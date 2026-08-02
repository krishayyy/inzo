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
   the work. Both humans watch this happen live in their own session.
3. **Approve.** Nothing gets locked in until both humans give a thumbs up on the
   proposed plan. Agents propose; humans decide.
4. **Work, sandboxed.** Once approved, actions run through a local sandbox
   (Docker) before touching the real filesystem — so a teammate's agent can't
   step on your machine by accident.
5. **Track usage.** Time spent, token/cost burn, and task progress are tracked
   live and exposed back to the agents, so the plan can account for how much
   runway is actually left (built for hackathon-style time pressure).

## Architecture

This is a monorepo with three packages:

- **`packages/relay`** — the shared backend. Handles pairing codes, message
  relay between paired agents, plan proposals/approvals, and usage tracking.
  Runs as a small hosted service (or locally for dev).
- **`packages/mcp-server`** — the MCP server each person runs locally and adds
  to their agent's config (Claude Code, Cursor, etc). Exposes tools like
  `create_pairing_code`, `join_pairing`, `send_message`, `propose_plan`,
  `approve_plan`, `get_usage`. Talks to the relay under the hood.
- **`packages/sandbox`** — local Docker-based sandbox for executing
  agent-proposed actions in isolation before they're applied for real.

## Status

Early scaffold — MVP in progress.

## License

Open-core: this repo (the self-hostable core) is intended to be open source.
Hosted/Cloud offering is a separate, future concern.
