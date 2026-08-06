/**
 * Cloudflare Workers RPC wraps ANY thrown value crossing a Durable Object
 * RPC boundary into a generic "remote error" stub — only `name`/`message`
 * survive, even for a plain object thrown deliberately (verified empirically:
 * a plain `{status, code, message}` thrown from a DO method arrives at the
 * Worker as a bare `Error` with none of those fields). Only RETURNED values
 * structured-clone fully.
 *
 * So a public DO method that can fail must never throw across the boundary —
 * it returns a result instead, and the Worker unwraps it back into a real
 * throw on its own side of the boundary (a same-realm throw/catch, where
 * duck-typing status/code works fine).
 */
export type RpcResult<T> = { ok: true; data: T } | { ok: false; status?: number; code: string; message: string };

function isDomainErrorShape(err: unknown): err is { status?: number; code: string; message: string } {
  return typeof err === "object" && err !== null && "code" in err && "message" in err;
}

/** Wrap a DO method body: converts a thrown RelayError/CredentialError into a plain RpcResult. */
export function rpcSafe<T>(fn: () => T): RpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    if (isDomainErrorShape(err)) {
      return { ok: false, status: (err as { status?: number }).status, code: err.code, message: err.message };
    }
    throw err;
  }
}

/** Worker-side: turns a failed RpcResult back into a real (same-realm) throw. */
export function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.data;
  const err = new Error(result.message) as Error & { status?: number; code: string };
  err.status = result.status;
  err.code = result.code;
  throw err;
}
