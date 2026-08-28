import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_CLIENT_VERSION } from "inzo-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertClientSupported, isCacheStale, isNewer, rewriteMcpPin, updateCheckDisabled } from "../update.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "inzo-update-test-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.INZO_NO_UPDATE_CHECK;
});

describe("version comparison", () => {
  it("compares numerically, not lexically", () => {
    // The trap: "0.10.0" < "0.9.0" as strings, and getting this backwards
    // means telling everyone to downgrade.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.4.1", "0.4.1")).toBe(false);
    expect(isNewer("0.4.0", "0.4.1")).toBe(false);
  });

  it("says no rather than guessing when a version is unparseable", () => {
    expect(isNewer("next", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "")).toBe(false);
  });
});

describe("update check discipline", () => {
  it("is disabled by INZO_NO_UPDATE_CHECK", () => {
    process.env.INZO_NO_UPDATE_CHECK = "1";
    expect(updateCheckDisabled()).toBe(true);
  });

  it("is disabled off a TTY, so CI stays silent", () => {
    // Covers CI without detecting it, and covers piping into jq or head too.
    delete process.env.INZO_NO_UPDATE_CHECK;
    expect(updateCheckDisabled()).toBe(process.stdout.isTTY !== true);
  });

  it("checks at most once a day", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    expect(isCacheStale(null, now)).toBe(true);
    expect(isCacheStale({ latest: "0.2.0", checkedAt: "2026-09-01T11:00:00.000Z" }, now)).toBe(false);
    expect(isCacheStale({ latest: "0.2.0", checkedAt: "2026-08-30T11:00:00.000Z" }, now)).toBe(true);
    expect(isCacheStale({ latest: "0.2.0", checkedAt: "not a date" }, now)).toBe(true);
  });
});

describe("the .mcp.json pin (U-3)", () => {
  function write(args: string[]): void {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { inzo: { command: "npx", args, env: { INZO_WORKSPACE: dir } } } }),
    );
  }

  it("rewrites a stale pin", () => {
    // The failure this prevents: you update the CLI, everything looks
    // current, and your agent keeps running last month's server forever.
    write(["-y", "inzo-mcp@0.1.0"]);
    expect(rewriteMcpPin(dir, "0.2.0")).toBe("0.2.0");
    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers.inzo.args).toEqual(["-y", "inzo-mcp@0.2.0"]);
  });

  it("leaves a current pin alone", () => {
    write(["-y", "inzo-mcp@0.2.0"]);
    expect(rewriteMcpPin(dir, "0.2.0")).toBeNull();
  });

  it("does not touch other servers or other arguments", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "npx", args: ["-y", "other-mcp@1.0.0"] },
          inzo: { command: "npx", args: ["-y", "inzo-mcp@0.1.0"], env: { INZO_WORKSPACE: dir } },
        },
      }),
    );
    rewriteMcpPin(dir, "0.2.0");
    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers.other.args).toEqual(["-y", "other-mcp@1.0.0"]);
    expect(config.mcpServers.inzo.env.INZO_WORKSPACE).toBe(dir);
  });

  it("leaves a malformed or absent config alone rather than rewriting it blindly", () => {
    expect(rewriteMcpPin(dir, "0.2.0")).toBeNull();
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    expect(rewriteMcpPin(dir, "0.2.0")).toBeNull();
  });
});

describe("client version negotiation (U-3)", () => {
  it("refuses a client older than the relay's minimum", () => {
    // A clear refusal beats a subtle disagreement — and what two clients
    // could silently disagree about is what a human approved.
    expect(() => assertClientSupported("0.4.0", "0.3.0")).toThrow(/needs inzo 0\.4\.0 or newer/);
  });

  it("allows an equal or newer client", () => {
    expect(() => assertClientSupported("0.4.0", "0.4.0")).not.toThrow();
    expect(() => assertClientSupported("0.4.0", "0.5.0")).not.toThrow();
  });

  it("proceeds against a relay that advertises no minimum", () => {
    // A relay that predates negotiation is not enforcing anything.
    expect(() => assertClientSupported(null, "0.1.0")).not.toThrow();
    expect(() => assertClientSupported(undefined, "0.1.0")).not.toThrow();
  });

  it("lets this build into a session on the shipped minimum", () => {
    expect(() => assertClientSupported(MIN_CLIENT_VERSION, "0.1.0")).not.toThrow();
  });
});
