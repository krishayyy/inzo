import { describe, expect, it } from "vitest";
import { SseParser } from "../sse.js";

describe("SseParser", () => {
  it("parses a complete frame", () => {
    const parser = new SseParser();
    const events = parser.push('event: message.created\ndata: {"message":{"body":"hi"}}\n\n');
    expect(events).toEqual([{ event: "message.created", data: { message: { body: "hi" } } }]);
  });

  it("reassembles a frame split across chunks", () => {
    // A socket can split anywhere, including mid-field. Naive per-chunk
    // parsing silently drops the event when that happens.
    const parser = new SseParser();
    expect(parser.push("event: plan.upd")).toEqual([]);
    expect(parser.push('ated\ndata: {"plan":{"ver')).toEqual([]);
    const events = parser.push('sion":3}}\n\n');
    expect(events).toEqual([{ event: "plan.updated", data: { plan: { version: 3 } } }]);
  });

  it("emits several frames arriving in one chunk", () => {
    const parser = new SseParser();
    const events = parser.push('event: ping\ndata: {"t":1}\n\nevent: ping\ndata: {"t":2}\n\n');
    expect(events).toHaveLength(2);
    expect(events[1].data).toEqual({ t: 2 });
  });

  it("ignores comment keepalives", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\n\n")).toEqual([]);
  });

  it("ignores a data-only frame with no event name", () => {
    const parser = new SseParser();
    expect(parser.push("data: orphan\n\n")).toEqual([]);
  });

  it("joins multi-line data fields", () => {
    const parser = new SseParser();
    const events = parser.push("event: note\ndata: line one\ndata: line two\n\n");
    expect(events[0].data).toBe("line one\nline two");
  });

  it("keeps unparseable data as a raw string instead of throwing", () => {
    const parser = new SseParser();
    const events = parser.push("event: note\ndata: not json\n\n");
    expect(events[0].data).toBe("not json");
  });
});
