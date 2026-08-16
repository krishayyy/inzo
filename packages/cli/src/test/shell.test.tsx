import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api.js";
import { encode } from "../envelope.js";
import { App } from "../shell/app.js";
import type { SessionFile } from "../session.js";

const SHIFT_TAB = "[Z";
const ENTER = "\r";

const session: SessionFile = {
  relayUrl: "http://127.0.0.1:1",
  pairingId: "pair_test",
  agentId: "agent_me",
  agentToken: "tok",
  updatedAt: new Date().toISOString(),
};

const sent: string[] = [];

/** Enough of the API for the shell to mount; the stream URL never connects. */
function fakeApi(): Api {
  return {
    mine: async () => ({ pairing: null }),
    messages: async () => ({ messages: [], cursor: 0 }),
    plan: async () => ({ plan: null }),
    usage: async () => ({ usage: { byAgent: {}, totals: { tokensUsed: 0, costUsd: 0, wallClockMs: 0 } }, runway: {} }),
    sendMessage: async (_pairingId: string, body: string) => {
      sent.push(body);
      return { message: {} };
    },
    canSignConsent: () => false,
    streamUrl: () => "http://127.0.0.1:1/stream",
  } as unknown as Api;
}

function newHome(state?: { pairing?: string; git?: string }): string {
  const home = mkdtempSync(join(tmpdir(), "inzo-shell-"));
  process.env.INZO_HOME = home;
  if (state) {
    const dir = join(home, ".inzo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shell.json"), JSON.stringify({ pairing: "cowork", git: "manual", ...state }));
  }
  return home;
}

function mount(cwd: string) {
  return render(
    <App session={session} pairingId="pair_test" peerAgentId="agent_peer" cwd={cwd} api={fakeApi()} />,
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

afterEach(() => {
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("shell", () => {
  it("cycles the git mode with shift+tab", async () => {
    const home = newHome();
    const app = mount(home);
    await settle();
    expect(app.lastFrame()).toContain("git manual");

    app.stdin.write(SHIFT_TAB);
    await settle();
    expect(app.lastFrame()).toContain("git plan");

    app.stdin.write(SHIFT_TAB);
    await settle();
    expect(app.lastFrame()).toContain("git auto-sync");
    app.unmount();
  });

  it("/claim sends a claim envelope, not chat", async () => {
    const home = newHome();
    const app = mount(home);
    await settle();

    app.stdin.write("/claim src/**");
    app.stdin.write(ENTER);
    await settle();

    expect(sent).toEqual([encode({ kind: "inzo.claim", globs: ["src/**"] })]);
    app.unmount();
  });

  it("plain text goes to the thread as chat", async () => {
    const home = newHome();
    const app = mount(home);
    await settle();

    app.stdin.write("hello there");
    app.stdin.write(ENTER);
    await settle();

    expect(sent).toEqual(["hello there"]);
    app.unmount();
  });

  it("acquaintance mode has no /claim and no /sync at all", async () => {
    const home = newHome({ pairing: "acquaintance" });
    const app = mount(home);
    await settle();
    expect(app.lastFrame()).toContain("code and commands cannot cross");

    app.stdin.write("/help");
    app.stdin.write(ENTER);
    await settle();
    const help = app.lastFrame()!;
    expect(help).not.toContain("/claim");
    expect(help).not.toContain("/sync");
    expect(help).toContain("/share");
    expect(help).toContain("/ask");

    app.stdin.write("/claim src/**");
    app.stdin.write(ENTER);
    await settle();
    expect(app.lastFrame()).toContain("Unknown command /claim");
    expect(sent).toEqual([]); // nothing left the machine
    app.unmount();
  });
});
