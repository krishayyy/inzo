import { Router, type RequestHandler } from "express";
import { InvalidSessionDescriptorError, validatePresence } from "inzo-protocol";
import { badRequest } from "../lib/errors.js";
import { relayEvents } from "../lib/events.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

/**
 * Presence: who is on what branch, with what dirty, right now.
 *
 * Never persisted and never audited — see the `Presence` doc in inzo-protocol
 * for why both of those are deliberate rather than an omission. It lives in a
 * `Map` in this process and evaporates on restart, which is the correct
 * durability for a 90-second liveness hint.
 *
 * Requires no scope of its own: every member can already read the thread and
 * the plan, and a working-tree hint is strictly less than either.
 */
export function presenceRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const get: RequestHandler<PairingParams> = (req, res) => {
    store.assertMember(store.getPairing(req.params.id), req.inzoAuth!.agentId);
    res.json({ presence: store.getPresence(req.params.id) });
  };

  const post: RequestHandler<PairingParams> = (req, res, next) => {
    try {
      const presence = validatePresence(req.body?.presence);
      const agentId = req.inzoAuth!.agentId;
      store.assertMember(store.getPairing(req.params.id), agentId);
      const entry = store.setPresence(req.params.id, agentId, presence);
      relayEvents.publish({ type: "presence.updated", pairingId: req.params.id, presence: entry });
      res.json({ presence: entry });
    } catch (err) {
      if (err instanceof InvalidSessionDescriptorError) {
        next(badRequest(err.message));
        return;
      }
      next(err);
    }
  };

  router.get("/", get);
  router.post("/", post);

  return router;
}
