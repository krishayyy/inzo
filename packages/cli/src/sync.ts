import { MAX_DIRTY_PATHS, type Presence } from "inzo-protocol";
import { readCapacity } from "./capacity.js";
import { type Api } from "./api.js";
import { attach } from "./attach.js";
import { currentBranch, git, gitOrNull, originUrl, requireGit } from "./git.js";
import { style } from "./render.js";
import { resolveWorkspace } from "./session.js";
import { usage } from "./start.js";

/**
 * The git commands `inzo sync` runs, built before anything executes.
 *
 * Pure and exported so the rails below are assertable with no network and no
 * repo: the test that matters is "this argv never contains --force", and that
 * is only worth anything if it checks the argv the command actually runs.
 */
export function syncArgv(branch: string): string[][] {
  return [
    ["pull", "--rebase", "--autostash", "origin", branch],
    ["push", "origin", branch],
  ];
}

/** Branches Inzo will not push to, ever, whatever the session says. */
const PROTECTED = new Set(["main", "master", "trunk", "develop"]);

export interface SyncFlags {
  dryRun: boolean;
  json: boolean;
}

export function parseSyncFlags(argv: string[]): SyncFlags {
  const flags: SyncFlags = { dryRun: false, json: false };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--no-color") continue;
    else usage(`Unknown flag "${arg}"`);
  }
  return flags;
}

/**
 * `inzo sync` — pull --rebase --autostash, then push. Nothing else.
 *
 * Inzo never moves a file; git does. `watch` only ever fetches and this is the
 * sole writer, which is the entire safety story for the git layer.
 *
 * The rails are refusals rather than warnings because each one protects
 * against a mistake that is expensive to undo and easy to make while moving
 * fast with a teammate.
 */
export async function sync(argv: string[]): Promise<void> {
  const flags = parseSyncFlags(argv);
  await requireGit();

  const { api, pairingId } = await attach();
  const workspace = resolveWorkspace();

  const { session: descriptor } = await api.session(pairingId);
  const sessionBranch = descriptor?.repo?.branch;
  if (!sessionBranch) {
    throw new Error("This session has no shared repo, so there is nothing to sync. Start one from inside a git repo.");
  }

  const branch = await currentBranch(workspace);
  if (branch !== sessionBranch) {
    throw new Error(
      `You are on "${branch}", but this session's branch is "${sessionBranch}". ` +
        `Run \`git checkout ${sessionBranch}\` first — syncing would push your work to the wrong branch.`,
    );
  }
  // Belt and braces. The session branch is `inzo/<hex>` today, so this can
  // only fire if a descriptor is crafted or hand-edited — which is exactly
  // when a refusal is worth having.
  if (PROTECTED.has(branch)) {
    throw new Error(`Refusing to push "${branch}". Inzo never pushes a shared trunk branch.`);
  }

  // Checked before running anything, so a repo with no remote gets a sentence
  // that names the fix instead of git's "fatal: 'origin' does not appear to
  // be a git repository", which is true but unhelpful.
  if ((await originUrl(workspace)) === null) {
    throw new Error(
      "This repo has no `origin` remote, so there is nothing to sync with. " +
        "Add one with `gh repo create --source=. --push` or `git remote add origin <url>`, then start the session again.",
    );
  }

  const commands = syncArgv(branch);

  if (flags.dryRun) {
    const printed = commands.map((args) => `git ${args.join(" ")}`);
    if (flags.json) process.stdout.write(`${JSON.stringify({ branch, commands: printed }, null, 2)}\n`);
    else for (const line of printed) process.stdout.write(`${line}\n`);
    return;
  }

  for (const args of commands) {
    try {
      const out = await git(args, workspace);
      if (!flags.json && out) process.stdout.write(`${style.dim(out)}\n`);
    } catch (err) {
      // A rebase conflict is not a failure of sync — it is git handing the
      // work back to the human, which is the correct outcome. Flag it in
      // presence so teammates see it in `watch` instead of wondering why
      // nothing is landing, then get out of the way.
      const conflicts = await conflictedPaths(workspace);
      if (conflicts.length > 0) {
        await postPresence(api, pairingId, workspace, branch, true);
        process.stdout.write(`${style.red("Rebase stopped on a conflict:")}\n`);
        for (const path of conflicts) process.stdout.write(`  ${path}\n`);
        process.stdout.write(
          `\nResolve them, then ${style.bold("git add")} and ${style.bold("git rebase --continue")}. ` +
            `Run ${style.bold("inzo sync")} again after that.\n`,
        );
        return;
      }
      throw new Error(`git ${args.join(" ")} failed: ${(err as Error).message}`);
    }
  }

  const presence = await postPresence(api, pairingId, workspace, branch, false);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ branch, synced: true, presence }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${style.green("Synced")} ${branch} — ${presence.head}, ${presence.dirty.length} file(s) dirty.\n`);
}

/** Paths git has left with conflict markers, if any. */
export async function conflictedPaths(workspace: string): Promise<string[]> {
  const out = await gitOrNull(["diff", "--name-only", "--diff-filter=U"], workspace);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * This working tree, as the other members will see it.
 *
 * Capped at the protocol's limit before it is sent rather than after: a
 * thousand-file rebase should degrade to a truncated list, not a 400 that
 * makes presence silently stop updating for the rest of the session.
 */
export async function readPresence(workspace: string, branch: string, conflicted = false): Promise<Presence> {
  const head = (await gitOrNull(["rev-parse", "--short", "HEAD"], workspace)) ?? "0000000";
  const status = (await gitOrNull(["status", "--porcelain"], workspace)) ?? "";
  const dirty = status
    .split("\n")
    .filter(Boolean)
    // Drop the status column by token, not by character offset: `git()` trims
    // its output, which eats the leading space of a " M path" line and would
    // otherwise shift every unstaged path by one character.
    .map((line) => line.trim().replace(/^\S+\s+/, ""))
    // A rename reads as "old -> new"; the new path is the one being worked on.
    .map((path) => (path.includes(" -> ") ? path.split(" -> ")[1] : path))
    .filter(Boolean)
    .slice(0, MAX_DIRTY_PATHS);

  const counts = await gitOrNull(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`], workspace);
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];

  return {
    branch,
    head,
    dirty,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    conflicted,
    // Rides the beat that already exists: no new endpoint, no extra request.
    capacity: readCapacity(),
  };
}

/**
 * Publishes presence, best-effort.
 *
 * Change-triggered from the day it ships (§10 H-1): every caller is a point
 * where the working tree actually moved. A 30-second heartbeat retrofitted
 * later would mean launching on the expensive version, and this is a liveness
 * hint — never worth failing a real operation over.
 */
export async function postPresence(
  api: Api,
  pairingId: string,
  workspace: string,
  branch: string,
  conflicted: boolean,
): Promise<Presence> {
  const presence = await readPresence(workspace, branch, conflicted);
  try {
    await api.setPresence(pairingId, presence);
  } catch {
    // Ignored on purpose.
  }
  return presence;
}
