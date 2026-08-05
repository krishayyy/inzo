/**
 * The client half has to agree with the relay byte for byte, so these tests
 * pin the exact serializations rather than just round-tripping. A drift here
 * would surface as "the signature mysteriously does not verify", which is a
 * miserable thing to debug in production.
 */

import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyHashOf,
  buildAuthHeaders,
  canonicalize,
  consentStatement,
  decodePayload,
  generateHolderKeyPair,
  isExpiring,
  planSubjectHash,
  publicJwkFromPem,
  signConsent,
} from "../src/index.js";

function fakeCredential(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(payload)}.sig`;
}

const PLAN = {
  pairingId: "pairing_1",
  goal: "Ship a scoped coordination loop",
  items: [{ owner: "agent_a", task: "relay" }],
  version: 3,
};

describe("canonicalization parity", () => {
  it("sorts keys at every level", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("treats an empty body as no body, matching the relay", () => {
    expect(bodyHashOf({})).toBe("");
    expect(bodyHashOf(undefined)).toBe("");
    expect(bodyHashOf(null)).toBe("");
  });

  it("drops undefined values rather than emitting them", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("holder keys", () => {
  it("derives the same public JWK from the private key", () => {
    const pair = generateHolderKeyPair();
    expect(publicJwkFromPem(pair.privateKeyPem)).toEqual(pair.publicJwk);
  });

  it("never puts the private key in the public half", () => {
    const pair = generateHolderKeyPair();
    expect(Object.keys(pair.publicJwk).sort()).toEqual(["crv", "kty", "x"]);
    expect(JSON.stringify(pair.publicJwk)).not.toContain("PRIVATE");
  });
});

describe("request proofs (§1.2)", () => {
  it("produces a signature the relay's rules will verify", () => {
    const pair = generateHolderKeyPair();
    const credential = fakeCredential({ jti: "cred_1", exp: 9_999_999_999 });
    const body = { body: "hello" };
    const headers = buildAuthHeaders({
      credential,
      privateKeyPem: pair.privateKeyPem,
      method: "post",
      path: "/pairings/p1/messages",
      body,
      nonce: "fixed-nonce",
      now: 1_700_000_000_000,
    });

    expect(headers.Authorization).toBe(`Inzo ${credential}`);
    expect(headers["Inzo-Proof-At"]).toBe("1700000000");
    expect(headers["Inzo-Proof-Nonce"]).toBe("fixed-nonce");

    const expected = ["POST", "/pairings/p1/messages", "cred_1", "1700000000", bodyHashOf(body), "fixed-nonce"].join("\n");
    const ok = cryptoVerify(
      null,
      Buffer.from(expected),
      createPublicKey({ key: pair.publicJwk as unknown as Record<string, unknown>, format: "jwk" }),
      Buffer.from(headers["Inzo-Proof"], "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("uppercases the method so casing cannot break verification", () => {
    const pair = generateHolderKeyPair();
    const credential = fakeCredential({ jti: "cred_1", exp: 9_999_999_999 });
    const base = { credential, privateKeyPem: pair.privateKeyPem, path: "/x", nonce: "n", now: 1000 };
    const lower = buildAuthHeaders({ ...base, method: "get" });
    const upper = buildAuthHeaders({ ...base, method: "GET" });
    expect(lower["Inzo-Proof"]).toBe(upper["Inzo-Proof"]);
  });

  it("produces a fresh nonce per call, so identical requests differ", () => {
    const pair = generateHolderKeyPair();
    const credential = fakeCredential({ jti: "cred_1", exp: 9_999_999_999 });
    const args = { credential, privateKeyPem: pair.privateKeyPem, method: "GET", path: "/x", now: 1000 };
    expect(buildAuthHeaders(args)["Inzo-Proof"]).not.toBe(buildAuthHeaders(args)["Inzo-Proof"]);
  });

  it("produces a different proof for a different body", () => {
    const pair = generateHolderKeyPair();
    const credential = fakeCredential({ jti: "cred_1", exp: 9_999_999_999 });
    const base = { credential, privateKeyPem: pair.privateKeyPem, method: "POST", path: "/x", nonce: "n", now: 1000 };
    expect(buildAuthHeaders({ ...base, body: { a: 1 } })["Inzo-Proof"]).not.toBe(
      buildAuthHeaders({ ...base, body: { a: 2 } })["Inzo-Proof"],
    );
  });
});

describe("credential inspection", () => {
  it("reads the payload without verifying", () => {
    const credential = fakeCredential({ jti: "cred_9", cap: ["messages:read"], exp: 42 });
    expect(decodePayload(credential)).toMatchObject({ jti: "cred_9", cap: ["messages:read"] });
  });

  it("flags a credential that is close to expiring", () => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    const later = Math.floor(Date.now() / 1000) + 900;
    expect(isExpiring(fakeCredential({ jti: "c", exp: soon }))).toBe(true);
    expect(isExpiring(fakeCredential({ jti: "c", exp: later }))).toBe(false);
  });

  it("treats an unreadable credential as expiring rather than usable", () => {
    expect(isExpiring("garbage")).toBe(true);
  });
});

describe("consent signatures (§6.2)", () => {
  it("signs the statement the relay will reconstruct", () => {
    const pair = generateHolderKeyPair();
    const { signature, subjectHash } = signConsent(pair.privateKeyPem, PLAN);
    expect(subjectHash).toBe(planSubjectHash(PLAN));

    const ok = cryptoVerify(
      null,
      Buffer.from(consentStatement(PLAN.pairingId, PLAN.version, subjectHash)),
      createPublicKey({ key: pair.publicJwk as unknown as Record<string, unknown>, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("is domain separated, so a proof can never be replayed as consent", () => {
    expect(consentStatement("p", 1, "sha256:x")).toMatch(/^inzo-consent-v3\n/);
  });

  it("changes the signature when any signed field changes", () => {
    const pair = generateHolderKeyPair();
    const base = signConsent(pair.privateKeyPem, PLAN).signature;
    expect(signConsent(pair.privateKeyPem, { ...PLAN, version: 4 }).signature).not.toBe(base);
    expect(signConsent(pair.privateKeyPem, { ...PLAN, goal: "other" }).signature).not.toBe(base);
    expect(
      signConsent(pair.privateKeyPem, { ...PLAN, items: [{ owner: "agent_b", task: "relay" }] }).signature,
    ).not.toBe(base);
  });

  it("ignores fields the human does not read", () => {
    const pair = generateHolderKeyPair();
    const withExtra = { ...PLAN, updatedAt: "2026-01-01" } as unknown as typeof PLAN;
    expect(signConsent(pair.privateKeyPem, withExtra).signature).toBe(signConsent(pair.privateKeyPem, PLAN).signature);
  });
});
