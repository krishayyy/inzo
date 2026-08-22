/**
 * Append-only, hash-chained audit log — PROTOCOL.md §7.
 *
 * Motivated by EU AI Act Article 12 (automatic logging over the system
 * lifetime, six-month minimum retention) and Article 14 (human oversight).
 * Article 26 pushes both onto deployers, which is what makes an exportable,
 * verifiable log a requirement rather than a nicety.
 *
 * The chain matters more than the retention. A plain log table is a claim by
 * whoever runs the database; a hash chain is a commitment. Tampering with,
 * reordering, or deleting any record breaks every hash after it, so a relay
 * cannot quietly rewrite history it has already published.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { canonicalize, sha256Hex } from "./credential.js";

export const AUDIT_ACTIONS = [
  "pairing.created",
  "pairing.joined",
  "credential.issued",
  "credential.attenuated",
  "credential.revoked",
  "plan.proposed",
  "plan.item_status_changed",
  "task.proposed",
  "task.assigned",
  "task.status_changed",
  "memory.written",
  "memory.updated",
  "memory.forgotten",
  "consent.approved",
  "consent.withdrawn",
  "consent.satisfied",
  "command.requested",
  "command.executed",
  "command.refused",
  "scope.narrowed",
  "stream.opened",
  "stream.closed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** How the actor's identity was established. A bearer credential cannot
 *  support non-repudiation, so consent may never carry this value — §1.2. */
export type Assurance = "pop" | "bearer";

export interface AuditActor {
  principal: string | null;
  agent: string | null;
  credential: string | null;
}

export interface AuditRecord {
  seq: number;
  at: string;
  pairingId: string;
  actor: AuditActor;
  action: AuditAction;
  assurance: Assurance;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** The chain's anchor. Every pairing's first record links to this. */
export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_records (
  pairing_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  assurance TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (pairing_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_audit_pairing_seq ON audit_records(pairing_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_records(at);
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

/**
 * `hash = SHA256(prevHash ++ canonical(record without hash))`.
 *
 * Canonical serialization is load-bearing: two implementations that order keys
 * differently would compute different hashes for identical content and every
 * cross-organization reconciliation would fail.
 */
export function hashRecord(record: Omit<AuditRecord, "hash">): string {
  return `sha256:${sha256Hex(record.prevHash + canonicalize(record))}`;
}

export interface AppendInput {
  pairingId: string;
  action: AuditAction;
  actor: AuditActor;
  assurance: Assurance;
  detail?: Record<string, unknown>;
  at?: string;
}

export class AuditLog {
  constructor(private readonly db: DatabaseType) {}

  append(input: AppendInput): AuditRecord {
    const head = this.head(input.pairingId);
    const unhashed: Omit<AuditRecord, "hash"> = {
      seq: (head?.seq ?? 0) + 1,
      at: input.at ?? new Date().toISOString(),
      pairingId: input.pairingId,
      actor: input.actor,
      action: input.action,
      assurance: input.assurance,
      detail: input.detail ?? {},
      prevHash: head?.hash ?? GENESIS_HASH,
    };
    const record: AuditRecord = { ...unhashed, hash: hashRecord(unhashed) };

    this.db
      .prepare(
        `INSERT INTO audit_records (pairing_id, seq, at, actor, action, assurance, detail, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  head(pairingId: string): AuditRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM audit_records WHERE pairing_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(pairingId) as AuditRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(pairingId: string, since = 0): AuditRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_records WHERE pairing_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(pairingId, since) as AuditRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Recomputes the chain from genesis.
   *
   * This is the check that makes the log worth anything: an auditor who is
   * handed an export runs exactly this, and any edit, reorder, or deletion
   * surfaces as the seq where recomputation first diverges.
   */
  verify(pairingId: string): { valid: boolean; brokenAt: number | null; head: string | null } {
    const records = this.list(pairingId, 0);
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;

    for (const record of records) {
      if (record.seq !== expectedSeq || record.prevHash !== prevHash) {
        return { valid: false, brokenAt: record.seq, head: null };
      }
      const { hash, ...rest } = record;
      if (hashRecord(rest) !== hash) {
        return { valid: false, brokenAt: record.seq, head: null };
      }
      prevHash = hash;
      expectedSeq += 1;
    }
    return { valid: true, brokenAt: null, head: records.length ? prevHash : null };
  }

  /**
   * Drops records older than the retention window.
   *
   * Deliberately prunes whole pairings only. Pruning a prefix of a live chain
   * would leave the remainder unverifiable from genesis, which is worse than
   * keeping it — so a pairing is retained until all of its records age out.
   */
  prune(retentionDays: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const stale = this.db
      .prepare(`SELECT pairing_id FROM audit_records GROUP BY pairing_id HAVING MAX(at) < ?`)
      .all(cutoff) as Array<{ pairing_id: string }>;
    let removed = 0;
    for (const { pairing_id } of stale) {
      removed += this.db.prepare(`DELETE FROM audit_records WHERE pairing_id = ?`).run(pairing_id).changes;
    }
    return removed;
  }
}

function rowToRecord(row: AuditRow): AuditRecord {
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

/** §7.5 — a relay in EU AI Act mode must not be configured below the floor. */
export const MIN_RETENTION_DAYS = 180;

export function resolveRetentionDays(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.INZO_AUDIT_RETENTION_DAYS ?? MIN_RETENTION_DAYS);
  const days = Number.isFinite(configured) && configured > 0 ? configured : MIN_RETENTION_DAYS;
  if (env.INZO_COMPLIANCE_MODE === "eu-ai-act" && days < MIN_RETENTION_DAYS) {
    throw new Error(
      `INZO_AUDIT_RETENTION_DAYS=${days} is below the ${MIN_RETENTION_DAYS}-day floor required by ` +
        `INZO_COMPLIANCE_MODE=eu-ai-act (Article 12). Raise it or unset compliance mode.`,
    );
  }
  return days;
}
