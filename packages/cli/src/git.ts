import { execFile } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { validateRepoName, validateRepoUrl } from "inzo-protocol";

const run = promisify(execFile);

/**
 * Every git call in this package goes through here, and it is `execFile` with
 * an argv array — never `exec`, never `shell: true`, never a template string.
 *
 * The reason is P1-3: a clone URL reaches a joiner from the *relay*, which the
 * protocol explicitly does not trust. One shell interpolation anywhere on this
 * path turns a crafted descriptor into code execution on every joiner.
 */
export async function git(args: string[], cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** Same, but a non-zero exit is an answer rather than an error. */
export async function gitOrNull(args: string[], cwd = process.cwd()): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

export async function requireGit(): Promise<void> {
  if ((await gitOrNull(["--version"])) === null) {
    throw new Error("git is required for this command and was not found on PATH. Install git >= 2.30 and try again.");
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await gitOrNull(["rev-parse", "--is-inside-work-tree"], dir)) === "true";
}

/**
 * Whether `dir` is a repository root in its own right — not merely a
 * directory that happens to sit inside someone else's repository.
 *
 * The difference is not academic, and it bit hard the first time this was run
 * end to end. `git rev-parse --is-inside-work-tree` answers true for a
 * brand-new empty directory when any ancestor is a repo, and a home directory
 * under git is common. `initRepo` believed the scratch directory was already
 * a repository, skipped `git init`, and the directory silently became part of
 * the user's home repo: `git status` then scanned all of $HOME (which is how
 * this was found — `inzo join` appeared to hang), and every later git command
 * would have been aimed at the wrong repository entirely.
 */
export async function isRepoRoot(dir: string): Promise<boolean> {
  const top = await gitOrNull(["rev-parse", "--show-toplevel"], dir);
  if (top === null) return false;
  return realpathSync(top) === realpathSync(dir);
}

export async function originUrl(dir: string): Promise<string | null> {
  return await gitOrNull(["remote", "get-url", "origin"], dir);
}

export async function currentBranch(dir: string): Promise<string | null> {
  return await gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"], dir);
}

/**
 * The argv for a hardened clone, built separately from running it so the
 * security-critical shape is assertable in a test with no network.
 *
 * `protocol.ext.allow=never` kills git's `ext::` transport (which runs a shell
 * command), `protocol.file.allow=never` kills `file://` local-disk clones,
 * `--no-recurse-submodules` stops a submodule URL reopening both, and `--`
 * stops a URL that survived validation being read as an option.
 */
export function cloneArgv(url: string, dest: string): string[] {
  return [
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.file.allow=never",
    "clone",
    "--no-recurse-submodules",
    "--",
    validateRepoUrl(url),
    validateRepoName(dest),
  ];
}

/** Clones `url` into a direct child of `parent` named `dest`. */
export async function clone(url: string, dest: string, parent: string): Promise<void> {
  await git(cloneArgv(url, dest), parent);
}

/**
 * Puts `dir` on `branch`, creating it if neither local nor remote has it.
 *
 * `checkout <branch>` first so a joiner tracks the branch the starter pushed;
 * `-b` only as the fallback, because forcing a fresh branch over an existing
 * one would silently orphan the teammate's work.
 */
export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  if ((await currentBranch(dir)) === branch) return;
  if ((await gitOrNull(["checkout", branch, "--"], dir)) !== null) return;
  await git(["checkout", "-b", branch, "--"], dir);
}

/** Secret-shaped filenames, matched against the workspace's top level. */
const SECRET_PATTERNS = [/^\.env($|\.)/, /\.pem$/, /\.key$/, /-credentials\.json$/, /-key\.json$/];

/**
 * Names the secret-shaped files a shared command could read in this workspace
 * (P1-6). The sandbox bind-mounts the whole workspace, so a gitignored `.env`
 * is outside the repo but inside the boundary — and `cat .env` puts it in the
 * shared thread.
 *
 * Returns filenames only. Contents are never read, and must never be.
 *
 * ponytail: top level only. Recurse if real workspaces turn out to hide
 * secrets in subdirectories often enough to matter.
 */
export async function secretShapedFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SECRET_PATTERNS.some((pattern) => pattern.test(entry.name)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  if (names.length === 0) return [];

  // Outside a repo nothing is "gitignored", but every match is still inside
  // the mount, so report them all rather than reporting nothing.
  if (!(await isGitRepo(dir))) return names.sort();

  const ignored = await gitOrNull(["check-ignore", "--", ...names], dir);
  return ignored ? ignored.split("\n").filter(Boolean).sort() : [];
}
