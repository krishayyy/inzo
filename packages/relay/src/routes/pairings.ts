import { Router } from "express";
import type { RelayStore } from "../lib/store.js";
import { requireAuth } from "../lib/auth.js";

export function pairingsRouter(store: RelayStore): Router {
  const router = Router();

  // POST /pairings — create a short-lived pairing code.
  router.post("/", (req, res) => {
    const pairingCode = store.createPairingCode();
    res.status(201).json({ code: pairingCode.code, expiresAt: pairingCode.expiresAt, agentId: pairingCode.creatorAgentId, agentToken: pairingCode.agentToken, pairingId: null });
  });

  // POST /pairings/:code/join — join with a code, creating a persistent pairing.
  router.post("/:code/join", (req, res) => {
    const pairing = store.joinPairing(req.params.code);
    res.status(201).json({ pairingId: pairing.id, agentId: pairing.agentB, agentToken: pairing.agentToken, peerAgentId: pairing.peerAgentId });
  });

  // GET /pairings/by-code/:code — look up the pairing that resulted from a
  // code, if it's been joined yet. Lets the code's creator discover the
  // pairingId without ever having seen it directly. Returns { pairing: null }
  // (200, not 404) if the code hasn't been joined yet, since "not joined yet"
  // is an expected polling state, not an error.
  router.get("/mine", requireAuth(store), (req, res) => {
    const identity = req.inzoAuth!;
    const pairing = identity.pairingId ? store.getPairing(identity.pairingId) : null;
    res.json({ pairing: pairing && { ...pairing, agentId: identity.agentId, peerAgentId: store.otherAgent(pairing, identity.agentId) } });
  });

  // GET /pairings/:id — fetch a pairing's basic info.
  return router;
}
