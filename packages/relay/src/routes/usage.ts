import { Router, type RequestHandler } from "express";
import { requireScope } from "../lib/auth.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

export function usageRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // POST /pairings/:id/usage — an agent self-reports its own usage.
  //
  // Values are CUMULATIVE totals for this agent, not deltas, which is what
  // makes a dropped or duplicated report harmless.
  const report: RequestHandler<PairingParams> = (req, res) => {
    const { tokensUsed, costUsd, wallClockMs, progressPct } = req.body ?? {};
    store.reportUsage(req.params.id, req.inzoAuth!.agentId, {
      tokensUsed: tokensUsed ?? 0,
      costUsd: costUsd ?? 0,
      wallClockMs: wallClockMs ?? 0,
      progressPct: progressPct ?? 0,
    });
    res.status(201).json(store.getUsageSnapshot(req.params.id));
  };

  // GET /pairings/:id/usage — combined usage plus the derived runway.
  const get: RequestHandler<PairingParams> = (req, res) => {
    res.json(store.getUsageSnapshot(req.params.id));
  };

  router.post("/", requireScope("usage:report"), report);
  router.get("/", get);

  return router;
}
