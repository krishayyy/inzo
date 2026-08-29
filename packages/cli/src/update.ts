import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { style } from "./render.js";

const run = promisify(execFile);

/**
 * Update checking (§9 U-1) and the version pin in `.mcp.json` (U-3).
 *
 * Three rules the check never breaks, because an update notice that gets any
 * of them wrong is worse than no notice at all:
 *
 *   - never on the critical path — the cached answer is used, and the refresh
 *     happens after the command has already printed its result;
 *   - never off a TTY, so CI stays silent;
 *   - never a failure. A registry that is down, slow, or unreachable produces
 *     no notice and no error, ever.
 */
const CACHE_PATH = join(process.env.INZO_HOME ?? join(homedir(), ".inzo"), "update-check.json");

/**
 * The registry name, which is not what users type.
 *
 * npm's anti-squatting policy rejected the plain name `inzo` as too close to
 * ini/ink/intl/minio/pino. `inzo-cli` cleared it — it is already on the
 * registry — and it matches the rest of the family: inzo-mcp, inzo-holder,
 * inzo-sandbox. The bin stays `inzo`, so only the thing you install is named
 * differently from the thing you type.
 */
export const PACKAGE_NAME = "inzo-cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  latest: string;
  checkedAt: string;
}

/** Numeric comparison, so 0.10.0 is correctly newer than 0.9.0. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => (v.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4) ?? []).map(Number);
  const a = parse(candidate);
  const b = parse(current);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function updateCheckDisabled(): boolean {
  // Off a TTY covers CI without needing to detect it, and covers `| head`,
  // `--json` piped into jq, and every other non-interactive use for free.
  return process.env.INZO_NO_UPDATE_CHECK === "1" || !process.stdout.isTTY;
}

function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_PATH, `${JSON.stringify(cache)}\n`);
  } catch {
    // A cache that cannot be written costs one extra request tomorrow.
  }
}

export function isCacheStale(cache: UpdateCache | null, now = Date.now()): boolean {
  if (!cache) return true;
  const at = Date.parse(cache.checkedAt);
  return Number.isNaN(at) || now - at > CHECK_INTERVAL_MS;
}

/** The cached notice, if there is one. Never makes a request. */
export function updateNotice(current: string): string | null {
  if (updateCheckDisabled()) return null;
  const cache = readCache();
  if (!cache || !isNewer(cache.latest, current)) return null;
  return style.dim(`  inzo ${cache.latest} available (you have ${current}) · npm i -g ${PACKAGE_NAME}`);
}

/**
 * Refreshes the cache in the background, at most once a day.
 *
 * Deliberately returns immediately: the notice a user sees is always the
 * cached one, so a slow registry can delay tomorrow's notice but never
 * today's command.
 */
export function refreshUpdateCache(): void {
  if (updateCheckDisabled() || !isCacheStale(readCache())) return;
  void fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(3000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const latest = (data as { version?: string } | null)?.version;
      if (typeof latest === "string") writeCache({ latest, checkedAt: new Date().toISOString() });
    })
    .catch(() => {
      // Silent by design. An update check is never worth an error.
    });
}

/**
 * Rewrites the `inzo-mcp` pin in `.mcp.json` (U-3).
 *
 * The failure this prevents is genuinely baffling from the outside: you update
 * the CLI, everything looks current, and your agent keeps running the old MCP
 * server forever because the pin never moved. Returns the version now pinned,
 * or null if there was nothing to change.
 */
export function rewriteMcpPin(workspace: string, version: string): string | null {
  const path = join(workspace, ".mcp.json");
  if (!existsSync(path)) return null;
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    const args = config.mcpServers?.inzo?.args;
    if (!args) return null;

    let changed = false;
    const rewritten = args.map((arg) => {
      if (!arg.startsWith("inzo-mcp@")) return arg;
      const pinned = `inzo-mcp@${version}`;
      if (arg !== pinned) changed = true;
      return pinned;
    });
    if (!changed) return null;

    config.mcpServers!.inzo.args = rewritten;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return version;
  } catch {
    // A hand-edited or malformed .mcp.json is the user's to fix; rewriting it
    // blindly would be worse than leaving it alone.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Protocol version negotiation (U-3)
// ---------------------------------------------------------------------------

/**
 * Refuses to join a session this client is too old to speak correctly.
 *
 * A clear refusal beats a subtle disagreement, and it matters most here: the
 * thing two clients could silently disagree about is what a human approved.
 * A relay that advertises no minimum is one that predates this, and is
 * therefore not enforcing anything — proceed.
 */
export function assertClientSupported(minimum: string | null | undefined, current: string): void {
  if (!minimum) return;
  if (isNewer(minimum, current)) {
    throw new Error(
      `This session needs inzo ${minimum} or newer — you have ${current}. Run \`npm i -g ${PACKAGE_NAME}\`.`,
    );
  }
}


// ---------------------------------------------------------------------------
// Installing an update (§9 U-2)
// ---------------------------------------------------------------------------

/**
 * How this copy of the CLI got here, which decides whether updating it is
 * even meaningful.
 *
 *   - `global`  — `npm i -g inzo-cli`. The only kind worth updating in place.
 *   - `npx`     — a throwaway cache directory. `npx inzo-cli@latest` already
 *                 fetches the newest version, and writing into npm's cache
 *                 would be both pointless and rude.
 *   - `source`  — a git checkout. Running `npm i -g` here would install a
 *                 *different* copy than the one being run, which is worse
 *                 than doing nothing: the developer's next command would
 *                 still be their build, and they would have no idea why.
 */
export type InstallKind = "global" | "npx" | "source";

export async function installKind(entry = process.argv[1]): Promise<InstallKind> {
  if (!entry) return "source";

  // Checked on the invocation path before resolving it: npm caches npx
  // packages under a `_npx` directory on every platform, and a symlink
  // elsewhere in the path should not hide that.
  const resolved = (() => {
    try {
      return realpathSync(entry);
    } catch {
      return entry;
    }
  })();
  if (entry.includes(`${sep}_npx${sep}`) || resolved.includes(`${sep}_npx${sep}`)) return "npx";

  const globalRoot = await run("npm", ["root", "-g"], { timeout: 15_000 })
    .then(({ stdout }) => {
      try {
        return realpathSync(stdout.trim());
      } catch {
        return stdout.trim();
      }
    })
    .catch(() => null);
  if (globalRoot && resolved.startsWith(globalRoot + sep)) return "global";
  return "source";
}

/**
 * Installs the newest published version.
 *
 * Returns the version installed, or null if there was nothing to do. Never
 * throws: a failed self-update is an inconvenience, and it must not take down
 * the command the user actually asked for.
 */
export async function installUpdate(current: string): Promise<string | null> {
  const cache = readCache();
  if (!cache || !isNewer(cache.latest, current)) return null;
  if ((await installKind()) !== "global") return null;
  try {
    // 5 minutes: a cold npm install over a slow link is not a hang.
    await run("npm", ["install", "-g", `${PACKAGE_NAME}@${cache.latest}`], { timeout: 300_000 });
    return cache.latest;
  } catch {
    return null;
  }
}

/**
 * Updates at a session boundary, and only there (§9 U-2: never mid-session).
 *
 * `start` and `join` are the two points where no work is in flight, so they
 * are the only safe places to swap the binary underneath the user. Returns
 * true when an update landed, which means the caller must stop: the process
 * still running is the *old* code, and letting it go on to create a session
 * would produce one from the version we just replaced — and then a second one
 * when the user re-ran.
 */
export async function updateBeforeSession(current: string): Promise<boolean> {
  if (updateCheckDisabled()) return false;

  const installed = await installUpdate(current);
  if (!installed) return false;

  process.stdout.write(
    `${style.green(`Updated inzo ${current} -> ${installed}.`)}\n` +
      `Run your command again to use it.\n`,
  );
  return true;
}

/**
 * The update line for `inzo doctor`, which names the command that fixes it.
 *
 * A source checkout is told to pull rather than to npm-install, because
 * installing would leave the checkout it is being run from untouched.
 */
export async function updateStatus(current: string): Promise<{ ok: boolean; detail: string }> {
  const cache = readCache();
  if (!cache) return { ok: true, detail: `${current} (no check yet — run any command on a terminal first)` };
  if (!isNewer(cache.latest, current)) return { ok: true, detail: `${current} (latest)` };

  const kind = await installKind();
  const fix =
    kind === "global"
      ? "run `inzo update`"
      : kind === "npx"
        ? `use \`npx ${PACKAGE_NAME}@latest\``
        : "git pull && npm run build";
  return { ok: false, detail: `${current}, but ${cache.latest} is out — ${fix}` };
}
