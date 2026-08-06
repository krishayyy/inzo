import { Router, type RequestHandler } from "express";
import { requireScope } from "../lib/auth.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

export function digestRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // GET /pairings/:id/digest — a bounded-size catch-up view: current plan,
  // current consent, usage/runway, and only the last `limit` messages. Built
  // for an agent reconnecting after a gap, so catching up costs about the
  // same whether it missed 5 messages or 500 — see RelayStore.getDigest.
  const get: RequestHandler<PairingParams> = (req, res) => {
    const raw = Number(req.query.limit ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;
    res.json(store.getDigest(req.params.id, limit));
  };

  router.get("/", requireScope("messages:read"), get);

  return router;
}
