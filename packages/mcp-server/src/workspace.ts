import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Resolves the directory a sandboxed command is allowed to touch.
 *
 * The working directory is chosen by the LOCAL human via `INZO_WORKSPACE` and
 * never by the peer, never inferred from the command, and never defaulted.
 * A default here would be the whole ballgame: the sandbox only protects what
 * it does not mount, so silently falling back to `$HOME` would hand a peer's
 * agent read-write access to everything the user owns.
 */
export function resolveWorkspace(raw = process.env.INZO_WORKSPACE): string {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "INZO_WORKSPACE is not set. Set it to the absolute path of the directory you are willing " +
        "to let a paired agent's commands touch. There is deliberately no default.",
    );
  }

  const workspace = resolve(raw);
  const home = resolve(homedir());

  if (workspace === sep || workspace === home) {
    throw new Error(
      `INZO_WORKSPACE must be a specific project directory, not ${workspace === sep ? "the filesystem root" : "your home directory"}.`,
    );
  }
  if (home.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)) {
    throw new Error(`INZO_WORKSPACE "${workspace}" contains your home directory; choose a narrower path.`);
  }

  let stats;
  try {
    stats = statSync(workspace);
  } catch {
    throw new Error(`INZO_WORKSPACE "${workspace}" does not exist.`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`INZO_WORKSPACE "${workspace}" is not a directory.`);
  }

  return workspace;
}
