import { createInterface } from "node:readline/promises";
import { signConsent } from "inzo-holder";
import { createApi, type Api, type Message, type PresenceEntry } from "./api.js";
import {
  formatMessage,
  formatPairing,
  formatPlan,
  formatPresence,
  formatRunway,
  heading,
  shortMember,
  style,
} from "./render.js";
import { loadSession, requirePairing, type SessionFile } from "./session.js";
import { subscribe } from "./sse.js";

export interface Ctx {
  api: Api;
  pairingId: string;
  agentId: string;
  /** Needed to sign an approval locally; never sent anywhere. */
  session: SessionFile;
  out: (line: string) => void;
}

function context(): Ctx {
  const session = loadSession();
  return {
    api: createApi(session),
    pairingId: requirePairing(session),
    agentId: session.agentId,
    session,
    // eslint-disable-next-line no-console
    out: (line: string) => console.log(line),
  };
}

/** One-shot snapshot: who you are paired with, the plan, and the runway. */
export async function status(ctx = context()): Promise<void> {
  const [{ pairing }, { plan }, snapshot] = await Promise.all([
    ctx.api.mine(),
    ctx.api.plan(ctx.pairingId),
    ctx.api.usage(ctx.pairingId),
  ]);
  if (!pairing) throw new Error("No active pairing.");

  ctx.out(formatPairing(pairing));
  ctx.out(heading("Plan"));
  ctx.out(formatPlan(plan, pairing.agentId, pairing.peerAgentId, pairing.members));
  ctx.out(heading("Runway"));
  ctx.out(formatRunway(snapshot.runway));
}

/**
 * Live view. This is the surface that makes "both humans watch it happen"
 * true rather than a claim in a README.
 */
export async function watch(ctx = context(), signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  process.once("SIGINT", () => controller.abort());

  const { pairing } = await ctx.api.mine();
  if (!pairing) throw new Error("No active pairing.");

  // Backfill first so a viewer joining late sees the whole negotiation, not
  // just whatever happens to arrive after they connected.
  const history = await ctx.api.messages(ctx.pairingId);
  ctx.out(formatPairing(pairing));

  // A snapshot before the stream opens, so a late viewer sees who is where
  // rather than an empty panel until someone next syncs.
  const presence = new Map<string, PresenceEntry>();
  try {
    for (const entry of (await ctx.api.presence(ctx.pairingId)).presence) presence.set(entry.agentId, entry);
  } catch {
    // Presence is a hint. An older relay that has never heard of it must not
    // stop `watch` from showing the thread, the plan, and the runway.
  }
  if (presence.size > 0) {
    ctx.out(heading("Presence"));
    ctx.out(formatPresence([...presence.values()], ctx.agentId));
  }

  ctx.out(heading("Thread"));
  for (const message of history.messages) ctx.out(formatMessage(message, ctx.agentId));
  ctx.out(style.dim("\nwatching live — ctrl-c to stop\n"));

  try {
    for await (const event of subscribe(ctx.api.streamUrl(ctx.pairingId), controller.signal)) {
      switch (event.event) {
        case "message.created":
          ctx.out(formatMessage((event.data as { message: Message }).message, ctx.agentId));
          break;
        case "plan.updated": {
          const { plan } = event.data as { plan: Parameters<typeof formatPlan>[0] };
          ctx.out(heading("Plan updated"));
          ctx.out(formatPlan(plan, pairing.agentId, pairing.peerAgentId, pairing.members));
          if (plan && !plan.locked && !plan.approvedBy.includes(ctx.agentId)) {
            ctx.out(style.yellow(`\nRun \`inzo approve\` to sign off on v${plan.version}.\n`));
          }
          break;
        }
        case "usage.reported":
          ctx.out(style.dim(formatRunway((event.data as { runway: Parameters<typeof formatRunway>[0] }).runway)));
          break;
        case "budget.updated":
          ctx.out(style.dim("Budget updated."));
          break;
        case "session.updated": {
          const { session } = event.data as { session: { mode: string } };
          ctx.out(style.cyan(`\nMode is now ${style.bold(session.mode)}.\n`));
          break;
        }
        case "presence.updated": {
          const { presence: entry } = event.data as { presence: PresenceEntry };
          presence.set(entry.agentId, entry);
          ctx.out(heading("Presence"));
          ctx.out(formatPresence([...presence.values()], ctx.agentId));
          break;
        }
        case "pairing.revoked": {
          const { revocation } = event.data as { revocation: { revokedAgentId: string; by: string } };
          const mine = revocation.revokedAgentId === ctx.agentId;
          const who = mine ? "YOUR agent" : shortMember(revocation.revokedAgentId);
          const by = revocation.by === ctx.agentId ? "you" : shortMember(revocation.by);
          ctx.out(style.red(`\n!! ${who} was revoked by ${by}.\n`));
          // Past two people, one member leaving is not the end of the session
          // — the rest are still working, and closing their view would be
          // wrong. Only stop watching when the ejected agent is this one.
          if (mine || (pairing.members?.length ?? 2) <= 2) {
            ctx.out(style.red("The pairing is over.\n"));
            controller.abort();
            return;
          }
          break;
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    throw err;
  }
}

/**
 * The human approval gate. Prints the exact plan text and requires a typed
 * confirmation before recording consent, then approves that specific version
 * — so consent is always attached to text a human actually read.
 */
export async function approve(ctx = context(), confirm = askYesNo): Promise<void> {
  const [{ pairing }, { plan }] = await Promise.all([ctx.api.mine(), ctx.api.plan(ctx.pairingId)]);
  if (!pairing) throw new Error("No active pairing.");
  if (!plan) throw new Error("No plan has been proposed yet — nothing to approve.");
  if (plan.locked) {
    ctx.out(style.green("This plan is already locked in by both sides."));
    return;
  }
  if (plan.approvedBy.includes(pairing.agentId)) {
    ctx.out(style.dim(`You already approved v${plan.version}. Waiting on the other side.`));
    return;
  }

  ctx.out(heading(`Plan v${plan.version} — proposed by ${plan.proposedBy === pairing.agentId ? "your agent" : "the peer"}`));
  ctx.out(formatPlan(plan, pairing.agentId, pairing.peerAgentId, pairing.members));

  if (!(await confirm(`\nApprove v${plan.version}?`))) {
    ctx.out(style.dim("Not approved. Nothing was recorded."));
    return;
  }

  if (!ctx.api.canSignConsent()) {
    throw new Error(
      "This session has no signing key, so it cannot produce a verifiable approval. Re-pair from your agent to upgrade it.",
    );
  }

  // Sign the plan THIS terminal just rendered, hashed locally. Signing a digest
  // supplied by the relay would let a hostile relay collect a signature over
  // text the human never saw — which is the whole thing consent exists to stop.
  const { signature } = signConsent(ctx.session.holderPrivateKey!, {
    pairingId: ctx.pairingId,
    goal: plan.goal,
    items: plan.items,
    version: plan.version,
  });

  const result = await ctx.api.approve(ctx.pairingId, plan.version, signature);
  ctx.out(
    result.plan.locked
      ? style.green("Both sides approved. The plan is locked in.")
      : style.yellow("Your approval is recorded. Waiting on the other side."),
  );
  if (result.consent) {
    ctx.out(style.dim(`Consent ${result.consent.satisfied ? "satisfied" : "pending"} · ${result.consent.subject.hash}`));
  }
}

/**
 * Pulls this side's approval back.
 *
 * Deliberately needs no confirmation and no cooperation from the peer:
 * withdrawing consent is the safe direction, and the moment you want it is the
 * moment you have stopped trusting what is happening.
 */
export async function withdraw(ctx = context()): Promise<void> {
  const { consent } = await ctx.api.withdrawConsent(ctx.pairingId);
  ctx.out(style.yellow("Approval withdrawn."));
  ctx.out(
    style.dim(
      consent.satisfied
        ? "Consent is still satisfied by the remaining approvals."
        : "Peer-originated work is blocked until both sides approve again.",
    ),
  );
}

/** Prints the tamper-evident log, and says loudly if the chain is broken. */
export async function audit(args: string[], ctx = context()): Promise<void> {
  const flags = parseFlags(args);
  const since = flags.since ? Number(flags.since) : undefined;
  const { records, chainValid, brokenAt, issuer } = await ctx.api.audit(ctx.pairingId, since);

  ctx.out(heading(`Audit log — ${records.length} record${records.length === 1 ? "" : "s"} · ${issuer}`));
  for (const record of records) {
    const who = record.actor.principal ?? record.actor.agent ?? "—";
    const mark = record.assurance === "pop" ? "" : style.yellow(" [bearer]");
    ctx.out(`${style.dim(String(record.seq).padStart(4))}  ${record.at}  ${record.action}${mark}  ${style.dim(who)}`);
  }

  ctx.out(
    chainValid
      ? style.green("\nChain verified from genesis — no record was edited, reordered, or removed.")
      : style.red(`\nCHAIN BROKEN at record ${brokenAt}. Records were altered after the fact. Treat this as an incident.`),
  );
}

/**
 * The kill switch, with a confirmation because it cannot be undone.
 *
 * `peer` stays as a 2-member alias — it is in the published README — but it is
 * meaningless with five people, so a specific member agentId is accepted and
 * is the right answer past two. Resolving `peer` against the real membership
 * here (rather than letting the relay guess) means a 3+ member pairing gets a
 * message naming its members instead of an opaque 400.
 */
export async function revoke(target: string, ctx = context(), confirm = askYesNo): Promise<void> {
  const { pairing } = await ctx.api.mine();
  if (!pairing) throw new Error("No active pairing.");

  const members = pairing.members ?? [];
  let subject: string;
  if (target === "self") {
    subject = "your own agent";
  } else if (target === "peer") {
    if (members.length > 2) {
      throw new Error(
        `"peer" is ambiguous in a ${members.length}-member pairing. Name the member: ` +
          members.filter((id) => id !== pairing.agentId).map(shortMember).join(", "),
      );
    }
    subject = "the peer's agent";
  } else if (members.length > 0 && !members.includes(target)) {
    // Also matched on the short form, since that is what `status` prints.
    const full = members.find((id) => shortMember(id) === target);
    if (!full) throw new Error(`"${target}" is not a member of this pairing. Members: ${members.map(shortMember).join(", ")}`);
    target = full;
    subject = shortMember(full);
  } else {
    subject = shortMember(target);
  }

  ctx.out(style.red(`This immediately and permanently cuts off ${subject}. It cannot be undone.`));
  if (!(await confirm("Revoke?"))) {
    ctx.out(style.dim("Cancelled. Nothing was revoked."));
    return;
  }
  const { revocation } = await ctx.api.revoke(ctx.pairingId, target);
  ctx.out(style.red(`Revoked ${subject} at ${revocation.revokedAt}.`));
  if (members.length > 2) {
    ctx.out(style.dim(`${members.length - 1} member(s) remain in this pairing.`));
  }
}

export async function budget(args: string[], ctx = context()): Promise<void> {
  const flags = parseFlags(args);
  const input: Record<string, unknown> = {};
  if ("deadline" in flags) input.deadline = flags.deadline === "none" ? null : flags.deadline;
  if ("tokens" in flags) input.tokenBudget = flags.tokens === "none" ? null : Number(flags.tokens);
  if ("cost" in flags) input.costBudgetUsd = flags.cost === "none" ? null : Number(flags.cost);

  if (Object.keys(input).length === 0) {
    const snapshot = await ctx.api.usage(ctx.pairingId);
    ctx.out(formatRunway(snapshot.runway));
    return;
  }

  await ctx.api.setBudget(ctx.pairingId, input);
  const snapshot = await ctx.api.usage(ctx.pairingId);
  ctx.out(formatRunway(snapshot.runway));
}

export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (args[i + 1] && !args[i + 1].startsWith("--")) flags[arg.slice(2)] = args[++i];
    else flags[arg.slice(2)] = "true";
  }
  return flags;
}

/**
 * Never prompts when stdin is not a TTY.
 *
 * A confirmation that blocks forever in CI is the worst available failure —
 * it looks like a hang, not a refusal, and the job dies on a timeout with
 * nothing useful in the log. Refusing loudly is strictly better, and the
 * caller can pass --yes to say what it wants up front.
 */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${question} — but stdin is not a terminal, so this cannot be confirmed interactively. Re-run it in a terminal.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
