#!/usr/bin/env node
import { approve, audit, budget, revoke, status, watch, withdraw } from "./commands.js";
import { invite, pair } from "./pair.js";
import { sessionFilePath } from "./session.js";
import { style } from "./render.js";

const USAGE = `inzo — pair, watch, and control an agent pairing

  inzo pair                  create a pairing code and wire up .mcp.json here
  inzo pair <code>           join a pairing code a teammate shared with you
  inzo pair --invite <n>     invite <n> more teammates into your active pairing
  inzo watch                 live view of the thread, plan, and runway
  inzo status                one-shot snapshot of the pairing
  inzo approve               read the current plan and sign off on it
  inzo revoke [peer|self]    kill switch (default: peer)
  inzo withdraw              pull your approval back, no peer cooperation needed
  inzo audit [--since <n>]   tamper-evident log, with chain verification
  inzo budget [--deadline <iso>] [--tokens <n>] [--cost <usd>]
                             set or show the shared budget; pass "none" to clear

Credentials come from ${sessionFilePath()}, written by \`inzo pair\` or by the
Inzo MCP server when your agent pairs. There is deliberately no --token flag:
argv is visible to every process on this machine.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "pair": {
      if (rest[0] === "--invite") {
        const count = Number(rest[1]);
        if (!Number.isInteger(count) || count < 1) {
          throw new Error("inzo pair --invite <n> requires a positive integer count");
        }
        await invite(count);
        return 0;
      }
      await pair(rest[0]);
      return 0;
    }
    case "watch":
      await watch();
      return 0;
    case "status":
      await status();
      return 0;
    case "approve":
      await approve();
      return 0;
    case "revoke": {
      const target = rest[0] ?? "peer";
      if (target !== "peer" && target !== "self") {
        throw new Error('revoke takes "peer" or "self"');
      }
      await revoke(target);
      return 0;
    }
    case "withdraw":
      await withdraw();
      return 0;
    case "audit":
      await audit(rest);
      return 0;
    case "budget":
      await budget(rest);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${style.red(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(1);
  });
