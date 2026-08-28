import { Router, type RequestHandler } from "express";
import { InvalidSessionDescriptorError, validateContextInput } from "inzo-protocol";
import { badRequest } from "../lib/errors.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

/**
 * The shared context ledger (T-7).
 *
 * `GET ?path=&sha=` returns an entry only on an exact `path@sha` match, so a
 * summary can never outlive the bytes it describes. `POST` publishes one.
 *
 * Requires `messages:read` / `messages:send` rather than scopes of its own: a
 * summary is a message about a file, and giving it a separate axis of
 * authority would imply it carries more weight than it does.
 */
export function contextRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const get: RequestHandler<PairingParams> = (req, res, next) => {
    const { path, sha } = req.query;
    if (typeof path !== "string" || typeof sha !== "string") {
      return next(badRequest("path and sha query parameters are required"));
    }
    const entry = store.getContext(req.params.id, req.inzoAuth!.agentId, path, sha);
    res.json({ context: entry, stats: store.contextStats(req.params.id) });
  };

  const post: RequestHandler<PairingParams> = (req, res, next) => {
    try {
      const input = validateContextInput(req.body?.context);
      res.json({ context: store.putContext(req.params.id, req.inzoAuth!.agentId, input) });
    } catch (err) {
      if (err instanceof InvalidSessionDescriptorError) return next(badRequest(err.message));
      next(err);
    }
  };

  router.get("/", get);
  router.post("/", post);

  return router;
}
