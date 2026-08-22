import { Router, type RequestHandler } from "express";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

export function profileRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // PUT /pairings/:id/profile — declare THIS caller's own model + strengths.
  // There is no route to set another agent's profile — it is self-reported,
  // the same way a name tag is something you put on yourself.
  const put: RequestHandler<PairingParams> = (req, res) => {
    const profile = store.setAgentProfile(req.params.id, req.inzoAuth!.agentId, req.body ?? {});
    res.json({ profile });
  };

  // GET /pairings/:id/profile — every member's declared profile, so either
  // side (or a human) can see who's on the pairing and what they're good at
  // before splitting up work.
  const get: RequestHandler<PairingParams> = (req, res) => {
    res.json({ profiles: store.getAgentProfiles(req.params.id) });
  };

  router.put("/", put);
  router.get("/", get);

  return router;
}
