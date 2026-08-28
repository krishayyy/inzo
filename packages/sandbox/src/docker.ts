import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  CONTAINER_WORKDIR,
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_TIMEOUT_MS,
  type RunInSandboxOptions,
} from "./types.js";
import { DockerUnavailableError, InvalidSandboxOptionsError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Checks whether the `docker` CLI is on PATH and the daemon is reachable,
 * by running `docker info`. Never throws — returns a result object describing
 * why Docker is unavailable, if it is.
 */
export async function checkDockerAvailable(
  execFn: typeof execFileAsync = execFileAsync,
): Promise<{ available: true } | { available: false; reason: string }> {
  try {
    await execFn("docker", ["info"], { timeout: 10_000 });
    return { available: true };
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException & { stderr?: string };
    if (nodeErr.code === "ENOENT") {
      return { available: false, reason: "the `docker` CLI was not found on PATH" };
    }
    const detail = nodeErr.stderr?.toString().trim() || nodeErr.message || "unknown error";
    return { available: false, reason: `\`docker info\` failed (${detail})` };
  }
}

/**
 * Asserts Docker is available, throwing a typed `DockerUnavailableError` if not.
 */
export async function assertDockerAvailable(
  execFn: typeof execFileAsync = execFileAsync,
): Promise<void> {
  const result = await checkDockerAvailable(execFn);
  if (!result.available) {
    throw new DockerUnavailableError(result.reason);
  }
}

/**
 * Pure function that builds the `docker run ...` argv from sandbox options.
 * Kept separate from process-spawning so it can be unit tested without Docker.
 */
export function buildDockerRunArgs(options: RunInSandboxOptions): string[] {
  if (!options.command || options.command.trim() === "") {
    throw new InvalidSandboxOptionsError("options.command must be a non-empty string");
  }
  if (!options.workdir || options.workdir.trim() === "") {
    throw new InvalidSandboxOptionsError("options.workdir must be a non-empty host path");
  }

  const hostWorkdir = path.resolve(options.workdir);
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const memory = options.memory ?? DEFAULT_MEMORY_LIMIT;
  const cpus = options.cpus ?? DEFAULT_CPU_LIMIT;
  const network = options.network ?? false;
  const readonlyMount = options.readonly ?? false;

  const args: string[] = [
    "run",
    "--rm",
    "--attach", "STDOUT",
    "--attach", "STDERR",
    "--workdir", CONTAINER_WORKDIR,
    "--mount", `type=bind,source=${hostWorkdir},target=${CONTAINER_WORKDIR}${readonlyMount ? ",readonly" : ""}`,
    "--memory", memory,
    "--cpus", cpus,
    // Drop privileges / harden the container beyond the filesystem+network isolation.
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
  ];

  if (network) {
    args.push("--network", "bridge");
  } else {
    args.push("--network", "none");
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(image, options.command, ...(options.args ?? []));

  return args;
}

export interface DockerProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Spawns `docker` with the given argv, enforcing `timeoutMs` by killing the
 * container (best-effort `docker kill` on the generated name, then SIGKILL
 * on the local process) if it runs too long.
 */
export function spawnDocker(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  spawnFn: typeof spawn = spawn,
): Promise<DockerProcessResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawnFn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL the docker CLI process; combined with --rm this also tears
      // down the container once the CLI's client connection drops. For a
      // more surgical kill we'd need to pre-assign --name and `docker kill`
      // it directly, but SIGKILL-ing the attached `docker run` is sufficient
      // here since we always pass --rm.
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const exitCode = timedOut ? 124 : code ?? (signal ? 128 : 1);
      resolve({ stdout, stderr, exitCode, timedOut, durationMs });
    });
  });
}
