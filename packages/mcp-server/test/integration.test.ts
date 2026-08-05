import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The relay and the MCP client are two halves of one contract, and the place
 * they drift is field names. These run the real client against a real relay
 * so a rename on either side fails here instead of at a hackathon table.
 */
let server: Server;
let client: typeof import("../src/relayClient.js").relayClient;
let store: import("inzo-relay").RelayStore;
let base: string;

beforeAll(async () => {
  const { createApp, RelayStore } = await import("inzo-relay");
  store = new RelayStore();
  const app = createApp(store);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // relayClient reads INZO_RELAY_URL once at module load.
  process.env.INZO_RELAY_URL = base;
  process.env.INZO_HOME = mkdtempSync(join(tmpdir(), "inzo-home-"));
  client = (await import("../src/relayClient.js")).relayClient;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

/** Pairs two agents through the same client the MCP tools use. */
async function pair() {
  const creator = await client.createPairing();
  const joiner = await client.joinPairing(creator.code);
  return { creator, joiner, pairingId: joiner.pairingId };
}

describe("mcp client <-> relay", () => {
  it("pairs, and each side learns who the peer is", async () => {
    const { creator, joiner } = await pair();
    const mine = await client.getMine(creator.agentToken);
    expect(mine.pairing?.peerAgentId).toBe(joiner.agentId);
    expect(mine.pairing?.scope).toContain("commands:run");
  });

  it("carries a full negotiation through to a locked plan", async () => {
    const { creator, joiner, pairingId } = await pair();
    await client.sendMessage(pairingId, creator.agentToken, "I can own the API contract.");
    await client.sendMessage(pairingId, joiner.agentToken, "Then I'll take the UI and deploy.");

    const thread = await client.getMessages(pairingId, creator.agentToken);
    expect(thread.messages).toHaveLength(2);

    const { plan } = await client.proposePlan(pairingId, creator.agentToken, "Ship the core loop", [
      { owner: creator.agentId, task: "API + tests" },
      { owner: joiner.agentId, task: "UI + deploy" },
    ]);
    expect(plan.version).toBe(1);
    expect(plan.locked).toBe(false);

    await client.approvePlan(pairingId, creator.agentToken, plan.version);
    const both = await client.approvePlan(pairingId, joiner.agentToken, plan.version);
    expect(both.plan.locked).toBe(true);
  });

  it("surfaces a stale approval as an error the agent can explain", async () => {
    const { creator, joiner, pairingId } = await pair();
    await client.proposePlan(pairingId, creator.agentToken, "v1", [{ owner: "a", task: "t" }]);
    await client.proposePlan(pairingId, joiner.agentToken, "v2", [{ owner: "b", task: "t" }]);

    await expect(client.approvePlan(pairingId, creator.agentToken, 1)).rejects.toMatchObject({
      status: 409,
      code: "stale_plan",
    });
  });

  it("computes a runway the agent can plan against", async () => {
    const { creator, pairingId } = await pair();
    await client.setBudget(pairingId, creator.agentToken, { tokenBudget: 10_000 });
    await client.reportUsage(pairingId, creator.agentToken, {
      tokensUsed: 0,
      costUsd: 0,
      wallClockMs: 0,
      progressPct: 0,
    });
    const snapshot = await client.reportUsage(pairingId, creator.agentToken, {
      tokensUsed: 2000,
      costUsd: 1,
      wallClockMs: 120_000,
      progressPct: 25,
    });

    expect(snapshot.usage.totals.tokensUsed).toBe(2000);
    expect(snapshot.runway.tokensRemaining).toBe(8000);
    expect(snapshot.runway.burn?.tokensPerMin).toBe(1000);
    expect(snapshot.runway.verdict).toBeTruthy();
  });

  it("lets a human strip an authority the agent then cannot use or restore", async () => {
    const { creator, pairingId } = await pair();
    await client.narrowScope(creator.agentToken, ["messages:read", "messages:send"]);

    await expect(
      client.proposePlan(pairingId, creator.agentToken, "g", [{ owner: "a", task: "t" }]),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });

    await expect(
      client.narrowScope(creator.agentToken, ["messages:read", "messages:send", "plan:propose"]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("cuts the peer off the instant the kill switch is pulled", async () => {
    const { creator, joiner, pairingId } = await pair();
    await client.sendMessage(pairingId, joiner.agentToken, "still fine");

    const { revocation } = await client.revoke(pairingId, creator.agentToken, "peer");
    expect(revocation.revokedAgentId).toBe(joiner.agentId);

    await expect(client.sendMessage(pairingId, joiner.agentToken, "nope")).rejects.toMatchObject({
      status: 401,
      code: "revoked",
    });
    // The revoker keeps their own access and can see what happened.
    const mine = await client.getMine(creator.agentToken);
    expect(mine.pairing?.peerRevoked).toBe(true);
  });

  it("tells a peer-facing caller when the peer may no longer run commands", async () => {
    const { creator, joiner, pairingId } = await pair();
    await client.narrowScope(joiner.agentToken, ["messages:read", "messages:send"]);

    // This is the check run_shared_command makes before touching the sandbox.
    const { pairing } = await client.getMine(creator.agentToken);
    expect(pairing?.peerScope).not.toContain("commands:run");
    expect(pairingId).toBeTruthy();
  });
});
