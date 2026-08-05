import type { RequestHandler } from "express";

/**
 * Structured request logging.
 *
 * Deliberately logs `req.path`, never `req.originalUrl`: the SSE stream
 * accepts its bearer token as `?token=` (EventSource cannot set headers), so
 * logging query strings would write live credentials into the log file. The
 * protocol requires that not happen, and the safest way to honour it is to
 * have no code path that can log a query string at all, rather than a
 * per-route exception someone forgets later.
 */
export function requestLogger(write: (line: string) => void = (line) => process.stdout.write(line)): RequestHandler {
  return (req, res, next) => {
    if (req.path === "/health") return next(); // uptime checks would drown everything else
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      write(
        `${JSON.stringify({
          t: new Date().toISOString(),
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(durationMs * 10) / 10,
        })}\n`,
      );
    });
    next();
  };
}
