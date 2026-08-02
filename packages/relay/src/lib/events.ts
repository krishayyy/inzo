import { EventEmitter } from "node:events";
import type { Message, Plan, UsageReport } from "../types.js";

/**
 * Central event bus for the relay.
 *
 * Every state change (new message, plan update, usage report) is emitted
 * here in addition to being persisted. Nothing subscribes to it in v1 —
 * clients poll the GET endpoints — but a future WebSocket/SSE layer can
 * subscribe to `pairing:<id>` events without touching the store or routes.
 */
export type RelayEvent =
  | { type: "message.created"; pairingId: string; message: Message }
  | { type: "plan.updated"; pairingId: string; plan: Plan }
  | { type: "usage.reported"; pairingId: string; usage: UsageReport };

class RelayEventBus extends EventEmitter {
  publish(event: RelayEvent): void {
    this.emit(`pairing:${event.pairingId}`, event);
    this.emit("*", event);
  }
}

export const relayEvents = new RelayEventBus();
