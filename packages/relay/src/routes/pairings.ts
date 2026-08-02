import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { badRequest, rateLimited, RelayError } from "../lib/errors.js";
import { FailureLimiter } from "../lib/rateLimit.js";
import { parseCnf } from "../lib/credential.js";
import type { RelayStore } from "../lib/store.js";

export function pairingsRouter(store: RelayStore, limiter = new FailureLimiter()): Router {
  const router = Router();

  // POST /pairings — create a short-lived pairing code and issue the creator's
  // credential. The token is returned exactly once and never retrievable again.
  router.post("/", (req, res) => {
    // `cnf` is the caller's locally-generated Ed25519 public key. Supply it and
    // you get a signed v3 credential bound to a key we never see; omit it and
    // you get a v2 bearer token, which cannot give consent.
    const cnf = req.body?.cnf === undefined ? undefined : parseCnf(req.body.cnf);
    const pairingCode = store.createPairingCode(cnf);
    res.status(201).json({
      code: pairingCode.code,
      expiresAt: pairingCode.expiresAt,
      agentId: pairingCode.creatorAgentId,
      principalId: pairingCode.principalId,
      credential: pairingCode.credential,
      agentToken: pairingCode.agentToken,
      scope: pairingCode.scope,
      cap: pairingCode.scope,
      pairingId: null,
    });
  });

  // POST /pairings/:code/join — consume a code, create the pairing, issue the
  // joiner's credential.
  //
  // Only FAILED attempts count against the limiter: a code is one-shot, so a
  // successful join cannot be replayed anyway, and penalizing success would
  // punish a team pairing repeatedly from one room's NAT address.
  router.post("/:code/join", (req, res, next) => {
    const key = req.ip ?? "unknown";
    if (limiter.isLimited(key)) {
      return next(rateLimited("Too many failed pairing-code attempts. Wait a few minutes and try again."));
    }
    try {
      const cnf = req.body?.cnf === undefined ? undefined : parseCnf(req.body.cnf);
      const pairing = store.joinPairing(req.params.code, cnf);
      limiter.clear(key);
      res.status(201).json({
        pairingId: pairing.id,
        agentId: pairing.agentB,
        principalId: pairing.principalId,
        credential: pairing.credential,
        agentToken: pairing.agentToken,
        scope: pairing.scope,
        cap: pairing.scope,
        peerAgentId: pairing.peerAgentId,
      });
    } catch (err) {
      if (err instanceof RelayError && [404, 409, 410].includes(err.status)) limiter.recordFailure(key);
      next(err);
    }
  });

  // GET /pairings/mine — the creator polls this after sharing their code to
  // learn when someone joined. Replaces v1's lookup-by-code, which let anyone
  // holding a code read pairing metadata. `pairing` is null (with 200, not
  // 404) while the code is unjoined — "nobody has joined yet" is an expected
  // polling state, not an error.
  router.get("/mine", requireAuth(store), (req, res) => {
    const identity = req.inzoAuth!;
    if (!identity.pairingId) {
      res.json({ pairing: null });
      return;
    }
    const pairing = store.getPairing(identity.pairingId);
    const peerAgentId = store.otherAgent(pairing, identity.agentId);
    res.json({
      pairing: {
        id: pairing.id,
        agentId: identity.agentId,
        peerAgentId,
        createdAt: pairing.createdAt,
        budget: store.getBudget(pairing.id),
        scope: identity.scope,
        // Exposed so this side can refuse peer-originated work the peer's own
        // credential does not authorize — e.g. never run a shared command from
        // a peer whose token no longer carries `commands:run`.
        peerScope: store.getAgentScope(peerAgentId),
        revoked: Boolean(identity.revokedAt),
        peerRevoked: store.isAgentRevoked(peerAgentId),
      },
    });
  });

  // POST /pairings/mine/scope — permanently narrow this credential's own
  // capabilities. Not under /:id because a creator can narrow before anyone
  // has joined, when there is no pairing id yet.
  router.post("/mine/scope", requireAuth(store), (req, res) => {
    const { scope } = req.body ?? {};
    if (scope === undefined) throw badRequest("scope is required (an array of capabilities to keep)");
    res.json({ scope: store.narrowScope(req.inzoAuth!.agentId, scope) });
  });

  // POST /pairings/:id/revoke — the kill switch. Either side can cut either
  // credential off immediately, without the other party's cooperation.
  router.post("/:id/revoke", requireAuth(store), (req, res) => {
    const { target } = req.body ?? {};
    if (target !== "self" && target !== "peer") {
      throw badRequest('target must be "self" or "peer"');
    }
    res.json({ revocation: store.revokeAgent(req.params.id, req.inzoAuth!.agentId, target) });
  });

  return router;
}
