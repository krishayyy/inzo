import { buildAuthHeaders } from "inzo-holder";
import type { SessionDescriptor } from "inzo-protocol";
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

export interface Plan {
  goal: string;
  items: Array<{ owner: string; task: string }>;
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
    /** True when this session can produce a non-repudiable approval. */
    canSignConsent: () => Boolean(session.credential && session.holderPrivateKey),
    usage: (pairingId: string) => call<UsageSnapshot>("GET", `/pairings/${pairingId}/usage`),
    setBudget: (pairingId: string, input: Record<string, unknown>) =>
      call<{ budget: unknown }>("PUT", `/pairings/${pairingId}/budget`, input),
    revoke: (pairingId: string, target: "peer" | "self") =>
      call<{ revocation: { revokedAgentId: string; revokedAt: string; by: string } }>(
        "POST",
        `/pairings/${pairingId}/revoke`,
        { target },
      ),
    session: (pairingId: string) => call<{ session: SessionDescriptor | null }>("GET", `/pairings/${pairingId}/session`),
    setSession: (pairingId: string, session: SessionDescriptor) =>
      call<{ session: SessionDescriptor }>("POST", `/pairings/${pairingId}/session`, { session }),
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
