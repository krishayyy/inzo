import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

function buildApp() {
  const store = new RelayStore(":memory:");
  const app = createApp(store);
  return { app, store };
}

async function createPairing(app: ReturnType<typeof createApp>) {
  const created = await request(app).post("/pairings").send({ agentId: "agent-alice" });
  const code = created.body.pairingCode.code as string;
  const joined = await request(app)
    .post(`/pairings/${code}/join`)
    .send({ agentId: "agent-bob" });
  return { code, pairing: joined.body.pairing };
}

describe("pairing codes", () => {
  it("creates a human-readable code tied to the creator, then joins to form a pairing", async () => {
    const { app } = buildApp();

    const created = await request(app).post("/pairings").send({ agentId: "agent-alice" });
    expect(created.status).toBe(201);
    expect(created.body.pairingCode.code).toMatch(/^INZO-[A-Z0-9]{4}$/);
    expect(created.body.pairingCode.creatorAgentId).toBe("agent-alice");

    const code = created.body.pairingCode.code;
    const joined = await request(app).post(`/pairings/${code}/join`).send({ agentId: "agent-bob" });
    expect(joined.status).toBe(201);
    expect(joined.body.pairing.agentA).toBe("agent-alice");
    expect(joined.body.pairing.agentB).toBe("agent-bob");
    expect(joined.body.pairing.id).toBeTruthy();
  });

  it("rejects joining with an unknown code", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/pairings/INZO-0000/join").send({ agentId: "agent-bob" });
    expect(res.status).toBe(404);
  });

  it("rejects joining a code twice", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/pairings").send({ agentId: "agent-alice" });
    const code = created.body.pairingCode.code;

    await request(app).post(`/pairings/${code}/join`).send({ agentId: "agent-bob" });
    const secondJoin = await request(app).post(`/pairings/${code}/join`).send({ agentId: "agent-carol" });
    expect(secondJoin.status).toBe(409);
  });

  it("looks up a pairing by its originating code, for the creator to discover the pairingId", async () => {
    const { app } = buildApp();

    const created = await request(app).post("/pairings").send({ agentId: "agent-alice" });
    const code = created.body.pairingCode.code as string;

    const beforeJoin = await request(app).get(`/pairings/by-code/${code}`);
    expect(beforeJoin.status).toBe(200);
    expect(beforeJoin.body.pairing).toBeNull();

    await request(app).post(`/pairings/${code}/join`).send({ agentId: "agent-bob" });

    const afterJoin = await request(app).get(`/pairings/by-code/${code}`);
    expect(afterJoin.status).toBe(200);
    expect(afterJoin.body.pairing.agentA).toBe("agent-alice");
    expect(afterJoin.body.pairing.agentB).toBe("agent-bob");
    expect(afterJoin.body.pairing.code).toBe(code);
  });

  it("rejects an agent joining its own code", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/pairings").send({ agentId: "agent-alice" });
    const code = created.body.pairingCode.code;

    const res = await request(app).post(`/pairings/${code}/join`).send({ agentId: "agent-alice" });
    expect(res.status).toBe(400);
  });
});

describe("messages", () => {
  it("sends and receives a message thread between paired agents", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);

    const sent = await request(app)
      .post(`/pairings/${pairing.id}/messages`)
      .send({ fromAgentId: "agent-alice", body: "let's split the frontend and backend" });
    expect(sent.status).toBe(201);
    expect(sent.body.message.body).toBe("let's split the frontend and backend");

    const thread = await request(app).get(`/pairings/${pairing.id}/messages`);
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.cursor).toBe(sent.body.message.cursor);
  });

  it("supports polling for messages since a cursor", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);

    const first = await request(app)
      .post(`/pairings/${pairing.id}/messages`)
      .send({ fromAgentId: "agent-alice", body: "first" });

    const second = await request(app)
      .post(`/pairings/${pairing.id}/messages`)
      .send({ fromAgentId: "agent-bob", body: "second" });

    const sinceFirst = await request(app)
      .get(`/pairings/${pairing.id}/messages`)
      .query({ since: first.body.message.cursor });

    expect(sinceFirst.body.messages).toHaveLength(1);
    expect(sinceFirst.body.messages[0].body).toBe("second");
    expect(sinceFirst.body.cursor).toBe(second.body.message.cursor);
  });

  it("rejects a message from an agent outside the pairing", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);

    const res = await request(app)
      .post(`/pairings/${pairing.id}/messages`)
      .send({ fromAgentId: "agent-mallory", body: "hi" });
    expect(res.status).toBe(403);
  });
});

describe("plans", () => {
  it("locks a plan only once both sides have approved", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);

    const proposed = await request(app)
      .post(`/pairings/${pairing.id}/plan`)
      .send({
        proposedBy: "agent-alice",
        goal: "Ship the hackathon demo",
        items: [
          { owner: "agent-alice", task: "backend API" },
          { owner: "agent-bob", task: "frontend UI" },
        ],
      });
    expect(proposed.status).toBe(201);
    expect(proposed.body.plan.locked).toBe(false);
    expect(proposed.body.plan.approvedBy).toEqual([]);

    const afterOne = await request(app)
      .post(`/pairings/${pairing.id}/plan/approve`)
      .send({ agentId: "agent-alice" });
    expect(afterOne.body.plan.locked).toBe(false);
    expect(afterOne.body.plan.approvedBy).toEqual(["agent-alice"]);

    const afterBoth = await request(app)
      .post(`/pairings/${pairing.id}/plan/approve`)
      .send({ agentId: "agent-bob" });
    expect(afterBoth.body.plan.locked).toBe(true);
    expect(afterBoth.body.plan.approvedBy.sort()).toEqual(["agent-alice", "agent-bob"]);

    const fetched = await request(app).get(`/pairings/${pairing.id}/plan`);
    expect(fetched.body.plan.locked).toBe(true);
  });

  it("resets approvals when a plan is re-proposed", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);

    await request(app)
      .post(`/pairings/${pairing.id}/plan`)
      .send({ proposedBy: "agent-alice", goal: "v1", items: [{ owner: "agent-alice", task: "x" }] });
    await request(app).post(`/pairings/${pairing.id}/plan/approve`).send({ agentId: "agent-alice" });
    await request(app).post(`/pairings/${pairing.id}/plan/approve`).send({ agentId: "agent-bob" });

    const reproposed = await request(app)
      .post(`/pairings/${pairing.id}/plan`)
      .send({ proposedBy: "agent-bob", goal: "v2", items: [{ owner: "agent-bob", task: "y" }] });

    expect(reproposed.body.plan.locked).toBe(false);
    expect(reproposed.body.plan.approvedBy).toEqual([]);
    expect(reproposed.body.plan.goal).toBe("v2");
  });

  it("returns null when no plan has been proposed yet", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);
    const res = await request(app).get(`/pairings/${pairing.id}/plan`);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
  });
});

describe("usage", () => {
  it("aggregates usage reports per agent and combined totals", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);

    await request(app)
      .post(`/pairings/${pairing.id}/usage`)
      .send({ agentId: "agent-alice", tokensUsed: 1000, costUsd: 0.5, wallClockMs: 60_000, progressPct: 20 });
    await request(app)
      .post(`/pairings/${pairing.id}/usage`)
      .send({ agentId: "agent-alice", tokensUsed: 500, costUsd: 0.25, wallClockMs: 30_000, progressPct: 40 });
    await request(app)
      .post(`/pairings/${pairing.id}/usage`)
      .send({ agentId: "agent-bob", tokensUsed: 2000, costUsd: 1.0, wallClockMs: 90_000, progressPct: 55 });

    const res = await request(app).get(`/pairings/${pairing.id}/usage`);
    expect(res.status).toBe(200);

    const { byAgent, totals } = res.body.usage;
    expect(byAgent["agent-alice"].tokensUsed).toBe(1500);
    expect(byAgent["agent-alice"].costUsd).toBeCloseTo(0.75);
    expect(byAgent["agent-alice"].progressPct).toBe(40); // latest report wins
    expect(byAgent["agent-alice"].reportCount).toBe(2);

    expect(byAgent["agent-bob"].tokensUsed).toBe(2000);
    expect(byAgent["agent-bob"].progressPct).toBe(55);

    expect(totals.tokensUsed).toBe(3500);
    expect(totals.costUsd).toBeCloseTo(1.75);
    expect(totals.wallClockMs).toBe(180_000);
  });

  it("rejects a negative usage value", async () => {
    const { app } = buildApp();
    const { pairing } = await createPairing(app);
    const res = await request(app)
      .post(`/pairings/${pairing.id}/usage`)
      .send({ agentId: "agent-alice", tokensUsed: -5, costUsd: 0, wallClockMs: 0, progressPct: 0 });
    expect(res.status).toBe(400);
  });
});
