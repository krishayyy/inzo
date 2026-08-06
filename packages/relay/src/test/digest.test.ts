import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

function setup() {
  const store = new RelayStore();
  return { store, app: createApp(store) };
}

async function pair(app: ReturnType<typeof createApp>) {
  const creator = (await request(app).post("/pairings").send({})).body;
  const joiner = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
  return {
    pairingId: joiner.pairingId as string,
    a: { agentId: creator.agentId as string, auth: { Authorization: `Bearer ${creator.agentToken}` } },
    b: { agentId: joiner.agentId as string, auth: { Authorization: `Bearer ${joiner.agentToken}` } },
  };
}

describe("digest", () => {
  it("requires auth and rejects a credential from another pairing", async () => {
    const { app } = setup();
    const first = await pair(app);
    const second = await pair(app);
    expect((await request(app).get(`/pairings/${first.pairingId}/digest`)).status).toBe(401);
    expect((await request(app).get(`/pairings/${first.pairingId}/digest`).set(second.a.auth)).status).toBe(403);
  });

  it("returns null plan and consent, and empty recentMessages, before anything has happened", async () => {
    const { app } = setup();
    const { pairingId, a } = await pair(app);
    const res = await request(app).get(`/pairings/${pairingId}/digest`).set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pairingId,
      plan: null,
      consent: null,
      recentMessages: [],
    });
    expect(res.body.usage).toBeDefined();
    expect(typeof res.body.generatedAt).toBe("string");
  });

  it("caps recentMessages at the requested limit, keeping the newest, oldest first", async () => {
    const { app } = setup();
    const { pairingId, a } = await pair(app);
    for (let i = 0; i < 5; i++) {
      await request(app).post(`/pairings/${pairingId}/messages`).set(a.auth).send({ body: `msg ${i}` });
    }
    const res = await request(app).get(`/pairings/${pairingId}/digest?limit=2`).set(a.auth);
    expect(res.body.recentMessages.map((m: { body: string }) => m.body)).toEqual(["msg 3", "msg 4"]);
  });

  it("caps the limit at 50 even if a caller asks for more", async () => {
    const { app } = setup();
    const { pairingId, a } = await pair(app);
    for (let i = 0; i < 5; i++) {
      await request(app).post(`/pairings/${pairingId}/messages`).set(a.auth).send({ body: `msg ${i}` });
    }
    const res = await request(app).get(`/pairings/${pairingId}/digest?limit=999999`).set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body.recentMessages).toHaveLength(5);
  });

  it("ignores a non-numeric limit and falls back to the default", async () => {
    const { app } = setup();
    const { pairingId, a } = await pair(app);
    const res = await request(app).get(`/pairings/${pairingId}/digest?limit=nope`).set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body.recentMessages).toEqual([]);
  });

  it("reflects the current plan and consent state", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    const proposal = await request(app)
      .post(`/pairings/${pairingId}/plan`)
      .set(a.auth)
      .send({ goal: "ship it", items: [{ owner: a.agentId, task: "build" }] });
    expect(proposal.status).toBe(201);

    const digestBefore = await request(app).get(`/pairings/${pairingId}/digest`).set(a.auth);
    expect(digestBefore.body.plan.goal).toBe("ship it");
    expect(digestBefore.body.plan.approvedBy).toEqual([]);

    await request(app).post(`/pairings/${pairingId}/plan/approve`).set(a.auth).send({ planVersion: 1 });
    await request(app).post(`/pairings/${pairingId}/plan/approve`).set(b.auth).send({ planVersion: 1 });

    const digestAfter = await request(app).get(`/pairings/${pairingId}/digest`).set(a.auth);
    expect(digestAfter.body.plan.locked).toBe(true);
    store.close();
  });
});
