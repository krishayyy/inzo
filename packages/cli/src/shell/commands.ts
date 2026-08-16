import { signConsent } from "inzo-holder";
import type { Api, Plan, Runway } from "../api.js";
import { encode, type MemberState } from "../envelope.js";
import { branchFor, collisions, type Git } from "../git.js";
import type { GitMode, Pairing, ShellState } from "../modes.js";
import { GIT_MODE_HINT } from "../modes.js";
import { parse as parsePlanFile, render as renderPlanFile, type Handles } from "../planfile.js";
import { formatPlan, formatRunway, shortAgent } from "../render.js";
import type { SessionFile } from "../session.js";

export interface ShellCtx {
  api: Api;
  pairingId: string;
  agentId: string;
  session: SessionFile;
  state: ShellState;
  git: Git;
  /** Repo root PLAN.md lives in; also the git working directory. */
  cwd: string;
  plan: Plan | null;
  runway: Runway | null;
  presence: Map<string, MemberState>;
  handles: Handles;
  /** Prints a local-only line into the thread pane. */
  print: (text: string) => void;
  setGitMode: (mode: GitMode) => void;
  setPairingMode: (mode: Pairing) => Promise<void>;
  readPlanFile: () => string;
  writePlanFile: (text: string) => void;
  quit: () => void;
}

export interface Command {
  name: string;
  args?: string;
  summary: string;
  /** Modes this command exists in. Absent from a mode means absent from the registry. */
  modes: Pairing[];
  run: (ctx: ShellCtx, args: string[]) => void | Promise<void>;
}

const BOTH: Pairing[] = ["cowork", "acquaintance"];
const COWORK: Pairing[] = ["cowork"];

export const COMMANDS: Command[] = [
  {
    name: "help",
    summary: "list the commands available in this mode",
    modes: BOTH,
    run: (ctx) => {
      for (const command of commandsFor(ctx.state.pairing)) {
        ctx.print(`  /${command.name}${command.args ? ` ${command.args}` : ""}  —  ${command.summary}`);
      }
      if (ctx.state.pairing === "acquaintance") {
        ctx.print("  acquaintance mode: nothing leaves this machine except /say, /share and /ask.");
      }
    },
  },
  {
    name: "say",
    args: "<text>",
    summary: "send a message to the thread",
    modes: BOTH,
    run: async (ctx, args) => {
      if (args.length === 0) return ctx.print("Usage: /say <text>");
      await ctx.api.sendMessage(ctx.pairingId, args.join(" "));
    },
  },
  {
    name: "status",
    args: "[text]",
    summary: "snapshot of the pairing, or broadcast what you are working on",
    modes: BOTH,
    run: async (ctx, args) => {
      if (args.length > 0) {
        await ctx.api.sendMessage(ctx.pairingId, encode({ kind: "inzo.status", text: args.join(" ") }));
        return;
      }
      const { pairing } = await ctx.api.mine();
      if (!pairing) return ctx.print("No active pairing.");
      ctx.print(`pairing ${pairing.id}`);
      ctx.print(`  you   ${shortAgent(pairing.agentId)}  ${pairing.revoked ? "REVOKED" : "active"}`);
      ctx.print(`  peer  ${shortAgent(pairing.peerAgentId)}  ${pairing.peerRevoked ? "REVOKED" : "active"}`);
      ctx.print(`  mode  ${ctx.state.pairing} · git ${ctx.state.git}`);
      if (ctx.runway) ctx.print(formatRunway(ctx.runway));
    },
  },
  {
    name: "plan",
    summary: "show the current plan",
    modes: BOTH,
    run: (ctx) => {
      const peer = [...ctx.presence.keys()].find((id) => id !== ctx.agentId) ?? "";
      ctx.print(formatPlan(ctx.plan, ctx.agentId, peer));
    },
  },
  {
    name: "propose",
    summary: "publish PLAN.md as a new plan version (this resets both approvals)",
    modes: COWORK,
    run: async (ctx) => {
      const parsed = parsePlanFile(ctx.readPlanFile(), ctx.handles);
      const { plan } = await ctx.api.proposePlan(
        ctx.pairingId,
        parsed.goal,
        parsed.items.map((item) => ({
          owner: item.owner,
          task: item.task,
          ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
        })),
      );
      ctx.print(`Proposed v${plan.version}. Both sides must approve again.`);
    },
  },
  {
    name: "mark",
    args: "<n> <pending|in_progress|done>",
    summary: "move one plan item's progress (never touches the plan's version or consent)",
    modes: BOTH,
    run: async (ctx, args) => {
      const index = Number(args[0]) - 1; // 1-based in PLAN.md, 0-based on the wire
      const status = args[1];
      if (!Number.isInteger(index) || index < 0 || (status !== "pending" && status !== "in_progress" && status !== "done")) {
        return ctx.print("Usage: /mark <n> pending|in_progress|done");
      }
      await ctx.api.updateItemStatus(ctx.pairingId, index, status);
      ctx.print(`Item ${index + 1} is now ${status}.`);
    },
  },
  {
    name: "approve",
    args: "[version]",
    summary: "sign off on the plan — pass the version to confirm",
    modes: BOTH,
    run: async (ctx, args) => {
      // Always re-fetch. Approving what the pane happened to be showing would
      // let a swap-in between render and keystroke collect the signature.
      const { plan } = await ctx.api.plan(ctx.pairingId);
      if (!plan) return ctx.print("No plan has been proposed yet — nothing to approve.");
      if (plan.locked) return ctx.print(`Plan v${plan.version} is already locked in by both sides.`);
      if (plan.approvedBy.includes(ctx.agentId)) {
        return ctx.print(`You already approved v${plan.version}. Waiting on the other side.`);
      }

      const peer = [...ctx.presence.keys()].find((id) => id !== ctx.agentId) ?? "";
      if (args[0] !== String(plan.version)) {
        ctx.print(formatPlan(plan, ctx.agentId, peer));
        return ctx.print(`Type /approve ${plan.version} to sign off on exactly this text.`);
      }
      if (!ctx.api.canSignConsent()) {
        return ctx.print("This session has no signing key, so it cannot produce a verifiable approval.");
      }

      // Sign the plan this terminal just fetched and rendered, hashed locally.
      // Signing a digest the relay handed us would let a hostile relay collect
      // a signature over text nobody read — the thing consent exists to stop.
      const { signature } = signConsent(ctx.session.holderPrivateKey!, {
        pairingId: ctx.pairingId,
        goal: plan.goal,
        items: plan.items,
        version: plan.version,
      });
      const result = await ctx.api.approve(ctx.pairingId, plan.version, signature);
      ctx.print(
        result.plan.locked ? "Both sides approved. The plan is locked in." : "Your approval is recorded. Waiting on the other side.",
      );
    },
  },
  {
    name: "withdraw",
    summary: "pull your approval back — no peer cooperation needed",
    modes: BOTH,
    run: async (ctx) => {
      const { consent } = await ctx.api.withdrawConsent(ctx.pairingId);
      ctx.print(
        consent.satisfied
          ? "Approval withdrawn. Consent still satisfied by the remaining approvals."
          : "Approval withdrawn. Peer-originated work is blocked until both sides approve again.",
      );
    },
  },
  {
    name: "audit",
    args: "[since]",
    summary: "tamper-evident log, with chain verification",
    modes: BOTH,
    run: async (ctx, args) => {
      const since = args[0] ? Number(args[0]) : undefined;
      const { records, chainValid, brokenAt } = await ctx.api.audit(ctx.pairingId, since);
      for (const record of records.slice(-20)) {
        ctx.print(`  ${String(record.seq).padStart(4)}  ${record.action}${record.assurance === "pop" ? "" : " [bearer]"}`);
      }
      ctx.print(
        chainValid
          ? "Chain verified from genesis — nothing was edited, reordered or removed."
          : `CHAIN BROKEN at record ${brokenAt}. Treat this as an incident.`,
      );
    },
  },
  {
    name: "budget",
    args: "[--tokens n] [--cost usd] [--deadline iso]",
    summary: "show or set the shared budget",
    modes: BOTH,
    run: async (ctx, args) => {
      const input: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        const value = args[i + 1];
        if (args[i] === "--tokens") input.tokenBudget = value === "none" ? null : Number(value);
        else if (args[i] === "--cost") input.costBudgetUsd = value === "none" ? null : Number(value);
        else if (args[i] === "--deadline") input.deadline = value === "none" ? null : value;
      }
      if (Object.keys(input).length > 0) await ctx.api.setBudget(ctx.pairingId, input);
      const snapshot = await ctx.api.usage(ctx.pairingId);
      ctx.print(formatRunway(snapshot.runway));
    },
  },
  {
    name: "revoke",
    args: "[peer|self] confirm",
    summary: "kill switch — permanent, needs the literal word confirm",
    modes: BOTH,
    run: async (ctx, args) => {
      const target = args[0] === "self" ? "self" : "peer";
      if (args[1] !== "confirm") {
        return ctx.print(`This permanently cuts off ${target === "peer" ? "the peer's" : "your own"} agent. Type /revoke ${target} confirm.`);
      }
      const { revocation } = await ctx.api.revoke(ctx.pairingId, target);
      ctx.print(`Revoked at ${revocation.revokedAt}. The pairing is over.`);
    },
  },

  // ---- cowork -------------------------------------------------------------
  {
    name: "claim",
    args: "<glob...>",
    summary: "tell everyone which files you are touching",
    modes: COWORK,
    run: async (ctx, args) => {
      if (args.length === 0) return ctx.print("Usage: /claim <glob> [glob...]");
      await ctx.api.sendMessage(ctx.pairingId, encode({ kind: "inzo.claim", globs: args }));
    },
  },
  {
    name: "release",
    args: "[glob...]",
    summary: "drop your claims (all of them, if you name none)",
    modes: COWORK,
    run: async (ctx, args) => {
      await ctx.api.sendMessage(ctx.pairingId, encode({ kind: "inzo.release", globs: args }));
    },
  },
  {
    name: "who",
    summary: "who is here, what they hold, where their branch is",
    modes: COWORK,
    run: (ctx) => {
      if (ctx.presence.size === 0) return ctx.print("Nobody has claimed anything yet.");
      for (const member of ctx.presence.values()) {
        const label = member.agentId === ctx.agentId ? "you" : shortAgent(member.agentId);
        ctx.print(`  ${label}  ${member.claims.join(" ") || "(no claims)"}`);
        if (member.status) ctx.print(`      ${member.status}`);
        if (member.head) ctx.print(`      ${member.head.branch} @ ${member.head.sha.slice(0, 7)}`);
      }
    },
  },
  {
    name: "sync",
    summary: "fetch, rebase, commit your claimed files, and announce the SHA",
    modes: COWORK,
    run: async (ctx) => {
      for (const line of await syncOnce(ctx, true)) ctx.print(line);
    },
  },
  {
    name: "handoff",
    args: "[note]",
    summary: "sync, then release your claims so someone else can pick them up",
    modes: COWORK,
    run: async (ctx, args) => {
      for (const line of await syncOnce(ctx, true)) ctx.print(line);
      await ctx.api.sendMessage(ctx.pairingId, encode({ kind: "inzo.release", globs: [] }));
      if (args.length > 0) await ctx.api.sendMessage(ctx.pairingId, args.join(" "));
      ctx.print("Claims released.");
    },
  },

  // ---- acquaintance -------------------------------------------------------
  {
    name: "share",
    args: "<label> <value>",
    summary: "send one labelled fact — the only outbound path besides /say and /ask",
    modes: BOTH,
    run: async (ctx, args) => {
      if (args.length < 2) return ctx.print("Usage: /share <label> <value>");
      await ctx.api.sendMessage(
        ctx.pairingId,
        encode({ kind: "inzo.share", label: args[0], value: args.slice(1).join(" ") }),
      );
    },
  },
  {
    name: "ask",
    args: "<question>",
    summary: "ask the other side a question",
    modes: BOTH,
    run: async (ctx, args) => {
      if (args.length === 0) return ctx.print("Usage: /ask <question>");
      await ctx.api.sendMessage(ctx.pairingId, encode({ kind: "inzo.ask", question: args.join(" ") }));
    },
  },
  {
    name: "mode",
    args: "<cowork|acquaintance>",
    summary: "switch trust mode; acquaintance attenuates the credential itself",
    modes: BOTH,
    run: async (ctx, args) => {
      const next = args[0];
      if (next !== "cowork" && next !== "acquaintance") return ctx.print("Usage: /mode cowork|acquaintance");
      await ctx.setPairingMode(next);
    },
  },
  {
    name: "git",
    args: "<manual|plan|auto-sync|auto>",
    summary: "set the git mode (shift+tab cycles it)",
    modes: COWORK,
    run: (ctx, args) => {
      const next = args[0] as GitMode;
      if (!(next in GIT_MODE_HINT)) return ctx.print("Usage: /git manual|plan|auto-sync|auto");
      ctx.setGitMode(next);
      ctx.print(`git mode: ${next} — ${GIT_MODE_HINT[next]}`);
    },
  },
  {
    name: "quit",
    summary: "leave the shell (the pairing stays open)",
    modes: BOTH,
    run: (ctx) => ctx.quit(),
  },
];

export function commandsFor(mode: Pairing): Command[] {
  return COMMANDS.filter((command) => command.modes.includes(mode));
}

export function findCommand(name: string, mode: Pairing): Command | undefined {
  return commandsFor(mode).find((command) => command.name === name);
}

/**
 * One pass of the git side of cowork: fetch, rebase if behind, commit the files
 * you claimed, push and announce. Shared by `/sync`, `/handoff` and the
 * auto-sync loop so all three obey exactly the same invariants.
 */
export async function syncOnce(ctx: ShellCtx, explicit: boolean): Promise<string[]> {
  const out: string[] = [];
  const mode = ctx.state.git;
  if (mode === "manual" && !explicit) return out;

  const before = await ctx.git.status();
  if (!before.repo) return [`${ctx.cwd} is not a git repository — git commands are off.`];
  if (before.rebaseInProgress || before.mergeInProgress) {
    return ["A rebase or merge is in progress. inzo will not touch git until you finish it."];
  }

  await ctx.git.fetch();
  // Re-read after fetching: the divergence counts from before the fetch are
  // exactly the ones the fetch just invalidated.
  const status = await ctx.git.status();
  if (status.behind > 0 && status.branch) {
    const rebase = await ctx.git.rebase(`origin/${status.branch}`);
    out.push(rebase.ok ? `Rebased onto origin/${status.branch}.` : `Rebase stopped: ${rebase.detail}`);
    if (!rebase.ok) return out;
  }
  if (mode === "plan") return out.length > 0 ? out : ["Fetched. Plan mode makes no commits."];

  const mine = ctx.presence.get(ctx.agentId)?.claims ?? [];
  const paths = collisions(status.dirty, mine);
  if (paths.length === 0) {
    out.push(status.dirty.length > 0 ? "Nothing to commit inside your claims." : "Working tree clean.");
    return out;
  }

  const branch = branchFor(ctx.agentId);
  if (status.branch !== branch) {
    // Your branch and only your branch: never commit onto whatever the peer or
    // the repo happened to leave checked out.
    const checkout = await ctx.git.run("checkout", "-B", branch);
    if (checkout.code !== 0) return [...out, `Cannot switch to ${branch}: ${checkout.stderr.trim()}`];
    out.push(`On ${branch}.`);
  }

  const commit = await ctx.git.commitPaths(paths, `inzo: ${paths.length} file(s) from your claims`);
  if (!commit.committed) return [...out, `No commit: ${commit.reason}`];
  out.push(`Committed ${paths.length} file(s) as ${commit.sha!.slice(0, 7)}.`);

  if (mode === "auto" || explicit) {
    const pushed = await ctx.git.push(branch, branch);
    out.push(pushed.pushed ? `Pushed ${branch}.` : `Not pushed: ${pushed.reason}`);
  }

  await ctx.api.sendMessage(
    ctx.pairingId,
    encode({ kind: "inzo.head", branch, sha: commit.sha!, files: paths }),
  );
  return out;
}

/** In `auto`, merge peer branches whose files do not touch your claims. */
export async function mergePeers(ctx: ShellCtx): Promise<string[]> {
  const out: string[] = [];
  const mine = ctx.presence.get(ctx.agentId)?.claims ?? [];
  for (const member of ctx.presence.values()) {
    if (member.agentId === ctx.agentId || !member.head) continue;
    const overlap = collisions(member.head.files, mine);
    if (overlap.length > 0) {
      out.push(`Not merging ${member.head.branch}: it touches your claim (${overlap.join(", ")}).`);
      continue;
    }
    const merged = await ctx.git.mergeBranch(`origin/${member.head.branch}`);
    if (merged.merged) out.push(`Merged ${member.head.branch}.`);
    else if (merged.conflict) out.push(`Conflict merging ${member.head.branch} — aborted, resolve by hand.`);
  }
  return out;
}

/** The PLAN.md view of the relay plan, ready to write to disk. */
export function planFileText(plan: Plan, handles: Handles): string {
  return renderPlanFile(
    {
      goal: plan.goal,
      items: plan.items.map((item) => ({
        owner: item.owner,
        task: item.task,
        status: item.status ?? "pending",
        ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
      })),
      version: plan.version,
      locked: plan.locked,
      approvedBy: plan.approvedBy,
    },
    handles,
  );
}
