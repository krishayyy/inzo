/**
 * Shared wire-protocol types and validators — see `docs/PROTOCOL.md`.
 *
 * This package exists for one reason: `packages/relay` and `packages/relay-cf`
 * are independent implementations of the same protocol, and a rule that lives
 * in both can drift. For most of the surface that drift is a bug the
 * conformance suite catches. For the session descriptor's repo URL it would be
 * a *security* divergence — one relay accepting a `git clone` URL the other
 * rejects — so that rule is written once, here, and imported by both.
 *
 * Constraints on anything added to this file: zero dependencies, no Node
 * builtins, no I/O. The Cloudflare Worker relay bundles this, and it must stay
 * bundleable.
 */

// ---------------------------------------------------------------------------
// Session descriptor
// ---------------------------------------------------------------------------

/**
 * `research` -> `plan` -> `build` is one progression a team moves through;
 * `cowork` is the unstructured default. A mode sets local sandbox policy and
 * agent playbook only — it never changes a credential's scope, because scope
 * narrows one-way and binding it to mode would put friction on every step of
 * the normal workflow.
 */
export const SESSION_MODES = ["cowork", "plan", "build", "research"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const DEFAULT_SESSION_MODE: SessionMode = "cowork";

export interface SessionRepo {
  /** Clone URL, or null for a repo with no remote (peers get a scratch dir). */
  url: string | null;
  /** The shared session branch, e.g. `inzo/7fk2q9`. */
  branch: string;
  /** Directory name a joiner clones into. Always a bare basename. */
  name: string;
}

export interface SessionDescriptor {
  mode: SessionMode;
  repo: SessionRepo | null;
}

export const MAX_REPO_URL_LENGTH = 512;
export const MAX_BRANCH_LENGTH = 200;
export const MAX_REPO_NAME_LENGTH = 100;

/** Thrown for any malformed descriptor. Relays map this to HTTP 400. */
export class InvalidSessionDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionDescriptorError";
  }
}

function fail(message: string): never {
  throw new InvalidSessionDescriptorError(message);
}

/** Control characters, including the newlines that could split a git config. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * `user@host:path` — git's scp-like shorthand. Deliberately strict: no
 * whitespace, no leading dash, and a host that looks like a host.
 */
const SSH_SHORTHAND = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;

/**
 * Validates a clone URL before it can ever reach `git clone`.
 *
 * This is the highest-consequence function in the package. The URL arrives
 * from the relay, and the relay is explicitly not trusted (PROTOCOL.md: it is
 * "a transport and witness", not a source of truth). A crafted descriptor
 * otherwise gets code execution on every joiner:
 *
 *   - `ext::sh -c '…'`     git's ext transport runs a shell command
 *   - a leading `-`        argument injection (`--upload-pack=…`)
 *   - `file:///…`          clones local disk, hardlinks it with --local
 *
 * So this is an allowlist, not a denylist: only https and ssh get through, and
 * everything unrecognized is refused. The client additionally passes
 * `-c protocol.ext.allow=never -c protocol.file.allow=never` and `--`, so a
 * hole here still has to get past those.
 */
export function validateRepoUrl(url: unknown): string {
  if (typeof url !== "string") fail("repo.url must be a string or null");
  if (url.length === 0) fail("repo.url must not be empty");
  if (url.length > MAX_REPO_URL_LENGTH) {
    fail(`repo.url must be at most ${MAX_REPO_URL_LENGTH} characters`);
  }
  if (CONTROL_CHARS.test(url)) fail("repo.url must not contain control characters");
  if (/\s/.test(url)) fail("repo.url must not contain whitespace");
  // Checked before scheme matching: a URL starting with `-` is read by git as
  // an option no matter what follows it.
  if (url.startsWith("-")) fail("repo.url must not start with '-'");

  if (url.startsWith("https://")) {
    const host = url.slice("https://".length);
    if (host.length === 0 || host.startsWith("/")) fail("repo.url is missing a host");
    return url;
  }

  if (url.startsWith("ssh://")) {
    const rest = url.slice("ssh://".length);
    if (rest.length === 0 || rest.startsWith("/")) fail("repo.url is missing a host");
    return url;
  }

  if (SSH_SHORTHAND.test(url)) return url;

  fail(
    "repo.url must be an https:// or ssh:// URL, or git's user@host:path form. " +
      "Other transports (ext::, file://, git://) are refused.",
  );
}

/**
 * Git branch names, narrowed well inside `git check-ref-format`.
 *
 * Rejecting `..` and a leading `-` matters for the same reason the URL rules
 * do: the branch reaches `git checkout` as an argument.
 */
export function validateBranch(branch: unknown): string {
  if (typeof branch !== "string") fail("repo.branch must be a string");
  if (branch.length === 0) fail("repo.branch must not be empty");
  if (branch.length > MAX_BRANCH_LENGTH) {
    fail(`repo.branch must be at most ${MAX_BRANCH_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    fail("repo.branch may only contain letters, digits, '.', '_', '/', and '-'");
  }
  if (branch.startsWith("-")) fail("repo.branch must not start with '-'");
  if (branch.includes("..")) fail("repo.branch must not contain '..'");
  if (branch.startsWith("/") || branch.endsWith("/")) fail("repo.branch must not start or end with '/'");
  if (branch.includes("//")) fail("repo.branch must not contain '//'");
  if (branch.endsWith(".lock")) fail("repo.branch must not end with '.lock'");
  return branch;
}

/**
 * The directory a joiner clones into. A bare basename, so a crafted name
 * cannot escape the directory the human ran `inzo join` in.
 */
export function validateRepoName(name: unknown): string {
  if (typeof name !== "string") fail("repo.name must be a string");
  if (name.length === 0) fail("repo.name must not be empty");
  if (name.length > MAX_REPO_NAME_LENGTH) {
    fail(`repo.name must be at most ${MAX_REPO_NAME_LENGTH} characters`);
  }
  if (name === "." || name === "..") fail("repo.name must not be '.' or '..'");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    fail("repo.name may only contain letters, digits, '.', '_', and '-'");
  }
  if (name.startsWith("-")) fail("repo.name must not start with '-'");
  return name;
}

export function validateMode(mode: unknown): SessionMode {
  if (typeof mode !== "string" || !(SESSION_MODES as readonly string[]).includes(mode)) {
    fail(`mode must be one of: ${SESSION_MODES.join(", ")}`);
  }
  return mode as SessionMode;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a whole descriptor, returning a normalized copy.
 *
 * Returns a fresh object rather than the input so a caller cannot smuggle
 * extra keys through into storage.
 */
export function validateSessionDescriptor(input: unknown): SessionDescriptor {
  if (!isPlainObject(input)) fail("session must be an object");

  const mode = validateMode(input.mode);

  if (input.repo === undefined || input.repo === null) {
    return { mode, repo: null };
  }
  if (!isPlainObject(input.repo)) fail("session.repo must be an object or null");

  const url = input.repo.url === undefined || input.repo.url === null ? null : validateRepoUrl(input.repo.url);

  return {
    mode,
    repo: {
      url,
      branch: validateBranch(input.repo.branch),
      name: validateRepoName(input.repo.name),
    },
  };
}

/** Parses a descriptor from storage. Returns null rather than throwing. */
export function parseSessionDescriptor(raw: string | null | undefined): SessionDescriptor | null {
  if (!raw) return null;
  try {
    return validateSessionDescriptor(JSON.parse(raw));
  } catch {
    // A descriptor written by an older or broken build should degrade to
    // "no session settings", never take down the pairing that owns it.
    return null;
  }
}

export function serializeSessionDescriptor(descriptor: SessionDescriptor): string {
  return JSON.stringify(descriptor);
}

// ---------------------------------------------------------------------------
// Mode policy
// ---------------------------------------------------------------------------

/**
 * What a mode actually sets. Three layers of very different strength, and the
 * table is worth reading as such:
 *
 *   - consent (is the plan locked?) is **hard** — server-verified on every
 *     route, and it gates peer-originated commands by itself. A mode never
 *     loosens it.
 *   - `readonly` / `network` are **hard** — Docker enforces both.
 *   - `enforceItemOwnership` and the playbook are **advisory**, agent-side.
 *
 * Modes never change credential scope. Scope narrows one-way and is a separate,
 * human-controlled axis; binding it to mode would put friction on every step of
 * the research -> plan -> build progression, which is monotonically widening.
 */
export interface ModePolicy {
  /** Sandbox mount is read-only. `research` reads code; it does not change it. */
  readonly: boolean;
  /** Network inside the sandbox. On only for research, which needs to look things up. */
  network: boolean;
  /** Whether a command may only act on plan items the caller owns. */
  enforceItemOwnership: boolean;
}

export const MODE_POLICY: Record<SessionMode, ModePolicy> = {
  research: { readonly: true, network: true, enforceItemOwnership: false },
  plan: { readonly: true, network: false, enforceItemOwnership: false },
  build: { readonly: false, network: false, enforceItemOwnership: true },
  cowork: { readonly: false, network: false, enforceItemOwnership: false },
};

/**
 * The mode a session moves to when the plan locks, or null to stay put.
 *
 * Unanimous consent on a task split *is* the start of building, so making the
 * human also type `inzo mode build` is ceremony. Only the two pre-build modes
 * advance: `cowork` is a deliberate choice to work unstructured, and moving it
 * to `build` would start enforcing an item ownership nobody asked for.
 */
export function modeOnPlanLock(current: SessionMode): SessionMode | null {
  return current === "research" || current === "plan" ? "build" : null;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * A liveness hint: what one member's working tree looks like right now.
 *
 * Ephemeral by design, and the design is deliberate on three counts:
 *
 *   - It is never persisted. A `Map` in the Express process, DO instance
 *     memory in `PairingRoom`. Durable Object storage writes are billed and
 *     add latency, and 90 seconds of liveness does not deserve either.
 *   - It never enters the hash-chained audit log. Putting a heartbeat in a
 *     tamper-evident record devalues the record.
 *   - It is change-triggered, not periodic. A 30-second beat retrofitted
 *     later would mean launching on the expensive version (§10).
 *
 * Nothing is enforced against it — it exists so two people editing one repo
 * can see the overlap git cannot show them.
 */
/**
 * One rate-limit window a member is working inside.
 *
 * **No vendor appears in this schema, deliberately.** N windows, each a
 * used-fraction and a reset time, is what makes this model-agnostic rather
 * than Claude-shaped with adapters bolted on: Claude is a 5h rolling window
 * plus a weekly one, an OpenAI-style account is RPM/TPM plus monthly spend, a
 * local model has none. A provider nobody has taught us about reports no
 * windows and the feature goes quiet rather than guessing.
 */
export interface CapacityWindow {
  /** Free-form, shown verbatim: "5h", "weekly", "monthly spend". */
  label: string;
  /** 0..1 of the window consumed. */
  used: number;
  /** ISO timestamp, or null when the reset time genuinely isn't known. */
  resetsAt: string | null;
  /**
   * True when this is derived from self-reported token counts rather than
   * stated by the provider. Always rendered as an estimate, never as fact —
   * the window is per *account*, so a member also working solo is undercounted.
   */
  estimated: boolean;
}

export interface Capacity {
  /** Whatever the member calls their provider. Never interpreted, only shown. */
  provider: string;
  windows: CapacityWindow[];
}

export const MAX_CAPACITY_WINDOWS = 8;
export const MAX_LABEL_LENGTH = 40;

export interface Presence {
  branch: string;
  /** Short commit sha of the member's HEAD. */
  head: string;
  /** Paths dirty in their working tree, relative to the repo root. */
  dirty: string[];
  ahead: number;
  behind: number;
  /** True while a rebase is stopped on a conflict — see `inzo sync`. */
  conflicted: boolean;
  /**
   * How much of this member's AI quota is left (§8).
   *
   * It rides on presence rather than getting an endpoint because it is
   * exactly what presence already is: a fast-changing, ephemeral, per-member
   * liveness hint. Zero new protocol surface, zero storage, zero extra
   * requests. The separation that matters: budget is *intent* — persisted,
   * approved, auditable — and capacity is *current reality*, advisory and
   * gone in 90 seconds.
   */
  capacity?: Capacity | null;
}

/** How long a presence entry stays live without a refresh. */
export const PRESENCE_TTL_MS = 90_000;

export const MAX_DIRTY_PATHS = 100;
export const MAX_PATH_LENGTH = 400;

/**
 * Validates a presence payload.
 *
 * The caps matter more than they look: presence is unauthenticated in the
 * sense that any member can post any content, it fans out to every other
 * member's terminal, and it is held in memory. An uncapped `dirty` array is
 * both a memory cost and a way to flood a teammate's screen.
 */
export function validatePresence(input: unknown): Presence {
  if (!isPlainObject(input)) fail("presence must be an object");

  const branch = validateBranch(input.branch);

  if (typeof input.head !== "string" || !/^[0-9a-f]{4,40}$/.test(input.head)) {
    fail("presence.head must be a hex commit sha");
  }

  if (!Array.isArray(input.dirty)) fail("presence.dirty must be an array");
  if (input.dirty.length > MAX_DIRTY_PATHS) {
    fail(`presence.dirty must hold at most ${MAX_DIRTY_PATHS} paths`);
  }
  const dirty = input.dirty.map((path) => {
    if (typeof path !== "string" || path.length === 0) fail("presence.dirty entries must be non-empty strings");
    if (path.length > MAX_PATH_LENGTH) fail(`presence.dirty entries must be at most ${MAX_PATH_LENGTH} characters`);
    if (CONTROL_CHARS.test(path)) fail("presence.dirty entries must not contain control characters");
    return path;
  });

  return {
    branch,
    head: input.head,
    dirty,
    ahead: count(input.ahead, "presence.ahead"),
    behind: count(input.behind, "presence.behind"),
    conflicted: input.conflicted === true,
    capacity: validateCapacity(input.capacity),
  };
}

/** Absent and null both mean "this member reports no capacity", not zero. */
export function validateCapacity(input: unknown): Capacity | null {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) fail("presence.capacity must be an object or null");

  const provider = input.provider;
  if (typeof provider !== "string" || provider.length === 0) fail("capacity.provider must be a non-empty string");
  if (provider.length > MAX_LABEL_LENGTH) fail(`capacity.provider must be at most ${MAX_LABEL_LENGTH} characters`);
  if (CONTROL_CHARS.test(provider)) fail("capacity.provider must not contain control characters");

  if (!Array.isArray(input.windows)) fail("capacity.windows must be an array");
  if (input.windows.length > MAX_CAPACITY_WINDOWS) {
    fail(`capacity.windows must hold at most ${MAX_CAPACITY_WINDOWS} windows`);
  }

  const windows = input.windows.map((window): CapacityWindow => {
    if (!isPlainObject(window)) fail("capacity.windows entries must be objects");
    const label = window.label;
    if (typeof label !== "string" || label.length === 0) fail("capacity window label must be a non-empty string");
    if (label.length > MAX_LABEL_LENGTH) fail(`capacity window label must be at most ${MAX_LABEL_LENGTH} characters`);
    if (CONTROL_CHARS.test(label)) fail("capacity window label must not contain control characters");

    const used = window.used;
    // Not clamped: a used-fraction outside 0..1 means the sender is computing
    // it wrong, and quietly clamping would hide that from both humans.
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) {
      fail("capacity window used must be a number between 0 and 1");
    }

    let resetsAt: string | null = null;
    if (window.resetsAt !== undefined && window.resetsAt !== null) {
      if (typeof window.resetsAt !== "string" || Number.isNaN(Date.parse(window.resetsAt))) {
        fail("capacity window resetsAt must be an ISO timestamp or null");
      }
      resetsAt = window.resetsAt;
    }

    return { label, used, resetsAt, estimated: window.estimated !== false };
  });

  return { provider, windows };
}

/**
 * The window closest to running out, or null when nothing is reported.
 *
 * Used to decide what to warn about: with several windows the binding one is
 * whichever is fullest, not whichever is listed first.
 */
export function tightestWindow(capacity: Capacity | null | undefined): CapacityWindow | null {
  if (!capacity || capacity.windows.length === 0) return null;
  return capacity.windows.reduce((worst, window) => (window.used > worst.used ? window : worst));
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Files more than one member has uncommitted right now.
 *
 * A set intersection over the dirty lists, and the highest-value line in the
 * watch panel: it is exactly what two people on one repo need to know and
 * cannot get from git, which sees only one working tree.
 */
export function overlappingPaths(entries: Array<{ dirty: string[] }>): string[] {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    for (const path of new Set(entry.dirty)) {
      seen.set(path, (seen.get(path) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
}

// ---------------------------------------------------------------------------
// Shared context ledger (T-7)
// ---------------------------------------------------------------------------

/**
 * One agent's understanding of one file, shared with the others.
 *
 * This is the primitive that exists *because* two agents are coordinating,
 * and it is where the waste that pairing creates gets recovered. Two agents on
 * one repo otherwise each burn ~4,000 tokens reading `src/api.ts` to reach the
 * same understanding. Here the first one to read it publishes ~200 tokens of
 * summary and the second reads that instead.
 *
 * **Keyed by `path@blob-sha`, and that is the whole cache-coherence story.**
 * A summary is bound to the exact bytes it describes, so the moment the file
 * changes the key changes and the stale entry simply stops matching. There is
 * no invalidation to get wrong, no TTL to tune, and no way to serve a summary
 * of code that no longer exists.
 */
export interface ContextEntry {
  /** Repo-relative path, for humans and for lookup. */
  path: string;
  /** `git hash-object` of the exact content summarized. */
  sha: string;
  summary: string;
  /** Which member wrote it — a summary is one agent's reading, not a fact. */
  agentId: string;
  at: string;
}

/** Hard caps. An unbounded ledger is a memory leak with a helpful name. */
export const MAX_LEDGER_ENTRIES = 500;
export const MAX_LEDGER_BYTES = 256 * 1024;
export const MAX_SUMMARY_LENGTH = 4000;

export interface ContextInput {
  path: string;
  sha: string;
  summary: string;
}

export function validateContextInput(input: unknown): ContextInput {
  if (!isPlainObject(input)) fail("context must be an object");

  const path = input.path;
  if (typeof path !== "string" || path.length === 0) fail("context.path must be a non-empty string");
  if (path.length > MAX_PATH_LENGTH) fail(`context.path must be at most ${MAX_PATH_LENGTH} characters`);
  if (CONTROL_CHARS.test(path)) fail("context.path must not contain control characters");
  // A ledger path is a label, never opened by anyone — but it is echoed back
  // to other agents, and an absolute or traversing path invites one of them
  // to treat it as a filesystem instruction.
  if (path.startsWith("/") || path.includes("..")) fail("context.path must be repo-relative and must not contain '..'");

  const sha = input.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) fail("context.sha must be a hex object id");

  const summary = input.summary;
  if (typeof summary !== "string" || summary.length === 0) fail("context.summary must be a non-empty string");
  if (summary.length > MAX_SUMMARY_LENGTH) {
    fail(`context.summary must be at most ${MAX_SUMMARY_LENGTH} characters — summarize, do not paste the file`);
  }

  return { path, sha, summary };
}

/**
 * What the ledger has actually done, for `inzo tokens`.
 *
 * `hits` and `misses` are counted rather than inferred because the whole point
 * of `inzo tokens` is to make the token-negative claim falsifiable, and a
 * "saving" derived from entries *written* would be measuring the wrong thing —
 * a summary nobody reads saves nothing.
 */
export interface LedgerStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
}

/** The ledger key. Two files with the same content share one entry, correctly. */
export function contextKey(path: string, sha: string): string {
  return `${path}@${sha}`;
}
