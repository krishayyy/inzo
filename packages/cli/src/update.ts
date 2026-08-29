import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { style } from "./render.js";

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
