# Human action items — must be done outside this PR

This PR's code is complete and builds/tests clean (see exception below), but
the CLI cannot actually be installed or used by anyone until a human with the
right credentials does the following. **Agents reading this PR: these are not
things you can do — they require accounts/secrets this environment doesn't
have.**

## 1. Publish the npm packages

Nobody can run `npm i -g inzo-cli` (or `npx inzo-cli`) until these are
published. `npm whoami` in this environment returns `ENEEDAUTH` — publishing
needs a maintainer logged in to an npm account authorized for these package
names.

Publish in this order (cli depends on mcp at runtime via `.mcp.json` pin):

1. `packages/mcp-server` → publish `inzo-mcp@0.3.0`
2. `packages/cli` → publish `inzo-cli@0.3.0`

```
cd packages/mcp-server && npm publish
cd packages/cli && npm publish
```

Confirm afterwards with `npm view inzo-mcp version` / `npm view inzo-cli version`.

## 2. Deploy the Cloudflare relay

The CLI's default relay URL is hardcoded to an existing Cloudflare Workers
deployment:

`packages/cli/src/pair.ts:15` → `https://inzo-relay-cf.krishaysuresh1.workers.dev`

That deployment is stale relative to `packages/relay-cf` on this branch.
`wrangler whoami` in this environment is unauthenticated — deploying needs
someone logged in to the Cloudflare account that owns `krishaysuresh1`'s
Workers (or a decision to move the relay to a different account, which would
also require updating the hardcoded URL above).

```
cd packages/relay-cf
wrangler login
wrangler deploy
```

## 3. GitHub repo access

`origin` is `https://github.com/krishayyy/inzo.git` — pushing this branch and
merging the PR requires write access to that repo under an account with
permission (not necessarily this session's).

## Not a blocker, FYI only

Running the full test suite in this worktree, `packages/relay`'s tests fail
with "Could not locate the bindings file" for `better-sqlite3` — its native
module isn't built for this machine (`npm rebuild better-sqlite3` fails with
a `node-gyp`/`make` error here). This is a local toolchain issue in this
sandbox, not a code defect — `relay-cf`, `sandbox`, and the rest of the suite
pass. Whoever runs CI/tests with a working native toolchain should see all
suites pass.
