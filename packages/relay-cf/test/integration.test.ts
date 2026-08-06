import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

/** Creates a v2 (bearer) pairing and returns both sides' auth headers. */
async function pairV2() {
  const created = await post("/pairings");
  const joined = await post(`/pairings/${created.body.code}/join`);
  return {
    pairingId: joined.body.pairingId as string,
    a: { auth: { Authorization: `Bearer ${created.body.agentToken}` } },
    b: { auth: { Authorization: `Bearer ${joined.body.agentToken}` } },
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
    const proposed = await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: "a", task: "build" }] }, a.auth);
    expect(proposed.status).toBe(201);
    expect(proposed.body.plan.version).toBe(1);

    const fetched = await get(`/pairings/${pairingId}/plan`, a.auth);
    expect(fetched.body.plan.goal).toBe("ship it");
  });

  it("locks once both agents approve the same version", async () => {
    const { pairingId, a, b } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "ship it", items: [{ owner: "a", task: "build" }] }, a.auth);

    const first = await post(`/pairings/${pairingId}/plan/approve`, { planVersion: 1 }, a.auth);
    expect(first.body.plan.locked).toBe(false);

    const second = await post(`/pairings/${pairingId}/plan/approve`, { planVersion: 1 }, b.auth);
    expect(second.body.plan.locked).toBe(true);
  });

  it("rejects approving a stale version after a re-proposal", async () => {
    const { pairingId, a } = await pairV2();
    await post(`/pairings/${pairingId}/plan`, { goal: "v1", items: [{ owner: "a", task: "build" }] }, a.auth);
    await post(`/pairings/${pairingId}/plan`, { goal: "v2", items: [{ owner: "a", task: "build" }] }, a.auth);
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
