import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { RelayStore } from "./lib/store.js";

export { createApp } from "./app.js";
export { RelayStore } from "./lib/store.js";
export { relayEvents } from "./lib/events.js";
export * from "./types.js";

function main() {
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = process.env.INZO_RELAY_DB_PATH ?? "./data/relay.db";

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const store = new RelayStore(dbPath);
  const app = createApp(store);

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`inzo relay listening on http://localhost:${port} (db: ${dbPath})`);
  });
}

// Only boot the server when this file is run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
