import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "../src/docker.js";
import { InvalidSandboxOptionsError } from "../src/errors.js";
import { CONTAINER_WORKDIR, DEFAULT_SANDBOX_IMAGE } from "../src/types.js";

describe("buildDockerRunArgs", () => {
  it("constructs a correct docker invocation with defaults", () => {
    const args = buildDockerRunArgs({
      command: "echo",
      args: ["hello"],
      workdir: "/tmp/some-project",
    });

    expect(args).toContain("run");
    expect(args).toContain("--rm");
    expect(args).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(args).toEqual(
      expect.arrayContaining(["--workdir", CONTAINER_WORKDIR]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--mount",
        expect.stringContaining(`target=${CONTAINER_WORKDIR}`),
      ]),
    );
    // network disabled by default
    expect(args).toEqual(expect.arrayContaining(["--network", "none"]));
    // command + args appended at the end, after the image
    const imageIdx = args.indexOf(DEFAULT_SANDBOX_IMAGE);
    expect(args[imageIdx + 1]).toBe("echo");
    expect(args[imageIdx + 2]).toBe("hello");
  });

  it("mounts the resolved absolute host workdir", () => {
    const args = buildDockerRunArgs({
      command: "ls",
      workdir: "relative/path",
    });
    const mountArg = args[args.indexOf("--mount") + 1];
    expect(mountArg).toMatch(/^type=bind,source=\/.*relative\/path,target=\/workspace$/);
  });

  it("enables network only when explicitly requested", () => {
    const withNetwork = buildDockerRunArgs({
      command: "curl",
      workdir: "/tmp/x",
      network: true,
    });
    expect(withNetwork).toEqual(expect.arrayContaining(["--network", "bridge"]));
    expect(withNetwork).not.toEqual(expect.arrayContaining(["--network", "none"]));
  });

  it("uses a custom image when provided", () => {
    const args = buildDockerRunArgs({
      command: "node",
      workdir: "/tmp/x",
      image: "custom-image:latest",
    });
    expect(args).toContain("custom-image:latest");
    expect(args).not.toContain(DEFAULT_SANDBOX_IMAGE);
  });

  it("applies custom memory and cpu limits", () => {
    const args = buildDockerRunArgs({
      command: "node",
      workdir: "/tmp/x",
      memory: "1g",
      cpus: "2",
    });
    expect(args).toEqual(expect.arrayContaining(["--memory", "1g"]));
    expect(args).toEqual(expect.arrayContaining(["--cpus", "2"]));
  });

  it("passes through env vars as --env KEY=VALUE", () => {
    const args = buildDockerRunArgs({
      command: "node",
      workdir: "/tmp/x",
      env: { FOO: "bar", BAZ: "qux" },
    });
    expect(args).toEqual(expect.arrayContaining(["--env", "FOO=bar"]));
    expect(args).toEqual(expect.arrayContaining(["--env", "BAZ=qux"]));
  });

  it("throws InvalidSandboxOptionsError when command is empty", () => {
    expect(() => buildDockerRunArgs({ command: "", workdir: "/tmp/x" })).toThrow(
      InvalidSandboxOptionsError,
    );
  });

  it("throws InvalidSandboxOptionsError when workdir is empty", () => {
    expect(() => buildDockerRunArgs({ command: "ls", workdir: "" })).toThrow(
      InvalidSandboxOptionsError,
    );
  });

  it("hardens the container (no-new-privileges, cap-drop ALL)", () => {
    const args = buildDockerRunArgs({ command: "ls", workdir: "/tmp/x" });
    expect(args).toEqual(expect.arrayContaining(["--security-opt", "no-new-privileges"]));
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL"]));
  });
});
