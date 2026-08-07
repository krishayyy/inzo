import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { badRequest, conflict, forbidden, gone, notFound, stalePlan, subjectHashMismatch } from "./errors.js";
import { relayEvents } from "./events.js";
import { generateAgentToken, generateId, generatePairingCode, hashAgentToken } from "./ids.js";
import { computeRunway, foldUsage } from "./runway.js";
import { narrowedScope, parseScope, serializeScope } from "./scopes.js";
import { CredentialStore } from "./credentialStore.js";
import { planSubjectHash, type ConsentRecord } from "./consent.js";
import type { Jwk } from "./credential.js";
import type { Assurance } from "./audit.js";
import {
  ALL_SCOPES,
  type Budget,
  type CombinedUsage,
  type Message,
  type Pairing,
  type PairingCode,
  type Plan,
  type PlanItem,
  type Scope,
  type TokenIdentity,
  type UsageReport,
  type UsageSnapshot,
} from "../types.js";

// Kept in sync with packages/relay-cf/src/registry.ts.
const PAIRING_CODE_TTL_MS = 30 * 60 * 1000;

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
  scope TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);

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
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  pairing_id TEXT PRIMARY KEY REFERENCES pairings(id),
  deadline TEXT,
  token_budget INTEGER,
  cost_budget_usd REAL,
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
CREATE INDEX IF NOT EXISTS idx_usage_pairing ON usage_reports(pairing_id, created_at);
`;

/** Columns added after the first release, for dev databases created before them. */
const LATE_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "agent_tokens", column: "scope", ddl: `TEXT NOT NULL DEFAULT '${serializeScope([...ALL_SCOPES])}'` },
  { table: "agent_tokens", column: "revoked_at", ddl: "TEXT" },
  { table: "plans", column: "version", ddl: "INTEGER NOT NULL DEFAULT 1" },
];

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
  version: number;
  created_at: string;
  updated_at: string;
}

interface BudgetRow {
  pairing_id: string;
  deadline: string | null;
  token_budget: number | null;
  cost_budget_usd: number | null;
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

export interface BudgetInput {
  deadline?: string | null;
  tokenBudget?: number | null;
  costBudgetUsd?: number | null;
}

/** Bounded-size catch-up view of a pairing. See `RelayStore.getDigest`. */
export interface Digest {
  pairingId: string;
  generatedAt: string;
  plan: Plan | null;
  consent: ConsentRecord | null;
  usage: UsageSnapshot;
  recentMessages: Message[];
}

export class RelayStore {
  private readonly db: DatabaseType;
  /** The v3 trust boundary: signed credentials, consent, audit. Deliberately a
   *  separate object — this store owns the conversation, that one owns
   *  authority, and they have different reasons to change. */
  readonly credentials: CredentialStore;

  constructor(dbPath = ":memory:", issuerUrl = process.env.INZO_ISSUER_URL ?? "http://localhost:8787") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
    this.credentials = new CredentialStore(this.db, issuerUrl);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    for (const { table, column, ddl } of LATE_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Pairing codes + pairings
  // ---------------------------------------------------------------------

  /**
   * Creates a pairing code and the creator's credential.
   *
   * `cnf` is the caller's locally-generated Ed25519 public key. When present we
   * mint a principal and issue a v3 signed credential bound to that key; when
   * absent we fall back to a v2 opaque token, which authenticates but cannot
   * prove possession and is therefore barred from giving consent.
   */
  createPairingCode(cnf?: { jwk: Jwk }): PairingCode & {
    agentToken: string;
    scope: Scope[];
    pairingId: null;
    principalId: string | null;
    credential: string | null;
  } {
    const creatorAgentId = generateId("agent");
    const agentToken = generateAgentToken();
    const scope = [...ALL_SCOPES];
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
        this.db
          .prepare(
            `INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, scope, revoked_at, created_at)
             VALUES (?, ?, NULL, ?, NULL, ?)`,
          )
          .run(hashAgentToken(agentToken), creatorAgentId, serializeScope(scope), now.toISOString());

        let principalId: string | null = null;
        let credential: string | null = null;
        if (cnf) {
          principalId = this.credentials.createPrincipal();
          credential = this.credentials.issueRoot({
            agentId: creatorAgentId,
            principalId,
            pairingId: null,
            cap: scope,
            cnf,
          }).credential;
        }

        return {
          ...this.rowToPairingCode(this.getPairingCodeRow(code)!),
          agentToken,
          scope,
          pairingId: null,
          principalId,
          credential,
        };
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("UNIQUE")) continue;
        throw err;
      }
    }
    throw new Error("Failed to generate a unique pairing code");
  }

  joinPairing(
    code: string,
    cnf?: { jwk: Jwk },
  ): Pairing & {
    agentToken: string;
    scope: Scope[];
    peerAgentId: string;
    principalId: string | null;
    credential: string | null;
  } {
    const joinerAgentId = generateId("agent");
    const agentToken = generateAgentToken();
    const scope = [...ALL_SCOPES];
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

    const pairing: Pairing = {
      id: generateId("pairing"),
      code,
      agentA: row.creator_agent_id,
      agentB: joinerAgentId,
      createdAt: new Date().toISOString(),
    };

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE pairing_codes SET used_at = ? WHERE code = ?`).run(new Date().toISOString(), code);
      this.db
        .prepare(`INSERT INTO pairings (id, code, agent_a, agent_b, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(pairing.id, code, pairing.agentA, pairing.agentB, pairing.createdAt);
      this.db.prepare(`UPDATE agent_tokens SET pairing_id = ? WHERE agent_id = ?`).run(pairing.id, pairing.agentA);
      this.db
        .prepare(
          `INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, scope, revoked_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(hashAgentToken(agentToken), joinerAgentId, pairing.id, serializeScope(scope), pairing.createdAt);
    });
    tx();

    // The creator's credential was issued before a pairing existed; now it does.
    this.credentials.bindPairing(pairing.agentA, pairing.id);

    let principalId: string | null = null;
    let credential: string | null = null;
    if (cnf) {
      principalId = this.credentials.createPrincipal();
      credential = this.credentials.issueRoot({
        agentId: joinerAgentId,
        principalId,
        pairingId: pairing.id,
        cap: scope,
        cnf,
      }).credential;
    }

    const actor = { principal: principalId, agent: joinerAgentId, credential: null };
    const assurance: Assurance = cnf ? "pop" : "bearer";
    this.credentials.record(pairing.id, "pairing.created", actor, assurance, { code });
    this.credentials.record(pairing.id, "pairing.joined", actor, assurance, { peerAgentId: pairing.agentA });

    return { ...pairing, agentToken, scope, peerAgentId: pairing.agentA, principalId, credential };
  }

  /**
   * Drops pairing codes that expired without ever being used.
   *
   * Used codes are kept: a pairing row references the code it came from, and
   * that link is worth preserving for support and audit. Unused expired codes
   * are pure garbage that would otherwise grow the table forever on a hosted
   * relay where most codes are generated and abandoned.
   */
  purgeExpiredCodes(now: Date = new Date()): number {
    return this.db
      .prepare(`DELETE FROM pairing_codes WHERE used_at IS NULL AND expires_at < ?`)
      .run(now.toISOString()).changes;
  }

  resolveToken(token: string): TokenIdentity | null {
    const row = this.db
      .prepare(`SELECT agent_id, pairing_id, scope, revoked_at FROM agent_tokens WHERE token_hash = ?`)
      .get(hashAgentToken(token)) as
      | { agent_id: string; pairing_id: string | null; scope: string; revoked_at: string | null }
      | undefined;
    return row
      ? {
          agentId: row.agent_id,
          pairingId: row.pairing_id,
          scope: parseScope(row.scope),
          revokedAt: row.revoked_at,
        }
      : null;
  }

  /**
   * Permanently drops capabilities from the caller's own credential.
   *
   * Narrowing only — `narrowedScope` rejects anything the caller does not
   * already hold, so this can never be used to escalate. A human who has not
   * decided to let their agent approve plans unattended can strip
   * `plan:approve` and know the agent cannot put it back.
   */
  narrowScope(agentId: string, requested: unknown): Scope[] {
    const next = narrowedScope(requested, this.getAgentScope(agentId));
    this.db.prepare(`UPDATE agent_tokens SET scope = ? WHERE agent_id = ?`).run(serializeScope(next), agentId);
    return next;
  }

  getAgentScope(agentId: string): Scope[] {
    const row = this.db.prepare(`SELECT scope FROM agent_tokens WHERE agent_id = ?`).get(agentId) as
      | { scope: string }
      | undefined;
    return row ? parseScope(row.scope) : [];
  }

  isAgentRevoked(agentId: string): boolean {
    const row = this.db.prepare(`SELECT revoked_at FROM agent_tokens WHERE agent_id = ?`).get(agentId) as
      | { revoked_at: string | null }
      | undefined;
    return Boolean(row?.revoked_at);
  }

  /**
   * The kill switch. Either human can cut either side of the pairing off
   * instantly and unilaterally — withdrawing consent must never require the
   * other party's cooperation, because the case you need it for is exactly
   * the case where they are misbehaving.
   *
   * Revocation is one-way. There is no un-revoke; re-pair instead. That keeps
   * "revoked" a terminal state an auditor can trust.
   */
  revokeAgent(
    pairingId: string,
    actorAgentId: string,
    target: "self" | "peer",
  ): { revokedAgentId: string; revokedAt: string; by: string; revokedCredentials?: string[] } {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, actorAgentId);
    const revokedAgentId = target === "self" ? actorAgentId : this.otherAgent(pairing, actorAgentId);
    const revokedAt = new Date().toISOString();

    const info = this.db
      .prepare(`UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`)
      .run(revokedAt, revokedAgentId);

    if (info.changes === 0) {
      // Already revoked — idempotent, report the original timestamp.
      const existing = this.db
        .prepare(`SELECT revoked_at FROM agent_tokens WHERE agent_id = ?`)
        .get(revokedAgentId) as { revoked_at: string | null } | undefined;
      if (!existing) throw notFound(`No credential for agent "${revokedAgentId}"`);
      return { revokedAgentId, revokedAt: existing.revoked_at!, by: actorAgentId };
    }

    // Kill the v3 subtree too, and drop any consent given with those keys —
    // an approval is only worth what the credential behind it is worth (§6.3.7).
    const revokedCredentials = this.credentials.revokeAgentCredentials(revokedAgentId, revokedAt);
    this.credentials.withdrawByCredentials(pairingId, revokedCredentials);
    this.credentials.record(
      pairingId,
      "credential.revoked",
      { principal: this.credentials.agentPrincipal(actorAgentId), agent: actorAgentId, credential: null },
      "pop",
      { revokedAgentId, revokedCredentials, target },
    );

    relayEvents.publish({
      type: "pairing.revoked",
      pairingId,
      revocation: { revokedAgentId, revokedAt, by: actorAgentId },
    });
    return { revokedAgentId, revokedAt, by: actorAgentId, revokedCredentials };
  }

  /**
   * The pairing an agent currently belongs to, if any.
   *
   * Only used to resolve a pre-binding credential (one issued by
   * `POST /pairings`, before anyone had joined). Returns null while the code is
   * still unclaimed, which is an expected state rather than an error.
   */
  pairingForAgent(agentId: string): string | null {
    const row = this.db.prepare(`SELECT id FROM pairings WHERE agent_a = ? OR agent_b = ? LIMIT 1`).get(agentId, agentId) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  getPairing(pairingId: string): Pairing {
    const row = this.db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairingId) as PairingRow | undefined;
    if (!row) {
      throw notFound(`No pairing "${pairingId}"`);
    }
    return this.rowToPairing(row);
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
    if (typeof body !== "string" || !body.trim()) {
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
          .prepare(`SELECT *, rowid AS cursor FROM messages WHERE pairing_id = ? AND rowid > ? ORDER BY rowid ASC`)
          .all(pairingId, since) as MessageRow[])
      : (this.db
          .prepare(`SELECT *, rowid AS cursor FROM messages WHERE pairing_id = ? ORDER BY rowid ASC`)
          .all(pairingId) as MessageRow[]);
    return rows.map(this.rowToMessage);
  }

  // ---------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------

  proposePlan(pairingId: string, proposedBy: string, goal: string, items: PlanItem[]): Plan {
    if (typeof goal !== "string" || !goal.trim()) {
      throw badRequest("goal is required");
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest("items must be a non-empty array of { owner, task }");
    }
    for (const item of items) {
      if (!item?.owner?.trim() || !item?.task?.trim()) {
        throw badRequest("each plan item requires an owner and a task");
      }
    }
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, proposedBy);

    const now = new Date().toISOString();
    const existing = this.getPlanRow(pairingId);
    const createdAt = existing?.created_at ?? now;
    const version = (existing?.version ?? 0) + 1;

    // A fresh proposal resets approvals and unlocks — renegotiating must never
    // inherit stale consent. The version bump is what lets an in-flight
    // approval for the previous text be rejected rather than silently applied.
    const plan: Plan = {
      pairingId,
      goal,
      items,
      proposedBy,
      approvedBy: [],
      locked: false,
      version,
      createdAt,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO plans (pairing_id, goal, items, proposed_by, approved_by, locked, version, created_at, updated_at)
         VALUES (@pairingId, @goal, @items, @proposedBy, @approvedBy, 0, @version, @createdAt, @updatedAt)
         ON CONFLICT(pairing_id) DO UPDATE SET
           goal = excluded.goal,
           items = excluded.items,
           proposed_by = excluded.proposed_by,
           approved_by = excluded.approved_by,
           locked = 0,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run({
        pairingId,
        goal,
        items: JSON.stringify(items),
        proposedBy,
        approvedBy: JSON.stringify([]),
        version,
        createdAt,
        updatedAt: now,
      });

    // A fresh proposal opens a fresh consent record, destroying any prior
    // approvals (§6.3.4). `required` is both principals and is never editable.
    const principals = [
      this.credentials.agentPrincipal(pairing.agentA),
      this.credentials.agentPrincipal(pairing.agentB),
    ].filter((entry): entry is string => Boolean(entry));
    if (principals.length === 2) {
      this.credentials.openConsent(pairingId, { kind: "plan", version, hash: planSubjectHash(plan) }, principals);
    }
    this.credentials.record(
      pairingId,
      "plan.proposed",
      { principal: this.credentials.agentPrincipal(proposedBy), agent: proposedBy, credential: null },
      "pop",
      { version, subjectHash: planSubjectHash(plan) },
    );

    relayEvents.publish({ type: "plan.updated", pairingId, plan });
    return plan;
  }

  /**
   * Records one human's approval of a SPECIFIC plan version.
   *
   * `planVersion` is required and must match. Without it there is a real race:
   * A reads plan v1 and decides to approve, B re-proposes v2, A's approval
   * lands and attaches to text the human never read. Failing with 409 forces
   * a look at what actually changed.
   */
  approvePlan(
    pairingId: string,
    agentId: string,
    planVersion: unknown,
    consent?: { payload: import("./credential.js").CredentialPayload; assurance: Assurance; signature: unknown },
  ): Plan & { consent?: ConsentRecord } {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, agentId);

    const row = this.getPlanRow(pairingId);
    if (!row) {
      throw notFound(`No plan has been proposed for pairing "${pairingId}"`);
    }
    if (typeof planVersion !== "number" || !Number.isInteger(planVersion)) {
      throw badRequest("planVersion is required and must be the integer version of the plan you read");
    }
    if (planVersion !== row.version) {
      throw stalePlan(planVersion, row.version);
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

    // v3: turn the approval into evidence. The signature is over a hash of the
    // exact text the human read, made with a key this relay has never held —
    // so `satisfied` is checkable by the other org without trusting us.
    let consentRecord: ConsentRecord | undefined;
    if (consent) {
      const current = this.credentials.getConsent(pairingId);
      const expected = planSubjectHash(plan);
      if (current && current.subject.hash !== expected) {
        // Version matched but content did not. A version is a counter and can
        // collide across a restore; the hash cannot. This is an integrity
        // problem, not a stale read.
        throw subjectHashMismatch(current.subject.hash, expected);
      }
      consentRecord = this.credentials.approve({
        pairingId,
        payload: consent.payload,
        assurance: consent.assurance,
        signature: consent.signature,
      });
      this.credentials.record(
        pairingId,
        "consent.approved",
        this.credentials.actorFrom(consent.payload),
        consent.assurance,
        { version: plan.version, subjectHash: expected },
      );
      if (consentRecord.satisfied) {
        this.credentials.record(
          pairingId,
          "consent.satisfied",
          this.credentials.actorFrom(consent.payload),
          consent.assurance,
          { version: plan.version, subjectHash: expected },
        );
      }
      relayEvents.publish({ type: "consent.updated", pairingId, consent: consentRecord } as never);
    }

    relayEvents.publish({ type: "plan.updated", pairingId, plan });
    return consentRecord ? { ...plan, consent: consentRecord } : plan;
  }

  /** §6.3.6 — either principal can pull their approval unilaterally. */
  withdrawConsent(pairingId: string, principalId: string, agentId: string): ConsentRecord {
    const record = this.credentials.withdraw(pairingId, principalId);
    this.credentials.record(pairingId, "consent.withdrawn", { principal: principalId, agent: agentId, credential: null }, "pop", {
      version: record.subject.version,
    });
    relayEvents.publish({ type: "consent.updated", pairingId, consent: record } as never);
    return record;
  }

  getPlan(pairingId: string): Plan | null {
    this.getPairing(pairingId);
    const row = this.getPlanRow(pairingId);
    return row ? this.rowToPlan(row) : null;
  }

  // ---------------------------------------------------------------------
  // Budget
  // ---------------------------------------------------------------------

  setBudget(pairingId: string, agentId: string, input: BudgetInput): Budget {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, agentId);

    const existing = this.getBudget(pairingId);
    const next: Budget = {
      pairingId,
      deadline: "deadline" in input ? normalizeDeadline(input.deadline) : (existing?.deadline ?? null),
      tokenBudget:
        "tokenBudget" in input
          ? normalizeNumber(input.tokenBudget, "tokenBudget")
          : (existing?.tokenBudget ?? null),
      costBudgetUsd:
        "costBudgetUsd" in input
          ? normalizeNumber(input.costBudgetUsd, "costBudgetUsd")
          : (existing?.costBudgetUsd ?? null),
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO budgets (pairing_id, deadline, token_budget, cost_budget_usd, updated_at)
         VALUES (@pairingId, @deadline, @tokenBudget, @costBudgetUsd, @updatedAt)
         ON CONFLICT(pairing_id) DO UPDATE SET
           deadline = excluded.deadline,
           token_budget = excluded.token_budget,
           cost_budget_usd = excluded.cost_budget_usd,
           updated_at = excluded.updated_at`,
      )
      .run(next);

    relayEvents.publish({ type: "budget.updated", pairingId, budget: next });
    return next;
  }

  getBudget(pairingId: string): Budget | null {
    const row = this.db.prepare(`SELECT * FROM budgets WHERE pairing_id = ?`).get(pairingId) as
      | BudgetRow
      | undefined;
    return row
      ? {
          pairingId: row.pairing_id,
          deadline: row.deadline,
          tokenBudget: row.token_budget,
          costBudgetUsd: row.cost_budget_usd,
          updatedAt: row.updated_at,
        }
      : null;
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
    return foldUsage(pairingId, [pairing.agentA, pairing.agentB], this.getUsageReports(pairingId));
  }

  /** Usage plus the runway derived from it — what agents actually plan against. */
  getUsageSnapshot(pairingId: string, now: number = Date.now()): UsageSnapshot {
    const pairing = this.getPairing(pairingId);
    const reports = this.getUsageReports(pairingId);
    const usage = foldUsage(pairingId, [pairing.agentA, pairing.agentB], reports);
    const runway = computeRunway(this.getBudget(pairingId), usage, reports, now);
    return { usage, runway };
  }

  /**
   * A bounded-size catch-up view of a pairing: current plan, current
   * consent, usage/runway, and only the last `limit` messages — not the
   * full thread. §Digest
   *
   * The point is cost that doesn't grow with how long a pairing has been
   * running. `getMessages` is what you page through for the full history;
   * this is what an agent reconnecting after a gap asks for instead, so
   * catching up costs roughly the same whether it missed 5 messages or 500.
   */
  getDigest(pairingId: string, limit = 10): Digest {
    const pairing = this.getPairing(pairingId);
    return {
      pairingId,
      generatedAt: new Date().toISOString(),
      plan: this.getPlan(pairingId),
      consent: this.credentials.getConsent(pairingId),
      usage: this.getUsageSnapshot(pairingId),
      recentMessages: this.getRecentMessages(pairing.id, limit),
    };
  }

  /** Most recent `limit` messages, oldest first — the tail of the thread. */
  private getRecentMessages(pairingId: string, limit: number): Message[] {
    const rows = this.db
      .prepare(`SELECT *, rowid AS cursor FROM messages WHERE pairing_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(pairingId, limit) as MessageRow[];
    return rows.reverse().map(this.rowToMessage);
  }

  private getUsageReports(pairingId: string): UsageReport[] {
    const rows = this.db
      .prepare(`SELECT * FROM usage_reports WHERE pairing_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(pairingId) as UsageRow[];
    return rows.map((row) => ({
      id: row.id,
      pairingId: row.pairing_id,
      agentId: row.agent_id,
      tokensUsed: row.tokens_used,
      costUsd: row.cost_usd,
      wallClockMs: row.wall_clock_ms,
      progressPct: row.progress_pct,
      createdAt: row.created_at,
    }));
  }

  // ---------------------------------------------------------------------
  // Row <-> domain mappers
  // ---------------------------------------------------------------------

  private getPairingCodeRow(code: string): PairingCodeRow | undefined {
    return this.db.prepare(`SELECT * FROM pairing_codes WHERE code = ?`).get(code) as PairingCodeRow | undefined;
  }

  private getPlanRow(pairingId: string): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE pairing_id = ?`).get(pairingId) as PlanRow | undefined;
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
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function normalizeDeadline(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw badRequest("deadline must be an ISO-8601 string or null");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`deadline "${value}" is not a valid ISO-8601 timestamp`);
  return parsed.toISOString();
}

function normalizeNumber(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw badRequest(`${name} must be a non-negative number or null`);
  }
  return value;
}
