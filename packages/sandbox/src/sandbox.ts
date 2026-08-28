import { assertDockerAvailable, buildDockerRunArgs, spawnDocker } from "./docker.js";
import { DEFAULT_TIMEOUT_MS, type RunInSandboxOptions, type SandboxResult } from "./types.js";

/**
 * Runs a command inside an isolated Docker container:
 *  - Filesystem: only `options.workdir` is visible to the container (mounted
 *    read-write at /workspace, or read-only with `readonly: true`); nothing
 *    else on the host is reachable.
 *  - Network: disabled by default (`--network none`); pass `network: true`
 *    to opt a specific call into outbound network access.
 *  - Time: killed after `timeoutMs` (default 30s) if still running.
 *
 * This is the security boundary Inzo relies on before a teammate's paired
 * agent is allowed to touch the real filesystem — every proposed action
 * runs here first.
 *
 * Throws `DockerUnavailableError` if the `docker` CLI isn't installed or the
 * daemon isn't running. Throws `InvalidSandboxOptionsError` for bad options.
 * Does NOT throw for a nonzero exit code from the command itself — that's
 * reported via `SandboxResult.exitCode`.
 */
export async function runInSandbox(options: RunInSandboxOptions): Promise<SandboxResult> {
  await assertDockerAvailable();

  const args = buildDockerRunArgs(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = await spawnDocker(args, timeoutMs);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  };
}
