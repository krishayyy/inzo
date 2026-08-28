import { DockerUnavailableError, runInSandbox } from "inzo-sandbox";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateHolderKeyPair, isExpiring, publicJwkFromPem, signConsent } from "inzo-holder";
import { DEFAULT_SESSION_MODE, MODE_POLICY, SESSION_MODES, type SessionMode } from "inzo-protocol";
import { playbookFor } from "./playbooks.js";
import { relayClient, type Auth, type Scope } from "./relayClient.js";
import {
  requireHolderKey,
  requirePairingId,
  requireToken,
  sessionState,
  setCredential,
  setIdentity,
  setPairingId,
  setScope,
} from "./sessionState.js";
import { resolveWorkspace } from "./workspace.js";

/**
 * How this session authenticates.
 *
 * Prefers the v3 signed credential and falls back to the v2 bearer token, so a
 * session paired before v3 keeps working rather than breaking on upgrade.
 *
 * A v3 credential nearing expiry is silently renewed first, via attenuation
 * to the same scope and the same holder key — narrowing to yourself is a
 * no-op capability-wise, so this can't be used to widen anything. Without
 * this, a pairing that's idle for longer than the credential's TTL hard-fails
 * every tool call with no recovery but a full re-pair; a human-paced,
 * asynchronous conversation hits that gap routinely.
 */
async function auth(): Promise<Auth | string> {
  if (sessionState.credential && sessionState.holderPrivateKey) {
    if (isExpiring(sessionState.credential, 5 * 60)) {
      try {
        const current: Auth = { kind: "v3", credential: sessionState.credential, privateKeyPem: sessionState.holderPrivateKey };
        const jwk = publicJwkFromPem(sessionState.holderPrivateKey);
        const renewed = await relayClient.attenuate(current, sessionState.scope, { jwk });
        setCredential(renewed.credential);
      } catch {
        // Best-effort. If the credential is already past expiry, renewal
        // itself fails proof-of-possession — fall through with what's held
        // so the caller gets the relay's own clear "expired" error instead
        // of this masking it with a different failure.
      }
    }
    return { kind: "v3", credential: sessionState.credential, privateKeyPem: sessionState.holderPrivateKey };
  }
  return requireToken();
}

const SCOPES = [
  "messages:read",
  "messages:send",
  "plan:propose",
  "plan:approve",
  "usage:report",
  "commands:run",
] as const;

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * The session's current mode, as last read from the relay.
 *
 * A cache, and treated like one: every decision that actually enforces
 * something — the sandbox mount, the ownership gate — refreshes it first
 * rather than trusting this value. It exists so `tools/list` can be gated
 * without a network round trip on every listing.
 */
let currentMode: SessionMode = DEFAULT_SESSION_MODE;

/**
 * Tools whose presence depends on the mode.
 *
 * `plan` mode drops `run_shared_command` entirely rather than registering one
 * that errors: a tool absent from `tools/list` is never called, never costs
 * tokens, and never needs an error message explaining itself.
 */
const MODE_TOOLS: Record<SessionMode, string[]> = {
  research: ["run_shared_command"],
  plan: ["propose_plan", "approve_plan"],
  build: ["propose_plan", "approve_plan", "update_item_status", "run_shared_command"],
  cowork: ["propose_plan", "approve_plan", "update_item_status", "run_shared_command"],
};

const gated = new Map<string, RegisteredTool>();

function applyModeGating(mode: SessionMode): void {
  const allowed = new Set(MODE_TOOLS[mode] ?? MODE_TOOLS.cowork);
  for (const [name, tool] of gated) {
    if (allowed.has(name)) tool.enable();
    else tool.disable();
  }
}

/** Reads the mode from the relay and re-gates the tool surface if it moved. */
async function refreshMode(pairingId: string, token: Auth | string): Promise<SessionMode> {
  try {
    const { session } = await relayClient.getSession(pairingId, token);
    const mode = session?.mode ?? DEFAULT_SESSION_MODE;
    if (mode !== currentMode) {
      currentMode = mode;
      applyModeGating(mode);
    }
    return mode;
  } catch {
    // A relay that cannot answer must not silently widen the sandbox. Keep
    // the mode already in force.
    return currentMode;
  }
}

export function getCurrentMode(): SessionMode {
  return currentMode;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "get_session",
    {
      description:
        "Where the team is: mode, repo, branch, members, plan, playbook. Call after any gap.",
      inputSchema: {},
    },
    async () => {
      try {
        const pairingId = requirePairingId();
        const token = await auth();
        const mode = await refreshMode(pairingId, token);
        const { session } = await relayClient.getSession(pairingId, token);
        const { pairing } = await relayClient.getMine(token);
        const { plan } = await relayClient.getPlan(pairingId, token);
        return textResult({
          mode,
          repo: session?.repo ?? null,
          you: sessionState.agentId,
          members: pairing?.members ?? [],
          revoked: pairing?.revoked ?? false,
          sandbox: MODE_POLICY[mode],
          plan,
          playbook: playbookFor(mode),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      description: "Message the other agents. Both humans see it live.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      try {
        const { message } = await relayClient.sendMessage(requirePairingId(), await auth(), text);
        return textResult(message);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_digest",
    {
      description:
        "Catch up: plan, consent, runway, recent messages. full:true returns the whole thread instead.",
      inputSchema: { limit: z.number().optional(), full: z.boolean().optional() },
    },
    async ({ limit, full }) => {
      try {
        const pairingId = requirePairingId();
        const token = await auth();
        if (full) return textResult(await relayClient.getMessages(pairingId, token, limit));
        return textResult(await relayClient.getDigest(pairingId, token, limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  gated.set(
    "propose_plan",
    server.registerTool(
      "propose_plan",
      {
        description:
          "Propose a goal and task split. Owners are member agentIds; dependsOn holds earlier indices. Re-proposing resets approvals.",
        inputSchema: {
          goal: z.string(),
          tasks: z
            .array(
              z.object({
                owner: z.string(),
                task: z.string(),
                dependsOn: z.array(z.number()).optional(),
              }),
            )
            .min(1),
        },
      },
      async ({ goal, tasks }) => {
        try {
          const { plan } = await relayClient.proposePlan(requirePairingId(), await auth(), goal, tasks);
          return textResult(plan);
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  gated.set(
    "approve_plan",
    server.registerTool(
      "approve_plan",
      {
        description:
          "Record the human's approval of a plan version. Their act, never yours — see the playbook.",
        inputSchema: { planVersion: z.number() },
      },
      async ({ planVersion }) => {
        try {
          const pairingId = requirePairingId();

          // Re-fetch and re-hash the plan locally. Signing a digest supplied by
          // the relay would let a hostile relay collect a signature over text
          // this side never rendered.
          const { plan: current } = await relayClient.getPlan(pairingId, await auth());
          if (!current) throw new Error("No plan has been proposed yet.");
          if (current.version !== planVersion) {
            throw new Error(
              `Plan version ${planVersion} is stale; the current plan is version ${current.version}. Re-read it before approving.`,
            );
          }

          const { credential, privateKeyPem } = requireHolderKey();
          void credential;
          const { signature } = signConsent(privateKeyPem, {
            pairingId,
            goal: current.goal,
            items: current.items,
            version: current.version,
          });
          const { plan, consent } = await relayClient.approvePlan(pairingId, await auth(), planVersion, signature);

          // The relay advances research/plan to build the moment consent is
          // unanimous. Pick that up now so the tool surface matches the phase
          // the team is actually in, rather than a listing later.
          const mode = await refreshMode(pairingId, await auth());
          const advanced = { mode, playbook: playbookFor(mode) };
          if (consent) return textResult({ plan, consent, session: advanced });
          return textResult({ plan, session: advanced });
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  gated.set(
    "update_item_status",
    server.registerTool(
      "update_item_status",
      {
        description:
          "Mark progress on an item you own. Never touches the plan version or consent.",
        inputSchema: {
          itemIndex: z.number(),
          status: z.enum(["pending", "in_progress", "done"]),
        },
      },
      async ({ itemIndex, status }) => {
        try {
          const { plan } = await relayClient.updateItemStatus(requirePairingId(), await auth(), itemIndex, status);
          return textResult(plan);
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  gated.set(
    "run_shared_command",
    server.registerTool(
      "run_shared_command",
      {
        description:
          "Run a command in a Docker sandbox over INZO_WORKSPACE; itemIndex required in build mode. No host path; refused without Docker.",
        inputSchema: {
          command: z.string(),
          args: z.array(z.string()).optional(),
          origin: z
            .string()
            .default("peer")
            .describe("'self', 'peer', or a member agentId"),
          itemIndex: z.number().optional(),
          timeoutSeconds: z.number().optional(),
        },
      },
      async ({ command, args, origin, itemIndex, timeoutSeconds }) => {
        try {
          const pairingId = requirePairingId();
          const token = await auth();

          // The mode decides whether the mount is writable, so it is read
          // fresh here rather than trusted from cache. A stale "cowork" would
          // hand a research session a read-write workspace.
          const mode = await refreshMode(pairingId, token);
          const policy = MODE_POLICY[mode];

          // A peer-originated command is only allowed while the peer's own
          // credential still authorizes it. Checked live, not from cache: the
          // whole value of the kill switch is that it takes effect immediately.
          if (origin !== "self") {
            const { pairing } = await relayClient.getMine(token);
            if (!pairing) throw new Error("No active pairing.");
            if (origin === "peer") {
              if (pairing.peerAgentId === null) {
                throw new Error(
                  `"peer" is ambiguous for a pairing with ${pairing.members?.length ?? "more than 2"} members — pass the specific member agentId as origin instead.`,
                );
              }
            } else if (!pairing.members?.includes(origin)) {
              throw new Error(`"${origin}" is not a member of this pairing.`);
            } else {
              // 3+ member pairings: this relay build does not yet expose a
              // per-member live scope/revocation check the way it does for
              // the 2-member "peer" path below, and the check must never be
              // silently skipped — refuse rather than run unchecked work.
              throw new Error(
                `Running a command on behalf of a specific non-peer member ("${origin}") is not yet supported — only 'self' and 'peer' (2-member pairings) can run shared commands today.`,
              );
            }
            if (pairing.peerRevoked) {
              throw new Error("The peer's credential has been revoked. Refusing to run their command.");
            }
            // PROTOCOL.md §8: an agent may not act on a plan its humans have
            // not both approved. Capability says the peer *may* run commands;
            // consent says they may run THIS work. Both are required, and this
            // is the check that makes the approval gate load-bearing rather
            // than decorative.
            const { consent } = await relayClient.getConsent(pairingId, token);
            if (!consent || !consent.satisfied) {
              return errorResult(
                consent
                  ? `The current plan (version ${consent.subject.version}) is not approved by both humans. Refusing to run peer-originated work until consent is satisfied.`
                  : "No plan has been approved for this pairing. Refusing to run peer-originated work.",
              );
            }

            if (!(pairing.peerScope ?? []).includes("commands:run")) {
              throw new Error(
                "The peer's credential does not carry 'commands:run'. Refusing to run a command on their behalf.",
              );
            }
          }

          if (policy.enforceItemOwnership) {
            await assertItemIsMine(pairingId, token, itemIndex);
          }

          const workdir = resolveWorkspace();
          const result = await runInSandbox({
            command,
            args,
            workdir,
            readonly: policy.readonly,
            network: policy.network,
            timeoutMs: timeoutSeconds ? Math.round(timeoutSeconds * 1000) : undefined,
          });

          return textResult({
            pairingId,
            sandboxed: true,
            workdir,
            mode,
            network: policy.network,
            readonly: policy.readonly,
            ...result,
          });
        } catch (err) {
          if (err instanceof DockerUnavailableError) {
            return errorResult(
              new Error(
                `${err.message} Inzo will not run a shared command outside the sandbox, so this command was not run at all.`,
              ),
            );
          }
          return errorResult(err);
        }
      },
    ),
  );

  registerAdmin(server);
  applyModeGating(currentMode);
}

/**
 * The build-mode gate: you may only act on an item you own, once everything it
 * depends on is done.
 *
 * Enforced here rather than at the relay because the relay cannot see which
 * item a shell command serves — only the caller can say. That makes this a
 * guard rail for an honest agent, not a boundary against a hostile one; the
 * boundary against a hostile peer is consent, which the relay does enforce.
 */
async function assertItemIsMine(pairingId: string, token: Auth | string, itemIndex: number | undefined): Promise<void> {
  const { plan } = await relayClient.getPlan(pairingId, token);
  if (!plan) throw new Error("Build mode: no plan exists, so there is no item this command could serve.");
  if (!plan.locked) throw new Error("Build mode: the plan is not locked yet. Wait for both humans to approve it.");
  if (itemIndex === undefined) {
    throw new Error(
      "Build mode: pass itemIndex — the plan item this command serves. You may only act on items you own.",
    );
  }
  const item = plan.items[itemIndex];
  if (!item) throw new Error(`Build mode: the plan has no item at index ${itemIndex}.`);
  if (item.owner !== sessionState.agentId) {
    throw new Error(`Build mode: item ${itemIndex} is owned by ${item.owner}, not you. Work on your own items.`);
  }
  const blocking = (item.dependsOn ?? []).filter((dep) => plan.items[dep]?.status !== "done");
  if (blocking.length > 0) {
    throw new Error(`Build mode: item ${itemIndex} depends on ${blocking.join(", ")}, which are not done yet.`);
  }
}

/**
 * Eight rare tools behind one.
 *
 * Tool *definitions* are re-sent on every single request for the life of the
 * session, whether or not Inzo is used that turn — they were the largest fixed
 * cost in the system by a wide margin. Folding the cold path into one action
 * enum trades a little dispatch clarity for a cost the user pays continuously,
 * which is the right side of that trade. The hot path stays first-class.
 */
const ADMIN_ACTIONS = [
  "create_pairing",
  "join",
  "check_pairing",
  "pairing_status",
  "invite",
  "runway",
  "report_usage",
  "set_budget",
  "limit_scope",
  "revoke",
  "withdraw_consent",
  "audit_log",
] as const;

function registerAdmin(server: McpServer): void {
  server.registerTool(
    "inzo_admin",
    {
      description:
        "Off the hot path; args go in `params`. Start with create_pairing, or join {code}. Errors name any missing field.",
      inputSchema: {
        action: z.enum(ADMIN_ACTIONS),
        params: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ action, params }) => {
      const p = (params ?? {}) as Record<string, unknown>;
      try {
        switch (action) {
          case "create_pairing": {
            // The private half never leaves this machine; the relay only ever
            // sees the public key it binds the credential to.
            const holder = generateHolderKeyPair();
            const created = await relayClient.createPairing({ jwk: holder.publicJwk });
            setIdentity(created.agentId, created.agentToken, null, created.scope, {
              credential: created.credential,
              holderPrivateKey: created.credential ? holder.privateKeyPem : null,
              principalId: created.principalId,
            });
            return textResult({
              code: created.code,
              expiresAt: created.expiresAt,
              message: `Share this code: ${created.code}. Then inzo_admin{action:"check_pairing"} once they join.`,
            });
          }
          case "join": {
            const code = p.code;
            if (typeof code !== "string" || code === "") throw new Error("join needs params.code, the teammate's pairing code");
            const holder = generateHolderKeyPair();
            const pairing = await relayClient.joinPairing(code, { jwk: holder.publicJwk });
            setIdentity(pairing.agentId, pairing.agentToken, pairing.pairingId, pairing.scope, {
              credential: pairing.credential,
              holderPrivateKey: pairing.credential ? holder.privateKeyPem : null,
              principalId: pairing.principalId,
            });
            const joinedMode = await refreshMode(pairing.pairingId, await auth());
            return textResult({
              pairingId: pairing.pairingId,
              agentId: pairing.agentId,
              members: pairing.members,
              mode: joinedMode,
              playbook: playbookFor(joinedMode),
            });
          }
          case "check_pairing": {
            const { pairing } = await relayClient.getMine(await auth());
            if (!pairing) return textResult({ joined: false, message: "Nobody has joined with this code yet." });
            setPairingId(pairing.id);
            setScope(pairing.scope);
            const mode = await refreshMode(pairing.id, await auth());
            return textResult({ joined: true, pairing, mode, playbook: playbookFor(mode) });
          }
          case "pairing_status": {
            const { pairing } = await relayClient.getMine(await auth());
            return textResult(pairing ?? { message: "No active pairing." });
          }
          case "invite": {
            const invite = await relayClient.inviteToPairing(requirePairingId(), await auth());
            return textResult({ ...invite, message: `Share this code: ${invite.code}. They call join_pairing with it.` });
          }
          case "runway":
            return textResult(await relayClient.getUsage(requirePairingId(), await auth()));
          case "report_usage": {
            const snapshot = await relayClient.reportUsage(requirePairingId(), await auth(), {
              tokensUsed: num(p.tokens, "tokens"),
              costUsd: num(p.cost, "cost"),
              wallClockMs: Math.round(num(p.seconds, "seconds") * 1000),
              progressPct: num(p.progressPct, "progressPct"),
            });
            return textResult(snapshot);
          }
          case "set_budget": {
            const { budget } = await relayClient.setBudget(requirePairingId(), await auth(), {
              deadline: p.deadline as string | null | undefined,
              tokenBudget: p.tokenBudget as number | null | undefined,
              costBudgetUsd: p.costBudgetUsd as number | null | undefined,
            });
            return textResult(budget);
          }
          case "limit_scope": {
            const keep = p.keep;
            if (!Array.isArray(keep) || keep.length === 0 || keep.some((s) => !SCOPES.includes(s as never))) {
              throw new Error(`limit_scope needs keep: a non-empty array from ${SCOPES.join(", ")}`);
            }
            const { scope } = await relayClient.narrowScope(await auth(), keep as Scope[]);
            setScope(scope);
            return textResult({ scope, message: "Scope narrowed. This cannot be undone for this credential." });
          }
          case "revoke": {
            const target = p.target;
            if (target !== "peer" && target !== "self") throw new Error("revoke needs target: 'peer' or 'self'");
            const { revocation } = await relayClient.revoke(requirePairingId(), await auth(), target);
            return textResult({ revocation, message: `Revoked ${target}. This is permanent.` });
          }
          case "withdraw_consent": {
            const { consent } = await relayClient.withdrawConsent(requirePairingId(), await auth());
            return textResult({
              consent,
              message: "Approval withdrawn. Peer-originated work is blocked until both humans approve again.",
            });
          }
          case "audit_log":
            return textResult(
              await relayClient.getAudit(
                requirePairingId(),
                await auth(),
                p.since === undefined ? undefined : num(p.since, "since"),
              ),
            );
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

/** Exported for the mode-gating and token-budget tests, and for auth's own. */
export { auth, sessionState, applyModeGating, MODE_TOOLS, ADMIN_ACTIONS, SESSION_MODES };
