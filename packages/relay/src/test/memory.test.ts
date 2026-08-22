import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

async function pair(app: ReturnType<typeof createApp>) {
  const creator = (await request(app).post("/pairings").send({})).body;
  const joiner = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
  return {
    pairingId: joiner.pairingId as string,
    a: { agentId: creator.agentId as string, auth: { Authorization: `Bearer ${creator.agentToken}` } },
    b: { agentId: joiner.agentId as string, auth: { Authorization: `Bearer ${joiner.agentToken}` } },
  };
}

function setup() {
  const store = new RelayStore();
  return { store, app: createApp(store, {}) };
}

describe("shared memory", () => {
  it("makes one agent's memory readable by the other", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);

    await request(app)
      .post(`/pairings/${pairingId}/memory`)
      .set(a.auth)
      .send({ key: "deploy target", body: "We deploy to Fly, not Render." });

    const recalled = await request(app).get(`/pairings/${pairingId}/memory/recall?q=deploy`).set(b.auth);
    expect(recalled.status).toBe(200);
    expect(recalled.body.memories).toHaveLength(1);
    // Keys are normalized so "deploy target" and "deploy-target" are one fact.
    expect(recalled.body.memories[0].key).toBe("deploy-target");
    expect(recalled.body.memories[0].authorAgentId).toBe(a.agentId);
    store.close();
  });

  it("replaces rather than duplicates when the same key is written again", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const first = await request(app)
      .post(`/pairings/${pairingId}/memory`)
      .set(a.auth)
      .send({ key: "db", body: "Postgres" });
    await request(app).post(`/pairings/${pairingId}/memory`).set(a.auth).send({ key: "db", body: "SQLite" });

    const list = await request(app).get(`/pairings/${pairingId}/memory`).set(a.auth);
    expect(list.body.memories).toHaveLength(1);
    expect(list.body.memories[0].body).toBe("SQLite");
    // Identity is stable across a replacement, so references to it survive.
    expect(list.body.memories[0].id).toBe(first.body.memory.id);
    store.close();
  });

  it("always returns instructions, even when nothing matches the query", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/memory`)
      .set(a.auth)
      .send({ key: "style", body: "Never commit to main.", kind: "instruction" });

    const recalled = await request(app)
      .get(`/pairings/${pairingId}/memory/recall?q=something-entirely-unrelated`)
      .set(b.auth);
    expect(recalled.body.memories).toHaveLength(1);
    expect(recalled.body.memories[0].reason).toBe("instruction");
    store.close();
  });

  it("never leaks a private memory to the peer", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/memory`)
      .set(a.auth)
      .send({ key: "secret-repo-note", body: "internal only", visibility: "private" });

    const mine = await request(app).get(`/pairings/${pairingId}/memory`).set(a.auth);
    expect(mine.body.memories).toHaveLength(1);

    const theirs = await request(app).get(`/pairings/${pairingId}/memory`).set(b.auth);
    expect(theirs.body.memories).toHaveLength(0);

    const theirRecall = await request(app).get(`/pairings/${pairingId}/memory/recall?q=internal`).set(b.auth);
    expect(theirRecall.body.memories).toHaveLength(0);
    store.close();
  });

  it("refuses to let a peer overwrite or forget another member's memory", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app)
      .post(`/pairings/${pairingId}/memory`)
      .set(a.auth)
      .send({ key: "mine", body: "a's note", visibility: "private" });

    const overwrite = await request(app)
      .post(`/pairings/${pairingId}/memory`)
      .set(b.auth)
      .send({ key: "mine", body: "b's note" });
    expect(overwrite.status).toBe(403);

    await request(app).post(`/pairings/${pairingId}/memory`).set(a.auth).send({ key: "shared", body: "team fact" });
    const forget = await request(app).delete(`/pairings/${pairingId}/memory/shared`).set(b.auth);
    expect(forget.status).toBe(403);
    store.close();
  });

  it("cuts memory off entirely for a credential narrowed to drop memory:read", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app).post(`/pairings/${pairingId}/memory`).set(a.auth).send({ key: "k", body: "v" });

    await request(app).post(`/pairings/mine/scope`).set(b.auth).send({ scope: ["messages:read", "messages:send"] });

    const blocked = await request(app).get(`/pairings/${pairingId}/memory/recall`).set(b.auth);
    expect(blocked.status).toBe(403);
    store.close();
  });

  it("forgets a memory so it stops being recalled", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app).post(`/pairings/${pairingId}/memory`).set(a.auth).send({ key: "wrong", body: "outdated" });
    const forgotten = await request(app).delete(`/pairings/${pairingId}/memory/wrong`).set(a.auth);
    expect(forgotten.body.forgotten).toBe(true);

    const list = await request(app).get(`/pairings/${pairingId}/memory`).set(a.auth);
    expect(list.body.memories).toHaveLength(0);
    store.close();
  });
});

describe("team view", () => {
  it("shows each member's model, and hides usage from anyone who dropped usage:share", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);

    await request(app).put(`/pairings/${pairingId}/profile`).set(a.auth).send({ model: "claude-opus-5", strengths: ["architecture"] });
    await request(app).put(`/pairings/${pairingId}/profile`).set(b.auth).send({ model: "gpt-5-codex", strengths: ["tests"] });
    await request(app).post(`/pairings/${pairingId}/usage`).set(b.auth).send({ tokensUsed: 5000, costUsd: 0.5 });

    // b keeps everything except usage:share.
    await request(app)
      .post(`/pairings/mine/scope`)
      .set(b.auth)
      .send({ scope: ["messages:read", "messages:send", "plan:propose", "plan:approve", "usage:report", "commands:run", "memory:read", "memory:write"] });

    const team = await request(app).get(`/pairings/${pairingId}/team`).set(a.auth);
    expect(team.status).toBe(200);
    const byId = Object.fromEntries(team.body.members.map((m: { agentId: string }) => [m.agentId, m]));
    expect(byId[a.agentId].model).toBe("claude-opus-5");
    expect(byId[b.agentId].model).toBe("gpt-5-codex");
    expect(byId[b.agentId].sharesUsage).toBe(false);
    expect(byId[b.agentId].usage).toBeNull();
    store.close();
  });

  it("always shows a member their own usage", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    await request(app).post(`/pairings/${pairingId}/usage`).set(a.auth).send({ tokensUsed: 100, costUsd: 0.01 });
    await request(app).post(`/pairings/mine/scope`).set(a.auth).send({ scope: ["messages:read", "usage:report"] });

    const team = await request(app).get(`/pairings/${pairingId}/team`).set(a.auth);
    const self = team.body.members.find((m: { isSelf: boolean }) => m.isSelf);
    expect(self.usage.tokensUsed).toBe(100);
    store.close();
  });
});

describe("delegation", () => {
  it("prefers the member whose declared strengths match the work", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app).put(`/pairings/${pairingId}/profile`).set(a.auth).send({ strengths: ["docs"] });
    await request(app).put(`/pairings/${pairingId}/profile`).set(b.auth).send({ strengths: ["rust", "performance"] });

    const res = await request(app)
      .post(`/pairings/${pairingId}/delegate`)
      .set(a.auth)
      .send({ title: "Optimize the rust hot path", needs: ["rust"] });

    expect(res.status).toBe(200);
    expect(res.body.suggested).toBe(b.agentId);
    expect(res.body.rationale).toContain("matches");
    store.close();
  });

  it("a strength match outranks being cheaper", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    await request(app).put(`/pairings/${pairingId}/profile`).set(b.auth).send({ strengths: ["rust"] });
    // b is far busier, but is still the right agent for the job.
    await request(app).post(`/pairings/${pairingId}/usage`).set(b.auth).send({ tokensUsed: 900_000, costUsd: 9 });

    const res = await request(app).post(`/pairings/${pairingId}/delegate`).set(a.auth).send({ needs: ["rust"] });
    expect(res.body.suggested).toBe(b.agentId);
    store.close();
  });

  it("falls back to whoever has the most runway when no strength matches", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    const reported = await request(app)
      .post(`/pairings/${pairingId}/usage`)
      .set(a.auth)
      .send({ tokensUsed: 50_000, costUsd: 5 });
    // Asserted, not assumed: with no usage on record both members tie, and the
    // fallback below would pass or fail on member ordering rather than runway.
    expect(reported.status).toBe(201);

    const res = await request(app).post(`/pairings/${pairingId}/delegate`).set(a.auth).send({ title: "Something novel" });
    expect(res.body.suggested).toBe(b.agentId);
    expect(res.body.rationale).toContain("runway");
    store.close();
  });
});
