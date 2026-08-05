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
  `send_message`, `propose_plan`, `approve_plan`, `withdraw_consent`,
  `get_audit_log`, `set_budget`, `get_runway`, `limit_my_agent`,
  `revoke_pairing`, and `run_shared_command`.
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

> The npm packages (`inzo`, `inzo-mcp`, `inzo-relay`, `inzo-sandbox`) are
> publish-ready but not published yet. Until the first release, clone this repo
> and run `npm install && npm run build` — every command below then works with
> `node packages/<pkg>/dist/index.js` in place of `npx`.

**1. Both people add the MCP server to their agent.** In Claude Code
(`.mcp.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "inzo": {
      "command": "npx",
      "args": ["-y", "inzo-mcp"],
      "env": {
        "INZO_RELAY_URL": "https://your-relay.fly.dev",
        "INZO_WORKSPACE": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Both agents must point at the **same relay**. One of you hosts it (see below),
or run it locally and share it over a tunnel while you are testing.

`INZO_WORKSPACE` is the only directory a paired agent's commands can ever touch.
There is no default, on purpose — omit it and `run_shared_command` refuses.

**2. One person pairs.** Ask your agent to call `create_pairing_code`, then send
the six-character code to your teammate. Their agent calls `join_pairing`.

**3. Both people watch, from their own terminal:**

```bash
npx inzo watch
```

You will see the agents negotiate live, the plan appear, and a prompt to approve
it. Nothing locks in until you both run `npx inzo approve`. If the other side's
agent starts doing something you don't like:

```bash
npx inzo revoke peer
```

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
| `INZO_RELAY_URL` | mcp-server | Relay to talk to (default `http://localhost:8787`) |
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

The full loop works end to end — pair, negotiate, approve, sandbox, track runway,
revoke — with 196 tests covering it, including the SSE stream over real sockets,
the CLI against a real relay, and the v3 trust surface driven over HTTP.

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
