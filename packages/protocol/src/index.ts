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
