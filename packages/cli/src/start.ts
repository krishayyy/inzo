import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  DEFAULT_SESSION_MODE,
  SESSION_MODES,
  validateRepoName,
  validateRepoUrl,
  type SessionDescriptor,
  type SessionMode,
} from "inzo-protocol";
import { generateHolderKeyPair } from "inzo-holder";
import { createApi } from "./api.js";
import {
  checkoutBranch,
  clone,
  git,
  gitOrNull,
  isGitRepo,
  isRepoRoot,
  originUrl,
  requireGit,
  secretShapedFiles,
} from "./git.js";
import {
  mergeMcpConfig,
  relayPost,
  writeSession,
  type CreatePairingResponse,
  type JoinPairingResponse,
} from "./pair.js";
import { style } from "./render.js";
import { assertClientSupported, rewriteMcpPin, updateBeforeSession } from "./update.js";
import { MCP_VERSION, VERSION } from "./version.js";
import { loadSession, resolveWorkspace } from "./session.js";
import { postPresence } from "./sync.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface StartFlags {
  mode?: SessionMode;
  dir?: string;
  json: boolean;
  printConfig: boolean;
  format: "json" | "toml";
  yes: boolean;
  positional?: string;
}

class UsageError extends Error {
  readonly usage = true;
}

/** Usage errors exit 2, not 1 — see the CLI conventions in the plan. */
export function isUsageError(err: unknown): boolean {
  return err instanceof Error && (err as UsageError).usage === true;
}

/** Throws the error that makes the process exit 2 rather than 1. */
export function usage(message: string): never {
  throw new UsageError(message);
}

function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("-")) usage(`${flag} needs a value`);
  return value;
}

export function parseStartFlags(argv: string[]): StartFlags {
  const flags: StartFlags = { json: false, printConfig: false, format: "json", yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--mode":
        flags.mode = parseMode(takeValue(argv, i++, "--mode"));
        break;
      case "--dir":
        flags.dir = takeValue(argv, i++, "--dir");
        break;
      case "--format": {
        const value = takeValue(argv, i++, "--format");
        if (value !== "json" && value !== "toml") usage("--format takes json or toml");
        flags.format = value;
        break;
      }
      case "--print-config":
        flags.printConfig = true;
        break;
      case "--json":
        flags.json = true;
        break;
      // Reserved so scripts written against the documented surface keep
      // working. Nothing prompts today: P1-3's blocking confirmation is a
      // displayed line under the peer-trust model, and no path is destructive.
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--no-color":
        break;
      default:
        if (arg.startsWith("-")) usage(`Unknown flag "${arg}"`);
        if (flags.positional !== undefined) usage("start takes at most one positional argument");
        flags.positional = arg;
    }
  }
  return flags;
}

function parseMode(value: string): SessionMode {
  if (!(SESSION_MODES as readonly string[]).includes(value)) {
    usage(`mode must be one of: ${SESSION_MODES.join(", ")}`);
  }
  return value as SessionMode;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export type StartArg =
  | { kind: "none" }
  | { kind: "mode"; mode: SessionMode }
  | { kind: "repo"; url: string }
  | { kind: "name"; name: string };

/**
 * The §2 inference table, one branch per row.
 *
 * Disambiguation is total by construction: no mode name contains `/` or `:`,
 * so a repo can never be read as a mode. The near-miss check exists because
 * the alternative — silently creating a directory called `cowrok` — is the
 * kind of failure a user doesn't notice until much later.
 */
export function classifyStartArg(arg?: string): StartArg {
  if (arg === undefined || arg === "") return { kind: "none" };
  if ((SESSION_MODES as readonly string[]).includes(arg)) return { kind: "mode", mode: arg as SessionMode };
  if (arg.includes("/") || arg.includes(":")) return { kind: "repo", url: expandRepoShorthand(arg) };

  const near = SESSION_MODES.find((mode) => levenshtein(arg.toLowerCase(), mode) <= 2);
  if (near) usage(`Unknown argument "${arg}". Did you mean "${near}"? (Pass --dir to create a directory by that name.)`);

  return { kind: "name", name: validateRepoName(arg) };
}

/** `owner/repo` is GitHub shorthand; anything else must already be a URL. */
export function expandRepoShorthand(arg: string): string {
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(arg)) return `https://github.com/${arg}.git`;
  return validateRepoUrl(arg);
}

/** Strips the noise that makes two spellings of the same remote look different. */
function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function repoNameFromUrl(url: string): string {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return validateRepoName(tail.replace(/\.git$/, ""));
}

/**
 * The shared session branch.
 *
 * Not derived from the pairing code: the code is minted by the relay in the
 * same request that carries this descriptor, so it does not exist yet.
 */
export function newSessionBranch(): string {
  return `inzo/${randomBytes(4).toString("hex").slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Shared output
// ---------------------------------------------------------------------------

export function mcpConfigBlock(workspace: string, format: "json" | "toml"): string {
  if (format === "toml") {
    return [
      "[mcp_servers.inzo]",
      'command = "npx"',
      `args = ["-y", "inzo-mcp@${MCP_VERSION}"]`,
      `env = { INZO_WORKSPACE = ${JSON.stringify(workspace)} }`,
      "",
    ].join("\n");
  }
  return `${JSON.stringify(
    { mcpServers: { inzo: { command: "npx", args: ["-y", `inzo-mcp@${MCP_VERSION}`], env: { INZO_WORKSPACE: workspace } } } },
    null,
    2,
  )}\n`;
}

/**
 * P1-6. Filenames only — printing a value here would put the secret in the
 * scrollback the notice exists to warn about.
 */
function printSecretNotice(files: string[]): void {
  if (files.length === 0) return;
  process.stdout.write(
    `\n  ${style.yellow("!")} Shared commands can read these files in this workspace:\n` +
      `      ${files.join("   ")}\n` +
      `    They are gitignored, so teammates won't get them from the repo —\n` +
      `    but a shared command's output goes to the shared thread.\n`,
  );
}

/**
 * Makes `dir` a repository of its own.
 *
 * `isRepoRoot`, not `isGitRepo`: inside a home directory that is itself under
 * git, "am I in a work tree" is true for every new directory, and believing it
 * would leave this one adopted by the ancestor repo rather than owning itself.
 */
async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (!(await isRepoRoot(dir))) await git(["init", "--quiet"], dir);
}

// ---------------------------------------------------------------------------
// inzo start
// ---------------------------------------------------------------------------

export async function start(argv: string[]): Promise<void> {
  const flags = parseStartFlags(argv);
  const arg = classifyStartArg(flags.positional);

  // A session boundary: nothing is in flight, so this is one of the two
  // places it is safe to replace the binary underneath the user.
  if (!flags.json && (await updateBeforeSession(VERSION))) return;

  if (flags.printConfig) {
    const workspace = flags.dir ? resolve(flags.dir) : resolveWorkspace();
    process.stdout.write(mcpConfigBlock(workspace, flags.format));
    return;
  }

  const parent = resolve(flags.dir ?? process.cwd());
  let workspace: string;

  switch (arg.kind) {
    case "repo": {
      await requireGit();
      const name = repoNameFromUrl(arg.url);
      workspace = resolve(parent, name);
      if (existsSync(workspace)) {
        if (!(await isRepoRoot(workspace))) {
          throw new Error(`${workspace} already exists and is not a git repository. Move it aside, or pass --dir.`);
        }
        process.stdout.write(`Using the clone already at ${workspace}.\n`);
      } else {
        process.stdout.write(`Cloning ${arg.url} into ${workspace}\n`);
        await clone(arg.url, name, parent);
      }
      break;
    }
    case "name": {
      await requireGit();
      workspace = resolve(parent, arg.name);
      if (existsSync(workspace)) throw new Error(`${workspace} already exists. Pick another name, or start from inside it.`);
      await initRepo(workspace);
      process.stdout.write(`Created ${workspace} and ran git init.\n`);
      break;
    }
    default:
      workspace = flags.dir ? resolve(flags.dir) : resolveWorkspace();
  }

  process.chdir(workspace);
  workspace = resolveWorkspace();

  const mode = flags.mode ?? (arg.kind === "mode" ? arg.mode : DEFAULT_SESSION_MODE);
  const descriptor = await describeWorkspace(workspace, mode);

  if (descriptor.repo) await checkoutBranch(workspace, descriptor.repo.branch);

  const holder = generateHolderKeyPair();
  const created = await relayPost<CreatePairingResponse>("/pairings", {
    cnf: { jwk: holder.publicJwk },
    session: descriptor,
  });
  // Before anything is written: a client too old for this relay is refused
  // outright rather than left to disagree subtly about the protocol (U-3).
  assertClientSupported(created.minClientVersion, VERSION);
  const sessionPath = writeSession({
    pairingId: null,
    agentId: created.agentId,
    agentToken: created.agentToken,
    scope: created.scope,
    credential: created.credential,
    holderPrivateKey: created.credential ? holder.privateKeyPem : null,
    principalId: created.principalId,
    session: descriptor,
  });
  const mcpConfigPath = mergeMcpConfig(workspace);
  rewriteMcpPin(workspace, MCP_VERSION);
  const secrets = await secretShapedFiles(workspace);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          code: created.code,
          expiresAt: created.expiresAt,
          workspace,
          mode,
          repo: descriptor.repo,
          sessionPath,
          mcpConfigPath,
          secretShapedFiles: secrets,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${style.green("Pairing code:")} ${style.bold(created.code)} (expires ${created.expiresAt})\n`);
  process.stdout.write(`  mode      ${mode}\n`);
  process.stdout.write(`  workspace ${workspace}\n`);
  if (descriptor.repo) {
    process.stdout.write(`  branch    ${descriptor.repo.branch}\n`);
    process.stdout.write(`  repo      ${descriptor.repo.url ?? style.yellow("no remote")}\n`);
  }
  process.stdout.write(`\nYour teammate runs: ${style.bold(`npx inzo join ${created.code}`)}\n`);
  if (descriptor.repo && descriptor.repo.url === null) {
    process.stdout.write(
      `${style.yellow("\nThis repo has no remote,")} so joiners get an empty scratch directory instead of your code.\n` +
        `  Fix it with ${style.bold("gh repo create --source=. --push")} or ${style.bold("git remote add origin <url>")}, then start again.\n`,
    );
  }
  printSecretNotice(secrets);
  process.stdout.write(`\nWrote ${sessionPath} and ${mcpConfigPath}.\n`);
  process.stdout.write(`Once they've joined, run ${style.bold("inzo watch")} here.\n`);
}

/** Reads the workspace's git state into the descriptor the joiner will act on. */
async function describeWorkspace(workspace: string, mode: SessionMode): Promise<SessionDescriptor> {
  if (!(await isGitRepo(workspace))) return { mode, repo: null };

  const remote = await originUrl(workspace);
  let url: string | null = null;
  if (remote) {
    try {
      url = validateRepoUrl(remote);
    } catch {
      // An origin git accepts but the protocol refuses (an `ext::` remote, say)
      // must not be handed to joiners. Degrade to no-remote, loudly.
      process.stdout.write(`${style.yellow("origin")} ${remote} is not a clonable https/ssh URL; joiners get a scratch directory.\n`);
    }
  }
  return { mode, repo: { url, branch: newSessionBranch(), name: basename(workspace) } };
}

// ---------------------------------------------------------------------------
// inzo join
// ---------------------------------------------------------------------------

export interface JoinFlags {
  dir?: string;
  json: boolean;
  yes: boolean;
  code?: string;
}

export function parseJoinFlags(argv: string[]): JoinFlags {
  const flags: JoinFlags = { json: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dir":
        flags.dir = takeValue(argv, i++, "--dir");
        break;
      case "--json":
        flags.json = true;
        break;
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--no-color":
        break;
      default:
        if (arg.startsWith("-")) usage(`Unknown flag "${arg}"`);
        if (flags.code !== undefined) usage("join takes one pairing code");
        flags.code = arg;
    }
  }
  return flags;
}

export async function join(argv: string[]): Promise<void> {
  const flags = parseJoinFlags(argv);
  if (!flags.code) usage("inzo join <code> needs a pairing code");

  if (!flags.json && (await updateBeforeSession(VERSION))) return;

  const holder = generateHolderKeyPair();
  const joined = await relayPost<JoinPairingResponse>(`/pairings/${encodeURIComponent(flags.code)}/join`, {
    cnf: { jwk: holder.publicJwk },
  });
  assertClientSupported(joined.minClientVersion, VERSION);
  const descriptor: SessionDescriptor = joined.session ?? { mode: DEFAULT_SESSION_MODE, repo: null };

  const parent = resolve(flags.dir ?? process.cwd());
  const workspace = await bootstrapJoin(descriptor, parent, flags.code);

  process.chdir(workspace);
  const sessionPath = writeSession({
    pairingId: joined.pairingId,
    agentId: joined.agentId,
    agentToken: joined.agentToken,
    scope: joined.scope,
    credential: joined.credential,
    holderPrivateKey: joined.credential ? holder.privateKeyPem : null,
    principalId: joined.principalId,
    session: descriptor,
  });
  const mcpConfigPath = mergeMcpConfig(workspace);
  rewriteMcpPin(workspace, MCP_VERSION);
  const secrets = await secretShapedFiles(workspace);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          pairingId: joined.pairingId,
          workspace,
          mode: descriptor.mode,
          repo: descriptor.repo,
          sessionPath,
          mcpConfigPath,
          secretShapedFiles: secrets,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (descriptor.repo) await announce(workspace, descriptor.repo.branch);

  process.stdout.write(`${style.green("Joined pairing.")} Peer agent: ${joined.peerAgentId}\n`);
  process.stdout.write(`  mode      ${descriptor.mode}\n`);
  process.stdout.write(`  workspace ${workspace}\n`);
  if (descriptor.repo) process.stdout.write(`  branch    ${descriptor.repo.branch}\n`);
  printSecretNotice(secrets);
  process.stdout.write(`\nWrote ${sessionPath} and ${mcpConfigPath}.\n`);
  process.stdout.write(`Run ${style.bold("inzo watch")} to see the plan negotiate live.\n`);
}

/**
 * The §2 join table. Every path ends with the caller standing in a git repo on
 * the session branch, or with an error that names the obstacle.
 */
async function bootstrapJoin(descriptor: SessionDescriptor, parent: string, code: string): Promise<string> {
  const repo = descriptor.repo;
  const scratchName = scratchDirName(code);

  if (!repo) {
    const dir = resolve(parent, scratchName);
    if (existsSync(dir)) throw new Error(`${dir} already exists. Remove it, or pass --dir <path>.`);
    await requireGit();
    await initRepo(dir);
    process.stdout.write(`This session has no repo — created a scratch project at ${dir}.\n`);
    return dir;
  }

  await requireGit();

  // Already standing in the right repo: fetch and switch, don't re-clone.
  const here = resolveWorkspace(parent);
  if (repo.url && (await isGitRepo(here))) {
    const remote = await originUrl(here);
    if (remote && normalizeRemote(remote) === normalizeRemote(repo.url)) {
      await gitOrNull(["fetch", "origin"], here);
      await checkoutBranch(here, repo.branch);
      process.stdout.write(`Already in ${repo.name} — fetched and checked out ${repo.branch}.\n`);
      return here;
    }
  }

  if (!repo.url) {
    const dir = resolve(parent, scratchName);
    if (existsSync(dir)) throw new Error(`${dir} already exists. Remove it, or pass --dir <path>.`);
    await initRepo(dir);
    process.stdout.write(
      `${style.yellow("The shared repo has no remote,")} so there is nothing to clone. Created a scratch project at ${dir}.\n`,
    );
    return dir;
  }

  const name = repoNameFromUrl(repo.url);
  const dir = resolve(parent, name);
  if (existsSync(dir)) throw new Error(`${dir} already exists. Remove it, run join from inside it, or pass --dir <path>.`);
  process.stdout.write(`Cloning ${repo.url} into ${dir}\n`);
  await clone(repo.url, name, parent);
  await checkoutBranch(dir, repo.branch);
  return dir;
}


/**
 * Publishes this member's first presence, best-effort.
 *
 * Change-triggered, like every other presence write (§10 H-1): joining is a
 * change. Doing it here means the starter's `watch` panel gains a row the
 * moment someone arrives, rather than staying empty until that person happens
 * to run `inzo sync`.
 */
async function announce(workspace: string, branch: string): Promise<void> {
  try {
    const session = loadSession();
    if (!session.pairingId) return;
    await postPresence(createApi(session), session.pairingId, workspace, branch, false);
  } catch {
    // A liveness hint is never worth failing a join over.
  }
}


/**
 * The directory a joiner lands in when the session has no repo.
 *
 * Codes already read `INZO-7FK2Q9`, so prefixing blindly produced
 * `inzo-inzo-7fk2q9`. Strip the code's own prefix first.
 */
export function scratchDirName(code: string): string {
  return `inzo-${code.toLowerCase().replace(/^inzo-/, "")}`;
}
