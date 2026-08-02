import { randomBytes, randomUUID } from "node:crypto";

/** Characters chosen to avoid visual ambiguity (no 0/O, 1/I). */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Generates a short human-readable pairing code like "INZO-7X2K". */
export function generatePairingCode(): string {
  const bytes = randomBytes(4);
  let suffix = "";
  for (const byte of bytes) {
    suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `INZO-${suffix}`;
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
