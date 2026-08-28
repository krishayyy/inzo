import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionFile,
  requirePairingId,
  requireToken,
  sessionFilePath,
  sessionState,
  setIdentity,
  setPairingId,
} from "../src/sessionState.js";

const originalHome = process.env.INZO_HOME;

beforeEach(() => {
  process.env.INZO_HOME = mkdtempSync(join(tmpdir(), "inzo-home-"));
  sessionState.pairingId = null;
  sessionState.agentToken = null;
  sessionState.scope = [];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.INZO_HOME;
  else process.env.INZO_HOME = originalHome;
});

describe("sessionState", () => {
  it("throws a clear error when no pairing is active", () => {
    expect(() => requirePairingId()).toThrow(/No active pairing/);
  });

  it("throws a clear error when there is no credential", () => {
    expect(() => requireToken()).toThrow(/Pair this agent first/);
  });

  it("returns the pairingId once set", () => {
    setPairingId("pairing_123");
    expect(requirePairingId()).toBe("pairing_123");
  });

  it("has a stable agentId for the process lifetime", () => {
    expect(sessionState.agentId).toMatch(/^agent_/);
  });
});

describe("session file", () => {
  it("writes the credential owner-only, so other users on the box cannot read it", () => {
    setIdentity("agent_1", "secret-token", "pairing_1", ["messages:read"]);
    const mode = statSync(sessionFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips what the CLI needs to attach without re-pairing", () => {
    setIdentity("agent_1", "secret-token", "pairing_1", ["messages:read", "messages:send"]);
    const file = readSessionFile();
    expect(file).toMatchObject({
      agentId: "agent_1",
      agentToken: "secret-token",
      pairingId: "pairing_1",
      scope: ["messages:read", "messages:send"],
    });
    expect(file?.relayUrl).toBeTruthy();
  });

  it("stays 0600 when an existing file is rewritten", () => {
    setIdentity("agent_1", "secret-token", null);
    setPairingId("pairing_2");
    expect(statSync(sessionFilePath()).mode & 0o777).toBe(0o600);
    expect(readSessionFile()?.pairingId).toBe("pairing_2");
  });

  it("does not write anything before there is a credential to store", () => {
    setPairingId("pairing_1");
    expect(readSessionFile()).toBeNull();
  });
});


describe("workspace-keyed sessions", () => {
  const originalWorkspace = process.env.INZO_WORKSPACE;

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.INZO_WORKSPACE;
    else process.env.INZO_WORKSPACE = originalWorkspace;
  });

  it("keys the session file by INZO_WORKSPACE", () => {
    const a = mkdtempSync(join(tmpdir(), "inzo-ws-a-"));
    const b = mkdtempSync(join(tmpdir(), "inzo-ws-b-"));

    process.env.INZO_WORKSPACE = a;
    const pathA = sessionFilePath();
    process.env.INZO_WORKSPACE = b;
    const pathB = sessionFilePath();

    expect(pathA).not.toBe(pathB);
  });

  it("does not let a second workspace clobber the first one's holder key", () => {
    // The confused-deputy half of the same bug: with one global file, this
    // server could hold pairing A's credential while pointed at project B.
    const a = mkdtempSync(join(tmpdir(), "inzo-ws-a-"));
    const b = mkdtempSync(join(tmpdir(), "inzo-ws-b-"));

    process.env.INZO_WORKSPACE = a;
    setIdentity("agent_a", "token_a", "pair_a", [], {
      credential: "cred_a",
      holderPrivateKey: "KEY_A",
      principalId: "principal_a",
    });

    process.env.INZO_WORKSPACE = b;
    setIdentity("agent_b", "token_b", "pair_b", [], {
      credential: "cred_b",
      holderPrivateKey: "KEY_B",
      principalId: "principal_b",
    });

    process.env.INZO_WORKSPACE = a;
    expect(readSessionFile()?.holderPrivateKey).toBe("KEY_A");
    process.env.INZO_WORKSPACE = b;
    expect(readSessionFile()?.holderPrivateKey).toBe("KEY_B");
  });

  it("records the workspace it was scoped to", () => {
    const dir = mkdtempSync(join(tmpdir(), "inzo-ws-"));
    process.env.INZO_WORKSPACE = dir;
    setIdentity("agent_x", "token_x", "pair_x", [], {
      credential: "cred_x",
      holderPrivateKey: "KEY_X",
      principalId: null,
    });
    expect(readSessionFile()?.workspace).toBe(dir);
  });

  it("falls back to the global path when no workspace is declared", () => {
    delete process.env.INZO_WORKSPACE;
    expect(sessionFilePath()).toMatch(/[.]inzo\/session[.]json$/);
  });
});
