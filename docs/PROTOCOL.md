# Inzo wire protocol (v3.0)

This is the **authoritative contract** between `packages/relay` (server),
`packages/mcp-server` (agent-side client), and `packages/cli` (human-side
live viewer). If an implementation disagrees with this document, the
implementation is wrong. Change this file first, then the code.

---

## Why v3 exists

v1 identified callers by a `fromAgentId` / `agentId` / `proposedBy` field in
the **request body**. That is self-asserted and was trivially forgeable. A
demonstrated attack against v1, knowing only a `pairingId`:

- post messages impersonating a paired agent (a prompt-injection channel
  straight into a teammate's coding agent),
- read the entire private thread,
- forge **both** humans' plan approvals, driving a hostile plan to
  `locked: true` with zero human involvement.

v2 fixed forgery by deriving identity from an opaque bearer token, then added
scope narrowing and revocation. That closed the impersonation hole but left
three structural problems:

1. **The relay is a trusted third party.** Every guarantee — scope,
   revocation, approval — held only because the relay said so. Two parties in
   different organizations had to trust an operator neither of them chose.
2. **Authority could not leave the relay.** An opaque token means nothing to
   anyone else. Nothing could be verified by a third system, offline, or after
   the fact.
3. **Consent was a database row.** `approvedBy: ["agent_x"]` is an assertion by
   the relay, not evidence. It cannot be shown to an auditor, cannot survive
   the relay being wrong or hostile, and cannot be combined with a record kept
   by the other organization.

v3 replaces the opaque bearer token with a **signed, attenuable, holder-bound
capability credential**, and replaces the approval row with a **signed consent
record bound to the hash of the text a human actually read**.

The relay stops being the source of truth and becomes a transport and witness.

### Relationship to prior work

v3's credential model deliberately tracks the requirements in
`draft-reece-wimse-cross-org-delegation` (recursive attenuation, cross-org
verification without bilateral pre-agreement, offline verification, proof of
possession, principal invariance, cross-domain revocation, composable audit).
Where that draft applies, this protocol aims to be a conforming profile rather
than an alternative.

That draft is explicitly scoped to **workload-to-workload** delegation. It does
not address the case where authority must be jointly authorized by **two
humans in different organizations**, where each may withdraw unilaterally, and
where consent must remain attached to the exact artifact each human read.

§6 (Consent) is Inzo's contribution and is the part not covered elsewhere.

---

## 1. Identity model

Three distinct identities. Conflating any two of them is how the v1 attack
worked.

| Identity | Prefix | What it is | Lifetime |
|---|---|---|---|
| **Principal** | `prn_` | The human. The party whose authority is being exercised. | Stable across pairings |
| **Agent** | `agent_` | A software actor acting for exactly one principal. | Per pairing |
| **Credential** | `cred_` | A signed grant of capabilities to one agent. | Minutes |

**A credential never changes its principal.** Attenuation may narrow
capabilities and extend the chain, but `prn` is invariant at every hop. A
verifier that sees `prn` change between a credential and its parent MUST reject
the chain. This is what makes "who authorized this, ultimately?" answerable
from the credential alone.

### 1.1 Credential format

A credential is a compact JWS: `base64url(header).base64url(payload).base64url(signature)`.

Header:

```json
{ "alg": "EdDSA", "typ": "inzo-cred+jws", "kid": "<issuer key id>" }
```

Payload:

```json
{
  "iss": "https://relay.example.com",
  "jti": "cred_9f2a...",
  "sub": "agent_1b8c...",
  "prn": "prn_4d7e...",
  "pairing": "pairing_...",
  "cap": ["messages:read", "messages:send", "plan:propose", "plan:approve",
          "usage:report", "commands:run"],
  "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "<holder public key>" } },
  "chain": [],
  "depth": 0,
  "iat": 1785686400,
  "exp": 1785687300
}
```

- `iss` — the issuing relay. A verifier fetches `${iss}/.well-known/inzo-jwks`
  to resolve `kid` to a public key. This is what removes the pre-agreement
  requirement: any party can verify any credential from any Inzo relay.
- `cnf.jwk` — **proof of possession.** The credential is bound to a key the
  holder generated locally and never transmits. A stolen credential is inert
  without the matching private key.
- `chain` — ordered `jti`s of every ancestor, root first. Empty at depth 0.
- `exp` — **short by design** (default 15 minutes, MUST NOT exceed 1 hour).
  Short lifetime is what makes offline verification safe: a verifier that
  cannot reach the revocation list is wrong for at most one credential
  lifetime. See §4.

`ALL_CAPS` is the closed set above. Unknown capabilities MUST be rejected at
issue and at verification; a credential is not an extension point.

### 1.1.1 Pre-binding credentials

A credential minted by `POST /pairings` is signed before any pairing exists, so
it carries `pairing: null`. The relay resolves the binding at verification time
from the agent's current pairing.

This is deliberately the one authorization fact the relay still supplies, and it
is safe because a pre-binding credential **names no pairing and therefore grants
nothing to a third party**. A cross-organization verifier that receives one MUST
reject it. Everything a peer ever relies on is bound at issue.

Implementations MUST NOT extend this resolution to any other field. In
particular `prn`, `cap`, `chain`, and `exp` are never re-derived server-side —
if they could be, the signature would be decoration.

### 1.2 Proof of possession

Every authenticated request carries two headers:

```
Authorization:     Inzo <credential>
Inzo-Proof:        <base64url signature>
Inzo-Proof-At:     <unix seconds>
Inzo-Proof-Nonce:  <fresh random string, per request>
```

`Inzo-Proof` is the holder key's Ed25519 signature over the canonical string:

```
<method> "\n" <path> "\n" <credential jti> "\n" <unix seconds> "\n" <sha256 hex of body, or "" if no body> "\n" <nonce>
```

`<path>` excludes the query string. `<method>` is uppercased before signing, so
casing can never be the reason a valid request fails.

The relay MUST reject a proof whose timestamp is more than **300 seconds** from
its own clock, and MUST reject a **proof signature** it has already accepted
within that window.

**Why the nonce is required.** The replay key is the signature itself, not
`(jti, timestamp, path)`. Without a nonce, two legitimate identical requests —
same credential, same path, same second, no body, which is exactly what
repeated reads look like — would produce byte-identical signatures and the
second would be refused. That is a liveness failure wearing a security
property's clothes. The nonce makes every genuine request distinct while
leaving an actual replay, which repeats the whole header set verbatim,
detectable.

Clients MUST generate a fresh nonce per request from a cryptographically
secure source. A relay MUST NOT accept a request whose nonce it has already
seen inside the window, and MAY reject an absent nonce.

Binding the body hash into the proof is what stops a network intermediary from
altering a plan proposal in flight while keeping a valid credential attached.

> **Compatibility.** A relay MAY continue to accept v2 opaque bearer tokens
> during migration. Where it does, it MUST mark every resulting audit record
> `assurance: "bearer"` rather than `"pop"`, because a bearer token cannot
> prove possession and therefore cannot support non-repudiation. Consent
> approvals (§6) MUST NOT be accepted from a bearer credential.

---

## 2. Capabilities and attenuation

```
messages:read  messages:send  plan:propose  plan:approve  usage:report  commands:run
```

A root credential is issued holding all six. Any holder may **attenuate**:
produce a child credential with a subset of its own capabilities.

`POST /credentials/attenuate`

Request:
```json
{ "cap": ["messages:read", "messages:send"], "cnf": { "jwk": { ... } }, "ttl": 900 }
```

Response `201`:
```json
{ "credential": "eyJhbGc...", "jti": "cred_...", "expiresAt": "..." }
```

Rules, all enforced at issue **and** re-checked by any offline verifier:

1. **Monotonic narrowing.** `child.cap ⊆ parent.cap`. A request naming a
   capability the parent does not hold is rejected `400`. There is no widening
   operation at any depth.
2. **Principal invariance.** `child.prn == parent.prn`, always.
3. **Chain extension.** `child.chain = parent.chain ++ [parent.jti]`,
   `child.depth = parent.depth + 1`.
4. **Depth limit.** `depth <= 4`. Deeper chains are rejected — an unbounded
   delegation chain is an unbounded audit problem.
5. **Lifetime narrowing.** `child.exp <= parent.exp`. A child can never outlive
   its parent.

Rule 1 is the entire point of the capability system. Without an enforced subset
check, "capabilities" would be decoration that any holder could reset by
reissuing itself the full list. With it, a human who strips `plan:approve` gets
a real guarantee: their agent **cannot** record an approval on their behalf,
however it is prompted, and that guarantee is verifiable by the other
organization without asking the relay.

### 2.1 Verification algorithm (normative)

Given a credential `C` and the current time `now`, a verifier MUST:

1. Parse the JWS. Reject unless `alg == "EdDSA"` and `typ == "inzo-cred+jws"`.
2. Resolve `kid` against `${iss}/.well-known/inzo-jwks`. Reject if unknown.
3. Verify the signature. Reject on failure.
4. Reject if `now >= exp` or `now < iat - 60` (clock skew allowance).
5. Reject if any entry of `cap` is outside `ALL_CAPS`.
6. Reject if `depth != len(chain)` or `depth > 4`.
7. For each ancestor `A` in `chain`, if `A` is present in the verifier's
   revocation set, reject.
8. Reject if `jti` is in the revocation set.
9. If a parent credential is available, reject unless
   `cap ⊆ parent.cap`, `prn == parent.prn`, and `exp <= parent.exp`.
10. Verify `Inzo-Proof` against `cnf.jwk` per §1.2.

Steps 1–8 require no network call beyond a cacheable JWKS and revocation list.
That is the offline-verification property.

---

## 3. Pairing

Codes are `INZO-` + 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
(no `I`/`O`/`0`/`1`, which people mistype reading a code aloud at a table).
32^6 ≈ 1.07e9. Codes expire 15 minutes after creation and are single-use. The
relay rate-limits join attempts: 10 failures from one IP in 10 minutes ⇒
`429 rate_limited`.

### `POST /pairings`

Unauthenticated. Creates a pairing code, mints a principal, and issues the
creator's root credential.

Request:
```json
{ "cnf": { "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." } } }
```

The caller generates its holder keypair locally and sends only the public key.
A request without `cnf` is rejected `400 pop_required`.

Response `201`:
```json
{
  "code": "INZO-K7M4QX",
  "expiresAt": "2026-08-02T00:15:00.000Z",
  "principalId": "prn_...",
  "agentId": "agent_9f2a...",
  "credential": "eyJhbGc...",
  "cap": ["messages:read", "messages:send", "plan:propose", "plan:approve", "usage:report", "commands:run"],
  "pairingId": null
}
```

### `POST /pairings/:code/join`

Unauthenticated. Consumes the code, creates the pairing, mints the joiner's
principal and root credential. Same `cnf` requirement.

Response `201` adds `pairingId` and `peerAgentId`.

Errors: `404 not_found`, `409 conflict` (already used), `410 gone` (expired),
`429 rate_limited`.

### `GET /pairings/mine`

Authenticated. `pairing` is `null` with `200` (not `404`) while the code is
still unjoined — "nobody has joined yet" is an expected polling state, not an
error. Includes `peerCap` and `peerRevoked` so a client can fail closed on
peer-originated work without waiting for the relay to reject it.

---

## 4. Revocation

Either principal may revoke either credential, immediately and without the
other party's cooperation — the situation you need a kill switch for is exactly
the one where the peer will not cooperate.

### `POST /pairings/:id/revoke`

Request: `{ "target": "peer" | "self" }`

Response `200`:
```json
{
  "revocation": {
    "revokedAgentId": "agent_1b8c...",
    "revokedCredentials": ["cred_...", "cred_..."],
    "revokedAt": "...",
    "by": "prn_9f2a...",
    "signature": "<relay Ed25519 signature over the record>"
  }
}
```

Revoking an agent revokes **every credential in its subtree** — the root and
everything attenuated from it. Because each credential carries its full
ancestor `chain`, a descendant is detectable as revoked by a verifier that
knows only the revoked ancestor's `jti`. Revocation therefore propagates
without the verifier enumerating descendants.

Revocation is one-way and idempotent; re-revoking returns the original
`revokedAt`. There is no un-revoke — re-pair instead. That keeps "revoked" a
terminal state an auditor can trust.

A revoked credential fails **every** authenticated route with `401 revoked`,
including reads, and an open SSE stream held by that credential is closed
server-side.

### `GET /.well-known/inzo-revocations`

Unauthenticated, cacheable. The signed revocation set for this issuer.

```json
{
  "issuer": "https://relay.example.com",
  "issuedAt": "...",
  "expiresAt": "...",
  "revoked": [ { "jti": "cred_...", "revokedAt": "..." } ],
  "signature": "..."
}
```

Verifiers SHOULD refresh at `expiresAt` (default 60s). Combined with a 15
minute credential TTL, a fully offline verifier is wrong for at most one
credential lifetime — which is why §1.1 caps `exp`.

### `GET /.well-known/inzo-jwks`

Unauthenticated, cacheable. The issuer's public signing keys.

The set contains the **active** key and any **retired** keys that could still
appear in an unexpired credential. Verifiers MUST resolve `kid` against the
whole set, not against "the newest key" — see §4.1.

### 4.1 Key rotation

An issuer MAY rotate its signing key at any time. Rotation is deliberately not
a network route: it is an operator command (`inzo-relay rotate-key`), because
giving the most powerful operation on the relay an HTTP surface means giving it
an authorization story and a new way to be wrong, and host access already
implies strictly more authority than the command grants.

Rules:

1. Signing switches to the new key immediately. Credentials issued after
   rotation carry the new `kid`.
2. The previous key is marked retired but **stays published** in the JWKS.
   Credentials it signed remain valid until their own `exp`. Rotation is not a
   mass invalidation event — an issuer that cannot rotate without logging
   everyone out will never rotate.
3. A retired key MAY be dropped from the JWKS once it has been retired for
   longer than `MAX_TTL` (§1.1), at which point no credential it signed can
   still be alive.
4. Rotation does not change what any credential is allowed to do. It is a
   change of signer, not of authority.
5. Verifiers cache the JWKS. After rotating, an issuer SHOULD assume peers have
   the old set for at least their cache TTL.

Rotation never widens the trusted set beyond keys this issuer actually held: a
credential signed by an unknown `kid` is rejected before and after rotation
alike.

---

## 5. Messages, plans, budget, usage

Unchanged from v2 in shape. Every route is authenticated per §1.2 and gated on
the capability named below.

| Route | Capability |
|---|---|
| `POST /pairings/:id/messages` | `messages:send` |
| `GET /pairings/:id/messages?since=` | `messages:read` |
| `GET /pairings/:id/stream` | `messages:read` |
| `POST /pairings/:id/plan` | `plan:propose` |
| `POST /pairings/:id/plan/approve` | `plan:approve` |
| `PUT /pairings/:id/budget` | `usage:report` |
| `POST /pairings/:id/usage` | `usage:report` |

Request bodies **must not** carry `agentId`, `fromAgentId`, `proposedBy`, or
`principalId`. The server derives all of them from the credential. A body
containing them is rejected `400 identity_not_allowed` — failing loudly beats
silently ignoring a field a caller believes is authoritative.

Message `cursor` is a monotonically increasing integer, distinct from
`createdAt` (two messages can share a millisecond, never a cursor).

Usage reports are **cumulative totals per agent, not deltas** — this makes a
dropped or duplicated report harmless, which a delta model would not.

`runway` rules: any field whose budget is unset is `null`, never guessed; burn
is computed over each agent's `wallClockMs`, not wall-clock since pairing
creation; burn requires ≥2 reports from an agent, else `null` rather than
extrapolating from one point; `onTrack` is `false` when a projected exhaustion
lands before `deadline`; `verdict` is one advisory sentence, never a guarantee.

### 5.1 SSE stream

`GET /pairings/:id/stream` — `text/event-stream`.

Because `EventSource` cannot set headers, this endpoint additionally accepts
`?credential=`, `?proof=`, `?proofAt=`, and `?proofNonce=`. Query-string
credentials can leak via logs and `Referer`, so the relay MUST NOT log query
strings on this route, and the proof timestamp window is tightened to 60
seconds here. The proof is computed over the path only, excluding the query
string it travels in.

| event | data |
|---|---|
| `ready` | `{ pairingId, agentId, at }` — distinguishes "connected, nothing yet" from "still connecting" |
| `message.created` | `{ message }` |
| `plan.updated` | `{ plan }` |
| `consent.updated` | `{ consent }` — see §6 |
| `usage.reported` | `{ usage, runway }` — runway recomputed at emit time, never a stale copy |
| `budget.updated` | `{ budget }` |
| `pairing.revoked` | `{ revocation }` |
| `ping` | `{ t }` — every 25s, keeps proxies from idling the connection |

When `pairing.revoked` names the watching credential itself, the relay emits
the event and then **ends the response**.

---

## 6. Consent

> This section is the part of the protocol not covered by
> `draft-reece-wimse-cross-org-delegation`, which addresses workload-to-workload
> delegation within a chain of authority descending from a *single* principal.
> Here, authority to proceed requires the *joint, independent* authorization of
> **two principals in different organizations**, either of whom may withdraw
> unilaterally.

### 6.1 What a consent record is

A plan is a proposal. A **consent record** is the evidence that specific humans
agreed to a specific artifact.

```json
{
  "pairingId": "pairing_...",
  "subject": {
    "kind": "plan",
    "version": 3,
    "hash": "sha256:2b7d9c..."
  },
  "required": ["prn_4d7e...", "prn_8a1f..."],
  "approvals": [
    {
      "principal": "prn_4d7e...",
      "credential": "cred_...",
      "at": "2026-08-02T10:42:11.000Z",
      "signature": "<holder-key Ed25519 signature over the approval statement>"
    }
  ],
  "satisfied": false,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### 6.2 Binding consent to content, not to a row

`subject.hash` is the SHA-256 of the plan's **canonical serialization**:

```
canonical(plan) = JSON with keys sorted, no insignificant whitespace, over
                  exactly { pairingId, goal, items, version }
```

An approval signature covers the string:

```
"inzo-consent-v3" "\n" <pairingId> "\n" <subject.kind> "\n" <subject.version> "\n" <subject.hash>
```

signed by the approving credential's **holder key** (`cnf.jwk`).

This is the difference between v2 and v3 consent. In v2, "both humans approved"
was a claim by the relay. In v3 it is a signature, made by a key the relay
never held, over a hash of the exact bytes the human was shown. A relay that
lies about consent produces a record that fails verification, and any third
party — the other organization, an auditor, a court — can check it without
trusting the relay at all.

### 6.3 Rules

1. **`plan:approve` is required**, and the credential MUST be proof-of-possession
   (`assurance: "pop"`). A bearer credential cannot produce a non-repudiable
   signature and is rejected `403 pop_required_for_consent`.
2. **The version must match.** `POST /plan/approve` requires `planVersion` and
   rejects a mismatch `409 stale_plan`. This closes a real race: A reads plan
   v1 and decides to approve; B silently re-proposes v2; A's approval must not
   carry over onto text the human never read.
3. **The hash must match too.** If `planVersion` matches but the recomputed
   `subject.hash` does not, the relay MUST reject `409 stale_plan` and SHOULD
   treat it as an integrity incident. Version alone is a counter and can
   collide across a restore-from-backup; the hash cannot.
4. **Re-proposing destroys consent.** A new proposal increments `version`,
   clears `approvals`, and sets `satisfied: false`. Renegotiating never
   inherits stale consent.
5. **Satisfaction is unanimity over `required`.** `satisfied` becomes `true`
   only when every principal in `required` has a verifying approval. `required`
   is fixed at pairing creation to both principals and cannot be edited.
6. **Withdrawal is unilateral and immediate.** `POST /pairings/:id/consent/withdraw`
   removes that principal's approval and sets `satisfied: false`. It requires
   no cooperation from the peer. A previously-satisfied consent that is
   withdrawn does not un-emit its audit record — the record shows both the
   satisfaction and the withdrawal, in order.
7. **Revocation implies withdrawal.** Revoking a credential withdraws any
   approval made with it.

### 6.4 Endpoints

`POST /pairings/:id/plan/approve` — body `{ "planVersion": 3, "signature": "..." }`
Response `200`: `{ "plan": {...}, "consent": {...} }`

`GET /pairings/:id/consent` — `{ "consent": {...} | null }`

`POST /pairings/:id/consent/withdraw` — `{}` → `200 { "consent": {...} }`

`POST /consent/verify` — unauthenticated. Takes a consent record and returns
per-approval verification results. Exists so a third party can check a record
it was handed out-of-band without trusting this relay's `satisfied` flag.

---

## 7. Audit

Motivated by EU AI Act Article 12 (record-keeping: automatic logging over the
system lifetime, minimum six-month retention) and Article 14 (human oversight:
the ability to monitor, interpret, intervene, and override). Article 26 pushes
these obligations onto deployers, which is what makes an exportable log a
requirement and not a nicety.

### 7.1 Record shape

The audit log is **append-only and hash-chained**.

```json
{
  "seq": 42,
  "at": "2026-08-02T10:42:11.000Z",
  "pairingId": "pairing_...",
  "actor": { "principal": "prn_...", "agent": "agent_...", "credential": "cred_..." },
  "action": "consent.approved",
  "assurance": "pop",
  "detail": { "subjectHash": "sha256:2b7d9c...", "version": 3 },
  "prevHash": "sha256:00f1...",
  "hash": "sha256:9ab3..."
}
```

`hash = SHA256(prevHash ++ canonical(record without hash))`. The first record
in a pairing uses `prevHash = sha256:` + 64 zeros.

Tampering with, reordering, or deleting any record breaks the chain from that
point forward and is detectable by recomputing it. The relay cannot quietly
rewrite history it already published.

### 7.2 Logged actions

Every one of these MUST produce a record:

```
pairing.created      pairing.joined       credential.issued
credential.attenuated credential.revoked  plan.proposed
consent.approved     consent.withdrawn    consent.satisfied
command.requested    command.executed     command.refused
scope.narrowed       stream.opened        stream.closed
```

### 7.3 Export

`GET /pairings/:id/audit?since=<seq>` — authenticated, requires `messages:read`.

```json
{
  "records": [ ... ],
  "chainValid": true,
  "issuer": "https://relay.example.com",
  "signature": "<relay signature over the head hash>"
}
```

The relay signs the **head hash**, not each record — one signature commits to
the entire prefix.

### 7.4 Composability across organizations

Two organizations keeping independent logs can be reconciled because records
reference globally meaningful identifiers: `prn_`, `cred_`, and `subjectHash`.
A consent event in A's log and the corresponding event in B's log name the same
`subjectHash` and the same principals, so an incident reconstruction can
interleave both without either side trusting the other's relay. This is the
`composable audit` requirement (R7).

### 7.5 Retention

Records are retained a minimum of **180 days** (Article 12). `INZO_AUDIT_RETENTION_DAYS`
may raise this; a relay MUST refuse to start if configured below 180 while
`INZO_COMPLIANCE_MODE=eu-ai-act`.

---

## 8. Sandbox boundary

`packages/mcp-server` exposes `run_shared_command`. **Every** command it runs
goes through `@inzo/sandbox` (Docker, `--network none`, capabilities dropped,
non-root, resource-limited, timeout-enforced) against an explicitly chosen
working directory.

Rules:

- Never execute a shared command outside the sandbox, for any reason. There is
  deliberately no host-execution path to reach, so a mis-set flag cannot open
  one.
- Sandbox unavailable (Docker missing or not running) ⇒ **refuse and say so**.
  Never silently fall back to host execution. Emit `command.refused`.
- The working directory is chosen by the local human via `INZO_WORKSPACE`,
  never by the peer, and never defaults. `$HOME`, `/`, and any directory
  containing `$HOME` are rejected outright: the sandbox only protects what it
  does not mount, so a convenient default would hand a peer's agent everything
  the user owns.
- The tool's `origin` argument defaults to `"peer"`, the stricter path, which
  additionally requires the peer's live credential to still carry
  `commands:run` and to not be revoked. Because the flag can only *add*
  restrictions, getting it wrong can never weaken the boundary.
- A peer-originated command MUST additionally require `consent.satisfied` for
  the current plan version. An agent may not act on a plan its humans have not
  both approved.

---

## 9. Errors

| Condition | Status | `error.code` |
|---|---|---|
| Missing/malformed credential | 401 | `unauthenticated` |
| Credential signature invalid | 401 | `unauthenticated` |
| Credential expired | 401 | `credential_expired` |
| Credential revoked | 401 | `revoked` |
| Missing/invalid `Inzo-Proof` | 401 | `proof_invalid` |
| Missing `Inzo-Proof-Nonce` | 401 | `proof_invalid` |
| Proof timestamp outside window | 401 | `proof_stale` |
| Proof replayed | 401 | `proof_replayed` |
| Valid credential, wrong pairing in URL | 403 | `forbidden` |
| Credential lacks the capability | 403 | `insufficient_scope` |
| Consent attempted with a bearer credential | 403 | `pop_required_for_consent` |
| Identity field present in body | 400 | `identity_not_allowed` |
| No `cnf` at issue | 400 | `pop_required` |
| Attenuation would widen | 400 | `bad_request` |
| Depth limit exceeded | 400 | `depth_exceeded` |
| Approval names a stale version or hash | 409 | `stale_plan` |
| Too many failed code-join attempts | 429 | `rate_limited` |

Envelope, unchanged since v1: `{ "error": { "code": "...", "message": "..." } }`.

---

## 10. Session file

`~/.inzo/session.json`, mode `0600` inside a `0700` directory, written by
`packages/mcp-server` so `packages/cli` can attach to the same pairing without
re-pairing.

```json
{
  "relayUrl": "http://localhost:8787",
  "pairingId": "pairing_...",
  "principalId": "prn_...",
  "agentId": "agent_...",
  "credential": "eyJhbGc...",
  "holderPrivateKey": "<PKCS8 PEM>",
  "cap": ["messages:read", "messages:send"],
  "updatedAt": "..."
}
```

The **holder private key never leaves this file** and is never transmitted,
logged, or echoed in a tool result. It is the thing that makes a consent
signature non-repudiable; if it leaks, consent made with it is worthless.

The CLI reads this file and never accepts a credential as an argv flag, since
argv is visible to other processes via `ps`.

---

## 11. Threat model

What v3 defends against, and what it does not.

**Defended:**

| Threat | Mechanism |
|---|---|
| Peer impersonation | Credential signature + proof of possession (§1.2) |
| Stolen credential replayed | `cnf` holder key; attacker lacks the private key |
| Request tampering in flight | Body hash bound into `Inzo-Proof` |
| Privilege escalation by an agent | Monotonic narrowing, re-checked offline (§2.1) |
| Consent forged by the relay | Approvals signed by holder keys the relay never has (§6.2) |
| Approval carried onto swapped text | Version **and** content hash binding (§6.3) |
| Uncooperative peer | Unilateral revocation and withdrawal (§4, §6.3.6) |
| Silent history rewriting | Hash-chained audit log (§7.1) |
| Prompt injection via peer messages | Peer content is untrusted input, never instructions; peer commands additionally gated on live `commands:run` and satisfied consent (§8) |

**Not defended:**

- **A compromised holder key.** Equivalent to full control of that principal's
  side. Treat `~/.inzo/session.json` like a password.
- **A relay that refuses service.** v3 removes the relay's ability to *lie*
  about authority or consent. It does not remove its ability to drop messages
  or stall. Availability still requires trusting the operator.
- **A malicious agent within its granted capabilities.** If a human grants
  `commands:run`, the agent may run any command the sandbox permits. Scope is a
  boundary, not a judgment.
- **The model's own reasoning.** Defense against an agent being argued into a
  bad plan is complementary and out of scope; the consent gate exists precisely
  because that defense cannot be complete.

---

## 12. Conformance

An implementation is v3-conformant if it:

1. Issues only credentials with `cnf`, `prn`, `chain`, `depth`, and `exp <= 1h`.
2. Enforces §2.1 steps 1–10 on every authenticated request.
3. Rejects attenuation that widens `cap`, changes `prn`, increases `exp`, or
   exceeds `depth` 4.
4. Serves `/.well-known/inzo-jwks` and `/.well-known/inzo-revocations`, both
   signed and cacheable.
5. Accepts consent approvals only from proof-of-possession credentials holding
   `plan:approve`, and only when both `planVersion` and `subject.hash` match.
6. Sets `satisfied` only on unanimity over `required`.
7. Honours unilateral revocation and withdrawal without peer cooperation.
8. Appends a hash-chained audit record for every action in §7.2 and can export
   a verifiable chain.
9. Never executes a shared command outside the sandbox, and refuses when the
   sandbox is unavailable.

`packages/relay/src/test` is the executable form of this list.
