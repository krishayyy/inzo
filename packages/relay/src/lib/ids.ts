import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Characters chosen to avoid visual ambiguity (no 0/O, 1/I). */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Generates a short human-readable pairing code like "INZO-7X2K". */
export function generatePairingCode(): string {
  const bytes = randomBytes(6);
  let suffix = "";
  for (const byte of bytes) {
    suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `INZO-${suffix}`;
}

/** Opaque bearer token. Persist only its digest, never this value. */
export function generateAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
