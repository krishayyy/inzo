/**
 * Worker entry point — the only place that speaks HTTP.
 *
 * Both Durable Objects (Registry, PairingRoom) expose typed RPC methods, not
 * routes; this file is the router that resolves auth against Registry, then
 * dispatches the actual operation to the right PairingRoom instance. Kept
 * deliberately thin — business rules live in the DOs, not here.
 */
import { timingSafeEqual } from "node:crypto";
import {
  badRequest,
  bodyHashOf,
  CredentialError,
  forbidden,
  identityNotAllowed,
  insufficientScope,
  parseCnf,
  ProofReplayGuard,
  proofInvalid,
  proofStale,
  revoked,
  unauthenticated,
  verifyConsentRecord,
  verifyProof,
  type Assurance,
  type AuditActor,
  type ConsentRecord,
  type CredentialPayload,
} from "./lib.js";
import { PairingRoom } from "./pairingRoom.js";
import { Registry } from "./registry.js";
import { unwrap } from "./rpcError.js";
import type { Scope } from "./types.js";

/** Constant-time comparison — a naive `===` on a secret leaks its value one byte at a time via timing. */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export { PairingRoom, Registry };

interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  PAIRING_ROOM: DurableObjectNamespace<PairingRoom>;
  /**
   * Gates POST /admin/rotate-key. Set with `wrangler secret put
   * INZO_ADMIN_TOKEN` — never committed, never in wrangler.jsonc.
   *
   * The Node relay (packages/relay) makes rotation a CLI-only operator
   * command specifically to avoid giving the single most powerful operation
   * on the relay a network surface. A Worker has no persistent host to gate
   * a CLI command behind — the closest equivalent here is a route that
   * requires a secret only the person who deployed this Worker holds.
   */
  INZO_ADMIN_TOKEN?: string;
}

const IDENTITY_FIELDS = ["agentId", "fromAgentId", "proposedBy", "principalId"];
const replayGuard = new ProofReplayGuard();

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
}

/**
 * Domain errors reach this function two ways: thrown directly within this
 * Worker (real RelayError/CredentialError instances — `unauthenticated()`,
 * `forbidden()`, etc. — instanceof works fine, same realm), or via
 * `unwrap()` after crossing a Durable Object RPC boundary (a plain Error
 * with `.status`/`.code` bolted on, since custom fields do not otherwise
 * survive that boundary — see rpcError.ts). Both shapes are duck-typed the
 * same way here rather than trusting the prototype chain either way.
 */
function errorResponse(err: unknown): Response {
  if (typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const code = (err as { code: string }).code;
    const message = "message" in err ? String((err as { message: unknown }).message) : "Error";
    const status = "status" in err && typeof (err as { status: unknown }).status === "number" ? (err as { status: number }).status : 401;
    return json({ error: { code, message } }, status);
  }
  console.error(err);
  return json({ error: { code: "internal", message: "Internal error" } }, 500);
}

interface AuthContext {
  agentId: string;
  pairingId: string | null;
  scope: Scope[];
  principalId: string | null;
  credential: CredentialPayload | null;
}

/**
 * Faithful port of packages/relay/src/lib/auth.ts's requireAuth, against
 * Registry RPC instead of an in-process CredentialStore.
 *
 * `allowQueryToken` is for GET /pairings/:id/stream only — the CLI's fetch()
 * call could set headers, but the wire format matches native EventSource
 * (which cannot), so credential/proof ride in the query string there. The
 * proof window is tightened to 60s on that path for the same reason the
 * original does: query strings leak via logs and Referer more readily than
 * headers do.
 */
async function authenticate(
  req: Request,
  body: unknown,
  registry: DurableObjectStub<Registry>,
  options: { allowQueryToken?: boolean } = {},
): Promise<AuthContext> {
  const url = new URL(req.url);
  const header = req.headers.get("authorization") ?? "";
  const inzoMatch = header.match(/^Inzo (.+)$/);
  const bearerMatch = header.match(/^Bearer (.+)$/);
  const allowQuery = options.allowQueryToken === true;
  const queryCredential = allowQuery ? url.searchParams.get("credential") : null;
  const queryToken = allowQuery ? url.searchParams.get("token") : null;

  const presentedCredential = inzoMatch?.[1] ?? queryCredential;
  if (presentedCredential) {
    // Left to propagate as-is: verifyOrThrow always throws a CredentialError
    // shape, which errorResponse() recognizes structurally since instanceof
    // does not survive the RPC boundary this call just crossed.
    const payload: CredentialPayload = unwrap(await registry.verifyOrThrow(presentedCredential));

    const proof = req.headers.get("inzo-proof") ?? (allowQuery ? (url.searchParams.get("proof") ?? undefined) : undefined);
    const at = req.headers.get("inzo-proof-at") ?? (allowQuery ? (url.searchParams.get("proofAt") ?? undefined) : undefined);
    let timestamp: number;
    try {
      timestamp = verifyProof({
        payload,
        proof,
        timestamp: at,
        method: req.method,
        path: url.pathname,
        bodyHash: bodyHashOf(body),
        nonce: req.headers.get("inzo-proof-nonce") ?? (allowQuery ? (url.searchParams.get("proofNonce") ?? "") : ""),
        windowSeconds: allowQuery ? 60 : undefined,
      });
    } catch (err) {
      if (err instanceof CredentialError) throw err.code === "proof_stale" ? proofStale(err.message) : proofInvalid(err.message);
      throw proofInvalid("Inzo-Proof could not be verified");
    }
    if (!replayGuard.admit(proof!, timestamp)) throw new CredentialError("proof_replayed", "This proof was already used");

    // A credential minted by POST /pairings is signed before a pairing
    // exists, so it carries `pairing: null` forever — a JWS cannot be
    // edited after signing. Resolve the binding here, dynamically, the same
    // way packages/relay's auth.ts does.
    const boundPairing = payload.pairing ?? (await registry.pairingForAgent(payload.sub));
    return { agentId: payload.sub, pairingId: boundPairing, scope: payload.cap, principalId: payload.prn, credential: payload };
  }

  const token = bearerMatch?.[1] ?? queryToken;
  if (!token) throw unauthenticated();
  const identity = await registry.resolveToken(token);
  if (!identity) throw unauthenticated();
  if (identity.revokedAt) throw revoked(`This credential was revoked at ${identity.revokedAt}`);
  const principalId = await registry.agentPrincipal(identity.agentId);
  return { agentId: identity.agentId, pairingId: identity.pairingId, scope: identity.scope, principalId, credential: null };
}

function assertNoIdentitySpoofing(body: unknown): void {
  if (body && typeof body === "object" && IDENTITY_FIELDS.some((field) => field in (body as Record<string, unknown>))) {
    throw identityNotAllowed();
  }
}

function requireScope(auth: AuthContext, scope: Scope): void {
  if (!auth.scope.includes(scope)) throw insufficientScope(scope);
}

function actorFrom(auth: AuthContext): AuditActor {
  return { principal: auth.principalId, agent: auth.agentId, credential: auth.credential?.jti ?? null };
}

function assuranceFrom(auth: AuthContext): Assurance {
  return auth.credential ? "pop" : "bearer";
}

/** Matches packages/relay's `express.json({ limit: "128kb" })` — nothing this API accepts is large; a cap keeps a hostile body from becoming a memory problem. */
const MAX_BODY_BYTES = 128 * 1024;

async function readJson(req: Request): Promise<unknown> {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw { status: 413, code: "payload_too_large", message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit` };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw { status: 413, code: "payload_too_large", message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit` };
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      return errorResponse(err);
    }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  const issuerUrl = `${url.protocol}//${url.host}`;
  await registry.setIssuerUrl(issuerUrl);

  if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
    return json({ ok: true });
  }

  if (req.method === "GET" && parts[0] === ".well-known" && parts[1] === "inzo-jwks") {
    return json(await registry.jwks());
  }
  if (req.method === "GET" && parts[0] === ".well-known" && parts[1] === "inzo-revocations") {
    return json(await registry.revocationList());
  }

  // POST /admin/rotate-key — deliberately not derivable from any pairing's
  // credential. Rotation is the single most powerful operation on the
  // relay (§4.1); gating it on INZO_ADMIN_TOKEN keeps it out of reach of
  // anyone who only ever holds an agent credential, however broad its scope.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "admin" && parts[1] === "rotate-key") {
    if (!env.INZO_ADMIN_TOKEN) {
      return json({ error: { code: "not_configured", message: "INZO_ADMIN_TOKEN is not set on this deployment; rotation is disabled" } }, 503);
    }
    const presented = (req.headers.get("authorization") ?? "").match(/^Bearer (.+)$/)?.[1];
    if (!presented || !tokensMatch(presented, env.INZO_ADMIN_TOKEN)) {
      return json({ error: { code: "unauthenticated", message: "A valid admin token is required" } }, 401);
    }
    const newKid = await registry.rotateIssuerKey();
    const pruned = await registry.pruneRetiredKeys();
    return json({
      rotated: true,
      newKid,
      prunedRetiredKeys: pruned,
      note: "Retired key stays published in the JWKS until nothing it signed can still be alive. Verifiers cache the JWKS — allow their cache TTL to pass before assuming everyone has the new key.",
    });
  }

  if (parts[0] !== "pairings" && parts[0] !== "credentials" && parts[0] !== "consent") {
    return json({ error: { code: "not_found", message: `No route for ${req.method} ${url.pathname}` } }, 404);
  }

  // POST /pairings — create a pairing code
  if (req.method === "POST" && parts.length === 1 && parts[0] === "pairings") {
    const body = (await readJson(req)) as { cnf?: { jwk: unknown } };
    const cnf = body.cnf ? (body.cnf as { jwk: import("./lib.js").Jwk }) : undefined;
    const result = await registry.createPairingCode(cnf);
    return json(result, 201);
  }

  // POST /pairings/:code/join
  if (req.method === "POST" && parts.length === 3 && parts[0] === "pairings" && parts[2] === "join") {
    const code = parts[1];
    const body = (await readJson(req)) as { cnf?: { jwk: unknown } };
    const cnf = body.cnf ? (body.cnf as { jwk: import("./lib.js").Jwk }) : undefined;
    // Set by Cloudflare's edge, not client-controllable — no "trust proxy"
    // configuration needed the way packages/relay's Express app requires.
    const clientKey = req.headers.get("cf-connecting-ip") ?? "unknown";
    const joined = unwrap(await registry.joinPairing(code, cnf, clientKey));

    const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(joined.pairingId));
    await room.initialize(joined.pairingId, code, joined.agentA, joined.agentB, new Date().toISOString());

    const joinerAssurance: Assurance = joined.credential ? "pop" : "bearer";
    const joinerActor: AuditActor = { principal: joined.principalId, agent: joined.agentB, credential: null };
    await room.appendAudit("pairing.created", joinerActor, joinerAssurance, { code });
    await room.appendAudit("pairing.joined", joinerActor, joinerAssurance, { peerAgentId: joined.agentA });

    return json(
      {
        pairingId: joined.pairingId,
        agentA: joined.agentA,
        agentB: joined.agentB,
        code: joined.code,
        agentToken: joined.agentToken,
        scope: joined.scope,
        peerAgentId: joined.peerAgentId,
        principalId: joined.principalId,
        credential: joined.credential,
      },
      201,
    );
  }

  // POST /credentials/attenuate
  if (req.method === "POST" && parts.length === 2 && parts[0] === "credentials" && parts[1] === "attenuate") {
    const body = (await readJson(req)) as { cap: unknown; cnf: unknown; ttl?: number };
    const auth = await authenticate(req, body, registry);
    if (!auth.credential) throw badRequest("Attenuation requires a v3 credential; a bearer token has no chain to extend");
    if (body.cap === undefined) throw badRequest("cap is required (the capabilities to keep)");
    const cnf = parseCnf(body.cnf);
    const issued = unwrap(await registry.attenuateFrom(auth.credential, { cap: body.cap, cnf, ttlSeconds: body.ttl }));
    if (auth.pairingId) {
      const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(auth.pairingId));
      await room.appendAudit("credential.attenuated", actorFrom(auth), assuranceFrom(auth), {
        child: issued.payload.jti,
        cap: issued.payload.cap,
        depth: issued.payload.depth,
      });
    }
    return json({ credential: issued.credential, jti: issued.payload.jti, cap: issued.payload.cap, depth: issued.payload.depth, expiresAt: new Date(issued.payload.exp * 1000).toISOString() }, 201);
  }

  // POST /consent/verify — unauthenticated, on purpose. Lets a third party
  // handed a consent record out-of-band re-derive `satisfied` from the
  // signatures themselves rather than believing our flag. That independence
  // is the entire reason approvals are signed in the first place.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "consent" && parts[1] === "verify") {
    const requestBody = (await readJson(req)) as { consent?: ConsentRecord; holderKeys?: Record<string, import("./lib.js").Jwk> };
    const record = requestBody.consent;
    if (!record?.pairingId || !record.subject || !Array.isArray(record.approvals)) {
      throw badRequest("consent must be a consent record with pairingId, subject, required and approvals");
    }
    const known = await registry.holderKeysFor(record.pairingId);
    // Callers may supply holder keys themselves — the point is that this
    // check does not depend on our storage. Supplied keys win on conflict.
    const supplied = new Map<string, import("./lib.js").Jwk>(Object.entries(known));
    for (const [jti, jwk] of Object.entries(requestBody.holderKeys ?? {})) supplied.set(jti, jwk);
    return json(verifyConsentRecord(record, supplied));
  }

  // GET /pairings/mine — the creator polls this after sharing their code to
  // learn when someone joined. `pairing: null` (200, not 404) while unjoined
  // is an expected polling state, not an error. Must be checked before the
  // generic /pairings/:id/... dispatch below, or "mine" gets treated as a
  // pairing id.
  if (req.method === "GET" && parts.length === 2 && parts[0] === "pairings" && parts[1] === "mine") {
    const auth = await authenticate(req, undefined, registry);
    if (!auth.pairingId) return json({ pairing: null });
    const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(auth.pairingId));
    const pairing = unwrap(await room.getPairing());
    const peerAgentId = await room.otherAgent(pairing, auth.agentId);
    const [budget, peerScope, peerRevoked] = await Promise.all([
      room.getBudget(),
      registry.getAgentScope(peerAgentId),
      registry.isAgentRevoked(peerAgentId),
    ]);
    return json({
      pairing: {
        id: pairing.id,
        agentId: auth.agentId,
        peerAgentId,
        createdAt: pairing.createdAt,
        budget,
        scope: auth.scope,
        peerScope,
        revoked: false, // an already-revoked credential never reaches here — authenticate() rejects it first
        peerRevoked,
      },
    });
  }

  // POST /pairings/mine/scope — permanently narrow this credential's own
  // capabilities. Not under /:id because a creator can narrow before anyone
  // has joined, when there is no pairing id yet.
  if (req.method === "POST" && parts.length === 3 && parts[0] === "pairings" && parts[1] === "mine" && parts[2] === "scope") {
    const body = (await readJson(req)) as { scope?: unknown };
    const auth = await authenticate(req, body, registry);
    if (body.scope === undefined) throw badRequest("scope is required (an array of capabilities to keep)");
    const scope = unwrap(await registry.narrowScope(auth.agentId, body.scope));
    return json({ scope });
  }

  // Everything else is /pairings/:id/...
  if (parts[0] !== "pairings" || parts.length < 3) {
    return json({ error: { code: "not_found", message: `No route for ${req.method} ${url.pathname}` } }, 404);
  }
  const pairingId = parts[1];
  const sub = parts.slice(2).join("/");
  const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(pairingId));

  // GET /pairings/:id/stream — special-cased before the generic dispatch:
  // it accepts query-string auth (EventSource-compatible wire format, even
  // though the CLI uses fetch()), and the response is a raw streamed
  // Response forwarded straight from the DO's own fetch() rather than a
  // JSON body built from an RPC call.
  if (sub === "stream" && req.method === "GET") {
    const streamAuth = await authenticate(req, undefined, registry, { allowQueryToken: true });
    if (streamAuth.pairingId !== pairingId) throw forbidden("This token does not belong to the requested pairing");
    if (!streamAuth.scope.includes("messages:read")) throw insufficientScope("messages:read");
    // Query strings carrying a credential/proof must not reach logs or the
    // DO's own request object — swap to a fresh internal URL that carries
    // only the resolved agentId, never the credential this request came in
    // with.
    const internalUrl = new URL(req.url);
    internalUrl.search = `?agentId=${encodeURIComponent(streamAuth.agentId)}`;
    return room.fetch(new Request(internalUrl, { signal: req.signal }));
  }

  const rawBody = req.method === "GET" ? undefined : await readJson(req);
  const auth = await authenticate(req, rawBody, registry);
  assertNoIdentitySpoofing(rawBody);
  if (auth.pairingId !== pairingId) throw forbidden("This token does not belong to the requested pairing");

  if (sub === "messages" && req.method === "POST") {
    requireScope(auth, "messages:send");
    const { body } = (rawBody ?? {}) as { body?: string };
    const message = unwrap(await room.addMessage(auth.agentId, body ?? ""));
    return json({ message }, 201);
  }
  if (sub === "messages" && req.method === "GET") {
    requireScope(auth, "messages:read");
    const since = url.searchParams.get("since");
    const messages = unwrap(await room.getMessages(since ? Number(since) : undefined));
    return json({ messages, cursor: messages.at(-1)?.cursor ?? Number(since ?? 0) });
  }

  if (sub === "digest" && req.method === "GET") {
    requireScope(auth, "messages:read");
    const rawLimit = Number(url.searchParams.get("limit") ?? 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    return json(unwrap(await room.getDigest(limit)));
  }

  if (sub === "plan" && req.method === "POST") {
    requireScope(auth, "plan:propose");
    const { goal, items } = (rawBody ?? {}) as { goal?: string; items?: unknown };
    const pairingForPlan = unwrap(await room.getPairing());
    const [principalA, principalB] = await Promise.all([
      registry.agentPrincipal(pairingForPlan.agentA),
      registry.agentPrincipal(pairingForPlan.agentB),
    ]);
    const plan = unwrap(
      await room.proposePlan(
        pairingId,
        auth.agentId,
        goal ?? "",
        (items ?? []) as never,
        [principalA, principalB].filter((p): p is string => Boolean(p)),
        actorFrom(auth),
        assuranceFrom(auth),
      ),
    );
    return json({ plan }, 201);
  }
  if (sub === "plan" && req.method === "GET") {
    return json({ plan: await room.getPlan() });
  }
  if (sub === "plan/approve" && req.method === "POST") {
    requireScope(auth, "plan:approve");
    const { planVersion, signature } = (rawBody ?? {}) as { planVersion?: unknown; signature?: unknown };
    const consent = signature !== undefined && auth.credential ? { payload: auth.credential, signature } : undefined;
    const result = unwrap(await room.approvePlan(auth.agentId, planVersion, consent));
    const { consent: consentRecord, ...plan } = result as typeof result & { consent?: unknown };
    return json(consentRecord ? { plan, consent: consentRecord } : { plan });
  }

  const itemStatusMatch = sub.match(/^plan\/items\/(\d+)\/status$/);
  if (itemStatusMatch && req.method === "POST") {
    requireScope(auth, "plan:propose");
    const { status } = (rawBody ?? {}) as { status?: string };
    const updated = unwrap(
      await room.updateItemStatus(auth.agentId, Number(itemStatusMatch[1]), (status ?? "") as never, actorFrom(auth), assuranceFrom(auth)),
    );
    return json({ plan: updated });
  }

  if (sub === "consent" && req.method === "GET") {
    return json({ consent: await room.getConsent() });
  }
  if (sub === "consent/withdraw" && req.method === "POST") {
    if (!auth.principalId) throw badRequest("No principal associated with this credential");
    return json({ consent: unwrap(await room.withdrawConsent(auth.principalId, actorFrom(auth), assuranceFrom(auth))) });
  }

  if (sub === "budget" && req.method === "PUT") {
    const budget = unwrap(await room.setBudget(auth.agentId, (rawBody ?? {}) as never));
    return json({ budget });
  }
  if (sub === "budget" && req.method === "GET") {
    return json({ budget: await room.getBudget() });
  }

  if (sub === "usage" && req.method === "POST") {
    requireScope(auth, "usage:report");
    const { tokensUsed, costUsd, wallClockMs, progressPct } = (rawBody ?? {}) as {
      tokensUsed?: number;
      costUsd?: number;
      wallClockMs?: number;
      progressPct?: number;
    };
    unwrap(
      await room.reportUsage(auth.agentId, {
        tokensUsed: tokensUsed ?? 0,
        costUsd: costUsd ?? 0,
        wallClockMs: wallClockMs ?? 0,
        progressPct: progressPct ?? 0,
      }),
    );
    return json(await room.getUsageSnapshot(), 201);
  }
  if (sub === "usage" && req.method === "GET") {
    return json(await room.getUsageSnapshot());
  }

  if (sub === "revoke" && req.method === "POST") {
    const { target } = (rawBody ?? {}) as { target?: "self" | "peer" };
    const pairing = unwrap(await room.getPairing());
    unwrap(await room.assertMember(pairing, auth.agentId));
    const targetAgentId = target === "peer" ? await room.otherAgent(pairing, auth.agentId) : auth.agentId;
    const result = await registry.revokeAgent(targetAgentId);
    if (result.revokedCredentialJtis.length > 0) {
      await room.withdrawByCredentials(result.revokedCredentialJtis);
    }
    await room.appendAudit("credential.revoked", actorFrom(auth), assuranceFrom(auth), {
      revokedAgentId: result.revokedAgentId,
      revokedCredentials: result.revokedCredentialJtis,
      target: target ?? "self",
    });
    await room.broadcastRevocation(result.revokedAgentId, result.revokedAt, auth.agentId);
    return json({ revocation: { revokedAgentId: result.revokedAgentId, revokedAt: result.revokedAt, by: auth.agentId } });
  }

  if (sub === "audit" && req.method === "GET") {
    requireScope(auth, "messages:read");
    const since = Number(url.searchParams.get("since") ?? 0);
    const check = (await room.getAudit(Number.isFinite(since) ? since : 0)) as {
      records: unknown[];
      chainValid: boolean;
      brokenAt: number | null;
      head: string | null;
    };
    return json({ records: check.records, chainValid: check.chainValid, brokenAt: check.brokenAt, head: check.head, issuer: issuerUrl });
  }

  return json({ error: { code: "not_found", message: `No route for ${req.method} ${url.pathname}` } }, 404);
}
