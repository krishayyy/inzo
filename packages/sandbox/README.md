# @inzo/sandbox

Local, Docker-based sandbox for running agent-proposed shell commands or
scripts in isolation before they're allowed to touch the real filesystem.

## Why this exists

Inzo lets two people pair their AI coding agents so the agents can talk
directly and split work. That means a **teammate's agent** — not just your
own — can end up proposing commands that would run on **your machine**.

`@inzo/sandbox` is the security boundary in between. Once a plan is
approved, actions run through this package first:

- **Filesystem isolation** — the container can only see one host directory,
  the `workdir` you explicitly pass in, mounted read-write at `/workspace`.
  Nothing else on your machine is reachable from inside the container.
- **No network by default** — containers run with `--network none` unless
  you explicitly opt a call into network access (`network: true`).
- **Bounded execution time** — every run has a timeout (30s by default);
  the container is killed if it's exceeded.
- **Reduced privileges** — the container runs as a non-root user, with
  `--cap-drop ALL` and `--security-opt no-new-privileges` on top of the
  filesystem/network restrictions.

This is a defense-in-depth boundary, not a guarantee against a
container-escape-class exploit — but it means a buggy or malicious command
from a paired agent can't casually read your SSH keys, hit the network, or
wander outside the one directory you approved.

## Prerequisites

- [Docker](https://www.docker.com/) (Desktop or Engine) installed **and
  running**. `@inzo/sandbox` shells out to the `docker` CLI rather than
  bundling the Docker Engine SDK, so there's no extra native dependency —
  but Docker itself has to be present on the host.
- Not every machine running Inzo will have Docker. Calling `runInSandbox`
  on a machine without it throws a typed `DockerUnavailableError` (see
  below) rather than a cryptic spawn failure — check for it and surface a
  clear message ("install/start Docker") instead of crashing.

## Install

Within this monorepo, other packages depend on it as a workspace package:

```json
{
  "dependencies": {
    "@inzo/sandbox": "*"
  }
}
```

## Usage

```ts
import { runInSandbox, DockerUnavailableError } from "@inzo/sandbox";

try {
  const result = await runInSandbox({
    command: "npm",
    args: ["test"],
    workdir: "/Users/me/my-project", // the only host directory the container can see
    timeoutMs: 60_000,               // default: 30_000
    network: false,                  // default: false (no network)
  });

  console.log(result.stdout);
  console.log(result.exitCode); // 0 = success; nonzero does NOT throw
} catch (err) {
  if (err instanceof DockerUnavailableError) {
    // Docker isn't installed or isn't running — tell the user, don't crash.
  } else {
    throw err;
  }
}
```

### API

#### `runInSandbox(options): Promise<SandboxResult>`

| Option      | Type                     | Default                   | Notes                                                                 |
| ----------- | ------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| `command`   | `string`                 | —                           | Required. Executable to run inside the container.                      |
| `args`      | `string[]`               | `[]`                        | Arguments to `command`.                                                 |
| `workdir`   | `string`                 | —                           | Required. Host path mounted read-write at `/workspace` in the container. |
| `timeoutMs` | `number`                 | `30_000`                    | Container is killed (SIGKILL) if exceeded; result has `timedOut: true`.  |
| `network`   | `boolean`                | `false`                     | `false` → `--network none`; `true` → bridge networking.                 |
| `image`     | `string`                 | `"inzo-sandbox"`            | Docker image to run. See "Default image" below.                        |
| `env`       | `Record<string, string>` | `{}`                        | Explicit env vars passed into the container (host env is NOT inherited). |
| `memory`    | `string`                 | `"512m"`                    | Docker `--memory` value.                                                |
| `cpus`      | `string`                 | `"1"`                       | Docker `--cpus` value.                                                  |

Returns a `SandboxResult`:

```ts
interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}
```

A nonzero `exitCode` from the sandboxed command does **not** throw — that's
a normal result. `runInSandbox` only throws for boundary-level failures:

- `DockerUnavailableError` — the `docker` CLI isn't on PATH, or the daemon
  isn't reachable (`docker info` failed). Check this explicitly and show
  the user a clear "install/start Docker" message.
- `InvalidSandboxOptionsError` — `command` or `workdir` was missing/empty.

Also exported: `checkDockerAvailable()` / `assertDockerAvailable()` if a
caller wants to probe Docker availability up front (e.g. to show a
"sandbox not available" banner) without actually running anything yet.

## Default image

The default `image: "inzo-sandbox"` is built from
[`docker/Dockerfile`](./docker/Dockerfile): a minimal `node:20-alpine` image
with `git` installed and a non-root `sandbox` user, since agents will most
commonly want to run `node`/`npm`/`git` commands against the mounted
workdir. Build it locally with:

```sh
npm run build:image
# equivalent to:
# docker build -t inzo-sandbox -f docker/Dockerfile docker
```

You can point `runInSandbox` at any other image via the `image` option —
e.g. a Python image, or one with more tooling preinstalled.

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm test        # vitest, fully mocked — does NOT require Docker to be installed
```

The test suite mocks the `docker` CLI invocation (via injected
`spawn`/`execFile` functions) so `npm test` works on any machine, CI
included, whether or not Docker is present. It covers:

- correct `docker run` argv construction from `RunInSandboxOptions`
  (mount, workdir, network flag, resource limits, image, env vars)
- timeout handling (the process is killed and `timedOut: true` is reported)
- the "Docker not available" error path (`DockerUnavailableError`, both for
  a missing CLI and a non-responsive daemon)

### What still needs Docker installed to actually exercise

The unit tests intentionally never invoke the real `docker` binary. To
verify end-to-end (a real container actually launching, the filesystem/network
isolation actually holding, the default image actually building), you need
Docker running locally:

```sh
npm run build:image
node -e '
  const { runInSandbox } = require("./dist/index.js");
  runInSandbox({ command: "sh", args: ["-c", "pwd && ls && (curl -s example.com || echo no-network)"], workdir: process.cwd() })
    .then(r => console.log(r));
'
```
