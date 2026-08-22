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
  "memory:read",
  "memory:write",
  "usage:share",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export interface PairingCode {
  code: string;
  creatorAgentId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
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

/**
 * What one agent has declared about itself: which model is behind it and
 * what it's good at. Self-reported, not verified — the point is giving
 * both sides (and the humans watching) the facts to reason about who
 * should take which task, not an enforced capability grant. Contrast
 * `Scope`, which IS enforced.
 */
export interface AgentProfile {
  pairingId: string;
  agentId: string;
  model: string | null;
  strengths: string[];
  updatedAt: string;
}

export type TaskStatus = "proposed" | "assigned" | "in_progress" | "blocked" | "done";

/**
 * One unit of shared work — the thing `PlanItem` doesn't quite give you: a
 * plan item is a line of prose inside one signed document, replaced wholesale
 * on every re-propose. A task is its own addressable record with a lifecycle,
 * so "who owns this, why, and what changed" survives independently of
 * whatever the plan text currently says.
 *
 * Assignment is not gated behind plan-style unanimous consent — that gate
 * exists for *committing to run* the sandboxed work, which tasks don't do by
 * themselves. What a task DOES get is the same thing every other
 * authorization-relevant action gets: an append-only, attributed audit
 * record, so "why was this reassigned" is answerable later without asking.
 */
export interface Task {
  id: string;
  pairingId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignedTo: string | null;
  proposedBy: string;
  /** Free-text reasoning for the current assignment — "opus, strong at architecture, more budget left". */
  rationale: string | null;
  /** Ids of other tasks in this pairing that must be `done` first. Existence-checked, not cycle-checked beyond that. */
  dependsOn: string[];
  createdAt: string;
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

/**
 * A durable fact on the shared memory layer.
 *
 * The distinction from `Message` is the whole point: a message is a moment in
 * a transcript, read by scrolling. A memory is a standing fact, retrieved by
 * relevance and re-injected into an agent's context on its next turn — which
 * is what lets two agents behave like one mind rather than two readers of the
 * same log.
 */
export interface Memory {
  id: string;
  pairingId: string;
  /** Who wrote it. Memory is attributed; "the team knows X" is never anonymous. */
  authorAgentId: string;
  /**
   * `instruction` entries are standing orders and are ALWAYS returned by
   * recall, never ranked away — a team instruction that only surfaces when a
   * query happens to match it is not an instruction. `fact` entries are
   * ranked and returned top-k.
   */
  kind: MemoryKind;
  /**
   * Stable slug. Writing the same key again REPLACES the entry rather than
   * appending a second one, so memory converges on a current view of the
   * world instead of accumulating contradictory copies.
   */
  key: string;
  body: string;
  tags: string[];
  /**
   * `team` is readable by every member; `private` is readable only by its
   * author. Row-level visibility on top of the `memory:read` capability:
   * scope decides whether you may read memory at all, visibility decides
   * which rows — so sharing a mind never means surrendering everything.
   */
  visibility: MemoryVisibility;
  createdAt: string;
  updatedAt: string;
}

export type MemoryKind = "fact" | "instruction";
export type MemoryVisibility = "team" | "private";

/** A memory plus why `recall` returned it — surfaced so an agent (or a human
 *  reading the audit trail) can tell a keyword hit from a standing order. */
export interface RecalledMemory extends Memory {
  score: number;
  reason: "instruction" | "match";
}
