import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { FailureLimiter } from "../lib/rateLimit.js";
import { RelayStore } from "../lib/store.js";

function setup(options: Parameters<typeof createApp>[1] = {}) {
  const store = new RelayStore();
  return { store, app: createApp(store, options) };
}

/** Creates a pairing and returns both sides' credentials. */
async function pair(app: ReturnType<typeof createApp>) {
  const creator = (await request(app).post("/pairings").send({})).body;
  const joiner = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
  return {
    pairingId: joiner.pairingId as string,
    a: { agentId: creator.agentId as string, auth: { Authorization: `Bearer ${creator.agentToken}` } },
    b: { agentId: joiner.agentId as string, auth: { Authorization: `Bearer ${joiner.agentToken}` } },
  };
}

describe("identity", () => {
  it("issues one-time bearer credentials and six-character pairing codes", async () => {
    const { app, store } = setup();
    const created = await request(app).post("/pairings").send({});
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^INZO-[A-Z2-9]{6}$/);
    expect(created.body.agentToken).toHaveLength(43);
    expect(JSON.stringify(store)).not.toContain(created.body.agentToken);
    store.close();
  });

  it("derives message identity from bearer token and rejects forged body identity", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    const forged = await request(app)
      .post(`/pairings/${pairingId}/messages`)
      .set(a.auth)
      .send({ body: "hi", fromAgentId: b.agentId });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("identity_not_allowed");

    const sent = await request(app).post(`/pairings/${pairingId}/messages`).set(a.auth).send({ body: "hi" });
    expect(sent.status).toBe(201);
    expect(sent.body.message.fromAgentId).toBe(a.agentId);
    store.close();
  });

  it("prevents unauthenticated or cross-pairing reads", async () => {
    const { app, store } = setup();
    const first = await pair(app);
    const second = await pair(app);
    expect((await request(app).get(`/pairings/${first.pairingId}/messages`)).status).toBe(401);
    const crossed = await request(app).get(`/pairings/${first.pairingId}/messages`).set(second.a.auth);
    expect(crossed.status).toBe(403);
    store.close();
  });

  it("lets the code creator discover only their own pairing", async () => {
    const { app, store } = setup();
    const creator = (await request(app).post("/pairings").send({})).body;
    const auth = { Authorization: `Bearer ${creator.agentToken}` };
    expect((await request(app).get("/pairings/mine").set(auth)).body.pairing).toBeNull();

    const joined = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
    const mine = await request(app).get("/pairings/mine").set(auth);
    expect(mine.body.pairing.id).toBe(joined.pairingId);
    expect(mine.body.pairing.peerAgentId).toBe(joined.agentId);
    store.close();
  });
});

describe("pairing-code brute force", () => {
  it("rate-limits repeated failed joins from one address", async () => {
    const limiter = new FailureLimiter(3, 600_000);
    const { app, store } = setup({ limiter });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await request(app).post("/pairings/INZO-ZZZZZZ/join").send({})).status).toBe(404);
    }
    const blocked = await request(app).post("/pairings/INZO-ZZZZZZ/join").send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
    store.close();
  });

  it("does not count successful joins against the limit", async () => {
    const limiter = new FailureLimiter(2, 600_000);
    const { app, store } = setup({ limiter });
    for (let i = 0; i < 3; i++) {
      const created = (await request(app).post("/pairings").send({})).body;
      expect((await request(app).post(`/pairings/${created.code}/join`).send({})).status).toBe(201);
    }
    store.close();
  });
});

describe("plan consent", () => {
  it("requires the approved version to match what the human read", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);

    const v1 = (
      await request(app)
        .post(`/pairings/${pairingId}/plan`)
        .set(a.auth)
        .send({ goal: "ship the core loop", items: [{ owner: a.agentId, task: "api" }] })
    ).body.plan;
    expect(v1.version).toBe(1);

    // B swaps the plan out from under A's in-flight approval.
    const v2 = (
      await request(app)
        .post(`/pairings/${pairingId}/plan`)
        .set(b.auth)
        .send({ goal: "ship something else entirely", items: [{ owner: b.agentId, task: "deploy to prod" }] })
    ).body.plan;
    expect(v2.version).toBe(2);

    const stale = await request(app)
      .post(`/pairings/${pairingId}/plan/approve`)
      .set(a.auth)
      .send({ planVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("stale_plan");
    expect((await request(app).get(`/pairings/${pairingId}/plan`).set(a.auth)).body.plan.approvedBy).toEqual([]);
    store.close();
  });

  it("rejects an approval with no version at all", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/plan`)
      .set(a.auth)
      .send({ goal: "g", items: [{ owner: a.agentId, task: "t" }] });
    const res = await request(app).post(`/pairings/${pairingId}/plan/approve`).set(a.auth).send({});
    expect(res.status).toBe(400);
    store.close();
  });

  it("locks only once both sides approve the same version", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/plan`)
      .set(a.auth)
      .send({ goal: "g", items: [{ owner: a.agentId, task: "t" }] });

    const first = await request(app).post(`/pairings/${pairingId}/plan/approve`).set(a.auth).send({ planVersion: 1 });
    expect(first.body.plan.locked).toBe(false);
    const second = await request(app).post(`/pairings/${pairingId}/plan/approve`).set(b.auth).send({ planVersion: 1 });
    expect(second.body.plan.locked).toBe(true);
    store.close();
  });

  it("drops existing approvals when the plan is re-proposed", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/plan`)
      .set(a.auth)
      .send({ goal: "g", items: [{ owner: a.agentId, task: "t" }] });
    await request(app).post(`/pairings/${pairingId}/plan/approve`).set(a.auth).send({ planVersion: 1 });
    await request(app).post(`/pairings/${pairingId}/plan/approve`).set(b.auth).send({ planVersion: 1 });

    const reproposed = (
      await request(app)
        .post(`/pairings/${pairingId}/plan`)
        .set(b.auth)
        .send({ goal: "different", items: [{ owner: b.agentId, task: "t2" }] })
    ).body.plan;
    expect(reproposed.locked).toBe(false);
    expect(reproposed.approvedBy).toEqual([]);
    store.close();
  });
});

describe("scope", () => {
  it("lets a credential drop a capability and then refuses to use it", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);

    const narrowed = await request(app)
      .post("/pairings/mine/scope")
      .set(a.auth)
      .send({ scope: ["messages:read", "messages:send"] });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toEqual(["messages:read", "messages:send"]);

    const denied = await request(app)
      .post(`/pairings/${pairingId}/plan`)
      .set(a.auth)
      .send({ goal: "g", items: [{ owner: a.agentId, task: "t" }] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("insufficient_scope");

    // Still allowed to do what it kept.
    expect(
      (await request(app).post(`/pairings/${pairingId}/messages`).set(a.auth).send({ body: "hi" })).status,
    ).toBe(201);
    store.close();
  });

  it("refuses to widen a scope back out", async () => {
    const { app, store } = setup();
    const { a } = await pair(app);
    await request(app).post("/pairings/mine/scope").set(a.auth).send({ scope: ["messages:read"] });

    const widened = await request(app)
      .post("/pairings/mine/scope")
      .set(a.auth)
      .send({ scope: ["messages:read", "plan:approve"] });
    expect(widened.status).toBe(400);
    expect(widened.body.error.message).toMatch(/cannot widen/i);
    store.close();
  });

  it("publishes the peer's scope so this side can refuse unauthorized work", async () => {
    const { app, store } = setup();
    const { a, b } = await pair(app);
    await request(app).post("/pairings/mine/scope").set(b.auth).send({ scope: ["messages:read", "messages:send"] });

    const mine = await request(app).get("/pairings/mine").set(a.auth);
    expect(mine.body.pairing.peerScope).toEqual(["messages:read", "messages:send"]);
    expect(mine.body.pairing.peerScope).not.toContain("commands:run");
    store.close();
  });
});

describe("revocation kill switch", () => {
  it("lets either side eject the peer immediately and unilaterally", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    expect(
      (await request(app).post(`/pairings/${pairingId}/messages`).set(b.auth).send({ body: "before" })).status,
    ).toBe(201);

    const revocation = await request(app).post(`/pairings/${pairingId}/revoke`).set(a.auth).send({ target: "peer" });
    expect(revocation.status).toBe(200);
    expect(revocation.body.revocation.revokedAgentId).toBe(b.agentId);
    expect(revocation.body.revocation.by).toBe(a.agentId);

    const after = await request(app).post(`/pairings/${pairingId}/messages`).set(b.auth).send({ body: "after" });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("revoked");
    // Even reads are cut off — revocation is not "read-only mode".
    expect((await request(app).get(`/pairings/${pairingId}/messages`).set(b.auth)).status).toBe(401);
    store.close();
  });

  it("leaves the revoker's own access intact", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app).post(`/pairings/${pairingId}/revoke`).set(a.auth).send({ target: "peer" });
    expect((await request(app).get(`/pairings/${pairingId}/messages`).set(a.auth)).status).toBe(200);
    expect((await request(app).get("/pairings/mine").set(a.auth)).body.pairing.peerRevoked).toBe(true);
    store.close();
  });

  it("is idempotent and one-way", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const first = await request(app).post(`/pairings/${pairingId}/revoke`).set(a.auth).send({ target: "peer" });
    const second = await request(app).post(`/pairings/${pairingId}/revoke`).set(a.auth).send({ target: "peer" });
    expect(second.status).toBe(200);
    expect(second.body.revocation.revokedAt).toBe(first.body.revocation.revokedAt);
    store.close();
  });

  it("lets an agent revoke itself", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app).post(`/pairings/${pairingId}/revoke`).set(a.auth).send({ target: "self" });
    expect((await request(app).get(`/pairings/${pairingId}/messages`).set(a.auth)).status).toBe(401);
    store.close();
  });
});

describe("budget and usage", () => {
  it("treats usage reports as cumulative totals, not deltas", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/usage`)
      .set(a.auth)
      .send({ tokensUsed: 100, costUsd: 1, wallClockMs: 1000, progressPct: 10 });
    const second = await request(app)
      .post(`/pairings/${pairingId}/usage`)
      .set(a.auth)
      .send({ tokensUsed: 250, costUsd: 2.5, wallClockMs: 60_000, progressPct: 40 });

    // A duplicated or retried report must not inflate the total.
    expect(second.body.usage.totals.tokensUsed).toBe(250);
    expect(second.body.usage.byAgent[a.agentId].progressPct).toBe(40);
    expect(second.body.usage.byAgent[a.agentId].reportCount).toBe(2);
    store.close();
  });

  it("sets a budget field-by-field without clobbering the others", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app)
      .put(`/pairings/${pairingId}/budget`)
      .set(a.auth)
      .send({ tokenBudget: 500_000, costBudgetUsd: 20 });
    const moved = await request(app)
      .put(`/pairings/${pairingId}/budget`)
      .set(a.auth)
      .send({ deadline: "2026-08-02T18:00:00.000Z" });

    expect(moved.body.budget.tokenBudget).toBe(500_000);
    expect(moved.body.budget.costBudgetUsd).toBe(20);
    expect(moved.body.budget.deadline).toBe("2026-08-02T18:00:00.000Z");

    const cleared = await request(app).put(`/pairings/${pairingId}/budget`).set(a.auth).send({ tokenBudget: null });
    expect(cleared.body.budget.tokenBudget).toBeNull();
    expect(cleared.body.budget.costBudgetUsd).toBe(20);
    store.close();
  });

  it("rejects a malformed deadline rather than silently dropping it", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const res = await request(app).put(`/pairings/${pairingId}/budget`).set(a.auth).send({ deadline: "next tuesday" });
    expect(res.status).toBe(400);
    store.close();
  });

  it("returns a runway alongside usage", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app).put(`/pairings/${pairingId}/budget`).set(a.auth).send({ tokenBudget: 1000 });
    await request(app)
      .post(`/pairings/${pairingId}/usage`)
      .set(a.auth)
      .send({ tokensUsed: 400, costUsd: 0, wallClockMs: 0, progressPct: 0 });

    const res = await request(app).get(`/pairings/${pairingId}/usage`).set(a.auth);
    expect(res.body.runway.tokensRemaining).toBe(600);
    // One report is not enough to measure a slope.
    expect(res.body.runway.burn).toBeNull();
    expect(res.body.runway.verdict).toMatch(/not enough reports/i);
    store.close();
  });
});
