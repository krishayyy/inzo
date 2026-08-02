/**
 * Base class for all typed errors thrown by @inzo/sandbox.
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the `docker` CLI is missing from PATH, or the Docker daemon
 * isn't running/reachable. This is expected on machines that don't have
 * Docker installed — callers should catch this and degrade gracefully
 * (e.g. tell the user to install/start Docker) rather than crash.
 */
export class DockerUnavailableError extends SandboxError {
  constructor(reason: string) {
    super(
      `Docker is not available: ${reason}. Install Docker Desktop (or the Docker Engine) ` +
        `and make sure it is running, then try again.`,
    );
    this.name = "DockerUnavailableError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the sandbox invocation itself is misconfigured (bad options),
 * as opposed to the command run inside the sandbox failing (which is
 * reported via `SandboxResult.exitCode`, not an exception).
 */
export class InvalidSandboxOptionsError extends SandboxError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSandboxOptionsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
