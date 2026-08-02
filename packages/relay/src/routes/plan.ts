import { Router, type RequestHandler } from "express";
import { requireScope } from "../lib/auth.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

export function planRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // POST /pairings/:id/plan — propose (or re-propose) a shared goal + task
  // split. Re-proposing resets both approvals and bumps `version`.
  const propose: RequestHandler<PairingParams> = (req, res) => {
    const { goal, items } = req.body ?? {};
    const plan = store.proposePlan(req.params.id, req.inzoAuth!.agentId, goal, items);
    res.status(201).json({ plan });
  };

  // POST /pairings/:id/plan/approve — record one human's approval of the exact
  // version they read. `planVersion` is required; see store.approvePlan.
  // A v3 caller additionally sends `signature` — their holder key over a hash
  // of the exact plan text. That turns the approval from a row we assert into
  // evidence anyone can check without trusting us (§6.2).
  const approve: RequestHandler<PairingParams> = (req, res) => {
    const { planVersion, signature } = req.body ?? {};
    const auth = req.inzoAuth!;
    const consent =
      signature !== undefined && auth.credential
        ? { payload: auth.credential, assurance: auth.assurance, signature }
        : undefined;
    const result = store.approvePlan(req.params.id, auth.agentId, planVersion, consent);
    const { consent: consentRecord, ...plan } = result as typeof result & { consent?: unknown };
    res.json(consentRecord ? { plan, consent: consentRecord } : { plan });
  };

  // GET /pairings/:id/plan — current plan + approval status.
  const get: RequestHandler<PairingParams> = (req, res) => {
    res.json({ plan: store.getPlan(req.params.id) });
  };

  router.post("/", requireScope("plan:propose"), propose);
  router.post("/approve", requireScope("plan:approve"), approve);
  router.get("/", get);

  return router;
}
