/**
 * Multi-principal consent bound to content — PROTOCOL.md §6.
 *
 * This is the part of the protocol that `draft-reece-wimse-cross-org-delegation`
 * does not cover. That draft handles authority descending from a *single*
 * principal through a chain of workloads. Here, authority to proceed requires
 * the joint, independent authorization of **two humans in different
 * organizations**, either of whom may withdraw unilaterally.
 *
 * The v2 model recorded `approvedBy: ["agent_x", "agent_y"]` — a claim by the
 * relay. If the relay was wrong, compromised, or hostile, nothing downstream
 * could tell. v3 records a signature made by a key the relay has never held,
 * over a hash of the exact bytes the human was shown. A relay that lies about
 * consent produces a record that fails verification, and any third party can
 * check it without trusting the relay at all.
 */

import { canonicalize, fromJwk, sha256Hex, type Jwk } from "./credential.js";
import { verify as cryptoVerify } from "node:crypto";
import { badRequest, stalePlan } from "./errors.js";
import type { PlanItem } from "../types.js";

export const CONSENT_DOMAIN = "inzo-consent-v3";

export interface ConsentSubject {
  kind: "plan";
  version: number;
  hash: string;
}

export interface Approval {
  principal: string;
  credential: string;
  at: string;
  signature: string;
}

export interface ConsentRecord {
  pairingId: string;
  subject: ConsentSubject;
  /** Fixed at pairing creation to both principals. Never editable — §6.3.5. */
  required: string[];
  approvals: Approval[];
  satisfied: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The canonical hash of a plan's content.
 *
 * Deliberately covers only { pairingId, goal, items, version } — the fields a
 * human actually reads. Including `updatedAt` would make the hash change
 * without the text changing, and every approval would spuriously invalidate.
 */
export function planSubjectHash(plan: {
  pairingId: string;
  goal: string;
  items: PlanItem[];
  version: number;
}): string {
  return `sha256:${sha256Hex(
    canonicalize({
      pairingId: plan.pairingId,
      goal: plan.goal,
      items: plan.items.map((item) => ({ owner: item.owner, task: item.task })),
      version: plan.version,
    }),
  )}`;
}

/**
 * The exact string an approving human's key signs.
 *
 * Domain-separated by `CONSENT_DOMAIN` so a signature harvested from any other
 * part of the protocol — a proof of possession, say — can never be replayed as
 * an approval.
 */
export function consentStatement(pairingId: string, subject: ConsentSubject): string {
  return [CONSENT_DOMAIN, pairingId, subject.kind, String(subject.version), subject.hash].join("\n");
}

export function verifyApprovalSignature(
  pairingId: string,
  subject: ConsentSubject,
  signature: string,
  holderJwk: Jwk,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(consentStatement(pairingId, subject)),
      fromJwk(holderJwk),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * Guards an approval against the two ways consent can drift off the artifact
 * it was given for.
 *
 * The version check closes a race: A reads plan v1 and decides to approve, B
 * silently re-proposes v2, A's approval lands on text the human never read.
 *
 * The hash check closes what the version check cannot. A version is a counter;
 * counters collide across a restore-from-backup or a buggy migration. The hash
 * is over the content itself, so matching version + differing hash is not a
 * stale approval — it is an integrity incident, and the caller should treat it
 * as one.
 */
export function assertSubjectCurrent(
  claimedVersion: unknown,
  current: ConsentSubject,
): { integrityMismatch: boolean } {
  if (typeof claimedVersion !== "number" || !Number.isInteger(claimedVersion)) {
    throw badRequest("planVersion is required and must be the integer version of the plan you read");
  }
  if (claimedVersion !== current.version) {
    throw stalePlan(claimedVersion, current.version);
  }
  return { integrityMismatch: false };
}

export function isSatisfied(record: Pick<ConsentRecord, "required" | "approvals">): boolean {
  if (record.required.length === 0) return false;
  const approved = new Set(record.approvals.map((entry) => entry.principal));
  return record.required.every((principal) => approved.has(principal));
}

export const CONSENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS consent_records (
  pairing_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_version INTEGER NOT NULL,
  subject_hash TEXT NOT NULL,
  required TEXT NOT NULL,
  approvals TEXT NOT NULL,
  satisfied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface ConsentRow {
  pairing_id: string;
  subject_kind: string;
  subject_version: number;
  subject_hash: string;
  required: string;
  approvals: string;
  satisfied: number;
  created_at: string;
  updated_at: string;
}

export function rowToConsent(row: ConsentRow): ConsentRecord {
  return {
    pairingId: row.pairing_id,
    subject: {
      kind: row.subject_kind as "plan",
      version: row.subject_version,
      hash: row.subject_hash,
    },
    required: JSON.parse(row.required) as string[],
    approvals: JSON.parse(row.approvals) as Approval[],
    satisfied: !!row.satisfied,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Independently re-checks a consent record end to end.
 *
 * Exposed unauthenticated at `POST /consent/verify` so a third party handed a
 * record out-of-band can check it without trusting this relay's `satisfied`
 * flag — which is the entire reason approvals are signed rather than stored.
 */
export function verifyConsentRecord(
  record: ConsentRecord,
  holderKeys: ReadonlyMap<string, Jwk>,
): {
  valid: boolean;
  satisfied: boolean;
  approvals: Array<{ principal: string; valid: boolean; reason?: string }>;
} {
  const results = record.approvals.map((approval) => {
    const jwk = holderKeys.get(approval.credential);
    if (!jwk) {
      return { principal: approval.principal, valid: false, reason: "unknown credential" };
    }
    if (!record.required.includes(approval.principal)) {
      return { principal: approval.principal, valid: false, reason: "principal is not in required set" };
    }
    const ok = verifyApprovalSignature(record.pairingId, record.subject, approval.signature, jwk);
    return { principal: approval.principal, valid: ok, reason: ok ? undefined : "signature does not verify" };
  });

  const valid = results.every((entry) => entry.valid);
  const approvedPrincipals = new Set(
    results.filter((entry) => entry.valid).map((entry) => entry.principal),
  );
  return {
    valid,
    satisfied: valid && record.required.every((principal) => approvedPrincipals.has(principal)),
    approvals: results,
  };
}
