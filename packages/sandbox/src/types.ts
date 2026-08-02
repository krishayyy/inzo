/**
 * Options for executing a command inside the sandbox.
 */
export interface RunInSandboxOptions {
  /** The executable/command to run inside the container, e.g. "node" or "git". */
  command: string;
  /** Arguments passed to `command`. */
  args?: string[];
  /**
   * Host path to mount read-write into the container as the working directory.
   * This is the ONLY host filesystem the container can see.
   */
  workdir: string;
  /** Max wall-clock time to allow the command to run, in milliseconds. Default: 30_000. */
  timeoutMs?: number;
  /** Whether the container gets network access. Default: false (no network). */
  network?: boolean;
  /** Docker image to run the command in. Default: DEFAULT_SANDBOX_IMAGE. */
  image?: string;
  /**
   * Environment variables to pass into the container.
   * Kept explicit/allowlisted rather than inheriting the host env.
   */
  env?: Record<string, string>;
  /**
   * Memory limit for the container (Docker `--memory` syntax, e.g. "512m"). Default: "512m".
   */
  memory?: string;
  /**
   * CPU limit for the container (Docker `--cpus` syntax, e.g. "1"). Default: "1".
   */
  cpus?: string;
}

/**
 * Result of running a command in the sandbox.
 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** Path inside the container that `workdir` is mounted to. */
export const CONTAINER_WORKDIR = "/workspace";

/** Default sandbox image used when `options.image` is not provided. */
export const DEFAULT_SANDBOX_IMAGE = "inzo-sandbox";

/** Default command timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default container memory limit. */
export const DEFAULT_MEMORY_LIMIT = "512m";

/** Default container CPU limit. */
export const DEFAULT_CPU_LIMIT = "1";
