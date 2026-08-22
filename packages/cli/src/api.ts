import { buildAuthHeaders, publicJwkFromPem } from "inzo-holder";
import type { SessionFile } from "./session.js";

export interface ConsentRecord {
  pairingId: string;
  subject: { kind: string; version: number; hash: string };
  required: string[];
  approvals: Array<{ principal: string; credential: string; at: string; signature: string }>;
  satisfied: boolean;
}

export interface AuditRecord {
  seq: number;
  at: string;
  action: string;
  assurance: "pop" | "bearer";
  actor: { principal: string | null; agent: string | null };
  detail: Record<string, unknown>;
}

export interface Message {
  id: string;
  fromAgentId: string;
  body: string;
  createdAt: string;
  cursor: number;
}

export type ItemStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  owner: string;
  task: string;
  /** Indices of earlier items that must be `done` first. */
  dependsOn?: number[];
  /** Present only on relays that track per-item progress. */
  status?: ItemStatus;
}

export interface Plan {
  goal: string;
  items: PlanItem[];
  proposedBy: string;
  approvedBy: string[];
  locked: boolean;
  version: number;
  updatedAt: string;
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
  usage: {
    byAgent: Record<string, { tokensUsed: number; costUsd: number; progressPct: number }>;
    totals: { tokensUsed: number; costUsd: number; wallClockMs: number };
  };
  runway: Runway;
}

/** Self-declared, not enforced — a teammate's stated model and strengths. */
export interface AgentProfile {
  agentId: string;
  model: string | null;
  strengths: string[];
  updatedAt: string;
}

export type MemoryKind = "fact" | "instruction";
export type MemoryVisibility = "team" | "private";

export interface Memory {
  id: string;
  authorAgentId: string;
  kind: MemoryKind;
  key: string;
  body: string;
  tags: string[];
  visibility: MemoryVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface RecalledMemory extends Memory {
  score: number;
  reason: "instruction" | "match";
}

export interface TeamMember {
  agentId: string;
  isSelf: boolean;
  model: string | null;
  strengths: string[];
  revoked: boolean;
  /** False when that member's own credential dropped `usage:share`. */
  sharesUsage: boolean;
  usage: { tokensUsed: number; costUsd: number; wallClockMs: number } | null;
}

export interface TeamView {
  pairingId: string;
  members: TeamMember[];
  totals: { tokensUsed: number; costUsd: number; wallClockMs: number };
  runway: Runway;
}

export interface OwnerSuggestion {
  suggested: string;
  rationale: string;
  candidates: { agentId: string; model: string | null; strengthHits: number; tokensUsed: number; score: number }[];
}

export type TaskStatus = "proposed" | "assigned" | "in_progress" | "blocked" | "done";

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignedTo: string | null;
  proposedBy: string;
  rationale: string | null;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MinePairing {
  id: string;
  agentId: string;
  peerAgentId: string;
  budget: { deadline: string | null; tokenBudget: number | null; costBudgetUsd: number | null } | null;
  scope: string[];
  peerScope: string[];
  revoked: boolean;
  peerRevoked: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createApi(session: SessionFile) {
  /**
   * v3 when the session carries a credential and holder key, v2 otherwise.
   *
   * A session written before v3 still works read-only; it simply cannot sign
   * an approval, and `approve` says so rather than silently degrading.
   */
  function headersFor(method: string, path: string, body: unknown): Record<string, string> {
    if (session.credential && session.holderPrivateKey) {
      return buildAuthHeaders({
        credential: session.credential,
        privateKeyPem: session.holderPrivateKey,
        method,
        // The proof covers the path only — the relay strips the query string.
        path: path.split("?")[0],
        body,
      }) as unknown as Record<string, string>;
    }
    return { Authorization: `Bearer ${session.agentToken}` };
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${session.relayUrl}${path}`, {
        method,
        headers: {
          ...headersFor(method, path, body),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(`Cannot reach the relay at ${session.relayUrl} (${(err as Error).message}).`, 0);
    }

    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(error?.message ?? `${method} ${path} failed (${res.status})`, res.status, error?.code);
    }
    return data as T;
  }

  return {
    mine: () => call<{ pairing: MinePairing | null }>("GET", "/pairings/mine"),
    messages: (pairingId: string, since?: number) =>
      call<{ messages: Message[]; cursor: number }>(
        "GET",
        `/pairings/${pairingId}/messages${since ? `?since=${since}` : ""}`,
      ),
    plan: (pairingId: string) => call<{ plan: Plan | null }>("GET", `/pairings/${pairingId}/plan`),
    approve: (pairingId: string, planVersion: number, signature?: string) =>
      call<{ plan: Plan; consent?: ConsentRecord }>(
        "POST",
        `/pairings/${pairingId}/plan/approve`,
        signature ? { planVersion, signature } : { planVersion },
      ),
    consent: (pairingId: string) => call<{ consent: ConsentRecord | null }>("GET", `/pairings/${pairingId}/consent`),
    withdrawConsent: (pairingId: string) =>
      call<{ consent: ConsentRecord }>("POST", `/pairings/${pairingId}/consent/withdraw`, {}),
    audit: (pairingId: string, since?: number) =>
      call<{ records: AuditRecord[]; chainValid: boolean; brokenAt: number | null; issuer: string }>(
        "GET",
        `/pairings/${pairingId}/audit${since ? `?since=${since}` : ""}`,
      ),
    sendMessage: (pairingId: string, body: string) =>
      call<{ message: Message }>("POST", `/pairings/${pairingId}/messages`, { body }),
    proposePlan: (pairingId: string, goal: string, items: PlanItem[]) =>
      call<{ plan: Plan }>("POST", `/pairings/${pairingId}/plan`, { goal, items }),
    /** Bounded catch-up: costs the same whether you missed 5 messages or 500. */
    digest: (pairingId: string, limit = 20) =>
      call<{ plan: Plan | null; messages: Message[]; runway?: Runway }>(
        "GET",
        `/pairings/${pairingId}/digest?limit=${limit}`,
      ),
    updateItemStatus: (pairingId: string, itemIndex: number, status: ItemStatus) =>
      call<{ plan: Plan }>("POST", `/pairings/${pairingId}/plan/items/${itemIndex}/status`, { status }),
    /**
     * Mints a *child* credential holding a subset of this one's capabilities.
     *
     * Deliberately not `POST /pairings/mine/scope`: scope narrowing is permanent
     * and one-way, so it could never return to cowork. The parent stays in
     * session.json, which is what makes acquaintance mode reversible.
     */
    attenuate: (cap: string[], ttlSeconds?: number) => {
      if (!session.holderPrivateKey) {
        throw new ApiError("This session has no holder key, so it cannot attenuate its credential.", 0);
      }
      return call<{ credential: string; jti: string; cap: string[]; depth: number; expiresAt: string }>(
        "POST",
        "/credentials/attenuate",
        // Same holder key as the parent: the child is still bound to this
        // machine, and one key keeps proof-of-possession working unchanged.
        { cap, cnf: { jwk: publicJwkFromPem(session.holderPrivateKey) }, ...(ttlSeconds ? { ttl: ttlSeconds } : {}) },
      );
    },
    /** True when this session can produce a non-repudiable approval. */
    canSignConsent: () => Boolean(session.credential && session.holderPrivateKey),
    usage: (pairingId: string) => call<UsageSnapshot>("GET", `/pairings/${pairingId}/usage`),
    setBudget: (pairingId: string, input: Record<string, unknown>) =>
      call<{ budget: unknown }>("PUT", `/pairings/${pairingId}/budget`, input),
    listMemories: (pairingId: string) => call<{ memories: Memory[] }>("GET", `/pairings/${pairingId}/memory`),
    recall: (pairingId: string, query?: string, limit?: number) => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      return call<{ memories: RecalledMemory[] }>(
        "GET",
        `/pairings/${pairingId}/memory/recall${qs ? `?${qs}` : ""}`,
      );
    },
    remember: (pairingId: string, input: Record<string, unknown>) =>
      call<{ memory: Memory }>("POST", `/pairings/${pairingId}/memory`, input),
    forget: (pairingId: string, key: string) =>
      call<{ key: string; forgotten: boolean }>("DELETE", `/pairings/${pairingId}/memory/${encodeURIComponent(key)}`),
    getTeam: (pairingId: string) => call<TeamView>("GET", `/pairings/${pairingId}/team`),
    suggestOwner: (pairingId: string, input: Record<string, unknown>) =>
      call<OwnerSuggestion>("POST", `/pairings/${pairingId}/delegate`, input),
    getProfiles: (pairingId: string) => call<{ profiles: AgentProfile[] }>("GET", `/pairings/${pairingId}/profile`),
    getTasks: (pairingId: string) => call<{ tasks: Task[] }>("GET", `/pairings/${pairingId}/tasks`),
    proposeTask: (pairingId: string, input: Record<string, unknown>) =>
      call<{ task: Task }>("POST", `/pairings/${pairingId}/tasks`, input),
    assignTask: (pairingId: string, taskId: string, input: Record<string, unknown>) =>
      call<{ task: Task }>("PUT", `/pairings/${pairingId}/tasks/${taskId}/assign`, input),
    updateTaskStatus: (pairingId: string, taskId: string, status: TaskStatus) =>
      call<{ task: Task }>("PUT", `/pairings/${pairingId}/tasks/${taskId}/status`, { status }),
    revoke: (pairingId: string, target: "peer" | "self") =>
      call<{ revocation: { revokedAgentId: string; revokedAt: string; by: string } }>(
        "POST",
        `/pairings/${pairingId}/revoke`,
        { target },
      ),
    /** Mints a fresh one-shot code inviting a 3rd+ member into this pairing. */
    invite: (pairingId: string) => call<{ code: string; expiresAt: string }>("POST", `/pairings/${pairingId}/invite`, {}),
    streamUrl: (pairingId: string) => {
      const path = `/pairings/${pairingId}/stream`;
      if (session.credential && session.holderPrivateKey) {
        // EventSource cannot set headers, so the proof rides in the query.
        // The relay must not log query strings on this route, and it applies a
        // tighter 60-second proof window here for the same reason.
        const h = buildAuthHeaders({
          credential: session.credential,
          privateKeyPem: session.holderPrivateKey,
          method: "GET",
          path,
        });
        const q = new URLSearchParams({
          credential: session.credential,
          proof: h["Inzo-Proof"],
          proofAt: h["Inzo-Proof-At"],
          proofNonce: h["Inzo-Proof-Nonce"],
        });
        return `${session.relayUrl}${path}?${q.toString()}`;
      }
      return `${session.relayUrl}${path}?token=${encodeURIComponent(session.agentToken)}`;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
