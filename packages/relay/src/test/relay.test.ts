import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

function setup() {
  const store = new RelayStore();
  return { store, app: createApp(store) };
}

describe("v2 authenticated relay", () => {
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
    const creator = (await request(app).post("/pairings").send({})).body;
    const joiner = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
    const auth = { Authorization: `Bearer ${creator.agentToken}` };
    const forged = await request(app).post(`/pairings/${joiner.pairingId}/messages`).set(auth).send({ body: "hi", fromAgentId: joiner.agentId });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("identity_not_allowed");
    const sent = await request(app).post(`/pairings/${joiner.pairingId}/messages`).set(auth).send({ body: "hi" });
    expect(sent.status).toBe(201);
    expect(sent.body.message.fromAgentId).toBe(creator.agentId);
    store.close();
  });

  it("prevents unauthenticated or cross-pairing reads", async () => {
    const { app, store } = setup();
    const a = (await request(app).post("/pairings").send({})).body;
    const b = (await request(app).post(`/pairings/${a.code}/join`).send({})).body;
    const c = (await request(app).post("/pairings").send({})).body;
    const d = (await request(app).post(`/pairings/${c.code}/join`).send({})).body;
    expect((await request(app).get(`/pairings/${b.pairingId}/messages`)).status).toBe(401);
    const forbidden = await request(app).get(`/pairings/${b.pairingId}/messages`).set("Authorization", `Bearer ${d.agentToken}`);
    expect(forbidden.status).toBe(403);
    store.close();
  });

  it("lets the code creator discover only their own pairing", async () => {
    const { app, store } = setup();
    const creator = (await request(app).post("/pairings").send({})).body;
    expect((await request(app).get("/pairings/mine").set("Authorization", `Bearer ${creator.agentToken}`)).body.pairing).toBeNull();
    const joined = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
    const mine = await request(app).get("/pairings/mine").set("Authorization", `Bearer ${creator.agentToken}`);
    expect(mine.body.pairing.id).toBe(joined.pairingId);
    store.close();
  });
});
