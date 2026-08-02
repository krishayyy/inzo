# Inzo wire protocol (v2)

This is the **authoritative contract** between `packages/relay` (server),
`packages/mcp-server` (agent-side client), and `packages/cli` (human-side
live viewer). If an implementation disagrees with this document, the
implementation is wrong. Change this file first, then the code.

## Why v2 exists

v1 identified callers by a `fromAgentId` / `agentId` / `proposedBy` field in
the **request body**. That is self-asserted and was trivially forgeable. A
demonstrated attack against v1, knowing only a `pairingId`:

- post messages impersonating a paired agent (a prompt-injection channel
  straight into a teammate's coding agent),
- read the entire private thread,
- forge **both** humans' plan approvals, driving a hostile plan to
  `locked: true` with zero human involvement.

That last one defeats the product's core safety property. v2 fixes it by
deriving identity from a bearer token on the server, never from the body.

## Identity model

- Every participant holds an **agent token**: an opaque secret, 32 random
  bytes, base64url-encoded, issued once and never retrievable again.
- The relay stores only a SHA-256 hash of each token, never the token.
- A token resolves server-side to exactly one `(pairingId, agentId)` pair.
- **Every** endpoint below except `POST /pairings`, `POST /pairings/:code/join`,
  and `GET /health` requires `Authorization: Bearer <agentToken>`.
- Request bodies **must not** carry `fromAgentId`, `agentId`, or `proposedBy`.
  The server derives all three from the token. A body that includes them is
  rejected with `400 identity_not_allowed` — failing loudly beats silently
  ignoring a field a caller believes is authoritative.
- Token compromise is equivalent to full control of that side of the pairing.
  Treat it like a password: it is written to `~/.inzo/session.json` with mode
  `0600` and must never be logged or echoed in a tool result.

### Errors

| Condition | Status | `error.code` |
|---|---|---|
| Missing/malformed `Authorization` header | 401 | `unauthenticated` |
| Token not recognized | 401 | `unauthenticated` |
| Valid token, but wrong pairing in the URL | 403 | `forbidden` |
| Identity field present in body | 400 | `identity_not_allowed` |
| Too many failed code-join attempts | 429 | `rate_limited` |

Error envelope is unchanged from v1: `{ "error": { "code": "...", "message": "..." } }`.

## Pairing codes

Codes are `INZO-` + **6** chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
(Crockford-ish: no `I`/`O`/`0`/`1`, which people mistype when reading a code
aloud at a table). 32^6 ≈ 1.07e9, versus v1's 4 chars over a 36-char alphabet
(~1.7e6) which was brute-forceable.

Additionally the relay **rate-limits join attempts**: 10 failed attempts from
one IP in 10 minutes ⇒ `429 rate_limited`. Codes still expire 15 minutes after
creation and are single-use.

---

# Endpoints

## `POST /pairings`

Unauthenticated. Creates a pairing code and issues the creator's token.

Request: `{}` (no body fields; the creator's identity is *created* here)

Response `201`:
```json
{
  "code": "INZO-K7M4QX",
  "expiresAt": "2026-08-02T00:15:00.000Z",
  "agentId": "agent_9f2a...",
  "agentToken": "3sD9...",
  "pairingId": null
}
```
`agentToken` is shown exactly once. `pairingId` is `null` until someone joins.

## `POST /pairings/:code/join`

Unauthenticated. Consumes the code, creates the pairing, issues the joiner's token.

Request: `{}`

Response `201`:
```json
{
  "pairingId": "pairing_...",
  "agentId": "agent_1b8c...",
  "agentToken": "Qz4m...",
  "peerAgentId": "agent_9f2a..."
}
```

Errors: `404 not_found` unknown code, `409 conflict` already used,
`410 gone` expired, `429 rate_limited`.

## `GET /pairings/mine`

**Authenticated.** Replaces v1's `GET /pairings/by-code/:code`, which let
anyone holding a code read pairing metadata. The creator polls this after
sharing their code to learn when someone joined.

Response `200`:
```json
{
  "pairing": {
    "id": "pairing_...",
    "agentId": "agent_9f2a...",
    "peerAgentId": "agent_1b8c...",
    "createdAt": "...",
    "budget": { "deadline": "...", "tokenBudget": 500000, "costBudgetUsd": 20 }
  }
}
```
`pairing` is `null` (with `200`, not `404`) while the code is still unjoined —
"nobody has joined yet" is an expected polling state, not an error.
`budget` is `null` if unset.

## `POST /pairings/:id/messages`

**Authenticated.** Sender is the token holder.

Request: `{ "body": "..." }`

Response `201`: `{ "message": { "id", "pairingId", "fromAgentId", "body", "createdAt", "cursor" } }`

`cursor` is a monotonically increasing integer, distinct from `createdAt`
(two messages can share a millisecond, never a cursor).

## `GET /pairings/:id/messages?since=<cursor>`

**Authenticated.** Returns `{ "messages": [...], "cursor": <int> }`, oldest
first, strictly newer than `since` when provided.

## `GET /pairings/:id/stream`

**Authenticated.** Server-Sent Events (`text/content-type: text/event-stream`).
This is what makes "both humans watch it happen live" real, replacing polling.

Because `EventSource` cannot set headers, this endpoint **additionally**
accepts the token as `?token=<agentToken>`. Query-string tokens can leak via
logs and `Referer`, so the relay must not log query strings on this route.

Event names and `data` payloads:

| event | data |
|---|---|
| `message.created` | `{ "message": {...} }` |
| `plan.updated` | `{ "plan": {...} }` |
| `usage.reported` | `{ "usage": {...}, "runway": {...} }` |
| `ping` | `{ "t": <epoch ms> }` — every 25s, keeps proxies from idling the connection |

Only events for the token's own pairing are delivered.

## `POST /pairings/:id/plan`

**Authenticated.** Proposer is the token holder.

Request: `{ "goal": "...", "items": [ { "owner": "agent_...", "task": "..." } ] }`

Response `201`: `{ "plan": {...} }`

Re-proposing **resets all approvals** and unlocks the plan — renegotiating
must never inherit stale consent.

## `POST /pairings/:id/plan/approve`

**Authenticated.** Records the token holder's approval. Locks only once both
sides have approved.

Request: `{ "planVersion": <int> }`

`planVersion` is **required** and must match the plan's current `version`,
else `409 stale_plan`. This closes a real race: A approves, B silently
re-proposes a different plan, A's approval must not carry over to text the
human never saw. `Plan` therefore gains a `version: int` field, incremented
on every propose.

Response `200`: `{ "plan": {...} }`

## `GET /pairings/:id/plan`

**Authenticated.** `{ "plan": {...} | null }`.

`Plan` shape:
```json
{
  "pairingId": "...", "goal": "...", "version": 3,
  "items": [ { "owner": "...", "task": "..." } ],
  "proposedBy": "agent_...", "approvedBy": ["agent_..."],
  "locked": false, "createdAt": "...", "updatedAt": "..."
}
```

## `PUT /pairings/:id/budget`

**Authenticated.** Sets the shared budget both agents plan against.

Request (all fields optional, `null` clears):
```json
{ "deadline": "2026-08-02T18:00:00.000Z", "tokenBudget": 500000, "costBudgetUsd": 20 }
```

Response `200`: `{ "budget": {...} }`

## `POST /pairings/:id/usage`

**Authenticated.** Reporter is the token holder.

Request: `{ "tokensUsed": 0, "costUsd": 0, "wallClockMs": 0, "progressPct": 0 }`

These are **cumulative totals for this agent**, not deltas. The relay stores
each report and treats the latest per agent as current — this makes a dropped
or duplicated report harmless, which a delta model would not.

Response `201`: `{ "usage": {...}, "runway": {...} }`

## `GET /pairings/:id/usage`

**Authenticated.**

```json
{
  "usage": {
    "pairingId": "...",
    "byAgent": { "agent_...": { "tokensUsed", "costUsd", "wallClockMs", "progressPct", "reportCount", "lastReportedAt" } },
    "totals": { "tokensUsed", "costUsd", "wallClockMs" }
  },
  "runway": {
    "deadline": "..." ,
    "msRemaining": 5400000,
    "tokensRemaining": 380000,
    "costRemainingUsd": 12.4,
    "burn": { "tokensPerMin": 850, "costUsdPerMin": 0.04 },
    "projectedTokenExhaustion": "2026-08-02T17:10:00.000Z",
    "projectedCostExhaustion": null,
    "onTrack": true,
    "verdict": "Budget will outlast the deadline at the current burn rate."
  }
}
```

`runway` is the point of the whole usage subsystem: agents call this to decide
whether the plan they are about to commit to is *actually finishable*.

Rules:
- Any field whose budget is unset is `null`; never guess a budget.
- `burn` is computed over each agent's `wallClockMs`, not wall-clock since
  pairing creation — an agent idle for an hour has not been burning.
- Burn rates need ≥2 reports from an agent to be meaningful; with fewer,
  emit `null` rather than extrapolating from a single point.
- `onTrack` is `false` when a projected exhaustion lands before `deadline`.
- `verdict` is one short human-readable sentence. It is advisory; never
  present it as a guarantee.

## `GET /health`

Unauthenticated. `{ "ok": true }`.

---

# Session file

`~/.inzo/session.json`, mode `0600`, written by `packages/mcp-server` so that
`packages/cli` can attach to the same pairing without re-pairing:

```json
{
  "relayUrl": "http://localhost:8787",
  "pairingId": "pairing_...",
  "agentId": "agent_...",
  "agentToken": "...",
  "updatedAt": "..."
}
```

The CLI reads this file; it never accepts a token as an argv flag, since argv
is visible to other processes via `ps`.

# Sandbox boundary

`packages/mcp-server` exposes `run_shared_command`. Any command that originates
from the **peer** side runs through `@inzo/sandbox` (Docker, `--network none`,
capabilities dropped, non-root, resource-limited, timeout-enforced) against an
explicitly chosen working directory. This is the difference between the README's
security claim and an actual boundary.

Rules:
- Never execute a peer-supplied command outside the sandbox, for any reason.
- Sandbox unavailable (Docker missing/not running) ⇒ **refuse and say so**.
  Never silently fall back to host execution.
- The working directory is chosen by the local human via `INZO_WORKSPACE`,
  never by the peer, and never defaults to `$HOME` or `/`.
