import express, { type ErrorRequestHandler } from "express";
import { RelayStore } from "./lib/store.js";
import { RelayError } from "./lib/errors.js";
import { pairingsRouter } from "./routes/pairings.js";
import { messagesRouter } from "./routes/messages.js";
import { planRouter } from "./routes/plan.js";
import { usageRouter } from "./routes/usage.js";
import { requireAuth } from "./lib/auth.js";

/** Builds an Express app wired to the given store. Kept separate from index.ts so tests can build an app against an in-memory store without binding a port. */
export function createApp(store: RelayStore) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/pairings", pairingsRouter(store));
  app.use("/pairings/:id/messages", requireAuth(store), messagesRouter(store));
  app.use("/pairings/:id/plan", requireAuth(store), planRouter(store));
  app.use("/pairings/:id/usage", requireAuth(store), usageRouter(store));

  app.use((req, res) => {
    res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof RelayError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
  };
  app.use(errorHandler);

  return app;
}
