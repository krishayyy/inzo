import { Router, type RequestHandler } from "express";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

export function budgetRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // PUT /pairings/:id/budget — set the shared budget both agents plan against.
  // Every field is optional; an explicit null clears that field, while an
  // absent field leaves it untouched. That distinction matters: "I only want
  // to move the deadline" must not silently wipe the token budget.
  const put: RequestHandler<PairingParams> = (req, res) => {
    const budget = store.setBudget(req.params.id, req.inzoAuth!.agentId, req.body ?? {});
    res.json({ budget });
  };

  const get: RequestHandler<PairingParams> = (req, res) => {
    res.json({ budget: store.getBudget(req.params.id) });
  };

  router.put("/", put);
  router.get("/", get);

  return router;
}
