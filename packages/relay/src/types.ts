/** Shared domain types for the relay service. */

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
}

export interface Pairing {
  id: string;
  code: string;
  agentA: string;
  agentB: string;
  createdAt: string;
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
}

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
