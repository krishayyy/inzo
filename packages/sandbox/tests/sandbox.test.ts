import { describe, expect, it, vi, beforeEach } from "vitest";

const assertDockerAvailable = vi.fn();
const spawnDocker = vi.fn();

vi.mock("../src/docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/docker.js")>();
  return {
    ...actual,
    assertDockerAvailable: (...args: unknown[]) => assertDockerAvailable(...args),
    spawnDocker: (...args: unknown[]) => spawnDocker(...args),
  };
});

const { runInSandbox } = await import("../src/sandbox.js");
const { DockerUnavailableError } = await import("../src/errors.js");

describe("runInSandbox", () => {
  beforeEach(() => {
    assertDockerAvailable.mockReset();
    spawnDocker.mockReset();
  });

  it("checks docker availability before running, and returns the mapped result", async () => {
    assertDockerAvailable.mockResolvedValue(undefined);
    spawnDocker.mockResolvedValue({
      stdout: "out",
      stderr: "err",
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
    });

    const result = await runInSandbox({ command: "echo", args: ["hi"], workdir: "/tmp/x" });

    expect(assertDockerAvailable).toHaveBeenCalledTimes(1);
    expect(spawnDocker).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
    });
  });

  it("propagates DockerUnavailableError without attempting to spawn", async () => {
    assertDockerAvailable.mockRejectedValue(new DockerUnavailableError("not installed"));

    await expect(
      runInSandbox({ command: "echo", workdir: "/tmp/x" }),
    ).rejects.toBeInstanceOf(DockerUnavailableError);

    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("passes the configured timeoutMs through to spawnDocker", async () => {
    assertDockerAvailable.mockResolvedValue(undefined);
    spawnDocker.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });

    await runInSandbox({ command: "echo", workdir: "/tmp/x", timeoutMs: 5_000 });

    expect(spawnDocker).toHaveBeenCalledWith(expect.any(Array), 5_000);
  });
});
