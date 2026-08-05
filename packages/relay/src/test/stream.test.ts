import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

/**
 * These run against a real socket rather than supertest: SSE is a long-lived
 * response, and the thing worth testing is that events actually arrive while
 * the connection stays open.
 */
let open: Array<{ server: Server; store: RelayStore }> = [];

afterEach(async () => {
  for (const { server, store } of open) {
    // An SSE response is an open connection by design, and server.close()
    // waits for those, so drop them explicitly rather than hanging teardown.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
  open = [];
});

async function boot() {
  const store = new RelayStore();
  const app = createApp(store);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push({ server, store });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const creator = await (await fetch(`${base}/pairings`, { method: "POST" })).json();
  const joiner = await (
    await fetch(`${base}/pairings/${creator.code}/join`, { method: "POST" })
  ).json();

  return { base, creator, joiner, pairingId: joiner.pairingId as string };
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Reads the stream until `predicate` is satisfied, then gives up the socket. */
async function readUntil(
  response: Response,
  predicate: (events: SseEvent[]) => boolean,
  timeoutMs = 4000,
): Promise<SseEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  // A quiet stream parks inside reader.read() until the next ping 25s later,
  // so the deadline has to race the read rather than only being checked
  // between frames.
  const expired = Symbol("expired");
  const readOrExpire = async () => {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };

  try {
    while (Date.now() < deadline) {
      const next = await readOrExpire();
      if (next === expired) break;
      const { value, done } = next;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event) events.push({ event, data: data ? JSON.parse(data) : undefined });
      }
      if (predicate(events)) return events;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

const names = (events: SseEvent[]) => events.map((e) => e.event);

describe("SSE stream", () => {
  it("rejects an unauthenticated subscriber", async () => {
    const { base, pairingId } = await boot();
    const res = await fetch(`${base}/pairings/${pairingId}/stream`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("accepts the token as a query param, since EventSource cannot set headers", async () => {
    const { base, pairingId, creator } = await boot();
    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readUntil(res, (e) => names(e).includes("ready"));
    expect(names(events)).toContain("ready");
  });

  it("pushes a peer's message to a watching human without polling", async () => {
    const { base, pairingId, creator, joiner } = await boot();
    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    const received = readUntil(res, (e) => names(e).includes("message.created"));

    await fetch(`${base}/pairings/${pairingId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ body: "I can own the API contract." }),
    });

    const events = await received;
    const message = events.find((e) => e.event === "message.created")!.data as {
      message: { body: string; fromAgentId: string };
    };
    expect(message.message.body).toBe("I can own the API contract.");
    expect(message.message.fromAgentId).toBe(joiner.agentId);
  });

  it("pushes plan updates so both humans see a proposal as it lands", async () => {
    const { base, pairingId, creator, joiner } = await boot();
    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    const received = readUntil(res, (e) => names(e).includes("plan.updated"));

    await fetch(`${base}/pairings/${pairingId}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ goal: "ship the core loop", items: [{ owner: joiner.agentId, task: "ui" }] }),
    });

    const events = await received;
    const plan = events.find((e) => e.event === "plan.updated")!.data as { plan: { goal: string; version: number } };
    expect(plan.plan.goal).toBe("ship the core loop");
    expect(plan.plan.version).toBe(1);
  });

  it("recomputes runway at emit time rather than shipping a stale copy", async () => {
    const { base, pairingId, creator, joiner } = await boot();
    await fetch(`${base}/pairings/${pairingId}/budget`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creator.agentToken}` },
      body: JSON.stringify({ tokenBudget: 1000 }),
    });

    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    const received = readUntil(res, (e) => names(e).includes("usage.reported"));

    await fetch(`${base}/pairings/${pairingId}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ tokensUsed: 250, costUsd: 0, wallClockMs: 1000, progressPct: 10 }),
    });

    const events = await received;
    const snapshot = events.find((e) => e.event === "usage.reported")!.data as {
      runway: { tokensRemaining: number };
    };
    expect(snapshot.runway.tokensRemaining).toBe(750);
  });

  it("tells a watching human when the peer pulls the kill switch", async () => {
    const { base, pairingId, creator, joiner } = await boot();
    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    const received = readUntil(res, (e) => names(e).includes("pairing.revoked"));

    await fetch(`${base}/pairings/${pairingId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ target: "peer" }),
    });

    const events = await received;
    const revocation = events.find((e) => e.event === "pairing.revoked")!.data as {
      revocation: { revokedAgentId: string; by: string };
    };
    expect(revocation.revocation.revokedAgentId).toBe(creator.agentId);
    expect(revocation.revocation.by).toBe(joiner.agentId);
  });

  it("closes the stream of the credential being revoked", async () => {
    const { base, pairingId, creator, joiner } = await boot();
    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    // Reading to completion only terminates if the server ends the response.
    const finished = readUntil(res, () => false, 4000);

    await fetch(`${base}/pairings/${pairingId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${joiner.agentToken}` },
      body: JSON.stringify({ target: "peer" }),
    });

    const events = await finished;
    expect(names(events)).toContain("pairing.revoked");
  }, 10_000);

  it("never leaks another pairing's events", async () => {
    const { base, pairingId, creator } = await boot();
    const otherCreator = await (await fetch(`${base}/pairings`, { method: "POST" })).json();
    const otherJoiner = await (
      await fetch(`${base}/pairings/${otherCreator.code}/join`, { method: "POST" })
    ).json();

    const res = await fetch(`${base}/pairings/${pairingId}/stream?token=${creator.agentToken}`);
    const received = readUntil(res, (e) => names(e).includes("message.created"), 1200);

    await fetch(`${base}/pairings/${otherJoiner.pairingId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherJoiner.agentToken}` },
      body: JSON.stringify({ body: "not for you" }),
    });

    const events = await received;
    expect(names(events)).not.toContain("message.created");
    expect(names(events)).toContain("ready");
  });
});
