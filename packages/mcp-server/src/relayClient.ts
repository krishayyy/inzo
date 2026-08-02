/**
 * Thin HTTP client for the Inzo relay backend (packages/relay).
 *
 * This is the ONLY module that knows about the relay's HTTP API shape. If the
 * relay's actual field/route names drift from the agreed contract, this file
 * is the single place to fix it.
 */

const RELAY_URL = process.env.INZO_RELAY_URL ?? "http://localhost:8787";

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  let url = `${RELAY_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new RelayError(
      `Failed to reach Inzo relay at ${RELAY_URL} (${(err as Error).message}). Is the relay running?`,
    );
  }

  const text = await res.text();
  const data = text ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    const errObj =
      data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? (data as { error?: { code?: string; message?: string } }).error
        : undefined;
    const message = errObj?.message ?? `Relay request failed: ${method} ${path} -> ${res.status}`;
    throw new RelayError(message, res.status, data);
  }

  return data as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- Types (mirrors packages/relay/src/types.ts exactly) ----------

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

export interface ReportUsageInput {
  agentId: string;
  tokensUsed?: number;
  costUsd?: number;
  wallClockMs?: number;
  progressPct?: number;
}

// ---------- Client ----------

export const relayClient = {
  baseUrl: RELAY_URL,

  createPairing(agentId: string): Promise<{ pairingCode: PairingCode }> {
    return request("POST", "/pairings", { agentId });
  },

  joinPairing(code: string, agentId: string): Promise<{ pairing: Pairing }> {
    return request("POST", `/pairings/${encodeURIComponent(code)}/join`, { agentId });
  },

  getPairing(pairingId: string): Promise<{ pairing: Pairing }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}`);
  },

  getPairingByCode(code: string): Promise<{ pairing: Pairing | null }> {
    return request("GET", `/pairings/by-code/${encodeURIComponent(code)}`);
  },

  sendMessage(pairingId: string, fromAgentId: string, body: string): Promise<{ message: Message }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/messages`, {
      fromAgentId,
      body,
    });
  },

  getMessages(pairingId: string, since?: number): Promise<{ messages: Message[]; cursor: number }> {
    return request(
      "GET",
      `/pairings/${encodeURIComponent(pairingId)}/messages`,
      undefined,
      { since },
    );
  },

  proposePlan(
    pairingId: string,
    proposedBy: string,
    goal: string,
    items: PlanItem[],
  ): Promise<{ plan: Plan }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/plan`, {
      proposedBy,
      goal,
      items,
    });
  },

  approvePlan(pairingId: string, agentId: string): Promise<{ plan: Plan }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/plan/approve`, { agentId });
  },

  getPlan(pairingId: string): Promise<{ plan: Plan | null }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/plan`);
  },

  reportUsage(pairingId: string, input: ReportUsageInput): Promise<{ usage: UsageReport }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/usage`, input);
  },

  getUsage(pairingId: string): Promise<{ usage: CombinedUsage }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/usage`);
  },
};
