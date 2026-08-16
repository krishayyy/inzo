import { describe, expect, it } from "vitest";
import { encode, foldPresence, parse, type Envelope } from "../envelope.js";

const ALL: Envelope[] = [
  { kind: "inzo.claim", globs: ["src/**"], note: "refactor" },
  { kind: "inzo.claim", globs: ["a.ts", "b.ts"] },
  { kind: "inzo.release", globs: ["src/**"] },
  { kind: "inzo.head", branch: "inzo/kri", sha: "abc123", files: ["src/a.ts"] },
  { kind: "inzo.status", text: "reading the relay store" },
  { kind: "inzo.share", label: "bench", value: "42ms p95" },
  { kind: "inzo.ask", question: "does your side hash the plan locally?" },
];

describe("envelope", () => {
  it("round-trips every kind", () => {
    for (const envelope of ALL) {
      expect(parse(encode(envelope))).toEqual(envelope);
    }
  });

  it("treats plain text and malformed JSON as chat", () => {
    for (const body of ["hello", "", "{not json", "{}", '{"kind":"other.claim"}', "[1,2]", '{"kind":123}']) {
      expect(parse(body)).toBeNull();
    }
  });

  it("rejects an envelope whose fields are the wrong shape", () => {
    expect(parse('{"kind":"inzo.claim","globs":"src/**"}')).toBeNull();
    expect(parse('{"kind":"inzo.head","branch":"x","sha":"y"}')).toBeNull();
  });

  it("folds interleaved claim and release into the right claim set", () => {
    const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    const presence = foldPresence([
      { fromAgentId: "a", body: encode({ kind: "inzo.claim", globs: ["src/**", "docs/**"] }), createdAt: at(1) },
      { fromAgentId: "b", body: encode({ kind: "inzo.claim", globs: ["test/**"] }), createdAt: at(2) },
      { fromAgentId: "a", body: "just chatting", createdAt: at(3) },
      { fromAgentId: "a", body: encode({ kind: "inzo.release", globs: ["docs/**"] }), createdAt: at(4) },
      { fromAgentId: "a", body: encode({ kind: "inzo.status", text: "on it" }), createdAt: at(5) },
      { fromAgentId: "b", body: encode({ kind: "inzo.head", branch: "inzo/b", sha: "sha1", files: ["test/x.ts"] }), createdAt: at(6) },
    ]);

    expect(presence.get("a")?.claims).toEqual(["src/**"]);
    expect(presence.get("a")?.status).toBe("on it");
    expect(presence.get("a")?.lastSeen).toBe(at(5)); // chat does not refresh presence
    expect(presence.get("b")?.claims).toEqual(["test/**"]);
    expect(presence.get("b")?.head).toEqual({ branch: "inzo/b", sha: "sha1", files: ["test/x.ts"] });
  });

  it("an empty release drops every claim", () => {
    const presence = foldPresence([
      { fromAgentId: "a", body: encode({ kind: "inzo.claim", globs: ["x", "y"] }), createdAt: "t1" },
      { fromAgentId: "a", body: encode({ kind: "inzo.release", globs: [] }), createdAt: "t2" },
    ]);
    expect(presence.get("a")?.claims).toEqual([]);
  });

  it("does not double-count a repeated claim", () => {
    const presence = foldPresence([
      { fromAgentId: "a", body: encode({ kind: "inzo.claim", globs: ["x"] }), createdAt: "t1" },
      { fromAgentId: "a", body: encode({ kind: "inzo.claim", globs: ["x"] }), createdAt: "t2" },
    ]);
    expect(presence.get("a")?.claims).toEqual(["x"]);
  });
});
