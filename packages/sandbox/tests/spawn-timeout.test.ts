import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { spawnDocker } from "../src/docker.js";

/** Minimal fake ChildProcess: EventEmitter + stdout/stderr PassThroughs + kill(). */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => void;
    killedWith?: string;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal?: string) => {
    child.killedWith = signal;
  });
  return child;
}

describe("spawnDocker", () => {
  it("resolves with stdout/stderr/exitCode on normal completion", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    const promise = spawnDocker(["run", "--rm", "image", "echo", "hi"], 5_000, spawnFn as never);

    child.stdout.emit("data", Buffer.from("hello\n"));
    child.stderr.emit("data", Buffer.from("warn\n"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(spawnFn).toHaveBeenCalledWith(
      "docker",
      ["run", "--rm", "image", "echo", "hi"],
      expect.any(Object),
    );
  });

  it("propagates a nonzero exit code from the sandboxed command", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    const promise = spawnDocker(["run"], 5_000, spawnFn as never);
    child.emit("close", 7, null);

    const result = await promise;
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("kills the process and reports timedOut=true when it exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const spawnFn = vi.fn().mockReturnValue(child);

      const promise = spawnDocker(["run"], 1_000, spawnFn as never);

      vi.advanceTimersByTime(1_001);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      // Simulate the process actually dying after the SIGKILL.
      child.emit("close", null, "SIGKILL");

      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects if the docker process itself fails to spawn", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    const promise = spawnDocker(["run"], 5_000, spawnFn as never);
    child.emit("error", new Error("spawn docker ENOENT"));

    await expect(promise).rejects.toThrow("spawn docker ENOENT");
  });
});
