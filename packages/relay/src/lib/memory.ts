/**
 * Pure validation and ranking for the shared memory layer, agent profiles,
 * and task statuses.
 *
 * Extracted from store.ts specifically so packages/relay-cf can re-export it
 * rather than forking a second copy. Two implementations of "what does this
 * key normalize to" or "how is a memory scored" would drift, and drift here
 * is not cosmetic: it would mean the same write produces a different fact
 * depending on which relay you happen to be paired through.
 *
 * Zero SQL, zero framework coupling — everything here operates on plain
 * values so it runs unchanged on Workers.
 */
import { badRequest } from "./errors.js";
import type { MemoryKind, MemoryVisibility, TaskStatus } from "../types.js";

export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "instruction"];
export const MEMORY_VISIBILITIES: readonly MemoryVisibility[] = ["team", "private"];
export const TASK_STATUSES: readonly TaskStatus[] = ["proposed", "assigned", "in_progress", "blocked", "done"];
export const DEFAULT_RECALL_LIMIT = 12;
export const MAX_RECALL_LIMIT = 50;

/**
 * Keys are an addressable namespace shared by both agents, so they are
 * normalized rather than taken literally: "Deploy Target" and "deploy-target"
 * must resolve to the same fact, or replacement silently forks into two
 * contradictory entries.
 */
export function normalizeMemoryKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest("key is required");
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!key) throw badRequest("key must contain at least one alphanumeric character");
  return key.slice(0, 80);
}

export function normalizeMemoryBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest("body is required");
  const body = value.trim();
  if (body.length > 4000) throw badRequest("body must be 4000 characters or fewer");
  return body;
}

export function normalizeMemoryKind(value: unknown): MemoryKind {
  if (value === undefined || value === null) return "fact";
  if (typeof value !== "string" || !MEMORY_KINDS.includes(value as MemoryKind)) {
    throw badRequest(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  }
  return value as MemoryKind;
}

export function normalizeMemoryVisibility(value: unknown): MemoryVisibility {
  if (value === undefined || value === null) return "team";
  if (typeof value !== "string" || !MEMORY_VISIBILITIES.includes(value as MemoryVisibility)) {
    throw badRequest(`visibility must be one of ${MEMORY_VISIBILITIES.join(", ")}`);
  }
  return value as MemoryVisibility;
}

export function normalizeMemoryTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest("tags must be an array of strings");
  if (value.length > 20) throw badRequest("at most 20 tags");
  return [
    ...new Set(
      value.map((entry) => {
        if (typeof entry !== "string" || !entry.trim()) throw badRequest("each tag must be a non-empty string");
        return entry.trim().toLowerCase().slice(0, 40);
      }),
    ),
  ];
}

export function normalizeMemoryLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_RECALL_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw badRequest("limit must be a positive integer");
  }
  return Math.min(value, MAX_RECALL_LIMIT);
}

/** Lowercased words of 2+ chars: short enough to catch "ci", long enough to
 *  drop the articles that would otherwise match every memory. */
export function memoryTerms(query: unknown): string[] {
  if (typeof query !== "string" || !query.trim()) return [];
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])];
}

/**
 * Weighted lexical score over a memory's key, tags, and body.
 *
 * A term in the key is a much stronger signal than the same term buried in
 * prose, and a tag is the author explicitly saying what the entry is about —
 * so both outrank body hits. Body hits are capped so one long rambling memory
 * cannot dominate every query.
 *
 * Takes the raw column shape (tags as a JSON string) because both stores keep
 * it that way, and parsing here keeps the callers symmetrical.
 */
export function scoreMemory(row: { key: string; body: string; tags: string }, terms: string[]): number {
  if (terms.length === 0) return 0;
  const key = row.key.toLowerCase();
  const body = row.body.toLowerCase();
  const tags = JSON.parse(row.tags) as string[];
  let score = 0;
  for (const term of terms) {
    if (key.includes(term)) score += 4;
    if (tags.some((tag) => tag.includes(term))) score += 3;
    const hits = body.split(term).length - 1;
    if (hits > 0) score += Math.min(hits, 3);
  }
  return score;
}

export function normalizeModel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw badRequest("model must be a non-empty string or null");
  return value.trim().slice(0, 200);
}

export function normalizeStrengths(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest("strengths must be an array of strings");
  const strengths = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) throw badRequest("each strength must be a non-empty string");
    return entry.trim().slice(0, 60);
  });
  if (strengths.length > 20) throw badRequest("at most 20 strengths");
  return strengths;
}

/** Short display form of an agent id, for rationale strings. */
export function shortAgentId(agentId: string): string {
  return agentId.replace(/^agent_/, "").slice(0, 8);
}
