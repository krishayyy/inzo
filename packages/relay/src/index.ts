#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { RelayStore } from "./lib/store.js";

export { createApp, type AppOptions } from "./app.js";
export { RelayStore, type BudgetInput, type UsageInput } from "./lib/store.js";
export { relayEvents, type RelayEvent, type Revocation } from "./lib/events.js";
export { computeRunway, foldUsage } from "./lib/runway.js";
export { FailureLimiter } from "./lib/rateLimit.js";
export { requestLogger } from "./lib/logging.js";
export * from "./types.js";

/** Expired-but-unused pairing codes are swept on this cadence. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

function resolveDbPath(): string {
  return process.env.INZO_RELAY_DB_PATH ?? "./data/relay.db";
}

/**
 * `inzo-relay rotate-key` — §4.1.
 *
 * Deliberately an operator command rather than an HTTP route. Key rotation is
 * the single most powerful operation on the relay, and giving it a network
 * surface means giving it an authorization story, an audit story, and a new
 * way to be wrong. Shell access to the host is already strictly more authority
 * than this command grants.
 */
function rotateKeyCommand(): void {
  const dbPath = resolveDbPath();
  const store = new RelayStore(dbPath);
  try {
    const previous = store.credentials.activeKid();
    const next = store.credentials.rotateIssuerKey();
    const pruned = store.credentials.pruneRetiredKeys();
    // eslint-disable-next-line no-console
    console.log(
      [
        `rotated issuer key: ${previous} -> ${next}`,
        `${previous} is retired but still published in the JWKS; credentials it signed stay valid until they expire.`,
        pruned > 0 ? `pruned ${pruned} key(s) retired long enough that nothing they signed can still be alive.` : null,
        `Verifiers cache the JWKS — allow their cache TTL to pass before assuming everyone has the new key.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } finally {
    store.close();
  }
}

function main() {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${process.env.PORT}"`);
  }
  const dbPath = resolveDbPath();

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const store = new RelayStore(dbPath);
  const app = createApp(store, {
    trustProxy: process.env.INZO_TRUST_PROXY === "true",
    logging: process.env.INZO_LOG !== "off",
  });

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`inzo relay listening on http://localhost:${port} (db: ${dbPath})`);
  });

  const purge = setInterval(() => {
    try {
      store.purgeExpiredCodes();
      // Retired keys age out on the same sweep; nothing they signed can still
      // be alive once they are past the TTL ceiling.
      store.credentials.pruneRetiredKeys();
    } catch (err) {
      // A failed sweep is not worth taking the relay down for.
      // eslint-disable-next-line no-console
      console.error("purge failed", err);
    }
  }, PURGE_INTERVAL_MS);
  purge.unref();

  // Platforms like Fly and Docker send SIGTERM and then hard-kill. Closing the
  // SQLite handle explicitly avoids leaving a hot WAL behind on every deploy.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`${signal} received, shutting down`);
    clearInterval(purge);
    // SSE connections are open by design and will never close on their own.
    server.closeAllConnections();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only boot the server when this file is run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "rotate-key") {
    rotateKeyCommand();
  } else {
    main();
  }
}
