import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { badRequest, rateLimited, RelayError } from "../lib/errors.js";
import { FailureLimiter } from "../lib/rateLimit.js";
import { parseCnf } from "../lib/credential.js";
import { InvalidSessionDescriptorError, validateSessionDescriptor } from "inzo-protocol";
import type { RelayStore } from "../lib/store.js";

export function pairingsRouter(store: RelayStore, limiter = new FailureLimiter()): Router {
  const router = Router();

  // POST /pairings — create a short-lived pairing code and issue the creator's
  // credential. The token is returned exactly once and never retrievable again.
  router.post("/", (req, res, next) => {
    // `cnf` is the caller's locally-generated Ed25519 public key. Supply it and
    // you get a signed v3 credential bound to a key we never see; omit it and
    // you get a v2 bearer token, which cannot give consent.
    const cnf = req.body?.cnf === undefined ? undefined : parseCnf(req.body.cnf);
    // The descriptor attaches to the CODE, not the pairing: no pairing exists
    // yet, but the joiner needs to know what to clone the moment they join.
    let session = null;
    try {
      session =
        req.body?.session === undefined || req.body?.session === null
          ? null
          : validateSessionDescriptor(req.body.session);
    } catch (err) {
      if (err instanceof InvalidSessionDescriptorError) return next(badRequest(err.message));
      return next(err);
    }
    const pairingCode = store.createPairingCode(cnf, session);
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
      session: pairingCode.session,
    });
  });

  // POST /pairings/:code/join — consume a code. Either creates the pairing
  // (bootstrap code from POST /pairings) or adds the caller as a member of an
  // existing pairing (invite code from POST /pairings/:id/invite). Issues the
  // joiner's credential either way.
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
        agentId: pairing.members[pairing.members.length - 1],
        principalId: pairing.principalId,
        credential: pairing.credential,
        agentToken: pairing.agentToken,
        scope: pairing.scope,
        cap: pairing.scope,
        peerAgentId: pairing.peerAgentId,
        members: pairing.members,
        session: pairing.session,
      });
    } catch (err) {
      if (err instanceof RelayError && [404, 409, 410].includes(err.status)) limiter.recordFailure(key);
      next(err);
    }
  });

  // POST /pairings/:id/invite — mint a fresh one-shot code inviting a 3rd+
  // member into an EXISTING pairing. Any current member may invite; the
  // resulting code is joined the same way as the original bootstrap code.
  router.post("/:id/invite", requireAuth(store), (req, res) => {
    const pairingCode = store.createInviteCode(req.params.id, req.inzoAuth!.agentId);
    res.status(201).json({ code: pairingCode.code, expiresAt: pairingCode.expiresAt });
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
    // "peer" only makes sense for the original 2-member shape; for 3+
    // members use `members` and look up each one's own scope/revoked state.
    const peerAgentId = pairing.members.length === 2 ? store.otherAgent(pairing, identity.agentId) : null;
    res.json({
      pairing: {
        id: pairing.id,
        agentId: identity.agentId,
        members: pairing.members,
        approvalPolicy: pairing.approvalPolicy,
        session: pairing.session,
        peerAgentId,
        createdAt: pairing.createdAt,
        budget: store.getBudget(pairing.id),
        scope: identity.scope,
        // Exposed so this side can refuse peer-originated work the peer's own
        // credential does not authorize — e.g. never run a shared command from
        // a peer whose token no longer carries `commands:run`. Only populated
        // in the 2-member case; for 3+ members, look up each member's scope.
        peerScope: peerAgentId ? store.getAgentScope(peerAgentId) : null,
        revoked: Boolean(identity.revokedAt),
        peerRevoked: peerAgentId ? store.isAgentRevoked(peerAgentId) : null,
        // The N-party form of `peerScope`/`peerRevoked`, and the reason a 3+
        // member pairing can run shared commands at all: without a live
        // per-member scope and revocation check there is nothing to verify a
        // specific member's authority against, and the honest response to an
        // unverifiable check is to refuse. Populated at every size, so the
        // client never has to branch on member count.
        memberDetails: pairing.members.map((memberAgentId) => ({
          agentId: memberAgentId,
          scope: store.getAgentScope(memberAgentId),
          revoked: store.isAgentRevoked(memberAgentId),
        })),
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

  // POST /pairings/:id/revoke — the kill switch. Any member can cut any
  // other credential off immediately, without that party's cooperation.
  // target: "self", "peer" (2-member pairings only), "all" (every other
  // member), or a specific member agentId.
  router.post("/:id/revoke", requireAuth(store), (req, res) => {
    const { target } = req.body ?? {};
    if (typeof target !== "string" || !target.trim()) {
      throw badRequest('target must be "self", "peer", "all", or a member agentId');
    }
    if (target === "all") {
      const pairing = store.getPairing(req.params.id);
      const revocations = pairing.members
        .filter((agentId) => agentId !== req.inzoAuth!.agentId)
        .map((agentId) => store.revokeAgent(req.params.id, req.inzoAuth!.agentId, agentId));
      res.json({ revocations });
      return;
    }
    res.json({ revocation: store.revokeAgent(req.params.id, req.inzoAuth!.agentId, target) });
  });

  return router;
}
