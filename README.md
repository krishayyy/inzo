# Inzo

Agent-to-agent coordination, with humans in the loop.

Inzo lets two people pair their coding agents (Claude Code, Cursor, Codex — anything
that speaks MCP) so the agents can talk directly, propose a shared goal and task
split, and work in parallel — without every message getting relayed human → human →
agent → agent. Humans always see the conversation live and approve the plan before
it's locked in.

## How it works

1. **Pair.** One person generates a short pairing code from their agent session and
   sends it to a teammate. The teammate's agent joins with that code. This
   authorizes the two agents to message each other — nothing is open by default.
2. **Negotiate.** The paired agents talk to work out a shared goal and how to split
   the work. Both humans watch this happen live in their own terminal (`inzo watch`),
   pushed over SSE rather than polled.
3. **Approve.** Nothing gets locked in until both humans approve the *same version*
   of the plan. Re-proposing resets every approval, and an approval that names a
   stale version is rejected — so consent is always attached to text a human read.
4. **Work, sandboxed.** Shared commands always run in a local Docker sandbox
   (`--network none`, dropped capabilities, non-root, resource- and time-limited)
   that can see only the directory you named. There is no host-execution path.
5. **Track the runway.** Token/cost burn, elapsed work, and progress are tracked
   live and turned into a runway: what's left, how fast it's going, when it runs
   dry, and whether that lands before your deadline.

## Safety model

Coordination is the feature; the trust boundary is the product.

- **Identity is derived, never asserted.** Every call is authenticated by a signed
  credential that resolves to one `(principal, agent, pairing)`. Request bodies may
  not carry `agentId`/`fromAgentId`/`proposedBy`/`principalId` — a body that tries is
  rejected `400` rather than silently ignored. (v1 identified callers by a body
  field; anyone with a pairing code could impersonate an agent, read the private
  thread, and forge *both* approvals to lock a hostile plan.)
- **Credentials are signed, not opaque.** A credential is a compact Ed25519 JWS
  carrying its principal, capabilities, and full delegation chain. Anyone can check
  its signature, capabilities, and chain against the cacheable
  `/.well-known/inzo-jwks` — no per-request callback to us, and no pre-existing
  agreement between the two organizations. Revocation is the one live input: a
  verifier also reads the cacheable `/.well-known/inzo-revocations` feed, so a
  verifier running fully offline is stale about revocation for at most its cache
  TTL, and never longer than the one-hour ceiling on credential lifetime.
- **Proof of possession.** Each credential is bound to a holder key generated on
  your machine and never transmitted. Requests carry a signature over the method,
  path, and a hash of the body, so a stolen credential is inert and a plan cannot be
  altered in flight while keeping a valid credential attached.
- **Scoped authority, verifiably.** A credential carries capabilities —
  `messages:send`, `plan:approve`, `commands:run`, and so on — and can attenuate to a
  subset. Narrowing is one-way and re-checked by every verifier, so an agent can give
  away authority but can never grant itself authority back. Strip `plan:approve` and
  your agent *cannot* approve a plan on your behalf, however it gets prompted — and
  the peer's org can confirm that without trusting us.
- **Consent is a signature, not a database row.** Approving a plan signs a hash of
  the exact text you were shown, with a key the relay has never held. A relay that
  lies about consent produces a record that fails verification, and any third party
  can check it independently.
- **A real kill switch.** Either human can revoke either credential instantly,
  without the other side's cooperation. Revocation kills the whole subtree, fails
  every route including reads, closes open streams server-side, and withdraws any
  consent given with that credential. It is one-way.
- **Nothing is trusted from the peer.** Peer messages are untrusted input, not
  instructions. Peer-originated commands additionally require the peer's live
  credential to still carry `commands:run` *and* the current plan's consent to be
  satisfied.
- **Tamper-evident audit.** Every authorization-relevant action appends to a
  hash-chained log. Editing, reordering, or deleting a record breaks the chain and is
  detectable on export. Motivated by EU AI Act Articles 12 and 14.
- **Keys never touch argv.** The MCP server writes them to `~/.inzo/session.json`
  (`0600`); the CLI reads from there and has no `--token` flag, because argv is
  visible to every process via `ps`.

## Packages

- **`packages/relay`** — the shared backend. Pairing codes, message relay, plan
  proposals/approvals, budgets and runway, scope, revocation, and the live SSE
  stream. Express + SQLite. Runs hosted, or locally for dev.
- **`packages/mcp-server`** — the MCP server each person adds to their agent
  (Claude Code, Cursor, etc). Exposes `create_pairing_code`, `join_pairing`,
  `invite_to_pairing`, `send_message`, `propose_plan`, `approve_plan`,
  `withdraw_consent`, `get_audit_log`, `set_budget`, `get_runway`,
  `limit_my_agent`, `revoke_pairing`, and `run_shared_command`.
- **`packages/cli`** — what the human uses. `inzo watch` for the live view,
  `inzo approve` to sign off on a plan, `inzo withdraw` to take that back,
  `inzo revoke` for the kill switch, `inzo audit` for the tamper-evident log,
  plus `inzo status` and `inzo budget`.
- **`packages/sandbox`** — the Docker isolation every shared command runs inside.
- **`packages/holder`** — the client half of the trust model: holder keys,
  request proofs, and consent signatures. Shared by the MCP server and the CLI
  so there is one implementation of the signing rules rather than two that can
  drift. It has no network access, by design — nothing in it can accidentally
  transmit the private key it exists to protect.

## Quickstart

**0. Get it.** One of these, once:

```bash
npm i -g inzo-cli      # `inzo` on PATH; recommended
npx inzo-cli start     # zero-install, for a first try
```

The package is `inzo-cli` because npm's anti-squatting policy rejects the plain
name `inzo` (too close to ini/ink/intl/minio/pino). The command you *type* is
still `inzo` — only the thing you install carries the suffix, and it matches
the rest of the family: `inzo-mcp`, `inzo-holder`, `inzo-sandbox`.

**1. One person starts, from their project directory:**

```bash
inzo start
```

This prints a six-character code and puts your teammate in your repo when they
use it. It infers what you meant from where you are — a git repo with a remote
becomes a `cowork` session on it — and it writes two files and nothing else:
the session (`~/.inzo/sessions/<key>.json`, mode `0600`) and `.mcp.json` here,
merged so any other MCP server you have configured is left alone.

You can also say what you want outright:

```bash
inzo start research          # a mode: read-only sandbox, network on
inzo start owner/repo        # a repo: clone it, then start there
inzo start my-app            # a name: mkdir + git init, then start there
```

**2. Your teammate joins, from anywhere:**

```bash
inzo join <code>
```

One command puts them in the same repo, on the same branch, in the same mode.
If they are already in that repo it fetches and checks out; if not it clones;
if the session has no repo they get a scratch project. Their `.mcp.json` is
wired up the same way.

**Growing past two.** Any current member can invite more teammates into the
same pairing — a team, not just a pair:

```bash
inzo pair --invite 2   # prints 2 fresh one-shot codes, one per teammate
```

Each invitee runs `inzo join <code>`. Plans require every member's approval
to lock (unanimous, up to 8 members per pairing) — `"peer"` as a
revoke/command-origin target only makes sense for the original two; for 3+
members, name the specific agentId instead (see `members` in `get_session`).

**If `.mcp.json` isn't your agent's config format** (Codex reads
`~/.codex/config.toml`), print the block to paste:

```bash
inzo start --print-config --format toml
```

```json
{
  "mcpServers": {
    "inzo": {
      "command": "npx",
      "args": ["-y", "inzo-mcp"],
      "env": {
        "INZO_WORKSPACE": "/absolute/path/to/your/project"
      }
    }
  }
}
```

By default this talks to the hosted relay at
`https://inzo-relay-cf.krishaysuresh1.workers.dev` (Cloudflare Workers +
Durable Objects — see `packages/relay-cf`) — free to try, no setup, no
idle-sleep. Both agents must point at the **same relay**, so leave
`INZO_RELAY_URL` unset on both sides unless you're self-hosting (see below).

`INZO_WORKSPACE` is the only directory a paired agent's commands can ever touch.
There is no default, on purpose — omit it and `run_shared_command` refuses.

**3. Both people watch, from their own terminal:**

```bash
inzo watch
```

You will see the agents negotiate live, the plan appear, and a prompt to approve
it — plus a presence panel showing who is on which branch with what uncommitted,
and a line naming any file more than one of you has dirty right now. That last
one is what two people on one repo need and cannot get from git, which only ever
sees one working tree.

Nothing locks in until you both run `inzo approve`. If the other side's
agent starts doing something you don't like:

```bash
inzo revoke peer
```

**4. Work, and land it:**

```bash
inzo sync     # pull --rebase --autostash, then push. Never --force, ever.
inzo done     # sync, then open the PR from the session branch
```

Inzo never moves a file — git does. `watch` only fetches; `sync` is the only
writer. It refuses to run off the session branch, refuses to push a trunk
branch, and stops and hands you back normal git conflict resolution when a
rebase conflicts (your teammates see `CONFLICTED` next to your name).

### The workflow

`research` → `plan` → `build` is one progression, and it advances itself:

```bash
inzo start research     # agents investigate; sandbox read-only, network on
inzo mode plan          # agents negotiate the goal and the task split
   # (both humans approve)  → AUTO-ADVANCES to build; every watch shows a banner
inzo done               # sync + PR
```

No re-pairing, and no credential changes at any step — modes set local sandbox
policy and the agent's playbook, never anyone's authority. `cowork` is the
unstructured default for "just work with me". `inzo mode` is human-only and is
deliberately not an MCP tool: an agent should not be able to change the rules
it operates under.

### Quota, and what Inzo costs

```bash
inzo capacity --window 5h --used 62% --resets 15:40
inzo tokens
```

Two hours into pairing, one member's rolling window runs dry and the work
stops. `capacity` puts everyone's remaining quota in the watch panel so you see
it coming — N windows, each a used-fraction and a reset time, with no vendor
named anywhere in the schema. A provider we know nothing about reports no
windows and the feature stays quiet rather than guessing, and an estimate is
always labelled as one.

`tokens` reports what Inzo costs against what it saves. Inzo is meant to be
token-*negative*: two agents pairing is structurally wasteful — both build the
same context over the same code — and the shared context ledger is where that
waste gets recovered. When one agent reads `src/api.ts` it publishes a short
summary keyed by `path@blob-sha`; the other reads that instead of the file. The
sha keying is the whole cache story: edit the file and the key changes, so a
stale summary can never be served.

Overhead is measured exactly, savings are modelled, and `tokens` says which is
which. It reports negative when nobody uses the ledger, because a number that
cannot embarrass us is not worth printing.

### Staying current

```bash
inzo update      # install the newest version and repin .mcp.json
```

You will rarely need it. Inzo checks the registry at most once a day, caches
the answer, and shows a one-line footer when something newer exists. If you
installed globally, `inzo start` and `inzo join` update you automatically and
then ask you to re-run — those two commands are the only safe moment, because
no work is in flight at a session boundary and swapping the binary mid-session
would be worse than being a version behind.

Updating also repins `inzo-mcp` in `.mcp.json`, so **restart your agent** to
pick up the new server, and relaunch any running `inzo watch`.

The automatic path only applies to a global install. An `npx` copy is a
throwaway cache (`npx inzo-cli@latest` always fetches the newest anyway), and a
source checkout is left alone — installing there would replace a *different*
copy than the one you are running, and your next command would still be your
own build with no clue why. `inzo doctor` says which case you are in.
`INZO_NO_UPDATE_CHECK=1` turns all of it off, and nothing runs off a TTY.

### When something's wrong

```bash
inzo doctor
```

Checks Node, git, Docker, and `gh`, whether the relay answers, whether your
session file is still mode `0600` (it holds the key that signs your approvals),
whether `.mcp.json` points at the directory you are actually in, and whether its
pinned `inzo-mcp` version matches the CLI. That last one catches the update that
looks like it worked: the CLI is current, the config is valid, and your agent is
still running last month's MCP server because nothing moved the pin. Exits `1`
if anything required is broken. It only ever reads.

Relays advertise a minimum client version, so a client too old for a session is
refused at `join` with an upgrade message instead of silently disagreeing about
the protocol — and what two clients could disagree about is what a human
approved. `INZO_NO_UPDATE_CHECK=1` silences the update notice; it never runs off
a TTY, so CI is quiet by default.

`inzo pair` / `pair <code>` still work as aliases for `start` / `join`.

## Hosting the relay

The relay is a single Node process with a SQLite file. Locally:

```bash
npm run dev:relay        # http://localhost:8787
```

On Fly.io (config included):

```bash
fly launch --no-deploy --copy-config
fly volume create inzo_data --size 1
fly deploy
```

SQLite on a volume means one machine, deliberately — `fly.toml` pins it. The SSE
fan-out is in-process, so a second machine would show half the events to half the
viewers. Moving past one machine means Postgres plus an out-of-process event bus,
and that is not worth doing before there is load to justify it.

### Rotating the issuer key

```bash
node packages/relay/dist/index.js rotate-key
```

New credentials are signed with the new key immediately. The old key is retired
but stays published in the JWKS, so credentials it already signed keep verifying
until they expire — rotating does not log everyone out. Retired keys are dropped
automatically once nothing they signed can still be alive.

It is an operator command rather than an HTTP route on purpose: the most
powerful operation on the relay should not have a network surface, and shell
access to the host already implies more authority than this grants.

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `PORT` | relay | Port to listen on (default `8787`) |
| `INZO_RELAY_DB_PATH` | relay | SQLite path (default `./data/relay.db`) |
| `INZO_TRUST_PROXY` | relay | Set `true` only behind a proxy you control; otherwise clients can spoof `X-Forwarded-For` past the rate limiter |
| `INZO_LOG` | relay | Set `off` to disable structured request logging |
| `INZO_RELAY_URL` | mcp-server | Relay to talk to (default `https://inzo-relay-cf.krishaysuresh1.workers.dev`) |
| `INZO_WORKSPACE` | mcp-server | The only directory sandboxed commands may touch. No default |
| `INZO_HOME` | mcp-server, cli | Overrides `~` for the session file (used by tests) |

## Development

```bash
npm test          # build in dependency order, then run every package's suite
npm run test:only # skip the rebuild
```

`docs/PROTOCOL.md` is the authoritative contract between the packages. If an
implementation disagrees with it, the implementation is wrong — change the doc
first, then the code.

## Status

The full loop works end to end — start, join, negotiate, approve, sandbox, sync,
track runway, revoke, and land a PR — covered by tests including the SSE stream
over real sockets, the CLI against a real relay, and the v3 trust surface driven
over HTTP.

**Both relays are held to one suite.** `packages/relay` (Express + SQLite) and
`packages/relay-cf` (Workers + Durable Objects) are independent implementations
of the same protocol, and drift between them shows up as two members of one
session seeing different realities. `packages/conformance` runs the same
assertions against both. It has already earned its keep: writing it found
relay-cf omitting `agentId` from the join response, which the CLI writes
straight into its session file — on the default hosted relay, `inzo watch` was
rendering your own messages as the peer's.

**Inzo aims to be token-negative.** Two agents pairing is structurally wasteful
— both build the same context over the same code — and that waste is the budget
coordination pays from. The largest fixed cost was our own: MCP tool definitions
are re-sent on every request for the life of a session, whether or not Inzo is
used that turn. Twenty tools ran about 2,000 tokens per request. The surface is
now eight tools at under 600, with the cold path folded behind one `inzo_admin`
action and the behavioral guidance moved into tool *results*, which are billed
once. A test measures the served `tools/list` payload so it cannot grow back.

**Every package speaks v3.** The MCP server generates a holder keypair at pair
time and signs each request; the CLI signs your approval with a key that never
leaves your machine; the relay verifies both offline against its own published
keys. v2 bearer tokens are still accepted for migration — a bearer caller is
marked `assurance: "bearer"` in the audit log and cannot give consent, because a
bearer token cannot produce a non-repudiable signature.

Two consequences worth knowing:

- **`inzo approve` re-fetches and re-hashes the plan locally before signing.**
  Signing a hash supplied by the relay would let a hostile relay collect a
  signature over text you never saw.
- **A peer's command will not run until both humans have approved the current
  plan.** Capability says the peer *may* run commands; consent says they may run
  *this* work. Both are checked, live.

### v3 endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /.well-known/inzo-jwks` | none | Issuer public keys, active and recently retired — check any credential's signature without calling us |
| `GET /.well-known/inzo-revocations` | none | Signed revocation set, cacheable with an explicit `expiresAt` |
| `POST /credentials/attenuate` | v3 | Mint a narrowed child credential |
| `GET /pairings/:id/consent` | v3/v2 | Current consent record |
| `POST /pairings/:id/consent/withdraw` | v3 | Pull your approval, unilaterally |
| `POST /consent/verify` | none | Re-derive `satisfied` from signatures, without trusting us |
| `GET /pairings/:id/audit` | v3/v2 | Hash-chained log + chain validity |
| `GET /pairings/:id/digest?limit=` | v3/v2 | Bounded-size catch-up: plan, consent, runway, and just the last `limit` (≤50) messages — costs about the same whether you missed 5 messages or 500 |

Known limits, stated plainly:

- **Single relay instance.** In-process SSE fan-out and SQLite. Fine for a team
  or a hackathon; not a multi-tenant service yet.
- **Availability still requires trusting the operator.** v3 removes the relay's
  ability to *lie* about authority or consent — credentials and approvals are
  signed by keys it never holds, and the audit chain is tamper-evident. It does
  not remove the operator's ability to drop messages or stall.
- **A compromised holder key is game over for that side.** `~/.inzo/session.json`
  holds the private key that makes your consent non-repudiable. Treat it like a
  password.
- **Scope is a boundary, not a judgment.** If you grant `commands:run`, the agent
  may run anything the sandbox permits. Defending against an agent being argued
  into a bad plan is why the consent gate exists, and is not itself solved here.
- **No accounts, no billing.** Pairings are the only unit.

## License

[Apache-2.0](LICENSE). Open-core: this repo — the self-hostable core — is open
source. A hosted offering is a separate, future concern.
