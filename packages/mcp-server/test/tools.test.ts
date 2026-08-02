import { describe, it, expect } from "vitest";
import { z } from "zod";

// We validate the same shapes used as inputSchema in src/tools.ts, since the
// McpServer wraps them internally and isn't trivial to introspect directly.

const proposePlanSchema = z.object({
  goal: z.string().min(1),
  tasks: z
    .array(
      z.object({
        owner: z.string().min(1),
        task: z.string().min(1),
      }),
    )
    .min(1),
});

const joinPairingSchema = z.object({
  code: z.string().min(1),
});

const reportUsageSchema = z.object({
  tokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  progressPct: z.number().min(0).max(100),
});

describe("propose_plan input schema", () => {
  it("accepts a valid goal + task split", () => {
    const result = proposePlanSchema.safeParse({
      goal: "Ship the login page",
      tasks: [
        { owner: "agent_a", task: "Build the form" },
        { owner: "agent_b", task: "Wire up the API" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty task list", () => {
    const result = proposePlanSchema.safeParse({ goal: "Ship it", tasks: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a missing goal", () => {
    const result = proposePlanSchema.safeParse({
      tasks: [{ owner: "agent_a", task: "Do stuff" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("join_pairing input schema", () => {
  it("accepts a non-empty code", () => {
    expect(joinPairingSchema.safeParse({ code: "ABC123" }).success).toBe(true);
  });

  it("rejects an empty code", () => {
    expect(joinPairingSchema.safeParse({ code: "" }).success).toBe(false);
  });
});

describe("report_usage input schema", () => {
  it("accepts valid usage data", () => {
    const result = reportUsageSchema.safeParse({
      tokens: 1200,
      cost: 0.42,
      seconds: 90,
      progressPct: 50,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a progressPct over 100", () => {
    const result = reportUsageSchema.safeParse({
      tokens: 0,
      cost: 0,
      seconds: 0,
      progressPct: 150,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative token counts", () => {
    const result = reportUsageSchema.safeParse({
      tokens: -5,
      cost: 0,
      seconds: 0,
      progressPct: 0,
    });
    expect(result.success).toBe(false);
  });
});
