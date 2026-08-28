import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Capacity } from "inzo-protocol";
import { style } from "./render.js";
import { usage } from "./start.js";

/**
 * `inzo capacity` — the human-declared source (§8, source 3).
 *
 * Three sources were specified: provider rate-limit headers (highest fidelity,
 * provider-specific, optional), self-reported estimates from `report_usage`,
 * and this. Headers are deferred because they need a per-provider adapter and
 * the agent cannot always see them; this one always works, and it is the only
 * source that is *not* an estimate.
 *
 * Stored locally, never on the relay: a quota is per account, not per pairing,
 * and it outlives any one session. It reaches teammates on the presence beat.
 */
const CAPACITY_PATH = join(process.env.INZO_HOME ?? join(homedir(), ".inzo"), "capacity.json");

export interface CapacityFlags {
  window?: string;
  used?: number;
  resets?: string;
  provider?: string;
  clear: boolean;
  json: boolean;
}

export function parseCapacityFlags(argv: string[]): CapacityFlags {
  const flags: CapacityFlags = { clear: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--window":
        flags.window = value();
        break;
      case "--used": {
        const raw = value();
        // Accept "62%" and "0.62" — people will type both, and guessing wrong
        // would silently misreport a teammate's remaining quota.
        const parsed = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) usage("--used takes 0-1 or a percentage like 62%");
        flags.used = parsed;
        break;
      }
      case "--resets":
        flags.resets = value();
        break;
      case "--provider":
        flags.provider = value();
        break;
      case "--clear":
        flags.clear = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--no-color":
        break;
      default:
        usage(`Unknown flag "${arg}"`);
    }
  }
  return flags;
}

/**
 * Turns "15:40" into today's 15:40, or tomorrow's if that has passed.
 *
 * A reset time is always in the near future by definition, so a bare clock
 * time is unambiguous and is what people will type. Full ISO is accepted too.
 */
export function resolveResetTime(input: string, now = new Date()): string {
  const clock = input.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) usage(`--resets takes HH:MM or an ISO timestamp (got "${input}")`);
  return new Date(parsed).toISOString();
}

export function readCapacity(): Capacity | null {
  try {
    if (!existsSync(CAPACITY_PATH)) return null;
    return JSON.parse(readFileSync(CAPACITY_PATH, "utf8")) as Capacity;
  } catch {
    // A corrupt local hint must never break a sync or a watch.
    return null;
  }
}

function writeCapacity(capacity: Capacity | null): void {
  mkdirSync(dirname(CAPACITY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CAPACITY_PATH, `${JSON.stringify(capacity, null, 2)}\n`);
}

export async function capacity(argv: string[]): Promise<void> {
  const flags = parseCapacityFlags(argv);

  if (flags.clear) {
    writeCapacity(null);
    process.stdout.write("Capacity cleared. Teammates will stop seeing a window for you.\n");
    return;
  }

  if (flags.window === undefined) {
    const current = readCapacity();
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    if (!current || current.windows.length === 0) {
      process.stdout.write(
        style.dim("No capacity declared. Set one with: inzo capacity --window 5h --used 62% --resets 15:40\n"),
      );
      return;
    }
    process.stdout.write(`${current.provider}\n`);
    for (const window of current.windows) {
      process.stdout.write(`  ${formatWindow(window)}\n`);
    }
    return;
  }

  if (flags.used === undefined) usage("--used is required with --window (0-1, or a percentage like 62%)");

  const declared: Capacity = {
    provider: flags.provider ?? "self-declared",
    windows: [
      {
        label: flags.window,
        used: flags.used,
        resetsAt: flags.resets ? resolveResetTime(flags.resets) : null,
        // The one source that is not an estimate: a human read it off the
        // provider and typed it.
        estimated: false,
      },
    ],
  };
  writeCapacity(declared);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(declared, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${style.green("Capacity:")} ${formatWindow(declared.windows[0])}\n`);
  process.stdout.write(style.dim("Teammates see it on your next sync.\n"));
}

/** `▓▓▓▓▓▓▓░░░ 62% of 5h · resets 15:40` */
export function formatWindow(window: { label: string; used: number; resetsAt: string | null; estimated: boolean }): string {
  const filled = Math.round(window.used * 10);
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  const pct = `${Math.round(window.used * 100)}%`;
  const resets = window.resetsAt
    ? ` · resets ${new Date(window.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";
  // Never presented as fact when it is a guess — the window is per account,
  // so a member also working solo is undercounted by any estimate.
  const hedge = window.estimated ? style.dim(" (est)") : "";
  return `${bar} ${pct} of ${window.label}${resets}${hedge}`;
}
