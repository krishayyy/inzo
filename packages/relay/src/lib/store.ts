import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { badRequest, conflict, forbidden, gone, notFound } from "./errors.js";
import { relayEvents } from "./events.js";
import { generateAgentToken, generateId, generatePairingCode, hashAgentToken } from "./ids.js";
import type {
  CombinedUsage,
  Message,
  Pairing,
  PairingCode,
  Plan,
  PlanItem,
  UsageReport,
} from "../types.js";

const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  creator_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  pairing_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairings_code ON pairings(code);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  from_agent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pairing_created ON messages(pairing_id, created_at);

CREATE TABLE IF NOT EXISTS plans (
  pairing_id TEXT PRIMARY KEY REFERENCES pairings(id),
  goal TEXT NOT NULL,
  items TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_reports (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  agent_id TEXT NOT NULL,
  tokens_used INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  wall_clock_ms INTEGER NOT NULL,
  progress_pct REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_pairing ON usage_reports(pairing_id);
`;

interface PairingCodeRow {
  code: string;
  creator_agent_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface PairingRow {
  id: string;
  code: string;
  agent_a: string;
  agent_b: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  pairing_id: string;
  from_agent_id: string;
  body: string;
  created_at: string;
  cursor: number;
}

interface PlanRow {
  pairing_id: string;
  goal: string;
  items: string;
  proposed_by: string;
  approved_by: string;
  locked: number;
  created_at: string;
  updated_at: string;
}

interface UsageRow {
  id: string;
  pairing_id: string;
  agent_id: string;
  tokens_used: number;
  cost_usd: number;
  wall_clock_ms: number;
  progress_pct: number;
  created_at: string;
}

export interface UsageInput {
  tokensUsed: number;
  costUsd: number;
  wallClockMs: number;
  progressPct: number;
}

export class RelayStore {
  private readonly db: DatabaseType;

  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // Pairing codes + pairings
  // ---------------------------------------------------------------------

  createPairingCode(): PairingCode & { agentToken: string; pairingId: null } {
    const creatorAgentId = generateId("agent");
    const agentToken = generateAgentToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);

    // Extremely unlikely collision, but retry defensively.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        this.db
          .prepare(
            `INSERT INTO pairing_codes (code, creator_agent_id, created_at, expires_at, used_at)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(code, creatorAgentId, now.toISOString(), expiresAt.toISOString());
        this.db.prepare(`INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, created_at) VALUES (?, ?, NULL, ?)`)
          .run(hashAgentToken(agentToken), creatorAgentId, now.toISOString());
        return { ...this.rowToPairingCode(this.getPairingCodeRow(code)!), agentToken, pairingId: null };
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("UNIQUE")) continue;
        throw err;
      }
    }
    throw new Error("Failed to generate a unique pairing code");
  }

  joinPairing(code: string): Pairing & { agentToken: string; peerAgentId: string } {
    const joinerAgentId = generateId("agent");
    const agentToken = generateAgentToken();
    const row = this.getPairingCodeRow(code);
    if (!row) {
      throw notFound(`No pairing code "${code}"`);
    }
    if (row.used_at) {
      throw conflict(`Pairing code "${code}" has already been used`);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw gone(`Pairing code "${code}" has expired`);
    }
    if (row.creator_agent_id === joinerAgentId) {
      throw badRequest("An agent cannot join its own pairing code");
    }

    const pairing: Pairing = {
      id: generateId("pairing"),
      code,
      agentA: row.creator_agent_id,
      agentB: joinerAgentId,
      createdAt: new Date().toISOString(),
    };

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE pairing_codes SET used_at = ? WHERE code = ?`)
        .run(new Date().toISOString(), code);
      this.db
        .prepare(
          `INSERT INTO pairings (id, code, agent_a, agent_b, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(pairing.id, code, pairing.agentA, pairing.agentB, pairing.createdAt);
      this.db.prepare(`UPDATE agent_tokens SET pairing_id = ? WHERE agent_id = ?`).run(pairing.id, pairing.agentA);
      this.db.prepare(`INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, created_at) VALUES (?, ?, ?, ?)`)
        .run(hashAgentToken(agentToken), joinerAgentId, pairing.id, pairing.createdAt);
    });
    tx();

    return { ...pairing, agentToken, peerAgentId: pairing.agentA };
  }

  resolveToken(token: string): { agentId: string; pairingId: string | null } | null {
    const row = this.db.prepare(`SELECT agent_id, pairing_id FROM agent_tokens WHERE token_hash = ?`).get(hashAgentToken(token)) as { agent_id: string; pairing_id: string | null } | undefined;
    return row ? { agentId: row.agent_id, pairingId: row.pairing_id } : null;
  }

  getPairing(pairingId: string): Pairing {
    const row = this.db
      .prepare(`SELECT * FROM pairings WHERE id = ?`)
      .get(pairingId) as PairingRow | undefined;
    if (!row) {
      throw notFound(`No pairing "${pairingId}"`);
    }
    return this.rowToPairing(row);
  }

  /**
   * Looks up the pairing that resulted from a given pairing code, if any.
   * Used by the code's creator to discover the pairingId once their
   * teammate has joined (they only ever saw the code, not the id).
   * Returns null if the code hasn't been used (joined) yet.
   */
  getPairingByCode(code: string): Pairing | null {
    const row = this.db.prepare(`SELECT * FROM pairings WHERE code = ?`).get(code) as
      | PairingRow
      | undefined;
    return row ? this.rowToPairing(row) : null;
  }

  /** Throws 403 if the agent is not one of the two agents in the pairing. */
  assertMember(pairing: Pairing, agentId: string): void {
    if (agentId !== pairing.agentA && agentId !== pairing.agentB) {
      throw forbidden(`Agent "${agentId}" is not part of pairing "${pairing.id}"`);
    }
  }

  otherAgent(pairing: Pairing, agentId: string): string {
    return agentId === pairing.agentA ? pairing.agentB : pairing.agentA;
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------

  addMessage(pairingId: string, fromAgentId: string, body: string): Message {
    if (!body?.trim()) {
      throw badRequest("body is required");
    }
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, fromAgentId);

    const id = generateId("msg");
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO messages (id, pairing_id, from_agent_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, pairingId, fromAgentId, body, createdAt);

    const message: Message = {
      id,
      pairingId,
      fromAgentId,
      body,
      createdAt,
      cursor: Number(info.lastInsertRowid),
    };

    relayEvents.publish({ type: "message.created", pairingId, message });
    return message;
  }

  /**
   * Returns messages in a pairing's thread, oldest first.
   * Pass `since` (the `cursor` of the last message you saw) to page forward —
   * only strictly-newer messages are returned.
   */
  getMessages(pairingId: string, since?: number): Message[] {
    this.getPairing(pairingId); // validates existence
    const rows = since
      ? (this.db
          .prepare(
            `SELECT *, rowid AS cursor FROM messages WHERE pairing_id = ? AND rowid > ? ORDER BY rowid ASC`,
          )
          .all(pairingId, since) as MessageRow[])
      : (this.db
          .prepare(`SELECT *, rowid AS cursor FROM messages WHERE pairing_id = ? ORDER BY rowid ASC`)
          .all(pairingId) as MessageRow[]);
    return rows.map(this.rowToMessage);
  }

  // ---------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------

  proposePlan(
    pairingId: string,
    proposedBy: string,
    goal: string,
    items: PlanItem[],
  ): Plan {
    if (!goal?.trim()) {
      throw badRequest("goal is required");
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest("items must be a non-empty array of { owner, task }");
    }
    for (const item of items) {
      if (!item.owner?.trim() || !item.task?.trim()) {
        throw badRequest("each plan item requires an owner and a task");
      }
    }
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, proposedBy);

    const now = new Date().toISOString();
    const existing = this.getPlanRow(pairingId);
    const createdAt = existing?.created_at ?? now;

    // A fresh proposal resets approvals — re-negotiating unlocks the plan.
    const plan: Plan = {
      pairingId,
      goal,
      items,
      proposedBy,
      approvedBy: [],
      locked: false,
      createdAt,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO plans (pairing_id, goal, items, proposed_by, approved_by, locked, created_at, updated_at)
         VALUES (@pairingId, @goal, @items, @proposedBy, @approvedBy, 0, @createdAt, @updatedAt)
         ON CONFLICT(pairing_id) DO UPDATE SET
           goal = excluded.goal,
           items = excluded.items,
           proposed_by = excluded.proposed_by,
           approved_by = excluded.approved_by,
           locked = 0,
           updated_at = excluded.updated_at`,
      )
      .run({
        pairingId,
        goal,
        items: JSON.stringify(items),
        proposedBy,
        approvedBy: JSON.stringify([]),
        createdAt,
        updatedAt: now,
      });

    relayEvents.publish({ type: "plan.updated", pairingId, plan });
    return plan;
  }

  approvePlan(pairingId: string, agentId: string): Plan {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, agentId);

    const row = this.getPlanRow(pairingId);
    if (!row) {
      throw notFound(`No plan has been proposed for pairing "${pairingId}"`);
    }

    const approvedBy = new Set<string>(JSON.parse(row.approved_by));
    approvedBy.add(agentId);
    const locked = approvedBy.has(pairing.agentA) && approvedBy.has(pairing.agentB);
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(`UPDATE plans SET approved_by = ?, locked = ?, updated_at = ? WHERE pairing_id = ?`)
      .run(JSON.stringify([...approvedBy]), locked ? 1 : 0, updatedAt, pairingId);

    const plan = this.rowToPlan({
      ...row,
      approved_by: JSON.stringify([...approvedBy]),
      locked: locked ? 1 : 0,
      updated_at: updatedAt,
    });
    relayEvents.publish({ type: "plan.updated", pairingId, plan });
    return plan;
  }

  getPlan(pairingId: string): Plan | null {
    this.getPairing(pairingId);
    const row = this.getPlanRow(pairingId);
    return row ? this.rowToPlan(row) : null;
  }

  // ---------------------------------------------------------------------
  // Usage
  // ---------------------------------------------------------------------

  reportUsage(pairingId: string, agentId: string, input: UsageInput): UsageReport {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, agentId);

    const { tokensUsed, costUsd, wallClockMs, progressPct } = input;
    for (const [name, value] of Object.entries({ tokensUsed, costUsd, wallClockMs, progressPct })) {
      if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
        throw badRequest(`${name} must be a non-negative number`);
      }
    }
    if (progressPct > 100) {
      throw badRequest("progressPct must be between 0 and 100");
    }

    const usage: UsageReport = {
      id: generateId("usage"),
      pairingId,
      agentId,
      tokensUsed,
      costUsd,
      wallClockMs,
      progressPct,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO usage_reports
           (id, pairing_id, agent_id, tokens_used, cost_usd, wall_clock_ms, progress_pct, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.id,
        usage.pairingId,
        usage.agentId,
        usage.tokensUsed,
        usage.costUsd,
        usage.wallClockMs,
        usage.progressPct,
        usage.createdAt,
      );

    relayEvents.publish({ type: "usage.reported", pairingId, usage });
    return usage;
  }

  getUsage(pairingId: string): CombinedUsage {
    const pairing = this.getPairing(pairingId);
    const rows = this.db
      .prepare(`SELECT * FROM usage_reports WHERE pairing_id = ? ORDER BY created_at ASC`)
      .all(pairingId) as UsageRow[];

    const byAgent: CombinedUsage["byAgent"] = {
      [pairing.agentA]: emptyAgentUsage(),
      [pairing.agentB]: emptyAgentUsage(),
    };

    for (const row of rows) {
      const bucket = (byAgent[row.agent_id] ??= emptyAgentUsage());
      bucket.tokensUsed += row.tokens_used;
      bucket.costUsd += row.cost_usd;
      bucket.wallClockMs += row.wall_clock_ms;
      bucket.progressPct = row.progress_pct; // latest report wins
      bucket.reportCount += 1;
      bucket.lastReportedAt = row.created_at;
    }

    const totals = Object.values(byAgent).reduce(
      (acc, agent) => ({
        tokensUsed: acc.tokensUsed + agent.tokensUsed,
        costUsd: acc.costUsd + agent.costUsd,
        wallClockMs: acc.wallClockMs + agent.wallClockMs,
      }),
      { tokensUsed: 0, costUsd: 0, wallClockMs: 0 },
    );

    return { pairingId, byAgent, totals };
  }

  // ---------------------------------------------------------------------
  // Row <-> domain mappers
  // ---------------------------------------------------------------------

  private getPairingCodeRow(code: string): PairingCodeRow | undefined {
    return this.db.prepare(`SELECT * FROM pairing_codes WHERE code = ?`).get(code) as
      | PairingCodeRow
      | undefined;
  }

  private getPlanRow(pairingId: string): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE pairing_id = ?`).get(pairingId) as
      | PlanRow
      | undefined;
  }

  private rowToPairingCode(row: PairingCodeRow): PairingCode {
    return {
      code: row.code,
      creatorAgentId: row.creator_agent_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
    };
  }

  private rowToPairing(row: PairingRow): Pairing {
    return {
      id: row.id,
      code: row.code,
      agentA: row.agent_a,
      agentB: row.agent_b,
      createdAt: row.created_at,
    };
  }

  private rowToMessage(row: MessageRow): Message {
    return {
      id: row.id,
      pairingId: row.pairing_id,
      fromAgentId: row.from_agent_id,
      body: row.body,
      createdAt: row.created_at,
      cursor: row.cursor,
    };
  }

  private rowToPlan(row: PlanRow): Plan {
    return {
      pairingId: row.pairing_id,
      goal: row.goal,
      items: JSON.parse(row.items),
      proposedBy: row.proposed_by,
      approvedBy: JSON.parse(row.approved_by),
      locked: !!row.locked,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function emptyAgentUsage(): CombinedUsage["byAgent"][string] {
  return {
    tokensUsed: 0,
    costUsd: 0,
    wallClockMs: 0,
    progressPct: 0,
    reportCount: 0,
    lastReportedAt: null,
  };
}
