import { installKind, installUpdate, isNewer, PACKAGE_NAME, refreshUpdateCache } from "./update.js";
import { style } from "./render.js";
import { rewriteMcpPin } from "./update.js";
import { MCP_VERSION, VERSION } from "./version.js";
import { resolveWorkspace } from "./session.js";
import { usage } from "./start.js";

/**
 * `inzo update` — install the newest version now, rather than at the next
 * session boundary.
 *
 * Exists because the automatic path deliberately only fires at `start` and
 * `join` (§9 U-2: never mid-session), and someone who has just been told an
 * update is available should not have to start a session to get it.
 */
export async function update(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  for (const arg of argv) {
    if (arg !== "--json" && arg !== "--no-color") usage(`Unknown flag "${arg}"`);
  }

  // The cached answer may be a day old, or absent on a first run; this is the
  // one command where waiting for a fresh one is the whole point.
  const latest = await fetchLatest();
  if (latest === null) {
    if (json) process.stdout.write(`${JSON.stringify({ current: VERSION, latest: null })}\n`);
    else process.stdout.write(style.dim(`Could not reach the npm registry. You have ${VERSION}.\n`));
    return 0;
  }

  if (!isNewer(latest, VERSION)) {
    if (json) process.stdout.write(`${JSON.stringify({ current: VERSION, latest, updated: false })}\n`);
    else process.stdout.write(`${style.green(`inzo ${VERSION} is the latest.`)}\n`);
    return 0;
  }

  const kind = await installKind();
  if (kind !== "global") {
    // Installing would leave the copy actually being run untouched, which is
    // worse than refusing: the next command would still be the old one.
    const how =
      kind === "npx" ? `npx ${PACKAGE_NAME}@latest` : "git pull && npm run build";
    if (json) process.stdout.write(`${JSON.stringify({ current: VERSION, latest, updated: false, use: how })}\n`);
    else {
      process.stdout.write(
        `${style.yellow(`inzo ${latest} is available (you have ${VERSION}).`)}\n` +
          `This copy is ${kind === "npx" ? "running from the npx cache" : "a source checkout"}, so use: ${style.bold(how)}\n`,
      );
    }
    return 0;
  }

  process.stdout.write(style.dim(`Installing ${PACKAGE_NAME}@${latest}...\n`));
  const installed = await installUpdate(VERSION);
  if (!installed) {
    process.stderr.write(style.red(`Could not install ${PACKAGE_NAME}@${latest}. Try: npm i -g ${PACKAGE_NAME}@latest\n`));
    return 1;
  }

  // The agent's pinned MCP server moves with the CLI, or it keeps running the
  // old one forever (§9 U-3).
  const pin = rewriteMcpPin(resolveWorkspace(), MCP_VERSION);

  if (json) {
    process.stdout.write(`${JSON.stringify({ current: VERSION, latest: installed, updated: true, mcpPin: pin })}\n`);
    return 0;
  }
  process.stdout.write(`${style.green(`Updated inzo ${VERSION} -> ${installed}.`)}\n`);
  if (pin) process.stdout.write(`Repinned .mcp.json to inzo-mcp@${pin} — restart your agent to pick it up.\n`);
  process.stdout.write(`${style.bold("Relaunch")} any running \`inzo watch\` to use the new version.\n`);
  return 0;
}

/** The published version, or null if the registry cannot be reached. */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const version = ((await res.json()) as { version?: string }).version;
    // Keep the daily cache honest while we have a fresh answer in hand.
    refreshUpdateCache();
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
