/**
 * Registry — the single global Durable Object instance (idFromName("registry")).
 *
 * Owns everything that has to be global by nature: the issuer's signing key,
 * every principal, every issued credential (for revocation lookups), v2
 * bearer tokens, and pairing codes before a pairing exists. This is a
 * faithful port of packages/relay/src/lib/credentialStore.ts's SQL-touching
 * surface onto Durable Object SQLite storage — the pure crypto it calls
 * (packages/relay/src/lib/credential.ts) is imported unchanged.
 *
 * Pairing-scoped domain data (messages, plans, consent, usage) deliberately
 * does NOT live here — see pairingRoom.ts. That split is what gives each
 * pairing hard isolation: a bug or bad request against one pairing's Durable
 * Object cannot touch another's state, by construction, not by convention.
 */
import { DurableObject } from "cloudflare:workers";
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import {
  attenuate,
  badRequest,
  conflict,
  CredentialError,
  generateAgentToken,
  generateId,
  generateIssuerKey,
  generatePairingCode,
  gone,
  hashAgentToken,
  issueCredential,
  MAX_TTL_SECONDS,
  notFound,
  toJwk,
  verifyCredential,
  type CredentialPayload,
  type IssuerKey,
  type Jwk,
} from "./lib.js";
import { rpcSafe, type RpcResult } from "./rpcError.js";
import { ALL_SCOPES, type Scope, type TokenIdentity } from "./types.js";

const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  pairing_id TEXT,
  scope TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  creator_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

export interface CreatedPairingCode {
  code: string;
  agentToken: string;
  scope: Scope[];
  pairingId: null;
  principalId: string | null;
  credential: string | null;
  expiresAt: string;
}

export interface JoinedPairing {
  pairingId: string;
  agentA: string;
  agentB: string;
  code: string;
  agentToken: string;
  scope: Scope[];
  peerAgentId: string;
  principalId: string | null;
  credential: string | null;
}

export interface RevokeResult {
  revokedAgentId: string;
  revokedAt: string;
  revokedCredentialJtis: string[];
}

/** Neither DO in this package reads bindings off `env` — both are fully self-contained. */
type Env = Record<string, never>;

export class Registry extends DurableObject<Env> {
  private issuerUrl = "https://inzo-relay-cf.workers.dev";
  private issuerKey!: IssuerKey;
  private readonly revokedJtis = new Set<string>();
  private verificationKeys = new Map<string, KeyObject>();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(SCHEMA);
      this.issuerKey = this.loadOrCreateIssuerKey();
      this.loadVerificationKeys();
      for (const row of this.ctx.storage.sql.exec(`SELECT jti FROM credentials WHERE revoked_at IS NOT NULL`)) {
        this.revokedJtis.add(row.jti as string);
      }
    });
  }

  setIssuerUrl(url: string): void {
    this.issuerUrl = url;
  }

  // -----------------------------------------------------------------------
  // Key lifecycle — mirrors credentialStore.ts exactly (§4.1)
  // -----------------------------------------------------------------------

  private loadOrCreateIssuerKey(): IssuerKey {
    const row = [
      ...this.ctx.storage.sql.exec(
        `SELECT kid, private_pem FROM issuer_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      ),
    ][0] as { kid: string; private_pem: string } | undefined;

    if (row) {
      const privateKey = createPrivateKey(row.private_pem);
      return { kid: row.kid, privateKey, publicKey: createPublicKey(privateKey) };
    }

    const key = generateIssuerKey();
    this.ctx.storage.sql.exec(
      `INSERT INTO issuer_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)`,
      key.kid,
      key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      JSON.stringify(toJwk(key.publicKey)),
      new Date().toISOString(),
    );
    return key;
  }

  private loadVerificationKeys(): void {
    const rows = [...this.ctx.storage.sql.exec(`SELECT kid, public_jwk FROM issuer_keys`)] as Array<{
      kid: string;
      public_jwk: string;
    }>;
    this.verificationKeys = new Map(
      rows.map((row) => [
        row.kid,
        createPublicKey({ key: JSON.parse(row.public_jwk) as Record<string, unknown>, format: "jwk" }),
      ]),
    );
  }

  activeKid(): string {
    return this.issuerKey.kid;
  }

  rotateIssuerKey(): string {
    const next = generateIssuerKey();
    const stamp = new Date().toISOString();
    this.ctx.storage.sql.exec(`UPDATE issuer_keys SET retired_at = ? WHERE kid = ? AND retired_at IS NULL`, stamp, this.issuerKey.kid);
    this.ctx.storage.sql.exec(
      `INSERT INTO issuer_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)`,
      next.kid,
      next.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      JSON.stringify(toJwk(next.publicKey)),
      stamp,
    );
    this.issuerKey = next;
    this.loadVerificationKeys();
    return next.kid;
  }

  pruneRetiredKeys(now = Date.now()): number {
    const cutoff = new Date(now - MAX_TTL_SECONDS * 1000).toISOString();
    const result = this.ctx.storage.sql.exec(`DELETE FROM issuer_keys WHERE retired_at IS NOT NULL AND retired_at < ?`, cutoff);
    if (result.rowsWritten > 0) this.loadVerificationKeys();
    return result.rowsWritten;
  }

  jwks(): { keys: Array<Jwk & { kid: string; use: string; alg: string }> } {
    const rows = [...this.ctx.storage.sql.exec(`SELECT kid, public_jwk FROM issuer_keys`)] as Array<{
      kid: string;
      public_jwk: string;
    }>;
    return {
      keys: rows.map((row) => ({ ...(JSON.parse(row.public_jwk) as Jwk), kid: row.kid, use: "sig", alg: "EdDSA" })),
    };
  }

  revocationList(ttlSeconds = 60): {
    issuer: string;
    issuedAt: string;
    expiresAt: string;
    revoked: Array<{ jti: string; revokedAt: string }>;
  } {
    const rows = [
      ...this.ctx.storage.sql.exec(`SELECT jti, revoked_at FROM credentials WHERE revoked_at IS NOT NULL ORDER BY revoked_at ASC`),
    ] as Array<{ jti: string; revoked_at: string }>;
    const now = new Date();
    return {
      issuer: this.issuerUrl,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      revoked: rows.map((row) => ({ jti: row.jti, revokedAt: row.revoked_at })),
    };
  }

  // -----------------------------------------------------------------------
  // Credentials
  // -----------------------------------------------------------------------

  private persistCredential(payload: CredentialPayload): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO credentials (jti, agent_id, principal_id, pairing_id, cap, cnf_jwk, chain, depth, issued_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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

  private issueRoot(input: {
    agentId: string;
    principalId: string;
    pairingId: string | null;
    cap: Scope[];
    cnf: { jwk: Jwk };
  }): { credential: string; payload: CredentialPayload } {
    const issued = issueCredential(this.issuerKey, { ...input, issuer: this.issuerUrl });
    this.persistCredential(issued.payload);
    return issued;
  }

  attenuateFrom(
    parent: CredentialPayload,
    requested: { cap: unknown; cnf: { jwk: Jwk }; ttlSeconds?: number },
  ): RpcResult<{ credential: string; payload: CredentialPayload }> {
    return rpcSafe(() => {
      const issued = attenuate(this.issuerKey, parent, requested);
      this.persistCredential(issued.payload);
      return issued;
    });
  }

  verify(credential: string, now = Date.now()): CredentialPayload {
    return verifyCredential(credential, this.verificationKeys, { now, revoked: this.revokedJtis, expectedIssuer: this.issuerUrl });
  }

  /** RPC-safe: converts a CredentialError into an RpcResult rather than throwing across the boundary. */
  verifyOrThrow(credential: string): RpcResult<CredentialPayload> {
    return rpcSafe(() => {
      try {
        return this.verify(credential);
      } catch (err) {
        if (err instanceof CredentialError) throw err;
        throw new CredentialError("unauthenticated", "Could not verify credential");
      }
    });
  }

  agentPrincipal(agentId: string): string | null {
    const row = [...this.ctx.storage.sql.exec(`SELECT principal_id FROM credentials WHERE agent_id = ? LIMIT 1`, agentId)][0] as
      | { principal_id: string }
      | undefined;
    return row?.principal_id ?? null;
  }

  bindPairing(agentId: string, pairingId: string): void {
    this.ctx.storage.sql.exec(`UPDATE credentials SET pairing_id = ? WHERE agent_id = ? AND pairing_id IS NULL`, pairingId, agentId);
    this.ctx.storage.sql.exec(`UPDATE agent_tokens SET pairing_id = ? WHERE agent_id = ? AND pairing_id IS NULL`, pairingId, agentId);
  }

  // -----------------------------------------------------------------------
  // v2 bearer tokens
  // -----------------------------------------------------------------------

  resolveToken(token: string): TokenIdentity | null {
    const row = [
      ...this.ctx.storage.sql.exec(
        `SELECT agent_id, pairing_id, scope, revoked_at FROM agent_tokens WHERE token_hash = ?`,
        hashAgentToken(token),
      ),
    ][0] as { agent_id: string; pairing_id: string | null; scope: string; revoked_at: string | null } | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      pairingId: row.pairing_id,
      scope: JSON.parse(row.scope) as Scope[],
      revokedAt: row.revoked_at,
    };
  }

  // -----------------------------------------------------------------------
  // Pairing codes
  // -----------------------------------------------------------------------

  createPairingCode(cnf?: { jwk: Jwk }): CreatedPairingCode {
    const creatorAgentId = generateId("agent");
    const agentToken = generateAgentToken();
    const scope = [...ALL_SCOPES];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      const existing = [...this.ctx.storage.sql.exec(`SELECT code FROM pairing_codes WHERE code = ?`, code)];
      if (existing.length > 0) continue;

      this.ctx.storage.sql.exec(
        `INSERT INTO pairing_codes (code, creator_agent_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)`,
        code,
        creatorAgentId,
        now.toISOString(),
        expiresAt.toISOString(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, scope, revoked_at, created_at) VALUES (?, ?, NULL, ?, NULL, ?)`,
        hashAgentToken(agentToken),
        creatorAgentId,
        JSON.stringify(scope),
        now.toISOString(),
      );

      let principalId: string | null = null;
      let credential: string | null = null;
      if (cnf) {
        principalId = this.createPrincipal();
        credential = this.issueRoot({ agentId: creatorAgentId, principalId, pairingId: null, cap: scope, cnf }).credential;
      }

      return { code, agentToken, scope, pairingId: null, principalId, credential, expiresAt: expiresAt.toISOString() };
    }
    throw new Error("Failed to generate a unique pairing code");
  }

  private createPrincipal(): string {
    const id = `prn_${randomUUID()}`;
    this.ctx.storage.sql.exec(`INSERT INTO principals (id, created_at) VALUES (?, ?)`, id, new Date().toISOString());
    return id;
  }

  /**
   * Consumes a pairing code and mints the joiner's identity. Generates the
   * pairingId here (not in the Worker) so code-consumption and pairing
   * creation are atomic from the caller's point of view — no window where a
   * code is marked used but no pairing exists yet.
   */
  joinPairing(code: string, cnf?: { jwk: Jwk }): RpcResult<JoinedPairing> {
    return rpcSafe(() => {
      const row = [...this.ctx.storage.sql.exec(`SELECT * FROM pairing_codes WHERE code = ?`, code)][0] as
        | { code: string; creator_agent_id: string; created_at: string; expires_at: string; used_at: string | null }
        | undefined;
      if (!row) throw notFound(`No pairing code "${code}"`);
      if (row.used_at) throw conflict(`Pairing code "${code}" has already been used`);
      if (new Date(row.expires_at).getTime() < Date.now()) throw gone(`Pairing code "${code}" has expired`);

      const joinerAgentId = generateId("agent");
      const agentToken = generateAgentToken();
      const scope = [...ALL_SCOPES];
      const pairingId = generateId("pairing");
      const now = new Date().toISOString();

      this.ctx.storage.sql.exec(`UPDATE pairing_codes SET used_at = ? WHERE code = ?`, now, code);
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_tokens (token_hash, agent_id, pairing_id, scope, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
        hashAgentToken(agentToken),
        joinerAgentId,
        pairingId,
        JSON.stringify(scope),
        now,
      );
      this.bindPairing(row.creator_agent_id, pairingId);

      let principalId: string | null = null;
      let credential: string | null = null;
      if (cnf) {
        principalId = this.createPrincipal();
        credential = this.issueRoot({ agentId: joinerAgentId, principalId, pairingId, cap: scope, cnf }).credential;
      }

      return {
        pairingId,
        agentA: row.creator_agent_id,
        agentB: joinerAgentId,
        code,
        agentToken,
        scope,
        peerAgentId: row.creator_agent_id,
        principalId,
        credential,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Revocation — kill switch, §pairings/:id/revoke
  // -----------------------------------------------------------------------

  /** Idempotent: revoking an already-revoked agent returns the original timestamp. */
  revokeAgent(agentId: string): RevokeResult {
    const existing = [...this.ctx.storage.sql.exec(`SELECT revoked_at FROM agent_tokens WHERE agent_id = ? LIMIT 1`, agentId)][0] as
      | { revoked_at: string | null }
      | undefined;
    if (existing?.revoked_at) {
      return { revokedAgentId: agentId, revokedAt: existing.revoked_at, revokedCredentialJtis: [] };
    }

    const at = new Date().toISOString();
    this.ctx.storage.sql.exec(`UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`, at, agentId);

    const rows = [...this.ctx.storage.sql.exec(`SELECT jti FROM credentials WHERE agent_id = ? AND revoked_at IS NULL`, agentId)] as Array<{
      jti: string;
    }>;
    if (rows.length > 0) {
      this.ctx.storage.sql.exec(`UPDATE credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL`, at, agentId);
      for (const row of rows) this.revokedJtis.add(row.jti);
    }

    return { revokedAgentId: agentId, revokedAt: at, revokedCredentialJtis: rows.map((r) => r.jti) };
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }
}
