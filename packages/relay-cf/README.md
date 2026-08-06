# inzo-relay-cf

The Inzo relay ported to Cloudflare Workers + Durable Objects — a free,
always-on alternative to `packages/relay` (Node/Express/`better-sqlite3` on
Fly or Render).

## Why this exists

`packages/relay`'s free hosting options both have a real tradeoff at
hackathon scale (~100 concurrent pairings): Render's free tier is one thin
shared process, which is the wrong failure mode for a live event. Fly avoids
that but requires card verification. Durable Objects (SQLite-backed) are
free with no card, isolate each pairing into its own object (so no shared
process is a bottleneck or a leak point), and don't sleep the way Render's
free tier does.

## Architecture

- **`Registry`** — one global Durable Object (`idFromName("registry")`).
  Owns the issuer's Ed25519 signing key, credential issuance/revocation, v2
  bearer tokens, and pairing codes before a pairing exists. A faithful port
  of `packages/relay/src/lib/credentialStore.ts`'s SQL surface onto Durable
  Object SQLite storage.
- **`PairingRoom`** — one Durable Object per pairing (`idFromName(pairingId)`).
  Owns everything scoped to that pairing: messages, plans, consent. This is
  a *structurally* stronger isolation guarantee than the single-SQLite-file
  relay, where isolation depends on every query getting its `WHERE
  pairing_id = ?` right — here it's a different object with different
  storage, full stop.
- **`index.ts`** — the only place that speaks HTTP. Resolves auth against
  `Registry`, dispatches the actual operation to the right `PairingRoom`.

The pure protocol logic (`credential.ts`, `scopes.ts`, `consent.ts`,
`errors.ts`, `ids.ts`) is imported directly from `packages/relay/src/lib/` —
not forked — since none of it touches `better-sqlite3` or Express.

## Two real gotchas worth knowing if you touch this code

**RPC error handling.** Cloudflare Workers RPC does **not** preserve custom
fields on a thrown `Error` crossing a Durable Object boundary — only
`name`/`message` survive, and this is true even for a plain object thrown
deliberately (verified empirically, not assumed). `RelayError`/
`CredentialError` carry `.status`/`.code` as real fields the Worker needs, so
every public DO method that can fail **returns** an `RpcResult<T>` (see
`rpcError.ts`) instead of throwing — returned values structured-clone fully;
thrown ones don't. The Worker calls `unwrap()` to turn a failed result back
into a real throw on its own side of the boundary, where duck-typing
status/code works fine (same realm, no second RPC hop).

**Ed25519 JWK reconstruction is broken on this runtime.** `createPublicKey({
key: jwk, format: "jwk" })` for an Ed25519 OKP JWK silently reconstructs a
*different* key than the one exported — same shape, wrong bytes, so a real
signature made with the matching private key fails to verify. This is a
`nodejs_compat` bug, not ours (confirmed: the same round-trip is correct on
real Node.js). It broke every v3 signed-credential check on this relay until
found — `fromJwk()` in `packages/relay/src/lib/credential.ts` now builds the
Ed25519 SPKI DER by hand from the JWK's raw `x` bytes instead of using the
JWK import path, which is verified to round-trip correctly on both runtimes.
Never reintroduce a direct `createPublicKey({format:"jwk"})` call for an
Ed25519 key anywhere in this codebase — always go through `fromJwk()`.

## What's ported vs. not

**Ported, tested, working:** pairing (create/join), `GET /pairings/mine`
(poll for join + peer scope/revocation state) and `POST /pairings/mine/scope`
(narrow this side's own capabilities), v2 bearer auth, v3 signed credentials
+ proof of possession + attenuation, messages, the **live SSE stream**
(`GET /pairings/:id/stream` — this is what makes `inzo watch` real instead
of a polling loop; pushes `message.created`/`plan.updated`/`usage.reported`/
`budget.updated`/`pairing.revoked` to connected watchers, EventSource-
compatible query-string auth included), the bounded-cost digest endpoint
(includes usage/runway), plans, consent (signed approval + hash integrity
check), budget/usage/runway tracking, the hash-chained audit log
(append/list/verify — `GET /pairings/:id/audit`), revocation (self/peer,
cascades to credential + consent withdrawal + a live-closed stream + a
`credential.revoked` audit entry), pairing-code join rate limiting (in-memory
sliding window in `Registry`, since it's the one instance every join request
already passes through), JWKS + revocation-list well-known endpoints, issuer
key rotation (`POST /admin/rotate-key`, gated by the `INZO_ADMIN_TOKEN`
secret).

Nothing is currently un-ported. If you add a feature to `packages/relay`,
check whether it needs a matching port here too — a first review pass after
the initial port found the SSE stream, `/pairings/mine`, scope narrowing,
and join rate limiting all missing despite the relay otherwise looking
complete, so don't assume parity without actually diffing the route tables.

### Setting up key rotation

Rotation has no persistent host to gate a CLI command behind the way
`packages/relay`'s does, so the equivalent here is a secret only the person
who deployed this Worker holds:

```bash
npx wrangler secret put INZO_ADMIN_TOKEN   # paste a long random value
```

```bash
curl -X POST https://<your-worker>.workers.dev/admin/rotate-key \
  -H "Authorization: Bearer <the token you set>"
```

The old key stays published in the JWKS until nothing it signed can still be
alive — rotating does not log anyone out.

## Development

```bash
npm test          # vitest against a local Workers runtime — no auth needed
npm run typecheck
npx wrangler dev   # local dev server
npx wrangler deploy --dry-run  # validates the bundle without touching your account
```

Deploying for real needs `npx wrangler login` (opens a browser, free Workers
plan, no card) and then `npm run deploy`.
