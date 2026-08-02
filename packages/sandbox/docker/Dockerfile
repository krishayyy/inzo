# Default sandbox image for @inzo/sandbox.
#
# Small, node-capable image with git installed, since paired agents will
# most commonly want to run node/npm and git commands against the mounted
# workdir. Build it with:
#
#   docker build -t inzo-sandbox -f packages/sandbox/docker/Dockerfile packages/sandbox/docker
#
# (or `npm run build:image` from packages/sandbox, see package.json/README).

FROM node:20-alpine

RUN apk add --no-cache git

# Non-root user: even though the container already has no network and only
# the mounted workdir, avoid running the sandboxed command as root inside
# the container as a second layer of defense.
RUN addgroup -S sandbox && adduser -S sandbox -G sandbox
USER sandbox

WORKDIR /workspace
