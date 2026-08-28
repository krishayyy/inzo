import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { legacySessionFilePath, readCurrentPointer, sessionFilePathFor } from "inzo-holder";

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
  /** The directory this session is scoped to. Absent on legacy sessions. */
  workspace?: string;
  updatedAt: string;
}

/**
 * The project directory the current invocation belongs to.
 *
 * Walks up to the git root so `inzo status` works from a subdirectory the way
 * every other git-aware tool does. Falls back to cwd outside a repo.
 */
export function resolveWorkspace(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/**
 * Where this invocation's session lives.
 *
 * Sessions are keyed by workspace (see `inzo-holder`), so several projects can
 * be paired at once without overwriting each other's holder private key.
 * Resolution order: this workspace, then the most recently written session,
 * then the pre-workspace-keyed global file so an existing pairing survives the
 * upgrade.
 */
export function sessionFilePath(): string {
  const own = sessionFilePathFor(resolveWorkspace());
  if (existsSync(own)) return own;

  const pointer = readCurrentPointer();
  if (pointer) {
    const pointed = sessionFilePathFor(pointer);
    if (existsSync(pointed)) return pointed;
  }

  const legacy = legacySessionFilePath();
  if (existsSync(legacy)) return legacy;

  // Nothing exists yet: name the path this workspace *would* use, so the
  // "no session found" error points somewhere meaningful.
  return own;
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
      `No Inzo session found for ${resolveWorkspace()}. Run "inzo start" here, or "inzo join <code>" with a teammate's code.`,
    );
  }

  let parsed: SessionFile;
  try {
    parsed = JSON.parse(raw) as SessionFile;
  } catch {
    throw new Error(`The session file at ${path} is not valid JSON. Re-pair to rewrite it.`);
  }

  if (!parsed.agentToken || !parsed.relayUrl) {
    throw new Error(`The session file at ${path} is incomplete. Re-pair to rewrite it.`);
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
