import { EventEmitter } from "node:events";
import type { SessionDescriptor } from "inzo-protocol";
import type { Budget, Message, Plan, UsageReport } from "../types.js";

/**
 * Central event bus for the relay.
 *
 * Every state change is published here in addition to being persisted, and
 * `GET /pairings/:id/stream` subscribes to `pairing:<id>` to push it to both
 * humans. Keeping the bus separate from the store means routes never have to
 * know who is watching, and the store never has to know about HTTP.
 */
export interface Revocation {
  revokedAgentId: string;
  revokedAt: string;
  by: string;
}

export type RelayEvent =
  | { type: "message.created"; pairingId: string; message: Message }
  | { type: "plan.updated"; pairingId: string; plan: Plan }
  | { type: "usage.reported"; pairingId: string; usage: UsageReport }
  | { type: "budget.updated"; pairingId: string; budget: Budget }
  | { type: "pairing.revoked"; pairingId: string; revocation: Revocation }
  | { type: "session.updated"; pairingId: string; session: SessionDescriptor };

class RelayEventBus extends EventEmitter {
  publish(event: RelayEvent): void {
    this.emit(`pairing:${event.pairingId}`, event);
    this.emit("*", event);
  }
}

export const relayEvents = new RelayEventBus();

/**
 * Long-lived SSE connections each add a listener for their own pairing. The
 * default cap of 10 would start printing spurious leak warnings at a handful
 * of concurrent viewers, which is well within normal use.
 */
relayEvents.setMaxListeners(0);
