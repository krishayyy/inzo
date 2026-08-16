import { useEffect, useState } from "react";
import type { Api, Message, Plan, Runway } from "../api.js";
import { subscribe } from "../sse.js";

export interface StreamHandlers {
  onMessage: (message: Message) => void;
  onPlan: (plan: Plan | null) => void;
  onRunway: (runway: Runway) => void;
  onRevoked: (revocation: { revokedAgentId: string; by: string }) => void;
  onNote: (text: string) => void;
}

/**
 * Live thread subscription with backfill and reconnect.
 *
 * Wraps `subscribe()` rather than replacing it. On every (re)connect it first
 * replays the messages after the last cursor it saw, so a dropped connection
 * costs you nothing — the same reason `watch` backfills before streaming.
 */
export function useStream(api: Api, pairingId: string, handlers: StreamHandlers): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    let stopped = false;

    const backfill = async () => {
      const { messages } = await api.messages(pairingId, cursor || undefined);
      for (const message of messages) {
        cursor = Math.max(cursor, message.cursor);
        handlers.onMessage(message);
      }
    };

    const loop = async () => {
      let delay = 500;
      while (!stopped) {
        try {
          await backfill();
          const { plan } = await api.plan(pairingId);
          handlers.onPlan(plan);
          setConnected(true);
          delay = 500;

          for await (const event of subscribe(api.streamUrl(pairingId), controller.signal)) {
            switch (event.event) {
              case "message.created": {
                const message = (event.data as { message: Message }).message;
                cursor = Math.max(cursor, message.cursor);
                handlers.onMessage(message);
                break;
              }
              case "plan.updated":
                handlers.onPlan((event.data as { plan: Plan | null }).plan);
                break;
              case "usage.reported":
                handlers.onRunway((event.data as { runway: Runway }).runway);
                break;
              case "budget.updated":
                handlers.onNote("Budget updated.");
                break;
              case "pairing.revoked":
                handlers.onRevoked((event.data as { revocation: { revokedAgentId: string; by: string } }).revocation);
                stopped = true;
                break;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          handlers.onNote(`stream: ${(err as Error).message}`);
        }
        if (stopped) break;
        setConnected(false);
        // Capped backoff: a relay restart should not turn into a retry storm.
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    };

    void loop();
    return () => {
      stopped = true;
      controller.abort();
    };
    // Handlers are captured once on purpose: they are stable refs from the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pairingId]);

  return { connected };
}
