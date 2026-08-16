import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The git engine.
 *
 * `execFile` rather than a git library: the workspace has no runtime deps
 * outside itself and this needs about eight verbs. Git stays local to each
 * machine — inzo only shares *coordination* ("I pushed abc123 to inzo/kri
 * touching these files"), which is why it works with any remote and any host.
 *
 * Nothing here throws on an expected non-zero exit (conflict, nothing to
 * commit, detached head). Those are states the UI renders, not crashes.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  sha: string | null;
  ahead: number;
  behind: number;
  /** Paths with any uncommitted change, staged or not. */
  dirty: string[];
  rebaseInProgress: boolean;
  mergeInProgress: boolean;
}

export const PROTECTED_BRANCHES = ["main", "master"];

export class Git {
  constructor(private readonly cwd: string = process.cwd()) {}

  async run(...args: string[]): Promise<RunResult> {
    try {
      const { stdout, stderr } = await exec("git", args, { cwd: this.cwd, maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
    }
  }

  async status(): Promise<GitStatus> {
    const porcelain = await this.run("status", "--porcelain=v1", "--branch");
    if (porcelain.code !== 0) {
      return { repo: false, branch: null, sha: null, ahead: 0, behind: 0, dirty: [], rebaseInProgress: false, mergeInProgress: false };
    }

    const lines = porcelain.stdout.split("\n").filter(Boolean);
    const header = lines.find((line) => line.startsWith("##")) ?? "";
    const dirty = lines
      .filter((line) => !line.startsWith("##"))
      .map((line) => line.slice(3).trim())
      // Renames read "old -> new"; the new path is the one that matters.
      .map((path) => (path.includes(" -> ") ? path.slice(path.indexOf(" -> ") + 4) : path))
      .map((path) => path.replace(/^"|"$/g, ""));

    const branchMatch = header.match(/^## (?:No commits yet on )?([^.\s]+)/);
    const branch = header.includes("no branch") ? null : (branchMatch?.[1] ?? null);
    const gitDir = await this.gitDir();

    return {
      repo: true,
      branch,
      sha: await this.revParse("HEAD"),
      ahead: Number(header.match(/ahead (\d+)/)?.[1] ?? 0),
      behind: Number(header.match(/behind (\d+)/)?.[1] ?? 0),
      dirty,
      rebaseInProgress: gitDir !== null && (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))),
      mergeInProgress: gitDir !== null && existsSync(join(gitDir, "MERGE_HEAD")),
    };
  }

  async revParse(ref: string): Promise<string | null> {
    const result = await this.run("rev-parse", ref);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async fetch(): Promise<RunResult> {
    return this.run("fetch", "--all", "--prune");
  }

  /** Files changed between two refs (defaults to the last commit). */
  async changedFiles(from = "HEAD~1", to = "HEAD"): Promise<string[]> {
    const result = await this.run("diff", "--name-only", `${from}..${to}`);
    return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  }

  async rebase(upstream: string): Promise<{ ok: boolean; conflict: boolean; detail: string }> {
    const status = await this.status();
    if (status.rebaseInProgress || status.mergeInProgress) {
      return { ok: false, conflict: true, detail: "a rebase or merge is already in progress" };
    }
    const result = await this.run("rebase", upstream);
    if (result.code === 0) return { ok: true, conflict: false, detail: result.stdout.trim() };
    const conflict = /conflict/i.test(result.stderr + result.stdout);
    return { ok: false, conflict, detail: (result.stderr || result.stdout).trim() };
  }

  /**
   * Commits exactly the given paths and nothing else — the shell only ever
   * commits files you have claimed, so an unrelated edit can't ride along.
   */
  async commitPaths(paths: string[], message: string): Promise<{ committed: boolean; sha: string | null; reason?: string }> {
    if (paths.length === 0) return { committed: false, sha: null, reason: "nothing-to-commit" };

    const status = await this.status();
    if (status.rebaseInProgress || status.mergeInProgress) {
      return { committed: false, sha: null, reason: "rebase-or-merge-in-progress" };
    }

    const add = await this.run("add", "--", ...paths);
    if (add.code !== 0) return { committed: false, sha: null, reason: add.stderr.trim() || "add-failed" };

    const staged = await this.run("diff", "--cached", "--name-only");
    if (staged.stdout.trim() === "") return { committed: false, sha: null, reason: "nothing-to-commit" };

    const commit = await this.run("commit", "-m", message, "--", ...paths);
    if (commit.code !== 0) return { committed: false, sha: null, reason: commit.stderr.trim() || "commit-failed" };
    return { committed: true, sha: await this.revParse("HEAD") };
  }

  /**
   * Pushes your own branch, never anyone else's and never a protected one.
   * There is no force option on purpose — a force-push is exactly the move
   * that destroys a peer's work while looking like a sync.
   */
  async push(branch: string, ownBranch: string): Promise<{ pushed: boolean; reason?: string }> {
    if (PROTECTED_BRANCHES.includes(branch)) return { pushed: false, reason: `refusing to push to ${branch}` };
    if (branch !== ownBranch) return { pushed: false, reason: `refusing to push ${branch}: not your branch (${ownBranch})` };
    const result = await this.run("push", "--set-upstream", "origin", branch);
    return result.code === 0 ? { pushed: true } : { pushed: false, reason: (result.stderr || result.stdout).trim() };
  }

  async mergeBranch(ref: string): Promise<{ merged: boolean; conflict: boolean; detail: string }> {
    const status = await this.status();
    if (status.rebaseInProgress || status.mergeInProgress) {
      return { merged: false, conflict: true, detail: "a rebase or merge is already in progress" };
    }
    const result = await this.run("merge", "--no-edit", ref);
    if (result.code === 0) return { merged: true, conflict: false, detail: result.stdout.trim() };
    const conflict = /conflict/i.test(result.stderr + result.stdout);
    if (conflict) await this.run("merge", "--abort");
    return { merged: false, conflict, detail: (result.stderr || result.stdout).trim() };
  }

  private async gitDir(): Promise<string | null> {
    const result = await this.run("rev-parse", "--absolute-git-dir");
    return result.code === 0 ? result.stdout.trim() : null;
  }
}

/** Your branch, and only yours: `inzo/<agent-short>`. */
export function branchFor(agentId: string): string {
  const short = agentId.replace(/^agent_/, "").slice(0, 8) || "anon";
  return `inzo/${short}`;
}

/**
 * Tiny glob matcher: `*` (no separator), `**` (any), `?`. Not a dependency and
 * not `path.matchesGlob` either, which needs Node 22+ while this package
 * supports Node 20.
 */
export function matchGlob(glob: string, path: string): boolean {
  const segments = glob.split("/");
  let pattern = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") {
      // Zero or more whole segments, so `src/**/x.ts` also matches `src/x.ts`.
      pattern += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    pattern += segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    if (!last) pattern += "/";
  });
  return new RegExp(`^${pattern}$`).test(path);
}


/** Paths of yours that fall inside somebody else's claim. */
export function collisions(paths: readonly string[], claims: readonly string[]): string[] {
  return paths.filter((path) => claims.some((glob) => matchGlob(glob, path)));
}
