/**
 * The v3 trust surface — PROTOCOL.md §2, §4, §6, §7.
 *
 * Two of these routes are deliberately unauthenticated. `/.well-known/*` has
 * to be, or cross-organization verification would require an account with us,
 * which is precisely the pre-agreement the design exists to remove.
 * `/consent/verify` has to be, or checking a consent record would mean
 * trusting the relay whose honesty is the thing being checked.
 */

import { Router, type RequestHandler } from "express";
import { requireScope } from "../lib/auth.js";
import { parseCnf } from "../lib/credential.js";
import { verifyConsentRecord, type ConsentRecord } from "../lib/consent.js";
import { badRequest, forbidden, notFound, popRequiredForConsent } from "../lib/errors.js";
import type { RelayStore } from "../lib/store.js";
import type { Jwk } from "../lib/credential.js";

type PairingParams = { id: string };

/** Unauthenticated, cacheable discovery. */
export function wellKnownRouter(store: RelayStore): Router {
  const router = Router();

  router.get("/inzo-jwks", (_req, res) => {
    // Public keys only, and they rotate rarely — a minute of caching costs
    // nothing and keeps a busy verifier off our critical path.
    res.set("cache-control", "public, max-age=300").json(store.credentials.jwks());
  });

  router.get("/inzo-revocations", (_req, res) => {
    const list = store.credentials.revocationList();
    // Short cache on purpose: combined with the 15-minute credential TTL, an
    // offline verifier is wrong for at most one credential lifetime (§4).
    res.set("cache-control", "public, max-age=60").json(list);
  });

  return router;
}

/** `POST /credentials/attenuate` — §2. Narrowing only, always. */
export function credentialsRouter(store: RelayStore): Router {
  const router = Router();

  router.post("/attenuate", (req, res) => {
    const auth = req.inzoAuth!;
    if (!auth.credential) {
      throw badRequest("Attenuation requires a v3 credential; a bearer token has no chain to extend");
    }
    const { cap, cnf, ttl } = req.body ?? {};
    if (cap === undefined) throw badRequest("cap is required (the capabilities to keep)");

    const issued = store.credentials.attenuateFrom(auth.credential, {
      cap,
      cnf: parseCnf(cnf),
      ttlSeconds: typeof ttl === "number" ? ttl : undefined,
    });

    if (auth.pairingId) {
      store.credentials.record(auth.pairingId, "credential.attenuated", store.credentials.actorFrom(auth.credential), "pop", {
        child: issued.payload.jti,
        cap: issued.payload.cap,
        depth: issued.payload.depth,
      });
    }

    res.status(201).json({
      credential: issued.credential,
      jti: issued.payload.jti,
      cap: issued.payload.cap,
      depth: issued.payload.depth,
      expiresAt: new Date(issued.payload.exp * 1000).toISOString(),
    });
  });

  return router;
}

/** `/pairings/:id/consent` — §6. */
export function consentRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const get: RequestHandler<PairingParams> = (req, res) => {
    res.json({ consent: store.credentials.getConsent(req.params.id) });
  };

  const withdraw: RequestHandler<PairingParams> = (req, res) => {
    const auth = req.inzoAuth!;
    // Withdrawal changes whether work may proceed, so it needs the same
    // assurance that granting it did.
    if (auth.assurance !== "pop") throw popRequiredForConsent();
    if (!auth.principalId) throw forbidden("This credential has no principal to withdraw for");
    const record = store.credentials.getConsent(req.params.id);
    if (!record) throw notFound(`No consent record for pairing "${req.params.id}"`);
    res.json({ consent: store.withdrawConsent(req.params.id, auth.principalId, auth.agentId) });
  };

  router.get("/", requireScope("messages:read"), get);
  router.post("/withdraw", requireScope("plan:approve"), withdraw);

  return router;
}

/**
 * `POST /consent/verify` — unauthenticated, on purpose.
 *
 * Lets a third party who was handed a consent record out-of-band re-derive
 * `satisfied` from the signatures themselves rather than believing our flag.
 * That independence is the entire reason approvals are signed.
 */
export function consentVerifyRouter(store: RelayStore): Router {
  const router = Router();

  router.post("/verify", (req, res) => {
    const record = req.body?.consent as ConsentRecord | undefined;
    if (!record?.pairingId || !record.subject || !Array.isArray(record.approvals)) {
      throw badRequest("consent must be a consent record with pairingId, subject, required and approvals");
    }

    // Callers may supply the holder keys themselves — the point is that this
    // check does not depend on our storage. We fill in any we happen to know.
    const supplied = new Map<string, Jwk>(Object.entries((req.body?.holderKeys ?? {}) as Record<string, Jwk>));
    const known = store.credentials.holderKeysFor(record.pairingId);
    for (const [jti, jwk] of known) if (!supplied.has(jti)) supplied.set(jti, jwk);

    res.json(verifyConsentRecord(record, supplied));
  });

  return router;
}

/** `GET /pairings/:id/audit` — §7.3. */
export function auditRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const get: RequestHandler<PairingParams> = (req, res) => {
    const since = Number(req.query.since ?? 0);
    const records = store.credentials.audit.list(req.params.id, Number.isFinite(since) ? since : 0);
    const check = store.credentials.audit.verify(req.params.id);
    res.json({
      records,
      chainValid: check.valid,
      brokenAt: check.brokenAt,
      head: check.head,
      issuer: store.credentials.issuerUrl,
    });
  };

  router.get("/", requireScope("messages:read"), get);

  return router;
}
