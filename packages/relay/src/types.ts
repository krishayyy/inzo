/** Shared domain types for the relay service. */

import type { SessionDescriptor } from "inzo-protocol";

/**
 * Capabilities a token may carry. A token's scope is fixed at issue time to
 * ALL_SCOPES and can only ever be narrowed (never widened) afterwards — see
 * `RelayStore.narrowScope`.
 */
export const ALL_SCOPES = [
  "messages:read",
  "messages:send",
  "plan:propose",
  "plan:approve",
  "usage:report",
  "commands:run",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export interface PairingCode {
  code: string;
  creatorAgentId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  /** Session descriptor carried by this code, copied onto the pairing on join. */
  session: SessionDescriptor | null;
}

export type ApprovalPolicy = "unanimous";

export interface Pairing {
  id: string;
  code: string;
  /** Kept for back-compat: the creator (bootstrap join) and first joiner. */
  agentA: string;
  agentB: string;
  /** Full membership, length >= 2. The source of truth for N-party pairings. */
  members: string[];
  /** Only "unanimous" is read today; the column exists so a quorum policy can
   *  be added later without a second migration. */
  approvalPolicy: ApprovalPolicy;
  createdAt: string;
  /** Mode + repo for this session. Null until one is set. */
  session: SessionDescriptor | null;
}

/** What a bearer token resolves to server-side. Never built from a request body. */
export interface TokenIdentity {
  agentId: string;
  pairingId: string | null;
  scope: Scope[];
  revokedAt: string | null;
}

export interface Message {
  id: string;
  pairingId: string;
  fromAgentId: string;
  body: string;
  createdAt: string;
  /**
   * Monotonically increasing cursor for polling (`GET .../messages?since=`).
   * Not the same as `createdAt` — two messages can share a millisecond
   * timestamp, but never a cursor.
   */
  cursor: number;
}

export interface PlanItem {
  owner: string;
  task: string;
  /**
   * Indices into this same `items` array that must be `done` before this
   * item may move past `pending`. Each entry must be a lower index than the
   * item's own position — that alone makes a dependency cycle syntactically
   * impossible, no graph traversal required to reject one.
   */
  dependsOn?: number[];
}

export type ItemStatus = "pending" | "in_progress" | "done";

export interface Plan {
  pairingId: string;
  goal: string;
  items: PlanItem[];
  proposedBy: string;
  approvedBy: string[];
  locked: boolean;
  /**
   * Incremented on every propose. `POST /plan/approve` must echo the version
   * the human actually saw, so an approval can never silently carry over onto
   * text that was swapped in underneath it.
   */
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * The AgentRun sandbox embodying this plan's pending-approval wait
   * (§ packages/relay/src/lib/agentrun.ts). `null` until AgentRun has been
   * contacted; `sandboxState` tracks stopped -> disposed as approvals land.
   */
  sandboxId: string | null;
  sandboxState: "stopped" | "disposed" | "simulated" | null;
}

/** `Plan`, plus each item's live progress. Progress is intentionally not
 *  part of `Plan` itself: it is never part of the signed consent subject
 *  (`planSubjectHash`), so marking an item done can never invalidate an
 *  already-signed approval the way editing the goal or items would. */
export interface PlanWithStatus extends Omit<Plan, "items"> {
  items: (PlanItem & { status: ItemStatus })[];
}

/** The shared budget both agents plan against. Any field may be unset. */
export interface Budget {
  pairingId: string;
  deadline: string | null;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  updatedAt: string;
}

export interface UsageReport {
  id: string;
  pairingId: string;
  agentId: string;
  tokensUsed: number;
  costUsd: number;
  wallClockMs: number;
  progressPct: number;
  createdAt: string;
}

export interface AgentUsage {
  /** Cumulative total from this agent's most recent report, not a sum of reports. */
  tokensUsed: number;
  costUsd: number;
  wallClockMs: number;
  /** Latest self-reported progress percentage (0-100) from that agent. */
  progressPct: number;
  reportCount: number;
  lastReportedAt: string | null;
}

export interface CombinedUsage {
  pairingId: string;
  byAgent: Record<string, AgentUsage>;
  totals: {
    tokensUsed: number;
    costUsd: number;
    wallClockMs: number;
  };
}

/**
 * How much room is left, and whether the plan being negotiated is actually
 * finishable. Every field derived from an unset budget is `null` — the relay
 * never guesses a budget.
 */
export interface Runway {
  deadline: string | null;
  msRemaining: number | null;
  tokensRemaining: number | null;
  costRemainingUsd: number | null;
  burn: { tokensPerMin: number; costUsdPerMin: number } | null;
  projectedTokenExhaustion: string | null;
  projectedCostExhaustion: string | null;
  /** `null` when there is no deadline to be on track for. */
  onTrack: boolean | null;
  /** One short advisory sentence. Never a guarantee. */
  verdict: string;
}

export interface UsageSnapshot {
  usage: CombinedUsage;
  runway: Runway;
}

/** One member's presence, as served. Never persisted — see RelayStore. */
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
