/**
 * In-memory state for the lifetime of this stdio MCP server process.
 *
 * A stdio MCP server is spawned once per agent session, so a plain module-level
 * object is sufficient to remember which pairing this side is currently in
 * between tool calls — no persistence needed across process restarts.
 */

export interface SessionState {
  pairingId: string | null;
  agentId: string;
  agentToken: string | null;
}

function generateAgentId(): string {
  return `agent_${Math.random().toString(36).slice(2, 10)}`;
}

export const sessionState: SessionState = {
  pairingId: null,
  // A stable-ish identifier for this side of the pairing, used when reporting
  // usage / approvals. Can be overridden via INZO_AGENT_ID for readability.
  agentId: process.env.INZO_AGENT_ID ?? generateAgentId(),
  agentToken: null,
};

export function requirePairingId(): string {
  if (!sessionState.pairingId) {
    throw new Error(
      "No active pairing. Call create_pairing_code or join_pairing first to establish a pairing.",
    );
  }
  return sessionState.pairingId;
}

export function setPairingId(pairingId: string): void {
  sessionState.pairingId = pairingId;
}

export function setIdentity(agentId: string, agentToken: string, pairingId: string | null): void {
  sessionState.agentId = agentId;
  sessionState.agentToken = agentToken;
  sessionState.pairingId = pairingId;
}
