import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readCapacity } from "./capacity.js";
import { updateStatus } from "./update.js";
import { MCP_VERSION, VERSION } from "./version.js";
import { RELAY_URL } from "./pair.js";
import { style } from "./render.js";
import { resolveWorkspace, sessionFilePath } from "./session.js";
import { usage } from "./start.js";

const run = promisify(execFile);

/**
 * `inzo doctor` — why doesn't it work.
 *
 * With four external dependencies (node, git, Docker, gh) plus a relay, a
 * hosted session, and file permissions that actually matter, "it says no" has
 * too many causes to leave to a README section.
 *
 * Everything here is a read. Doctor never fixes anything: a diagnostic that
 * mutates state is one you stop trusting the moment it is wrong.
 */
export interface Check {
  name: string;
  ok: boolean;
  /** False for optional dependencies — they degrade a feature, not the tool. */
  required: boolean;
  detail: string;
}

export function parseDoctorFlags(argv: string[]): { json: boolean } {
  const flags = { json: false };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--no-color") continue;
    else usage(`Unknown flag "${arg}"`);
  }
  return flags;
}

/** First line of `<tool> --version`, or null if it isn't installed. */
async function version(command: string): Promise<string | null> {
  try {
    const { stdout } = await run(command, ["--version"], { timeout: 10_000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return null;
  }
}

/** Parses "2.39.5" out of whatever a tool prints around it. */
export function parseSemver(text: string | null): [number, number, number] | null {
  const match = text?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function atLeast(found: [number, number, number] | null, min: [number, number, number]): boolean {
  if (!found) return false;
  for (let i = 0; i < 3; i++) {
    if (found[i] > min[i]) return true;
    if (found[i] < min[i]) return false;
  }
  return true;
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const workspace = resolveWorkspace();

  // Not required: being a version behind degrades nothing on its own, and
  // failing doctor over it would cry wolf.
  const update = await updateStatus(VERSION);
  checks.push({ name: "inzo", ok: update.ok, required: false, detail: `${update.detail} · mcp pin ${MCP_VERSION}` });

  const node = parseSemver(process.version);
  checks.push({
    name: "node",
    ok: atLeast(node, [20, 0, 0]),
    required: true,
    detail: atLeast(node, [20, 0, 0]) ? process.version : `${process.version} — Inzo needs Node 20 or newer`,
  });

  const gitVersion = await version("git");
  const gitOk = atLeast(parseSemver(gitVersion), [2, 30, 0]);
  checks.push({
    name: "git",
    ok: gitOk,
    required: true,
    detail: gitVersion ?? "not found on PATH — start, join, sync, and cowork all need it",
  });

  // Optional on purpose: without Docker, coordination is unaffected and only
  // sandboxed shared commands refuse. Reporting that as a failure would send
  // people installing Docker to fix a problem they do not have.
  const docker = await version("docker");
  checks.push({
    name: "docker",
    ok: docker !== null,
    required: false,
    detail: docker ?? "not found — shared commands will refuse; coordination is unaffected",
  });

  const gh = await version("gh");
  checks.push({
    name: "gh",
    ok: gh !== null,
    required: false,
    detail: gh ?? "not found — `inzo done` prints the PR command instead of opening one",
  });

  checks.push(capacityCheck());
  checks.push(await relayCheck());
  checks.push(sessionCheck());
  checks.push(mcpConfigCheck(workspace));

  return checks;
}

/**
 * Which capacity source is in use (§8's "honest limits").
 *
 * Worth reporting because the difference is not cosmetic: a quota window is
 * per *account*, so a self-reported estimate undercounts anyone also working
 * solo or in a second session. Declaring it by hand is the accurate path, and
 * a user who does not know which one they are on cannot judge the number.
 */
function capacityCheck(): Check {
  const capacity = readCapacity();
  const window = capacity?.windows[0];
  if (!window) {
    return {
      name: "capacity",
      ok: false,
      required: false,
      detail: "none declared — teammates see no quota for you (inzo capacity --window 5h --used 62%)",
    };
  }
  const source = window.estimated ? "estimated" : "human-declared, exact";
  return {
    name: "capacity",
    ok: true,
    required: false,
    detail: `${capacity!.provider}: ${Math.round(window.used * 100)}% of ${window.label} (${source})`,
  };
}

async function relayCheck(): Promise<Check> {
  try {
    // The one route both relays serve unauthenticated: the issuer's public
    // keys. Probing an authenticated route instead would report "relay down"
    // for what is really an expired credential.
    const res = await fetch(`${RELAY_URL}/.well-known/inzo-jwks`, {
      signal: AbortSignal.timeout(10_000),
    });
    return {
      name: "relay",
      ok: res.ok,
      required: true,
      detail: res.ok ? RELAY_URL : `${RELAY_URL} answered ${res.status}`,
    };
  } catch (err) {
    return { name: "relay", ok: false, required: true, detail: `${RELAY_URL} unreachable (${(err as Error).message})` };
  }
}

/**
 * The session file holds a live credential and the holder private key that
 * makes an approval non-repudiable, so its mode is a real finding rather than
 * a tidiness note: group- or world-readable means anyone with an account on
 * this machine can sign as you.
 */
function sessionCheck(): Check {
  const path = sessionFilePath();
  if (!existsSync(path)) {
    return { name: "session", ok: false, required: false, detail: `none for this directory — run \`inzo start\`` };
  }
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    return {
      name: "session",
      ok: false,
      required: true,
      detail: `${path} is mode ${mode.toString(8)} — it holds your signing key. Run: chmod 600 ${path}`,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pairingId?: string | null };
    return {
      name: "session",
      ok: true,
      required: false,
      detail: parsed.pairingId ? `${path} (paired)` : `${path} (code created, nobody has joined yet)`,
    };
  } catch {
    return { name: "session", ok: false, required: true, detail: `${path} is not valid JSON — re-pair to rewrite it` };
  }
}

function mcpConfigCheck(workspace: string): Check {
  const path = join(workspace, ".mcp.json");
  if (!existsSync(path)) {
    return { name: ".mcp.json", ok: false, required: false, detail: `none in ${workspace} — your agent will not see Inzo` };
  }
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    const inzo = config.mcpServers?.inzo;
    if (!inzo) return { name: ".mcp.json", ok: false, required: false, detail: `${path} has no "inzo" server` };
    const declared = inzo.env?.INZO_WORKSPACE;
    if (declared && declared !== workspace) {
      // The one failure here that looks like nothing and behaves like chaos:
      // the agent's commands land in a different directory than the CLI's.
      return {
        name: ".mcp.json",
        ok: false,
        required: true,
        detail: `${path} points INZO_WORKSPACE at ${declared}, not ${workspace}`,
      };
    }
    // U-3: the update that looks like it worked. The CLI is current, the
    // config is valid, and the agent is still running an old MCP server
    // because nothing moved the pin.
    const pinned = inzo.args?.find((arg) => arg.startsWith("inzo-mcp@"))?.slice("inzo-mcp@".length);
    if (pinned && pinned !== MCP_VERSION) {
      return {
        name: ".mcp.json",
        ok: false,
        required: false,
        detail: `${path} pins inzo-mcp@${pinned}, but this CLI ships ${MCP_VERSION} — run \`inzo start\` here to rewrite it`,
      };
    }
    return { name: ".mcp.json", ok: true, required: false, detail: path };
  } catch {
    return { name: ".mcp.json", ok: false, required: true, detail: `${path} is not valid JSON` };
  }
}

export async function doctor(argv: string[]): Promise<number> {
  const flags = parseDoctorFlags(argv);
  const checks = await runChecks();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      // Never signal by color alone: the glyph carries the state too.
      const mark = check.ok ? style.green("ok  ") : check.required ? style.red("FAIL") : style.yellow("--  ");
      process.stdout.write(`  ${mark}  ${check.name.padEnd(12)}${check.detail}\n`);
    }
  }

  const broken = checks.filter((check) => !check.ok && check.required);
  if (broken.length > 0 && !flags.json) {
    process.stdout.write(`\n${style.red(`${broken.length} required check(s) failed.`)}\n`);
  }
  return broken.length > 0 ? 1 : 0;
}
