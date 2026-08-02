import { Router, type RequestHandler } from "express";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

export function planRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // POST /pairings/:id/plan — propose (or re-propose) a shared goal + task split.
  const propose: RequestHandler<PairingParams> = (req, res) => {
    const { proposedBy, goal, items } = req.body ?? {};
    const plan = store.proposePlan(req.params.id, proposedBy, goal, items);
    res.status(201).json({ plan });
  };

  // POST /pairings/:id/plan/approve — record one human's approval.
  const approve: RequestHandler<PairingParams> = (req, res) => {
    const { agentId } = req.body ?? {};
    const plan = store.approvePlan(req.params.id, agentId);
    res.json({ plan });
  };

  // GET /pairings/:id/plan — current plan + approval status.
  const get: RequestHandler<PairingParams> = (req, res) => {
    const plan = store.getPlan(req.params.id);
    res.json({ plan });
  };

  router.post("/", propose);
  router.post("/approve", approve);
  router.get("/", get);

  return router;
}
