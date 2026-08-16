import { render } from "ink";
import React from "react";
import { createApi } from "../api.js";
import { loadSession, requirePairing } from "../session.js";
import { App } from "./app.js";

/** Boots the interactive shell against the session on disk. */
export async function startShell(): Promise<void> {
  const session = loadSession();
  const pairingId = requirePairing(session);
  const { pairing } = await createApi(session).mine();
  if (!pairing) throw new Error("No active pairing.");

  const instance = render(
    React.createElement(App, { session, pairingId, peerAgentId: pairing.peerAgentId }),
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
}
