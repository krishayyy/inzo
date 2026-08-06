import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * State for this stdio MCP server process, mirrored to `~/.inzo/session.json`.
 *
 * The file exists so `inzo` can attach to the same pairing the agent is
 * in without re-pairing. It holds a live credential, so it is written 0600 in
 * a 0700 directory and must never be logged or echoed back in a tool result.
 */

export type Scope =
  | "messages:read"
  | "messages:send"
  | "plan:propose"
  | "plan:approve"
  | "usage:report"
  | "commands:run";

export interface SessionState {
  pairingId: string | null;
  agentId: string;
  agentToken: string | null;
  scope: Scope[];
  /** v3: the signed credential presented as `Authorization: Inzo <jws>`. */
  credential: string | null;
  /**
   * v3: the private half of the key the credential is bound to.
   *
   * This is the most sensitive value in the system — it is what makes a
   * consent signature non-repudiable. It is written 0600, never transmitted,
   * never logged, and never returned in a tool result.
   */
  holderPrivateKey: string | null;
  principalId: string | null;
}

export interface SessionFile {
  relayUrl: string;
  pairingId: string | null;
  agentId: string;
  agentToken: string;
  scope: Scope[];
  credential?: string | null;
  holderPrivateKey?: string | null;
  principalId?: string | null;
  updatedAt: string;
}

/** `INZO_HOME` exists so tests never touch the real home directory. */
export function sessionFilePath(): string {
  return join(process.env.INZO_HOME ?? homedir(), ".inzo", "session.json");
}

function generateAgentId(): string {
  return `agent_${Math.random().toString(36).slice(2, 10)}`;
}

export const sessionState: SessionState = {
  pairingId: null,
  agentId: process.env.INZO_AGENT_ID ?? generateAgentId(),
  agentToken: null,
  scope: [],
  credential: null,
  holderPrivateKey: null,
  principalId: null,
};

export function requirePairingId(): string {
  if (!sessionState.pairingId) {
    throw new Error(
      "No active pairing. Call create_pairing_code or join_pairing first to establish a pairing.",
    );
  }
  return sessionState.pairingId;
}

export function requireToken(): string {
  if (!sessionState.agentToken) {
    throw new Error("No agent credential is available. Pair this agent first.");
  }
  return sessionState.agentToken;
}

export function setIdentity(
  agentId: string,
  agentToken: string,
  pairingId: string | null,
  scope: Scope[] = sessionState.scope,
  v3?: { credential: string | null; holderPrivateKey: string | null; principalId: string | null },
): void {
  sessionState.agentId = agentId;
  sessionState.agentToken = agentToken;
  sessionState.pairingId = pairingId;
  sessionState.scope = scope;
  if (v3) {
    sessionState.credential = v3.credential;
    sessionState.holderPrivateKey = v3.holderPrivateKey;
    sessionState.principalId = v3.principalId;
  }
  writeSessionFile();
}

/** Replaces the credential after attenuation or re-issue, keeping the key. */
export function setCredential(credential: string): void {
  sessionState.credential = credential;
  writeSessionFile();
}

export function requireHolderKey(): { credential: string; privateKeyPem: string } {
  if (!sessionState.credential || !sessionState.holderPrivateKey) {
    throw new Error(
      "This session has no v3 credential. Re-pair to get one — a v2 bearer token cannot sign a plan approval.",
    );
  }
  return { credential: sessionState.credential, privateKeyPem: sessionState.holderPrivateKey };
}

export function setScope(scope: Scope[]): void {
  sessionState.scope = scope;
  if (sessionState.agentToken) writeSessionFile();
}

export function setPairingId(pairingId: string): void {
  sessionState.pairingId = pairingId;
  if (sessionState.agentToken) writeSessionFile();
}

/**
 * Best-effort: a session file that cannot be written should degrade the CLI
 * viewer, not break the agent's pairing. Failures are swallowed deliberately —
 * but never with the token in the error path.
 */
export function writeSessionFile(relayUrl = process.env.INZO_RELAY_URL ?? "https://inzo-relay-cf.krishaysuresh1.workers.dev"): boolean {
  if (!sessionState.agentToken) return false;
  const target = sessionFilePath();
  const payload: SessionFile = {
    relayUrl,
    pairingId: sessionState.pairingId,
    agentId: sessionState.agentId,
    agentToken: sessionState.agentToken,
    scope: sessionState.scope,
    credential: sessionState.credential,
    holderPrivateKey: sessionState.holderPrivateKey,
    principalId: sessionState.principalId,
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's mode only applies on create; enforce it on rewrite too.
    chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function readSessionFile(): SessionFile | null {
  try {
    return JSON.parse(readFileSync(sessionFilePath(), "utf8")) as SessionFile;
  } catch {
    return null;
  }
}
