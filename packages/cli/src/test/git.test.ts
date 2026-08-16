import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branchFor, collisions, Git, matchGlob } from "../git.js";

let repo: string;
let git: Git;

const write = (name: string, body: string) => writeFileSync(join(repo, name), body);

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "inzo-git-"));
  git = new Git(repo);
  await git.run("init", "-b", "main");
  await git.run("config", "user.email", "test@inzo.local");
  await git.run("config", "user.name", "inzo test");
  write("a.ts", "one\n");
  await git.run("add", "-A");
  await git.run("commit", "-m", "initial");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("Git", () => {
  it("reports a clean repo, then the dirty paths", async () => {
    expect((await git.status()).dirty).toEqual([]);
    write("a.ts", "two\n");
    write("b.ts", "new\n");
    const status = await git.status();
    expect(status.repo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.sha).toHaveLength(40);
    expect(status.dirty.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("commits only the claimed paths", async () => {
    const result = await git.commitPaths(["a.ts"], "claimed only");
    expect(result.committed).toBe(true);
    expect(await git.changedFiles()).toEqual(["a.ts"]);
    expect((await git.status()).dirty).toEqual(["b.ts"]); // untouched, still dirty
  });

  it("reports nothing-to-commit as a state, not a throw", async () => {
    expect(await git.commitPaths([], "empty")).toMatchObject({ committed: false, reason: "nothing-to-commit" });
    expect(await git.commitPaths(["a.ts"], "no change")).toMatchObject({
      committed: false,
      reason: "nothing-to-commit",
    });
  });

  it("refuses to push a protected branch or somebody else's branch", async () => {
    expect(await git.push("main", "main")).toMatchObject({ pushed: false, reason: /refusing to push to main/ });
    expect(await git.push("inzo/them", "inzo/me")).toMatchObject({ pushed: false, reason: /not your branch/ });
  });

  it("reports a rebase conflict as a state and refuses to commit mid-rebase", async () => {
    await git.run("checkout", "-b", "side");
    write("a.ts", "side\n");
    await git.commitPaths(["a.ts"], "side change");
    await git.run("checkout", "main");
    write("a.ts", "main\n");
    await git.commitPaths(["a.ts"], "main change");
    await git.run("checkout", "side");

    const rebase = await git.rebase("main");
    expect(rebase.ok).toBe(false);
    expect(rebase.conflict).toBe(true);

    const status = await git.status();
    expect(status.rebaseInProgress).toBe(true);
    expect(await git.commitPaths(["a.ts"], "during rebase")).toMatchObject({
      committed: false,
      reason: "rebase-or-merge-in-progress",
    });
    await git.run("rebase", "--abort");
  });

  it("reports a non-repo without throwing", async () => {
    const outside = new Git(mkdtempSync(join(tmpdir(), "inzo-norepo-")));
    expect((await outside.status()).repo).toBe(false);
  });
});

describe("glob matching", () => {
  it("matches the patterns claims are actually written with", () => {
    expect(matchGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchGlob("src/**", "test/a.ts")).toBe(false);
    expect(matchGlob("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(matchGlob("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchGlob("a.ts", "a.ts")).toBe(true);
    expect(matchGlob("a?.ts", "ab.ts")).toBe(true);
    expect(matchGlob("a.ts", "ax.ts")).toBe(false); // the dot is literal
  });

  it("finds the paths of yours that sit inside a peer's claim", () => {
    expect(collisions(["src/a.ts", "docs/x.md"], ["src/**"])).toEqual(["src/a.ts"]);
    expect(collisions(["docs/x.md"], ["src/**"])).toEqual([]);
  });
});

describe("branchFor", () => {
  it("gives each agent its own branch and never a shared one", () => {
    expect(branchFor("agent_kri9wq21xx")).toBe("inzo/kri9wq21");
    expect(branchFor("agent_kri9wq21xx")).not.toBe(branchFor("agent_zzz9wq21xx"));
  });
});
