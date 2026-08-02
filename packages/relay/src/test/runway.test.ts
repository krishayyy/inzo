import { describe, expect, it } from "vitest";
import { computeRunway, foldUsage } from "../lib/runway.js";
import type { Budget, UsageReport } from "../types.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

function report(agentId: string, over: Partial<UsageReport>): UsageReport {
  return {
    id: `usage_${Math.random()}`,
    pairingId: "pairing_1",
    agentId,
    tokensUsed: 0,
    costUsd: 0,
    wallClockMs: 0,
    progressPct: 0,
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function budget(over: Partial<Budget> = {}): Budget {
  return {
    pairingId: "pairing_1",
    deadline: null,
    tokenBudget: null,
    costBudgetUsd: null,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function runway(reports: UsageReport[], b: Budget | null) {
  const usage = foldUsage("pairing_1", ["a", "b"], reports);
  return computeRunway(b, usage, reports, NOW);
}

describe("foldUsage", () => {
  it("takes the latest cumulative report per agent instead of summing history", () => {
    const usage = foldUsage("pairing_1", ["a", "b"], [
      report("a", { tokensUsed: 100, wallClockMs: 1000 }),
      report("a", { tokensUsed: 250, wallClockMs: 60_000 }),
      report("b", { tokensUsed: 50, wallClockMs: 30_000 }),
    ]);
    expect(usage.byAgent.a.tokensUsed).toBe(250);
    expect(usage.byAgent.a.reportCount).toBe(2);
    expect(usage.totals.tokensUsed).toBe(300);
  });

  it("seeds both agents so a silent partner still appears", () => {
    const usage = foldUsage("pairing_1", ["a", "b"], [report("a", { tokensUsed: 10 })]);
    expect(usage.byAgent.b).toEqual({
      tokensUsed: 0,
      costUsd: 0,
      wallClockMs: 0,
      progressPct: 0,
      reportCount: 0,
      lastReportedAt: null,
    });
  });
});

describe("computeRunway", () => {
  it("never guesses at an unset budget", () => {
    const result = runway([report("a", { tokensUsed: 100 })], null);
    expect(result.tokensRemaining).toBeNull();
    expect(result.costRemainingUsd).toBeNull();
    expect(result.msRemaining).toBeNull();
    expect(result.onTrack).toBeNull();
    expect(result.verdict).toMatch(/no budget/i);
  });

  it("refuses to extrapolate a burn rate from a single report", () => {
    const result = runway([report("a", { tokensUsed: 500, wallClockMs: 60_000 })], budget({ tokenBudget: 1000 }));
    expect(result.burn).toBeNull();
    expect(result.projectedTokenExhaustion).toBeNull();
  });

  it("measures burn from the slope between an agent's first and last report", () => {
    const result = runway(
      [
        report("a", { tokensUsed: 0, costUsd: 0, wallClockMs: 0 }),
        report("a", { tokensUsed: 1000, costUsd: 0.5, wallClockMs: 60_000 }),
      ],
      budget({ tokenBudget: 5000 }),
    );
    expect(result.burn).toEqual({ tokensPerMin: 1000, costUsdPerMin: 0.5 });
    expect(result.tokensRemaining).toBe(4000);
    // 4000 remaining at 1000/min = four more minutes.
    expect(result.projectedTokenExhaustion).toBe(new Date(NOW + 4 * 60_000).toISOString());
  });

  it("ignores wall-clock the agents did not actually spend working", () => {
    // Two reports an hour apart in real time, but only one minute of agent work.
    const result = runway(
      [
        report("a", { tokensUsed: 0, wallClockMs: 0, createdAt: new Date(NOW - 3_600_000).toISOString() }),
        report("a", { tokensUsed: 600, wallClockMs: 60_000 }),
      ],
      budget({ tokenBudget: 1200 }),
    );
    expect(result.burn?.tokensPerMin).toBe(600);
  });

  it("flags a plan that runs out of tokens before the deadline", () => {
    const result = runway(
      [
        report("a", { tokensUsed: 0, wallClockMs: 0 }),
        report("a", { tokensUsed: 1000, wallClockMs: 60_000 }),
      ],
      budget({ tokenBudget: 2000, deadline: new Date(NOW + 30 * 60_000).toISOString() }),
    );
    // 1000 left at 1000/min runs dry in a minute, well before the 30m deadline.
    expect(result.onTrack).toBe(false);
    expect(result.verdict).toMatch(/runs out before the deadline/i);
  });

  it("clears a plan that outlasts the deadline", () => {
    const result = runway(
      [
        report("a", { tokensUsed: 0, wallClockMs: 0 }),
        report("a", { tokensUsed: 100, wallClockMs: 60_000 }),
      ],
      budget({ tokenBudget: 100_000, deadline: new Date(NOW + 30 * 60_000).toISOString() }),
    );
    expect(result.onTrack).toBe(true);
    expect(result.verdict).toMatch(/outlast/i);
  });

  it("reports a passed deadline rather than projecting past it", () => {
    const result = runway([], budget({ deadline: new Date(NOW - 1000).toISOString() }));
    expect(result.msRemaining).toBeLessThan(0);
    expect(result.onTrack).toBe(false);
    expect(result.verdict).toMatch(/deadline has passed/i);
  });

  it("says so plainly when the budget is already spent", () => {
    const result = runway([report("a", { tokensUsed: 1500 })], budget({ tokenBudget: 1000 }));
    expect(result.tokensRemaining).toBe(-500);
    expect(result.verdict).toMatch(/already spent/i);
  });

  it("treats a restarted agent's counter reset as no measurable burn, not negative burn", () => {
    const result = runway(
      [
        report("a", { tokensUsed: 900, wallClockMs: 60_000 }),
        report("a", { tokensUsed: 10, wallClockMs: 1000 }),
      ],
      budget({ tokenBudget: 1000 }),
    );
    expect(result.burn).toBeNull();
  });
});
