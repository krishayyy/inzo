import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlappingPaths, validatePresence } from "inzo-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPresence } from "../render.js";
import { isUsageError } from "../start.js";
import { conflictedPaths, parseSyncFlags, readPresence, syncArgv } from "../sync.js";

let dir: string;

function git(args: string[], cwd = dir): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "inzo-sync-test-")));
  git(["init", "--quiet", "-b", "inzo/7fk2q9"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "first"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sync rails", () => {
  it("never emits --force, under any condition", () => {
    // Asserted on the built argv rather than trusted from the source, because
    // this is the rail whose failure destroys a teammate's work.
    for (const branch of ["inzo/7fk2q9", "inzo/aaaaaa", "feature/x"]) {
      const flat = syncArgv(branch).flat();
      expect(flat).not.toContain("--force");
      expect(flat).not.toContain("-f");
      expect(flat).not.toContain("--force-with-lease");
    }
  });

  it("pulls with rebase and autostash, then pushes, in that order", () => {
    expect(syncArgv("inzo/7fk2q9")).toEqual([
      ["pull", "--rebase", "--autostash", "origin", "inzo/7fk2q9"],
      ["push", "origin", "inzo/7fk2q9"],
    ]);
  });

  it("targets the session branch explicitly, never the current HEAD by default", () => {
    // `git push` with no refspec depends on push.default, which a teammate's
    // global config could point anywhere.
    for (const args of syncArgv("inzo/abc123")) {
      expect(args).toContain("origin");
      expect(args).toContain("inzo/abc123");
    }
  });

  it("rejects unknown flags as usage errors", () => {
    expect(parseSyncFlags(["--dry-run", "--json"])).toEqual({ dryRun: true, json: true });
    let caught: unknown;
    try {
      parseSyncFlags(["--force"]);
    } catch (err) {
      caught = err;
    }
    expect(isUsageError(caught)).toBe(true);
  });
});

describe("reading presence from a real repo", () => {
  it("reports the head, the dirty paths, and a clean tree as clean", async () => {
    const clean = await readPresence(dir, "inzo/7fk2q9");
    expect(clean.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(clean.dirty).toEqual([]);
    expect(clean.conflicted).toBe(false);

    writeFileSync(join(dir, "README.md"), "changed\n");
    writeFileSync(join(dir, "new.ts"), "export {};\n");
    const dirty = await readPresence(dir, "inzo/7fk2q9");
    expect(dirty.dirty.sort()).toEqual(["README.md", "new.ts"]);
  });

  it("produces a payload the relay accepts", async () => {
    writeFileSync(join(dir, "a.ts"), "x\n");
    const presence = await readPresence(dir, "inzo/7fk2q9");
    // The protocol validator is the relay's own; if this throws, sync would
    // 400 on every call and presence would silently never update.
    expect(() => validatePresence(presence)).not.toThrow();
  });

  it("finds no conflicts in a clean repo", async () => {
    expect(await conflictedPaths(dir)).toEqual([]);
  });
});

describe("overlap detection", () => {
  it("names only files more than one member has dirty", () => {
    const overlap = overlappingPaths([
      { dirty: ["src/api.ts", "package.json"] },
      { dirty: ["web/App.tsx", "package.json"] },
      { dirty: ["docs/README.md"] },
    ]);
    expect(overlap).toEqual(["package.json"]);
  });

  it("does not count one member's duplicate as an overlap", () => {
    expect(overlappingPaths([{ dirty: ["a.ts", "a.ts"] }, { dirty: ["b.ts"] }])).toEqual([]);
  });

  it("finds nothing when nobody overlaps", () => {
    expect(overlappingPaths([{ dirty: ["a.ts"] }, { dirty: ["b.ts"] }])).toEqual([]);
  });
});

describe("presence panel", () => {
  const entry = (agentId: string, dirty: string[], extra = {}) => ({
    agentId,
    branch: "inzo/7fk2q9",
    head: "a1b2c3d",
    dirty,
    ahead: 0,
    behind: 0,
    conflicted: false,
    at: new Date().toISOString(),
    ...extra,
  });

  it("renders one row per member and flags the overlap", () => {
    const panel = formatPresence(
      [entry("agent_aaaa1111", ["src/api.ts", "package.json"]), entry("agent_bbbb2222", ["web/App.tsx", "package.json"])],
      "agent_aaaa1111",
    );
    expect(panel.split("\n")).toHaveLength(3);
    expect(panel).toContain("(you)");
    expect(panel).toContain("both dirty: package.json");
  });

  it("marks a conflicted member in words, not only color", () => {
    const panel = formatPresence([entry("agent_aaaa1111", ["a.ts"], { conflicted: true })], "agent_bbbb2222");
    expect(panel).toContain("CONFLICTED");
  });

  it("says so plainly when nobody has posted yet", () => {
    expect(formatPresence([], "agent_aaaa1111")).toContain("No presence yet");
  });
});
