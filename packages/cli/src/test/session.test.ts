import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacySessionFilePath, sessionFilePathFor, writeCurrentPointer } from "inzo-holder";
import { loadSession, resolveWorkspace, sessionFilePath } from "../session.js";

let home: string;
let root: string;
let cwd: string;
let priorHome: string | undefined;

/** Minimal well-formed session, so loadSession's validation isn't what's under test. */
function sessionFor(pairingId: string, holderPrivateKey: string) {
  return JSON.stringify({
    relayUrl: "https://relay.test",
    pairingId,
    agentId: `agent_${pairingId}`,
    agentToken: `token_${pairingId}`,
    holderPrivateKey,
    updatedAt: new Date().toISOString(),
  });
}

function writeSessionAt(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inzo-session-test-")));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  priorHome = process.env.INZO_HOME;
  process.env.INZO_HOME = home;
  cwd = process.cwd();
});

afterEach(() => {
  process.chdir(cwd);
  if (priorHome === undefined) delete process.env.INZO_HOME;
  else process.env.INZO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
});

describe("workspace-keyed sessions", () => {
  it("gives two projects two separate session files", () => {
    const a = join(root, "project-a");
    const b = join(root, "project-b");
    mkdirSync(a);
    mkdirSync(b);

    expect(sessionFilePathFor(a)).not.toBe(sessionFilePathFor(b));
  });

  it("does not let a second project overwrite the first project's holder key", () => {
    // The bug this replaces: one global session.json meant pairing project B
    // destroyed project A's holder private key, which cannot be regenerated.
    const a = join(root, "project-a");
    const b = join(root, "project-b");
    mkdirSync(a);
    mkdirSync(b);

    writeSessionAt(sessionFilePathFor(a), sessionFor("pair_a", "KEY_A"));
    writeSessionAt(sessionFilePathFor(b), sessionFor("pair_b", "KEY_B"));

    process.chdir(a);
    expect(loadSession().holderPrivateKey).toBe("KEY_A");
    process.chdir(b);
    expect(loadSession().holderPrivateKey).toBe("KEY_B");
  });

  it("resolves the same session from a subdirectory of the repo", () => {
    const repo = join(root, "repo");
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"));

    process.chdir(nested);
    expect(resolveWorkspace()).toBe(realpathSync(repo));
  });

  it("treats a directory outside a repo as its own workspace", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    process.chdir(plain);
    expect(resolveWorkspace()).toBe(realpathSync(plain));
  });

  it("falls back to the current pointer when this directory has no session", () => {
    const paired = join(root, "paired");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(paired);
    mkdirSync(elsewhere);

    writeSessionAt(sessionFilePathFor(paired), sessionFor("pair_p", "KEY_P"));
    writeCurrentPointer(paired);

    process.chdir(elsewhere);
    expect(loadSession().pairingId).toBe("pair_p");
  });

  it("still reads a pre-upgrade global session so an existing pairing survives", () => {
    const plain = join(root, "legacy-user");
    mkdirSync(plain);
    writeSessionAt(legacySessionFilePath(), sessionFor("pair_legacy", "KEY_LEGACY"));

    process.chdir(plain);
    expect(loadSession().pairingId).toBe("pair_legacy");
  });

  it("prefers this workspace's own session over the legacy global one", () => {
    const own = join(root, "own");
    mkdirSync(own);
    writeSessionAt(legacySessionFilePath(), sessionFor("pair_legacy", "KEY_LEGACY"));
    writeSessionAt(sessionFilePathFor(own), sessionFor("pair_own", "KEY_OWN"));

    process.chdir(own);
    expect(loadSession().pairingId).toBe("pair_own");
  });

  it("names this workspace's path when no session exists anywhere", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    process.chdir(empty);

    expect(sessionFilePath()).toBe(sessionFilePathFor(empty));
    expect(() => loadSession()).toThrow(/No Inzo session found/);
  });

  it("keys through symlinks so /tmp and /private/tmp are one session", () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    // realpathSync in sessionKeyFor should collapse these to one key.
    symlinkSync(real, link);
    expect(sessionFilePathFor(link)).toBe(sessionFilePathFor(real));
  });
});

describe("session file contents", () => {
  it("rejects a session missing its credential fields", () => {
    const dir = join(root, "broken");
    mkdirSync(dir);
    writeSessionAt(sessionFilePathFor(dir), JSON.stringify({ relayUrl: "https://relay.test" }));
    process.chdir(dir);
    expect(() => loadSession()).toThrow(/incomplete/);
  });

  it("rejects a session file that is not valid JSON", () => {
    const dir = join(root, "corrupt");
    mkdirSync(dir);
    writeSessionAt(sessionFilePathFor(dir), "{not json");
    process.chdir(dir);
    expect(() => loadSession()).toThrow(/not valid JSON/);
  });

  it("keeps the pointer readable only by its owner", () => {
    const dir = join(root, "perms");
    mkdirSync(dir);
    writeCurrentPointer(dir);
    const mode = statSync(join(home, ".inzo", "current")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("legacy session is never written to", () => {
  it("writes new sessions under sessions/, leaving the global file untouched", () => {
    const dir = join(root, "fresh");
    mkdirSync(dir);
    writeSessionAt(legacySessionFilePath(), sessionFor("pair_legacy", "KEY_LEGACY"));

    writeSessionAt(sessionFilePathFor(dir), sessionFor("pair_new", "KEY_NEW"));

    expect(JSON.parse(readFileSync(legacySessionFilePath(), "utf8")).pairingId).toBe("pair_legacy");
  });
});
