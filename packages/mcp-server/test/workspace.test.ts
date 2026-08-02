import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspace } from "../src/workspace.js";

describe("resolveWorkspace", () => {
  it("refuses to guess when INZO_WORKSPACE is unset", () => {
    expect(() => resolveWorkspace(undefined)).toThrow(/no default/i);
    expect(() => resolveWorkspace("   ")).toThrow(/INZO_WORKSPACE is not set/);
  });

  it("refuses the filesystem root", () => {
    expect(() => resolveWorkspace("/")).toThrow(/filesystem root/);
  });

  it("refuses the home directory itself", () => {
    expect(() => resolveWorkspace(homedir())).toThrow(/home directory/);
  });

  it("refuses any directory that contains the home directory", () => {
    // e.g. /Users on macOS, /home on Linux — mounting these would expose
    // everything the user owns to a peer's agent.
    const parentOfHome = join(homedir(), "..");
    expect(() => resolveWorkspace(parentOfHome)).toThrow(/contains your home directory/);
  });

  it("refuses a path that does not exist", () => {
    expect(() => resolveWorkspace(join(tmpdir(), "inzo-does-not-exist-xyz"))).toThrow(/does not exist/);
  });

  it("refuses a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "inzo-ws-"));
    const file = join(dir, "not-a-dir.txt");
    writeFileSync(file, "x");
    expect(() => resolveWorkspace(file)).toThrow(/not a directory/);
  });

  it("accepts a real project directory and returns it absolute", () => {
    const dir = mkdtempSync(join(tmpdir(), "inzo-ws-"));
    expect(resolveWorkspace(dir)).toBe(dir);
  });
});
