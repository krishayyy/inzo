import { createApi } from "./api.js";
import { style } from "./render.js";
import { loadSession, requirePairing } from "./session.js";
import { usage } from "./start.js";

/**
 * `inzo tokens` — the claim, made falsifiable.
 *
 * The design target is that using Inzo costs a team *fewer* tokens than not
 * using it. If a user feels their quota drain faster because Inzo is running,
 * the feature is a liability however good the coordination is. So this reports
 * both sides, and if it cannot be shown net-negative that is a bug to fix, not
 * a number to hide.
 *
 * Every figure here is an estimate and is labelled as one. The overhead side
 * is measured exactly; the savings side is a model, because the counterfactual
 * — what the second agent *would* have spent reading a file it never read —
 * is not observable by construction.
 */

/** Measured: the resident tool surface, from the toolSurface budget test. */
const RESIDENT_TOOL_TOKENS = 567;

/**
 * What a ledger hit avoids.
 *
 * A source file an agent bothers to summarize is rarely small; ~4,000 tokens
 * is a 400-line file at the usual ratio. Deliberately conservative — the point
 * is a floor on the saving, not a flattering number.
 */
const TOKENS_PER_AVOIDED_READ = 4000;

/** What one published summary cost to write, and costs each reader. */
const TOKENS_PER_SUMMARY = 250;

export interface TokenReport {
  turns: number;
  residentOverhead: number;
  ledgerEntries: number;
  ledgerHits: number;
  estimatedSaved: number;
  net: number;
}

export function estimate(input: { turns: number; ledgerEntries: number; ledgerHits: number }): TokenReport {
  const residentOverhead = input.turns * RESIDENT_TOOL_TOKENS;
  const summaryCost = input.ledgerEntries * TOKENS_PER_SUMMARY;
  const saved = input.ledgerHits * (TOKENS_PER_AVOIDED_READ - TOKENS_PER_SUMMARY);
  return {
    turns: input.turns,
    residentOverhead,
    ledgerEntries: input.ledgerEntries,
    ledgerHits: input.ledgerHits,
    estimatedSaved: saved,
    net: saved - residentOverhead - summaryCost,
  };
}

export function parseTokensFlags(argv: string[]): { json: boolean; turns: number } {
  const flags = { json: false, turns: 100 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--no-color") continue;
    else if (arg === "--turns") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) usage("--turns needs a positive integer");
      flags.turns = value;
    } else usage(`Unknown flag "${arg}"`);
  }
  return flags;
}

export async function tokens(argv: string[]): Promise<void> {
  const flags = parseTokensFlags(argv);
  const session = loadSession();
  const pairingId = requirePairing(session);
  const api = createApi(session);

  // Any read returns the ledger's stats, and a key nobody will have written
  // is the cheapest way to ask for them. It counts as a miss, which is honest:
  // this call really did fail to find anything.
  const { stats } = await api.context(pairingId, "inzo/stats", "0000000");
  const report = estimate({ turns: flags.turns, ledgerEntries: stats.entries, ledgerHits: stats.hits });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${style.bold("Inzo's own token cost")}  ${style.dim(`(estimated, over ${report.turns} turns)`)}\n`);
  process.stdout.write(`  tool definitions   ${fmt(-report.residentOverhead)}  ${style.dim(`${RESIDENT_TOOL_TOKENS}/turn resident`)}\n`);
  process.stdout.write(`  ledger summaries   ${fmt(-report.ledgerEntries * TOKENS_PER_SUMMARY)}  ${style.dim(`${report.ledgerEntries} written`)}\n`);
  process.stdout.write(
    `  reads avoided      ${fmt(report.estimatedSaved)}  ${style.dim(`${report.ledgerHits} hit(s) × ~${TOKENS_PER_AVOIDED_READ}`)}\n`,
  );
  process.stdout.write(
    `  ${style.bold("net")}                ${report.net >= 0 ? style.green(fmt(report.net)) : style.red(fmt(report.net))}\n`,
  );
  process.stdout.write(
    style.dim(
      "\nSavings are modelled, not measured: what the second agent would have spent\n" +
        "reading a file it never read is not observable. Overhead is exact.\n",
    ),
  );
}

function fmt(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${Math.abs(n).toLocaleString()}`.padStart(12);
}
