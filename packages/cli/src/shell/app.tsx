import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExpiring } from "inzo-holder";
import { Box, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi, type Api, type Message, type Plan, type Runway } from "../api.js";
import { foldPresence, parse as parseEnvelope, type FoldInput, type MemberState } from "../envelope.js";
import { branchFor, collisions, Git, type GitStatus } from "../git.js";
import {
  ACQUAINTANCE_CAP,
  GIT_MODE_HINT,
  loadShellState,
  nextGitMode,
  saveShellState,
  type GitMode,
  type Pairing,
  type ShellState,
} from "../modes.js";
import { formatPlan, formatRunway, shortAgent } from "../render.js";
import type { SessionFile } from "../session.js";
import { findCommand, mergePeers, planFileText, syncOnce, type ShellCtx } from "./commands.js";
import { useStream } from "./useStream.js";

const SCROLLBACK = 200;
const VISIBLE_LINES = 14;
const SYNC_INTERVAL_MS = 15_000;

export interface AppProps {
  session: SessionFile;
  pairingId: string;
  peerAgentId: string;
  cwd?: string;
  /** Injectable for tests; production builds one from the session. */
  api?: Api;
}

interface Entry {
  id: number;
  text: string;
  tone: "chat" | "self" | "system" | "alert";
}

export function App({ session, pairingId, peerAgentId, cwd = process.cwd(), api: injected }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const agentId = session.agentId;

  const baseApi = useMemo(() => injected ?? createApi(session), [injected, session]);
  const [api, setApi] = useState<Api>(baseApi);
  const [childCredential, setChildCredential] = useState<string | null>(null);
  const [state, setState] = useState<ShellState>(() => loadShellState());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [runway, setRunway] = useState<Runway | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const git = useMemo(() => new Git(cwd), [cwd]);
  const nextId = useRef(0);
  // Every envelope ever seen, so presence is a pure fold over the thread.
  const folded = useRef<FoldInput[]>([]);
  const [presence, setPresence] = useState<Map<string, MemberState>>(new Map());

  const handles = useMemo(
    () => ({ [agentId]: "you", [peerAgentId]: shortAgent(peerAgentId).replace(/^agent_/, "") }),
    [agentId, peerAgentId],
  );

  const push = useCallback((text: string, tone: Entry["tone"] = "system") => {
    setEntries((current) => [...current, { id: nextId.current++, text, tone }].slice(-SCROLLBACK));
  }, []);

  const print = useCallback((text: string) => push(text, "system"), [push]);

  // ---- live thread --------------------------------------------------------

  const handlers = useRef({
    onMessage: (message: Message) => {
      folded.current.push({ fromAgentId: message.fromAgentId, body: message.body, createdAt: message.createdAt });
      setPresence(foldPresence(folded.current));
      const mine = message.fromAgentId === agentId;
      push(describe(message, mine ? "you" : shortAgent(message.fromAgentId)), mine ? "self" : "chat");
    },
    onPlan: (next: Plan | null) => setPlan(next),
    onRunway: (next: Runway) => setRunway(next),
    onRevoked: (revocation: { revokedAgentId: string; by: string }) => {
      const who = revocation.revokedAgentId === agentId ? "YOUR agent" : "the peer's agent";
      push(`!! ${who} was revoked. The pairing is over.`, "alert");
    },
    onNote: (text: string) => push(text, "system"),
  }).current;

  const { connected } = useStream(api, pairingId, handlers);

  // PLAN.md is a view of the relay plan, re-rendered whenever the plan moves.
  useEffect(() => {
    if (!plan || state.pairing !== "cowork") return;
    try {
      writeFileSync(join(cwd, "PLAN.md"), planFileText(plan, handles));
    } catch (err) {
      push(`Could not write PLAN.md: ${(err as Error).message}`, "alert");
    }
  }, [plan, state.pairing, cwd, handles, push]);

  // ---- ctx shared with the command registry -------------------------------

  const ctxRef = useRef<ShellCtx>(null as unknown as ShellCtx);
  const setPairingMode = useCallback(
    async (next: Pairing) => {
      if (next === state.pairing) return;
      if (next === "cowork") {
        setChildCredential(null);
        setApi(baseApi);
        setState((current) => persist({ ...current, pairing: "cowork" }));
        push("cowork mode: full trust, same repo. /claim, /sync and git are back.");
        return;
      }
      const issued = await baseApi.attenuate(ACQUAINTANCE_CAP);
      setChildCredential(issued.credential);
      setApi(createApi({ ...session, credential: issued.credential }));
      setState((current) => persist({ ...current, pairing: "acquaintance" }));
      push(`acquaintance mode: running under a child credential holding only ${issued.cap.join(", ")}.`);
      push("Your agent cannot run peer commands or sign on your behalf while this holds.");
    },
    [state.pairing, baseApi, session, push],
  );

  ctxRef.current = {
    api,
    pairingId,
    agentId,
    session,
    state,
    git,
    cwd,
    plan,
    runway,
    presence,
    handles,
    print,
    setGitMode: (mode: GitMode) => setState((current) => persist({ ...current, git: mode })),
    setPairingMode,
    readPlanFile: () => readFileSync(join(cwd, "PLAN.md"), "utf8"),
    writePlanFile: (text: string) => writeFileSync(join(cwd, "PLAN.md"), text),
    quit: exit,
  };

  // ---- git status + the auto loop ----------------------------------------

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const status = await git.status();
      if (stopped) return;
      setGitStatus(status);
      if (status.repo && (ctxRef.current.state.git === "auto-sync" || ctxRef.current.state.git === "auto")) {
        for (const line of await syncOnce(ctxRef.current, false)) print(line);
        if (ctxRef.current.state.git === "auto") {
          for (const line of await mergePeers(ctxRef.current)) print(line);
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SYNC_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [git, print]);

  // Credentials cap at an hour, so an acquaintance session renews its child
  // before expiry — the same pattern the MCP server uses on its own credential.
  useEffect(() => {
    if (!childCredential) return;
    const timer = setInterval(() => {
      if (!isExpiring(childCredential, 300)) return;
      void baseApi
        .attenuate(ACQUAINTANCE_CAP)
        .then((issued) => {
          setChildCredential(issued.credential);
          setApi(createApi({ ...session, credential: issued.credential }));
        })
        .catch((err: Error) => push(`Could not renew the attenuated credential: ${err.message}`, "alert"));
    }, 60_000);
    return () => clearInterval(timer);
  }, [childCredential, baseApi, session, push]);

  // ---- input --------------------------------------------------------------

  const submit = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      setHistory((current) => [...current, trimmed]);
      setHistoryAt(null);

      if (!trimmed.startsWith("/")) {
        push(trimmed, "self");
        await ctxRef.current.api.sendMessage(pairingId, trimmed);
        return;
      }

      const [name, ...args] = trimmed.slice(1).split(/\s+/);
      const command = findCommand(name, ctxRef.current.state.pairing);
      if (!command) {
        push(`Unknown command /${name} in ${ctxRef.current.state.pairing} mode. /help lists what is available.`, "alert");
        return;
      }
      await command.run(ctxRef.current, args);
    },
    [pairingId, push],
  );

  // The prompt lives in a ref as well as state: a key chunk must be applied to
  // the line as it is *now*, not as the last render saw it.
  const inputRef = useRef("");
  const setLine = useCallback((next: string) => {
    inputRef.current = next;
    setInput(next);
  }, []);

  // Commands run one at a time, in the order they were typed.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const run = useCallback(
    (line: string) => {
      setLine("");
      setBusy(true);
      queue.current = queue.current
        .then(() => submit(line))
        .catch((err: Error) => push(err.message, "alert"))
        .finally(() => setBusy(false));
    },
    [submit, push, setLine],
  );

  useInput((value, key) => {
    if (key.tab && key.shift) {
      const mode = nextGitMode(state.git);
      setState((current) => persist({ ...current, git: mode }));
      push(`git mode: ${mode} — ${GIT_MODE_HINT[mode]}`);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (history.length === 0) return;
      const at = key.upArrow
        ? Math.max(0, (historyAt ?? history.length) - 1)
        : Math.min(history.length, (historyAt ?? history.length) + 1);
      setHistoryAt(at);
      setLine(history[at] ?? "");
      return;
    }
    if (key.backspace || key.delete) {
      setLine(inputRef.current.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.tab) return;

    // A chunk can carry several characters and their newline together — a paste,
    // or just fast typing — so split on newlines and run each complete line.
    const chunk = key.return && !/[\r\n]/.test(value) ? `${value}\n` : value;
    if (!chunk) return;
    const parts = chunk.split(/\r\n|[\r\n]/);
    let pending = inputRef.current;
    for (const part of parts.slice(0, -1)) {
      run(pending + part);
      pending = "";
    }
    setLine(pending + parts[parts.length - 1]);
  });

  // ---- render -------------------------------------------------------------

  const mine = presence.get(agentId)?.claims ?? [];
  const peerClaims = [...presence.values()].filter((m) => m.agentId !== agentId).flatMap((m) => m.claims);
  const clash = gitStatus ? collisions(gitStatus.dirty, peerClaims) : [];

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" minHeight={VISIBLE_LINES}>
        {entries.slice(-VISIBLE_LINES).map((entry) => (
          <Text key={entry.id} color={toneColor(entry.tone)} dimColor={entry.tone === "system"}>
            {entry.text}
          </Text>
        ))}
      </Box>

      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <Text>{formatPlan(plan, agentId, peerAgentId)}</Text>
        {[...presence.values()].map((member) => (
          <Text key={member.agentId} dimColor>
            {member.agentId === agentId ? "you " : "peer"} {member.claims.join(" ") || "(no claims)"}
            {member.head ? `  ${member.head.branch}@${member.head.sha.slice(0, 7)}` : ""}
            {member.status ? `  — ${member.status}` : ""}
          </Text>
        ))}
        {runway ? <Text dimColor>{formatRunway(runway)}</Text> : null}
        {clash.length > 0 ? (
          <Text color="red">! you have edits inside a peer&apos;s claim: {clash.join(", ")}</Text>
        ) : null}
      </Box>

      <Text dimColor>
        {state.pairing}
        {state.pairing === "cowork" ? ` · git ${state.git}` : " · code and commands cannot cross"}
        {gitStatus?.repo ? ` · ${branchFor(agentId)} ↓${gitStatus.behind} ↑${gitStatus.ahead} ${gitStatus.dirty.length === 0 ? "clean" : `${gitStatus.dirty.length} dirty`}` : ""}
        {mine.length > 0 ? ` · holding ${mine.length}` : ""}
        {connected ? "" : " · reconnecting"}
        {" · shift+tab git mode · /help"}
      </Text>

      <Box>
        <Text color="cyan">{busy ? "… " : "> "}</Text>
        <Text>{input}</Text>
      </Box>
    </Box>
  );
}

function persist(state: ShellState): ShellState {
  try {
    saveShellState(state);
  } catch {
    // A read-only home should not stop the shell; the mode just won't survive a restart.
  }
  return state;
}

function toneColor(tone: Entry["tone"]): string | undefined {
  return tone === "alert" ? "red" : tone === "self" ? "cyan" : tone === "chat" ? "yellow" : undefined;
}

/** Envelopes are protocol, not prose — render them as the events they are. */
export function describe(message: Message, who: string): string {
  const envelope = parseEnvelope(message.body);
  if (!envelope) return `${who}: ${message.body}`;
  switch (envelope.kind) {
    case "inzo.claim":
      return `${who} claimed ${envelope.globs.join(" ")}${envelope.note ? ` (${envelope.note})` : ""}`;
    case "inzo.release":
      return `${who} released ${envelope.globs.join(" ") || "everything"}`;
    case "inzo.head":
      return `${who} pushed ${envelope.sha.slice(0, 7)} to ${envelope.branch} — ${envelope.files.join(", ")}`;
    case "inzo.status":
      return `${who} — ${envelope.text}`;
    case "inzo.share":
      return `${who} shared ${envelope.label}: ${envelope.value}`;
    case "inzo.ask":
      return `${who} asks: ${envelope.question}`;
  }
}
