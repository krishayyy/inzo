import { describe, expect, it } from "vitest";
import { LedgerCache, PresenceStore, MAX_LEDGER_ENTRIES, MAX_LEDGER_BYTES, type ContextEntry, type Presence } from "../src/index.js";

/**
 * `LedgerCache` and `PresenceStore` are shared by both relays (Express and
 * Cloudflare) specifically so they cannot drift on eviction/expiry behavior.
 * These tests exercise that shared logic once, here, rather than trusting
 * each relay's own conformance suite to catch a regression in it.
 */
function entry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return { path: "a.ts", sha: "abc1234", summary: "x", agentId: "agent_1", at: new Date().toISOString(), ...overrides };
}

describe("LedgerCache", () => {
  it("returns what was put, and counts a hit", () => {
    const cache = new LedgerCache();
    const stored = entry();
    cache.put("a.ts@abc1234", stored);
    expect(cache.get("a.ts@abc1234")).toEqual(stored);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 1, hits: 1, misses: 0 });
  });

  it("counts a miss for an absent key, without creating an entry", () => {
    const cache = new LedgerCache();
    expect(cache.get("missing@0000000")).toBeNull();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, hits: 0, misses: 1 });
  });

  it("evicts oldest-first once MAX_LEDGER_ENTRIES is exceeded", () => {
    const cache = new LedgerCache();
    for (let i = 0; i <= MAX_LEDGER_ENTRIES; i++) {
      cache.put(`f${i}.ts@sha${i}`, entry({ path: `f${i}.ts`, sha: `sha${i}` }));
    }
    expect(cache.size).toBe(MAX_LEDGER_ENTRIES);
    // The very first entry should have been evicted to stay under the cap.
    expect(cache.get("f0.ts@sha0")).toBeNull();
    expect(cache.get(`f${MAX_LEDGER_ENTRIES}.ts@sha${MAX_LEDGER_ENTRIES}`)).not.toBeNull();
  });

  it("evicts on total byte size, independent of entry count", () => {
    const cache = new LedgerCache();
    const big = "x".repeat(MAX_LEDGER_BYTES);
    cache.put("big@sha", entry({ path: "big", sha: "sha", summary: big }));
    cache.put("small@sha2", entry({ path: "small", sha: "sha2", summary: "y" }));
    // The oversized first entry must have been evicted to bring bytes back
    // under the cap, even though only two entries were ever inserted.
    expect(cache.get("big@sha")).toBeNull();
  });

  it("touching an entry on read moves it to the end of LRU order", () => {
    const cache = new LedgerCache();
    cache.put("a@1", entry({ path: "a", sha: "1" }));
    cache.put("b@2", entry({ path: "b", sha: "2" }));
    // Touch "a" so "b" becomes the oldest. Fill to exactly one entry past the
    // cap so a single eviction happens — of "b", the true oldest.
    cache.get("a@1");
    for (let i = 0; i < MAX_LEDGER_ENTRIES - 1; i++) {
      cache.put(`filler${i}@sha`, entry({ path: `filler${i}`, sha: "sha" }));
    }
    // "b" was the least-recently-used, so it should be the one evicted first.
    expect(cache.get("b@2")).toBeNull();
    expect(cache.get("a@1")).not.toBeNull();
  });

  it("replacing an existing key does not double-count its bytes", () => {
    const cache = new LedgerCache();
    cache.put("a@1", entry({ path: "a", sha: "1", summary: "aaaa" }));
    cache.put("a@1", entry({ path: "a", sha: "1", summary: "bb" }));
    expect(cache.stats().bytes).toBe(2);
  });
});

describe("PresenceStore", () => {
  function presence(overrides: Partial<Presence> = {}): Presence {
    return { branch: "main", head: "abc1234", dirty: [], ahead: 0, behind: 0, conflicted: false, ...overrides };
  }

  it("returns what was set, tagged with agentId and a timestamp", () => {
    const store = new PresenceStore();
    const entry = store.set("agent_1", presence());
    expect(entry.agentId).toBe("agent_1");
    expect(entry.branch).toBe("main");
    expect(store.list()).toEqual([entry]);
  });

  it("last write wins per member", () => {
    const store = new PresenceStore();
    store.set("agent_1", presence({ branch: "main" }));
    store.set("agent_1", presence({ branch: "feature" }));
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].branch).toBe("feature");
  });

  it("reports empty once every member has expired", () => {
    const store = new PresenceStore();
    const entry = store.set("agent_1", presence());
    // Backdate the entry past the TTL directly, rather than waiting 90s.
    entry.at = new Date(0).toISOString();
    expect(store.list()).toEqual([]);
    expect(store.isEmpty).toBe(true);
  });
});
