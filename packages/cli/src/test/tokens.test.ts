import { describe, expect, it } from "vitest";
import { isUsageError } from "../start.js";
import { estimate, parseTokensFlags } from "../tokens.js";

describe("token accounting", () => {
  it("is net-negative when nobody uses the ledger", () => {
    // The honest answer, and the one this command exists to be able to give:
    // an Inzo that only costs is a liability, and hiding that would make the
    // number worthless.
    const report = estimate({ turns: 100, ledgerEntries: 0, ledgerHits: 0 });
    expect(report.net).toBeLessThan(0);
    expect(report.residentOverhead).toBeGreaterThan(0);
  });

  it("charges for a summary that is written and never read", () => {
    const unread = estimate({ turns: 10, ledgerEntries: 5, ledgerHits: 0 });
    const none = estimate({ turns: 10, ledgerEntries: 0, ledgerHits: 0 });
    expect(unread.net).toBeLessThan(none.net);
  });

  it("turns net-positive once the ledger is actually hit", () => {
    const report = estimate({ turns: 100, ledgerEntries: 20, ledgerHits: 20 });
    expect(report.net).toBeGreaterThan(0);
  });

  it("credits a hit with the read it avoided, minus what the summary cost", () => {
    const one = estimate({ turns: 0, ledgerEntries: 0, ledgerHits: 1 });
    // 4000 avoided minus the 250 the reader spends on the summary.
    expect(one.estimatedSaved).toBe(3750);
  });

  it("scales the overhead with the number of turns, since it is charged per request", () => {
    const short = estimate({ turns: 10, ledgerEntries: 0, ledgerHits: 0 });
    const long = estimate({ turns: 100, ledgerEntries: 0, ledgerHits: 0 });
    expect(long.residentOverhead).toBe(short.residentOverhead * 10);
  });
});

describe("tokens flags", () => {
  it("takes --turns and --json", () => {
    expect(parseTokensFlags(["--turns", "50", "--json"])).toEqual({ turns: 50, json: true });
  });

  it("rejects a non-positive --turns and unknown flags", () => {
    for (const argv of [["--turns", "0"], ["--turns", "abc"], ["--nope"]]) {
      let caught: unknown;
      try {
        parseTokensFlags(argv);
      } catch (err) {
        caught = err;
      }
      expect(isUsageError(caught)).toBe(true);
    }
  });
});
