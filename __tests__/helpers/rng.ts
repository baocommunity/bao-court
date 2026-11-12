// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE seeded-RNG kit for the Court test suite.
 *
 * Every property/fuzz/differential test draws randomness from ONE generator
 * family — mulberry32 (a tiny, dependency-free LCG) — so every assertion is
 * reproducible from a seed literal in the test body. Do NOT reach for
 * `Math.random()`, `crypto.getRandomValues`, or `nostr-tools
 * generateSecretKey` inside a generator-driven test: those are for the
 * CSPRNG-backed helpers in `keys.ts`, where uniqueness (not reproducibility)
 * is the point.
 *
 * Streams: give each logical input stream its own seed via `childRng(SEED,
 * 'label')` (a labeled child stream). Never thread one generator through two
 * unrelated fixtures — a change to one fixture's draw count would silently
 * shift every downstream value.
 */

/** mulberry32 — the house seeded generator (32-bit LCG, uniform [0,1)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string — derives child-stream seeds from a label. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A labeled child stream: deterministic in (seed, label), independent of any
 * other label under the same seed. `childRng(1000, 'verdicts')` and
 * `childRng(1000, 'salts')` never correlate.
 */
export function childRng(seed: number, label: string): () => number {
  return mulberry32((fnv1a(label) ^ Math.imul(seed >>> 0, 0x9e3779b9)) >>> 0);
}

const HEX_DIGITS = '0123456789abcdef';

/** Uniform integer in [lo, hi] (inclusive) from stream `r`. */
export const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

/** Uniform element of `xs` from stream `r`. */
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** 64 lowercase hex chars drawn from stream `r` (a synthetic 32-byte id). */
export const hex32 = (r: () => number): string =>
  Array.from({ length: 64 }, () => HEX_DIGITS[Math.floor(r() * 16)]).join('');

/** `hex32` that redraws on collision within `seen` (records the result). */
export const uniqueHex32 = (r: () => number, seen: Set<string>): string => {
  let value = hex32(r);
  while (seen.has(value)) value = hex32(r);
  seen.add(value);
  return value;
};

/** 32 random bytes drawn from stream `r` (a synthetic seckey). */
export function secFrom(r: () => number): Uint8Array {
  const sec = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) sec[i] = Math.floor(r() * 256);
  return sec;
}

/**
 * A stable unit value in `[0,1)` derived from `(seed, label)` alone.
 *
 * For fixture fields that must look spread out but be reproducible — the case
 * `Math.random()` in a fixture gets wrong: it buys nothing (the assertion
 * never depends on spread) and costs replayability.
 */
export function stableUnit(seed: number, label: string | number): number {
  return childRng(seed, String(label))();
}
