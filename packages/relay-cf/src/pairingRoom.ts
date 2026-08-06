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
 *
 * Deliberately NOT ported in this pass: budget/usage/runway tracking and the
 * hash-chained audit log. Both are real, documented gaps — see
 * packages/relay-cf/README.md — not silent omissions.
 */
import { DurableObject } from "cloudflare:workers";
import {
  badRequest,
  CONSENT_SCHEMA,
  forbidden,
  generateId,
  isSatisfied,
  notFound,
  planSubjectHash,
  rowToConsent,
  stalePlan,
  verifyApprovalSignature,
  type Approval,
  type ConsentRecord,
  type ConsentRow,
  type CredentialPayload,
} from "./lib.js";
import { rpcSafe, type RpcResult } from "./rpcError.js";
import type { Message, Pairing, Plan, PlanItem } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  created_at TEXT NOT NULL
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

${CONSENT_SCHEMA}
`;

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
  plan: Plan | null;
  consent: ConsentRecord | null;
  recentMessages: Message[];
}

/** This DO doesn't read bindings off `env` — it's fully self-contained. */
type Env = Record<string, never>;

export class PairingRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(SCHEMA);
  }

  initialize(id: string, code: string, agentA: string, agentB: string, createdAt: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO pairing (id, code, agent_a, agent_b, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      code,
      agentA,
      agentB,
      createdAt,
    );
  }

  // -----------------------------------------------------------------------
  // Pairing — `OrThrow` variants are for internal use only, never returned
  // directly from an RPC method.
  // -----------------------------------------------------------------------

  private getPairingOrThrow(): Pairing {
    const row = [...this.ctx.storage.sql.exec(`SELECT * FROM pairing LIMIT 1`)][0] as
      | { id: string; code: string; agent_a: string; agent_b: string; created_at: string }
      | undefined;
    if (!row) throw notFound("This pairing does not exist");
    return { id: row.id, code: row.code, agentA: row.agent_a, agentB: row.agent_b, createdAt: row.created_at };
  }

  private assertMemberOrThrow(pairing: Pairing, agentId: string): void {
    if (agentId !== pairing.agentA && agentId !== pairing.agentB) {
      throw forbidden(`Agent "${agentId}" is not part of pairing "${pairing.id}"`);
    }
  }

  getPairing(): RpcResult<Pairing> {
    return rpcSafe(() => this.getPairingOrThrow());
  }

  assertMember(pairing: Pairing, agentId: string): RpcResult<void> {
    return rpcSafe(() => this.assertMemberOrThrow(pairing, agentId));
  }

  otherAgent(pairing: Pairing, agentId: string): string {
    return agentId === pairing.agentA ? pairing.agentB : pairing.agentA;
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
      return { id, pairingId: pairing.id, fromAgentId, body, createdAt, cursor };
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
    };
  }

  getPlan(): Plan | null {
    const row = this.getPlanRow();
    return row ? this.rowToPlan(row) : null;
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
  proposePlan(pairingId: string, proposedBy: string, goal: string, items: PlanItem[], principals: string[]): RpcResult<Plan> {
    return rpcSafe(() => {
      if (typeof goal !== "string" || !goal.trim()) throw badRequest("goal is required");
      if (!Array.isArray(items) || items.length === 0) throw badRequest("items must be a non-empty array of { owner, task }");
      for (const item of items) {
        if (!item?.owner?.trim() || !item?.task?.trim()) throw badRequest("each plan item requires an owner and a task");
      }
      const pairing = this.getPairingOrThrow();
      this.assertMemberOrThrow(pairing, proposedBy);

      const now = new Date().toISOString();
      const existing = this.getPlanRow();
      const createdAt = existing?.created_at ?? now;
      const version = (existing?.version ?? 0) + 1;

      const plan: Plan = { pairingId, goal, items, proposedBy, approvedBy: [], locked: false, version, createdAt, updatedAt: now };

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

      const uniquePrincipals = [...new Set(principals.filter(Boolean))];
      if (uniquePrincipals.length === 2) {
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
      const locked = approvedBy.has(pairing.agentA) && approvedBy.has(pairing.agentB);
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
          throw badRequest(`Plan content changed under the same version — re-read the plan (expected hash ${expected}, consent has ${current.subject.hash})`);
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
      }

      return consentRecord ? { ...plan, consent: consentRecord } : plan;
    });
  }

  withdrawConsent(principalId: string): RpcResult<ConsentRecord> {
    return rpcSafe(() => {
      const current = this.getConsentOrThrow();
      if (!current) throw notFound(`No consent record for pairing`);
      const approvals = current.approvals.filter((entry) => entry.principal !== principalId);
      const next: ConsentRecord = { ...current, approvals, satisfied: isSatisfied({ required: current.required, approvals }), updatedAt: new Date().toISOString() };
      this.writeConsent(next);
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
  // Digest — bounded-size catch-up, mirrors packages/relay's getDigest
  // -----------------------------------------------------------------------

  getDigest(limit = 10): RpcResult<Digest> {
    return rpcSafe(() => {
      const pairing = this.getPairingOrThrow();
      return {
        pairingId: pairing.id,
        generatedAt: new Date().toISOString(),
        plan: this.getPlan(),
        consent: this.getConsentOrThrow(),
        recentMessages: this.getRecentMessages(pairing.id, limit),
      };
    });
  }
}
