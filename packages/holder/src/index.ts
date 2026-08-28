/**
 * Client-side half of the Inzo v3 trust model — PROTOCOL.md §1.2, §6.2, §10.
 *
 * Everything here runs on the human's machine and touches the one secret the
 * relay must never see: the holder private key. That key is what makes a
 * consent signature non-repudiable, so this module has exactly one job and no
 * network access — nothing in it can accidentally transmit the thing it
 * protects.
 *
 * Shared by `inzo-mcp` (agent side) and `inzo` (human side) so there is one
 * implementation of the signing rules rather than two that can drift.
 */

import {
  createHash,
  randomBytes,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface HolderKeyPair {
  publicJwk: Jwk;
  privateKeyPem: string;
}

export const CONSENT_DOMAIN = "inzo-consent-v3";

/**
 * Generates the keypair a credential is bound to.
 *
 * The public half goes to the relay as `cnf.jwk`; the private half is written
 * to `~/.inzo/session.json` (0600) and never leaves the machine. A credential
 * without the matching private key is inert, which is what makes theft of the
 * credential alone useless.
 */
export function generateHolderKeyPair(): HolderKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return {
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function publicJwkFromPem(privateKeyPem: string): Jwk {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" }) as Record<string, string>;
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

/**
 * Deterministic JSON — must match the relay's `canonicalize` exactly.
 *
 * Both the body hash in a proof and the subject hash in a consent record are
 * taken over this form. A divergence here would not fail loudly; it would fail
 * as a signature that mysteriously does not verify, so it is worth keeping
 * boring and identical.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Matches the relay's `bodyHashOf`: an absent or empty body hashes to "". */
export function bodyHashOf(body: unknown): string {
  if (body === undefined || body === null) return "";
  const serialized = typeof body === "string" ? body : canonicalize(body);
  if (serialized === "{}" || serialized === "") return "";
  return sha256Hex(serialized);
}

/** Reads a credential's payload without verifying it. Local inspection only. */
export function decodePayload(credential: string): {
  jti: string;
  sub: string;
  prn: string;
  pairing: string | null;
  cap: string[];
  exp: number;
  depth: number;
} {
  const part = credential.split(".")[1];
  if (!part) throw new Error("Malformed credential");
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

/** True when the credential is within `skewSeconds` of expiring. */
export function isExpiring(credential: string, skewSeconds = 120): boolean {
  try {
    return decodePayload(credential).exp - Math.floor(Date.now() / 1000) <= skewSeconds;
  } catch {
    return true;
  }
}

export interface ProofHeaders {
  Authorization: string;
  "Inzo-Proof": string;
  "Inzo-Proof-At": string;
  "Inzo-Proof-Nonce": string;
}

/**
 * Builds the three headers every authenticated v3 request carries.
 *
 * The signature covers method, path, credential id, timestamp, and a hash of
 * the body — so an intermediary can neither replay the request elsewhere nor
 * swap the body while keeping a valid credential attached.
 */
export function buildAuthHeaders(input: {
  credential: string;
  privateKeyPem: string;
  method: string;
  path: string;
  body?: unknown;
  /** Overridable for deterministic tests; defaults to fresh randomness. */
  nonce?: string;
  now?: number;
}): ProofHeaders {
  const at = Math.floor((input.now ?? Date.now()) / 1000);
  const { jti } = decodePayload(input.credential);
  // Fresh per request. Two identical reads in the same second must produce
  // different proofs, or the relay's replay guard cannot tell them apart from
  // an actual replay.
  const nonce = input.nonce ?? randomBytes(12).toString("base64url");
  const message = [
    input.method.toUpperCase(),
    input.path,
    jti,
    String(at),
    bodyHashOf(input.body),
    nonce,
  ].join("\n");
  const signature = cryptoSign(null, Buffer.from(message), createPrivateKey(input.privateKeyPem));
  return {
    Authorization: `Inzo ${input.credential}`,
    "Inzo-Proof": signature.toString("base64url"),
    "Inzo-Proof-At": String(at),
    "Inzo-Proof-Nonce": nonce,
  };
}

export interface PlanLike {
  pairingId: string;
  goal: string;
  items: Array<{ owner: string; task: string }>;
  version: number;
}

/**
 * The hash of the plan content, computed locally from the plan the human was
 * actually shown.
 *
 * Recomputing it here rather than trusting a hash handed to us by the relay is
 * the point: signing a relay-supplied hash would let a hostile relay collect a
 * signature over text the human never saw.
 */
export function planSubjectHash(plan: PlanLike): string {
  return `sha256:${sha256Hex(
    canonicalize({
      pairingId: plan.pairingId,
      goal: plan.goal,
      items: plan.items.map((item) => ({ owner: item.owner, task: item.task })),
      version: plan.version,
    }),
  )}`;
}

export function consentStatement(pairingId: string, version: number, hash: string, kind = "plan"): string {
  return [CONSENT_DOMAIN, pairingId, kind, String(version), hash].join("\n");
}

/**
 * Signs approval of a specific plan, from the plan itself.
 *
 * Takes the plan rather than a hash on purpose — a caller cannot accidentally
 * approve a digest whose preimage they never rendered.
 */
export function signConsent(privateKeyPem: string, plan: PlanLike): { signature: string; subjectHash: string } {
  const subjectHash = planSubjectHash(plan);
  const signature = cryptoSign(
    null,
    Buffer.from(consentStatement(plan.pairingId, plan.version, subjectHash)),
    createPrivateKey(privateKeyPem),
  ).toString("base64url");
  return { signature, subjectHash };
}

// ---------------------------------------------------------------------------
// Session file location
// ---------------------------------------------------------------------------

/**
 * Sessions are keyed by workspace, never global.
 *
 * A single `~/.inzo/session.json` meant one session per machine. A second
 * `inzo start` in another project overwrote the first session's holder
 * private key — the one value here that cannot be regenerated, and the one
 * its kill switch depends on. It also meant project B's MCP server held
 * pairing A's credential while `INZO_WORKSPACE` pointed at project B, so a
 * peer in pairing A could have commands run against an unrelated directory.
 *
 * Lives in `inzo-holder` because both `inzo` and `inzo-mcp` must agree on
 * where a session lives; two copies of this rule would drift the same way
 * the two `sessionFilePath()` definitions it replaces did.
 */
export function inzoHome(): string {
  return join(process.env.INZO_HOME ?? homedir(), ".inzo");
}

/**
 * Stable short key for a workspace path.
 *
 * Resolved through symlinks so `/tmp/x` and `/private/tmp/x` (macOS) are one
 * session rather than two silently diverging ones.
 */
export function sessionKeyFor(workspace: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(resolve(workspace));
  } catch {
    // The directory may not exist yet (`inzo start my-app` before mkdir).
    resolved = resolve(workspace);
  }
  return sha256Hex(resolved).slice(0, 16);
}

export function sessionsDir(): string {
  return join(inzoHome(), "sessions");
}

export function sessionFilePathFor(workspace: string): string {
  return join(sessionsDir(), `${sessionKeyFor(workspace)}.json`);
}

/**
 * Points at the most recently written session, so `inzo status` run from
 * outside any workspace still has something to attach to.
 */
export function currentPointerPath(): string {
  return join(inzoHome(), "current");
}

/**
 * The pre-workspace-keyed single global session. Read as a fallback so an
 * existing pairing survives the upgrade; never written to again.
 */
export function legacySessionFilePath(): string {
  return join(inzoHome(), "session.json");
}

/** Records `workspace` as the active session. Best-effort, never throws. */
export function writeCurrentPointer(workspace: string): void {
  try {
    mkdirSync(inzoHome(), { recursive: true, mode: 0o700 });
    writeFileSync(currentPointerPath(), `${resolve(workspace)}\n`, { mode: 0o600 });
  } catch {
    // A missing pointer degrades to "no session found", which is recoverable.
  }
}

/** The workspace the pointer names, or null when there is no usable pointer. */
export function readCurrentPointer(): string | null {
  try {
    const raw = readFileSync(currentPointerPath(), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}
