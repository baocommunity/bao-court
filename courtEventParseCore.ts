// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Shared parsing primitives for BAO Court protocol events.
 *
 * `events.ts` (lenient, null-returning, public API) and
 * `courtProtocolEvents.ts` (strict, throwing, session-bound) used to read
 * tags and content independently — the same `JSON.parse` + `tags.find`
 * pattern was inlined in every loose parser and `HEX_32` was declared twice.
 * These primitives give both tiers one source of truth for tag access,
 * content parsing, and value validation; each tier keeps its own strictness
 * contract on top.
 */

/** Canonical 32-byte lowercase-hex value (session hashes, salts, ids). */
export const HEX_32 = /^[0-9a-f]{64}$/;

/** Case-insensitive 64-hex check for Nostr pubkeys/ids (loose tier). */
export function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/** Type guard for a plain JSON object (not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse event content as one JSON object. Returns null for anything that is
 * not parseable or not an object — the loose tier treats that as "not a
 * protocol event".
 */
export function parseContentObject(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content || '{}');
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * First matching tag for `name` — exact `tags.find` semantics (whole tag
 * array or undefined), so presence checks like `if (tag)` behave identically.
 */
export function findTag(tags: readonly string[][], name: string): string[] | undefined {
  return tags.find((tag) => tag[0] === name);
}

/**
 * First matching tag value for `name` (loose tier: tag wins, falls back to
 * absent). Returns undefined when no such tag exists.
 */
export function findTagValue(tags: readonly string[][], name: string): string | undefined {
  return findTag(tags, name)?.[1];
}

/** Parse a positive integer (valid FROST/juror index); null when invalid. */
export function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Parse a canonical unsigned decimal integer; null when invalid. */
export function parseCanonicalUint(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
