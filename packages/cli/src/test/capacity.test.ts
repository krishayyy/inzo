import { tightestWindow, validateCapacity } from "inzo-protocol";
import { describe, expect, it } from "vitest";
import { formatWindow, parseCapacityFlags, resolveResetTime } from "../capacity.js";
import { formatPresence } from "../render.js";
import { isUsageError } from "../start.js";

function usageErrorFrom(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return isUsageError(err);
  }
}

describe("capacity flags", () => {
  it("accepts both 62% and 0.62, because people type both", () => {
    expect(parseCapacityFlags(["--window", "5h", "--used", "62%"]).used).toBeCloseTo(0.62);
    expect(parseCapacityFlags(["--window", "5h", "--used", "0.62"]).used).toBeCloseTo(0.62);
  });

  it("rejects a fraction outside 0-1 rather than clamping it", () => {
    // Clamping would hide a sender computing the fraction wrong, and the
    // number would then quietly misreport a teammate's remaining quota.
    expect(usageErrorFrom(() => parseCapacityFlags(["--used", "150%"]))).toBe(true);
    expect(usageErrorFrom(() => parseCapacityFlags(["--used", "-1"]))).toBe(true);
    expect(usageErrorFrom(() => parseCapacityFlags(["--used", "lots"]))).toBe(true);
  });

  it("rejects a flag with no value, and unknown flags", () => {
    expect(usageErrorFrom(() => parseCapacityFlags(["--window"]))).toBe(true);
    expect(usageErrorFrom(() => parseCapacityFlags(["--window", "--used"]))).toBe(true);
    expect(usageErrorFrom(() => parseCapacityFlags(["--nope"]))).toBe(true);
  });
});

describe("reset times", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("reads a bare clock time as the next time it comes around", () => {
    // A reset is always in the near future by definition, so "15:40" is
    // unambiguous — and it is what people will type.
    const later = new Date(resolveResetTime("15:40", now));
    expect(later.getTime()).toBeGreaterThan(now.getTime());
    expect(later.getHours()).toBe(15);
    expect(later.getMinutes()).toBe(40);
  });

  it("rolls a time that has already passed to tomorrow", () => {
    const local = new Date(now);
    const past = `${String(local.getHours() - 1).padStart(2, "0")}:00`;
    const resolved = new Date(resolveResetTime(past, now));
    expect(resolved.getTime()).toBeGreaterThan(now.getTime());
  });

  it("accepts a full ISO timestamp and rejects anything else", () => {
    expect(resolveResetTime("2026-09-01T15:40:00.000Z", now)).toBe("2026-09-01T15:40:00.000Z");
    expect(usageErrorFrom(() => resolveResetTime("soon", now))).toBe(true);
  });
});

describe("window rendering", () => {
  it("labels an estimate as one, and leaves a declared figure unhedged", () => {
    const estimated = formatWindow({ label: "5h", used: 0.62, resetsAt: null, estimated: true });
    const declared = formatWindow({ label: "5h", used: 0.62, resetsAt: null, estimated: false });
    expect(estimated).toContain("(est)");
    expect(declared).not.toContain("(est)");
  });

  it("draws the bar in proportion and never signals by color alone", () => {
    expect(formatWindow({ label: "5h", used: 0, resetsAt: null, estimated: false })).toContain("░░░░░░░░░░");
    expect(formatWindow({ label: "5h", used: 1, resetsAt: null, estimated: false })).toContain("▓▓▓▓▓▓▓▓▓▓");
    expect(formatWindow({ label: "5h", used: 0.62, resetsAt: null, estimated: false })).toContain("62%");
  });
});

describe("tightest window", () => {
  it("picks the fullest window, not the first", () => {
    const capacity = validateCapacity({
      provider: "anthropic",
      windows: [
        { label: "5h", used: 0.2, estimated: true },
        { label: "weekly", used: 0.91, estimated: true },
      ],
    });
    expect(tightestWindow(capacity)?.label).toBe("weekly");
  });

  it("returns null when there is nothing to report", () => {
    expect(tightestWindow(null)).toBeNull();
    expect(tightestWindow(validateCapacity({ provider: "local", windows: [] }))).toBeNull();
  });
});

describe("capacity in the presence panel", () => {
  const entry = (agentId: string, capacity: unknown) => ({
    agentId,
    branch: "inzo/7fk2q9",
    head: "a1b2c3d",
    dirty: [],
    ahead: 0,
    behind: 0,
    conflicted: false,
    at: new Date().toISOString(),
    capacity: capacity as never,
  });

  it("renders nothing for a member reporting no windows", () => {
    // A provider nobody has taught us about must go quiet, not guess — and a
    // zeroed bar would read as "no quota left".
    const panel = formatPresence([entry("agent_aaaa1111", null)], "agent_aaaa1111");
    expect(panel).not.toContain("%");
  });

  it("shows a bar for a member who reports one", () => {
    const panel = formatPresence(
      [entry("agent_aaaa1111", { provider: "anthropic", windows: [{ label: "5h", used: 0.62, resetsAt: null, estimated: true }] })],
      "agent_aaaa1111",
    );
    expect(panel).toContain("62% of 5h");
  });

  it("marks a nearly-exhausted window in words, not only color", () => {
    const panel = formatPresence(
      [entry("agent_aaaa1111", { provider: "anthropic", windows: [{ label: "5h", used: 0.95, resetsAt: null, estimated: false }] })],
      "agent_bbbb2222",
    );
    expect(panel).toContain("LOW");
  });
});
