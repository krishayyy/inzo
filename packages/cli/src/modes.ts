import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Same repo, full trust — vs. separate codebases, scoped trust. */
export type Pairing = "cowork" | "acquaintance";

/**
 * What an acquaintance-mode credential keeps. Everything else is dropped, so
 * the boundary is the credential itself: no `commands:run` means a peer command
 * cannot execute, no `plan:approve` means nothing can be signed on your behalf.
 * An offline verifier can confirm that against the published JWKS.
 */
export const ACQUAINTANCE_CAP = ["messages:read", "messages:send"];

export type GitMode = "manual" | "plan" | "auto-sync" | "auto";

export const GIT_MODES: readonly GitMode[] = ["manual", "plan", "auto-sync", "auto"] as const;

export const GIT_MODE_HINT: Record<GitMode, string> = {
  manual: "you drive git; inzo only shows divergence and collisions",
  plan: "fetch only; PLAN.md is the work surface",
  "auto-sync": "auto fetch+rebase, auto-commit your claims to your own branch",
  auto: "auto-sync, plus push and merge non-colliding peer branches",
};

export interface ShellState {
  pairing: Pairing;
  git: GitMode;
}

const DEFAULT_STATE: ShellState = { pairing: "cowork", git: "manual" };

/**
 * Deliberately not `session.json`: the MCP server rewrites that file wholesale
 * (packages/mcp-server/src/sessionState.ts), so unknown keys there get clobbered.
 */
export function shellStatePath(): string {
  return join(process.env.INZO_HOME ?? homedir(), ".inzo", "shell.json");
}

export function loadShellState(path = shellStatePath()): ShellState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ShellState>;
    return {
      pairing: parsed.pairing === "acquaintance" ? "acquaintance" : "cowork",
      git: GIT_MODES.includes(parsed.git as GitMode) ? (parsed.git as GitMode) : DEFAULT_STATE.git,
    };
  } catch {
    // Missing or corrupt: the shell must still start. Defaults are the safe end
    // of every axis — full trust locally, nothing automatic against git.
    return { ...DEFAULT_STATE };
  }
}

export function saveShellState(state: ShellState, path = shellStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** shift+tab cycling, in the Claude Code idiom. */
export function nextGitMode(current: GitMode): GitMode {
  return GIT_MODES[(GIT_MODES.indexOf(current) + 1) % GIT_MODES.length];
}
