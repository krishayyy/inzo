/**
 * Typed coordination envelopes carried inside `Message.body`.
 *
 * The relay treats a body as an opaque string and every member already sees
 * every message, so claims, presence and git refs ride the existing thread
 * rather than new tables or a protocol bump. A body that parses as JSON with a
 * string `kind` starting `inzo.` is an envelope; anything else is chat.
 */

export type Envelope =
  | { kind: "inzo.claim"; globs: string[]; note?: string }
  | { kind: "inzo.release"; globs: string[] }
  | { kind: "inzo.head"; branch: string; sha: string; files: string[] }
  | { kind: "inzo.status"; text: string }
  | { kind: "inzo.share"; label: string; value: string }
  | { kind: "inzo.ask"; question: string };

export type EnvelopeKind = Envelope["kind"];

export function encode(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

/** Returns null when the body is ordinary chat — including malformed JSON. */
export function parse(body: string): Envelope | null {
  if (!body.startsWith("{")) return null; // cheap reject; chat is the common case
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !kind.startsWith("inzo.")) return null;

  const e = value as Record<string, unknown>;
  switch (kind) {
    case "inzo.claim":
      return isGlobs(e.globs)
        ? { kind, globs: e.globs, ...(typeof e.note === "string" ? { note: e.note } : {}) }
        : null;
    case "inzo.release":
      return isGlobs(e.globs) ? { kind, globs: e.globs } : null;
    case "inzo.head":
      return typeof e.branch === "string" && typeof e.sha === "string" && isGlobs(e.files)
        ? { kind, branch: e.branch, sha: e.sha, files: e.files }
        : null;
    case "inzo.status":
      return typeof e.text === "string" ? { kind, text: e.text } : null;
    case "inzo.share":
      return typeof e.label === "string" && typeof e.value === "string"
        ? { kind, label: e.label, value: e.value }
        : null;
    case "inzo.ask":
      return typeof e.question === "string" ? { kind, question: e.question } : null;
    default:
      // An `inzo.` kind this build doesn't know: not chat, but nothing we can
      // render either. Dropping it is safer than showing raw JSON as a message.
      return null;
  }
}

export interface MemberState {
  agentId: string;
  claims: string[];
  status: string | null;
  head: { branch: string; sha: string; files: string[] } | null;
  lastSeen: string;
}

export interface FoldInput {
  fromAgentId: string;
  body: string;
  createdAt: string;
}

/**
 * Presence is derived, never stored: replaying the thread reconstructs it, so
 * catching up costs nothing and there is no state to get out of sync.
 */
export function foldPresence(messages: readonly FoldInput[]): Map<string, MemberState> {
  const members = new Map<string, MemberState>();
  const stateOf = (agentId: string, at: string): MemberState => {
    let state = members.get(agentId);
    if (!state) {
      state = { agentId, claims: [], status: null, head: null, lastSeen: at };
      members.set(agentId, state);
    }
    state.lastSeen = at;
    return state;
  };

  for (const message of messages) {
    const envelope = parse(message.body);
    if (!envelope) continue;
    const state = stateOf(message.fromAgentId, message.createdAt);
    switch (envelope.kind) {
      case "inzo.claim":
        for (const glob of envelope.globs) {
          if (!state.claims.includes(glob)) state.claims.push(glob);
        }
        break;
      case "inzo.release":
        state.claims =
          envelope.globs.length === 0 ? [] : state.claims.filter((glob) => !envelope.globs.includes(glob));
        break;
      case "inzo.head":
        state.head = { branch: envelope.branch, sha: envelope.sha, files: envelope.files };
        break;
      case "inzo.status":
        state.status = envelope.text;
        break;
      default:
        break; // share/ask are thread content, not presence
    }
  }
  return members;
}

function isGlobs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
