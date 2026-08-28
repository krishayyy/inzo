import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODE_POLICY, SESSION_MODES } from "inzo-protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { applyModeGating, registerTools } from "../src/tools.js";

/**
 * The resident cost of this MCP server, measured rather than asserted in a
 * comment.
 *
 * Tool definitions are re-sent on every request for the life of the session,
 * whether or not Inzo is used that turn. At 20 tools with 3-4 sentence
 * descriptions that was the largest single overhead in the system — more than
 * everything else Inzo adds put together. This test exists so it cannot
 * quietly grow back.
 *
 * Two numbers, because they answer different questions:
 *
 *   CONTENT — name, description, and input schema: everything this codebase
 *   actually writes, and the thing T-1's under-600 target is about.
 *
 *   WIRE — the whole `tools/list` payload. Larger because the MCP SDK adds a
 *   `$schema` URL and an `execution` block per tool (~24 tokens each) that no
 *   amount of rewriting here can remove. Asserted too, so a regression shows
 *   up even if it hides in a part we don't author.
 */
const CONTENT_BUDGET = 600;
const WIRE_BUDGET = 900;

/** Characters per token, the standard rough English estimate. */
function estimateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

/** Just the parts this codebase writes. */
function content(tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }) {
  return {
    name: tool.name,
    description: tool.description,
    properties: tool.inputSchema?.properties ?? {},
    required: tool.inputSchema?.required ?? [],
  };
}

let client: Client;

beforeAll(async () => {
  const server = new McpServer({ name: "inzo-mcp", version: "test" });
  registerTools(server);
  client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

async function listNames(): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

describe("resident tool surface (T-1)", () => {
  it("stays under the token budget in every mode", async () => {
    for (const mode of SESSION_MODES) {
      applyModeGating(mode);
      const { tools } = await client.listTools();
      const written = estimateTokens(tools.map(content));
      const wire = estimateTokens(tools);
      expect(written, `${mode}: ~${written} tokens of tool definitions`).toBeLessThan(CONTENT_BUDGET);
      expect(wire, `${mode}: ~${wire} tokens on the wire`).toBeLessThan(WIRE_BUDGET);
    }
  });

  it("keeps the hot path first-class", async () => {
    applyModeGating("cowork");
    const names = await listNames();
    for (const hot of [
      "get_session",
      "send_message",
      "get_digest",
      "propose_plan",
      "approve_plan",
      "update_item_status",
      "run_shared_command",
    ]) {
      expect(names).toContain(hot);
    }
    expect(names).toContain("inzo_admin");
  });

  it("folds every cold tool behind inzo_admin", async () => {
    applyModeGating("cowork");
    const names = await listNames();
    for (const cold of [
      "get_audit_log",
      "set_budget",
      "report_usage",
      "limit_my_agent",
      "revoke_pairing",
      "withdraw_consent",
      "invite_to_pairing",
      "check_pairing_code",
      // Pairing happens once per session — as cold as it gets.
      "create_pairing_code",
      "join_pairing",
      // Folded into get_session, so "where are we" is one call.
      "get_plan",
      "get_pairing_status",
      "get_runway",
      // Folded into get_digest behind `full`.
      "get_thread",
    ]) {
      expect(names, `${cold} should not be a resident tool`).not.toContain(cold);
    }
  });

  it("is less than half the 20-tool surface it replaced", async () => {
    applyModeGating("cowork");
    expect((await listNames()).length).toBeLessThanOrEqual(10);
  });
});

describe("mode gating", () => {
  it("does not register run_shared_command in plan mode", async () => {
    // A tool absent from tools/list is never called, which beats one that
    // errors: it costs nothing and needs no explanation.
    applyModeGating("plan");
    expect(await listNames()).not.toContain("run_shared_command");
  });

  it("keeps run_shared_command in research, build, and cowork", async () => {
    for (const mode of ["research", "build", "cowork"] as const) {
      applyModeGating(mode);
      expect(await listNames(), mode).toContain("run_shared_command");
    }
  });

  it("drops the plan tools in research, where there is nothing to plan yet", async () => {
    applyModeGating("research");
    const names = await listNames();
    expect(names).not.toContain("propose_plan");
    expect(names).not.toContain("approve_plan");
  });

  it("never gates away session, messaging, or admin", async () => {
    for (const mode of SESSION_MODES) {
      applyModeGating(mode);
      const names = await listNames();
      for (const always of ["get_session", "send_message", "get_digest", "inzo_admin"]) {
        expect(names, `${always} missing in ${mode}`).toContain(always);
      }
    }
  });

  it("returns to a larger surface when the mode widens back", async () => {
    applyModeGating("plan");
    const planned = (await listNames()).length;
    applyModeGating("build");
    expect((await listNames()).length).toBeGreaterThan(planned);
  });
});

describe("mode policy", () => {
  it("makes research read-only with network, and build writable without", () => {
    expect(MODE_POLICY.research).toEqual({ readonly: true, network: true, enforceItemOwnership: false });
    expect(MODE_POLICY.build).toEqual({ readonly: false, network: false, enforceItemOwnership: true });
  });

  it("enforces item ownership only in build", () => {
    const enforcing = SESSION_MODES.filter((mode) => MODE_POLICY[mode].enforceItemOwnership);
    expect(enforcing).toEqual(["build"]);
  });
});
