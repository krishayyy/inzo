import { describe, expect, it } from "vitest";
import { atLeast, parseDoctorFlags, parseSemver } from "../doctor.js";
import { baseBranch, compareUrl, githubSlug, parseDoneFlags } from "../done.js";
import { isUsageError } from "../start.js";

function usageErrorFrom(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return isUsageError(err);
  }
}

describe("version parsing", () => {
  it("finds the version inside whatever a tool prints around it", () => {
    expect(parseSemver("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39, 5]);
    expect(parseSemver("Docker version 27.1.1, build 6312585")).toEqual([27, 1, 1]);
    expect(parseSemver("gh version 2.63.2 (2024-12-05)")).toEqual([2, 63, 2]);
    expect(parseSemver("v20.11.0")).toEqual([20, 11, 0]);
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver("no numbers here")).toBeNull();
  });

  it("treats a two-part version as patch zero", () => {
    expect(parseSemver("git version 2.30")).toEqual([2, 30, 0]);
  });

  it("compares by component, not lexically", () => {
    // The trap: "2.9" > "2.30" as strings, and git 2.9 is genuinely too old.
    expect(atLeast([2, 30, 0], [2, 30, 0])).toBe(true);
    expect(atLeast([2, 9, 0], [2, 30, 0])).toBe(false);
    expect(atLeast([2, 40, 1], [2, 30, 0])).toBe(true);
    expect(atLeast([3, 0, 0], [2, 30, 0])).toBe(true);
    expect(atLeast([1, 99, 99], [2, 30, 0])).toBe(false);
    expect(atLeast(null, [2, 30, 0])).toBe(false);
  });
});

describe("doctor flags", () => {
  it("accepts --json and rejects anything else as a usage error", () => {
    expect(parseDoctorFlags(["--json"])).toEqual({ json: true });
    expect(usageErrorFrom(() => parseDoctorFlags(["--fix"]))).toBe(true);
  });
});

describe("done flags", () => {
  it("parses the documented flags", () => {
    expect(parseDoneFlags(["--no-pr", "--json"])).toMatchObject({ noPr: true, json: true });
    expect(parseDoneFlags(["--base", "develop"])).toMatchObject({ base: "develop" });
  });

  it("rejects a --base with no value, and unknown flags", () => {
    expect(usageErrorFrom(() => parseDoneFlags(["--base"]))).toBe(true);
    expect(usageErrorFrom(() => parseDoneFlags(["--base", "--json"]))).toBe(true);
    expect(usageErrorFrom(() => parseDoneFlags(["--force"]))).toBe(true);
  });
});

describe("github remote parsing", () => {
  it.each([
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["https://github.com/owner/repo/", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "owner/repo"],
  ])("reads %s as a slug", (remote, slug) => {
    expect(githubSlug(remote)).toBe(slug);
  });

  it("returns null for a non-GitHub or missing remote", () => {
    expect(githubSlug("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(githubSlug(null)).toBeNull();
  });

  it("builds a compare URL that survives a slash in the branch name", () => {
    // Session branches always contain a slash, so this is the normal case.
    expect(compareUrl("owner/repo", "main", "inzo/7fk2q9")).toBe(
      "https://github.com/owner/repo/compare/main...inzo%2F7fk2q9?expand=1",
    );
  });
});

describe("base branch detection", () => {
  it("falls back to main outside a repo rather than throwing", async () => {
    // A wrong-but-sane default beats a crash at the end of a working session.
    expect(await baseBranch("/nonexistent-path-for-inzo-test")).toBe("main");
  });
});
