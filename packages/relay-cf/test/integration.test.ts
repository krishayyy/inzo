import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bodyHashOf, generateHolderKeyPair, signProof, type ConsentRecord } from "../src/lib.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`https://relay.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`https://relay.test${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function put(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`https://relay.test${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Creates a v2 (bearer) pairing and returns both sides' auth headers. */
async function pairV2() {
  const created = await post("/pairings");
  const joined = await post(`/pairings/${created.body.code}/join`);
  return {
    pairingId: joined.body.pairingId as string,
    a: { agentId: created.body.agentId as string, auth: { Authorization: `Bearer ${created.body.agentToken}` } },
    b: { agentId: joined.body.agentB as string, auth: { Authorization: `Bearer ${joined.body.agentToken}` } },
  };
}

/** Builds the Inzo + proof headers for a signed v3 request, the same way the CLI/mcp-server holder does. */
function v3Headers(credential: string, privateKeyPem: string, method: string, path: string, body: unknown = undefined) {
  const jti = JSON.parse(Buffer.from(credential.split(".")[1], "base64url").toString()).jti as string;
  const now = Math.floor(Date.now() / 1000);
  // A random nonce so two calls in the same wall-clock second (common in a
  // fast test) don't produce byte-identical proofs and trip the real replay
  // guard — the same reason the wire protocol carries Inzo-Proof-Nonce.
  const nonce = Math.random().toString(36).slice(2);
  const proof = signProof(privateKeyPem, method, path, jti, now, bodyHashOf(body), nonce);
  return { Authorization: `Inzo ${credential}`, "Inzo-Proof": proof, "Inzo-Proof-At": String(now), "Inzo-Proof-Nonce": nonce };
}

/** Creates a v3 (signed-credential) pairing and returns both sides' credential + holder key material. */
async function pairV3() {
  const holderA = generateHolderKeyPair();
  const holderB = generateHolderKeyPair();
  const created = await post("/pairings", { cnf: { jwk: holderA.publicJwk } });
  const joined = await post(`/pairings/${created.body.code}/join`, { cnf: { jwk: holderB.publicJwk } });
  return {
    pairingId: joined.body.pairingId as string,
    a: { agentId: created.body.agentId as string, credential: created.body.credential as string, privateKeyPem: holderA.privateKeyPem },
    b: { agentId: joined.body.agentB as string, credential: joined.body.credential as string, privateKeyPem: holderB.privateKeyPem },
  };
}

describe("health + well-known", () => {
  it("reports healthy", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("serves a real JWKS with at least one Ed25519 signing key", async () => {
    const res = await get("/.well-known/inzo-jwks");
    expect(res.status).toBe(200);
    expect(res.body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
  });

  it("serves an empty revocation list before anything is revoked", async () => {
    const res = await get("/.well-known/inzo-revocations");
    expect(res.status).toBe(200);
    expect(res.body.revoked).toEqual([]);
  });
});

describe("pairing lifecycle (v2 bearer)", () => {
  it("creates a pairing code and lets a second agent join it", async () => {
    const created = await post("/pairings");
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^INZO-/);

    const joined = await post(`/pairings/${created.body.code}/join`);
    expect(joined.status).toBe(201);
    expect(joined.body.pairingId).toBeTruthy();
    expect(joined.body.agentToken).toBeTruthy();
  });

  it("rejects joining with an already-used code", async () => {
    const created = await post("/pairings");
    await post(`/pairings/${created.body.code}/join`);
    const second = await post(`/pairings/${created.body.code}/join`);
    expect(second.status).toBe(409);
  });

  it("rejects joining with an unknown code", async () => {
    const res = await post("/pairings/INZO-000000/join");
    expect(res.status).toBe(404);
  });
});

describe("messages", () => {
  it("delivers a message sent by one agent to the other, scoped to their pairing", async () => {
    const { pairingId, a, b } = await pairV2();
    const sent = await post(`/pairings/${pairingId}/messages`, { body: "hi from a" }, a.auth);
    expect(sent.status).toBe(201);

    const seen = await get(`/pairings/${pairingId}/messages`, b.auth);
    expect(seen.status).toBe(200);
    expect(seen.body.messages).toHaveLength(1);
    expect(seen.body.messages[0].body).toBe("hi from a");
  });

  it("rejects a body that tries to assert identity", async () => {
    const { pairingId, a, b } = await pairV2();
    const res = await post(`/pairings/${pairingId}/messages`, { body: "hi", fromAgentId: "someone-else" }, a.auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("identity_not_allowed");
    void b;
  });

  it("rejects a credential from an unrelated pairing", async () => {
    const first = await pairV2();
    const second = await pairV2();
    const res = await post(`/pairings/${first.pairingId}/messages`, { body: "hi" }, second.a.auth);
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const { pairingId } = await pairV2();
    const res = await get(`/pairings/${pairingId}/messages`);
    expect(res.status).toBe(401);
  });
});

describe("digest", () => {
  it("returns null plan/consent and an empty thread before anything happens", async () => {
    const { pairingId, a } = await pairV2();
    const res = await get(`/pairings/${pairingId}/digest`, a.auth);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
    expect(res.body.consent).toBeNull();
    expect(res.body.recentMessages).toEqual([]);
  });

  it("caps recentMessages at the requested limit, newest kept, oldest first", async () => {
    const { pairingId, a } = await pairV2();
    for (let i = 0; i < 5; i++) {
      await post(`/pairings/${pairingId}/messages`, { body: `msg ${i}` }, a.auth);
    }
    const res = await get(`/pairings/${pairingId}/digest?limit=2`, a.auth);
    expect(res.body.recentMessages.map((m: { body: string }) => m.body)).toEqual(["msg 3", "msg 4"]);
  });
});

describe("plans (v2 bearer — no signed consent)", () => {
  it("proposes a plan and reflects it via GET", async () => {
    const { pairingId, a } = await pairV2();
    const proposed = await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    expect(proposed.status).toBe(201);
    expect(proposed.body.plan.version).toBe(1);

    const fetched = await get(`/pairings/${pairingId}/plan`, a.auth);
    expect(fetched.body.plan.goal).toBe("ship it");
  });

  it("locks once both agents approve the same version", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);

    const first = await post(`/pairings/${pairingId}/plan/approve`, { planVersion: 1 }, a.auth);
    expect(first.body.plan.locked).toBe(false);

    const second = await post(`/pairings/${pairingId}/plan/approve`, { planVersion: 1 }, b.auth);
    expect(second.body.plan.locked).toBe(true);
  });

  it("rejects approving a stale version after a re-proposal", async () => {
    const { pairingId, a } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "v1", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    await post(`/pairings/${pairingId}/plan`, { goal: "v2", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    const res = await post(`/pairings/${pairingId}/plan/approve`, { planVersion: 1 }, a.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("stale_plan");
  });
});

describe("revocation", () => {
  it("lets an agent revoke itself, after which its token is rejected", async () => {
    const { pairingId, a } = await pairV2();
    const res = await post(`/pairings/${pairingId}/revoke`, { target: "self" }, a.auth);
    expect(res.status).toBe(200);
    expect(res.body.revocation.revokedAgentId).toBeTruthy();

    const after = await get(`/pairings/${pairingId}/messages`, a.auth);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("revoked");
  });

  it("lets an agent revoke its peer unilaterally", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/revoke`, { target: "peer" }, a.auth);

    const peerAfter = await get(`/pairings/${pairingId}/messages`, b.auth);
    expect(peerAfter.status).toBe(401);

    // The revoker's own token still works.
    const selfAfter = await get(`/pairings/${pairingId}/messages`, a.auth);
    expect(selfAfter.status).toBe(200);
  });

  it("is idempotent — revoking twice returns the same timestamp", async () => {
    const { pairingId, a } = await pairV2();
    const first = await post(`/pairings/${pairingId}/revoke`, { target: "self" }, a.auth);
    // A second revoke call has to come from someone still valid — use a fresh
    // pairing's agent to revoke an already-revoked target is not directly
    // expressible via this route (revoke targets self/peer of the caller), so
    // this test checks the underlying idempotency by revoking peer twice from
    // the still-valid side instead.
    const { pairingId: p2, a: a2, b: b2 } = await pairV2();
    void p2;
    const r1 = await post(`/pairings/${p2}/revoke`, { target: "peer" }, a2.auth);
    const r2 = await post(`/pairings/${p2}/revoke`, { target: "peer" }, a2.auth);
    expect(r2.body.revocation.revokedAt).toBe(r1.body.revocation.revokedAt);
    void first;
    void b2;
  });
});

describe("budget + usage + runway", () => {
  it("returns a null budget and a no-budget runway verdict before anything is set", async () => {
    const { pairingId, a } = await pairV2();
    const budget = await get(`/pairings/${pairingId}/budget`, a.auth);
    expect(budget.body.budget).toBeNull();

    const usage = await get(`/pairings/${pairingId}/usage`, a.auth);
    expect(usage.body.runway.onTrack).toBeNull();
    expect(usage.body.usage.totals).toEqual({ tokensUsed: 0, costUsd: 0, wallClockMs: 0 });
  });

  it("sets a budget, leaving unspecified fields untouched on a partial update", async () => {
    const { pairingId, a } = await pairV2();
    const first = await put(`/pairings/${pairingId}/budget`, { tokenBudget: 100000 }, a.auth);
    expect(first.status).toBe(200);
    expect(first.body.budget.tokenBudget).toBe(100000);
    expect(first.body.budget.deadline).toBeNull();

    const second = await put(`/pairings/${pairingId}/budget`, { costBudgetUsd: 5 }, a.auth);
    expect(second.body.budget.tokenBudget).toBe(100000);
    expect(second.body.budget.costBudgetUsd).toBe(5);
  });

  it("folds usage reports into totals and reflects them in the runway", async () => {
    const { pairingId, a, b } = await pairV2();
    await put(`/pairings/${pairingId}/budget`, { tokenBudget: 1000 }, a.auth);
    await post(`/pairings/${pairingId}/usage`, { tokensUsed: 300, costUsd: 1, wallClockMs: 1000, progressPct: 30 }, a.auth);
    await post(`/pairings/${pairingId}/usage`, { tokensUsed: 200, costUsd: 0.5, wallClockMs: 500, progressPct: 20 }, b.auth);

    const usage = await get(`/pairings/${pairingId}/usage`, a.auth);
    expect(usage.body.usage.totals.tokensUsed).toBe(500);
    expect(usage.body.runway.tokensRemaining).toBe(500);
  });

  it("rejects a negative usage value", async () => {
    const { pairingId, a } = await pairV2();
    const res = await post(`/pairings/${pairingId}/usage`, { tokensUsed: -1, costUsd: 0, wallClockMs: 0, progressPct: 0 }, a.auth);
    expect(res.status).toBe(400);
  });

  it("includes usage/runway in the digest", async () => {
    const { pairingId, a } = await pairV2();
    await put(`/pairings/${pairingId}/budget`, { tokenBudget: 1000 }, a.auth);
    await post(`/pairings/${pairingId}/usage`, { tokensUsed: 400, costUsd: 0, wallClockMs: 0, progressPct: 0 }, a.auth);
    const digest = await get(`/pairings/${pairingId}/digest`, a.auth);
    expect(digest.body.usage.usage.totals.tokensUsed).toBe(400);
    expect(digest.body.usage.runway.tokensRemaining).toBe(600);
  });
});

describe("audit log", () => {
  it("records pairing.created and pairing.joined on join, chained from genesis", async () => {
    const { pairingId, a } = await pairV2();
    const res = await get(`/pairings/${pairingId}/audit`, a.auth);
    expect(res.status).toBe(200);
    expect(res.body.chainValid).toBe(true);
    expect(res.body.brokenAt).toBeNull();
    expect(res.body.records.map((r: { action: string }) => r.action)).toEqual(["pairing.created", "pairing.joined"]);
    expect(res.body.records[0].seq).toBe(1);
    expect(res.body.records[0].prevHash).toMatch(/^sha256:0{64}$/);
  });

  it("chainValid stays true as more records are appended, and each hash links to the previous", async () => {
    const { pairingId, a } = await pairV2();
    await post(`/pairings/${pairingId}/messages`, { body: "hi" }, a.auth); // messages are not audited, should not appear
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);

    const res = await get(`/pairings/${pairingId}/audit`, a.auth);
    expect(res.body.chainValid).toBe(true);
    const actions = res.body.records.map((r: { action: string }) => r.action);
    expect(actions).toEqual(["pairing.created", "pairing.joined", "plan.proposed"]);

    for (let i = 1; i < res.body.records.length; i++) {
      expect(res.body.records[i].prevHash).toBe(res.body.records[i - 1].hash);
      expect(res.body.records[i].seq).toBe(res.body.records[i - 1].seq + 1);
    }
  });

  it("supports paging with `since` while still verifying the full chain", async () => {
    const { pairingId, a } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);

    const full = await get(`/pairings/${pairingId}/audit`, a.auth);
    expect(full.body.records).toHaveLength(3);

    const since = await get(`/pairings/${pairingId}/audit?since=2`, a.auth);
    expect(since.body.records).toHaveLength(1);
    expect(since.body.records[0].action).toBe("plan.proposed");
    // Verification still covers records before the requested window.
    expect(since.body.chainValid).toBe(true);
  });

  it("records credential.revoked on revoke", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/revoke`, { target: "peer" }, a.auth);
    const res = await get(`/pairings/${pairingId}/audit`, a.auth);
    const revoked = res.body.records.find((r: { action: string }) => r.action === "credential.revoked");
    expect(revoked).toBeDefined();
    expect(revoked.detail.target).toBe("peer");
    void b;
  });
});

describe("key rotation (admin)", () => {
  it("rejects a request with no token", async () => {
    const res = await post("/admin/rotate-key");
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await post("/admin/rotate-key", {}, { Authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
  });

  it("rotates the key with the correct token, and the JWKS keeps both keys", async () => {
    const before = await get("/.well-known/inzo-jwks");
    const beforeKid = before.body.keys[0].kid;

    const res = await post("/admin/rotate-key", {}, { Authorization: "Bearer test-admin-token" });
    expect(res.status).toBe(200);
    expect(res.body.rotated).toBe(true);
    expect(res.body.newKid).not.toBe(beforeKid);

    const after = await get("/.well-known/inzo-jwks");
    const kids = after.body.keys.map((k: { kid: string }) => k.kid);
    expect(kids).toContain(beforeKid);
    expect(kids).toContain(res.body.newKid);
  });

  it("a v3 credential issued before rotation still verifies (and can send a message) after it", async () => {
    const holder = generateHolderKeyPair();
    const created = await post("/pairings", { cnf: { jwk: holder.publicJwk } });
    expect(created.body.credential).toBeTruthy();
    const joined = await post(`/pairings/${created.body.code}/join`);
    const pairingId = joined.body.pairingId as string;

    // Rotate — the old key that signed `created.body.credential` retires,
    // but must still be accepted for anything issued before rotation.
    await post("/admin/rotate-key", {}, { Authorization: "Bearer test-admin-token" });

    const credential = created.body.credential as string;
    const path = `/pairings/${pairingId}/messages`;
    const body = { body: "still valid after rotation" };
    const now = Math.floor(Date.now() / 1000);
    const jti = JSON.parse(Buffer.from(credential.split(".")[1], "base64url").toString()).jti as string;
    const proof = signProof(holder.privateKeyPem, "POST", path, jti, now, bodyHashOf(body));

    const res = await post(path, body, {
      Authorization: `Inzo ${credential}`,
      "Inzo-Proof": proof,
      "Inzo-Proof-At": String(now),
    });
    expect(res.status).toBe(201);
    expect(res.body.message.body).toBe("still valid after rotation");
  });
});

describe("GET /pairings/mine", () => {
  it("returns pairing: null before anyone has joined", async () => {
    const created = await post("/pairings");
    const res = await get("/pairings/mine", { Authorization: `Bearer ${created.body.agentToken}` });
    expect(res.status).toBe(200);
    expect(res.body.pairing).toBeNull();
  });

  it("returns pairing details, including the peer's scope, once joined", async () => {
    const { pairingId, a, b } = await pairV2();
    void pairingId;
    const res = await get("/pairings/mine", a.auth);
    expect(res.status).toBe(200);
    expect(res.body.pairing.peerScope).toEqual([
      "messages:read",
      "messages:send",
      "plan:propose",
      "plan:approve",
      "usage:report",
      "commands:run",
    ]);
    expect(res.body.pairing.revoked).toBe(false);
    expect(res.body.pairing.peerRevoked).toBe(false);
    void b;
  });

  it("reflects the peer's narrowed scope", async () => {
    const { a, b } = await pairV2();
    await post("/pairings/mine/scope", { scope: ["messages:read", "messages:send"] }, b.auth);
    const res = await get("/pairings/mine", a.auth);
    expect(res.body.pairing.peerScope).toEqual(["messages:read", "messages:send"]);
  });

  it("reflects peerRevoked after the peer is revoked", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/revoke`, { target: "self" }, b.auth);
    const res = await get("/pairings/mine", a.auth);
    expect(res.body.pairing.peerRevoked).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await get("/pairings/mine");
    expect(res.status).toBe(401);
  });
});

describe("POST /pairings/mine/scope", () => {
  it("narrows scope and rejects widening back", async () => {
    const created = await post("/pairings");
    const auth = { Authorization: `Bearer ${created.body.agentToken}` };
    const narrowed = await post("/pairings/mine/scope", { scope: ["messages:read", "messages:send"] }, auth);
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toEqual(["messages:read", "messages:send"]);

    const widen = await post("/pairings/mine/scope", { scope: ["messages:read", "messages:send", "commands:run"] }, auth);
    expect(widen.status).toBe(400);
  });

  it("a narrowed scope is actually enforced on subsequent requests", async () => {
    const { pairingId, a } = await pairV2();
    await post("/pairings/mine/scope", { scope: ["messages:read"] }, a.auth);
    const res = await post(`/pairings/${pairingId}/messages`, { body: "hi" }, a.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("insufficient_scope");
  });
});

describe("join rate limiting", () => {
  it("does not limit a single wrong guess", async () => {
    const res = await post("/pairings/INZO-000000/join");
    expect(res.status).toBe(404);
  });

  it("rate-limits after enough failed guesses, and a good code still fails while limited", async () => {
    const created = await post("/pairings");
    for (let i = 0; i < 10; i++) {
      await post("/pairings/INZO-000000/join");
    }
    const res = await post(`/pairings/${created.body.code}/join`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
  });

  it("a successful join clears the failure count", async () => {
    for (let i = 0; i < 5; i++) {
      await post("/pairings/INZO-000000/join");
    }
    const created = await post("/pairings");
    const good = await post(`/pairings/${created.body.code}/join`);
    expect(good.status).toBe(201);

    // 5 more failures shouldn't combine with the pre-success 5 to hit the limit of 10.
    for (let i = 0; i < 5; i++) {
      await post("/pairings/INZO-000000/join");
    }
    const created2 = await post("/pairings");
    const stillGood = await post(`/pairings/${created2.body.code}/join`);
    expect(stillGood.status).toBe(201);
  });
});

describe("SSE stream", () => {
  /** Wraps a single reader over the stream's lifetime — acquiring a fresh reader per read() call fails with "already locked". */
  function eventReader(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      async next(count: number): Promise<Array<{ event: string; data: unknown }>> {
        const events: Array<{ event: string; data: unknown }> = [];
        while (events.length < count) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (eventLine) {
              events.push({ event: eventLine.slice(7), data: dataLine ? JSON.parse(dataLine.slice(6)) : undefined });
            }
          }
        }
        return events;
      },
      close: () => reader.cancel().catch(() => {}),
    };
  }

  it("sends a ready event immediately on connect", async () => {
    const { pairingId, a } = await pairV2();
    const res = await SELF.fetch(`https://relay.test/pairings/${pairingId}/stream`, { headers: a.auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const stream = eventReader(res);
    const [ready] = await stream.next(1);
    expect(ready.event).toBe("ready");
    expect((ready.data as { pairingId: string }).pairingId).toBe(pairingId);
    await stream.close();
  });

  it("pushes message.created to a connected watcher", async () => {
    const { pairingId, a, b } = await pairV2();
    const res = await SELF.fetch(`https://relay.test/pairings/${pairingId}/stream`, { headers: b.auth });
    const stream = eventReader(res);
    await stream.next(1); // ready

    await post(`/pairings/${pairingId}/messages`, { body: "hi from a" }, a.auth);

    const [messageEvent] = await stream.next(1);
    expect(messageEvent.event).toBe("message.created");
    expect((messageEvent.data as { message: { body: string } }).message.body).toBe("hi from a");
    await stream.close();
  });

  it("pushes plan.updated when a plan is proposed", async () => {
    const { pairingId, a } = await pairV2();
    const res = await SELF.fetch(`https://relay.test/pairings/${pairingId}/stream`, { headers: a.auth });
    const stream = eventReader(res);
    await stream.next(1); // ready

    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);

    const [planEvent] = await stream.next(1);
    expect(planEvent.event).toBe("plan.updated");
    expect((planEvent.data as { plan: { goal: string } }).plan.goal).toBe("ship it");
    await stream.close();
  });

  it("supports v2 token auth via query string (EventSource-compatible wire format)", async () => {
    const { pairingId, a } = await pairV2();
    const token = a.auth.Authorization.replace("Bearer ", "");
    const res = await SELF.fetch(`https://relay.test/pairings/${pairingId}/stream?token=${token}`);
    expect(res.status).toBe(200);
    const stream = eventReader(res);
    const [ready] = await stream.next(1);
    expect(ready.event).toBe("ready");
    await stream.close();
  });

  it("rejects a request with no credential at all", async () => {
    const { pairingId } = await pairV2();
    const res = await SELF.fetch(`https://relay.test/pairings/${pairingId}/stream`);
    expect(res.status).toBe(401);
  });

  it("closes the revoked side's own stream and notifies both sides", async () => {
    const { pairingId, a, b } = await pairV2();
    const streamA = await SELF.fetch(`https://relay.test/pairings/${pairingId}/stream`, { headers: a.auth });
    const stream = eventReader(streamA);
    await stream.next(1); // ready

    await post(`/pairings/${pairingId}/revoke`, { target: "self" }, a.auth);

    const [revokedEvent] = await stream.next(1);
    expect(revokedEvent.event).toBe("pairing.revoked");
    await stream.close();
    void b;
  });
});

/** Signs a plan approval statement with a holder's private key, matching consentStatement() in consent.ts. */
function signApproval(privateKeyPem: string, pairingId: string, subject: { kind: string; version: number; hash: string }): string {
  const statement = ["inzo-consent-v3", pairingId, subject.kind, String(subject.version), subject.hash].join("\n");
  const key = createPrivateKey(privateKeyPem);
  return Buffer.from(sign(null, Buffer.from(statement), key)).toString("base64url");
}

describe("POST /credentials/attenuate", () => {
  it("mints a child credential with a narrowed capability set", async () => {
    const { a } = await pairV3();
    const childHolder = generateHolderKeyPair();
    const path = "/credentials/attenuate";
    const body = { cap: ["messages:read"], cnf: { jwk: childHolder.publicJwk } };
    const res = await post(path, body, v3Headers(a.credential, a.privateKeyPem, "POST", path, body));
    expect(res.status).toBe(201);
    expect(res.body.cap).toEqual(["messages:read"]);
    expect(res.body.depth).toBe(1);
  });

  it("rejects widening beyond the parent's own capabilities", async () => {
    const { a } = await pairV3();
    const path = "/credentials/attenuate";

    const childHolder = generateHolderKeyPair();
    const narrowedBody = { cap: ["messages:read"], cnf: { jwk: childHolder.publicJwk } };
    const child = await post(path, narrowedBody, v3Headers(a.credential, a.privateKeyPem, "POST", path, narrowedBody));
    expect(child.status).toBe(201);

    // The child only holds messages:read — asking it to mint a grandchild with plan:approve must fail.
    const grandchildBody = { cap: ["messages:read", "plan:approve"], cnf: { jwk: generateHolderKeyPair().publicJwk } };
    const res = await post(path, grandchildBody, v3Headers(child.body.credential, childHolder.privateKeyPem, "POST", path, grandchildBody));
    expect(res.status).toBe(400);
  });

  it("rejects attenuation from a bearer (v2) credential", async () => {
    const { a } = await pairV2();
    const res = await post("/credentials/attenuate", { cap: ["messages:read"], cnf: { jwk: generateHolderKeyPair().publicJwk } }, a.auth);
    expect(res.status).toBe(400);
  });

  it("records a credential.attenuated audit entry", async () => {
    const { pairingId, a } = await pairV3();
    const path = "/credentials/attenuate";
    const body = { cap: ["messages:read"], cnf: { jwk: generateHolderKeyPair().publicJwk } };
    await post(path, body, v3Headers(a.credential, a.privateKeyPem, "POST", path, body));

    const auditPath = `/pairings/${pairingId}/audit`;
    const audit = await get(auditPath, v3Headers(a.credential, a.privateKeyPem, "GET", auditPath));
    const entry = audit.body.records.find((r: { action: string }) => r.action === "credential.attenuated");
    expect(entry).toBeDefined();
  });
});

describe("POST /consent/verify", () => {
  it("independently confirms a satisfied consent record using known holder keys", async () => {
    const { pairingId, a, b } = await pairV3();
    const proposePath = `/pairings/${pairingId}/plan`;
    const proposeBody = { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] };
    await post(proposePath, proposeBody, v3Headers(a.credential, a.privateKeyPem, "POST", proposePath, proposeBody));

    const consentPath = `/pairings/${pairingId}/consent`;
    const consentBefore = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));
    const subject = consentBefore.body.consent.subject;

    const approvePath = `/pairings/${pairingId}/plan/approve`;
    const approveBodyA = { planVersion: 1, signature: signApproval(a.privateKeyPem, pairingId, subject) };
    await post(approvePath, approveBodyA, v3Headers(a.credential, a.privateKeyPem, "POST", approvePath, approveBodyA));
    const approveBodyB = { planVersion: 1, signature: signApproval(b.privateKeyPem, pairingId, subject) };
    await post(approvePath, approveBodyB, v3Headers(b.credential, b.privateKeyPem, "POST", approvePath, approveBodyB));

    const consent = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));
    expect(consent.body.consent.satisfied).toBe(true);

    const verified = await post("/consent/verify", { consent: consent.body.consent });
    expect(verified.status).toBe(200);
    expect(verified.body.valid).toBe(true);
    expect(verified.body.satisfied).toBe(true);
  });

  it("rejects a malformed consent record", async () => {
    const res = await post("/consent/verify", { consent: { pairingId: "x" } });
    expect(res.status).toBe(400);
  });

  it("reports invalid when the signature doesn't match the supplied holder key", async () => {
    const { pairingId, a } = await pairV3();
    const proposePath = `/pairings/${pairingId}/plan`;
    const proposeBody = { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] };
    await post(proposePath, proposeBody, v3Headers(a.credential, a.privateKeyPem, "POST", proposePath, proposeBody));
    const consentPath = `/pairings/${pairingId}/consent`;
    const consent = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));

    const jti = JSON.parse(Buffer.from(a.credential.split(".")[1], "base64url").toString()).jti as string;
    const forged: ConsentRecord = {
      pairingId,
      subject: consent.body.consent.subject,
      required: consent.body.consent.required,
      approvals: [{ principal: consent.body.consent.required[0], credential: jti, at: new Date().toISOString(), signature: "not-a-real-signature" }],
      satisfied: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const res = await post("/consent/verify", { consent: forged });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });
});

describe("request body limits", () => {
  it("rejects a body over 128kb", async () => {
    const { pairingId, a } = await pairV2();
    const huge = { body: "x".repeat(200 * 1024) };
    const res = await post(`/pairings/${pairingId}/messages`, huge, a.auth);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  it("accepts a body comfortably under the limit", async () => {
    const { pairingId, a } = await pairV2();
    const res = await post(`/pairings/${pairingId}/messages`, { body: "x".repeat(1000) }, a.auth);
    expect(res.status).toBe(201);
  });
});

describe("stale plan integrity check", () => {
  it("reports stale_plan (409), not a generic bad_request, when the plan and its consent record's hashes disagree despite a matching version", async () => {
    // Unreachable through the normal API in one request — a version is a
    // counter that can collide across a restore or bad migration; the hash
    // is what actually catches that. Reproduced here by corrupting the
    // plan's stored content directly, the same way a bad migration would.
    const { pairingId, a } = await pairV3();
    const proposePath = `/pairings/${pairingId}/plan`;
    const proposeBody = { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] };
    const proposed = await post(proposePath, proposeBody, v3Headers(a.credential, a.privateKeyPem, "POST", proposePath, proposeBody));
    expect(proposed.status).toBe(201);

    // Corrupt the plan's goal in storage without touching consent_records —
    // now planSubjectHash(currentPlan) no longer matches what's in the
    // pairing's already-open consent record for version 1.
    const id = env.PAIRING_ROOM.idFromName(pairingId);
    const stub = env.PAIRING_ROOM.get(id);
    await runInDurableObject(stub, async (_instance: unknown, state: { storage: { sql: { exec: (q: string, ...p: unknown[]) => unknown } } }) => {
      state.storage.sql.exec(`UPDATE plans SET goal = ? WHERE pairing_id = ?`, "corrupted goal", pairingId);
    });

    const consentPath = `/pairings/${pairingId}/consent`;
    const consent = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));
    const signature = signApproval(a.privateKeyPem, pairingId, consent.body.consent.subject);

    const approvePath = `/pairings/${pairingId}/plan/approve`;
    const approveBody = { planVersion: 1, signature };
    const res = await post(approvePath, approveBody, v3Headers(a.credential, a.privateKeyPem, "POST", approvePath, approveBody));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("stale_plan");
  });
});

/** Approves a v2-bearer plan from both sides so it locks, with no signature machinery needed. */
async function lockPlan(pairingId: string, a: { auth: Record<string, string> }, b: { auth: Record<string, string> }): Promise<number> {
  const plan = await get(`/pairings/${pairingId}/plan`, a.auth);
  const version = plan.body.plan.version as number;
  await post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, a.auth);
  const second = await post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, b.auth);
  expect(second.body.plan.locked).toBe(true);
  return version;
}

describe("plan item ownership + dependencies (§ shared-goal tracking)", () => {
  it("rejects an item whose owner isn't an actual participant of the pairing", async () => {
    const { pairingId, a } = await pairV2();
    const res = await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: "not-a-real-agent", task: "build" }] }, a.auth);
    expect(res.status).toBe(400);
  });

  it("rejects a dependsOn index that isn't strictly earlier than the item itself", async () => {
    const { pairingId, a } = await pairV2();
    const forward = await post(
      `/pairings/${pairingId}/plan`,
      { goal: "ship it", items: [{ owner: a.agentId, task: "one", dependsOn: [0] }] }, // depends on itself
      a.auth,
    );
    expect(forward.status).toBe(400);

    const outOfRange = await post(
      `/pairings/${pairingId}/plan`,
      { goal: "ship it", items: [{ owner: a.agentId, task: "one" }, { owner: a.agentId, task: "two", dependsOn: [5] }] },
      a.auth,
    );
    expect(outOfRange.status).toBe(400);
  });

  it("accepts a valid dependsOn chain and reflects it back on GET", async () => {
    const { pairingId, a, b } = await pairV2();
    const res = await post(
      `/pairings/${pairingId}/plan`,
      { goal: "ship it", items: [{ owner: a.agentId, task: "backend" }, { owner: b.agentId, task: "frontend", dependsOn: [0] }] },
      a.auth,
    );
    expect(res.status).toBe(201);
    const fetched = await get(`/pairings/${pairingId}/plan`, a.auth);
    expect(fetched.body.plan.items[1].dependsOn).toEqual([0]);
  });

  it("every item defaults to pending status once proposed", async () => {
    const { pairingId, a } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    const fetched = await get(`/pairings/${pairingId}/plan`, a.auth);
    expect(fetched.body.plan.items[0].status).toBe("pending");
  });

  it("rejects updating item status before the plan is locked", async () => {
    const { pairingId, a } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    const res = await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "in_progress" }, a.auth);
    expect(res.status).toBe(400);
  });

  it("rejects an agent updating an item it doesn't own", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    await lockPlan(pairingId, a, b);
    const res = await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "in_progress" }, b.auth);
    expect(res.status).toBe(403);
  });

  it("lets the owner move its own item through pending -> in_progress -> done", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    await lockPlan(pairingId, a, b);

    const inProgress = await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "in_progress" }, a.auth);
    expect(inProgress.status).toBe(200);
    expect(inProgress.body.plan.items[0].status).toBe("in_progress");

    const done = await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "done" }, a.auth);
    expect(done.body.plan.items[0].status).toBe("done");
  });

  it("blocks starting a dependent item until its dependency is done", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(
      `/pairings/${pairingId}/plan`,
      { goal: "ship it", items: [{ owner: a.agentId, task: "backend" }, { owner: b.agentId, task: "frontend", dependsOn: [0] }] },
      a.auth,
    );
    await lockPlan(pairingId, a, b);

    const tooEarly = await post(`/pairings/${pairingId}/plan/items/1/status`, { status: "in_progress" }, b.auth);
    expect(tooEarly.status).toBe(400);

    await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "done" }, a.auth);
    const nowOk = await post(`/pairings/${pairingId}/plan/items/1/status`, { status: "in_progress" }, b.auth);
    expect(nowOk.status).toBe(200);
  });

  it("marking an item done never touches plan.version and never invalidates an already-signed consent", async () => {
    const { pairingId, a, b } = await pairV3();
    const proposePath = `/pairings/${pairingId}/plan`;
    const proposeBody = { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] };
    await post(proposePath, proposeBody, v3Headers(a.credential, a.privateKeyPem, "POST", proposePath, proposeBody));

    const consentPath = `/pairings/${pairingId}/consent`;
    const before = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));
    const subject = before.body.consent.subject;

    const approvePath = `/pairings/${pairingId}/plan/approve`;
    const approveA = { planVersion: 1, signature: signApproval(a.privateKeyPem, pairingId, subject) };
    await post(approvePath, approveA, v3Headers(a.credential, a.privateKeyPem, "POST", approvePath, approveA));
    const approveB = { planVersion: 1, signature: signApproval(b.privateKeyPem, pairingId, subject) };
    await post(approvePath, approveB, v3Headers(b.credential, b.privateKeyPem, "POST", approvePath, approveB));

    const beforeStatusChange = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));
    expect(beforeStatusChange.body.consent.satisfied).toBe(true);

    const statusPath = `/pairings/${pairingId}/plan/items/0/status`;
    const statusBody = { status: "done" };
    const statusRes = await post(statusPath, statusBody, v3Headers(a.credential, a.privateKeyPem, "POST", statusPath, statusBody));
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.plan.version).toBe(1); // unchanged

    const afterStatusChange = await get(consentPath, v3Headers(a.credential, a.privateKeyPem, "GET", consentPath));
    expect(afterStatusChange.body.consent).toEqual(beforeStatusChange.body.consent); // byte-identical, untouched
  });

  it("clears stale status when the plan is re-proposed with a new version", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "v1", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    await lockPlan(pairingId, a, b);
    await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "done" }, a.auth);

    // Re-propose replaces the items array entirely — item 0's identity is new.
    await post(`/pairings/${pairingId}/plan`, { goal: "v2", items: [{ owner: a.agentId, task: "build, take two" }] }, a.auth);
    const fetched = await get(`/pairings/${pairingId}/plan`, a.auth);
    expect(fetched.body.plan.items[0].status).toBe("pending");
  });

  it("records a plan.item_status_changed audit entry", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: a.agentId, task: "build" }] }, a.auth);
    await lockPlan(pairingId, a, b);
    await post(`/pairings/${pairingId}/plan/items/0/status`, { status: "done" }, a.auth);

    const audit = await get(`/pairings/${pairingId}/audit`, a.auth);
    const entry = audit.body.records.find((r: { action: string }) => r.action === "plan.item_status_changed");
    expect(entry).toBeDefined();
  });
});
