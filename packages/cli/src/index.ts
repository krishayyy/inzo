#!/usr/bin/env node
import { approve, audit, budget, revoke, status, watch, withdraw } from "./commands.js";
import { invite, pair } from "./pair.js";
import { mode } from "./mode.js";
import { isUsageError, join, start } from "./start.js";
import { sessionFilePath } from "./session.js";
import { style } from "./render.js";

/** Kept in step with packages/cli/package.json by the release process. */
const VERSION = "0.1.0";

const USAGE = `inzo — pair, watch, and control an agent pairing

  inzo start [mode|repo|name]
                             start a session here and print a code to share
  inzo join <code>           join a teammate's session: repo, branch, and mode
  inzo mode [<mode>]         show or set research | plan | build | cowork
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

Sessions are keyed by project directory, so several repos can be paired at once.
This one resolves to:
  ${sessionFilePath()}

Credentials are written there by \`inzo pair\` or by the Inzo MCP server when your
agent pairs. There is deliberately no --token flag: argv is visible to every
process on this machine.
`;

/**
 * Windows is not supported yet, and the reason is not cosmetic: `chmod 0600`
 * is a no-op on NTFS, so the holder private key — which makes consent
 * non-repudiable and cannot be regenerated — would sit unprotected. Refusing
 * is safer than half-working. WSL is a complete environment for this.
 */
function assertSupportedPlatform(): void {
  if (process.platform === "win32") {
    throw new Error(
      "Inzo does not support Windows yet: file permissions there cannot protect the holder " +
        "private key that signs your approvals. Run it under WSL instead.",
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command !== undefined && !["help", "--help", "-h", "--version", "-v"].includes(command)) {
    assertSupportedPlatform();
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (command) {
    case "start":
      await start(rest);
      return 0;
    case "join":
      await join(rest);
      return 0;
    case "mode":
      await mode(rest);
      return 0;
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
    // Usage errors exit 2 so a script can tell "you typed it wrong" from
    // "it ran and failed" — see the CLI conventions in the plan.
    process.exit(isUsageError(err) ? 2 : 1);
  });
