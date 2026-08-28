// Shared domain types — single source of truth stays in packages/relay; this
// package re-exports rather than forking a second copy that can drift.
export * from "../../relay/src/types.js";

/** One member's presence, as served. Never persisted — see PairingRoom. */
export interface PresenceEntry {
  agentId: string;
  branch: string;
  head: string;
  dirty: string[];
  ahead: number;
  behind: number;
  conflicted: boolean;
  /** When this snapshot was posted; drives the 90-second TTL. */
  at: string;
}
