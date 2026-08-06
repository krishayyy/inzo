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

## A real gotcha worth knowing if you touch this code

Cloudflare Workers RPC does **not** preserve custom fields on a thrown
`Error` crossing a Durable Object boundary — only `name`/`message` survive,
and this is true even for a plain object thrown deliberately (verified
empirically, not assumed). `RelayError`/`CredentialError` carry `.status`/
`.code` as real fields the Worker needs, so every public DO method that can
fail **returns** an `RpcResult<T>` (see `rpcError.ts`) instead of throwing —
returned values structured-clone fully; thrown ones don't. The Worker calls
`unwrap()` to turn a failed result back into a real throw on its own side of
the boundary, where duck-typing status/code works fine (same realm, no
second RPC hop).

## What's ported vs. not

**Ported, tested, working:** pairing (create/join), v2 bearer auth, v3
signed credentials + proof of possession + attenuation, messages, the
bounded-cost digest endpoint (now includes usage/runway), plans, consent
(signed approval + hash integrity check), budget/usage/runway tracking,
revocation (self/peer, cascades to credential + consent withdrawal), JWKS +
revocation-list well-known endpoints.

**Not yet ported — real, documented gaps, not silent omissions:**
- The hash-chained audit log (`packages/relay`'s `audit.ts`) — `get_audit_log`
  will 404 against this relay until it's ported.
- Issuer key rotation as an operator command (exists in `packages/relay`'s CLI; not wired up here yet)

## Development

```bash
npm test          # vitest against a local Workers runtime — no auth needed
npm run typecheck
npx wrangler dev   # local dev server
npx wrangler deploy --dry-run  # validates the bundle without touching your account
```

Deploying for real needs `npx wrangler login` (opens a browser, free Workers
plan, no card) and then `npm run deploy`.
