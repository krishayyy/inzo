import { Router, type RequestHandler } from "express";
import { requireScope } from "../lib/auth.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

export function messagesRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // POST /pairings/:id/messages — send a message to the paired agent.
  const create: RequestHandler<PairingParams> = (req, res) => {
    const { body } = req.body ?? {};
    res.status(201).json({ message: store.addMessage(req.params.id, req.inzoAuth!.agentId, body) });
  };

  // GET /pairings/:id/messages?since=<cursor> — poll the thread for new messages.
  const list: RequestHandler<PairingParams> = (req, res) => {
    const rawSince = typeof req.query.since === "string" ? Number(req.query.since) : undefined;
    const since = rawSince !== undefined && Number.isFinite(rawSince) ? rawSince : undefined;
    const messages = store.getMessages(req.params.id, since);
    const cursor = messages.length > 0 ? messages[messages.length - 1].cursor : (since ?? 0);
    res.json({ messages, cursor });
  };

  router.post("/", requireScope("messages:send"), create);
  router.get("/", requireScope("messages:read"), list);

  return router;
}
