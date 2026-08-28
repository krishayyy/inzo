import { Router, type RequestHandler } from "express";
import { InvalidSessionDescriptorError, validateSessionDescriptor } from "inzo-protocol";
import { requireScope } from "../lib/auth.js";
import { badRequest } from "../lib/errors.js";
import { relayEvents } from "../lib/events.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

/**
 * The session descriptor: which mode the team is in, and which repo/branch
 * they share.
 *
 * Validation is deliberately not done here — it lives in `inzo-protocol` so
 * this relay and the Cloudflare one cannot drift on it. Drift on the repo URL
 * rules specifically would be a security divergence, since that URL ends up
 * as an argument to `git clone` on every joiner's machine.
 */
export function sessionRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const get: RequestHandler<PairingParams> = (req, res) => {
    res.json({ session: store.getSession(req.params.id) });
  };

  // Requires plan:propose rather than a scope of its own: changing the mode is
  // the same class of act as proposing what the team works on. It never widens
  // anyone's authority, because scope is fixed at mint.
  const set: RequestHandler<PairingParams> = (req, res, next) => {
    try {
      const session = validateSessionDescriptor(req.body?.session);
      const saved = store.setSession(req.params.id, req.inzoAuth!.agentId, session);
      relayEvents.publish({ type: "session.updated", pairingId: req.params.id, session: saved });
      res.json({ session: saved });
    } catch (err) {
      if (err instanceof InvalidSessionDescriptorError) {
        next(badRequest(err.message));
        return;
      }
      next(err);
    }
  };

  router.get("/", get);
  router.post("/", requireScope("plan:propose"), set);

  return router;
}
