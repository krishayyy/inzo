import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

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

function setup() {
  const store = new RelayStore();
  return { store, app: createApp(store, {}) };
}

describe("tasks", () => {
  it("proposes a task unassigned by default", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const res = await request(app)
      .post(`/pairings/${pairingId}/tasks`)
      .set(a.auth)
      .send({ title: "Add auth middleware" });

    expect(res.status).toBe(201);
    expect(res.body.task.status).toBe("proposed");
    expect(res.body.task.assignedTo).toBeNull();
    expect(res.body.task.proposedBy).toBe(a.agentId);
    store.close();
  });

  it("can propose pre-assigned with a rationale, and lists it for both members", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    const proposed = await request(app)
      .post(`/pairings/${pairingId}/tasks`)
      .set(a.auth)
      .send({ title: "Schema migration", assignTo: b.agentId, rationale: "b declared strength in schema work" });

    expect(proposed.body.task.status).toBe("assigned");
    expect(proposed.body.task.assignedTo).toBe(b.agentId);
    expect(proposed.body.task.rationale).toMatch(/schema work/);

    const list = await request(app).get(`/pairings/${pairingId}/tasks`).set(b.auth);
    expect(list.body.tasks).toHaveLength(1);
    store.close();
  });

  it("reassigns with a new rationale, recorded to the audit trail", async () => {
    const { app, store } = setup();
    const { pairingId, a, b } = await pair(app);
    const created = await request(app).post(`/pairings/${pairingId}/tasks`).set(a.auth).send({ title: "Write tests" });
    const taskId = created.body.task.id;

    const assigned = await request(app)
      .put(`/pairings/${pairingId}/tasks/${taskId}/assign`)
      .set(a.auth)
      .send({ assignedTo: b.agentId, rationale: "more budget remaining" });
    expect(assigned.body.task.assignedTo).toBe(b.agentId);
    expect(assigned.body.task.status).toBe("assigned");

    const audit = await request(app).get(`/pairings/${pairingId}/audit`).set(a.auth);
    const entry = audit.body.records.find((r: { action: string }) => r.action === "task.assigned");
    expect(entry).toBeDefined();
    expect(entry.detail.to).toBe(b.agentId);
    expect(entry.detail.rationale).toMatch(/budget/);
    store.close();
  });

  it("rejects assigning to someone who isn't a pairing member", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const created = await request(app).post(`/pairings/${pairingId}/tasks`).set(a.auth).send({ title: "Deploy" });
    const res = await request(app)
      .put(`/pairings/${pairingId}/tasks/${created.body.task.id}/assign`)
      .set(a.auth)
      .send({ assignedTo: "agent_not_in_pairing" });
    expect(res.status).toBe(403);
    store.close();
  });

  it("moves a task through statuses, recording each transition", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const created = await request(app).post(`/pairings/${pairingId}/tasks`).set(a.auth).send({ title: "Refactor" });
    const taskId = created.body.task.id;

    const inProgress = await request(app)
      .put(`/pairings/${pairingId}/tasks/${taskId}/status`)
      .set(a.auth)
      .send({ status: "in_progress" });
    expect(inProgress.body.task.status).toBe("in_progress");

    const done = await request(app).put(`/pairings/${pairingId}/tasks/${taskId}/status`).set(a.auth).send({ status: "done" });
    expect(done.body.task.status).toBe("done");
    store.close();
  });

  it("blocks marking a task done while its dependency isn't done yet", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const dep = await request(app).post(`/pairings/${pairingId}/tasks`).set(a.auth).send({ title: "Schema first" });
    const task = await request(app)
      .post(`/pairings/${pairingId}/tasks`)
      .set(a.auth)
      .send({ title: "API second", dependsOn: [dep.body.task.id] });

    const blocked = await request(app)
      .put(`/pairings/${pairingId}/tasks/${task.body.task.id}/status`)
      .set(a.auth)
      .send({ status: "done" });
    expect(blocked.status).toBe(409);

    await request(app).put(`/pairings/${pairingId}/tasks/${dep.body.task.id}/status`).set(a.auth).send({ status: "done" });
    const nowAllowed = await request(app)
      .put(`/pairings/${pairingId}/tasks/${task.body.task.id}/status`)
      .set(a.auth)
      .send({ status: "done" });
    expect(nowAllowed.status).toBe(200);
    store.close();
  });

  it("rejects dependsOn referencing an unknown task id", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const res = await request(app)
      .post(`/pairings/${pairingId}/tasks`)
      .set(a.auth)
      .send({ title: "Orphan dep", dependsOn: ["task_doesnotexist"] });
    expect(res.status).toBe(400);
    store.close();
  });

  it("rejects an empty title", async () => {
    const { app, store } = setup();
    const { pairingId, a } = await pair(app);
    const res = await request(app).post(`/pairings/${pairingId}/tasks`).set(a.auth).send({ title: "  " });
    expect(res.status).toBe(400);
    store.close();
  });
});
