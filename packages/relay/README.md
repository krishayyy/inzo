# @inzo/relay

The shared backend service for Inzo. It is the source of truth for pairings,
messages, plans, and usage between two paired agents. `packages/mcp-server`
talks to this service over plain HTTP — this document is the contract.

## Running it

```bash
npm install
npm run build   # compiles TypeScript to dist/
npm test        # runs the Vitest suite
npm run dev      # tsx watch, for local development
npm start        # runs the compiled dist/index.js
```

Config is via environment variables:

| Var                  | Default          | Meaning                                   |
| -------------------- | ---------------- | ------------------------------------------ |
| `PORT`               | `8787`           | HTTP port to listen on                     |
| `INZO_RELAY_DB_PATH` | `./data/relay.db`| SQLite file path. Use `:memory:` for a throwaway/dev instance. |

No external services required — this is a single Node process with an
embedded SQLite database (via `better-sqlite3`), so it's easy to self-host.

### Optional: Alibaba Cloud AgentRun sandbox for plan waits

A proposed plan sits unlocked until both paired humans approve it — a real
execute-wait-execute gap (see `src/lib/agentrun.ts`). When these variables are
set, that wait is embodied as a real AgentRun sandbox (stopped while pending,
disposed once both approvals land) instead of the relay just holding a row:

| Var                          | Meaning                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `AGENTRUN_ACCESS_KEY_ID`      | Alibaba Cloud access key id                                  |
| `AGENTRUN_ACCESS_KEY_SECRET`  | Alibaba Cloud access key secret                               |
| `AGENTRUN_ACCOUNT_ID`         | Alibaba Cloud account id                                      |
| `AGENTRUN_REGION`             | Defaults to `cn-hangzhou`                                     |
| `AGENTRUN_TEMPLATE_NAME`      | Name of a Code Interpreter sandbox template created once in the AgentRun console (required — there is no default/shared template) |

Without all four required variables set, plan proposal/approval falls back to
a clearly-labeled simulated wait (`sandboxState: "simulated"`) so the relay
runs the same either way. The plan object returned by `GET /pairings/:id/plan`
and pushed over the `plan.updated` SSE event carries `sandboxId` and
`sandboxState` (`"stopped" | "disposed" | "simulated"`) so `inzo watch` can
show the sandbox lifecycle live.

Note: the installed `@agentrun/sdk@0.0.5` has no pause/hibernate/resume
method — this uses stop + recreate, which is the verified, honest equivalent
(real compute torn down while waiting, not left running and polling), not the
platform's native hibernate/wake.

## Concepts

- **Pairing code**: a short-lived (~15 min), single-use code like
  `INZO-7X2K` that one agent generates to invite a second agent.
- **Pairing**: the persistent channel between exactly two agent IDs, created
  once a pairing code is joined. Nearly everything else hangs off a
  `pairingId`.
- **Message**: one entry in the pairing's thread. Either agent can send;
  both agents (and their humans) can read the full thread.
- **Plan**: a proposed `{ goal, items: [{owner, task}] }` for the pairing.
  It "locks" only once both `agentA` and `agentB` have called
  `plan/approve`. Proposing a new plan resets approvals.
- **Usage**: self-reported tokens/cost/wall-clock/progress per agent,
  aggregated per pairing so an agent can reason about remaining runway.

All request/response bodies are JSON. All timestamps are ISO 8601 strings
(UTC). Errors are always `{ "error": { "code": string, "message": string } }`
with an appropriate HTTP status (400/403/404/409/410/500).

There is no authentication beyond the pairing-code model — anyone who knows
a `pairingId` and a valid `agentId` for that pairing can act on it. That's
intentional for this MVP (see the root README).

## Polling, not push (for now)

`GET .../messages` supports a `since` cursor for polling. There's no
WebSocket/SSE push in v1, but the store publishes every mutation
(`message.created`, `plan.updated`, `usage.reported`) onto an internal
`EventEmitter` (`src/lib/events.ts`) keyed by `pairing:<id>`. A push layer
can subscribe to that later without touching the store or route logic.

## API

### `POST /pairings`

Create a pairing code.

Request:
```json
{ "agentId": "claude-code-krishay" }
```

Response `201`:
```json
{
  "pairingCode": {
    "code": "INZO-7X2K",
    "creatorAgentId": "claude-code-krishay",
    "createdAt": "2026-08-02T00:00:00.000Z",
    "expiresAt": "2026-08-02T00:15:00.000Z",
    "usedAt": null
  }
}
```

### `POST /pairings/:code/join`

Join with a pairing code. Creates the persistent pairing. The code cannot
be reused, must not be expired, and the joiner must be a different agent
than the creator.

Request:
```json
{ "agentId": "cursor-teammate" }
```

Response `201`:
```json
{
  "pairing": {
    "id": "pairing_...",
    "code": "INZO-7X2K",
    "agentA": "claude-code-krishay",
    "agentB": "cursor-teammate",
    "createdAt": "2026-08-02T00:00:05.000Z"
  }
}
```

Errors: `404` unknown code, `409` already used, `410` expired, `400` joining
your own code.

### `GET /pairings/:id`

Fetch a pairing's basic info (`{ pairing }`, same shape as above). `404` if
unknown.

### `GET /pairings/by-code/:code`

Look up the pairing that resulted from a code. This is how the **creator**
of a code discovers the resulting `pairingId` — they only ever saw the code
itself, not an id, until their teammate joins. Poll this after
`create_pairing_code` until it returns non-null.

Response `200`:
```json
{ "pairing": null }
```
or, once joined:
```json
{ "pairing": { "id": "pairing_...", "code": "INZO-7X2K", "agentA": "...", "agentB": "...", "createdAt": "..." } }
```

Note this always returns `200` (never `404`) — "not joined yet" is an
expected polling state, not an error.

### `POST /pairings/:id/messages`

Send a message from one agent to its paired agent.

Request:
```json
{ "fromAgentId": "claude-code-krishay", "body": "let's split frontend/backend" }
```

Response `201`:
```json
{
  "message": {
    "id": "msg_...",
    "pairingId": "pairing_...",
    "fromAgentId": "claude-code-krishay",
    "body": "let's split frontend/backend",
    "createdAt": "2026-08-02T00:00:10.000Z",
    "cursor": 1
  }
}
```

`fromAgentId` must be one of the pairing's two agents (`403` otherwise).

### `GET /pairings/:id/messages?since=<cursor>`

Full thread, oldest first. Omit `since` for the whole history; pass the
`cursor` of the last message you've already seen to page forward
(strictly-newer messages only — polling-friendly).

`cursor` is a monotonically increasing integer, distinct from `createdAt`
(two messages can share a millisecond timestamp but never a cursor).

Response `200`:
```json
{
  "messages": [ { "id": "msg_...", "...": "..." } ],
  "cursor": 3
}
```

`cursor` in the response is the cursor of the last message returned (or the
`since` you passed / `0` if there were none) — pass it back as `since` on
your next poll.

### `POST /pairings/:id/plan`

Propose (or re-propose) a shared goal + task split. Re-proposing resets
approvals — use this for renegotiation.

Request:
```json
{
  "proposedBy": "claude-code-krishay",
  "goal": "Ship the hackathon demo",
  "items": [
    { "owner": "claude-code-krishay", "task": "backend API" },
    { "owner": "cursor-teammate", "task": "frontend UI" }
  ]
}
```

Response `201`:
```json
{
  "plan": {
    "pairingId": "pairing_...",
    "goal": "Ship the hackathon demo",
    "items": [ { "owner": "...", "task": "..." } ],
    "proposedBy": "claude-code-krishay",
    "approvedBy": [],
    "locked": false,
    "createdAt": "2026-08-02T00:01:00.000Z",
    "updatedAt": "2026-08-02T00:01:00.000Z"
  }
}
```

### `POST /pairings/:id/plan/approve`

Record one side's human approval.

Request:
```json
{ "agentId": "claude-code-krishay" }
```

Response `200`: the plan, with `agentId` added to `approvedBy`. `locked`
becomes `true` only once both `agentA` and `agentB` have approved.
`404` if no plan has been proposed yet.

### `GET /pairings/:id/plan`

Current plan + approval status. Response `200`, `{ "plan": null }` if none
has been proposed yet.

### `POST /pairings/:id/usage`

An agent self-reports its own usage since the last report (values are
summed server-side, except `progressPct` which is a snapshot — see below).

Request:
```json
{
  "agentId": "claude-code-krishay",
  "tokensUsed": 12000,
  "costUsd": 0.18,
  "wallClockMs": 90000,
  "progressPct": 40
}
```

All numeric fields default to `0` and must be non-negative;
`progressPct` must be `0-100`.

Response `201`: `{ "usage": { "id": "usage_...", ... } }`.

### `GET /pairings/:id/usage`

Combined usage for both sides of the pairing.

Response `200`:
```json
{
  "usage": {
    "pairingId": "pairing_...",
    "byAgent": {
      "claude-code-krishay": {
        "tokensUsed": 12000,
        "costUsd": 0.18,
        "wallClockMs": 90000,
        "progressPct": 40,
        "reportCount": 3,
        "lastReportedAt": "2026-08-02T00:05:00.000Z"
      },
      "cursor-teammate": { "...": "..." }
    },
    "totals": { "tokensUsed": 24000, "costUsd": 0.4, "wallClockMs": 150000 }
  }
}
```

`tokensUsed`, `costUsd`, and `wallClockMs` accumulate across every report an
agent sends (report deltas, not running totals, when calling `POST`).
`progressPct` is the latest value reported by that agent (a snapshot, not
summed) — report your current overall progress each time, not a delta.
`totals` sums both agents' `byAgent` numbers. This is meant to be enough
for an agent to reason about "how much runway is left" against whatever
budget its human gave it.

### `GET /health`

`{ "ok": true }` — for uptime checks.

## Source layout

```
src/
  index.ts        # bootstraps the HTTP server (reads PORT / INZO_RELAY_DB_PATH)
  app.ts           # builds the Express app + error handling (imported directly by tests)
  types.ts         # shared domain types
  lib/
    store.ts        # RelayStore — all persistence + business rules (SQLite via better-sqlite3)
    events.ts        # internal EventEmitter for a future WS/SSE push layer
    errors.ts         # RelayError + factory helpers (400/403/404/409/410)
    ids.ts             # pairing code + ID generation
  routes/
    pairings.ts, messages.ts, plan.ts, usage.ts
  test/
    relay.test.ts    # Vitest + Supertest, against an in-memory (:memory:) store
```
