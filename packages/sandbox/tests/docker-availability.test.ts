import { describe, expect, it, vi } from "vitest";
import { assertDockerAvailable, checkDockerAvailable } from "../src/docker.js";
import { DockerUnavailableError } from "../src/errors.js";

describe("checkDockerAvailable", () => {
  it("reports available when `docker info` succeeds", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    const result = await checkDockerAvailable(execFn as never);
    expect(result).toEqual({ available: true });
    expect(execFn).toHaveBeenCalledWith("docker", ["info"], expect.any(Object));
  });

  it("reports unavailable with a clear reason when the docker CLI is missing (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    const execFn = vi.fn().mockRejectedValue(err);
    const result = await checkDockerAvailable(execFn as never);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/not found on PATH/);
    }
  });

  it("reports unavailable with the daemon error when `docker info` fails for another reason", async () => {
    const err = Object.assign(new Error("failed"), {
      stderr: "Cannot connect to the Docker daemon",
    });
    const execFn = vi.fn().mockRejectedValue(err);
    const result = await checkDockerAvailable(execFn as never);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/Cannot connect to the Docker daemon/);
    }
  });
});

describe("assertDockerAvailable", () => {
  it("resolves silently when docker is available", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    await expect(assertDockerAvailable(execFn as never)).resolves.toBeUndefined();
  });

  it("throws a typed DockerUnavailableError when docker is not available", async () => {
    const err = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    const execFn = vi.fn().mockRejectedValue(err);
    await expect(assertDockerAvailable(execFn as never)).rejects.toBeInstanceOf(
      DockerUnavailableError,
    );
  });
});
