/**
 * Persistence for v3 credentials, consent, and audit — PROTOCOL.md §1, §4, §6, §7.
 *
 * Kept separate from `RelayStore` deliberately. The v2 store owns the
 * conversation (messages, plans, budgets); this owns the trust boundary. They
 * have different reasons to change, and mixing them is how a "just this once"
 * shortcut ends up bypassing an authorization check.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { AuditLog, AUDIT_SCHEMA, type Assurance, type AuditAction, type AuditActor } from "./audit.js";
import {
  attenuate,
  generateIssuerKey,
  issueCredential,
  toJwk,
  verifyCredential,
  type CredentialPayload,
  type IssuerKey,
  type Jwk,
} from "./credential.js";
import {
  CONSENT_SCHEMA,
  isSatisfied,
  rowToConsent,
  verifyApprovalSignature,
  type Approval,
  type ConsentRecord,
  type ConsentRow,
  type ConsentSubject,
} from "./consent.js";
import { badRequest, forbidden, notFound, popRequiredForConsent } from "./errors.js";
import type { Scope } from "../types.js";

export const CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS issuer_keys (
  kid TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  jti TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  pairing_id TEXT,
  cap TEXT NOT NULL,
  cnf_jwk TEXT NOT NULL,
  chain TEXT NOT NULL,
  depth INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_credentials_agent ON credentials(agent_id);
CREATE INDEX IF NOT EXISTS idx_credentials_revoked ON credentials(revoked_at);
${CONSENT_SCHEMA}
${AUDIT_SCHEMA}
`;

interface CredentialRow {
  jti: string;
  agent_id: string;
  principal_id: string;
  pairing_id: string | null;
  cap: string;
  cnf_jwk: string;
  chain: string;
  depth: number;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface IssuedCredential {
  credential: string;
  payload: CredentialPayload;
}

export class CredentialStore {
  readonly audit: AuditLog;
  private readonly issuerKey: IssuerKey;
  /** In-memory mirror of the revoked set. Verification happens on every
   *  request; a SQL round-trip per check is not worth it at this scale. */
  private readonly revokedJtis = new Set<string>();

  constructor(
    private readonly db: DatabaseType,
    readonly issuerUrl: string,
  ) {
    this.db.exec(CREDENTIAL_SCHEMA);
    this.audit = new AuditLog(db);
    this.issuerKey = this.loadOrCreateIssuerKey();
    for (const row of this.db.prepare(`SELECT jti FROM credentials WHERE revoked_at IS NOT NULL`).all() as Array<{
      jti: string;
    }>) {
      this.revokedJtis.add(row.jti);
    }
  }

  /**
   * The signing key is persisted, not regenerated per boot.
   *
   * A fresh key on restart would invalidate every credential in flight and,
   * worse, make previously-exported audit signatures unverifiable — the record
   * would still be internally consistent but nobody could confirm we signed it.
   */
  private loadOrCreateIssuerKey(): IssuerKey {
    const row = this.db
      .prepare(`SELECT kid, private_pem FROM issuer_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get() as { kid: string; private_pem: string } | undefined;

    if (row) {
      const privateKey = createPrivateKey(row.private_pem);
      return { kid: row.kid, privateKey, publicKey: createPublicKey(privateKey) };
    }

    const key = generateIssuerKey();
    this.db
      .prepare(`INSERT INTO issuer_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)`)
      .run(
        key.kid,
        key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        JSON.stringify(toJwk(key.publicKey)),
        new Date().toISOString(),
      );
    return key;
  }

  /** `GET /.well-known/inzo-jwks` — §4. Cacheable, unauthenticated. */
  jwks(): { keys: Array<Jwk & { kid: string; use: string; alg: string }> } {
    const rows = this.db.prepare(`SELECT kid, public_jwk FROM issuer_keys`).all() as Array<{
      kid: string;
      public_jwk: string;
    }>;
    return {
      keys: rows.map((row) => ({
        ...(JSON.parse(row.public_jwk) as Jwk),
        kid: row.kid,
        use: "sig",
        alg: "EdDSA",
      })),
    };
  }

  /** `GET /.well-known/inzo-revocations` — §4. */
  revocationList(ttlSeconds = 60): {
    issuer: string;
    issuedAt: string;
    expiresAt: string;
    revoked: Array<{ jti: string; revokedAt: string }>;
  } {
    const rows = this.db
      .prepare(`SELECT jti, revoked_at FROM credentials WHERE revoked_at IS NOT NULL ORDER BY revoked_at ASC`)
      .all() as Array<{ jti: string; revoked_at: string }>;
    const now = new Date();
    return {
      issuer: this.issuerUrl,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      revoked: rows.map((row) => ({ jti: row.jti, revokedAt: row.revoked_at })),
    };
  }

  createPrincipal(): string {
    const id = `prn_${randomUUID()}`;
    this.db.prepare(`INSERT INTO principals (id, created_at) VALUES (?, ?)`).run(id, new Date().toISOString());
    return id;
  }

  issueRoot(input: {
    agentId: string;
    principalId: string;
    pairingId: string | null;
    cap: Scope[];
    cnf: { jwk: Jwk };
    ttlSeconds?: number;
  }): IssuedCredential {
    const issued = issueCredential(this.issuerKey, { ...input, issuer: this.issuerUrl });
    this.persist(issued.payload);
    return issued;
  }

  /** §2. Narrowing only — `attenuate` rejects any widening before we get here. */
  attenuateFrom(
    parent: CredentialPayload,
    requested: { cap: unknown; cnf: { jwk: Jwk }; ttlSeconds?: number },
  ): IssuedCredential {
    const issued = attenuate(this.issuerKey, parent, requested);
    this.persist(issued.payload);
    return issued;
  }

  private persist(payload: CredentialPayload): void {
    this.db
      .prepare(
        `INSERT INTO credentials
           (jti, agent_id, principal_id, pairing_id, cap, cnf_jwk, chain, depth, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        payload.jti,
        payload.sub,
        payload.prn,
        payload.pairing,
        JSON.stringify(payload.cap),
        JSON.stringify(payload.cnf.jwk),
        JSON.stringify(payload.chain),
        payload.depth,
        new Date(payload.iat * 1000).toISOString(),
        new Date(payload.exp * 1000).toISOString(),
      );
  }

  /** Backfills `pairing` on the creator's root once someone actually joins. */
  bindPairing(agentId: string, pairingId: string): void {
    this.db
      .prepare(`UPDATE credentials SET pairing_id = ? WHERE agent_id = ? AND pairing_id IS NULL`)
      .run(pairingId, agentId);
  }

  verify(credential: string, now = Date.now()): CredentialPayload {
    const keys = new Map([[this.issuerKey.kid, this.issuerKey.publicKey]]);
    return verifyCredential(credential, keys, {
      now,
      revoked: this.revokedJtis,
      expectedIssuer: this.issuerUrl,
    });
  }

  getHolderJwk(jti: string): Jwk | null {
    const row = this.db.prepare(`SELECT cnf_jwk FROM credentials WHERE jti = ?`).get(jti) as
      | { cnf_jwk: string }
      | undefined;
    return row ? (JSON.parse(row.cnf_jwk) as Jwk) : null;
  }

  /** Every credential the pairing has ever issued, for verification exports. */
  holderKeysFor(pairingId: string): Map<string, Jwk> {
    const rows = this.db.prepare(`SELECT jti, cnf_jwk FROM credentials WHERE pairing_id = ?`).all(pairingId) as Array<{
      jti: string;
      cnf_jwk: string;
    }>;
    return new Map(rows.map((row) => [row.jti, JSON.parse(row.cnf_jwk) as Jwk]));
  }

  isRevoked(jti: string): boolean {
    return this.revokedJtis.has(jti);
  }

  /**
   * Revokes every credential belonging to an agent — the root and everything
   * attenuated from it.
   *
   * Descendants do not need to be enumerated at verification time: each one
   * carries its ancestors in `chain`, so a verifier that knows only the revoked
   * ancestor's jti rejects the whole subtree (§4).
   */
  revokeAgentCredentials(agentId: string, at: string): string[] {
    const rows = this.db
      .prepare(`SELECT jti FROM credentials WHERE agent_id = ? AND revoked_at IS NULL`)
      .all(agentId) as Array<{ jti: string }>;
    if (rows.length === 0) return [];

    this.db.prepare(`UPDATE credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`).run(at, agentId);
    for (const row of rows) this.revokedJtis.add(row.jti);
    return rows.map((row) => row.jti);
  }

  agentPrincipal(agentId: string): string | null {
    const row = this.db.prepare(`SELECT principal_id FROM credentials WHERE agent_id = ? LIMIT 1`).get(agentId) as
      | { principal_id: string }
      | undefined;
    return row?.principal_id ?? null;
  }

  // -------------------------------------------------------------------
  // Consent — §6
  // -------------------------------------------------------------------

  getConsent(pairingId: string): ConsentRecord | null {
    const row = this.db.prepare(`SELECT * FROM consent_records WHERE pairing_id = ?`).get(pairingId) as
      | ConsentRow
      | undefined;
    return row ? rowToConsent(row) : null;
  }

  /**
   * Opens a fresh consent record for a newly proposed plan.
   *
   * A new proposal always destroys prior consent (§6.3.4) — renegotiating must
   * never inherit an approval given for different text.
   */
  openConsent(pairingId: string, subject: ConsentSubject, required: string[]): ConsentRecord {
    const now = new Date().toISOString();
    const record: ConsentRecord = {
      pairingId,
      subject,
      required,
      approvals: [],
      satisfied: false,
      createdAt: now,
      updatedAt: now,
    };
    this.writeConsent(record);
    return record;
  }

  /**
   * Records one principal's signed approval.
   *
   * Rejects a bearer credential outright: an approval's entire value is that it
   * is non-repudiable, and a bearer credential can only yield an assertion by
   * this relay — the thing v3 exists to stop depending on.
   */
  approve(input: {
    pairingId: string;
    payload: CredentialPayload;
    assurance: Assurance;
    signature: unknown;
  }): ConsentRecord {
    if (input.assurance !== "pop") throw popRequiredForConsent();
    if (typeof input.signature !== "string" || !input.signature) {
      throw badRequest("signature is required: sign the consent statement with your holder key");
    }

    const record = this.getConsent(input.pairingId);
    if (!record) throw notFound(`No plan has been proposed for pairing "${input.pairingId}"`);
    if (!record.required.includes(input.payload.prn)) {
      throw forbidden("This principal is not one of the parties whose consent is required");
    }
    if (!verifyApprovalSignature(input.pairingId, record.subject, input.signature, input.payload.cnf.jwk)) {
      throw badRequest("Approval signature does not verify against this credential's holder key");
    }

    const approval: Approval = {
      principal: input.payload.prn,
      credential: input.payload.jti,
      at: new Date().toISOString(),
      signature: input.signature,
    };
    // Re-approving replaces rather than duplicates; consent is per principal.
    const approvals = [...record.approvals.filter((entry) => entry.principal !== approval.principal), approval];
    const next: ConsentRecord = {
      ...record,
      approvals,
      satisfied: isSatisfied({ required: record.required, approvals }),
      updatedAt: approval.at,
    };
    this.writeConsent(next);
    return next;
  }

  /**
   * Withdraws one principal's approval — unilaterally, §6.3.6.
   *
   * Requires no cooperation from the peer, because the situation you need
   * withdrawal for is exactly the one where they will not cooperate. The audit
   * record is not rewritten: a consent that was satisfied and then withdrawn
   * shows both events, in order.
   */
  withdraw(pairingId: string, principalId: string): ConsentRecord {
    const record = this.getConsent(pairingId);
    if (!record) throw notFound(`No consent record for pairing "${pairingId}"`);
    const approvals = record.approvals.filter((entry) => entry.principal !== principalId);
    const next: ConsentRecord = {
      ...record,
      approvals,
      satisfied: isSatisfied({ required: record.required, approvals }),
      updatedAt: new Date().toISOString(),
    };
    this.writeConsent(next);
    return next;
  }

  /** §6.3.7 — revoking a credential withdraws anything approved with it. */
  withdrawByCredentials(pairingId: string, jtis: string[]): ConsentRecord | null {
    const record = this.getConsent(pairingId);
    if (!record) return null;
    const dead = new Set(jtis);
    const approvals = record.approvals.filter((entry) => !dead.has(entry.credential));
    if (approvals.length === record.approvals.length) return record;
    const next: ConsentRecord = {
      ...record,
      approvals,
      satisfied: isSatisfied({ required: record.required, approvals }),
      updatedAt: new Date().toISOString(),
    };
    this.writeConsent(next);
    return next;
  }

  private writeConsent(record: ConsentRecord): void {
    this.db
      .prepare(
        `INSERT INTO consent_records
           (pairing_id, subject_kind, subject_version, subject_hash, required, approvals, satisfied, created_at, updated_at)
         VALUES (@pairingId, @kind, @version, @hash, @required, @approvals, @satisfied, @createdAt, @updatedAt)
         ON CONFLICT(pairing_id) DO UPDATE SET
           subject_kind = excluded.subject_kind,
           subject_version = excluded.subject_version,
           subject_hash = excluded.subject_hash,
           required = excluded.required,
           approvals = excluded.approvals,
           satisfied = excluded.satisfied,
           updated_at = excluded.updated_at`,
      )
      .run({
        pairingId: record.pairingId,
        kind: record.subject.kind,
        version: record.subject.version,
        hash: record.subject.hash,
        required: JSON.stringify(record.required),
        approvals: JSON.stringify(record.approvals),
        satisfied: record.satisfied ? 1 : 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
  }

  // -------------------------------------------------------------------
  // Audit convenience
  // -------------------------------------------------------------------

  record(
    pairingId: string,
    action: AuditAction,
    actor: AuditActor,
    assurance: Assurance,
    detail?: Record<string, unknown>,
  ): void {
    this.audit.append({ pairingId, action, actor, assurance, detail });
  }

  actorFrom(payload: CredentialPayload): AuditActor {
    return { principal: payload.prn, agent: payload.sub, credential: payload.jti };
  }
}
