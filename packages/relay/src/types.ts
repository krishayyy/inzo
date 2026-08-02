/** Shared domain types for the relay service. */

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

export interface CombinedUsage {
  pairingId: string;
  byAgent: Record<
    string,
    {
      tokensUsed: number;
      costUsd: number;
      wallClockMs: number;
      /** Latest self-reported progress percentage (0-100) from that agent. */
      progressPct: number;
      reportCount: number;
      lastReportedAt: string | null;
    }
  >;
  totals: {
    tokensUsed: number;
    costUsd: number;
    wallClockMs: number;
  };
}
