/**
 * Parity tests for the Workers relay's shared memory, roster and delegation.
 *
 * These deliberately mirror packages/relay/src/test/memory.test.ts case for
 * case. Two relay implementations of the same protocol only stay honest if
 * the same assertions run against both — a behaviour that holds on the Node
 * relay and quietly differs here would be invisible to the pairing that
 * happens to be on the hosted Worker.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = Promise<{ status: number; body: any }>;

async function send(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Res {
  const res = await SELF.fetch(`https://relay.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => send("POST", path, body, headers);
const put = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => send("PUT", path, body, headers);
const get = (path: string, headers: Record<string, string> = {}) => send("GET", path, undefined, headers);
const del = (path: string, headers: Record<string, string> = {}) => send("DELETE", path, undefined, headers);

async function pair() {
  const created = await post("/pairings");
  const joined = await post(`/pairings/${created.body.code}/join`);
  return {
    pairingId: joined.body.pairingId as string,
    a: { agentId: created.body.agentId as string, auth: { Authorization: `Bearer ${created.body.agentToken}` } },
    b: { agentId: joined.body.agentId as string, auth: { Authorization: `Bearer ${joined.body.agentToken}` } },
  };
}

describe("join response contract", () => {
  it("returns the joiner's own agentId, which mcp-server persists to the session file", async () => {
    const created = await post("/pairings");
    const joined = await post(`/pairings/${created.body.code}/join`);
    // Regression: this field was missing here but present on packages/relay,
    // so every joiner against the hosted relay wrote agentId: undefined into
    // ~/.inzo/session.json and could not be identified afterwards.
    expect(typeof joined.body.agentId).toBe("string");
    expect(joined.body.agentId).toBe(joined.body.agentB);
    expect(joined.body.agentId).not.toBe(created.body.agentId);
  });
});

describe("shared memory (workers)", () => {
  it("makes one agent's memory readable by the other, under a normalized key", async () => {
    const { pairingId, a, b } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "deploy target", body: "We deploy to Fly, not Render." }, a.auth);

    const recalled = await get(`/pairings/${pairingId}/memory/recall?q=deploy`, b.auth);
    expect(recalled.status).toBe(200);
    expect(recalled.body.memories).toHaveLength(1);
    expect(recalled.body.memories[0].key).toBe("deploy-target");
    expect(recalled.body.memories[0].authorAgentId).toBe(a.agentId);
  });

  it("replaces rather than duplicates when the same key is written again", async () => {
    const { pairingId, a } = await pair();
    const first = await post(`/pairings/${pairingId}/memory`, { key: "db", body: "Postgres" }, a.auth);
    await post(`/pairings/${pairingId}/memory`, { key: "db", body: "SQLite" }, a.auth);

    const list = await get(`/pairings/${pairingId}/memory`, a.auth);
    expect(list.body.memories).toHaveLength(1);
    expect(list.body.memories[0].body).toBe("SQLite");
    expect(list.body.memories[0].id).toBe(first.body.memory.id);
  });

  it("always returns instructions, even when nothing matches the query", async () => {
    const { pairingId, a, b } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "style", body: "Never commit to main.", kind: "instruction" }, a.auth);

    const recalled = await get(`/pairings/${pairingId}/memory/recall?q=something-entirely-unrelated`, b.auth);
    expect(recalled.body.memories).toHaveLength(1);
    expect(recalled.body.memories[0].reason).toBe("instruction");
  });

  it("never leaks a private memory to the peer", async () => {
    const { pairingId, a, b } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "note", body: "internal only", visibility: "private" }, a.auth);

    expect((await get(`/pairings/${pairingId}/memory`, a.auth)).body.memories).toHaveLength(1);
    expect((await get(`/pairings/${pairingId}/memory`, b.auth)).body.memories).toHaveLength(0);
    expect((await get(`/pairings/${pairingId}/memory/recall?q=internal`, b.auth)).body.memories).toHaveLength(0);
  });

  it("refuses to let a peer overwrite a private memory or forget another's", async () => {
    const { pairingId, a, b } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "mine", body: "a's note", visibility: "private" }, a.auth);
    expect((await post(`/pairings/${pairingId}/memory`, { key: "mine", body: "b's note" }, b.auth)).status).toBe(403);

    await post(`/pairings/${pairingId}/memory`, { key: "shared", body: "team fact" }, a.auth);
    expect((await del(`/pairings/${pairingId}/memory/shared`, b.auth)).status).toBe(403);
  });

  it("cuts memory off entirely for a credential narrowed to drop memory:read", async () => {
    const { pairingId, a, b } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "k", body: "v" }, a.auth);
    await post(`/pairings/mine/scope`, { scope: ["messages:read", "messages:send"] }, b.auth);

    expect((await get(`/pairings/${pairingId}/memory/recall`, b.auth)).status).toBe(403);
  });

  it("forgets a memory so it stops being recalled", async () => {
    const { pairingId, a } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "wrong", body: "outdated" }, a.auth);
    expect((await del(`/pairings/${pairingId}/memory/wrong`, a.auth)).body.forgotten).toBe(true);
    expect((await get(`/pairings/${pairingId}/memory`, a.auth)).body.memories).toHaveLength(0);
  });

  it("records memory writes to the tamper-evident audit chain", async () => {
    const { pairingId, a } = await pair();
    await post(`/pairings/${pairingId}/memory`, { key: "audited", body: "fact" }, a.auth);
    const audit = await get(`/pairings/${pairingId}/audit`, a.auth);
    expect(audit.body.chainValid).toBe(true);
    expect(audit.body.records.some((r: { action: string }) => r.action === "memory.written")).toBe(true);
  });
});

describe("team view (workers)", () => {
  it("shows each member's model and hides usage from anyone who dropped usage:share", async () => {
    const { pairingId, a, b } = await pair();
    await put(`/pairings/${pairingId}/profile`, { model: "claude-opus-5", strengths: ["architecture"] }, a.auth);
    await put(`/pairings/${pairingId}/profile`, { model: "gpt-5-codex", strengths: ["tests"] }, b.auth);
    await post(`/pairings/${pairingId}/usage`, { tokensUsed: 5000, costUsd: 0.5 }, b.auth);
    await post(
      `/pairings/mine/scope`,
      { scope: ["messages:read", "messages:send", "plan:propose", "plan:approve", "usage:report", "commands:run", "memory:read", "memory:write"] },
      b.auth,
    );

    const team = await get(`/pairings/${pairingId}/team`, a.auth);
    expect(team.status).toBe(200);
    const byId = Object.fromEntries(team.body.members.map((m: { agentId: string }) => [m.agentId, m]));
    expect(byId[a.agentId].model).toBe("claude-opus-5");
    expect(byId[b.agentId].model).toBe("gpt-5-codex");
    expect(byId[b.agentId].sharesUsage).toBe(false);
    expect(byId[b.agentId].usage).toBeNull();
    // The team total still reflects the spend even though the row is hidden —
    // withholding your breakdown is not the same as leaving the team's books.
    expect(team.body.totals.tokensUsed).toBe(5000);
  });

  it("always shows a member their own usage", async () => {
    const { pairingId, a } = await pair();
    await post(`/pairings/${pairingId}/usage`, { tokensUsed: 100, costUsd: 0.01 }, a.auth);
    await post(`/pairings/mine/scope`, { scope: ["messages:read", "usage:report"] }, a.auth);

    const team = await get(`/pairings/${pairingId}/team`, a.auth);
    expect(team.body.members.find((m: { isSelf: boolean }) => m.isSelf).usage.tokensUsed).toBe(100);
  });
});

describe("delegation (workers)", () => {
  it("prefers the member whose declared strengths match the work", async () => {
    const { pairingId, a, b } = await pair();
    await put(`/pairings/${pairingId}/profile`, { strengths: ["docs"] }, a.auth);
    await put(`/pairings/${pairingId}/profile`, { strengths: ["rust", "performance"] }, b.auth);

    const res = await post(`/pairings/${pairingId}/delegate`, { title: "Optimize the rust hot path", needs: ["rust"] }, a.auth);
    expect(res.status).toBe(200);
    expect(res.body.suggested).toBe(b.agentId);
    expect(res.body.rationale).toContain("matches");
  });

  it("a strength match outranks being cheaper", async () => {
    const { pairingId, a, b } = await pair();
    await put(`/pairings/${pairingId}/profile`, { strengths: ["rust"] }, b.auth);
    await post(`/pairings/${pairingId}/usage`, { tokensUsed: 900000, costUsd: 9 }, b.auth);

    const res = await post(`/pairings/${pairingId}/delegate`, { needs: ["rust"] }, a.auth);
    expect(res.body.suggested).toBe(b.agentId);
  });

  it("falls back to whoever has the most runway when no strength matches", async () => {
    const { pairingId, a, b } = await pair();
    const reported = await post(`/pairings/${pairingId}/usage`, { tokensUsed: 50000, costUsd: 5 }, a.auth);
    expect(reported.status).toBe(201);

    const res = await post(`/pairings/${pairingId}/delegate`, { title: "Something novel" }, a.auth);
    expect(res.body.suggested).toBe(b.agentId);
    expect(res.body.rationale).toContain("runway");
  });
});

describe("tasks (workers)", () => {
  it("proposes, assigns, and blocks done behind an open dependency", async () => {
    const { pairingId, a, b } = await pair();
    const first = await post(`/pairings/${pairingId}/tasks`, { title: "Schema migration" }, a.auth);
    expect(first.status).toBe(201);
    expect(first.body.task.status).toBe("proposed");

    const second = await post(`/pairings/${pairingId}/tasks`, { title: "Backfill", dependsOn: [first.body.task.id] }, a.auth);
    const blocked = await put(`/pairings/${pairingId}/tasks/${second.body.task.id}/status`, { status: "done" }, a.auth);
    expect(blocked.status).toBe(409);

    const assigned = await put(
      `/pairings/${pairingId}/tasks/${first.body.task.id}/assign`,
      { assignedTo: b.agentId, rationale: "declared strength in schema work" },
      a.auth,
    );
    expect(assigned.body.task.assignedTo).toBe(b.agentId);
    expect(assigned.body.task.status).toBe("assigned");

    await put(`/pairings/${pairingId}/tasks/${first.body.task.id}/status`, { status: "done" }, b.auth);
    const nowOk = await put(`/pairings/${pairingId}/tasks/${second.body.task.id}/status`, { status: "done" }, a.auth);
    expect(nowOk.body.task.status).toBe("done");
  });
});
