import type { RequestHandler } from "express";
import { identityNotAllowed, forbidden, unauthenticated } from "./errors.js";
import type { RelayStore } from "./store.js";

declare global {
  namespace Express { interface Request { inzoAuth?: { agentId: string; pairingId: string | null } } }
}

export function requireAuth(store: RelayStore): RequestHandler {
  return (req, _res, next) => {
    const match = req.header("authorization")?.match(/^Bearer (.+)$/);
    const identity = match && store.resolveToken(match[1]);
    if (!identity) return next(unauthenticated());
    if (req.body && ["agentId", "fromAgentId", "proposedBy"].some((field) => field in req.body)) return next(identityNotAllowed());
    if (req.params.id && identity.pairingId !== req.params.id) return next(forbidden("This token does not belong to the requested pairing"));
    req.inzoAuth = identity;
    next();
  };
}
