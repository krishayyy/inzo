import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateHolderKeyPair } from "inzo-holder";
import { createApi } from "./api.js";
import { panel, style, withSpinner } from "./render.js";
import { loadSession, requirePairing, sessionFilePath, type SessionFile } from "./session.js";

/**
 * Same default as packages/mcp-server/src/relayClient.ts — both sides of a
 * pairing must point at the same relay, so the CLI's bootstrap default has to
 * match the MCP server's, not just read INZO_RELAY_URL independently.
 */
const RELAY_URL = process.env.INZO_RELAY_URL ?? "https://inzo-relay-cf.krishaysuresh1.workers.dev";

interface CreatePairingResponse {
  code: string;
  expiresAt: string;
  agentId: string;
  agentToken: string;
  scope: string[];
  principalId: string | null;
  credential: string | null;
}

interface JoinPairingResponse {
  pairingId: string;
  agentId: string;
  agentToken: string;
  scope: string[];
  peerAgentId: string;
  principalId: string | null;
  credential: string | null;
}

async function relayPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RELAY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot reach the relay at ${RELAY_URL} (${(err as Error).message}).`);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const error = (data as { error?: { message?: string } } | undefined)?.error;
    throw new Error(error?.message ?? `POST ${path} failed (${res.status})`);
  }
  return data as T;
}

function writeSession(fields: Omit<SessionFile, "relayUrl" | "updatedAt">): void {
  const target = sessionFilePath();
  const payload: SessionFile = { relayUrl: RELAY_URL, updatedAt: new Date().toISOString(), ...fields };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on create; enforce it on rewrite too.
  chmodSync(target, 0o600);
}

/**
 * Writes (or merges into) .mcp.json in the current directory so pairing and
 * agent setup happen in one step instead of a manual copy-paste from the
 * README. Only touches the "inzo" key — any other configured MCP server is
 * left untouched.
 */
export function mergeMcpConfig(): string {
  const path = join(process.cwd(), ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as typeof config;
    } catch {
      throw new Error(`${path} exists but is not valid JSON — fix or remove it, then run "inzo pair" again.`);
    }
  }
  config.mcpServers ??= {};
  config.mcpServers.inzo = {
    command: "npx",
    args: ["-y", "inzo-mcp"],
    env: { INZO_WORKSPACE: process.cwd() },
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export async function pair(code?: string): Promise<void> {
  const holder = generateHolderKeyPair();
  const mcpConfigPath = mergeMcpConfig();

  if (code) {
    const joined = await withSpinner(
      "Joining pairing…",
      relayPost<JoinPairingResponse>(`/pairings/${encodeURIComponent(code)}/join`, { cnf: { jwk: holder.publicJwk } }),
    );
    writeSession({
      pairingId: joined.pairingId,
      agentId: joined.agentId,
      agentToken: joined.agentToken,
      scope: joined.scope,
      credential: joined.credential,
      holderPrivateKey: joined.credential ? holder.privateKeyPem : null,
      principalId: joined.principalId,
    });
    process.stdout.write(
      `${panel("Joined", `Peer agent: ${shortId(joined.peerAgentId)}`, "green")}\n\n` +
        `Wrote ${sessionFilePath()} and ${mcpConfigPath}.\n` +
        `Run ${style.bold("inzo watch")} to see the plan negotiate live.\n`,
    );
    return;
  }

  const created = await withSpinner("Creating a pairing…", relayPost<CreatePairingResponse>("/pairings", { cnf: { jwk: holder.publicJwk } }));
  writeSession({
    pairingId: null,
    agentId: created.agentId,
    agentToken: created.agentToken,
    scope: created.scope,
    credential: created.credential,
    holderPrivateKey: created.credential ? holder.privateKeyPem : null,
    principalId: created.principalId,
  });
  // Letter-spaced so it reads clearly at a glance and is easy to dictate over
  // a call — the same treatment a 2FA code gets, because this fills the same
  // role: a short-lived secret one person has to hand another correctly.
  const spaced = created.code.toUpperCase().split("").join(" ");
  process.stdout.write(
    `${panel("Pairing code", `${style.bold(spaced)}\n${style.dim(`expires ${new Date(created.expiresAt).toLocaleTimeString()}`)}`, "blue")}\n\n` +
      `Share it with your teammate — they run: ${style.bold(`inzo pair ${created.code}`)}\n` +
      `Wrote ${sessionFilePath()} and ${mcpConfigPath}.\n` +
      `Once they've joined, run ${style.bold("inzo watch")} here.\n`,
  );
}

function shortId(agentId: string): string {
  return agentId.startsWith("agent_") ? agentId.slice(0, 14) : agentId;
}

/**
 * Invites `count` more teammates into the pairing this session is already
 * part of — one one-shot code per invite, looped, rather than a single
 * reusable multi-use code (see PROTOCOL notes on N-party invites: less to
 * build, and it's what create/join already does).
 */
export async function invite(count: number): Promise<void> {
  const session = loadSession();
  const pairingId = requirePairing(session);
  const api = createApi(session);

  for (let i = 0; i < count; i++) {
    const result = await withSpinner(`Creating invite ${i + 1} of ${count}…`, api.invite(pairingId));
    process.stdout.write(`${style.green("Invite code:")} ${style.bold(result.code)} (expires ${result.expiresAt})\n`);
  }
  process.stdout.write(`Share each code with a different teammate — they run: ${style.bold("inzo pair <code>")}\n`);
}
