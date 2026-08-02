import { Router, type RequestHandler } from "express";
import type { RelayStore } from "../lib/store.js";
import { badRequest } from "../lib/errors.js";

type PairingParams = { id: string };

export function usageRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // POST /pairings/:id/usage — an agent self-reports its own usage.
  const report: RequestHandler<PairingParams> = (req, res) => {
    const { tokensUsed, costUsd, wallClockMs, progressPct } = req.body ?? {};
    const usage = store.reportUsage(req.params.id, req.inzoAuth!.agentId, {
      tokensUsed: tokensUsed ?? 0,
      costUsd: costUsd ?? 0,
      wallClockMs: wallClockMs ?? 0,
      progressPct: progressPct ?? 0,
    });
    res.status(201).json({ usage });
  };

  // GET /pairings/:id/usage — combined usage for both sides of the pairing.
  const get: RequestHandler<PairingParams> = (req, res) => {
    const usage = store.getUsage(req.params.id);
    res.json({ usage });
  };

  router.post("/", report);
  router.get("/", get);

  return router;
}
