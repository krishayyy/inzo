export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Incremental SSE frame parser.
 *
 * Written by hand rather than pulled from a dependency because the CLI's whole
 * value is being instantly runnable at a hackathon table, and because Node's
 * global EventSource cannot attach an Authorization header anyway. Kept pure
 * and separate from the socket so the framing logic is unit-testable: a
 * network chunk can split anywhere, including mid-frame.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let split: number;
    while ((split = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      const parsed = parseFrame(frame);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

function parseFrame(frame: string): SseEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (!event) return null;
  const raw = dataLines.join("\n");
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = raw;
  }
  return { event, data };
}

/**
 * Subscribes to an SSE endpoint until the signal aborts or the server hangs up.
 * Yields events as they arrive.
 */
export async function* subscribe(url: string, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = (() => {
      try {
        return (JSON.parse(text) as { error?: { message?: string } }).error?.message;
      } catch {
        return undefined;
      }
    })();
    throw new Error(code ?? `Stream failed (${res.status})`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
