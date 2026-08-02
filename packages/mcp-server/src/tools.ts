import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { relayClient } from "./relayClient.js";
import { requirePairingId, sessionState, setIdentity } from "./sessionState.js";

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

function requireToken(): string {
  if (!sessionState.agentToken) throw new Error("No agent credential is available. Pair this agent first.");
  return sessionState.agentToken;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "create_pairing_code",
    {
      title: "Create pairing code",
      description:
        "Generate a short pairing code to share with a teammate so their agent can join and pair with yours. Stores the resulting pairing as the active pairing for this session.",
      inputSchema: {},
    },
    async () => {
      try {
        const pairingCode = await relayClient.createPairing();
        setIdentity(pairingCode.agentId, pairingCode.agentToken, null);
        return textResult({
          code: pairingCode.code,
          expiresAt: pairingCode.expiresAt,
          message: `Share this code with your teammate: ${pairingCode.code}. Once they've joined with it, call check_pairing_code with this same code to pick up the active pairing on your side.`,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "join_pairing",
    {
      title: "Join pairing",
      description:
        "Join a pairing using a code a teammate shared with you. Sets the resulting pairing as the active pairing for this session.",
      inputSchema: {
        code: z.string().min(1).describe("The pairing code shared by your teammate"),
      },
    },
    async ({ code }) => {
      try {
        const pairing = await relayClient.joinPairing(code);
        setIdentity(pairing.agentId, pairing.agentToken, pairing.pairingId);
        return textResult({ pairingId: pairing.pairingId, peerAgentId: pairing.peerAgentId, message: "Joined pairing successfully." });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "check_pairing_code",
    {
      title: "Check pairing code",
      description:
        "For the side that created a pairing code with create_pairing_code: check whether a teammate has joined yet. If they have, sets the resulting pairing as the active pairing for this session. Call this again (e.g. after a short wait) if it hasn't been joined yet.",
      inputSchema: {
        code: z.string().min(1).describe("The pairing code you generated with create_pairing_code"),
      },
    },
    async ({ code }) => {
      try {
        if (!sessionState.agentToken) throw new Error("Create a pairing code in this session first.");
        const { pairing } = await relayClient.getMine(sessionState.agentToken);
        if (!pairing) {
          return textResult({
            joined: false,
            message: "Your teammate hasn't joined with this code yet. Try again shortly.",
          });
        }
        setIdentity(sessionState.agentId, sessionState.agentToken, pairing.id);
        return textResult({ joined: true, pairingId: pairing.id, pairing });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description: "Send a message to your paired agent in the active pairing's shared thread.",
      inputSchema: {
        text: z.string().min(1).describe("The message text to send to the paired agent"),
      },
    },
    async ({ text }) => {
      try {
        const pairingId = requirePairingId();
        if (!sessionState.agentToken) throw new Error("No agent credential is available.");
        const { message } = await relayClient.sendMessage(pairingId, sessionState.agentToken, text);
        return textResult(message);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get thread",
      description:
        "Fetch the conversation so far in the active pairing, optionally only messages since a given cursor. Use this to reason about what's been discussed and to show the human the live conversation.",
      inputSchema: {
        since: z
          .number()
          .optional()
          .describe("Cursor returned from a previous get_thread call; omit to fetch the full thread"),
      },
    },
    async ({ since }) => {
      try {
        const pairingId = requirePairingId();
        const result = await relayClient.getMessages(pairingId, requireToken(), since);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "propose_plan",
    {
      title: "Propose plan",
      description:
        "Propose a shared goal and task split to the paired agent. Both humans must approve via approve_plan before the plan is locked in.",
      inputSchema: {
        goal: z.string().min(1).describe("The shared goal both agents/humans are working toward"),
        tasks: z
          .array(
            z.object({
              owner: z.string().min(1).describe("Who owns this task, e.g. an agentId or human name"),
              task: z.string().min(1).describe("Description of the task"),
            }),
          )
          .min(1)
          .describe("The proposed task split"),
      },
    },
    async ({ goal, tasks }) => {
      try {
        const pairingId = requirePairingId();
        const { plan } = await relayClient.proposePlan(pairingId, requireToken(), goal, tasks);
        return textResult(plan);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "approve_plan",
    {
      title: "Approve plan",
      description:
        "Record this side's human approval of the current proposed plan. Once both sides approve, the plan becomes locked. This should only be called after the human on this side has explicitly signed off.",
      inputSchema: {},
    },
    async () => {
      try {
        const pairingId = requirePairingId();
        const { plan } = await relayClient.approvePlan(pairingId, requireToken());
        return textResult(plan);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_plan",
    {
      title: "Get plan",
      description: "Fetch the current plan for the active pairing, including approval and lock status.",
      inputSchema: {},
    },
    async () => {
      try {
        const pairingId = requirePairingId();
        const { plan } = await relayClient.getPlan(pairingId, requireToken());
        return textResult(plan ?? { message: "No plan has been proposed yet." });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "report_usage",
    {
      title: "Report usage",
      description:
        "Report this agent's own token usage, cost, elapsed time, and task progress back to the pairing, so both sides can see combined usage and remaining runway.",
      inputSchema: {
        tokens: z.number().nonnegative().describe("Total tokens used so far by this agent"),
        cost: z.number().nonnegative().describe("Estimated cost in USD so far by this agent"),
        seconds: z.number().nonnegative().describe("Elapsed wall-clock seconds this agent has been working"),
        progressPct: z
          .number()
          .min(0)
          .max(100)
          .describe("This agent's estimated progress toward its assigned tasks, 0-100"),
      },
    },
    async ({ tokens, cost, seconds, progressPct }) => {
      try {
        const pairingId = requirePairingId();
        const { usage } = await relayClient.reportUsage(pairingId, requireToken(), {
          agentId: sessionState.agentId,
          tokensUsed: tokens,
          costUsd: cost,
          wallClockMs: Math.round(seconds * 1000),
          progressPct,
        });
        return textResult(usage);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get usage",
      description: "Fetch combined token/cost/time/progress usage for both sides of the active pairing.",
      inputSchema: {},
    },
    async () => {
      try {
        const pairingId = requirePairingId();
        const { usage } = await relayClient.getUsage(pairingId, requireToken());
        return textResult(usage);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
