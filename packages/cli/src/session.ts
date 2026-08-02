import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionFile {
  relayUrl: string;
  pairingId: string | null;
  agentId: string;
  agentToken: string;
  scope?: string[];
  /** v3 signed credential, absent on sessions paired before v3. */
  credential?: string | null;
  /** The private key that makes an approval non-repudiable. Never leaves disk. */
  holderPrivateKey?: string | null;
  principalId?: string | null;
  updatedAt: string;
}

export function sessionFilePath(): string {
  return join(process.env.INZO_HOME ?? homedir(), ".inzo", "session.json");
}

/**
 * The CLI reads its credential from the session file the MCP server wrote,
 * and from nowhere else.
 *
 * In particular it never takes a token as a command-line flag: argv is
 * visible to every other process on the machine via `ps`, so a `--token`
 * option would leak the credential to anyone with a shell on the box.
 */
export function loadSession(): SessionFile {
  const path = sessionFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No Inzo session found at ${path}. Pair from your agent first (create_pairing_code or join_pairing), then run this again.`,
    );
  }

  let parsed: SessionFile;
  try {
    parsed = JSON.parse(raw) as SessionFile;
  } catch {
    throw new Error(`The session file at ${path} is not valid JSON. Re-pair from your agent to rewrite it.`);
  }

  if (!parsed.agentToken || !parsed.relayUrl) {
    throw new Error(`The session file at ${path} is incomplete. Re-pair from your agent to rewrite it.`);
  }
  return parsed;
}

export function requirePairing(session: SessionFile): string {
  if (!session.pairingId) {
    throw new Error(
      "Your agent created a pairing code but nobody has joined it yet. Share the code, then run this again.",
    );
  }
  return session.pairingId;
}
