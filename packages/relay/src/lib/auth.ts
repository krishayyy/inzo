import type { RequestHandler } from "express";
import {
  credentialExpired,
  forbidden,
  identityNotAllowed,
  insufficientScope,
  proofInvalid,
  proofReplayed,
  proofStale,
  revoked,
  unauthenticated,
} from "./errors.js";
import type { RelayStore } from "./store.js";
import {
  bodyHashOf,
  CredentialError,
  ProofReplayGuard,
  verifyProof,
  type CredentialPayload,
} from "./credential.js";
import type { Assurance } from "./audit.js";
import type { Scope, TokenIdentity } from "../types.js";

export interface AuthContext extends TokenIdentity {
  pairingId: string | null;
  /**
   * How identity was established. `bearer` is the v2 path, kept for migration;
   * it authenticates but cannot prove possession, so it can never support a
   * non-repudiable consent signature — see `requirePop`.
   */
  assurance: Assurance;
  principalId: string | null;
  credential: CredentialPayload | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      inzoAuth?: AuthContext;
    }
  }
}

export interface AuthOptions {
  /**
   * Also accept the credential and proof in the query string. Only for
   * `GET /stream`: EventSource cannot set headers. Query strings leak via logs
   * and `Referer`, so this is opt-in per route rather than a global fallback,
   * the relay must not log query strings on any route that enables it, and the
   * proof window is tightened.
   */
  allowQueryToken?: boolean;
}

const IDENTITY_FIELDS = ["agentId", "fromAgentId", "proposedBy", "principalId"];

/** Shared across the process: a proof is valid for its whole window, so the
 *  replay set has to outlive any single request to be worth anything. */
const replayGuard = new ProofReplayGuard();

function credentialErrorToRelayError(err: CredentialError) {
  switch (err.code) {
    case "credential_expired":
      return credentialExpired(err.message);
    case "revoked":
      return revoked(err.message);
    case "depth_exceeded":
      return unauthenticated(err.message);
    default:
      return unauthenticated(err.message);
  }
}

/**
 * Derives identity from the presented credential, server-side, always.
 *
 * The ordering is deliberate: authenticate, then reject self-asserted identity
 * in the body, then check pairing membership, then capability. A body carrying
 * `agentId`/`fromAgentId`/`proposedBy`/`principalId` fails loudly rather than
 * being silently ignored — a caller that believes those fields are
 * authoritative has a bug worth surfacing, and in v1 that belief was the
 * impersonation vector.
 *
 * Two credential formats are accepted during migration:
 *   `Authorization: Inzo <jws>`    → v3, signed + proof of possession
 *   `Authorization: Bearer <opaque>` → v2, authenticated but unprovable
 */
export function requireAuth(store: RelayStore, options: AuthOptions = {}): RequestHandler {
  const allowQuery = options.allowQueryToken === true;

  return (req, _res, next) => {
    const header = req.header("authorization") ?? "";
    const inzoMatch = header.match(/^Inzo (.+)$/);
    const bearerMatch = header.match(/^Bearer (.+)$/);
    const queryCredential = allowQuery && typeof req.query.credential === "string" ? req.query.credential : null;
    const queryToken = allowQuery && typeof req.query.token === "string" ? req.query.token : null;

    let context: AuthContext;

    const presentedCredential = inzoMatch?.[1] ?? queryCredential;
    if (presentedCredential) {
      let payload: CredentialPayload;
      try {
        payload = store.credentials.verify(presentedCredential);
      } catch (err) {
        return next(err instanceof CredentialError ? credentialErrorToRelayError(err) : unauthenticated());
      }

      const proof = req.header("inzo-proof") ?? (allowQuery && typeof req.query.proof === "string" ? req.query.proof : undefined);
      const at =
        req.header("inzo-proof-at") ?? (allowQuery && typeof req.query.proofAt === "string" ? req.query.proofAt : undefined);

      let timestamp: number;
      try {
        timestamp = verifyProof({
          payload,
          proof,
          timestamp: at,
          method: req.method,
          // `originalUrl` includes the query string; the proof is over the path
          // the client actually signed, so strip it.
          path: req.originalUrl.split("?")[0],
          bodyHash: bodyHashOf(req.body),
          // A per-request nonce is what makes two identical reads in the same
          // second distinguishable from a replay. Without it the guard would
          // reject legitimate repeated GETs, which is a liveness failure
          // dressed up as a security control.
          nonce:
            req.header("inzo-proof-nonce") ??
            (allowQuery && typeof req.query.proofNonce === "string" ? req.query.proofNonce : ""),
          windowSeconds: allowQuery ? 60 : undefined,
        });
      } catch (err) {
        if (err instanceof CredentialError) {
          return next(err.code === "proof_stale" ? proofStale(err.message) : proofInvalid(err.message));
        }
        return next(proofInvalid("Inzo-Proof could not be verified"));
      }

      if (!replayGuard.admit(proof!, timestamp)) {
        return next(proofReplayed());
      }

      // A credential minted by `POST /pairings` is signed before a pairing
      // exists, so it carries `pairing: null`. Rather than re-issuing it out of
      // band (the creator is not in the request when the joiner arrives), we
      // resolve the binding here.
      //
      // This is deliberately the one fact the relay still supplies. A
      // pre-binding credential is local by construction — it names no pairing,
      // so it grants nothing to a third party and a cross-org verifier is right
      // to reject it. Everything a peer relies on is bound at issue.
      const boundPairing = payload.pairing ?? store.pairingForAgent(payload.sub);

      context = {
        agentId: payload.sub,
        pairingId: boundPairing,
        scope: payload.cap,
        revokedAt: null,
        assurance: "pop",
        principalId: payload.prn,
        credential: boundPairing === payload.pairing ? payload : { ...payload, pairing: boundPairing },
      };
    } else {
      const token = bearerMatch?.[1] ?? queryToken;
      const identity = token ? store.resolveToken(token) : null;
      if (!identity) return next(unauthenticated());
      if (identity.revokedAt) return next(revoked(`This credential was revoked at ${identity.revokedAt}`));
      context = {
        ...identity,
        assurance: "bearer",
        principalId: store.credentials.agentPrincipal(identity.agentId),
        credential: null,
      };
    }

    if (req.body && IDENTITY_FIELDS.some((field) => field in req.body)) {
      return next(identityNotAllowed());
    }
    if (req.params.id && context.pairingId !== req.params.id) {
      return next(forbidden("This token does not belong to the requested pairing"));
    }

    req.inzoAuth = context;
    next();
  };
}

/** Gate a route on a capability the credential must still carry. */
export function requireScope(scope: Scope): RequestHandler {
  return (req, _res, next) => {
    if (!req.inzoAuth) return next(unauthenticated());
    if (!req.inzoAuth.scope.includes(scope)) return next(insufficientScope(scope));
    next();
  };
}
