import { overlappingPaths, tightestWindow } from "inzo-protocol";
import { formatWindow } from "./capacity.js";
import type { Message, MinePairing, Plan, PresenceEntry, Runway } from "./api.js";

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

const wrap = (code: string) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const style = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortAgent(agentId: string): string {
  return agentId.startsWith("agent_") ? agentId.slice(0, 14) : agentId;
}

export function formatMessage(message: Message, selfAgentId: string): string {
  const mine = message.fromAgentId === selfAgentId;
  const who = mine ? style.cyan("your agent") : style.yellow("peer agent");
  return `${style.dim(clock(message.createdAt))}  ${who}  ${message.body}`;
}

export function formatDuration(ms: number): string {
  if (ms < 0) return `${formatDuration(-ms)} ago`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Renders one approval box per member, however many there are.
 *
 * `members` is optional only so a pre-N-party relay still renders something
 * sensible; when it is absent this falls back to the two agents it was given.
 * A plan locks on unanimous approval, so showing five people four boxes is
 * not a cosmetic bug — it hides who everyone is waiting on.
 */
export function formatPlan(
  plan: Plan | null,
  selfAgentId: string,
  peerAgentId: string | null,
  members?: string[],
): string {
  if (!plan) return style.dim("No plan proposed yet.");

  const everyone = members?.length ? members : [selfAgentId, ...(peerAgentId ? [peerAgentId] : [])];
  const label = (agentId: string) => (agentId === selfAgentId ? "you" : shortMember(agentId));

  const approvals = everyone.map((agentId) => {
    // Never signal state by color alone — the glyph carries it too.
    return plan.approvedBy.includes(agentId)
      ? style.green(`[x] ${label(agentId)}`)
      : style.dim(`[ ] ${label(agentId)}`);
  });

  const waiting = everyone.filter((agentId) => !plan.approvedBy.includes(agentId));
  const status = plan.locked
    ? style.green("LOCKED")
    : style.yellow(`AWAITING ${waiting.length} OF ${everyone.length}`);

  const lines = [
    `${style.bold(plan.goal)}  ${style.dim(`(v${plan.version})`)}  ${status}`,
    ...plan.items.map((item) => `  - ${label(item.owner)}: ${item.task}`),
    `  ${approvals.join("   ")}`,
  ];
  return lines.join("\n");
}

/** `agent_ab12cd34` -> `ab12cd34`. Readable in a row of five. */
export function shortMember(agentId: string): string {
  return agentId.startsWith("agent_") ? agentId.slice(6, 14) : agentId.slice(0, 8);
}

export function formatRunway(runway: Runway): string {
  const parts: string[] = [];
  if (runway.msRemaining !== null) {
    const left = formatDuration(runway.msRemaining);
    parts.push(runway.msRemaining < 0 ? style.red(`deadline ${left}`) : `${left} to deadline`);
  }
  if (runway.tokensRemaining !== null) parts.push(`${runway.tokensRemaining.toLocaleString()} tokens left`);
  if (runway.costRemainingUsd !== null) parts.push(`$${runway.costRemainingUsd.toFixed(2)} left`);
  if (runway.burn) parts.push(style.dim(`${Math.round(runway.burn.tokensPerMin).toLocaleString()} tok/min`));

  const verdict =
    runway.onTrack === false ? style.red(runway.verdict) : runway.onTrack ? style.green(runway.verdict) : style.dim(runway.verdict);
  return `${parts.length ? parts.join("  ·  ") + "\n" : ""}${verdict}`;
}

const NOTABLE_SCOPES = ["commands:run", "plan:approve", "plan:propose", "messages:send"];

/**
 * One row per member, with what each has given up.
 *
 * Driven by `memberDetails` when the relay supplies it, so a five-person
 * pairing renders five rows rather than "you" and a peer who does not exist.
 * The `peerScope` path stays for a relay that predates it.
 */
export function formatPairing(pairing: MinePairing): string {
  const lines = [`${style.bold("Pairing")} ${pairing.id}`];

  const details =
    pairing.memberDetails ??
    (pairing.peerAgentId
      ? [
          { agentId: pairing.agentId, scope: pairing.scope, revoked: pairing.revoked },
          { agentId: pairing.peerAgentId, scope: pairing.peerScope ?? [], revoked: Boolean(pairing.peerRevoked) },
        ]
      : [{ agentId: pairing.agentId, scope: pairing.scope, revoked: pairing.revoked }]);

  for (const member of details) {
    const who = (member.agentId === pairing.agentId ? "you" : shortMember(member.agentId)).padEnd(10);
    const state = member.revoked ? style.red("REVOKED") : style.green("active");
    lines.push(`  ${who}${shortAgent(member.agentId)}  ${state}`);
    const dropped = NOTABLE_SCOPES.filter((scope) => !member.scope.includes(scope));
    if (dropped.length > 0) {
      lines.push(`  ${style.dim(`           has given up: ${dropped.join(", ")}`)}`);
    }
  }
  return lines.join("\n");
}

export function heading(text: string): string {
  return `\n${style.bold(text)}\n${style.dim("-".repeat(text.length))}`;
}

/** `agent_ab12cd34` -> `ab12cd34`, so a row of names stays readable. */
function memberLabel(agentId: string, selfAgentId: string): string {
  const short = agentId.startsWith("agent_") ? agentId.slice(6, 14) : agentId.slice(0, 8);
  return agentId === selfAgentId ? `${short} (you)` : short;
}

/**
 * The presence panel.
 *
 * The last line — files more than one person has uncommitted — is the highest
 * value-per-line in the whole tool. It is exactly what two people on one repo
 * need to know and cannot get from git, which only ever sees one working tree.
 */
export function formatPresence(entries: PresenceEntry[], selfAgentId: string): string {
  if (entries.length === 0) return style.dim("No presence yet — teammates appear here as they sync.");

  const lines = entries.map((entry) => {
    const who = memberLabel(entry.agentId, selfAgentId).padEnd(16);
    const counts = `${entry.ahead > 0 ? `^${entry.ahead}` : "  "} ${entry.behind > 0 ? `v${entry.behind}` : "  "}`;
    const files = entry.dirty.length === 0 ? style.dim("clean") : entry.dirty.slice(0, 3).join(", ");
    const more = entry.dirty.length > 3 ? style.dim(` +${entry.dirty.length - 3}`) : "";
    // Never signal by color alone — the word carries it too.
    const flag = entry.conflicted ? style.red("  CONFLICTED") : "";
    return `  ${who}${entry.branch.padEnd(16)}${counts}  ${files}${more}${flag}`;
  });

  // A member who reports no windows renders nothing at all, rather than a
  // zero that would read as "no quota left" (§8).
  for (const entry of entries) {
    const window = tightestWindow(entry.capacity);
    if (!window) continue;
    const who = memberLabel(entry.agentId, selfAgentId).padEnd(16);
    const line = `  ${who}${formatWindow(window)}`;
    lines.push(window.used >= 0.9 ? style.red(`${line}  LOW`) : window.used >= 0.75 ? style.yellow(line) : style.dim(line));
  }

  const overlap = overlappingPaths(entries);
  if (overlap.length > 0) {
    lines.push(style.yellow(`  ! both dirty: ${overlap.join(", ")}`));
  }
  return lines.join("\n");
}
