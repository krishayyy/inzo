import { Router, type RequestHandler } from "express";
import { requireScope } from "../lib/auth.js";
import type { RelayStore } from "../lib/store.js";

type PairingParams = { id: string };
type KeyParams = PairingParams & { key: string };

/**
 * The shared memory layer.
 *
 * Split into two capabilities rather than one: an agent that may READ the
 * team's memory is not thereby entitled to WRITE into what its teammate's
 * agent will believe on its next turn. Dropping `memory:write` while keeping
 * `memory:read` is the useful middle state — a teammate who learns from the
 * team without being able to plant anything in it.
 */
export function memoryRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  // POST /pairings/:id/memory — write or replace a fact by key.
  const write: RequestHandler<PairingParams> = (req, res) => {
    const memory = store.remember(req.params.id, req.inzoAuth!.agentId, req.body ?? {});
    res.status(201).json({ memory });
  };

  // GET /pairings/:id/memory — the full list this caller may see (Memory tab).
  const list: RequestHandler<PairingParams> = (req, res) => {
    res.json({ memories: store.listMemories(req.params.id, req.inzoAuth!.agentId) });
  };

  // GET /pairings/:id/memory/recall?q=&limit= — relevance retrieval. GET so an
  // agent can recall without it reading as a mutation in the audit trail;
  // recall is the hot path before every turn and must stay cheap.
  const recall: RequestHandler<PairingParams> = (req, res) => {
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ memories: store.recall(req.params.id, req.inzoAuth!.agentId, { query, limit }) });
  };

  // DELETE /pairings/:id/memory/:key — author-only. A wrong memory keeps being
  // re-injected until it is actually gone, so this is a real delete.
  const forget: RequestHandler<KeyParams> = (req, res) => {
    res.json(store.forget(req.params.id, req.inzoAuth!.agentId, req.params.key));
  };

  router.post("/", requireScope("memory:write"), write);
  router.get("/", requireScope("memory:read"), list);
  router.get("/recall", requireScope("memory:read"), recall);
  router.delete("/:key", requireScope("memory:write"), forget);

  return router;
}

/**
 * GET /pairings/:id/team — the Team tab in one call: who is on the pairing,
 * what model each one runs, and what each has spent.
 *
 * Spend is gated on the OTHER member's `usage:share`, not the reader's. Tokens
 * are money, and whether yours are visible has to be your decision, expressed
 * in your own credential — so an agent that narrowed away `usage:share` shows
 * up on the roster with `usage: null` rather than a number its holder never
 * agreed to publish. Your own row is always visible to you.
 */
export function teamRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const get: RequestHandler<PairingParams> = (req, res) => {
    const pairingId = req.params.id;
    const self = req.inzoAuth!.agentId;
    const profiles = store.getAgentProfiles(pairingId);
    const { usage, runway } = store.getUsageSnapshot(pairingId);

    const members = profiles.map((profile) => {
      const shares = profile.agentId === self || store.getAgentScope(profile.agentId).includes("usage:share");
      return {
        agentId: profile.agentId,
        isSelf: profile.agentId === self,
        model: profile.model,
        strengths: profile.strengths,
        revoked: store.isAgentRevoked(profile.agentId),
        sharesUsage: shares,
        usage: shares ? (usage.byAgent[profile.agentId] ?? null) : null,
      };
    });

    res.json({ pairingId, members, totals: usage.totals, runway });
  };

  router.get("/", requireScope("messages:read"), get);
  return router;
}

/**
 * POST /pairings/:id/delegate — "who should take this?", answered from
 * declared models and live token spend. Returns a suggestion plus its
 * reasoning; it never assigns, because assignment is an attributed act a
 * human may need to overrule.
 */
export function delegateRouter(store: RelayStore): Router {
  const router = Router({ mergeParams: true });

  const suggest: RequestHandler<PairingParams> = (req, res) => {
    res.json(store.suggestOwner(req.params.id, req.body ?? {}));
  };

  router.post("/", requireScope("messages:read"), suggest);
  return router;
}
