/**
 * Thin HTTP client for the Inzo relay backend (packages/relay).
 *
 * This is the ONLY module that knows about the relay's HTTP API shape. If the
 * relay's actual field/route names drift from the agreed contract, this file
 * is the single place to fix it.
 */

import { buildAuthHeaders } from "inzo-holder";

/**
 * Defaults to the hosted relay so `inzo-mcp` works out of the box. Set
 * INZO_RELAY_URL to point at a self-hosted relay (e.g. local dev, or your own
 * Fly deployment) instead.
 */
const RELAY_URL = process.env.INZO_RELAY_URL ?? "https://inzo-relay-cf.krishaysuresh1.workers.dev";

/**
 * How a request proves who is making it.
 *
 * `v3` presents a signed credential plus a proof over method, path and body.
 * `bearer` is the v2 path, kept so a session paired before v3 keeps working —
 * it authenticates but cannot sign consent.
 */
export type Auth =
  | { kind: "v3"; credential: string; privateKeyPem: string }
  | { kind: "bearer"; token: string };

function authHeaders(auth: Auth | undefined, method: string, path: string, body: unknown): Record<string, string> {
  if (!auth) return {};
  if (auth.kind === "bearer") return { Authorization: `Bearer ${auth.token}` };
  // The proof covers the path WITHOUT the query string, matching the relay.
  return buildAuthHeaders({
    credential: auth.credential,
    privateKeyPem: auth.privateKeyPem,
    method,
    path,
    body,
  }) as unknown as Record<string, string>;
}

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
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
  auth?: Auth | string,
): Promise<T> {
  const resolved: Auth | undefined =
    typeof auth === "string" ? { kind: "bearer", token: auth } : auth;
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
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(resolved, method, path, body),
      },
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
    throw new RelayError(message, res.status, errObj?.code, data);
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

// ---------- Types (mirrors packages/relay/src/types.ts) ----------

export type Scope =
  | "messages:read"
  | "messages:send"
  | "plan:propose"
  | "plan:approve"
  | "usage:report"
  | "commands:run";

export interface ConsentApproval {
  principal: string;
  credential: string;
  at: string;
  signature: string;
}

export interface ConsentRecord {
  pairingId: string;
  subject: { kind: string; version: number; hash: string };
  required: string[];
  approvals: ConsentApproval[];
  satisfied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  seq: number;
  at: string;
  pairingId: string;
  actor: { principal: string | null; agent: string | null; credential: string | null };
  action: string;
  assurance: "pop" | "bearer";
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
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
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Budget {
  pairingId: string;
  deadline: string | null;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  updatedAt: string;
}

export interface MinePairing {
  id: string;
  agentId: string;
  peerAgentId: string;
  createdAt: string;
  budget: Budget | null;
  scope: Scope[];
  peerScope: Scope[];
  revoked: boolean;
  peerRevoked: boolean;
}

export interface AgentUsage {
  tokensUsed: number;
  costUsd: number;
  wallClockMs: number;
  progressPct: number;
  reportCount: number;
  lastReportedAt: string | null;
}

export interface CombinedUsage {
  pairingId: string;
  byAgent: Record<string, AgentUsage>;
  totals: { tokensUsed: number; costUsd: number; wallClockMs: number };
}

export interface Runway {
  deadline: string | null;
  msRemaining: number | null;
  tokensRemaining: number | null;
  costRemainingUsd: number | null;
  burn: { tokensPerMin: number; costUsdPerMin: number } | null;
  projectedTokenExhaustion: string | null;
  projectedCostExhaustion: string | null;
  onTrack: boolean | null;
  verdict: string;
}

export interface UsageSnapshot {
  usage: CombinedUsage;
  runway: Runway;
}

export interface Revocation {
  revokedAgentId: string;
  revokedAt: string;
  by: string;
}

/** Bounded-size catch-up view of a pairing — see relay's RelayStore.getDigest. */
export interface Digest {
  pairingId: string;
  generatedAt: string;
  plan: Plan | null;
  consent: ConsentRecord | null;
  usage: UsageSnapshot;
  recentMessages: Message[];
}

export interface BudgetInput {
  deadline?: string | null;
  tokenBudget?: number | null;
  costBudgetUsd?: number | null;
}

export interface ReportUsageInput {
  tokensUsed?: number;
  costUsd?: number;
  wallClockMs?: number;
  progressPct?: number;
}

// ---------- Client ----------

export const relayClient = {
  baseUrl: RELAY_URL,

  createPairing(cnf?: { jwk: unknown }): Promise<{
    code: string;
    expiresAt: string;
    agentId: string;
    agentToken: string;
    scope: Scope[];
    pairingId: null;
    principalId: string | null;
    credential: string | null;
  }> {
    return request("POST", "/pairings", cnf ? { cnf } : {});
  },

  joinPairing(code: string, cnf?: { jwk: unknown }): Promise<{
    pairingId: string;
    agentId: string;
    agentToken: string;
    scope: Scope[];
    peerAgentId: string;
    principalId: string | null;
    credential: string | null;
  }> {
    return request("POST", `/pairings/${encodeURIComponent(code)}/join`, cnf ? { cnf } : {});
  },

  getMine(auth: Auth | string): Promise<{ pairing: MinePairing | null }> {
    return request("GET", "/pairings/mine", undefined, undefined, auth);
  },

  narrowScope(auth: Auth | string, scope: Scope[]): Promise<{ scope: Scope[] }> {
    return request("POST", "/pairings/mine/scope", { scope }, undefined, auth);
  },

  revoke(pairingId: string, auth: Auth | string, target: "self" | "peer"): Promise<{ revocation: Revocation }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/revoke`, { target }, undefined, auth);
  },

  sendMessage(pairingId: string, auth: Auth | string, body: string): Promise<{ message: Message }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/messages`, { body }, undefined, auth);
  },

  getMessages(pairingId: string, auth: Auth | string, since?: number): Promise<{ messages: Message[]; cursor: number }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/messages`, undefined, { since }, auth);
  },

  /**
   * A fixed-size catch-up view instead of the full thread: current plan,
   * current consent, usage/runway, and only the last `limit` messages. Use
   * this to reconnect after a gap instead of paging through everything that
   * happened while you were away.
   */
  getDigest(pairingId: string, auth: Auth | string, limit?: number): Promise<Digest> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/digest`, undefined, { limit }, auth);
  },

  proposePlan(pairingId: string, auth: Auth | string, goal: string, items: PlanItem[]): Promise<{ plan: Plan }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/plan`, { goal, items }, undefined, auth);
  },

  /** `signature` turns the approval into evidence rather than an assertion. */
  approvePlan(
    pairingId: string,
    auth: Auth | string,
    planVersion: number,
    signature?: string,
  ): Promise<{ plan: Plan; consent?: ConsentRecord }> {
    return request(
      "POST",
      `/pairings/${encodeURIComponent(pairingId)}/plan/approve`,
      signature ? { planVersion, signature } : { planVersion },
      undefined,
      auth,
    );
  },

  getConsent(pairingId: string, auth: Auth | string): Promise<{ consent: ConsentRecord | null }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/consent`, undefined, undefined, auth);
  },

  withdrawConsent(pairingId: string, auth: Auth | string): Promise<{ consent: ConsentRecord }> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/consent/withdraw`, {}, undefined, auth);
  },

  getAudit(
    pairingId: string,
    auth: Auth | string,
    since?: number,
  ): Promise<{ records: AuditRecord[]; chainValid: boolean; brokenAt: number | null; issuer: string }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/audit`, undefined, { since }, auth);
  },

  /** Mint a narrowed child credential — never a widened one (§2). */
  attenuate(
    auth: Auth,
    cap: Scope[],
    cnf: { jwk: unknown },
    ttl?: number,
  ): Promise<{ credential: string; jti: string; cap: Scope[]; depth: number; expiresAt: string }> {
    return request("POST", "/credentials/attenuate", { cap, cnf, ttl }, undefined, auth);
  },

  getPlan(pairingId: string, auth: Auth | string): Promise<{ plan: Plan | null }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/plan`, undefined, undefined, auth);
  },

  setBudget(pairingId: string, auth: Auth | string, input: BudgetInput): Promise<{ budget: Budget }> {
    return request("PUT", `/pairings/${encodeURIComponent(pairingId)}/budget`, input, undefined, auth);
  },

  getBudget(pairingId: string, auth: Auth | string): Promise<{ budget: Budget | null }> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/budget`, undefined, undefined, auth);
  },

  reportUsage(pairingId: string, auth: Auth | string, input: ReportUsageInput): Promise<UsageSnapshot> {
    return request("POST", `/pairings/${encodeURIComponent(pairingId)}/usage`, input, undefined, auth);
  },

  getUsage(pairingId: string, auth: Auth | string): Promise<UsageSnapshot> {
    return request("GET", `/pairings/${encodeURIComponent(pairingId)}/usage`, undefined, undefined, auth);
  },
};
