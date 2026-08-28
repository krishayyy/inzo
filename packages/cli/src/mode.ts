import { DEFAULT_SESSION_MODE, MODE_POLICY, SESSION_MODES, type SessionMode } from "inzo-protocol";
import { style } from "./render.js";
import { attach } from "./attach.js";
import { usage } from "./start.js";

/**
 * `inzo mode <mode>` — move the session between research / plan / build /
 * cowork, in any direction.
 *
 * Human-only, and deliberately never exposed as an MCP tool: an agent should
 * not be able to change the rules it operates under. Nothing here touches a
 * credential — scope is fixed at mint and narrows only by the human's own
 * `limit` — so this is free to move in both directions with no re-pairing.
 *
 * The common path rarely needs it: `build` engages by itself the moment the
 * plan locks.
 */
export async function mode(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const wanted = argv.find((arg) => !arg.startsWith("-"));

  // Validated before anything is loaded or fetched: a typo is a usage error,
  // and should say so instantly rather than after a round trip.
  if (wanted !== undefined && !(SESSION_MODES as readonly string[]).includes(wanted)) {
    usage(`mode must be one of: ${SESSION_MODES.join(", ")}`);
  }

  const { api, pairingId } = await attach();

  const { session: current } = await api.session(pairingId);

  if (wanted === undefined) {
    const now = current?.mode ?? DEFAULT_SESSION_MODE;
    if (json) {
      process.stdout.write(`${JSON.stringify({ mode: now, ...MODE_POLICY[now] }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${style.bold(now)}  ${describePolicy(now)}\n`);
    process.stdout.write(`${style.dim(`Change it with: inzo mode <${SESSION_MODES.join("|")}>`)}\n`);
    return;
  }

  const next = wanted as SessionMode;

  // Carry the repo through untouched. Posting a descriptor without it would
  // silently detach every joiner from the shared branch.
  const { session: saved } = await api.setSession(pairingId, { mode: next, repo: current?.repo ?? null });

  if (json) {
    process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${style.green("Mode:")} ${style.bold(saved.mode)}  ${describePolicy(saved.mode)}\n`);
  process.stdout.write(`${style.dim("Every member's watch shows the change. No credential changed.")}\n`);
}

function describePolicy(m: SessionMode): string {
  const policy = MODE_POLICY[m];
  const parts = [
    policy.readonly ? "sandbox read-only" : "sandbox read-write",
    policy.network ? "network on" : "no network",
  ];
  if (policy.enforceItemOwnership) parts.push("own items only");
  return style.dim(`(${parts.join(", ")})`);
}
