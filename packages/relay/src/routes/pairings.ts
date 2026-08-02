import { Router } from "express";
import type { RelayStore } from "../lib/store.js";

export function pairingsRouter(store: RelayStore): Router {
  const router = Router();

  // POST /pairings — create a short-lived pairing code.
  router.post("/", (req, res) => {
    const { agentId } = req.body ?? {};
    const pairingCode = store.createPairingCode(agentId);
    res.status(201).json({ pairingCode });
  });

  // POST /pairings/:code/join — join with a code, creating a persistent pairing.
  router.post("/:code/join", (req, res) => {
    const { agentId } = req.body ?? {};
    const pairing = store.joinPairing(req.params.code, agentId);
    res.status(201).json({ pairing });
  });

  // GET /pairings/by-code/:code — look up the pairing that resulted from a
  // code, if it's been joined yet. Lets the code's creator discover the
  // pairingId without ever having seen it directly. Returns { pairing: null }
  // (200, not 404) if the code hasn't been joined yet, since "not joined yet"
  // is an expected polling state, not an error.
  router.get("/by-code/:code", (req, res) => {
    const pairing = store.getPairingByCode(req.params.code);
    res.json({ pairing });
  });

  // GET /pairings/:id — fetch a pairing's basic info.
  router.get("/:id", (req, res) => {
    const pairing = store.getPairing(req.params.id);
    res.json({ pairing });
  });

  return router;
}
