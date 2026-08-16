import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeMcpConfig } from "../pair.js";

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "inzo-pair-test-")));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("mergeMcpConfig", () => {
  it("writes a fresh .mcp.json when none exists", () => {
    mergeMcpConfig();
    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers.inzo).toEqual({
      command: "npx",
      args: ["-y", "inzo-mcp"],
      env: { INZO_WORKSPACE: dir },
    });
  });

  it("merges into an existing config without touching other servers", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "npx", args: ["-y", "other-mcp"] } } }),
    );
    mergeMcpConfig();
    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(config.mcpServers.other).toEqual({ command: "npx", args: ["-y", "other-mcp"] });
    expect(config.mcpServers.inzo.args).toEqual(["-y", "inzo-mcp"]);
  });

  it("refuses to clobber an unparsable .mcp.json", () => {
    writeFileSync(join(dir, ".mcp.json"), "not json");
    expect(() => mergeMcpConfig()).toThrow(/not valid JSON/);
  });
});
