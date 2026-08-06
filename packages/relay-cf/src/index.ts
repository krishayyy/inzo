/**
 * Worker entry point — the only place that speaks HTTP.
 *
 * Both Durable Objects (Registry, PairingRoom) expose typed RPC methods, not
 * routes; this file is the router that resolves auth against Registry, then
 * dispatches the actual operation to the right PairingRoom instance. Kept
 * deliberately thin — business rules live in the DOs, not here.
 */
import {
  badRequest,
  bodyHashOf,
  CredentialError,
  forbidden,
  identityNotAllowed,
  insufficientScope,
  ProofReplayGuard,
  proofInvalid,
  proofStale,
  revoked,
  unauthenticated,
  verifyProof,
  type CredentialPayload,
} from "./lib.js";
import { PairingRoom } from "./pairingRoom.js";
import { Registry } from "./registry.js";
import { unwrap } from "./rpcError.js";
import type { Scope } from "./types.js";

export { PairingRoom, Registry };

interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  PAIRING_ROOM: DurableObjectNamespace<PairingRoom>;
}

const IDENTITY_FIELDS = ["agentId", "fromAgentId", "proposedBy", "principalId"];
const replayGuard = new ProofReplayGuard();

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
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

/** Faithful port of packages/relay/src/lib/auth.ts's requireAuth, against Registry RPC instead of an in-process CredentialStore. */
async function authenticate(req: Request, body: unknown, registry: DurableObjectStub<Registry>): Promise<AuthContext> {
  const header = req.headers.get("authorization") ?? "";
  const inzoMatch = header.match(/^Inzo (.+)$/);
  const bearerMatch = header.match(/^Bearer (.+)$/);

  if (inzoMatch) {
    const presented = inzoMatch[1];
    // Left to propagate as-is: verifyOrThrow always throws a CredentialError
    // shape, which errorResponse() recognizes structurally (see
    // isCredentialErrorShape) since instanceof does not survive the RPC
    // boundary this call just crossed.
    const payload: CredentialPayload = unwrap(await registry.verifyOrThrow(presented));

    const proof = req.headers.get("inzo-proof") ?? undefined;
    const at = req.headers.get("inzo-proof-at") ?? undefined;
    const url = new URL(req.url);
    let timestamp: number;
    try {
      timestamp = verifyProof({
        payload,
        proof,
        timestamp: at,
        method: req.method,
        path: url.pathname,
        bodyHash: bodyHashOf(body),
        nonce: req.headers.get("inzo-proof-nonce") ?? "",
      });
    } catch (err) {
      if (err instanceof CredentialError) throw err.code === "proof_stale" ? proofStale(err.message) : proofInvalid(err.message);
      throw proofInvalid("Inzo-Proof could not be verified");
    }
    if (!replayGuard.admit(proof!, timestamp)) throw new CredentialError("proof_replayed", "This proof was already used");

    return { agentId: payload.sub, pairingId: payload.pairing, scope: payload.cap, principalId: payload.prn, credential: payload };
  }

  const token = bearerMatch?.[1];
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

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
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

  if (parts[0] !== "pairings" && parts[0] !== "credentials") {
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
    const joined = unwrap(await registry.joinPairing(code, cnf));

    const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(joined.pairingId));
    await room.initialize(joined.pairingId, code, joined.agentA, joined.agentB, new Date().toISOString());

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
    const body = (await readJson(req)) as { cap: unknown; cnf: { jwk: import("./lib.js").Jwk }; ttl?: number };
    const auth = await authenticate(req, body, registry);
    if (!auth.credential) throw unauthenticated("Attenuation requires a v3 signed credential, not a bearer token");
    const issued = unwrap(await registry.attenuateFrom(auth.credential, { cap: body.cap, cnf: body.cnf, ttlSeconds: body.ttl }));
    return json({ credential: issued.credential, jti: issued.payload.jti, cap: issued.payload.cap, depth: issued.payload.depth, expiresAt: new Date(issued.payload.exp * 1000).toISOString() }, 201);
  }

  // Everything else is /pairings/:id/...
  if (parts[0] !== "pairings" || parts.length < 3) {
    return json({ error: { code: "not_found", message: `No route for ${req.method} ${url.pathname}` } }, 404);
  }
  const pairingId = parts[1];
  const sub = parts.slice(2).join("/");
  const room = env.PAIRING_ROOM.get(env.PAIRING_ROOM.idFromName(pairingId));

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
      await room.proposePlan(pairingId, auth.agentId, goal ?? "", (items ?? []) as never, [principalA, principalB].filter((p): p is string => Boolean(p))),
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

  if (sub === "consent" && req.method === "GET") {
    return json({ consent: await room.getConsent() });
  }
  if (sub === "consent/withdraw" && req.method === "POST") {
    if (!auth.principalId) throw badRequest("No principal associated with this credential");
    return json({ consent: unwrap(await room.withdrawConsent(auth.principalId)) });
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
    return json({ revocation: { revokedAgentId: result.revokedAgentId, revokedAt: result.revokedAt, by: auth.agentId } });
  }

  return json({ error: { code: "not_found", message: `No route for ${req.method} ${url.pathname}` } }, 404);
}
