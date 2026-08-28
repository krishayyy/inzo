import { describe, expect, it } from "vitest";
import type { MinePairing, Plan } from "../api.js";
import { formatPairing, formatPlan } from "../render.js";

const members = ["agent_aaaa1111", "agent_bbbb2222", "agent_cccc3333", "agent_dddd4444", "agent_eeee5555"];
const SELF = members[0];

function plan(approvedBy: string[], locked = false): Plan {
  return {
    goal: "Ship the thing",
    items: members.slice(0, 2).map((owner, i) => ({ owner, task: `task ${i}` })),
    proposedBy: SELF,
    approvedBy,
    locked,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

function pairing(overrides: Partial<MinePairing> = {}): MinePairing {
  return {
    id: "pairing_1",
    agentId: SELF,
    members,
    memberDetails: members.map((agentId) => ({ agentId, scope: ["commands:run", "plan:approve", "plan:propose", "messages:send"], revoked: false })),
    peerAgentId: null as unknown as string,
    budget: null,
    scope: ["commands:run", "plan:approve", "plan:propose", "messages:send"],
    peerScope: [],
    revoked: false,
    peerRevoked: false,
    ...overrides,
  };
}

describe("plan rendering past two members (P0-3)", () => {
  it("renders one approval box per member, not two", () => {
    // Showing five people two boxes is not cosmetic: it hides who everyone
    // is still waiting on, and a plan locks only when all five have signed.
    const rendered = formatPlan(plan([SELF]), SELF, null, members);
    const boxes = rendered.match(/\[[ x]\]/g) ?? [];
    expect(boxes).toHaveLength(5);
    expect(boxes.filter((box) => box === "[x]")).toHaveLength(1);
  });

  it("counts how many approvals are still outstanding", () => {
    expect(formatPlan(plan([SELF, members[1]]), SELF, null, members)).toContain("AWAITING 3 OF 5");
    expect(formatPlan(plan(members, true), SELF, null, members)).toContain("LOCKED");
  });

  it("labels you as you and everyone else by a readable id", () => {
    const rendered = formatPlan(plan([]), SELF, null, members);
    expect(rendered).toContain("you");
    expect(rendered).toContain("bbbb2222");
    // Never "peer" past two people — there isn't one.
    expect(rendered).not.toContain("peer");
  });

  it("still renders a two-member pairing from peerAgentId alone", () => {
    // A relay that predates memberDetails must keep working.
    const rendered = formatPlan(plan([SELF]), SELF, members[1]);
    expect(rendered.match(/\[[ x]\]/g)).toHaveLength(2);
  });
});

describe("pairing rendering past two members", () => {
  it("renders one row per member", () => {
    const rendered = formatPairing(pairing());
    for (const agentId of members) {
      expect(rendered).toContain(agentId.slice(6, 14));
    }
    expect(rendered.split("\n").filter((line) => line.includes("active"))).toHaveLength(5);
  });

  it("marks a single revoked member without touching the rest", () => {
    const details = pairing().memberDetails!.map((member, i) => (i === 2 ? { ...member, revoked: true } : member));
    const rendered = formatPairing(pairing({ memberDetails: details }));
    expect(rendered.split("\n").filter((line) => line.includes("REVOKED"))).toHaveLength(1);
    expect(rendered.split("\n").filter((line) => line.includes("active"))).toHaveLength(4);
  });

  it("names what a specific member has given up", () => {
    const details = pairing().memberDetails!.map((member, i) =>
      i === 1 ? { ...member, scope: ["messages:send"] } : member,
    );
    const rendered = formatPairing(pairing({ memberDetails: details }));
    expect(rendered).toContain("has given up: commands:run, plan:approve, plan:propose");
  });

  it("falls back to the two-member shape when the relay sends no details", () => {
    const rendered = formatPairing(
      pairing({ memberDetails: undefined, members: undefined, peerAgentId: members[1], peerScope: ["messages:send"] }),
    );
    expect(rendered.split("\n").filter((line) => line.includes("active"))).toHaveLength(2);
    expect(rendered).toContain("has given up: commands:run");
  });
});
