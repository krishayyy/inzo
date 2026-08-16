import { describe, expect, it } from "vitest";
import { parse, PlanFileError, render, type PlanView } from "../planfile.js";

const handles = { agent_me: "you", agent_kri: "krishay" };

const plan: PlanView = {
  goal: "Ship the inzo TUI shell",
  items: [
    { owner: "agent_me", task: "Ink app skeleton", status: "done" },
    { owner: "agent_kri", task: "claim/presence envelopes", status: "in_progress" },
    { owner: "agent_me", task: "git sync engine", status: "pending", dependsOn: [0] },
  ],
  version: 3,
  locked: true,
  approvedBy: ["agent_me", "agent_kri"],
};

describe("planfile", () => {
  it("render → parse → render is a fixed point", () => {
    const once = render(plan, handles);
    const parsed = parse(once, handles);
    expect(parsed).toEqual(plan);
    expect(render(parsed, handles)).toBe(once);
  });

  it("renders statuses, owners and dependencies legibly", () => {
    const text = render(plan, handles);
    expect(text).toContain("- [x] @you");
    expect(text).toContain("- [>] @krishay");
    expect(text).toContain("(needs: 1)"); // 1-based in the file, 0-based in dependsOn
    expect(text).toContain("<!-- inzo: version 3 | locked | approved you,krishay -->");
  });

  it("rejects a forward dependency", () => {
    const bad = render(plan, handles).replace("(needs: 1)", "(needs: 3)");
    expect(() => parse(bad, handles)).toThrow(PlanFileError);
  });

  it("rejects a file with no goal, no tasks, or an unparseable line", () => {
    expect(() => parse("# Goal\n\n## Tasks\n- [x] @you a", handles)).toThrow(/Goal` section is empty/);
    expect(() => parse("# Goal\nx\n## Tasks\n", handles)).toThrow(/no tasks/);
    expect(() => parse("# Goal\nx\n## Tasks\n* [x] @you a", handles)).toThrow(/Cannot parse/);
    expect(() => parse("nothing structured here", handles)).toThrow(/# Goal/);
  });

  it("keeps an unknown handle as-is rather than guessing an agent", () => {
    const parsed = parse("# Goal\nx\n## Tasks\n- [ ] @stranger do a thing", handles);
    expect(parsed.items[0].owner).toBe("stranger");
  });
});
