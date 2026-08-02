import type { AgentUsage, Budget, CombinedUsage, Runway, UsageReport } from "../types.js";

const MS_PER_MIN = 60_000;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function emptyAgentUsage(): AgentUsage {
  return {
    tokensUsed: 0,
    costUsd: 0,
    wallClockMs: 0,
    progressPct: 0,
    reportCount: 0,
    lastReportedAt: null,
  };
}

/**
 * Folds a pairing's report history into current usage.
 *
 * Reports are CUMULATIVE per-agent totals, so the latest report from each
 * agent wins outright — they are never summed across time. That is what makes
 * a dropped or duplicated report harmless; summing deltas would double-count
 * a retry and silently inflate the numbers the humans are budgeting against.
 */
export function foldUsage(
  pairingId: string,
  agentIds: string[],
  reports: UsageReport[],
): CombinedUsage {
  const byAgent: Record<string, AgentUsage> = {};
  for (const agentId of agentIds) byAgent[agentId] = emptyAgentUsage();

  for (const report of reports) {
    const bucket = (byAgent[report.agentId] ??= emptyAgentUsage());
    bucket.tokensUsed = report.tokensUsed;
    bucket.costUsd = report.costUsd;
    bucket.wallClockMs = report.wallClockMs;
    bucket.progressPct = report.progressPct;
    bucket.reportCount += 1;
    bucket.lastReportedAt = report.createdAt;
  }

  const totals = Object.values(byAgent).reduce(
    (acc, agent) => ({
      tokensUsed: acc.tokensUsed + agent.tokensUsed,
      costUsd: round(acc.costUsd + agent.costUsd, 6),
      wallClockMs: acc.wallClockMs + agent.wallClockMs,
    }),
    { tokensUsed: 0, costUsd: 0, wallClockMs: 0 },
  );

  return { pairingId, byAgent, totals };
}

/**
 * Burn rate, measured per agent-minute actually worked.
 *
 * Requires >= 2 reports from an agent: with a single data point the only way
 * to get a rate is to assume the agent started at zero at pairing creation,
 * which is wrong for anyone who paired and then went to get coffee. With two
 * points we can difference them and measure the real slope. Agents with fewer
 * than two reports contribute nothing rather than a guess.
 */
function computeBurn(reports: UsageReport[]): Runway["burn"] {
  const series = new Map<string, UsageReport[]>();
  for (const report of reports) {
    const list = series.get(report.agentId) ?? [];
    list.push(report);
    series.set(report.agentId, list);
  }

  let deltaTokens = 0;
  let deltaCost = 0;
  let deltaMs = 0;

  for (const list of series.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    const last = list[list.length - 1];
    // Clamp: cumulative counters should never move backwards, but a restarted
    // agent might re-report from zero. Treat that as "no measurable burn"
    // rather than negative burn.
    deltaTokens += Math.max(0, last.tokensUsed - first.tokensUsed);
    deltaCost += Math.max(0, last.costUsd - first.costUsd);
    deltaMs += Math.max(0, last.wallClockMs - first.wallClockMs);
  }

  if (deltaMs <= 0) return null;
  const minutes = deltaMs / MS_PER_MIN;
  return {
    tokensPerMin: round(deltaTokens / minutes, 2),
    costUsdPerMin: round(deltaCost / minutes, 6),
  };
}

function projectExhaustion(remaining: number | null, perMin: number | undefined, now: number): string | null {
  if (remaining === null || perMin === undefined || perMin <= 0) return null;
  if (remaining <= 0) return new Date(now).toISOString();
  return new Date(now + (remaining / perMin) * MS_PER_MIN).toISOString();
}

function buildVerdict(runway: Omit<Runway, "verdict">, hasBudget: boolean): string {
  if (!hasBudget) return "No budget is set, so there is nothing to plan against yet.";
  if (runway.tokensRemaining !== null && runway.tokensRemaining <= 0) {
    return "The token budget is already spent.";
  }
  if (runway.costRemainingUsd !== null && runway.costRemainingUsd <= 0) {
    return "The cost budget is already spent.";
  }
  if (runway.msRemaining !== null && runway.msRemaining <= 0) {
    return "The deadline has passed.";
  }
  if (!runway.burn) {
    return "Not enough reports yet to estimate a burn rate — report usage at least twice per agent.";
  }
  if (runway.onTrack === false) {
    return "At the current burn rate the budget runs out before the deadline; cut scope or slow down.";
  }
  if (runway.onTrack === true) {
    return "Budget will outlast the deadline at the current burn rate.";
  }
  return "Burning steadily, but no deadline is set to measure against.";
}

/**
 * The point of the whole usage subsystem: agents call this to decide whether
 * the plan they are about to commit to is actually finishable.
 *
 * Every field whose budget is unset stays `null`. The relay never guesses a
 * budget, and `verdict` is advisory — never presented as a guarantee.
 */
export function computeRunway(
  budget: Budget | null,
  usage: CombinedUsage,
  reports: UsageReport[],
  now: number = Date.now(),
): Runway {
  const deadline = budget?.deadline ?? null;
  const hasBudget = Boolean(
    budget && (budget.deadline !== null || budget.tokenBudget !== null || budget.costBudgetUsd !== null),
  );

  const msRemaining = deadline ? new Date(deadline).getTime() - now : null;
  const tokensRemaining =
    budget?.tokenBudget != null ? budget.tokenBudget - usage.totals.tokensUsed : null;
  const costRemainingUsd =
    budget?.costBudgetUsd != null ? round(budget.costBudgetUsd - usage.totals.costUsd, 6) : null;

  const burn = computeBurn(reports);
  const projectedTokenExhaustion = projectExhaustion(tokensRemaining, burn?.tokensPerMin, now);
  const projectedCostExhaustion = projectExhaustion(costRemainingUsd, burn?.costUsdPerMin, now);

  let onTrack: boolean | null = null;
  if (deadline) {
    const deadlineMs = new Date(deadline).getTime();
    const exhaustions = [projectedTokenExhaustion, projectedCostExhaustion]
      .filter((at): at is string => at !== null)
      .map((at) => new Date(at).getTime());
    onTrack = deadlineMs > now && !exhaustions.some((at) => at < deadlineMs);
  }

  const partial = {
    deadline,
    msRemaining,
    tokensRemaining,
    costRemainingUsd,
    burn,
    projectedTokenExhaustion,
    projectedCostExhaustion,
    onTrack,
  };

  return { ...partial, verdict: buildVerdict(partial, hasBudget) };
}
