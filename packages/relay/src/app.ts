import express, { type ErrorRequestHandler } from "express";
import { requireAuth, requireScope } from "./lib/auth.js";
import { RelayError } from "./lib/errors.js";
import { requestLogger } from "./lib/logging.js";
import { FailureLimiter } from "./lib/rateLimit.js";
import { RelayStore } from "./lib/store.js";
import { budgetRouter } from "./routes/budget.js";
import { messagesRouter } from "./routes/messages.js";
import { pairingsRouter } from "./routes/pairings.js";
import { planRouter } from "./routes/plan.js";
import { streamRouter } from "./routes/stream.js";
import {
  auditRouter,
  consentRouter,
  consentVerifyRouter,
  credentialsRouter,
  wellKnownRouter,
} from "./routes/trust.js";
import { usageRouter } from "./routes/usage.js";

export interface AppOptions {
  /**
   * Trust `X-Forwarded-For` when deriving the client IP. Off by default: with
   * it on and no proxy actually in front, any client can spoof the header and
   * walk straight past the pairing-code rate limiter. Turn it on only when a
   * proxy you control is terminating requests.
   */
  trustProxy?: boolean;
  limiter?: FailureLimiter;
  /** Structured request logging. Off in tests, on when serving for real. */
  logging?: boolean;
}

/**
 * Builds an Express app wired to the given store. Kept separate from index.ts
 * so tests can build an app against an in-memory store without binding a port.
 */
export function createApp(store: RelayStore, options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy) app.set("trust proxy", true);
  if (options.logging) app.use(requestLogger());
  // Nothing this API accepts is large; a cap keeps a hostile body from
  // becoming a memory problem.
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Unauthenticated on purpose: requiring an account to verify a credential
  // would reintroduce exactly the pre-agreement cross-org verification is
  // meant to avoid, and requiring one to check a consent record would mean
  // trusting the relay whose honesty is being checked.
  app.use("/.well-known", wellKnownRouter(store));
  app.use("/consent", consentVerifyRouter(store));

  app.use("/pairings", pairingsRouter(store, options.limiter));
  app.use("/credentials", requireAuth(store), credentialsRouter(store));

  // EventSource cannot set an Authorization header, so the stream — and only
  // the stream — also accepts `?token=`.
  app.use(
    "/pairings/:id/stream",
    requireAuth(store, { allowQueryToken: true }),
    requireScope("messages:read"),
    streamRouter(store),
  );

  app.use("/pairings/:id/messages", requireAuth(store), messagesRouter(store));
  app.use("/pairings/:id/plan", requireAuth(store), planRouter(store));
  app.use("/pairings/:id/consent", requireAuth(store), consentRouter(store));
  app.use("/pairings/:id/audit", requireAuth(store), auditRouter(store));
  app.use("/pairings/:id/budget", requireAuth(store), budgetRouter(store));
  app.use("/pairings/:id/usage", requireAuth(store), usageRouter(store));

  app.use((req, res) => {
    res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof RelayError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }

    // Middleware below us throws HTTP-shaped errors too — body-parser raises a
    // 413 for an oversized body, a 400 for malformed JSON. Those are the
    // client's fault, so answering 500 would both mislead the caller and spray
    // stack traces into the log for what is really just a bad request.
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const type = (err as { type?: string }).type;
      res.status(status).json({
        error: {
          code: type ? type.replace(/\./g, "_") : "bad_request",
          message: err instanceof Error ? err.message : "Bad request",
        },
      });
      return;
    }

    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
  };
  app.use(errorHandler);

  return app;
}
