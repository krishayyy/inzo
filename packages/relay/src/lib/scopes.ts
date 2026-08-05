import { ALL_SCOPES, type Scope } from "../types.js";
import { badRequest } from "./errors.js";

const SCOPE_SET = new Set<string>(ALL_SCOPES);

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

export function serializeScope(scope: Scope[]): string {
  return JSON.stringify(scope);
}

export function parseScope(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isScope) : [];
  } catch {
    return [];
  }
}

/**
 * Validates a caller-supplied scope list and proves it is a SUBSET of what the
 * caller already holds.
 *
 * This is the narrowing invariant, and it is the whole point of the scope
 * system: a credential can give away authority but can never grant itself
 * authority it was not already holding. Without the subset check, "scope"
 * would be decoration — any agent could simply re-post the full list.
 */
export function narrowedScope(requested: unknown, current: Scope[]): Scope[] {
  if (!Array.isArray(requested)) {
    throw badRequest(`scope must be an array of capabilities from: ${ALL_SCOPES.join(", ")}`);
  }
  const unknownScopes = requested.filter((entry) => !isScope(entry));
  if (unknownScopes.length > 0) {
    throw badRequest(`Unknown capabilities: ${unknownScopes.map(String).join(", ")}`);
  }

  const next = [...new Set(requested as Scope[])];
  const held = new Set(current);
  const widened = next.filter((entry) => !held.has(entry));
  if (widened.length > 0) {
    throw badRequest(
      `A credential cannot widen its own scope. Not currently held: ${widened.join(", ")}`,
    );
  }
  // Preserve canonical ordering so the value is stable to compare and display.
  return ALL_SCOPES.filter((entry) => next.includes(entry));
}
