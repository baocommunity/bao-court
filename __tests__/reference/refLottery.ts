// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * INDEPENDENT reference implementations of the selection lottery
 * (differential-parity round 8 — see __tests__/differentialParity.test.ts).
 *
 * Production (selection.ts):
 *   jurorRandomValue    sha256(seed ++ pubkey-bytes) via @noble, first four
 *                       bytes assembled with manual byte arithmetic.
 *   quadraticPriority   -ln(r) / sqrt(max(1, stake))      — exponential clock.
 *   weightedPriority    -ln(r) / weight                   — exponential clock.
 *
 * Reference (this file), node:crypto + DataView:
 *   refJurorRandomValue      sha256 via createHash, u32 via readUInt32BE.
 *   refPriorityProductionFormulation  the same -ln(r)/w expression,
 *                            independently coded (EXACT differential).
 *   refPriorityInverseCdf    the inverse-CDF formulation E = -ln(1-u)/w
 *                            (STATISTICAL differential — see below).
 *
 * EXACT vs STATISTICAL, documented:
 *   - jurorRandomValue is EXACTLY equal (same digest bytes, same integer
 *     division — only the code path differs).
 *   - The production clock and the inverse-CDF clock are two different
 *     pushes of the SAME Exp(rate) measure through the uniform variable
 *     (u vs 1-u). They are equal in DISTRIBUTION, never pointwise: for the
 *     same u, -ln(u) ≠ -ln(1-u) except u = 0.5. The suite proves (a) the
 *     deterministic identity refPriorityInverseCdf(u,w) ===
 *     refPriorityProductionFormulation(1-u,w) — the measure-preserving
 *     relabelling — and (b) statistical equality of the induced
 *     distributions over 100k draws (equal-probability chi-square, moments,
 *     and min-clock winner frequencies vs the w/Σw law).
 */

import { createHash } from 'node:crypto';

import { refHexToBytes } from './refCanonical';
import { refBytewiseUtf8Compare } from './refMerkle';

/** Deterministic PRNG (mulberry32) so every statistical bound is reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** EXACT reference for jurorRandomValue: node-crypto sha256 + DataView u32. */
export function refJurorRandomValue(seed: Uint8Array, pubkeyHex: string): number {
  const digest = createHash('sha256')
    .update(Buffer.from(seed))
    .update(Buffer.from(refHexToBytes(pubkeyHex)))
    .digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/**
 * EXACT reference for weightedPriority/quadraticPriority: the same
 * `-ln(r) / weight` expression with the same boundary clamps, coded
 * independently. Bit-identical doubles expected for every input.
 */
export function refPriorityProductionFormulation(random: number, weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RangeError(`ref: invalid juror weight ${weight} (must be finite and positive)`);
  }
  let r = random;
  if (r <= 0) r = Number.MIN_VALUE;
  if (r >= 1) r = 1 - Number.EPSILON;
  return -Math.log(r) / weight;
}

/**
 * STATISTICAL reference: inverse-CDF exponential clock. For u uniform on
 * [0,1), E = -ln(1-u)/w satisfies P(E > t) = e^(-w·t) — exactly the Exp(w)
 * clock the production formulation realises through -ln(u)/w.
 */
export function refPriorityInverseCdf(random: number, weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RangeError(`ref: invalid juror weight ${weight} (must be finite and positive)`);
  }
  let u = random;
  if (u < 0) u = 0;
  if (u >= 1) u = 1 - Number.EPSILON;
  return -Math.log(1 - u) / weight;
}

export interface RefSelectionEntry {
  readonly nostrPubkey: string;
  readonly priority: number;
  readonly idx: number;
}

/**
 * INDEPENDENT end-to-end ranking (the differential core of selectJury /
 * selectJuryWithBackups): seed derivation, per-juror clock, ordering, and
 * idx assignment are all re-implemented here. Uses the production
 * formulation so the result is EXACTLY comparable (same doubles).
 */
export function refSelectJuryRanking(
  eligiblePubkeys: readonly string[],
  weights: readonly number[],
  disputeEventId: string,
  blockHash: string,
): RefSelectionEntry[] {
  if (eligiblePubkeys.length !== weights.length) {
    throw new RangeError('ref: pubkey/weight length mismatch');
  }
  // deriveSelectionSeed: sha256(disputeBytes ++ blockBytes) — via node crypto.
  const seed = createHash('sha256')
    .update(Buffer.from(refHexToBytes(disputeEventId)))
    .update(Buffer.from(refHexToBytes(blockHash)))
    .digest();
  return eligiblePubkeys
    .map((nostrPubkey, i) => ({
      nostrPubkey,
      priority: refPriorityProductionFormulation(
        refJurorRandomValue(seed, nostrPubkey),
        weights[i]!,
      ),
    }))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        refBytewiseUtf8Compare(a.nostrPubkey, b.nostrPubkey),
    )
    .map((entry, i) => ({ ...entry, idx: i + 1 }));
}
