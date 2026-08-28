import { createApi, type Api } from "./api.js";
import { loadSession, rememberPairingId, type SessionFile } from "./session.js";

/**
 * The session, its API client, and the pairing id — resolved, not assumed.
 *
 * `inzo start` writes the session *before* anyone has joined, because that is
 * when it has the credential: at that moment there is no pairing, so
 * `pairingId` is null. If the CLI only ever read the file, the person who
 * started the session would be told "nobody has joined yet" forever, even
 * with a teammate already in the room — which is exactly what happened the
 * first time this was run end to end.
 *
 * So a null id is a prompt to ask the relay, not an answer. `GET
 * /pairings/mine` is the same call the MCP server's `check_pairing` makes,
 * and the result is written back so the question is asked once.
 */
export async function attach(): Promise<{ session: SessionFile; api: Api; pairingId: string }> {
  const session = loadSession();
  const api = createApi(session);

  if (session.pairingId) return { session, api, pairingId: session.pairingId };

  const { pairing } = await api.mine();
  if (!pairing) {
    throw new Error(
      "You created a pairing code but nobody has joined it yet. Share the code, then run this again.",
    );
  }

  rememberPairingId(session, pairing.id);
  return { session: { ...session, pairingId: pairing.id }, api, pairingId: pairing.id };
}
