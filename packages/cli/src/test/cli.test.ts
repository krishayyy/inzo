import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../api.js";
import { approve, revoke, status, watch, type Ctx } from "../commands.js";
import { buildAuthHeaders, generateHolderKeyPair } from "inzo-holder";
import { loadSession } from "../session.js";

let server: Server;
let store: import("inzo-relay").RelayStore;
let base: string;

beforeAll(async () => {
  const { createApp, RelayStore } = await import("inzo-relay");
  store = new RelayStore();
  server = await new Promise<Server>((resolve) => {
    const s = createApp(store).listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

/**
 * Pairs both sides the way the MCP server does: each generates a holder
 * keypair locally and sends only the public half, so the session that comes
 * back can actually sign an approval.
 */
async function pair() {
  const keyA = generateHolderKeyPair();
  const keyB = generateHolderKeyPair();
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json());

  const created = await post("/pairings", { cnf: { jwk: keyA.publicJwk } });
  const joined = await post(`/pairings/${created.code}/join`, { cnf: { jwk: keyB.publicJwk } });
  return {
    creator: { ...created, holderPrivateKey: keyA.privateKeyPem },
    joiner: { ...joined, holderPrivateKey: keyB.privateKeyPem },
    pairingId: joined.pairingId as string,
  };
}

function ctxFor(
  agent: { agentId: string; agentToken: string; credential?: string; holderPrivateKey?: string },
  pairingId: string,
) {
  const lines: string[] = [];
  const session = {
    relayUrl: base,
    pairingId,
    agentId: agent.agentId,
    agentToken: agent.agentToken,
    credential: agent.credential ?? null,
    holderPrivateKey: agent.holderPrivateKey ?? null,
    updatedAt: new Date().toISOString(),
  };
  const ctx: Ctx = {
    api: createApi(session),
    pairingId,
    agentId: agent.agentId,
    session,
    out: (line) => lines.push(line),
  };
  return { ctx, lines, text: () => lines.join("\n") };
}

async function proposePlan(
  agent: { agentToken: string; credential?: string; holderPrivateKey?: string },
  pairingId: string,
  goal: string,
) {
  const path = `/pairings/${pairingId}/plan`;
  const body = { goal, items: [{ owner: "someone", task: "do the thing" }] };
  const auth =
    agent.credential && agent.holderPrivateKey
      ? (buildAuthHeaders({
          credential: agent.credential,
          privateKeyPem: agent.holderPrivateKey,
          method: "POST",
          path,
          body,
        }) as unknown as Record<string, string>)
      : { Authorization: `Bearer ${agent.agentToken}` };

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  return (await res.json()).plan;
}

describe("session file", () => {
  it("explains how to pair instead of failing cryptically", () => {
    process.env.INZO_HOME = mkdtempSync(join(tmpdir(), "inzo-empty-"));
    expect(() => loadSession()).toThrow(/Pair from your agent first/);
  });

  it("rejects a corrupt session file rather than half-reading it", () => {
    const home = mkdtempSync(join(tmpdir(), "inzo-bad-"));
    mkdirSync(join(home, ".inzo"));
    writeFileSync(join(home, ".inzo", "session.json"), "{not json");
    process.env.INZO_HOME = home;
    expect(() => loadSession()).toThrow(/not valid JSON/);
  });

  it("rejects a session file with no credential in it", () => {
    const home = mkdtempSync(join(tmpdir(), "inzo-partial-"));
    mkdirSync(join(home, ".inzo"));
    writeFileSync(join(home, ".inzo", "session.json"), JSON.stringify({ relayUrl: base }));
    process.env.INZO_HOME = home;
    expect(() => loadSession()).toThrow(/incomplete/);
  });
});

describe("approve gate", () => {
  it("records nothing when the human declines", async () => {
    const { creator, joiner, pairingId } = await pair();
    await proposePlan(joiner, pairingId, "ship it");
    const { ctx, text } = ctxFor(creator, pairingId);

    await approve(ctx, async () => false);

    expect(text()).toMatch(/Nothing was recorded/);
    const { plan } = await ctx.api.plan(pairingId);
    expect(plan?.approvedBy).toEqual([]);
  });

  it("shows the plan text before asking, so consent is informed", async () => {
    const { creator, joiner, pairingId } = await pair();
    await proposePlan(joiner, pairingId, "a very specific goal");
    const { ctx, text } = ctxFor(creator, pairingId);

    let questionAskedAfterPlanShown = false;
    await approve(ctx, async () => {
      questionAskedAfterPlanShown = text().includes("a very specific goal");
      return false;
    });

    expect(questionAskedAfterPlanShown).toBe(true);
  });

  it("approves the exact version it displayed", async () => {
    const { creator, joiner, pairingId } = await pair();
    const plan = await proposePlan(joiner, pairingId, "ship it");
    const { ctx, text } = ctxFor(creator, pairingId);

    await approve(ctx, async () => true);

    expect(text()).toMatch(/Waiting on the other side/);
    const current = (await ctx.api.plan(pairingId)).plan!;
    expect(current.approvedBy).toEqual([creator.agentId]);
    expect(current.version).toBe(plan.version);
  });

  it("reports a locked plan once both sides have signed off", async () => {
    const { creator, joiner, pairingId } = await pair();
    await proposePlan(joiner, pairingId, "ship it");
    await approve(ctxFor(creator, pairingId).ctx, async () => true);
    const second = ctxFor(joiner, pairingId);

    await approve(second.ctx, async () => true);

    expect(second.text()).toMatch(/locked in/);
  });

  it("does not re-ask once this side has already approved", async () => {
    const { creator, joiner, pairingId } = await pair();
    await proposePlan(joiner, pairingId, "ship it");
    const first = ctxFor(creator, pairingId);
    await approve(first.ctx, async () => true);

    const again = ctxFor(creator, pairingId);
    let asked = false;
    await approve(again.ctx, async () => {
      asked = true;
      return true;
    });

    expect(asked).toBe(false);
    expect(again.text()).toMatch(/already approved/);
  });

  it("refuses when there is nothing proposed yet", async () => {
    const { creator, pairingId } = await pair();
    await expect(approve(ctxFor(creator, pairingId).ctx, async () => true)).rejects.toThrow(/nothing to approve/i);
  });
});

describe("kill switch", () => {
  it("does nothing unless the human confirms", async () => {
    const { creator, joiner, pairingId } = await pair();
    const { ctx, text } = ctxFor(creator, pairingId);

    await revoke("peer", ctx, async () => false);

    expect(text()).toMatch(/Cancelled/);
    const peer = ctxFor(joiner, pairingId);
    await expect(peer.ctx.api.plan(pairingId)).resolves.toBeTruthy();
  });

  it("cuts the peer off once confirmed", async () => {
    const { creator, joiner, pairingId } = await pair();
    await revoke("peer", ctxFor(creator, pairingId).ctx, async () => true);

    const peer = ctxFor(joiner, pairingId);
    await expect(peer.ctx.api.plan(pairingId)).rejects.toMatchObject({ status: 401, code: "revoked" });
  });
});

describe("watch", () => {
  it("backfills the thread so a late viewer sees the whole negotiation", async () => {
    const { creator, joiner, pairingId } = await pair();
    await fetch(`${base}/pairings/${pairingId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ body: "said before anyone was watching" }),
    });

    const { ctx, text } = ctxFor(creator, pairingId);
    const controller = new AbortController();
    const running = watch(ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await running;

    expect(text()).toMatch(/said before anyone was watching/);
  });

  it("prints a peer's message as it arrives, without polling", async () => {
    const { creator, joiner, pairingId } = await pair();
    const { ctx, text } = ctxFor(creator, pairingId);
    const controller = new AbortController();
    const running = watch(ctx, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await fetch(`${base}/pairings/${pairingId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ body: "live from the peer" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await running;

    expect(text()).toMatch(/live from the peer/);
  });

  it("stops and says so when this side gets revoked mid-watch", async () => {
    const { creator, joiner, pairingId } = await pair();
    const { ctx, text } = ctxFor(creator, pairingId);
    const controller = new AbortController();
    const running = watch(ctx, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await fetch(`${base}/pairings/${pairingId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ target: "peer" }),
    });

    // Returns on its own — no abort needed.
    await running;
    expect(text()).toMatch(/YOUR agent was revoked by the peer/);
  }, 10_000);
});

describe("status", () => {
  it("summarises pairing, plan, and runway in one shot", async () => {
    const { creator, joiner, pairingId } = await pair();
    await proposePlan(joiner, pairingId, "ship the core loop");
    await fetch(`${base}/pairings/${pairingId}/budget`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creator.agentToken}` },
      body: JSON.stringify({ tokenBudget: 1000 }),
    });

    const { ctx, text } = ctxFor(creator, pairingId);
    await status(ctx);

    expect(text()).toMatch(/ship the core loop/);
    expect(text()).toMatch(/1,000 tokens left/);
    expect(text()).toMatch(/AWAITING APPROVAL/);
  });
});
