import { Router, type RequestHandler } from "express";
import { relayEvents, type RelayEvent } from "../lib/events.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };

/** Keeps proxies and load balancers from idling out a quiet connection. */
const PING_INTERVAL_MS = 25_000;

/**
 * Server-Sent Events: this is what makes "both humans watch it happen live"
 * real, rather than a polling loop that shows the negotiation a few seconds
 * after it happened.
 *
 * Only events for the token's own pairing are delivered — the subscription is
 * keyed by the pairing derived from the bearer token, never by anything the
 * client asks for.
 */
export function streamRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const stream: RequestHandler<PairingParams> = (req, res) => {
    const pairingId = req.params.id;
    const agentId = req.inzoAuth!.agentId;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx and friends buffer by default, which would defeat the point.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Tell the client the stream is live before anything happens on it, so a
    // viewer can distinguish "connected, nothing yet" from "still connecting".
    send("ready", { pairingId, agentId, at: new Date().toISOString() });

    const onEvent = (event: RelayEvent) => {
      switch (event.type) {
        case "message.created":
          send("message.created", { message: event.message });
          break;
        case "plan.updated":
          send("plan.updated", { plan: event.plan });
          break;
        case "usage.reported":
          // Runway is recomputed at emit time so watchers get the number they
          // would have gotten from GET /usage, not a stale copy.
          send("usage.reported", store.getUsageSnapshot(pairingId));
          break;
        case "budget.updated":
          send("budget.updated", { budget: event.budget });
          break;
        case "pairing.revoked":
          send("pairing.revoked", { revocation: event.revocation });
          // If this viewer is the one being ejected, the stream is part of
          // what gets cut off — closing it here is the same fail-closed
          // behavior the request path applies to a revoked token.
          if (event.revocation.revokedAgentId === agentId) {
            cleanup();
            res.end();
          }
          break;
      }
    };

    const ping = setInterval(() => send("ping", { t: Date.now() }), PING_INTERVAL_MS);
    relayEvents.on(`pairing:${pairingId}`, onEvent);

    function cleanup() {
      clearInterval(ping);
      relayEvents.off(`pairing:${pairingId}`, onEvent);
    }

    req.on("close", cleanup);
    res.on("close", cleanup);
  };

  router.get("/", stream);

  return router;
}
