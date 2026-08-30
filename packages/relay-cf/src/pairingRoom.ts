/**
 * PairingRoom — one Durable Object instance per pairing (idFromName(pairingId)).
 *
 * Owns everything scoped to a single pairing: the pairing row itself,
 * messages, plans, and consent. This is the isolation boundary — a request
 * against one pairing physically cannot read or write another pairing's
 * state, because it is a different object with different storage, not a
 * shared table filtered by a WHERE clause. That is a structurally stronger
 * guarantee than the single-SQLite-file relay (packages/relay) provides,
 * where isolation is enforced by application logic that has to get every
 * query right.
 *
 * Every method a Worker calls directly on the DO stub is RPC-safe (returns
 * `RpcResult<T>` rather than throwing — see rpcError.ts for why). Internal
 * helpers that are never called across the RPC boundary keep normal
 * throw/catch semantics; the `OrThrow` suffix marks those.
 */
import {
  contextKey,
  modeOnPlanLock,
  parseSessionDescriptor,
  serializeSessionDescriptor,
  LedgerCache,
  PresenceStore,
  type ContextEntry,
  type ContextInput,
  type LedgerStats,
  type Presence,
  type PresenceEntry,
  type SessionDescriptor,
} from "inzo-protocol";
import { DurableObject } from "cloudflare:workers";
import {
  AUDIT_SCHEMA,
  badRequest,
  computeRunway,
  CONSENT_SCHEMA,
  foldUsage,
  forbidden,
  generateId,
  GENESIS_HASH,
  hashRecord,
  isSatisfied,
  notFound,
  planSubjectHash,
  rowToConsent,
  stalePlan,
  subjectHashMismatch,
  verifyApprovalSignature,
  type Approval,
  type Assurance,
  type AuditAction,
  type AuditActor,
  type AuditRecord,
  type ConsentRecord,
  type ConsentRow,
  type CredentialPayload,
} from "./lib.js";
import { rpcSafe, type RpcResult } from "./rpcError.js";
import type { Budget, CombinedUsage, ItemStatus, Message, Pairing, Plan, PlanItem, PlanWithStatus, UsageReport, UsageSnapshot } from "./types.js";

/** Bounds join-spam via repeated per-invite codes on one pairing. Mirrors packages/relay's store.ts. */
const MAX_MEMBERS = 8;

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  approval_policy TEXT NOT NULL DEFAULT 'unanimous',
  created_at TEXT NOT NULL,
  session TEXT
);

-- Full membership. agent_a/agent_b above stay populated for back-compat
-- (the creator and first joiner) but this table is the source of truth once
-- a pairing has more than two members. Mirrors packages/relay's schema.
CREATE TABLE IF NOT EXISTS pairing_members (
  agent_id  TEXT PRIMARY KEY,
  joined_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  pairing_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  items TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Live per-item progress, deliberately separate from \`plans\`: this is
-- mutable operational state, never part of what a signed consent approval
-- covers (see PlanWithStatus in types.ts). Keyed by the plan's own version
-- so a re-proposed plan's stale indices from a prior version are never read
-- as if they applied to the new one.
CREATE TABLE IF NOT EXISTS plan_item_status (
  pairing_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  item_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pairing_id, plan_version, item_index)
);

CREATE TABLE IF NOT EXISTS budgets (
  pairing_id TEXT PRIMARY KEY,
  deadline TEXT,
  token_budget INTEGER,
  cost_budget_usd REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_reports (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tokens_used INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  wall_clock_ms INTEGER NOT NULL,
  progress_pct REAL NOT NULL,
  created_at TEXT NOT NULL
);

${CONSENT_SCHEMA}
${AUDIT_SCHEMA}
`;

interface AuditRow {
  pairing_id: string;
  seq: number;
  at: string;
  actor: string;
  action: string;
  assurance: string;
  detail: string;
  prev_hash: string;
  hash: string;
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
  agent_id: string;
  tokens_used: number;
  cost_usd: number;
  wall_clock_ms: number;
  progress_pct: number;
  created_at: string;
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

export interface Digest {
  pairingId: string;
  generatedAt: string;
  plan: PlanWithStatus | null;
  consent: ConsentRecord | null;
  usage: UsageSnapshot;
  recentMessages: Message[];
}

/** This DO doesn't read bindings off `env` — it's fully self-contained. */
type Env = Record<string, never>;

interface StreamSubscriber {
  agentId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export class PairingRoom extends DurableObject<Env> {
  /**
   * In-memory only, per warm DO instance — this is what makes "both humans
   * watch it happen live" real instead of a polling loop, mirroring
   * packages/relay's stream.ts (which uses a Node EventEmitter for the same
   * purpose). Every mutating method below calls broadcast() after it commits,
   * so a subscriber's connection is just this Set until it disconnects.
   */
  private readonly streamSubscribers = new Set<StreamSubscriber>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(SCHEMA);
  }

  initialize(
    id: string,
    code: string,
    agentA: string,
    agentB: string,
    createdAt: string,
    session?: SessionDescriptor | null,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO pairing (id, code, agent_a, agent_b, created_at, session) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      code,
      agentA,
      agentB,
      createdAt,
      session ? serializeSessionDescriptor(session) : null,
    );
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO pairing_members (agent_id, joined_at) VALUES (?, ?)`, agentA, createdAt);
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO pairing_members (agent_id, joined_at) VALUES (?, ?)`, agentB, createdAt);
  }

  /** Adds a 3rd+ member to an already-initialized pairing (via an invite code). */
  addMember(agentId: string, joinedAt: string): RpcResult<Pairing> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      if (pairing.members.length >= MAX_MEMBERS) {
        throw badRequest(`Pairing "${pairing.id}" already has the maximum of ${MAX_MEMBERS} members`);
      }
      this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO pairing_members (agent_id, joined_at) VALUES (?, ?)`, agentId, joinedAt);
      return this.getPairingOrThrow();
    });
  }

  // -----------------------------------------------------------------------
  // Live stream — GET /pairings/:id/stream, forwarded here as a raw fetch()
  // by the Worker (not an RPC method) so the connection can stay open and be
  // written to later from addMessage/proposePlan/etc. The Worker has already
  // authenticated the caller by the time it calls this — see index.ts.
  // -----------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
    if (!agentId) return new Response("agentId is required", { status: 400 });
    const pairing = this.getPairingOrThrow();

    let subscriber: StreamSubscriber;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = { agentId, controller };
        this.streamSubscribers.add(subscriber);
        controller.enqueue(
          encoder.encode(`event: ready\ndata: ${JSON.stringify({ pairingId: pairing.id, agentId, at: new Date().toISOString() })}\n\n`),
        );
      },
      cancel: () => {
        this.streamSubscribers.delete(subscriber);
      },
    });
    request.signal.addEventListener("abort", () => this.streamSubscribers.delete(subscriber));

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        // Matches index.ts's SECURITY_HEADERS — this response bypasses the
        // json() helper that normally applies them, so they're set here by
        // hand. Referrer-Policy matters most on this route specifically:
        // it's the one response that can carry a credential in the query
        // string it was requested with.
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  }

  private broadcast(event: string, data: unknown): void {
    if (this.streamSubscribers.size === 0) return;
    const line = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const sub of this.streamSubscribers) {
      try {
        sub.controller.enqueue(line);
      } catch {
        this.streamSubscribers.delete(sub);
      }
    }
  }

  /**
   * Ejects a revoked agent's own stream — the same fail-closed behavior the
   * request path applies to a revoked token. Called by the Worker's revoke
   * handler after it has already told Registry to revoke the credential.
   */
  broadcastRevocation(revokedAgentId: string, revokedAt: string, by: string): void {
    this.broadcast("pairing.revoked", { revocation: { revokedAgentId, revokedAt, by } });
    for (const sub of this.streamSubscribers) {
      if (sub.agentId === revokedAgentId) {
        try {
          sub.controller.close();
        } catch {
          /* already closed */
        }
        this.streamSubscribers.delete(sub);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pairing — `OrThrow` variants are for internal use only, never returned
  // directly from an RPC method.
  // -----------------------------------------------------------------------

  private getMembers(): string[] {
    const rows = [...this.ctx.storage.sql.exec(`SELECT agent_id FROM pairing_members ORDER BY joined_at ASC`)] as Array<{
      agent_id: string;
    }>;
    return rows.map((row) => row.agent_id);
  }

  private getPairingOrThrow(): Pairing {
    const row = [...this.ctx.storage.sql.exec(`SELECT * FROM pairing LIMIT 1`)][0] as
      | {
        id: string;
        code: string;
        agent_a: string;
        agent_b: string;
        approval_policy: string;
        created_at: string;
        session: string | null;
      }
      | undefined;
    if (!row) throw notFound("This pairing does not exist");
    return {
      id: row.id,
      code: row.code,
      agentA: row.agent_a,
      agentB: row.agent_b,
      members: this.getMembers(),
      approvalPolicy: (row.approval_policy as Pairing["approvalPolicy"]) ?? "unanimous",
      createdAt: row.created_at,
      session: parseSessionDescriptor(row.session),
    };
  }

  private assertMemberOrThrow(pairing: Pairing, agentId: string): void {
    if (!pairing.members.includes(agentId)) {
      throw forbidden(`Agent "${agentId}" is not part of pairing "${pairing.id}"`);
    }
  }

  getPairing(): RpcResult<Pairing> {
    return rpcSafe(() => this.getPairingOrThrow());
  }

  // ---------------------------------------------------------------------
  // Presence — instance memory only, deliberately
  // ---------------------------------------------------------------------

  /**
   * Never written to `ctx.storage`.
   *
   * Durable Object storage writes are billed and add latency, and a hint that
   * expires in 90 seconds deserves neither. It also stays out of the audit
   * chain: a heartbeat in a tamper-evident record devalues the record.
   *
   * The consequence — presence is lost if this DO is evicted — is correct.
   * Every member re-posts on their next change, and the room is already
   * resident whenever anyone is actually watching.
   */
  private readonly presenceStore = new PresenceStore();

  setPresence(agentId: string, presence: Presence): RpcResult<PresenceEntry> {
    return rpcSafe(() => {
      this.assertMemberOrThrow(this.getPairingOrThrow(), agentId);
      const entry = this.presenceStore.set(agentId, presence);
      this.broadcast("presence.updated", { presence: entry });
      return entry;
    });
  }

  /** Live entries only. Expiry is applied on read, so no alarm is needed. */
  getPresence(agentId: string): RpcResult<PresenceEntry[]> {
    return rpcSafe(() => {
      this.assertMemberOrThrow(this.getPairingOrThrow(), agentId);
      return this.presenceStore.list();
    });
  }

  // ---------------------------------------------------------------------
  // Shared context ledger (T-7)
  // ---------------------------------------------------------------------

  /**
   * Instance memory, LRU, hard-capped by `LedgerCache` (shared with the
   * Express relay via `inzo-protocol`) — see that class for why the eviction
   * policy lives there rather than here.
   */
  private readonly ledger = new LedgerCache();

  putContext(agentId: string, input: ContextInput): RpcResult<ContextEntry> {
    return rpcSafe(() => {
      this.assertMemberOrThrow(this.getPairingOrThrow(), agentId);
      const entry: ContextEntry = { ...input, agentId, at: new Date().toISOString() };
      this.ledger.put(contextKey(input.path, input.sha), entry);
      return entry;
    });
  }

  /**
   * A hit only on an exact `path@sha` match. A summary of content that has
   * since changed describes code that no longer exists, and returning it
   * would be worse than a miss — the agent would act on it confidently.
   */
  getContext(agentId: string, path: string, sha: string): RpcResult<{ context: ContextEntry | null; stats: LedgerStats }> {
    return rpcSafe(() => {
      this.assertMemberOrThrow(this.getPairingOrThrow(), agentId);
      const context = this.ledger.get(contextKey(path, sha));
      return { context, stats: this.ledger.stats() };
    });
  }

  getSession(): RpcResult<SessionDescriptor | null> {
    return rpcSafe(() => {
      const row = [...this.ctx.storage.sql.exec(`SELECT session FROM pairing LIMIT 1`)][0] as
        | { session: string | null }
        | undefined;
      return parseSessionDescriptor(row?.session ?? null);
    });
  }

  /**
   * Replaces the session descriptor.
   *
   * Changing the mode never changes a credential: scope is fixed at mint and
   * only narrows. A mode selects local sandbox policy and agent playbook.
   */
  setSession(agentId: string, session: SessionDescriptor): RpcResult<SessionDescriptor> {
    return rpcSafe(() => {
      this.assertMemberOrThrow(this.getPairingOrThrow(), agentId);
      this.ctx.storage.sql.exec(`UPDATE pairing SET session = ?`, serializeSessionDescriptor(session));
      this.broadcast("session.updated", { session });
      return session;
    });
  }

  assertMember(pairing: Pairing, agentId: string): RpcResult<void> {
    return rpcSafe(() => this.assertMemberOrThrow(pairing, agentId));
  }

  /** Only well-defined for a 2-member pairing — see packages/relay's store.ts equivalent. */
  otherAgent(pairing: Pairing, agentId: string): RpcResult<string> {
    return rpcSafe(() => {
      if (pairing.members.length !== 2) {
        throw badRequest(`"peer" is ambiguous for pairing "${pairing.id}" (${pairing.members.length} members) — specify an agent id`);
      }
      return agentId === pairing.members[0] ? pairing.members[1] : pairing.members[0];
    });
  }

  // -----------------------------------------------------------------------
  // Messages
  // -----------------------------------------------------------------------

  addMessage(fromAgentId: string, body: string): RpcResult<Message> {
    return rpcSafe(() => {
      if (typeof body !== "string" || !body.trim()) throw badRequest("body is required");
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, fromAgentId);

      const id = generateId("msg");
      const createdAt = new Date().toISOString();
      const result = this.ctx.storage.sql.exec(
        `INSERT INTO messages (id, from_agent_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING rowid AS cursor`,
        id,
        fromAgentId,
        body,
        createdAt,
      );
      const cursor = Number([...result][0]!.cursor);
      const message = { id, pairingId: pairing.id, fromAgentId, body, createdAt, cursor };
      this.broadcast("message.created", { message });
      return message;
    });
  }

  getMessages(since?: number): RpcResult<Message[]> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      const rows = (
        since
          ? [...this.ctx.storage.sql.exec(`SELECT *, rowid AS cursor FROM messages WHERE rowid > ? ORDER BY rowid ASC`, since)]
          : [...this.ctx.storage.sql.exec(`SELECT *, rowid AS cursor FROM messages ORDER BY rowid ASC`)]
      ) as Array<{ id: string; from_agent_id: string; body: string; created_at: string; cursor: number }>;
      return rows.map((row) => this.rowToMessage(pairing.id, row));
    });
  }

  private getRecentMessages(pairingId: string, limit: number): Message[] {
    const rows = [
      ...this.ctx.storage.sql.exec(`SELECT *, rowid AS cursor FROM messages ORDER BY rowid DESC LIMIT ?`, limit),
    ] as Array<{ id: string; from_agent_id: string; body: string; created_at: string; cursor: number }>;
    return rows.reverse().map((row) => this.rowToMessage(pairingId, row));
  }

  private rowToMessage(
    pairingId: string,
    row: { id: string; from_agent_id: string; body: string; created_at: string; cursor: number },
  ): Message {
    return { id: row.id, pairingId, fromAgentId: row.from_agent_id, body: row.body, createdAt: row.created_at, cursor: row.cursor };
  }

  // -----------------------------------------------------------------------
  // Plans + consent
  // -----------------------------------------------------------------------

  private getPlanRow(): PlanRow | undefined {
    return [...this.ctx.storage.sql.exec(`SELECT * FROM plans LIMIT 1`)][0] as unknown as PlanRow | undefined;
  }

  private rowToPlan(row: PlanRow): Plan {
    return {
      pairingId: row.pairing_id,
      goal: row.goal,
      items: JSON.parse(row.items) as PlanItem[],
      proposedBy: row.proposed_by,
      approvedBy: JSON.parse(row.approved_by) as string[],
      locked: !!row.locked,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // This relay has no AgentRun integration; null is accurate, not a stub.
      sandboxId: null,
      sandboxState: null,
    };
  }

  private getItemStatusMap(pairingId: string, planVersion: number): Map<number, ItemStatus> {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT item_index, status FROM plan_item_status WHERE pairing_id = ? AND plan_version = ?`,
        pairingId,
        planVersion,
      ),
    ] as Array<{ item_index: number; status: ItemStatus }>;
    return new Map(rows.map((row) => [row.item_index, row.status]));
  }

  private withStatus(plan: Plan): PlanWithStatus {
    const statuses = this.getItemStatusMap(plan.pairingId, plan.version);
    return { ...plan, items: plan.items.map((item, index) => ({ ...item, status: statuses.get(index) ?? "pending" })) };
  }

  getPlan(): PlanWithStatus | null {
    const row = this.getPlanRow();
    return row ? this.withStatus(this.rowToPlan(row)) : null;
  }

  private getConsentOrThrow(): ConsentRecord | null {
    const pairing = this.getPairingOrThrow();
    const row = [...this.ctx.storage.sql.exec(`SELECT * FROM consent_records WHERE pairing_id = ?`, pairing.id)][0] as unknown as
      | ConsentRow
      | undefined;
    return row ? rowToConsent(row) : null;
  }

  getConsent(): ConsentRecord | null {
    // Never throws in practice — a pairing always exists once this DO has
    // been initialize()'d, which happens before any client learns its ID.
    return this.getConsentOrThrow();
  }

  private writeConsent(record: ConsentRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO consent_records (pairing_id, subject_kind, subject_version, subject_hash, required, approvals, satisfied, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pairing_id) DO UPDATE SET
         subject_kind = excluded.subject_kind, subject_version = excluded.subject_version,
         subject_hash = excluded.subject_hash, required = excluded.required, approvals = excluded.approvals,
         satisfied = excluded.satisfied, updated_at = excluded.updated_at`,
      record.pairingId,
      record.subject.kind,
      record.subject.version,
      record.subject.hash,
      JSON.stringify(record.required),
      JSON.stringify(record.approvals),
      record.satisfied ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    );
  }

  /**
   * `principals` is supplied by the Worker (it already resolved both agents'
   * principal IDs via Registry) rather than fetched here, so this object
   * never needs to call out to another Durable Object mid-request.
   */
  proposePlan(
    pairingId: string,
    proposedBy: string,
    goal: string,
    items: PlanItem[],
    principals: string[],
    actor: AuditActor,
    assurance: Assurance,
  ): RpcResult<Plan> {
    return rpcSafe(() => {
      if (typeof goal !== "string" || !goal.trim()) throw badRequest("goal is required");
      if (!Array.isArray(items) || items.length === 0) throw badRequest("items must be a non-empty array of { owner, task }");
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, proposedBy);

      items.forEach((item, index) => {
        if (!item?.owner?.trim() || !item?.task?.trim()) throw badRequest("each plan item requires an owner and a task");
        // The owner must be an actual participant of this pairing, not free
        // text — otherwise "don't touch an item you don't own" has nothing
        // real to check a caller's identity against.
        if (!pairing.members.includes(item.owner)) {
          throw badRequest(`Item ${index}'s owner "${item.owner}" is not a participant of this pairing`);
        }
        if (item.dependsOn !== undefined) {
          if (!Array.isArray(item.dependsOn)) throw badRequest(`Item ${index}'s dependsOn must be an array of item indices`);
          for (const dep of item.dependsOn) {
            // Only earlier indices are allowed — that alone makes a
            // dependency cycle syntactically unrepresentable, no graph
            // traversal needed to reject one.
            if (!Number.isInteger(dep) || dep < 0 || dep >= index) {
              throw badRequest(`Item ${index}'s dependsOn must reference earlier items only (got ${dep})`);
            }
          }
        }
      });

      const now = new Date().toISOString();
      const existing = this.getPlanRow();
      const createdAt = existing?.created_at ?? now;
      const version = (existing?.version ?? 0) + 1;

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
        // This relay has no AgentRun integration; null is accurate, not a stub.
        sandboxId: null,
        sandboxState: null,
      };

      this.ctx.storage.sql.exec(
        `INSERT INTO plans (pairing_id, goal, items, proposed_by, approved_by, locked, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(pairing_id) DO UPDATE SET
           goal = excluded.goal, items = excluded.items, proposed_by = excluded.proposed_by,
           approved_by = excluded.approved_by, locked = 0, version = excluded.version, updated_at = excluded.updated_at`,
        pairingId,
        goal,
        JSON.stringify(items),
        proposedBy,
        JSON.stringify([]),
        version,
        createdAt,
        now,
      );

      // Any status recorded against a prior version's item indices no longer
      // means anything once the items array has been replaced.
      this.ctx.storage.sql.exec(`DELETE FROM plan_item_status WHERE pairing_id = ? AND plan_version != ?`, pairingId, version);

      const uniquePrincipals = [...new Set(principals.filter(Boolean))];
      if (uniquePrincipals.length === pairing.members.length) {
        const subject = { kind: "plan" as const, version, hash: planSubjectHash(plan) };
        this.writeConsent({
          pairingId,
          subject,
          required: uniquePrincipals,
          approvals: [],
          satisfied: false,
          createdAt: now,
          updatedAt: now,
        });
      }

      this.appendAudit("plan.proposed", actor, assurance, { version, subjectHash: planSubjectHash(plan) });
      this.broadcast("plan.updated", { plan });
      return plan;
    });
  }

  approvePlan(
    agentId: string,
    planVersion: unknown,
    consent?: { payload: CredentialPayload; signature: unknown },
  ): RpcResult<Plan & { consent?: ConsentRecord }> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, agentId);

      const row = this.getPlanRow();
      if (!row) throw notFound(`No plan has been proposed for pairing "${pairing.id}"`);
      if (typeof planVersion !== "number" || !Number.isInteger(planVersion)) {
        throw badRequest("planVersion is required and must be the integer version of the plan you read");
      }
      if (planVersion !== row.version) throw stalePlan(planVersion, row.version);

      const approvedBy = new Set<string>(JSON.parse(row.approved_by));
      approvedBy.add(agentId);
      // Unanimous — the only approvalPolicy read today (see Pairing.approvalPolicy).
      const locked = pairing.members.every((member) => approvedBy.has(member));
      const updatedAt = new Date().toISOString();

      this.ctx.storage.sql.exec(
        `UPDATE plans SET approved_by = ?, locked = ?, updated_at = ? WHERE pairing_id = ?`,
        JSON.stringify([...approvedBy]),
        locked ? 1 : 0,
        updatedAt,
        pairing.id,
      );
      const plan = this.rowToPlan({ ...row, approved_by: JSON.stringify([...approvedBy]), locked: locked ? 1 : 0, updated_at: updatedAt });

      let consentRecord: ConsentRecord | undefined;
      if (consent) {
        if (typeof consent.signature !== "string" || !consent.signature) {
          throw badRequest("signature is required: sign the consent statement with your holder key");
        }
        const current = this.getConsentOrThrow();
        if (!current) throw notFound(`No plan has been proposed for pairing "${pairing.id}"`);
        const expected = planSubjectHash(plan);
        if (current.subject.hash !== expected) {
          throw subjectHashMismatch(expected, current.subject.hash);
        }
        if (!current.required.includes(consent.payload.prn)) {
          throw forbidden("This principal is not one of the parties whose consent is required");
        }
        if (!verifyApprovalSignature(pairing.id, current.subject, consent.signature, consent.payload.cnf.jwk)) {
          throw badRequest("Approval signature does not verify against this credential's holder key");
        }
        const approval: Approval = { principal: consent.payload.prn, credential: consent.payload.jti, at: updatedAt, signature: consent.signature };
        const approvals = [...current.approvals.filter((entry) => entry.principal !== approval.principal), approval];
        consentRecord = { ...current, approvals, satisfied: isSatisfied({ required: current.required, approvals }), updatedAt: approval.at };
        this.writeConsent(consentRecord);

        const approvalActor: AuditActor = { principal: consent.payload.prn, agent: consent.payload.sub, credential: consent.payload.jti };
        this.appendAudit("consent.approved", approvalActor, "pop", { version: plan.version, subjectHash: expected });
        if (consentRecord.satisfied) {
          this.appendAudit("consent.satisfied", approvalActor, "pop", { version: plan.version, subjectHash: expected });
        }
      }

      this.broadcast("plan.updated", { plan });

      // Unanimous consent on a task split IS the start of building, so the
      // session advances itself rather than making a human type `inzo mode
      // build`. `cowork` stays put — see modeOnPlanLock.
      if (locked && pairing.session) {
        const next = modeOnPlanLock(pairing.session.mode);
        if (next) {
          const advanced = { ...pairing.session, mode: next };
          this.ctx.storage.sql.exec(`UPDATE pairing SET session = ?`, serializeSessionDescriptor(advanced));
          this.broadcast("session.updated", { session: advanced });
        }
      }

      return consentRecord ? { ...plan, consent: consentRecord } : plan;
    });
  }

  /**
   * Marks one item's live progress. Deliberately does not touch `plans` or
   * `consent_records` — see the `plan_item_status` schema comment. Gated on
   * the plan being locked (both sides have agreed) so "start work" always
   * means work against an actually-agreed goal, never a draft still being
   * negotiated.
   */
  updateItemStatus(agentId: string, itemIndex: number, status: ItemStatus, actor: AuditActor, assurance: Assurance): RpcResult<PlanWithStatus> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, agentId);
      if (!["pending", "in_progress", "done"].includes(status)) {
        throw badRequest(`status must be one of pending, in_progress, done (got "${status}")`);
      }

      const row = this.getPlanRow();
      if (!row) throw notFound(`No plan has been proposed for pairing "${pairing.id}"`);
      const plan = this.rowToPlan(row);
      if (!plan.locked) throw badRequest("The plan must be approved by both sides before item progress can be tracked");
      if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= plan.items.length) {
        throw badRequest(`itemIndex must be between 0 and ${plan.items.length - 1}`);
      }

      const item = plan.items[itemIndex]!;
      if (item.owner !== agentId) {
        throw forbidden(`Item ${itemIndex} ("${item.task}") belongs to ${item.owner}, not ${agentId} — an agent may only update its own items`);
      }

      const statuses = this.getItemStatusMap(plan.pairingId, plan.version);
      if (status !== "pending" && item.dependsOn?.length) {
        const unfinished = item.dependsOn.filter((dep) => (statuses.get(dep) ?? "pending") !== "done");
        if (unfinished.length > 0) {
          throw badRequest(`Item ${itemIndex} depends on item(s) ${unfinished.join(", ")}, which are not done yet`);
        }
      }

      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO plan_item_status (pairing_id, plan_version, item_index, status, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pairing_id, plan_version, item_index) DO UPDATE SET
           status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        plan.pairingId,
        plan.version,
        itemIndex,
        status,
        agentId,
        now,
      );

      this.appendAudit("plan.item_status_changed", actor, assurance, { version: plan.version, itemIndex, task: item.task, status });
      const updated = this.withStatus(plan);
      this.broadcast("plan.item_status_changed", { plan: updated, itemIndex, status });
      return updated;
    });
  }

  withdrawConsent(principalId: string, actor: AuditActor, assurance: Assurance): RpcResult<ConsentRecord> {
    return rpcSafe(() => {
      const current = this.getConsentOrThrow();
      if (!current) throw notFound(`No consent record for pairing`);
      const approvals = current.approvals.filter((entry) => entry.principal !== principalId);
      const next: ConsentRecord = { ...current, approvals, satisfied: isSatisfied({ required: current.required, approvals }), updatedAt: new Date().toISOString() };
      this.writeConsent(next);
      this.appendAudit("consent.withdrawn", actor, assurance, { principal: principalId });
      return next;
    });
  }

  /** §6.3.7 — a revoked credential's approval is withdrawn with it. Never throws: returns null if there's nothing to withdraw. */
  withdrawByCredentials(jtis: string[]): ConsentRecord | null {
    const current = this.getConsentOrThrow();
    if (!current) return null;
    const dead = new Set(jtis);
    const approvals = current.approvals.filter((entry) => !dead.has(entry.credential));
    if (approvals.length === current.approvals.length) return current;
    const next: ConsentRecord = { ...current, approvals, satisfied: isSatisfied({ required: current.required, approvals }), updatedAt: new Date().toISOString() };
    this.writeConsent(next);
    return next;
  }

  // -----------------------------------------------------------------------
  // Budget + usage + runway
  // -----------------------------------------------------------------------

  setBudget(agentId: string, input: { deadline?: unknown; tokenBudget?: unknown; costBudgetUsd?: unknown }): RpcResult<Budget> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, agentId);

      const existing = this.getBudgetOrThrow();
      const next: Budget = {
        pairingId: pairing.id,
        deadline: "deadline" in input ? normalizeDeadline(input.deadline) : (existing?.deadline ?? null),
        tokenBudget: "tokenBudget" in input ? normalizeNumber(input.tokenBudget, "tokenBudget") : (existing?.tokenBudget ?? null),
        costBudgetUsd: "costBudgetUsd" in input ? normalizeNumber(input.costBudgetUsd, "costBudgetUsd") : (existing?.costBudgetUsd ?? null),
        updatedAt: new Date().toISOString(),
      };

      this.ctx.storage.sql.exec(
        `INSERT INTO budgets (pairing_id, deadline, token_budget, cost_budget_usd, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pairing_id) DO UPDATE SET
           deadline = excluded.deadline, token_budget = excluded.token_budget,
           cost_budget_usd = excluded.cost_budget_usd, updated_at = excluded.updated_at`,
        next.pairingId,
        next.deadline,
        next.tokenBudget,
        next.costBudgetUsd,
        next.updatedAt,
      );
      this.broadcast("budget.updated", { budget: next });
      return next;
    });
  }

  private getBudgetOrThrow(): Budget | null {
    const pairing = this.getPairingOrThrow();
    const row = [...this.ctx.storage.sql.exec(`SELECT * FROM budgets WHERE pairing_id = ?`, pairing.id)][0] as unknown as BudgetRow | undefined;
    return row
      ? { pairingId: pairing.id, deadline: row.deadline, tokenBudget: row.token_budget, costBudgetUsd: row.cost_budget_usd, updatedAt: row.updated_at }
      : null;
  }

  getBudget(): Budget | null {
    return this.getBudgetOrThrow();
  }

  reportUsage(agentId: string, input: { tokensUsed: number; costUsd: number; wallClockMs: number; progressPct: number }): RpcResult<UsageReport> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, agentId);

      const { tokensUsed, costUsd, wallClockMs, progressPct } = input;
      for (const [name, value] of Object.entries({ tokensUsed, costUsd, wallClockMs, progressPct })) {
        if (typeof value !== "number" || Number.isNaN(value) || value < 0) throw badRequest(`${name} must be a non-negative number`);
      }
      if (progressPct > 100) throw badRequest("progressPct must be between 0 and 100");

      const usage: UsageReport = { id: generateId("usage"), pairingId: pairing.id, agentId, tokensUsed, costUsd, wallClockMs, progressPct, createdAt: new Date().toISOString() };
      this.ctx.storage.sql.exec(
        `INSERT INTO usage_reports (id, agent_id, tokens_used, cost_usd, wall_clock_ms, progress_pct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        usage.id,
        usage.agentId,
        usage.tokensUsed,
        usage.costUsd,
        usage.wallClockMs,
        usage.progressPct,
        usage.createdAt,
      );
      // Recomputed at emit time, matching packages/relay's stream.ts, so
      // watchers get the number GET /usage would give them, not a stale copy.
      this.broadcast("usage.reported", this.getUsageSnapshot());
      return usage;
    });
  }

  private getUsageReports(pairingId: string): UsageReport[] {
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM usage_reports ORDER BY created_at ASC, rowid ASC`)] as unknown as UsageRow[];
    return rows.map((row) => ({
      id: row.id,
      pairingId,
      agentId: row.agent_id,
      tokensUsed: row.tokens_used,
      costUsd: row.cost_usd,
      wallClockMs: row.wall_clock_ms,
      progressPct: row.progress_pct,
      createdAt: row.created_at,
    }));
  }

  getUsage(): CombinedUsage {
    const pairing = this.getPairingOrThrow();
    return foldUsage(pairing.id, pairing.members, this.getUsageReports(pairing.id));
  }

  /** Usage plus the runway derived from it — what agents actually plan against. */
  getUsageSnapshot(now: number = Date.now()): UsageSnapshot {
    const pairing = this.getPairingOrThrow();
    const reports = this.getUsageReports(pairing.id);
    const usage = foldUsage(pairing.id, pairing.members, reports);
    const runway = computeRunway(this.getBudgetOrThrow(), usage, reports, now);
    return { usage, runway };
  }

  // -----------------------------------------------------------------------
  // Audit log — append-only, hash-chained. Mirrors packages/relay's
  // AuditLog (PROTOCOL.md §7): `hash = SHA256(prevHash ++ canonical(record
  // without hash))`, so tampering, reordering, or deleting any record breaks
  // every hash after it. `verify()` is the check that makes the log worth
  // anything — an auditor recomputes the chain from genesis and any edit
  // surfaces as the seq where recomputation first diverges.
  // -----------------------------------------------------------------------

  private auditHeadOrThrow(): AuditRecord | null {
    const row = [...this.ctx.storage.sql.exec(`SELECT * FROM audit_records ORDER BY seq DESC LIMIT 1`)][0] as unknown as
      | AuditRow
      | undefined;
    return row ? this.rowToAuditRecord(row) : null;
  }

  private rowToAuditRecord(row: AuditRow): AuditRecord {
    return {
      seq: row.seq,
      at: row.at,
      pairingId: row.pairing_id,
      actor: JSON.parse(row.actor) as AuditActor,
      action: row.action as AuditAction,
      assurance: row.assurance as Assurance,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
      prevHash: row.prev_hash,
      hash: row.hash,
    };
  }

  /**
   * Appends one record to this pairing's chain. Called internally by the
   * methods above at every trust-relevant transition (plan proposed,
   * consent approved, etc.), and directly by the Worker for events that
   * originate outside this DO (a pairing forming in Registry, a credential
   * revoked in Registry).
   */
  appendAudit(action: AuditAction, actor: AuditActor, assurance: Assurance, detail: Record<string, unknown> = {}): AuditRecord {
    const pairing = this.getPairingOrThrow();
    const head = this.auditHeadOrThrow();
    const unhashed: Omit<AuditRecord, "hash"> = {
      seq: (head?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      pairingId: pairing.id,
      actor,
      action,
      assurance,
      detail,
      prevHash: head?.hash ?? GENESIS_HASH,
    };
    const record: AuditRecord = { ...unhashed, hash: hashRecord(unhashed) };

    this.ctx.storage.sql.exec(
      `INSERT INTO audit_records (pairing_id, seq, at, actor, action, assurance, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.pairingId,
      record.seq,
      record.at,
      JSON.stringify(record.actor),
      record.action,
      record.assurance,
      JSON.stringify(record.detail),
      record.prevHash,
      record.hash,
    );
    return record;
  }

  /**
   * `GET /pairings/:id/audit` — the requested slice (`since`), plus whether
   * the FULL chain still checks out from genesis. Verification always covers
   * everything regardless of `since`: a caller paging through recent records
   * still learns if history before their window was tampered with.
   */
  getAudit(since = 0): { records: AuditRecord[]; chainValid: boolean; brokenAt: number | null; head: string | null } {
    const sliceRows = [...this.ctx.storage.sql.exec(`SELECT * FROM audit_records WHERE seq > ? ORDER BY seq ASC`, since)] as unknown as AuditRow[];
    const records = sliceRows.map((row) => this.rowToAuditRecord(row));

    const allRows = [...this.ctx.storage.sql.exec(`SELECT * FROM audit_records ORDER BY seq ASC`)] as unknown as AuditRow[];
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    let brokenAt: number | null = null;
    for (const row of allRows) {
      const record = this.rowToAuditRecord(row);
      if (record.seq !== expectedSeq || record.prevHash !== prevHash) {
        brokenAt = record.seq;
        break;
      }
      const { hash, ...rest } = record;
      if (hashRecord(rest) !== hash) {
        brokenAt = record.seq;
        break;
      }
      prevHash = hash;
      expectedSeq += 1;
    }
    return { records, chainValid: brokenAt === null, brokenAt, head: brokenAt === null && allRows.length ? prevHash : null };
  }

  // -----------------------------------------------------------------------
  // Digest — bounded-size catch-up, mirrors packages/relay's getDigest
  // -----------------------------------------------------------------------

  getDigest(limit = 10): RpcResult<Digest> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      return {
        pairingId: pairing.id,
        generatedAt: new Date().toISOString(),
        usage: this.getUsageSnapshot(),
        plan: this.getPlan(),
        consent: this.getConsentOrThrow(),
        recentMessages: this.getRecentMessages(pairing.id, limit),
      };
    });
  }
}
