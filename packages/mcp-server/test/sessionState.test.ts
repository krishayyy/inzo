import { describe, it, expect, beforeEach } from "vitest";
import { sessionState, requirePairingId, setPairingId } from "../src/sessionState.js";

describe("sessionState", () => {
  beforeEach(() => {
    sessionState.pairingId = null;
  });

  it("throws a clear error when no pairing is active", () => {
    expect(() => requirePairingId()).toThrow(/No active pairing/);
  });

  it("returns the pairingId once set", () => {
    setPairingId("pairing_123");
    expect(requirePairingId()).toBe("pairing_123");
  });

  it("has a stable agentId for the process lifetime", () => {
    expect(sessionState.agentId).toMatch(/^agent_/);
  });
});
