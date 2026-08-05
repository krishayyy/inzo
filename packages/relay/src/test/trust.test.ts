/**
 * End-to-end v3 over HTTP — PROTOCOL.md §12 conformance, at the wire.
 *
 * `credential.test.ts` proves the primitives in isolation. This proves the
 * primitives are actually reachable: that the middleware really rejects a
 * missing proof, that consent really flows through the plan route, and that
 * the audit chain a client can export is the one the relay actually kept.
 */

import request from "supertest";
import { sign as cryptoSign, createPrivateKey, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";
import { bodyHashOf, generateHolderKeyPair, signProof } from "../lib/credential.js";
import { consentStatement, planSubjectHash } from "../lib/consent.js";

type Holder = ReturnType<typeof generateHolderKeyPair>;

interface Side {
  agentId: string;
  principalId: string;
  credential: string;
  holder: Holder;
}

function setup() {
  const store = new RelayStore(":memory:", "https://relay.test");
  return { store, app: createApp(store) };
}

/** Builds the three headers a v3 request carries — §1.2. */
function authFor(side: Side, method: string, path: string, body?: unknown, nonce = randomUUID()) {
  const at = Math.floor(Date.now() / 1000);
  const bodyHash = bodyHashOf(body);
  const jti = JSON.parse(Buffer.from(side.credential.split(".")[1], "base64url").toString()).jti as string;
  return {
    Authorization: `Inzo ${side.credential}`,
    "Inzo-Proof": signProof(side.holder.privateKeyPem, method, path, jti, at, bodyHash, nonce),
    "Inzo-Proof-At": String(at),
    "Inzo-Proof-Nonce": nonce,
  };
}

async function pairV3(app: ReturnType<typeof createApp>) {
  const holderA = generateHolderKeyPair();
  const holderB = generateHolderKeyPair();
  const creator = (await request(app).post("/pairings").send({ cnf: { jwk: holderA.publicJwk } })).body;
  const joiner = (
    await request(app).post(`/pairings/${creator.code}/join`).send({ cnf: { jwk: holderB.publicJwk } })
  ).body;
  return {
    pairingId: joiner.pairingId as string,
    a: { ...creator, holder: holderA } as Side & { code: string },
    b: { ...joiner, agentId: joiner.agentId, holder: holderB } as Side,
  };
}

function signConsent(holder: Holder, pairingId: string, version: number, hash: string) {
  return cryptoSign(
    null,
    Buffer.from(consentStatement(pairingId, { kind: "plan", version, hash })),
    createPrivateKey(holder.privateKeyPem),
  ).toString("base64url");
}

describe("v3 discovery (§4)", () => {
  it("publishes verifiable signing keys without authentication", async () => {
    const { app } = setup();
    const res = await request(app).get("/.well-known/inzo-jwks").expect(200);
    expect(res.body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(res.headers["cache-control"]).toContain("max-age");
  });

  it("publishes a revocation list that names revoked credentials", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const path = `/pairings/${pairingId}/revoke`;
    await request(app).post(path).set(authFor(a, "POST", path, { target: "peer" })).send({ target: "peer" }).expect(200);

    const list = (await request(app).get("/.well-known/inzo-revocations").expect(200)).body;
    expect(list.issuer).toBe("https://relay.test");
    expect(list.revoked.length).toBeGreaterThan(0);

    // And the revoked side is actually locked out, including on reads.
    const read = `/pairings/${pairingId}/messages`;
    await request(app).get(read).set(authFor(b, "GET", read)).expect(401);
  });
});

describe("v3 authentication (§1.2)", () => {
  it("accepts a properly proofed request", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const path = `/pairings/${pairingId}/messages`;
    await request(app)
      .post(path)
      .set(authFor(a, "POST", path, { body: "hello" }))
      .send({ body: "hello" })
      .expect(201);
  });

  it("rejects a credential presented without a proof", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const res = await request(app)
      .post(`/pairings/${pairingId}/messages`)
      .set({ Authorization: `Inzo ${a.credential}` })
      .send({ body: "hello" })
      .expect(401);
    expect(res.body.error.code).toBe("proof_invalid");
  });

  it("rejects a credential proofed with someone else's key", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const path = `/pairings/${pairingId}/messages`;
    const stolen = { ...a, holder: b.holder }; // has the credential, not the key
    const res = await request(app)
      .post(path)
      .set(authFor(stolen, "POST", path, { body: "hi" }))
      .send({ body: "hi" })
      .expect(401);
    expect(res.body.error.code).toBe("proof_invalid");
  });

  it("rejects a body swapped after the proof was made", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const path = `/pairings/${pairingId}/messages`;
    const headers = authFor(a, "POST", path, { body: "safe" });
    const res = await request(app).post(path).set(headers).send({ body: "hostile" }).expect(401);
    expect(res.body.error.code).toBe("proof_invalid");
  });

  it("refuses a replayed request", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const path = `/pairings/${pairingId}/messages`;
    const headers = authFor(a, "POST", path, { body: "once" });
    await request(app).post(path).set(headers).send({ body: "once" }).expect(201);
    const res = await request(app).post(path).set(headers).send({ body: "once" }).expect(401);
    expect(res.body.error.code).toBe("proof_replayed");
  });

  it("still rejects self-asserted identity in the body", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const path = `/pairings/${pairingId}/messages`;
    const body = { body: "hi", principalId: "prn_evil" };
    const res = await request(app).post(path).set(authFor(a, "POST", path, body)).send(body).expect(400);
    expect(res.body.error.code).toBe("identity_not_allowed");
  });
});

describe("v3 attenuation over the wire (§2)", () => {
  it("issues a narrowed child and enforces the narrowing on use", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const childHolder = generateHolderKeyPair();
    const body = { cap: ["messages:read"], cnf: { jwk: childHolder.publicJwk } };

    const issued = (
      await request(app)
        .post("/credentials/attenuate")
        .set(authFor(a, "POST", "/credentials/attenuate", body))
        .send(body)
        .expect(201)
    ).body;
    expect(issued.cap).toEqual(["messages:read"]);
    expect(issued.depth).toBe(1);

    const child: Side = { ...a, credential: issued.credential, holder: childHolder };
    const read = `/pairings/${pairingId}/messages`;
    await request(app).get(read).set(authFor(child, "GET", read)).expect(200);

    // ...but the capability it gave up is genuinely gone.
    const send = `/pairings/${pairingId}/messages`;
    const res = await request(app)
      .post(send)
      .set(authFor(child, "POST", send, { body: "x" }))
      .send({ body: "x" })
      .expect(403);
    expect(res.body.error.code).toBe("insufficient_scope");
  });

  it("refuses to widen", async () => {
    const { app } = setup();
    const { a } = await pairV3(app);
    const childHolder = generateHolderKeyPair();
    const narrow = { cap: ["messages:read"], cnf: { jwk: childHolder.publicJwk } };
    const issued = (
      await request(app)
        .post("/credentials/attenuate")
        .set(authFor(a, "POST", "/credentials/attenuate", narrow))
        .send(narrow)
        .expect(201)
    ).body;

    const child: Side = { ...a, credential: issued.credential, holder: childHolder };
    const grab = { cap: ["messages:read", "commands:run"], cnf: { jwk: generateHolderKeyPair().publicJwk } };
    const res = await request(app)
      .post("/credentials/attenuate")
      .set(authFor(child, "POST", "/credentials/attenuate", grab))
      .send(grab)
      .expect(400);
    expect(res.body.error.message).toMatch(/cannot widen/i);
  });

  it("kills a child when its parent is revoked", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const childHolder = generateHolderKeyPair();
    const body = { cap: ["messages:read"], cnf: { jwk: childHolder.publicJwk } };
    const issued = (
      await request(app)
        .post("/credentials/attenuate")
        .set(authFor(b, "POST", "/credentials/attenuate", body))
        .send(body)
        .expect(201)
    ).body;
    const child: Side = { ...b, credential: issued.credential, holder: childHolder };

    const revoke = `/pairings/${pairingId}/revoke`;
    await request(app).post(revoke).set(authFor(a, "POST", revoke, { target: "peer" })).send({ target: "peer" });

    const read = `/pairings/${pairingId}/messages`;
    const res = await request(app).get(read).set(authFor(child, "GET", read)).expect(401);
    expect(res.body.error.code).toBe("revoked");
  });
});

describe("v3 consent (§6)", () => {
  async function proposeAndRead(app: ReturnType<typeof createApp>, pairingId: string, a: Side, goal = "Ship the loop") {
    const body = { goal, items: [{ owner: a.agentId, task: "relay" }] };
    const path = `/pairings/${pairingId}/plan`;
    const plan = (await request(app).post(path).set(authFor(a, "POST", path, body)).send(body).expect(201)).body.plan;
    return plan as { version: number; goal: string; items: Array<{ owner: string; task: string }> };
  }

  it("requires both principals before it is satisfied", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const plan = await proposeAndRead(app, pairingId, a);
    const hash = planSubjectHash({ pairingId, goal: plan.goal, items: plan.items, version: plan.version });
    const path = `/pairings/${pairingId}/plan/approve`;

    const bodyA = { planVersion: plan.version, signature: signConsent(a.holder, pairingId, plan.version, hash) };
    const first = (await request(app).post(path).set(authFor(a, "POST", path, bodyA)).send(bodyA).expect(200)).body;
    expect(first.consent.satisfied).toBe(false);

    const bodyB = { planVersion: plan.version, signature: signConsent(b.holder, pairingId, plan.version, hash) };
    const second = (await request(app).post(path).set(authFor(b, "POST", path, bodyB)).send(bodyB).expect(200)).body;
    expect(second.consent.satisfied).toBe(true);
    expect(second.plan.locked).toBe(true);
  });

  it("rejects an approval signed for a different plan version", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const plan = await proposeAndRead(app, pairingId, a);
    const wrongHash = planSubjectHash({ pairingId, goal: "something else", items: plan.items, version: plan.version });
    const path = `/pairings/${pairingId}/plan/approve`;
    const body = { planVersion: plan.version, signature: signConsent(a.holder, pairingId, plan.version, wrongHash) };
    const res = await request(app).post(path).set(authFor(a, "POST", path, body)).send(body).expect(400);
    expect(res.body.error.message).toMatch(/signature does not verify/i);
  });

  it("lets either side withdraw unilaterally", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const plan = await proposeAndRead(app, pairingId, a);
    const hash = planSubjectHash({ pairingId, goal: plan.goal, items: plan.items, version: plan.version });
    const approve = `/pairings/${pairingId}/plan/approve`;

    for (const side of [a, b]) {
      const body = { planVersion: plan.version, signature: signConsent(side.holder, pairingId, plan.version, hash) };
      await request(app).post(approve).set(authFor(side, "POST", approve, body)).send(body).expect(200);
    }

    const withdraw = `/pairings/${pairingId}/consent/withdraw`;
    const res = await request(app).post(withdraw).set(authFor(b, "POST", withdraw)).send().expect(200);
    expect(res.body.consent.satisfied).toBe(false);
    expect(res.body.consent.approvals.map((entry: { principal: string }) => entry.principal)).toEqual([a.principalId]);
  });

  it("destroys consent when the plan is re-proposed", async () => {
    const { app } = setup();
    const { pairingId, a } = await pairV3(app);
    const plan = await proposeAndRead(app, pairingId, a);
    const hash = planSubjectHash({ pairingId, goal: plan.goal, items: plan.items, version: plan.version });
    const approve = `/pairings/${pairingId}/plan/approve`;
    const body = { planVersion: plan.version, signature: signConsent(a.holder, pairingId, plan.version, hash) };
    await request(app).post(approve).set(authFor(a, "POST", approve, body)).send(body).expect(200);

    // Re-propose with changed text — the realistic case, and the one whose
    // whole point is that A's approval of v1 must not carry over.
    await proposeAndRead(app, pairingId, a, "Ship something else entirely");
    const get = `/pairings/${pairingId}/consent`;
    const after = (await request(app).get(get).set(authFor(a, "GET", get)).expect(200)).body;
    expect(after.consent.approvals).toEqual([]);
    expect(after.consent.satisfied).toBe(false);
    expect(after.consent.subject.version).toBe(2);
  });

  it("bars a v2 bearer credential from giving consent", async () => {
    const { app, store } = setup();
    const creator = (await request(app).post("/pairings").send({})).body; // no cnf → bearer
    const joiner = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;
    await request(app)
      .post(`/pairings/${joiner.pairingId}/plan`)
      .set({ Authorization: `Bearer ${creator.agentToken}` })
      .send({ goal: "g", items: [{ owner: creator.agentId, task: "t" }] })
      .expect(201);

    // A bearer caller cannot produce a signature, so no consent is recorded and
    // the record stays absent rather than being asserted by the relay.
    await request(app)
      .post(`/pairings/${joiner.pairingId}/plan/approve`)
      .set({ Authorization: `Bearer ${creator.agentToken}` })
      .send({ planVersion: 1 })
      .expect(200);
    expect(store.credentials.getConsent(joiner.pairingId)).toBeNull();
  });

  it("lets a third party verify a record without trusting the relay", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const plan = await proposeAndRead(app, pairingId, a);
    const hash = planSubjectHash({ pairingId, goal: plan.goal, items: plan.items, version: plan.version });
    const approve = `/pairings/${pairingId}/plan/approve`;
    for (const side of [a, b]) {
      const body = { planVersion: plan.version, signature: signConsent(side.holder, pairingId, plan.version, hash) };
      await request(app).post(approve).set(authFor(side, "POST", approve, body)).send(body).expect(200);
    }
    const record = (
      await request(app).get(`/pairings/${pairingId}/consent`).set(authFor(a, "GET", `/pairings/${pairingId}/consent`))
    ).body.consent;

    // Unauthenticated — the whole point.
    const ok = await request(app).post("/consent/verify").send({ consent: record }).expect(200);
    expect(ok.body).toMatchObject({ valid: true, satisfied: true });

    // A relay claiming a consent it does not have is caught by the same route.
    const forged = { ...record, approvals: [record.approvals[0], { ...record.approvals[1], signature: record.approvals[0].signature }] };
    const bad = await request(app).post("/consent/verify").send({ consent: forged }).expect(200);
    expect(bad.body.satisfied).toBe(false);
  });
});

describe("v3 audit (§7)", () => {
  it("exports a verifiable chain covering the whole flow", async () => {
    const { app } = setup();
    const { pairingId, a, b } = await pairV3(app);
    const body = { goal: "Ship", items: [{ owner: a.agentId, task: "t" }] };
    const propose = `/pairings/${pairingId}/plan`;
    const plan = (await request(app).post(propose).set(authFor(a, "POST", propose, body)).send(body)).body.plan;
    const hash = planSubjectHash({ pairingId, goal: plan.goal, items: plan.items, version: plan.version });
    const approve = `/pairings/${pairingId}/plan/approve`;
    for (const side of [a, b]) {
      const payload = { planVersion: plan.version, signature: signConsent(side.holder, pairingId, plan.version, hash) };
      await request(app).post(approve).set(authFor(side, "POST", approve, payload)).send(payload).expect(200);
    }

    const audit = `/pairings/${pairingId}/audit`;
    const res = await request(app).get(audit).set(authFor(a, "GET", audit)).expect(200);
    expect(res.body.chainValid).toBe(true);

    const actions = res.body.records.map((record: { action: string }) => record.action);
    expect(actions).toEqual(
      expect.arrayContaining(["pairing.created", "pairing.joined", "plan.proposed", "consent.approved", "consent.satisfied"]),
    );
    // Every record carries the subject hash the humans actually signed, which is
    // what lets two organizations' independent logs be reconciled (§7.4).
    const approved = res.body.records.find((record: { action: string }) => record.action === "consent.approved");
    expect(approved.detail.subjectHash).toBe(hash);
    expect(approved.assurance).toBe("pop");
  });

  it("reports a broken chain rather than hiding it", async () => {
    const { store, app } = setup();
    const { pairingId, a } = await pairV3(app);
    // Reach past the API and tamper the way a hostile operator would.
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare(`UPDATE audit_records SET detail = ? WHERE pairing_id = ? AND seq = 1`)
      .run(JSON.stringify({ code: "forged" }), pairingId);

    const audit = `/pairings/${pairingId}/audit`;
    const res = await request(app).get(audit).set(authFor(a, "GET", audit)).expect(200);
    expect(res.body.chainValid).toBe(false);
    expect(res.body.brokenAt).toBe(1);
  });
});
