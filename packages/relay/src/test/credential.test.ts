/**
 * Executable form of PROTOCOL.md §12 (conformance) — credentials, proof of
 * possession, consent, and audit.
 *
 * Each block names the rule it defends. A test that fails here means the
 * implementation disagrees with the spec, and per the repo's own convention
 * the implementation is the thing that is wrong.
 */

import Database from "better-sqlite3";
import { sign as cryptoSign, createPrivateKey } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditLog, AUDIT_SCHEMA, GENESIS_HASH, resolveRetentionDays } from "../lib/audit.js";
import {
  attenuate,
  bodyHashOf,
  canonicalize,
  generateHolderKeyPair,
  generateIssuerKey,
  issueCredential,
  MAX_DEPTH,
  MAX_TTL_SECONDS,
  ProofReplayGuard,
  proofInput,
  signProof,
  verifyCredential,
  verifyProof,
  type IssuerKey,
} from "../lib/credential.js";
import {
  consentStatement,
  isSatisfied,
  planSubjectHash,
  verifyApprovalSignature,
  verifyConsentRecord,
  type ConsentRecord,
} from "../lib/consent.js";
import { CredentialStore } from "../lib/credentialStore.js";

const ISSUER = "https://relay.test";
const ALL: Array<
  "messages:read" | "messages:send" | "plan:propose" | "plan:approve" | "usage:report" | "commands:run"
> = ["messages:read", "messages:send", "plan:propose", "plan:approve", "usage:report", "commands:run"];

function root(key: IssuerKey, cap = ALL, ttlSeconds = 900) {
  const holder = generateHolderKeyPair();
  const issued = issueCredential(key, {
    issuer: ISSUER,
    agentId: "agent_a",
    principalId: "prn_a",
    pairingId: "pairing_1",
    cap,
    cnf: { jwk: holder.publicJwk },
    ttlSeconds,
  });
  return { ...issued, holder };
}

describe("canonicalization", () => {
  it("orders keys deterministically at every level", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("produces identical output regardless of construction order", () => {
    const one: Record<string, unknown> = {};
    one.goal = "ship";
    one.version = 2;
    const two: Record<string, unknown> = {};
    two.version = 2;
    two.goal = "ship";
    // Cross-org consent verification depends on this: differing serialization
    // would yield differing hashes for identical content.
    expect(canonicalize(one)).toBe(canonicalize(two));
  });
});

describe("credential issue and verify (§2.1)", () => {
  let key: IssuerKey;
  let keys: Map<string, ReturnType<typeof generateIssuerKey>["publicKey"]>;

  beforeEach(() => {
    key = generateIssuerKey();
    keys = new Map([[key.kid, key.publicKey]]);
  });

  it("round-trips a freshly issued credential", () => {
    const { credential, payload } = root(key);
    const verified = verifyCredential(credential, keys, { expectedIssuer: ISSUER });
    expect(verified.jti).toBe(payload.jti);
    expect(verified.prn).toBe("prn_a");
    expect(verified.cap).toEqual(ALL);
    expect(verified.depth).toBe(0);
  });

  it("rejects a tampered payload", () => {
    const { credential } = root(key);
    const [header, , signature] = credential.split(".");
    const forged = Buffer.from(
      JSON.stringify({ iss: ISSUER, jti: "cred_x", sub: "agent_evil", prn: "prn_evil", cap: ALL }),
    ).toString("base64url");
    expect(() => verifyCredential(`${header}.${forged}.${signature}`, keys)).toThrow(/signature is invalid/i);
  });

  it("rejects an unknown issuer key", () => {
    const { credential } = root(key);
    expect(() => verifyCredential(credential, new Map())).toThrow(/unknown issuer key/i);
  });

  it("rejects a credential from a different relay", () => {
    const { credential } = root(key);
    expect(() => verifyCredential(credential, keys, { expectedIssuer: "https://elsewhere.test" })).toThrow(
      /different relay/i,
    );
  });

  it("rejects an expired credential with a distinguishable code", () => {
    const { credential } = root(key, ALL, 60);
    expect(() => verifyCredential(credential, keys, { now: Date.now() + 61_000 })).toThrow(/expired/i);
  });

  it("caps lifetime at MAX_TTL_SECONDS however long a caller asks for", () => {
    const { payload } = root(key, ALL, 999_999_999);
    expect(payload.exp - payload.iat).toBe(MAX_TTL_SECONDS);
  });
});

describe("attenuation (§2)", () => {
  let key: IssuerKey;
  let keys: Map<string, ReturnType<typeof generateIssuerKey>["publicKey"]>;

  beforeEach(() => {
    key = generateIssuerKey();
    keys = new Map([[key.kid, key.publicKey]]);
  });

  it("narrows capabilities and extends the chain", () => {
    const parent = root(key);
    const holder = generateHolderKeyPair();
    const child = attenuate(key, parent.payload, {
      cap: ["messages:read"],
      cnf: { jwk: holder.publicJwk },
    });
    expect(child.payload.cap).toEqual(["messages:read"]);
    expect(child.payload.depth).toBe(1);
    expect(child.payload.chain).toEqual([parent.payload.jti]);
    expect(verifyCredential(child.credential, keys).cap).toEqual(["messages:read"]);
  });

  it("refuses to widen — the whole point of the capability system", () => {
    const parent = root(key, ["messages:read"]);
    const holder = generateHolderKeyPair();
    expect(() =>
      attenuate(key, parent.payload, { cap: ["messages:read", "commands:run"], cnf: { jwk: holder.publicJwk } }),
    ).toThrow(/cannot widen/i);
  });

  it("keeps the principal invariant across every hop", () => {
    const parent = root(key);
    const holder = generateHolderKeyPair();
    const child = attenuate(key, parent.payload, { cap: ["messages:read"], cnf: { jwk: holder.publicJwk } });
    expect(child.payload.prn).toBe(parent.payload.prn);
  });

  it("never lets a child outlive its parent", () => {
    const parent = root(key, ALL, 120);
    const holder = generateHolderKeyPair();
    const child = attenuate(key, parent.payload, {
      cap: ["messages:read"],
      cnf: { jwk: holder.publicJwk },
      ttlSeconds: 3600,
    });
    expect(child.payload.exp).toBeLessThanOrEqual(parent.payload.exp);
  });

  it("enforces the depth limit", () => {
    let current = root(key).payload;
    for (let i = 0; i < MAX_DEPTH; i++) {
      const holder = generateHolderKeyPair();
      current = attenuate(key, current, { cap: ["messages:read"], cnf: { jwk: holder.publicJwk } }).payload;
    }
    const holder = generateHolderKeyPair();
    expect(() => attenuate(key, current, { cap: ["messages:read"], cnf: { jwk: holder.publicJwk } })).toThrow(
      /depth/i,
    );
  });

  it("rejects unknown capabilities", () => {
    const parent = root(key);
    const holder = generateHolderKeyPair();
    expect(() => attenuate(key, parent.payload, { cap: ["root:everything"], cnf: { jwk: holder.publicJwk } })).toThrow(
      /unknown capabilities/i,
    );
  });
});

describe("revocation reaches descendants (§4)", () => {
  it("rejects a child whose ancestor was revoked, knowing only the ancestor", () => {
    const key = generateIssuerKey();
    const keys = new Map([[key.kid, key.publicKey]]);
    const parent = root(key);
    const holder = generateHolderKeyPair();
    const child = attenuate(key, parent.payload, { cap: ["messages:read"], cnf: { jwk: holder.publicJwk } });

    // The verifier knows nothing about the child — only that the root died.
    const revoked = new Set([parent.payload.jti]);
    expect(() => verifyCredential(child.credential, keys, { revoked })).toThrow(/ancestor/i);
  });
});

describe("proof of possession (§1.2)", () => {
  let key: IssuerKey;

  beforeEach(() => {
    key = generateIssuerKey();
  });

  it("accepts a proof signed by the bound holder key", () => {
    const { payload, holder } = root(key);
    const ts = Math.floor(Date.now() / 1000);
    const bodyHash = bodyHashOf({ body: "hello" });
    const proof = signProof(holder.privateKeyPem, "POST", "/pairings/p/messages", payload.jti, ts, bodyHash);
    expect(
      verifyProof({
        payload,
        proof,
        timestamp: String(ts),
        method: "POST",
        path: "/pairings/p/messages",
        bodyHash,
      }),
    ).toBe(ts);
  });

  it("rejects a proof signed by a different key — a stolen credential is inert", () => {
    const { payload } = root(key);
    const thief = generateHolderKeyPair();
    const ts = Math.floor(Date.now() / 1000);
    const proof = signProof(thief.privateKeyPem, "POST", "/x", payload.jti, ts, "");
    expect(() =>
      verifyProof({ payload, proof, timestamp: String(ts), method: "POST", path: "/x", bodyHash: "" }),
    ).toThrow(/does not verify/i);
  });

  it("rejects a proof whose body changed in flight", () => {
    const { payload, holder } = root(key);
    const ts = Math.floor(Date.now() / 1000);
    const proof = signProof(holder.privateKeyPem, "POST", "/x", payload.jti, ts, bodyHashOf({ goal: "safe" }));
    expect(() =>
      verifyProof({
        payload,
        proof,
        timestamp: String(ts),
        method: "POST",
        path: "/x",
        bodyHash: bodyHashOf({ goal: "hostile" }),
      }),
    ).toThrow(/does not verify/i);
  });

  it("rejects a proof outside the time window", () => {
    const { payload, holder } = root(key);
    const ts = Math.floor(Date.now() / 1000) - 600;
    const proof = signProof(holder.privateKeyPem, "POST", "/x", payload.jti, ts, "");
    expect(() =>
      verifyProof({ payload, proof, timestamp: String(ts), method: "POST", path: "/x", bodyHash: "" }),
    ).toThrow(/window/i);
  });

  it("admits a proof once and refuses the replay", () => {
    const guard = new ProofReplayGuard();
    expect(guard.admit("sig-a", 1000)).toBe(true);
    expect(guard.admit("sig-a", 1000)).toBe(false);
    // A different request in the same second is not a replay.
    expect(guard.admit("sig-b", 1000)).toBe(true);
  });

  it("binds the proof to method, path, body and nonce", () => {
    expect(proofInput("post", "/a", "cred_1", 5, "h", "n")).toBe("POST\n/a\ncred_1\n5\nh\nn");
  });

  it("distinguishes two identical reads in the same second by nonce", () => {
    const { payload, holder } = root(key);
    const ts = Math.floor(Date.now() / 1000);
    const one = signProof(holder.privateKeyPem, "GET", "/x", payload.jti, ts, "", "nonce-1");
    const two = signProof(holder.privateKeyPem, "GET", "/x", payload.jti, ts, "", "nonce-2");
    expect(one).not.toBe(two);

    const guard = new ProofReplayGuard();
    expect(guard.admit(one, ts)).toBe(true);
    expect(guard.admit(two, ts)).toBe(true);
    expect(guard.admit(one, ts)).toBe(false);
  });
});

describe("consent (§6)", () => {
  const plan = {
    pairingId: "pairing_1",
    goal: "Ship a scoped coordination loop",
    items: [{ owner: "agent_a", task: "relay" }],
    version: 3,
  };

  it("hashes only the fields a human reads", () => {
    const a = planSubjectHash(plan);
    const b = planSubjectHash({ ...plan, items: [{ owner: "agent_a", task: "relay" }] });
    expect(a).toBe(b);
    expect(planSubjectHash({ ...plan, goal: "Something else" })).not.toBe(a);
    expect(planSubjectHash({ ...plan, version: 4 })).not.toBe(a);
  });

  it("verifies an approval signed by the holder key", () => {
    const holder = generateHolderKeyPair();
    const subject = { kind: "plan" as const, version: 3, hash: planSubjectHash(plan) };
    const signature = cryptoSign(
      null,
      Buffer.from(consentStatement(plan.pairingId, subject)),
      createPrivateKey(holder.privateKeyPem),
    ).toString("base64url");
    expect(verifyApprovalSignature(plan.pairingId, subject, signature, holder.publicJwk)).toBe(true);
  });

  it("rejects an approval replayed onto a different plan version", () => {
    const holder = generateHolderKeyPair();
    const subject = { kind: "plan" as const, version: 3, hash: planSubjectHash(plan) };
    const signature = cryptoSign(
      null,
      Buffer.from(consentStatement(plan.pairingId, subject)),
      createPrivateKey(holder.privateKeyPem),
    ).toString("base64url");
    const swapped = { kind: "plan" as const, version: 4, hash: planSubjectHash({ ...plan, version: 4 }) };
    expect(verifyApprovalSignature(plan.pairingId, swapped, signature, holder.publicJwk)).toBe(false);
  });

  it("is satisfied only on unanimity over the required set", () => {
    const required = ["prn_a", "prn_b"];
    const one = [{ principal: "prn_a", credential: "c", at: "t", signature: "s" }];
    expect(isSatisfied({ required, approvals: one })).toBe(false);
    expect(
      isSatisfied({ required, approvals: [...one, { principal: "prn_b", credential: "c2", at: "t", signature: "s" }] }),
    ).toBe(true);
  });

  it("lets a third party verify a record without trusting the relay's flag", () => {
    const a = generateHolderKeyPair();
    const b = generateHolderKeyPair();
    const subject = { kind: "plan" as const, version: 3, hash: planSubjectHash(plan) };
    const sign = (h: typeof a) =>
      cryptoSign(
        null,
        Buffer.from(consentStatement(plan.pairingId, subject)),
        createPrivateKey(h.privateKeyPem),
      ).toString("base64url");

    const record: ConsentRecord = {
      pairingId: plan.pairingId,
      subject,
      required: ["prn_a", "prn_b"],
      approvals: [
        { principal: "prn_a", credential: "cred_a", at: "t", signature: sign(a) },
        { principal: "prn_b", credential: "cred_b", at: "t", signature: sign(b) },
      ],
      satisfied: true,
      createdAt: "t",
      updatedAt: "t",
    };
    const keys = new Map([
      ["cred_a", a.publicJwk],
      ["cred_b", b.publicJwk],
    ]);
    expect(verifyConsentRecord(record, keys)).toMatchObject({ valid: true, satisfied: true });

    // A relay claiming consent it does not have is caught by the same check.
    const forged: ConsentRecord = {
      ...record,
      approvals: [record.approvals[0], { ...record.approvals[1], signature: record.approvals[0].signature }],
    };
    expect(verifyConsentRecord(forged, keys).satisfied).toBe(false);
  });
});

describe("consent store (§6.3)", () => {
  let store: CredentialStore;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CredentialStore(db, ISSUER);
  });

  function issueFor(principalId: string, agentId: string) {
    const holder = generateHolderKeyPair();
    const issued = store.issueRoot({
      agentId,
      principalId,
      pairingId: "pairing_1",
      cap: ALL,
      cnf: { jwk: holder.publicJwk },
    });
    return { ...issued, holder };
  }

  function approvalFor(holderPem: string, subject: { kind: "plan"; version: number; hash: string }) {
    return cryptoSign(
      null,
      Buffer.from(consentStatement("pairing_1", subject)),
      createPrivateKey(holderPem),
    ).toString("base64url");
  }

  it("requires both principals, then satisfies", () => {
    const a = issueFor("prn_a", "agent_a");
    const b = issueFor("prn_b", "agent_b");
    const subject = { kind: "plan" as const, version: 1, hash: planSubjectHash({ ...{ pairingId: "pairing_1", goal: "g", items: [{ owner: "agent_a", task: "t" }] }, version: 1 }) };
    store.openConsent("pairing_1", subject, ["prn_a", "prn_b"]);

    let record = store.approve({
      pairingId: "pairing_1",
      payload: a.payload,
      assurance: "pop",
      signature: approvalFor(a.holder.privateKeyPem, subject),
    });
    expect(record.satisfied).toBe(false);

    record = store.approve({
      pairingId: "pairing_1",
      payload: b.payload,
      assurance: "pop",
      signature: approvalFor(b.holder.privateKeyPem, subject),
    });
    expect(record.satisfied).toBe(true);
  });

  it("refuses consent from a bearer credential", () => {
    const a = issueFor("prn_a", "agent_a");
    const subject = { kind: "plan" as const, version: 1, hash: "sha256:abc" };
    store.openConsent("pairing_1", subject, ["prn_a", "prn_b"]);
    expect(() =>
      store.approve({
        pairingId: "pairing_1",
        payload: a.payload,
        assurance: "bearer",
        signature: approvalFor(a.holder.privateKeyPem, subject),
      }),
    ).toThrow(/non-repudiable/i);
  });

  it("refuses an approval from a principal outside the required set", () => {
    const c = issueFor("prn_c", "agent_c");
    const subject = { kind: "plan" as const, version: 1, hash: "sha256:abc" };
    store.openConsent("pairing_1", subject, ["prn_a", "prn_b"]);
    expect(() =>
      store.approve({
        pairingId: "pairing_1",
        payload: c.payload,
        assurance: "pop",
        signature: approvalFor(c.holder.privateKeyPem, subject),
      }),
    ).toThrow(/not one of the parties/i);
  });

  it("withdraws unilaterally, without the peer's cooperation", () => {
    const a = issueFor("prn_a", "agent_a");
    const b = issueFor("prn_b", "agent_b");
    const subject = { kind: "plan" as const, version: 1, hash: "sha256:abc" };
    store.openConsent("pairing_1", subject, ["prn_a", "prn_b"]);
    store.approve({ pairingId: "pairing_1", payload: a.payload, assurance: "pop", signature: approvalFor(a.holder.privateKeyPem, subject) });
    store.approve({ pairingId: "pairing_1", payload: b.payload, assurance: "pop", signature: approvalFor(b.holder.privateKeyPem, subject) });

    const after = store.withdraw("pairing_1", "prn_b");
    expect(after.satisfied).toBe(false);
    expect(after.approvals.map((entry) => entry.principal)).toEqual(["prn_a"]);
  });

  it("withdraws consent made with a credential that is later revoked", () => {
    const a = issueFor("prn_a", "agent_a");
    const subject = { kind: "plan" as const, version: 1, hash: "sha256:abc" };
    store.openConsent("pairing_1", subject, ["prn_a", "prn_b"]);
    store.approve({ pairingId: "pairing_1", payload: a.payload, assurance: "pop", signature: approvalFor(a.holder.privateKeyPem, subject) });

    const killed = store.revokeAgentCredentials("agent_a", new Date().toISOString());
    const after = store.withdrawByCredentials("pairing_1", killed);
    expect(after?.approvals).toEqual([]);
    expect(store.isRevoked(a.payload.jti)).toBe(true);
  });

  it("re-opening consent for a new proposal destroys prior approvals", () => {
    const a = issueFor("prn_a", "agent_a");
    const first = { kind: "plan" as const, version: 1, hash: "sha256:aaa" };
    store.openConsent("pairing_1", first, ["prn_a", "prn_b"]);
    store.approve({ pairingId: "pairing_1", payload: a.payload, assurance: "pop", signature: approvalFor(a.holder.privateKeyPem, first) });

    const second = store.openConsent("pairing_1", { kind: "plan", version: 2, hash: "sha256:bbb" }, ["prn_a", "prn_b"]);
    expect(second.approvals).toEqual([]);
    expect(second.satisfied).toBe(false);
  });

  it("publishes jwks and a revocation list", () => {
    const a = issueFor("prn_a", "agent_a");
    expect(store.jwks().keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    store.revokeAgentCredentials("agent_a", new Date().toISOString());
    expect(store.revocationList().revoked.map((entry) => entry.jti)).toContain(a.payload.jti);
  });

  it("keeps the signing key across restarts so old signatures stay verifiable", () => {
    const first = store.jwks().keys[0].kid;
    const reopened = new CredentialStore(db, ISSUER);
    expect(reopened.jwks().keys[0].kid).toBe(first);
  });
});

describe("issuer key rotation (§4.1)", () => {
  let store: CredentialStore;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CredentialStore(db, ISSUER);
  });

  function issueFor(agentId: string) {
    const holder = generateHolderKeyPair();
    return store.issueRoot({
      agentId,
      principalId: "prn_a",
      pairingId: "pairing_1",
      cap: ALL,
      cnf: { jwk: holder.publicJwk },
    });
  }

  it("signs new credentials with the new key", () => {
    const before = store.activeKid();
    const after = store.rotateIssuerKey();
    expect(after).not.toBe(before);
    expect(store.activeKid()).toBe(after);

    const issued = issueFor("agent_new");
    const header = JSON.parse(Buffer.from(issued.credential.split(".")[0], "base64url").toString());
    expect(header.kid).toBe(after);
  });

  it("keeps credentials signed by the retired key verifiable until they expire", () => {
    const issued = issueFor("agent_old");
    store.rotateIssuerKey();
    // This is the whole point: rotation must not be a mass invalidation event.
    expect(store.verify(issued.credential).jti).toBe(issued.payload.jti);
  });

  it("publishes both keys in the JWKS so external verifiers can catch up", () => {
    const before = store.activeKid();
    const after = store.rotateIssuerKey();
    const kids = store.jwks().keys.map((key) => key.kid);
    expect(kids).toContain(before);
    expect(kids).toContain(after);
  });

  it("survives a restart with the newest key active and the old one still trusted", () => {
    const issued = issueFor("agent_old");
    const rotated = store.rotateIssuerKey();

    const reopened = new CredentialStore(db, ISSUER);
    expect(reopened.activeKid()).toBe(rotated);
    expect(reopened.verify(issued.credential).jti).toBe(issued.payload.jti);
  });

  it("still rejects a credential signed by a key this issuer never had", () => {
    const foreign = generateIssuerKey();
    const holder = generateHolderKeyPair();
    const forged = issueCredential(foreign, {
      issuer: ISSUER,
      agentId: "agent_a",
      principalId: "prn_a",
      pairingId: "pairing_1",
      cap: ALL,
      cnf: { jwk: holder.publicJwk },
    });
    store.rotateIssuerKey();
    expect(() => store.verify(forged.credential)).toThrow(/Unknown issuer key/);
  });

  it("prunes retired keys only once nothing they signed can still be alive", () => {
    const retiredKid = store.activeKid();
    store.rotateIssuerKey();

    // A moment after retirement, credentials signed by it may still be valid.
    expect(store.pruneRetiredKeys(Date.now())).toBe(0);
    expect(store.jwks().keys.map((key) => key.kid)).toContain(retiredKid);

    // Past the hard TTL ceiling, nothing can reference it any more.
    const wellPastTtl = Date.now() + (MAX_TTL_SECONDS + 60) * 1000;
    expect(store.pruneRetiredKeys(wellPastTtl)).toBe(1);
    expect(store.jwks().keys.map((key) => key.kid)).not.toContain(retiredKid);
  });

  it("never prunes the active key", () => {
    const active = store.activeKid();
    store.pruneRetiredKeys(Date.now() + MAX_TTL_SECONDS * 10 * 1000);
    expect(store.jwks().keys.map((key) => key.kid)).toContain(active);
  });
});

describe("audit chain (§7)", () => {
  let db: Database.Database;
  let log: AuditLog;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(AUDIT_SCHEMA);
    log = new AuditLog(db);
  });

  const actor = { principal: "prn_a", agent: "agent_a", credential: "cred_a" };

  it("anchors the first record to genesis and links the rest", () => {
    const one = log.append({ pairingId: "p1", action: "pairing.created", actor, assurance: "pop" });
    const two = log.append({ pairingId: "p1", action: "plan.proposed", actor, assurance: "pop" });
    expect(one.prevHash).toBe(GENESIS_HASH);
    expect(one.seq).toBe(1);
    expect(two.prevHash).toBe(one.hash);
    expect(log.verify("p1")).toMatchObject({ valid: true, brokenAt: null });
  });

  it("detects an edited record", () => {
    log.append({ pairingId: "p1", action: "pairing.created", actor, assurance: "pop" });
    log.append({ pairingId: "p1", action: "consent.approved", actor, assurance: "pop", detail: { version: 1 } });
    log.append({ pairingId: "p1", action: "consent.satisfied", actor, assurance: "pop" });

    db.prepare(`UPDATE audit_records SET detail = ? WHERE pairing_id = 'p1' AND seq = 2`).run(
      JSON.stringify({ version: 99 }),
    );
    expect(log.verify("p1")).toMatchObject({ valid: false, brokenAt: 2 });
  });

  it("detects a deleted record", () => {
    for (const action of ["pairing.created", "plan.proposed", "consent.approved"] as const) {
      log.append({ pairingId: "p1", action, actor, assurance: "pop" });
    }
    db.prepare(`DELETE FROM audit_records WHERE pairing_id = 'p1' AND seq = 2`).run();
    expect(log.verify("p1").valid).toBe(false);
  });

  it("keeps chains per pairing independent", () => {
    log.append({ pairingId: "p1", action: "pairing.created", actor, assurance: "pop" });
    const other = log.append({ pairingId: "p2", action: "pairing.created", actor, assurance: "pop" });
    expect(other.seq).toBe(1);
    expect(other.prevHash).toBe(GENESIS_HASH);
  });

  it("records the assurance level, so bearer-authenticated actions are distinguishable", () => {
    const record = log.append({ pairingId: "p1", action: "plan.proposed", actor, assurance: "bearer" });
    expect(record.assurance).toBe("bearer");
  });

  it("prunes only pairings entirely outside the retention window", () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    log.append({ pairingId: "old", action: "pairing.created", actor, assurance: "pop", at: old });
    log.append({ pairingId: "live", action: "pairing.created", actor, assurance: "pop" });
    expect(log.prune(180)).toBe(1);
    expect(log.list("live").length).toBe(1);
    expect(log.list("old").length).toBe(0);
  });

  it("refuses a retention floor below Article 12 in compliance mode", () => {
    expect(() => resolveRetentionDays({ INZO_COMPLIANCE_MODE: "eu-ai-act", INZO_AUDIT_RETENTION_DAYS: "30" })).toThrow(
      /180/,
    );
    expect(resolveRetentionDays({ INZO_AUDIT_RETENTION_DAYS: "30" })).toBe(30);
    expect(resolveRetentionDays({})).toBe(180);
  });
});
