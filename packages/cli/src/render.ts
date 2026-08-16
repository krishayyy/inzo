import type { Message, MinePairing, Plan, Runway } from "./api.js";

// FORCE_COLOR is the standard counterpart to NO_COLOR (used by chalk, supports-color,
// and most of the Node CLI ecosystem) — it lets color survive being piped, which
// matters for e.g. `inzo watch | tee session.log` where stdout isn't a TTY but the
// person driving the pipe still wants to see color on their own terminal.
const useColor = process.env.NO_COLOR === undefined && (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true);

// Box borders and spinners degrade to plain text under the same conditions as
// color: a script piping our output, or NO_COLOR set. NO_COLOR's letter of
// the law is just "no ANSI color codes", but in practice most CLIs treat it
// as "give me plain output", and we do the same — a box with no color is
// still a shape a log-scraper has to work around.
const useFancy = useColor;

const wrap = (code: string) => (text: string) => (useColor ? `[${code}m${text}[0m` : text);

// 24-bit color, matching the hex values in website/styles.css exactly, so the
// CLI and the site read as the same product rather than two coincidentally
// similar ones. Two colors have no site equivalent because the CLI needs a
// three-way success/pending/danger split that the site's two-accent palette
// doesn't: amber for "waiting on you", and a link-blue distinct from the
// brand blue for anything clickable/copyable in a terminal.
const truecolor = (r: number, g: number, b: number) => (text: string) =>
  useColor ? `[38;2;${r};${g};${b}m${text}[0m` : text;

export const style = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: truecolor(217, 79, 47), // --orange, website's one warm/alert hue — no separate danger red in the brand
  green: truecolor(47, 156, 74), // --green
  yellow: truecolor(202, 165, 61), // amber — pending/attention; no site equivalent
  cyan: truecolor(31, 92, 224), // --blue
  blue: truecolor(31, 92, 224), // --blue, named to match the site's own token name
  muted: truecolor(90, 104, 120), // --muted
};

// ---- ANSI-aware layout -----------------------------------------------------

const ESCAPE = /\[[0-9;]*m/g;

/** Length as the terminal will render it, ignoring invisible color codes. */
function visibleLength(text: string): number {
  return text.replace(ESCAPE, "").length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

/**
 * Wraps a single content line to `width`. Most lines here are either plain
 * text or wrapped in exactly one color span (an entire line passed through
 * one style.xxx() call) — for that shape, the color codes are peeled off,
 * the plain text is word-wrapped, and each resulting physical line gets the
 * same open/close codes reapplied. A line mixing multiple color spans (rare —
 * only the approvals line does this) is left unwrapped rather than risking a
 * dangling escape code split across lines, which would bleed color into
 * whatever prints after the panel.
 */
const SINGLE_SPAN = /^(\[[0-9;]*m)([\s\S]*)(\[0m)$/;

function wrapLine(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const match = line.match(SINGLE_SPAN);
  if (!match) return [line]; // mixed spans: leave to overflow rather than corrupt colors
  const [, open, inner, close] = match;

  const words = inner.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.map((l) => `${open}${l}${close}`);
}

/**
 * Draws a rounded box around `body` with `title` set into the top border —
 * every major status block (pairing, plan, runway) renders as one of these,
 * which is what makes `inzo status` read as a dashboard rather than a log.
 * Content wraps to a fixed comfortable width rather than growing the box to
 * fit whatever the longest line happens to be — a runway verdict or a
 * dropped-scope list can run to a full sentence, and letting that set the
 * box width would make every panel as wide as its chattiest line.
 */
export function panel(title: string, body: string, tone: "default" | "green" | "orange" | "blue" = "default"): string {
  const rawLines = body.split("\n");
  if (!useFancy) return [title.toUpperCase(), ...rawLines].join("\n");

  const color = tone === "green" ? style.green : tone === "orange" ? style.red : tone === "blue" ? style.blue : style.dim;
  const columns = process.stdout.columns || 80;
  const wrapWidth = Math.min(64, columns - 4);
  const lines = rawLines.flatMap((line) => wrapLine(line, wrapWidth));
  const contentWidth = Math.max(visibleLength(title) + 4, ...lines.map(visibleLength));

  const titleBar = `${color(BOX.h)} ${style.bold(title)} `;
  const top = `${color(BOX.tl)}${titleBar}${color(BOX.h.repeat(Math.max(0, contentWidth - visibleLength(title) - 1)))}${color(BOX.tr)}`;
  const mid = lines.map((line) => `${color(BOX.v)} ${padVisible(line, contentWidth)} ${color(BOX.v)}`);
  const bottom = `${color(BOX.bl)}${color(BOX.h.repeat(contentWidth + 2))}${color(BOX.br)}`;
  return [top, ...mid, bottom].join("\n");
}

/** A filled/empty block bar — used for runway once a budget makes "percent of what" answerable. */
export function bar(fraction: number, width = 18): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const color = clamped < 0.15 ? style.red : clamped < 0.4 ? style.yellow : style.green;
  return `${color("█".repeat(filled))}${style.dim("░".repeat(width - filled))}`;
}

// ---- spinner ----------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Runs `work` while animating a spinner on the current line, then clears it —
 * only when stdout is an interactive TTY. Piped/non-interactive output (which
 * is exactly what the test suite runs under) gets none of this: no interval,
 * no stdout writes outside of `ctx.out`, so it cannot affect captured output
 * or leave a timer running past the test.
 */
export async function withSpinner<T>(label: string, work: Promise<T>): Promise<T> {
  if (!useFancy) return work;
  let frame = 0;
  process.stdout.write(`${style.dim(FRAMES[0])} ${label}`);
  const timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
    process.stdout.write(`\r${style.dim(FRAMES[frame])} ${label}`);
  }, 80);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    // \x1b[2K clears the whole line — the spinner's final frame must not
    // linger above whatever prints next.
    process.stdout.write("\r[2K");
  }
}

// ---- formatting ---------------------------------------------------------

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

export function formatPlan(plan: Plan | null, selfAgentId: string, peerAgentId: string): string {
  if (!plan) return style.dim("No plan proposed yet.");

  // Filled/open circles read as a checklist at a glance and — same rule the
  // site's CSS calls out — never carry the approved/pending distinction by
  // color alone; the glyph itself changes too.
  const approvals = [selfAgentId, peerAgentId].map((agentId) => {
    const label = agentId === selfAgentId ? "you" : "peer";
    return plan.approvedBy.includes(agentId) ? style.green(`● ${label}`) : style.dim(`○ ${label}`);
  });

  const status = plan.locked ? style.green("LOCKED") : style.yellow("AWAITING APPROVAL");
  const lines = [
    `${style.bold(plan.goal)}`,
    // status carries its own color and a trailing reset, so it cannot be
    // nested inside dim()'s wrapping — ANSI resets aren't stack-based, and
    // the inner one would cancel the outer style rather than restoring it
    // after. Colored independently instead of composed.
    `${style.dim(`v${plan.version}`)} ${style.dim("·")} ${status}`,
    "",
    ...plan.items.map((item) => `${item.owner === selfAgentId ? style.cyan("you") : style.yellow("peer")}  ${item.task}`),
    "",
    approvals.join("   "),
  ];
  return panel("Plan", lines.join("\n"), plan.locked ? "green" : "default");
}

export function formatRunway(runway: Runway, budget?: MinePairing["budget"] | null): string {
  const lines: string[] = [];

  if (runway.tokensRemaining !== null) {
    let line = `${runway.tokensRemaining.toLocaleString()} tokens left`;
    if (budget?.tokenBudget) {
      line = `${bar(runway.tokensRemaining / budget.tokenBudget)}  ${line}`;
    }
    lines.push(line);
  }
  if (runway.costRemainingUsd !== null) {
    let line = `$${runway.costRemainingUsd.toFixed(2)} left`;
    if (budget?.costBudgetUsd) {
      line = `${bar(runway.costRemainingUsd / budget.costBudgetUsd)}  ${line}`;
    }
    lines.push(line);
  }
  if (runway.msRemaining !== null) {
    const left = formatDuration(runway.msRemaining);
    lines.push(runway.msRemaining < 0 ? style.red(`deadline ${left}`) : `${left} to deadline`);
  }
  if (runway.burn) {
    lines.push(style.dim(`${Math.round(runway.burn.tokensPerMin).toLocaleString()} tok/min`));
  }
  if (lines.length === 0) lines.push(style.dim("No budget set."));

  const verdictColor = runway.onTrack === false ? style.red : runway.onTrack ? style.green : style.dim;
  lines.push("", verdictColor(runway.verdict));

  return panel("Runway", lines.join("\n"), runway.onTrack === false ? "orange" : runway.onTrack ? "green" : "default");
}

export function formatPairing(pairing: MinePairing): string {
  const lines = [
    // The full ID goes in the body, not the title: a pairing id is a long
    // UUID, and putting it in the title made this box wider than the Plan
    // and Runway panels stacked under it — three boxes of different widths
    // reads as unfinished, not as a dashboard.
    style.dim(pairing.id),
    `you    ${shortAgent(pairing.agentId)}  ${pairing.revoked ? style.red("REVOKED") : style.green("● active")}`,
    `peer   ${shortAgent(pairing.peerAgentId)}  ${pairing.peerRevoked ? style.red("REVOKED") : style.green("● active")}`,
  ];
  const dropped = ["commands:run", "plan:approve", "plan:propose", "messages:send"].filter(
    (scope) => !pairing.peerScope.includes(scope),
  );
  if (dropped.length > 0) {
    lines.push(style.dim(`peer has given up: ${dropped.join(", ")}`));
  }
  return panel("Pairing", lines.join("\n"));
}

export function heading(text: string): string {
  return useFancy ? `\n${style.bold(text)}` : `\n${text}\n${"-".repeat(text.length)}`;
}
