/**
 * Signed, attenuable, holder-bound capability credentials — PROTOCOL.md §1–§2.
 *
 * A v2 opaque bearer token meant nothing to anyone but the relay that issued
 * it, which made the relay a trusted third party for every guarantee in the
 * system. A v3 credential is a compact JWS that any party can verify offline
 * against the issuer's published JWKS, so "what is this agent allowed to do,
 * and on whose authority" is answerable without asking us.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { ALL_SCOPES, type Scope } from "../types.js";
import { badRequest } from "./errors.js";

/** Hard ceiling on credential lifetime. Offline verification is only safe
 *  because a stale verifier is wrong for at most this long. §1.1 */
export const MAX_TTL_SECONDS = 3600;
export const DEFAULT_TTL_SECONDS = 900;

/** §2 rule 4. An unbounded delegation chain is an unbounded audit problem. */
export const MAX_DEPTH = 4;

/** §1.2 — how far a proof timestamp may drift from the relay's clock. */
export const PROOF_WINDOW_SECONDS = 300;
export const STREAM_PROOF_WINDOW_SECONDS = 60;

const SCOPE_SET = new Set<string>(ALL_SCOPES);

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface CredentialPayload {
  iss: string;
  jti: string;
  sub: string;
  /** The human. Invariant across every hop of the chain — §1. */
  prn: string;
  pairing: string | null;
  cap: Scope[];
  /** Proof-of-possession: the holder's public key. Never the private half. */
  cnf: { jwk: Jwk };
  /** Ancestor jtis, root first. Lets a verifier detect a revoked ancestor
   *  without enumerating descendants — §4. */
  chain: string[];
  depth: number;
  iat: number;
  exp: number;
}

export interface IssuerKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface VerifyOptions {
  now?: number;
  /** jtis known to be revoked. Any hit on the credential or its chain rejects. */
  revoked?: ReadonlySet<string>;
  expectedIssuer?: string;
}

export class CredentialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function unb64u(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Deterministic JSON: keys sorted at every level, no insignificant whitespace.
 *
 * Every hash and signature in the protocol commits to this form. Two
 * implementations that serialize the same object differently would produce
 * different hashes for identical content, which would silently break
 * cross-organization consent verification (§6.2).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function generateIssuerKey(kid = `key_${randomUUID()}`): IssuerKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, publicKey };
}

/** Holder keypair. The private half stays on the holder's machine — §10. */
export function generateHolderKeyPair(): { publicJwk: Jwk; privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicJwk: toJwk(publicKey),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function toJwk(key: KeyObject): Jwk {
  const jwk = key.export({ format: "jwk" }) as Record<string, string>;
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

export function fromJwk(jwk: Jwk): KeyObject {
  if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new CredentialError("bad_request", "cnf.jwk must be an Ed25519 OKP public key");
  }
  try {
    return createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: "jwk" });
  } catch {
    throw new CredentialError("bad_request", "cnf.jwk is not a valid Ed25519 public key");
  }
}

/** Validates a caller-supplied `cnf` before it is baked into a credential. */
export function parseCnf(value: unknown): { jwk: Jwk } {
  const jwk = (value as { jwk?: unknown } | undefined)?.jwk;
  if (!jwk) throw badRequest("cnf.jwk is required: generate an Ed25519 keypair and send the public half");
  const parsed = jwk as Jwk;
  fromJwk(parsed); // throws if malformed
  return { jwk: { kty: "OKP", crv: "Ed25519", x: parsed.x } };
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueInput {
  issuer: string;
  agentId: string;
  principalId: string;
  pairingId: string | null;
  cap: Scope[];
  cnf: { jwk: Jwk };
  chain?: string[];
  depth?: number;
  ttlSeconds?: number;
  now?: number;
}

export function issueCredential(
  key: IssuerKey,
  input: IssueInput,
): { credential: string; payload: CredentialPayload } {
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const ttl = Math.min(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  if (ttl <= 0) throw badRequest("ttl must be a positive number of seconds");

  const payload: CredentialPayload = {
    iss: input.issuer,
    jti: `cred_${randomUUID()}`,
    sub: input.agentId,
    prn: input.principalId,
    pairing: input.pairingId,
    cap: ALL_SCOPES.filter((entry) => input.cap.includes(entry)),
    cnf: input.cnf,
    chain: input.chain ?? [],
    depth: input.depth ?? 0,
    iat: nowSec,
    exp: nowSec + ttl,
  };

  const header = { alg: "EdDSA", typ: "inzo-cred+jws", kid: key.kid };
  const signingInput = `${b64u(canonicalize(header))}.${b64u(canonicalize(payload))}`;
  const signature = cryptoSign(null, Buffer.from(signingInput), key.privateKey);
  return { credential: `${signingInput}.${b64u(signature)}`, payload };
}

/**
 * Produces a child credential holding a SUBSET of the parent's capabilities.
 *
 * The subset check is the whole point of the capability system. Without it,
 * "capabilities" would be decoration any holder could reset by reissuing
 * itself the full list. With it, a human who strips `plan:approve` gets a
 * guarantee their agent cannot put it back, however it is prompted — and one
 * the peer's organization can verify without asking this relay.
 */
export function attenuate(
  key: IssuerKey,
  parent: CredentialPayload,
  requested: { cap: unknown; cnf: { jwk: Jwk }; ttlSeconds?: number },
  now = Date.now(),
): { credential: string; payload: CredentialPayload } {
  if (!Array.isArray(requested.cap)) {
    throw badRequest(`cap must be an array of capabilities from: ${ALL_SCOPES.join(", ")}`);
  }
  const unknown = requested.cap.filter((entry) => !SCOPE_SET.has(entry as string));
  if (unknown.length > 0) {
    throw badRequest(`Unknown capabilities: ${unknown.map(String).join(", ")}`);
  }

  const next = [...new Set(requested.cap as Scope[])];
  const held = new Set(parent.cap);
  const widened = next.filter((entry) => !held.has(entry));
  if (widened.length > 0) {
    throw badRequest(`A credential cannot widen its own capabilities. Not currently held: ${widened.join(", ")}`);
  }

  const depth = parent.depth + 1;
  if (depth > MAX_DEPTH) {
    throw new CredentialError("depth_exceeded", `Delegation depth ${depth} exceeds the limit of ${MAX_DEPTH}`);
  }

  // A child may never outlive its parent — §2 rule 5.
  const nowSec = Math.floor(now / 1000);
  const requestedTtl = Math.min(requested.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  const ttl = Math.max(1, Math.min(requestedTtl, parent.exp - nowSec));

  return issueCredential(key, {
    issuer: parent.iss,
    agentId: parent.sub,
    principalId: parent.prn, // invariant — §1
    pairingId: parent.pairing,
    cap: next,
    cnf: requested.cnf,
    chain: [...parent.chain, parent.jti],
    depth,
    ttlSeconds: ttl,
    now,
  });
}

// ---------------------------------------------------------------------------
// Verify — PROTOCOL.md §2.1
// ---------------------------------------------------------------------------

/** Parses without verifying. Only for inspection; never for authorization. */
export function decodeCredential(credential: string): { header: Record<string, unknown>; payload: CredentialPayload } {
  const parts = credential.split(".");
  if (parts.length !== 3) throw new CredentialError("unauthenticated", "Malformed credential");
  try {
    return {
      header: JSON.parse(unb64u(parts[0]).toString()) as Record<string, unknown>,
      payload: JSON.parse(unb64u(parts[1]).toString()) as CredentialPayload,
    };
  } catch {
    throw new CredentialError("unauthenticated", "Malformed credential");
  }
}

/**
 * Steps 1–8 of §2.1. Requires no network call beyond a cacheable JWKS and
 * revocation set, which is what makes cross-organization verification possible
 * without a bilateral agreement or a runtime callback to the issuer.
 */
export function verifyCredential(
  credential: string,
  keysByKid: ReadonlyMap<string, KeyObject>,
  options: VerifyOptions = {},
): CredentialPayload {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const parts = credential.split(".");
  if (parts.length !== 3) throw new CredentialError("unauthenticated", "Malformed credential");
  const { header, payload } = decodeCredential(credential);

  if (header.alg !== "EdDSA" || header.typ !== "inzo-cred+jws") {
    throw new CredentialError("unauthenticated", "Unsupported credential algorithm or type");
  }
  const issuerKey = typeof header.kid === "string" ? keysByKid.get(header.kid) : undefined;
  if (!issuerKey) throw new CredentialError("unauthenticated", "Unknown issuer key");

  const ok = cryptoVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), issuerKey, unb64u(parts[2]));
  if (!ok) throw new CredentialError("unauthenticated", "Credential signature is invalid");

  if (options.expectedIssuer && payload.iss !== options.expectedIssuer) {
    throw new CredentialError("unauthenticated", "Credential was issued by a different relay");
  }
  if (now >= payload.exp) throw new CredentialError("credential_expired", "Credential has expired");
  if (now < payload.iat - 60) throw new CredentialError("unauthenticated", "Credential is not yet valid");

  if (!Array.isArray(payload.cap) || payload.cap.some((entry) => !SCOPE_SET.has(entry))) {
    throw new CredentialError("unauthenticated", "Credential carries an unknown capability");
  }
  if (!Array.isArray(payload.chain) || payload.depth !== payload.chain.length) {
    throw new CredentialError("unauthenticated", "Credential depth does not match its chain");
  }
  if (payload.depth > MAX_DEPTH) {
    throw new CredentialError("depth_exceeded", `Delegation depth ${payload.depth} exceeds the limit`);
  }

  // A revoked ancestor kills the whole subtree, and the chain is what makes
  // that checkable by a verifier that only knows the ancestor's jti — §4.
  const revoked = options.revoked;
  if (revoked?.size) {
    if (revoked.has(payload.jti)) throw new CredentialError("revoked", "This credential was revoked");
    const deadAncestor = payload.chain.find((jti) => revoked.has(jti));
    if (deadAncestor) {
      throw new CredentialError("revoked", `An ancestor of this credential (${deadAncestor}) was revoked`);
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Proof of possession — §1.2
// ---------------------------------------------------------------------------

export function proofInput(
  method: string,
  path: string,
  jti: string,
  timestamp: number,
  bodyHash: string,
  nonce = "",
): string {
  return [method.toUpperCase(), path, jti, String(timestamp), bodyHash, nonce].join("\n");
}

export function bodyHashOf(body: unknown): string {
  if (body === undefined || body === null) return "";
  const serialized = typeof body === "string" ? body : canonicalize(body);
  if (serialized === "{}" || serialized === "") return "";
  return sha256Hex(serialized);
}

export function signProof(
  privateKeyPem: string,
  method: string,
  path: string,
  jti: string,
  timestamp: number,
  bodyHash: string,
  nonce = "",
): string {
  const key = createPrivateKey(privateKeyPem);
  return b64u(cryptoSign(null, Buffer.from(proofInput(method, path, jti, timestamp, bodyHash, nonce)), key));
}

/**
 * Verifies that the caller holds the private half of the key the credential
 * was bound to, and that the request body is the one that was signed.
 *
 * Binding the body hash is what stops an intermediary from swapping a plan
 * proposal in flight while keeping a valid credential attached.
 */
export function verifyProof(input: {
  payload: CredentialPayload;
  proof: string | undefined;
  timestamp: string | undefined;
  method: string;
  path: string;
  bodyHash: string;
  nonce?: string;
  now?: number;
  windowSeconds?: number;
}): number {
  if (!input.proof) throw new CredentialError("proof_invalid", "Inzo-Proof header is required");
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) throw new CredentialError("proof_invalid", "Inzo-Proof-At must be a unix timestamp");

  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const window = input.windowSeconds ?? PROOF_WINDOW_SECONDS;
  if (Math.abs(nowSec - ts) > window) {
    throw new CredentialError("proof_stale", `Proof timestamp is outside the ${window}s window`);
  }

  const holder = fromJwk(input.payload.cnf.jwk);
  const message = Buffer.from(
    proofInput(input.method, input.path, input.payload.jti, ts, input.bodyHash, input.nonce ?? ""),
  );
  let ok = false;
  try {
    ok = cryptoVerify(null, message, holder, unb64u(input.proof));
  } catch {
    ok = false;
  }
  if (!ok) throw new CredentialError("proof_invalid", "Inzo-Proof does not verify against the credential's cnf key");
  return ts;
}

/**
 * Replay guard for accepted proofs — §1.2.
 *
 * A proof is valid for its whole window, so without this an observer who sees
 * one request could repeat it verbatim until the window closes.
 */
export class ProofReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowSeconds = PROOF_WINDOW_SECONDS) {}

  /**
   * Returns false if this exact proof was already accepted.
   *
   * Keyed on the signature rather than on (jti, timestamp, path). A replay is
   * byte-identical by definition, so it presents the same signature; two
   * genuinely different requests — same credential, same path, same second,
   * different body — produce different signatures and must both be admitted.
   * Keying on the tuple alone would reject the second one, which is a
   * liveness bug rather than a security property.
   */
  admit(proof: string, timestamp: number, now = Date.now()): boolean {
    const nowSec = Math.floor(now / 1000);
    for (const [key, at] of this.seen) {
      if (nowSec - at > this.windowSeconds * 2) this.seen.delete(key);
    }
    if (this.seen.has(proof)) return false;
    this.seen.set(proof, nowSec);
    return true;
  }
}
