# inzo-mcp

The MCP (Model Context Protocol) server for [Inzo](../../README.md). Add it to
your coding agent's config and it exposes tools for pairing with a teammate's
agent, negotiating a plan, and tracking usage — all relayed through the Inzo
relay backend (`packages/relay`).

This package is a **thin client**: it holds no state of its own beyond "which
pairing am I in right now" for the current process, and forwards everything
else to the relay over HTTP.

## Install / build

From the repo root:

```bash
npm install
npm run build --workspace=packages/mcp-server
```

Or from this directory:

```bash
npm install
npm run build
```

For local development without building, use:

```bash
npm run dev
```

(runs `src/index.ts` directly via `tsx`.)

## Configuration

| Env var          | Default                  | Purpose                                      |
| ----------------- | ------------------------ | --------------------------------------------- |
| `INZO_RELAY_URL`  | `http://localhost:8787`  | Base URL of the Inzo relay backend            |
| `INZO_AGENT_ID`   | random, e.g. `agent_x7k2m9` | Identifier this agent reports to the relay |

## Adding it to Claude Code

Add this to your MCP config (e.g. `.mcp.json` in a project, or your global
Claude Code MCP settings) under `mcpServers`:

```json
{
  "mcpServers": {
    "inzo": {
      "command": "node",
      "args": ["/absolute/path/to/inzo/packages/mcp-server/dist/index.js"],
      "env": {
        "INZO_RELAY_URL": "http://localhost:8787"
      }
    }
  }
}
```

Once `npx inzo-mcp` is published, this simplifies to:

```json
{
  "mcpServers": {
    "inzo": {
      "command": "npx",
      "args": ["-y", "inzo-mcp"],
      "env": {
        "INZO_RELAY_URL": "http://localhost:8787"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `create_pairing_code` | Generate a short pairing code to share with a teammate. Sets the active pairing for this session. |
| `join_pairing` | Join a pairing using a code a teammate shared with you. Sets the active pairing for this session. |
| `send_message` | Send a message to your paired agent in the active pairing's shared thread. |
| `get_thread` | Fetch the conversation so far (optionally since a cursor), so the agent can reason about it and show it to the human. |
| `propose_plan` | Propose a shared goal + task split to the paired agent. |
| `approve_plan` | Record this side's human approval of the current plan. Both sides must approve for it to lock. |
| `get_plan` | Fetch the current plan plus approval/lock status. |
| `report_usage` | Report this agent's own tokens, cost, elapsed seconds, and progress %. |
| `get_usage` | Fetch combined usage for both sides of the pairing. |

## Example flow

1. **Person A** (in their agent session): calls `create_pairing_code` → gets
   back a code like `7F3K-QZ`. They send it to their teammate over Slack/text.
2. **Person B**: calls `join_pairing` with `{ "code": "7F3K-QZ" }` → both
   sessions now share a `pairingId`.
3. Either side calls `send_message` to talk to the other agent; both sides use
   `get_thread` to see the running conversation.
4. One agent calls `propose_plan` with a goal and task split. Each human
   reviews it, and each side's agent calls `approve_plan` once its human gives
   a thumbs up. `get_plan` shows `locked: true` once both have approved.
5. As work proceeds, each side calls `report_usage` periodically; either side
   can call `get_usage` to see combined burn and progress.

## Architecture note

All HTTP calls to the relay live in `src/relayClient.ts`. If the relay's
actual route/field names differ slightly from the agreed contract once it's
built, that's the one file that needs to change.

## Tests

```bash
npm test
```

Runs schema-validation tests (via Vitest) for the tool input schemas and
session-state helpers. These don't require the relay to be running.
