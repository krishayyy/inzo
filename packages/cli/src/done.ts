import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attach } from "./attach.js";
import { currentBranch, gitOrNull, originUrl, requireGit } from "./git.js";
import { style } from "./render.js";
import { resolveWorkspace } from "./session.js";
import { usage } from "./start.js";
import { sync } from "./sync.js";

const run = promisify(execFile);

export interface DoneFlags {
  noPr: boolean;
  json: boolean;
  base?: string;
}

export function parseDoneFlags(argv: string[]): DoneFlags {
  const flags: DoneFlags = { noPr: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-pr") flags.noPr = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--no-color") continue;
    else if (arg === "--base") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) usage("--base needs a branch name");
      flags.base = value;
    } else usage(`Unknown flag "${arg}"`);
  }
  return flags;
}

/**
 * The default branch the PR targets.
 *
 * Asks the remote rather than assuming `main`: plenty of real repos are still
 * on `master`, and opening a PR against a branch that does not exist is a
 * confusing way to end a session that otherwise went fine.
 */
export async function baseBranch(workspace: string): Promise<string> {
  const symbolic = await gitOrNull(["symbolic-ref", "refs/remotes/origin/HEAD"], workspace);
  if (symbolic) return symbolic.replace("refs/remotes/origin/", "");
  for (const candidate of ["main", "master"]) {
    if ((await gitOrNull(["rev-parse", "--verify", `origin/${candidate}`], workspace)) !== null) return candidate;
  }
  return "main";
}

/** `git@github.com:o/r.git` and `https://github.com/o/r` both -> `o/r`. */
export function githubSlug(remote: string | null): string | null {
  if (!remote) return null;
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

export function compareUrl(slug: string, base: string, head: string): string {
  return `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

/**
 * `inzo done` — sync, then open the PR.
 *
 * The gap this closes is a product one, not a technical one. Cowork ended on a
 * session branch and then nothing: `revoke` was the only "end", which is
 * hostile framing for "we finished". Without a merge-back path the tool
 * produces orphan branches and hands the work back at the least convenient
 * moment.
 *
 * `gh` is offered, never required. Without it this prints the exact command
 * and the compare URL, which is the whole value minus one keystroke.
 */
export async function done(argv: string[]): Promise<void> {
  const flags = parseDoneFlags(argv);
  await requireGit();

  const workspace = resolveWorkspace();
  const { api, pairingId } = await attach();

  // Sync first, always. A PR opened from an unsynced branch shows the reviewer
  // a different diff than the one the team just agreed on.
  await sync(flags.json ? ["--json"] : []);

  if (flags.noPr) {
    if (!flags.json) process.stdout.write(`${style.green("Synced.")} No PR opened (--no-pr).\n`);
    return;
  }

  const head = await currentBranch(workspace);
  if (!head) throw new Error("Cannot determine the current branch, so there is nothing to open a PR from.");

  const base = flags.base ?? (await baseBranch(workspace));
  if (base === head) {
    throw new Error(`This session's branch is "${head}", which is also the base branch. There is nothing to merge.`);
  }

  const slug = githubSlug(await originUrl(workspace));
  const { plan } = await api.plan(pairingId).catch(() => ({ plan: null }));
  const title = plan?.goal ?? `Inzo session ${head}`;

  const ghArgs = ["pr", "create", "--head", head, "--base", base, "--title", title, "--body", prBody(plan)];

  try {
    const { stdout } = await run("gh", ghArgs, { cwd: workspace, timeout: 60_000 });
    const url = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    if (flags.json) process.stdout.write(`${JSON.stringify({ branch: head, base, pr: url }, null, 2)}\n`);
    else process.stdout.write(`${style.green("Pull request:")} ${url}\n`);
    return;
  } catch (err) {
    // Not an error worth failing on: the work is pushed either way, and the
    // human can finish in one paste.
    const manual = `gh ${ghArgs.map(quote).join(" ")}`;
    const compare = slug ? compareUrl(slug, base, head) : null;
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ branch: head, base, pr: null, command: manual, compare }, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `${style.yellow("Could not open the PR automatically")} (${(err as Error).message.split("\n")[0]}).\n` +
        `  Run: ${style.bold(manual)}\n` +
        (compare ? `  Or open: ${compare}\n` : ""),
    );
  }
}

function prBody(plan: { goal: string; items: Array<{ task: string }> } | null): string {
  if (!plan) return "Opened by `inzo done`.";
  return [`## ${plan.goal}`, "", ...plan.items.map((item) => `- ${item.task}`), "", "Opened by `inzo done`."].join("\n");
}

/** Shell-quotes for display only — nothing here is ever passed to a shell. */
function quote(arg: string): string {
  return /^[A-Za-z0-9._/:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}
