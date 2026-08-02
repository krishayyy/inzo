# Relay image. The sandbox that runs shared commands is a separate, LOCAL
# concern (see packages/sandbox) — it deliberately never runs on the hosted
# relay, which must not be able to execute anything on anyone's behalf.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/relay/package.json packages/relay/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/cli/package.json packages/cli/
RUN npm ci --workspace inzo-relay --include-workspace-root

COPY packages/relay packages/relay
RUN npm run build --workspace inzo-relay \
  && npm prune --omit=dev --workspace inzo-relay --include-workspace-root

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/relay/node_modules packages/relay/node_modules
COPY --from=build /app/packages/relay/dist packages/relay/dist
COPY --from=build /app/packages/relay/package.json packages/relay/package.json

# The relay holds credentials; it has no reason to be root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8787
ENV INZO_RELAY_DB_PATH=/data/relay.db
# Behind Fly's proxy, so X-Forwarded-For is trustworthy here and the
# pairing-code rate limiter needs it to see real client addresses.
ENV INZO_TRUST_PROXY=true
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/relay/dist/index.js"]
