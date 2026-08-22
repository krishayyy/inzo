import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { badRequest, conflict, forbidden, gone, notFound, stalePlan, subjectHashMismatch } from "./errors.js";
import { relayEvents } from "./events.js";
import { generateAgentToken, generateId, generatePairingCode, hashAgentToken } from "./ids.js";
import { computeRunway, foldUsage } from "./runway.js";
import { narrowedScope, parseScope, serializeScope } from "./scopes.js";
import {
  memoryTerms,
  normalizeMemoryBody,
  normalizeMemoryKey,
  normalizeMemoryKind,
  normalizeMemoryLimit,
  normalizeMemoryTags,
  normalizeMemoryVisibility,
  normalizeModel,
  normalizeStrengths,
  scoreMemory,
  shortAgentId,
  TASK_STATUSES,
} from "./memory.js";
import { CredentialStore } from "./credentialStore.js";
import { planSubjectHash, type ConsentRecord } from "./consent.js";
import { beginPlanWait, type WaitHandle } from "./agentrun.js";
import type { Jwk } from "./credential.js";
import type { Assurance } from "./audit.js";
import {
  ALL_SCOPES,
  type AgentProfile,
  type Budget,
  type CombinedUsage,
  type Memory,
  type MemoryKind,
  type MemoryVisibility,
  type Message,
  type Pairing,
  type PairingCode,
  type Plan,
  type PlanItem,
  type RecalledMemory,
  type Scope,
  type Task,
  type TaskStatus,
  type TokenIdentity,
  type UsageReport,
  type UsageSnapshot,
} from "../types.js";

// Kept in sync with packages/relay-cf/src/registry.ts.
const PAIRING_CODE_TTL_MS = 30 * 60 * 1000;

/** Bounds join-spam via repeated per-invite codes on one pairing. */
const MAX_MEMBERS = 8;

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

-- Full membership of a pairing. agent_a/agent_b above stay populated for
-- back-compat (the creator and first joiner) but this table is the source of
-- truth once a pairing has more than two members.
CREATE TABLE IF NOT EXISTS pairing_members (
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  agent_id   TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (pairing_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_pairing_members_pairing ON pairing_members(pairing_id);
CREATE INDEX IF NOT EXISTS idx_pairing_members_agent ON pairing_members(agent_id);

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
  updated_at TEXT NOT NULL,
  sandbox_id TEXT,
  sandbox_state TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  pairing_id TEXT PRIMARY KEY REFERENCES pairings(id),
  deadline TEXT,
  token_budget INTEGER,
  cost_budget_usd REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  agent_id TEXT NOT NULL,
  model TEXT,
  strengths TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pairing_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  assigned_to TEXT,
  proposed_by TEXT NOT NULL,
  rationale TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_pairing ON tasks(pairing_id, created_at);

-- The shared memory layer. The key is unique per pairing so re-remembering a
-- key replaces it (see RelayStore.remember): memory converges rather than
-- accumulating contradictory copies of the same fact.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  author_agent_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'team',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (pairing_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_pairing ON memories(pairing_id, updated_at);

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
  { table: "plans", column: "sandbox_id", ddl: "TEXT" },
  { table: "plans", column: "sandbox_state", ddl: "TEXT" },
  // Set only on an invite code minted by createInviteCode() for an EXISTING
  // pairing; NULL on the bootstrap code minted by createPairingCode().
  { table: "pairing_codes", column: "pairing_id", ddl: "TEXT" },
  { table: "pairings", column: "approval_policy", ddl: "TEXT NOT NULL DEFAULT 'unanimous'" },
];

interface PairingCodeRow {
  code: string;
  creator_agent_id: string;
  pairing_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface PairingRow {
  id: string;
  code: string;
  agent_a: string;
  agent_b: string;
  approval_policy: string;
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
  sandbox_id: string | null;
  sandbox_state: string | null;
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

export interface AgentProfileInput {
  model?: string | null;
  strengths?: string[];
}

interface AgentProfileRow {
  pairing_id: string;
  agent_id: string;
  model: string | null;
  strengths: string;
  updated_at: string;
}

export interface ProposeTaskInput {
  title: string;
  description?: string | null;
  dependsOn?: string[];
  /** Optional immediate assignment at proposal time — still recorded as attributed, with rationale. */
  assignTo?: string;
  rationale?: string | null;
}

export interface AssignTaskInput {
  assignedTo: string;
  rationale?: string | null;
}

export interface RememberInput {
  key: string;
  body: string;
  kind?: MemoryKind;
  tags?: string[];
  visibility?: MemoryVisibility;
}

export interface RecallInput {
  query?: string;
  limit?: number;
}

export interface SuggestOwnerInput {
  title?: string;
  description?: string | null;
  /** Explicit capability hints, matched against declared strengths. */
  needs?: string[];
}

export interface OwnerSuggestion {
  suggested: string;
  rationale: string;
  candidates: { agentId: string; model: string | null; strengthHits: number; tokensUsed: number; score: number }[];
}

interface MemoryRow {
  id: string;
  pairing_id: string;
  author_agent_id: string;
  kind: string;
  key: string;
  body: string;
  tags: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  pairing_id: string;
  title: string;
  description: string | null;
  status: string;
  assigned_to: string | null;
  proposed_by: string;
  rationale: string | null;
  depends_on: string;
  created_at: string;
  updated_at: string;
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
  /** AgentRun sandbox handles for pending plans, keyed by pairing. Not
   *  persisted — the DB columns (sandbox_id/sandbox_state) are the durable,
   *  display-facing record; this map is what lets approvePlan call dispose()
   *  on the exact handle proposePlan opened, within one process lifetime. */
  private readonly planWaits = new Map<string, WaitHandle>();

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
    agentId: string;
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
            `INSERT INTO pairing_codes (code, creator_agent_id, pairing_id, created_at, expires_at, used_at)
             VALUES (?, ?, NULL, ?, ?, NULL)`,
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
          agentId: creatorAgentId,
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

  /**
   * Invites a 3rd+ member into an EXISTING pairing.
   *
   * N-party pairing reuses the same one-shot `pairing_codes` mechanism as the
   * original 2-party bootstrap — the inviter just loops this once per
   * teammate rather than the relay minting a reusable multi-use code. Same
   * TTL, same one-shot semantics, same join route.
   */
  createInviteCode(pairingId: string, inviterAgentId: string): PairingCode {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, inviterAgentId);
    if (pairing.members.length >= MAX_MEMBERS) {
      throw conflict(`Pairing "${pairingId}" already has the maximum of ${MAX_MEMBERS} members`);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        this.db
          .prepare(
            `INSERT INTO pairing_codes (code, creator_agent_id, pairing_id, created_at, expires_at, used_at)
             VALUES (?, ?, ?, ?, ?, NULL)`,
          )
          .run(code, inviterAgentId, pairingId, now.toISOString(), expiresAt.toISOString());
        return this.rowToPairingCode(this.getPairingCodeRow(code)!);
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

    if (row.pairing_id) {
      return this.joinExistingPairing(row.pairing_id, row.code, joinerAgentId, agentToken, scope, cnf);
    }

    const pairing: Pairing = {
      id: generateId("pairing"),
      code,
      agentA: row.creator_agent_id,
      agentB: joinerAgentId,
      members: [row.creator_agent_id, joinerAgentId],
      approvalPolicy: "unanimous",
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
      for (const agentId of pairing.members) {
        this.db
          .prepare(`INSERT INTO pairing_members (pairing_id, agent_id, joined_at) VALUES (?, ?, ?)`)
          .run(pairing.id, agentId, pairing.createdAt);
      }
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

  /** Joining via an invite code minted by createInviteCode() for a pairing that already exists (3rd+ member). */
  private joinExistingPairing(
    pairingId: string,
    code: string,
    joinerAgentId: string,
    agentToken: string,
    scope: Scope[],
    cnf?: { jwk: Jwk },
  ): Pairing & { agentToken: string; scope: Scope[]; peerAgentId: string; principalId: string | null; credential: string | null } {
    const existing = this.getPairing(pairingId);
    if (existing.members.length >= MAX_MEMBERS) {
      throw conflict(`Pairing "${pairingId}" already has the maximum of ${MAX_MEMBERS} members`);
    }
    const joinedAt = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE pairing_codes SET used_at = ? WHERE code = ?`).run(joinedAt, code);
      this.db
        .prepare(
          `INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, scope, revoked_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(hashAgentToken(agentToken), joinerAgentId, pairingId, serializeScope(scope), joinedAt);
      this.db
        .prepare(`INSERT INTO pairing_members (pairing_id, agent_id, joined_at) VALUES (?, ?, ?)`)
        .run(pairingId, joinerAgentId, joinedAt);
    });
    tx();

    let principalId: string | null = null;
    let credential: string | null = null;
    if (cnf) {
      principalId = this.credentials.createPrincipal();
      credential = this.credentials.issueRoot({
        agentId: joinerAgentId,
        principalId,
        pairingId,
        cap: scope,
        cnf,
      }).credential;
    }

    const actor = { principal: principalId, agent: joinerAgentId, credential: null };
    const assurance: Assurance = cnf ? "pop" : "bearer";
    this.credentials.record(pairingId, "pairing.joined", actor, assurance, {
      code,
      memberCount: existing.members.length + 1,
    });

    const pairing = this.getPairing(pairingId);
    // "peer" is only unambiguous for the original 2-party shape; meaningless
    // once a 3rd member joins, but kept populated (as the first member) so a
    // caller that hasn't been updated for N-party gets a value, not a crash.
    const peerAgentId = pairing.members[0];
    return { ...pairing, agentToken, scope, peerAgentId, principalId, credential };
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
  /**
   * `target` is "self", "peer" (only unambiguous when the pairing has
   * exactly 2 members), or a specific member agentId — "all" (every other
   * member) is a route/tool-layer concern: call this once per member.
   */
  revokeAgent(
    pairingId: string,
    actorAgentId: string,
    target: string,
  ): { revokedAgentId: string; revokedAt: string; by: string; revokedCredentials?: string[] } {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, actorAgentId);
    let revokedAgentId: string;
    if (target === "self") {
      revokedAgentId = actorAgentId;
    } else if (target === "peer") {
      revokedAgentId = this.otherAgent(pairing, actorAgentId);
    } else if (pairing.members.includes(target)) {
      revokedAgentId = target;
    } else {
      throw badRequest(`"${target}" is not a member of pairing "${pairing.id}"`);
    }
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
    const row = this.db
      .prepare(`SELECT pairing_id AS id FROM pairing_members WHERE agent_id = ? LIMIT 1`)
      .get(agentId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getPairing(pairingId: string): Pairing {
    const row = this.db.prepare(`SELECT * FROM pairings WHERE id = ?`).get(pairingId) as PairingRow | undefined;
    if (!row) {
      throw notFound(`No pairing "${pairingId}"`);
    }
    return this.rowToPairing(row);
  }

  /** Full membership of a pairing, in join order. */
  getMembers(pairingId: string): string[] {
    const rows = this.db
      .prepare(`SELECT agent_id FROM pairing_members WHERE pairing_id = ? ORDER BY joined_at ASC`)
      .all(pairingId) as Array<{ agent_id: string }>;
    return rows.map((row) => row.agent_id);
  }

  /** Throws 403 if the agent is not a member of the pairing. */
  assertMember(pairing: Pairing, agentId: string): void {
    if (!pairing.members.includes(agentId)) {
      throw forbidden(`Agent "${agentId}" is not part of pairing "${pairing.id}"`);
    }
  }

  /**
   * "The other agent" is only well-defined for a 2-member pairing. For 3+
   * members, callers must pick a specific target from `pairing.members`
   * instead of asking for "the peer".
   */
  otherAgent(pairing: Pairing, agentId: string): string {
    if (pairing.members.length !== 2) {
      throw badRequest(
        `"peer" is ambiguous for pairing "${pairing.id}" (${pairing.members.length} members) — specify an agent id`,
      );
    }
    return agentId === pairing.members[0] ? pairing.members[1] : pairing.members[0];
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

  async proposePlan(pairingId: string, proposedBy: string, goal: string, items: PlanItem[]): Promise<Plan> {
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

    // A re-proposal supersedes whatever wait the previous version opened —
    // that sandbox no longer represents anything real, so tear it down rather
    // than leaking it.
    const priorWait = this.planWaits.get(pairingId);
    if (priorWait) {
      this.planWaits.delete(pairingId);
      await priorWait.dispose();
    }

    // The gap between proposing and both humans approving is a genuine
    // execute-wait-execute moment — nothing useful runs until it closes. That
    // wait is embodied as a real AgentRun sandbox, stopped immediately since
    // the point is representing "blocked," not running anything.
    const wait = await beginPlanWait(pairingId);
    await wait.suspend();
    this.planWaits.set(pairingId, wait);
    const sandboxState = wait.simulated ? "simulated" : "stopped";

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
      sandboxId: wait.sandboxId,
      sandboxState,
    };

    this.db
      .prepare(
        `INSERT INTO plans (pairing_id, goal, items, proposed_by, approved_by, locked, version, created_at, updated_at, sandbox_id, sandbox_state)
         VALUES (@pairingId, @goal, @items, @proposedBy, @approvedBy, 0, @version, @createdAt, @updatedAt, @sandboxId, @sandboxState)
         ON CONFLICT(pairing_id) DO UPDATE SET
           goal = excluded.goal,
           items = excluded.items,
           proposed_by = excluded.proposed_by,
           approved_by = excluded.approved_by,
           locked = 0,
           version = excluded.version,
           updated_at = excluded.updated_at,
           sandbox_id = excluded.sandbox_id,
           sandbox_state = excluded.sandbox_state`,
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
        sandboxId: wait.sandboxId,
        sandboxState,
      });

    // A fresh proposal opens a fresh consent record, destroying any prior
    // approvals (§6.3.4). `required` is every member's principal (unanimous
    // policy — see Pairing.approvalPolicy) and is never editable.
    const principals = pairing.members
      .map((agentId) => this.credentials.agentPrincipal(agentId))
      .filter((entry): entry is string => Boolean(entry));
    if (principals.length === pairing.members.length) {
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
  async approvePlan(
    pairingId: string,
    agentId: string,
    planVersion: unknown,
    consent?: { payload: import("./credential.js").CredentialPayload; assurance: Assurance; signature: unknown },
  ): Promise<Plan & { consent?: ConsentRecord }> {
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
    // Unanimous — the only approvalPolicy read today (see Pairing.approvalPolicy).
    const locked = pairing.members.every((member) => approvedBy.has(member));
    const updatedAt = new Date().toISOString();

    // Both approvals landed — the wait this plan opened has resolved. Tear
    // the sandbox down for good rather than leaving it stopped indefinitely.
    let sandboxState = row.sandbox_state;
    if (locked) {
      const wait = this.planWaits.get(pairingId);
      if (wait) {
        this.planWaits.delete(pairingId);
        await wait.dispose();
        sandboxState = wait.simulated ? "simulated" : "disposed";
      }
    }

    this.db
      .prepare(`UPDATE plans SET approved_by = ?, locked = ?, updated_at = ?, sandbox_state = ? WHERE pairing_id = ?`)
      .run(JSON.stringify([...approvedBy]), locked ? 1 : 0, updatedAt, sandboxState, pairingId);

    const plan = this.rowToPlan({
      ...row,
      sandbox_state: sandboxState,
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
  // Agent profiles
  //
  // Self-declared, not enforced — a teammate's stated model and strengths,
  // so a peer proposing a task split (or a human watching) has the facts to
  // reason about who should take what. This is deliberately separate from
  // `Scope`: scope is checked on every request and can only narrow; a
  // profile is just a claim, closer to a name tag than a credential.
  // ---------------------------------------------------------------------

  setAgentProfile(pairingId: string, agentId: string, input: AgentProfileInput): AgentProfile {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, agentId);

    const existing = this.getAgentProfileRow(pairingId, agentId);
    const strengths =
      input.strengths !== undefined ? normalizeStrengths(input.strengths) : (existing ? JSON.parse(existing.strengths) : []);
    const model = "model" in input ? normalizeModel(input.model) : (existing?.model ?? null);
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO agent_profiles (pairing_id, agent_id, model, strengths, updated_at)
         VALUES (@pairingId, @agentId, @model, @strengths, @updatedAt)
         ON CONFLICT(pairing_id, agent_id) DO UPDATE SET
           model = excluded.model,
           strengths = excluded.strengths,
           updated_at = excluded.updated_at`,
      )
      .run({ pairingId, agentId, model, strengths: JSON.stringify(strengths), updatedAt });

    const profile: AgentProfile = { pairingId, agentId, model, strengths, updatedAt };
    relayEvents.publish({ type: "profile.updated", pairingId, profile });
    return profile;
  }

  /** Every member's declared profile, including members who never declared one
   *  (returned with `model: null, strengths: []`) — so a caller can always
   *  render the full roster without a second lookup per member. */
  getAgentProfiles(pairingId: string): AgentProfile[] {
    const pairing = this.getPairing(pairingId);
    const rows = this.db
      .prepare(`SELECT * FROM agent_profiles WHERE pairing_id = ?`)
      .all(pairingId) as AgentProfileRow[];
    const byAgent = new Map(rows.map((row) => [row.agent_id, this.rowToAgentProfile(row)]));
    const updatedAt = new Date(0).toISOString();
    return pairing.members.map(
      (agentId) => byAgent.get(agentId) ?? { pairingId, agentId, model: null, strengths: [], updatedAt },
    );
  }

  private getAgentProfileRow(pairingId: string, agentId: string): AgentProfileRow | undefined {
    return this.db
      .prepare(`SELECT * FROM agent_profiles WHERE pairing_id = ? AND agent_id = ?`)
      .get(pairingId, agentId) as AgentProfileRow | undefined;
  }

  private rowToAgentProfile(row: AgentProfileRow): AgentProfile {
    return {
      pairingId: row.pairing_id,
      agentId: row.agent_id,
      model: row.model,
      strengths: JSON.parse(row.strengths),
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------
  // Tasks
  //
  // Unlike the plan, a task is not gated behind unanimous signed consent —
  // that gate exists for committing the sandbox to actually run work, and
  // proposing/assigning a task doesn't run anything by itself. What every
  // mutation DOES get is an attributed, tamper-evident audit record (the
  // same log plan/consent/revocation write to), so "why was this assigned,
  // and by whom" is answerable from the audit trail later, not just from
  // whoever remembers the conversation.
  // ---------------------------------------------------------------------

  proposeTask(pairingId: string, proposedBy: string, input: ProposeTaskInput): Task {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, proposedBy);

    if (typeof input.title !== "string" || !input.title.trim()) {
      throw badRequest("title is required");
    }
    const dependsOn = this.normalizeDependsOn(pairingId, input.dependsOn);
    if (input.assignTo !== undefined) this.assertMember(pairing, input.assignTo);

    const now = new Date().toISOString();
    const task: Task = {
      id: generateId("task"),
      pairingId,
      title: input.title.trim().slice(0, 200),
      description: input.description?.trim() || null,
      status: input.assignTo ? "assigned" : "proposed",
      assignedTo: input.assignTo ?? null,
      proposedBy,
      rationale: input.rationale?.trim() || null,
      dependsOn,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, pairing_id, title, description, status, assigned_to, proposed_by, rationale, depends_on, created_at, updated_at)
         VALUES (@id, @pairingId, @title, @description, @status, @assignedTo, @proposedBy, @rationale, @dependsOn, @createdAt, @updatedAt)`,
      )
      .run({ ...task, dependsOn: JSON.stringify(task.dependsOn) });

    this.recordTaskEvent(pairingId, proposedBy, "task.proposed", task, {
      title: task.title,
      assignedTo: task.assignedTo,
    });
    relayEvents.publish({ type: "task.updated", pairingId, task });
    return task;
  }

  /**
   * Reassigns (or first-assigns) a task, with a required rationale — the
   * point of this being its own call rather than a generic PATCH is that
   * "who owns this and why" is exactly the fact that must survive into the
   * audit trail, not be inferable only from a diff.
   */
  assignTask(pairingId: string, actorAgentId: string, taskId: string, input: AssignTaskInput): Task {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, actorAgentId);
    this.assertMember(pairing, input.assignedTo);
    const existing = this.getTaskRow(pairingId, taskId);
    if (!existing) throw notFound(`No task "${taskId}" in pairing "${pairingId}"`);

    const rationale = input.rationale?.trim() || null;
    const updatedAt = new Date().toISOString();
    const status: TaskStatus = existing.status === "proposed" || existing.status === "assigned" ? "assigned" : (existing.status as TaskStatus);

    this.db
      .prepare(`UPDATE tasks SET assigned_to = ?, status = ?, rationale = ?, updated_at = ? WHERE id = ?`)
      .run(input.assignedTo, status, rationale, updatedAt, taskId);

    const task = this.rowToTask({ ...existing, assigned_to: input.assignedTo, status, rationale, updated_at: updatedAt });
    this.recordTaskEvent(pairingId, actorAgentId, "task.assigned", task, {
      from: existing.assigned_to,
      to: input.assignedTo,
      rationale,
    });
    relayEvents.publish({ type: "task.updated", pairingId, task });
    return task;
  }

  updateTaskStatus(pairingId: string, actorAgentId: string, taskId: string, status: unknown): Task {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, actorAgentId);
    if (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus)) {
      throw badRequest(`status must be one of ${TASK_STATUSES.join(", ")}`);
    }
    const existing = this.getTaskRow(pairingId, taskId);
    if (!existing) throw notFound(`No task "${taskId}" in pairing "${pairingId}"`);

    // "done" is a claim worth being able to trust: block it while an
    // upstream dependency isn't done yet, the same way PlanItem.dependsOn
    // guards item completion (§types.ts PlanItem).
    if (status === "done") {
      const dependsOn: string[] = JSON.parse(existing.depends_on);
      for (const depId of dependsOn) {
        const dep = this.getTaskRow(pairingId, depId);
        if (dep && dep.status !== "done") {
          throw conflict(`Task "${taskId}" depends on "${depId}", which is not done yet`);
        }
      }
    }

    const updatedAt = new Date().toISOString();
    this.db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, updatedAt, taskId);
    const task = this.rowToTask({ ...existing, status, updated_at: updatedAt });
    this.recordTaskEvent(pairingId, actorAgentId, "task.status_changed", task, {
      from: existing.status,
      to: status,
    });
    relayEvents.publish({ type: "task.updated", pairingId, task });
    return task;
  }

  getTasks(pairingId: string): Task[] {
    this.getPairing(pairingId);
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE pairing_id = ? ORDER BY created_at ASC`)
      .all(pairingId) as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  private normalizeDependsOn(pairingId: string, value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw badRequest("dependsOn must be an array of task ids");
    for (const id of value) {
      if (typeof id !== "string" || !this.getTaskRow(pairingId, id)) {
        throw badRequest(`dependsOn references unknown task "${id}"`);
      }
    }
    return [...new Set(value as string[])];
  }

  private getTaskRow(pairingId: string, taskId: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE pairing_id = ? AND id = ?`).get(pairingId, taskId) as
      | TaskRow
      | undefined;
  }

  private recordTaskEvent(
    pairingId: string,
    actorAgentId: string,
    action: "task.proposed" | "task.assigned" | "task.status_changed",
    task: Task,
    detail: Record<string, unknown>,
  ): void {
    this.credentials.record(
      pairingId,
      action,
      { principal: this.credentials.agentPrincipal(actorAgentId), agent: actorAgentId, credential: null },
      "pop",
      { taskId: task.id, ...detail },
    );
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      pairingId: row.pairing_id,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      assignedTo: row.assigned_to,
      proposedBy: row.proposed_by,
      rationale: row.rationale,
      dependsOn: JSON.parse(row.depends_on),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------
  // Shared memory
  //
  // The layer that makes a pairing a teammate rather than a chat room. A
  // `Message` is a moment in a transcript; a `Memory` is a standing fact that
  // gets re-injected into whichever agent is about to work. Two rules do most
  // of the work here:
  //
  //   1. Writing an existing key REPLACES it. Memory has to converge on a
  //      current view of the world; an append-only pile of contradictory
  //      facts is just the transcript again, and worse to read.
  //   2. Instructions are never ranked away. A standing order that only
  //      surfaces when a query happens to match its wording is not a standing
  //      order, so `kind: "instruction"` rows are always returned by recall.
  //
  // Reading is gated twice, deliberately. `memory:read` decides whether a
  // credential may touch memory at all; per-row `visibility` decides which
  // rows it sees. That is what keeps "share one mind" from silently meaning
  // "your teammate's agent can read every note about your private repo" —
  // an agent can hold facts the team cannot see, and narrowing a credential
  // to drop `memory:read` cuts the whole layer off without deleting anything.
  // ---------------------------------------------------------------------

  remember(pairingId: string, authorAgentId: string, input: RememberInput): Memory {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, authorAgentId);

    const key = normalizeMemoryKey(input.key);
    const body = normalizeMemoryBody(input.body);
    const kind = normalizeMemoryKind(input.kind);
    const visibility = normalizeMemoryVisibility(input.visibility);
    const tags = input.tags === undefined ? [] : normalizeMemoryTags(input.tags);

    const existing = this.getMemoryRow(pairingId, key);
    // A private memory belongs to whoever wrote it. Letting a peer overwrite
    // it would turn a shared key namespace into a way to silently rewrite
    // another agent's private context.
    if (existing && existing.visibility === "private" && existing.author_agent_id !== authorAgentId) {
      throw forbidden(`Memory "${key}" is private to another member`);
    }

    const now = new Date().toISOString();
    const createdAt = existing?.created_at ?? now;

    this.db
      .prepare(
        `INSERT INTO memories (id, pairing_id, author_agent_id, kind, key, body, tags, visibility, created_at, updated_at)
         VALUES (@id, @pairingId, @authorAgentId, @kind, @key, @body, @tags, @visibility, @createdAt, @updatedAt)
         ON CONFLICT(pairing_id, key) DO UPDATE SET
           author_agent_id = excluded.author_agent_id,
           kind = excluded.kind,
           body = excluded.body,
           tags = excluded.tags,
           visibility = excluded.visibility,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: existing?.id ?? generateId("mem"),
        pairingId,
        authorAgentId,
        kind,
        key,
        body,
        tags: JSON.stringify(tags),
        visibility,
        createdAt,
        updatedAt: now,
      });

    const memory = this.rowToMemory(this.getMemoryRow(pairingId, key)!);
    this.credentials.record(
      pairingId,
      existing ? "memory.updated" : "memory.written",
      { principal: this.credentials.agentPrincipal(authorAgentId), agent: authorAgentId, credential: null },
      "pop",
      { memoryId: memory.id, key, kind, visibility },
    );
    relayEvents.publish({ type: "memory.updated", pairingId, memory });
    return memory;
  }

  /**
   * Relevance retrieval over the memory a given reader is allowed to see.
   *
   * Scoring is lexical on purpose — no embedding service, no network call, no
   * model dependency in the trust boundary. A relay that had to call out to
   * embed text would be a relay that leaks the team's memory to a third party
   * on every recall, which is exactly the property this product cannot have.
   * Lexical ranking is weaker, but it is auditable and offline, and the key/
   * tag weighting below recovers most of the practical difference.
   */
  recall(pairingId: string, readerAgentId: string, input: RecallInput = {}): RecalledMemory[] {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, readerAgentId);

    const limit = normalizeMemoryLimit(input.limit);
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE pairing_id = ? ORDER BY updated_at DESC`)
      .all(pairingId) as MemoryRow[];

    const visible = rows.filter((row) => row.visibility === "team" || row.author_agent_id === readerAgentId);
    const terms = memoryTerms(input.query);

    // Standing orders first, always, and outside the top-k budget — see the
    // section comment. Newest last so the most recent instruction is the one
    // an agent reads closest to its own turn.
    const instructions: RecalledMemory[] = visible
      .filter((row) => row.kind === "instruction")
      .map((row) => ({ ...this.rowToMemory(row), score: Number.POSITIVE_INFINITY, reason: "instruction" as const }))
      .reverse();

    const facts = visible.filter((row) => row.kind === "fact");
    const scored = facts
      .map((row) => ({ row, score: scoreMemory(row, terms) }))
      // With no query, recall degrades to "the most recently updated facts",
      // which is the right default for an agent asking "what do we know?"
      .filter((entry) => terms.length === 0 || entry.score > 0)
      // Key is the final tiebreak so the ordering is TOTAL: two memories
      // written in the same millisecond otherwise came back in whatever order
      // SQLite happened to return, making an agent's recall unstable between
      // two identical calls.
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.updated_at.localeCompare(a.row.updated_at) ||
          a.row.key.localeCompare(b.row.key),
      )
      .slice(0, limit)
      .map((entry) => ({ ...this.rowToMemory(entry.row), score: entry.score, reason: "match" as const }));

    return [...instructions, ...scored];
  }

  /** Everything the reader may see, unranked — the Memory tab's list view. */
  listMemories(pairingId: string, readerAgentId: string): Memory[] {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, readerAgentId);
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE pairing_id = ? ORDER BY updated_at DESC`)
      .all(pairingId) as MemoryRow[];
    return rows
      .filter((row) => row.visibility === "team" || row.author_agent_id === readerAgentId)
      .map((row) => this.rowToMemory(row));
  }

  /**
   * Forgetting is a real operation, not a soft flag: a memory that is wrong
   * keeps being re-injected into a teammate's context until it is gone. Only
   * the author may forget, so a peer cannot quietly delete what your agent
   * knows.
   */
  forget(pairingId: string, actorAgentId: string, key: string): { key: string; forgotten: boolean } {
    const pairing = this.getPairing(pairingId);
    this.assertMember(pairing, actorAgentId);
    const normalized = normalizeMemoryKey(key);
    const existing = this.getMemoryRow(pairingId, normalized);
    if (!existing) throw notFound(`No memory "${normalized}" in pairing "${pairingId}"`);
    if (existing.author_agent_id !== actorAgentId) {
      throw forbidden(`Only the author of memory "${normalized}" can forget it`);
    }

    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(existing.id);
    this.credentials.record(
      pairingId,
      "memory.forgotten",
      { principal: this.credentials.agentPrincipal(actorAgentId), agent: actorAgentId, credential: null },
      "pop",
      { memoryId: existing.id, key: normalized },
    );
    relayEvents.publish({ type: "memory.forgotten", pairingId, key: normalized });
    return { key: normalized, forgotten: true };
  }

  private getMemoryRow(pairingId: string, key: string): MemoryRow | undefined {
    return this.db.prepare(`SELECT * FROM memories WHERE pairing_id = ? AND key = ?`).get(pairingId, key) as
      | MemoryRow
      | undefined;
  }

  private rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      pairingId: row.pairing_id,
      authorAgentId: row.author_agent_id,
      kind: row.kind as MemoryKind,
      key: row.key,
      body: row.body,
      tags: JSON.parse(row.tags),
      visibility: row.visibility as MemoryVisibility,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------
  // Delegation
  // ---------------------------------------------------------------------

  /**
   * Suggests an owner for a task from declared profiles and live usage.
   *
   * This only ever SUGGESTS. Assignment stays an explicit, attributed call
   * (`assignTask`) because "who owns this" is a claim a human may need to
   * overrule, and an auto-assigning relay would be making that call on their
   * behalf with no signature behind it. What this returns is a rationale
   * good enough to paste into `assignTask` — the routing brain, not the hand.
   */
  suggestOwner(pairingId: string, input: SuggestOwnerInput = {}): OwnerSuggestion {
    const pairing = this.getPairing(pairingId);
    const profiles = new Map(this.getAgentProfiles(pairingId).map((profile) => [profile.agentId, profile]));
    const usage = this.getUsage(pairingId);
    const wanted = memoryTerms([input.title, input.description, (input.needs ?? []).join(" ")].filter(Boolean).join(" "));

    const candidates = pairing.members
      // A revoked member cannot do the work, so it must never be suggested.
      .filter((agentId) => !this.isAgentRevoked(agentId))
      .map((agentId) => {
        const profile = profiles.get(agentId);
        const strengths = (profile?.strengths ?? []).map((entry) => entry.toLowerCase());
        // Strength match dominates: the right model for the job matters more
        // than who happens to be cheapest right now.
        const strengthHits = wanted.filter((term) =>
          strengths.some((strength) => strength.includes(term) || term.includes(strength)),
        ).length;
        const spent = usage.byAgent[agentId]?.tokensUsed ?? 0;
        return { agentId, model: profile?.model ?? null, strengthHits, tokensUsed: spent };
      });

    // Load balance on tokens spent, normalized so the tiebreak can never
    // outrank a real strength match — an idle teammate with the wrong model
    // should not win over a busy one with the right one.
    const busiest = Math.max(1, ...candidates.map((entry) => entry.tokensUsed));
    const ranked = candidates
      .map((entry) => ({ ...entry, score: entry.strengthHits * 10 + (1 - entry.tokensUsed / busiest) }))
      // agentId last so an unbroken tie still yields the SAME suggestion on
      // every call — a delegation that flips between two equally-ranked
      // members is not a recommendation anyone can act on.
      .sort((a, b) => b.score - a.score || a.tokensUsed - b.tokensUsed || a.agentId.localeCompare(b.agentId));

    const best = ranked[0];
    if (!best) throw conflict(`Pairing "${pairingId}" has no eligible members to take work`);

    const why = best.strengthHits
      ? `matches ${best.strengthHits} of the task's needs${best.model ? ` on ${best.model}` : ""}`
      : `no declared strength matched, so this is the member with the most runway left${best.model ? ` (${best.model})` : ""}`;

    return {
      suggested: best.agentId,
      rationale: `${shortAgentId(best.agentId)} ${why}; ${best.tokensUsed.toLocaleString()} tokens spent so far.`,
      candidates: ranked,
    };
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
    return foldUsage(pairingId, pairing.members, this.getUsageReports(pairingId));
  }

  /** Usage plus the runway derived from it — what agents actually plan against. */
  getUsageSnapshot(pairingId: string, now: number = Date.now()): UsageSnapshot {
    const pairing = this.getPairing(pairingId);
    const reports = this.getUsageReports(pairingId);
    const usage = foldUsage(pairingId, pairing.members, reports);
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
      members: this.getMembers(row.id),
      approvalPolicy: (row.approval_policy as Pairing["approvalPolicy"]) ?? "unanimous",
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
      sandboxId: row.sandbox_id,
      sandboxState: row.sandbox_state as Plan["sandboxState"],
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
