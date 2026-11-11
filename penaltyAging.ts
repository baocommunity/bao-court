// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * penaltyAging — the FAIRNESS COMPANION of a decaying reputation weight.
 *
 * Why this module exists
 * ----------------------
 * `docs/proofs/economics/06-expert-verify.tex.md` §4 (r30-4) measures the
 * host's R23 change: the idle-reset *cliff* was replaced by continuous decay,
 *
 *     w(idle) = w0 + (earned − w0)·e^{−λ·idle},   λ = ln2/3 (half-life 3 epochs),
 *
 * which is better for an idling penalised juror at EVERY epoch. The doc's two
 * fixes must ship together or not at all:
 *
 *  1. **Anchor the decay at the floor** — `anchor = earned >= w0 ? w0 : floor`,
 *     so a penalty decays toward the floor (idleness never hands weight back);
 *     implemented by {@link pairedJurorWeight}.
 *  2. **Age the penalties** — with the anchor alone, one bad epoch pins a juror
 *     at ≤ 0.8·w0 for as long as its record is retained, because the penalty
 *     product runs over ALL retained epochs.
 *
 * The pairing, and the direction it must run
 * ------------------------------------------
 * The penalty multiplier ages at the SAME λ as the commitment, but on the
 * PARTICIPATING epoch clock: a penalty's deviation from 1 fades by
 * `e^{−λ·(age + participating epochs)}`. Recovery is therefore bought with
 * **participation** (the epochs a juror actually works), never with idleness —
 * which is the property the loop in 06 §4.3 priced. Waiting out a penalty is
 * not a strategy; working it off is.
 *
 * What the pair does and does not claim (read before quoting a number)
 * --------------------------------------------------------------------
 * At the floor the pair's cycle average is **exactly the floor at every
 * (active, idle) split**, while the pre-R23 cliff averages `floor` only for
 * idle ≤ 6 epochs and then resets to `w0`: the pair never exceeds the cliff at
 * ANY finite cycle (see `__tests__/penaltyAging.test.ts`). For a PARTIALLY
 * penalised juror (0.5 < earned < w0) the pair is bounded by the floor, so it
 * can exceed the flat 6-epoch cliff on short cycles (the cliff holds the
 * penalty and then jumps to w0) while staying strictly BELOW the shipped ramp
 * at every epoch — the claim that holds universally is "never worse than the
 * ramp it replaces", and both are pinned.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */

/**
 * The penalty-aging rate: the SAME λ the host uses for the commitment decay
 * (`jurorReputationWeight.decayLambda`), ln 2 / 3, i.e. a 3-epoch half-life.
 * Equal λ is the point of the pairing — one clock for restitution and one for
 * probation.
 */
export const PENALTY_AGING_LAMBDA = Math.LN2 / 3;

/** The half-life of {@link PENALTY_AGING_LAMBDA}, in participating epochs. */
export const PENALTY_AGING_HALF_LIFE_EPOCHS = 3;

/** The host's shipped weight floor as a fraction of w0 (`jurorReputationWeight` P.minWeightFactor). */
export const DEFAULT_MIN_WEIGHT_FACTOR = 0.5;

/** One retained penalty epoch: its factor, and the participating epochs since it was incurred. */
export interface PenaltyRecord {
  /** The per-epoch multiplier the epoch earned, in (0, 1] (`×0.8` = an SLA miss). */
  readonly factor: number;
  /** Participating epochs already served since the penalty was incurred (default 0). */
  readonly ageEpochs?: number;
}

function assertEpochs(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number of epochs (got ${String(value)})`);
  }
  return value;
}

/**
 * The composite penalty multiplier after `epochs` MORE PARTICIPATING epochs:
 *
 *     Π_i [ 1 − (1 − factor_i)·e^{−λ·(age_i + epochs)} ]
 *
 * `epochs = 0` re-scores the retained record as it stands; `epochs = n` ages
 * every retained penalty by `n` epochs of participation. Monotone non-decreasing
 * in `epochs` and in every `factor`, equal to 1 for an empty record, and
 * asymptotic to 1 (a penalty never expires outright, it fades at the same λ as
 * the commitment).
 *
 * @example
 * ```ts
 * agePenalties([{ factor: 0.8 }], 0); // 0.8
 * agePenalties([{ factor: 0.8 }], 3); // 0.9    (one half-life: half the deviation served)
 * agePenalties([{ factor: 0.8 }], 9); // 0.975
 * ```
 */
export function agePenalties(penalties: readonly PenaltyRecord[], epochs = 0): number {
  if (!Array.isArray(penalties)) {
    throw new Error('penalties must be an array of penalty records');
  }
  const elapsed = assertEpochs(epochs, 'epochs');
  let multiplier = 1;
  for (const penalty of penalties) {
    const { factor, ageEpochs } = penalty ?? ({} as PenaltyRecord);
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 || factor > 1) {
      throw new Error(`penalty factor must be a finite multiplier in (0, 1] (got ${String(factor)})`);
    }
    const age = ageEpochs === undefined ? 0 : assertEpochs(ageEpochs, 'penalty ageEpochs');
    multiplier *= 1 - (1 - factor) * Math.exp(-PENALTY_AGING_LAMBDA * (age + elapsed));
  }
  return multiplier;
}

/**
 * The PAIRED reputation weight: aged penalties + a decay anchored at the floor.
 *
 *     earned = w0 · agePenalties(penalties) · bonus
 *     anchor = earned >= w0 ? w0 : floor          (the r30-4a fix, one line)
 *     w      = anchor + (earned − anchor)·e^{−λ·idle},  floored at `floor`
 *
 * A bonus (earned ≥ w0) fades toward w0 with idleness — the shipped direction,
 * unchanged. A penalty is anchored at the floor: idleness pulls it DOWN toward
 * the floor and never hands it back, and the only way up is
 * {@link agePenalties} on the participating clock. `w` is therefore
 * non-increasing in `idleEpochs` for every penalty strength, which is exactly
 * the loop 06 §4.3 measured as +26.0 % under the shipped ramp.
 */
export function pairedJurorWeight(input: {
  readonly w0: number;
  readonly penalties?: readonly PenaltyRecord[];
  /** Idle epochs since the juror last participated (default 0). */
  readonly idleEpochs?: number;
  /** Earned bonus multiplier ≥ 1 on the weight (`×1.1` = a coherence bonus); default 1. */
  readonly bonusMultiplier?: number;
  /** Weight floor as a fraction of w0 (default {@link DEFAULT_MIN_WEIGHT_FACTOR}). */
  readonly minWeightFactor?: number;
}): number {
  const {
    w0,
    penalties = [],
    idleEpochs = 0,
    bonusMultiplier = 1,
    minWeightFactor = DEFAULT_MIN_WEIGHT_FACTOR,
  } = input;
  if (typeof w0 !== 'number' || !Number.isFinite(w0) || w0 <= 0) {
    throw new Error(`w0 must be a finite positive weight (got ${String(w0)})`);
  }
  if (
    typeof minWeightFactor !== 'number'
    || !Number.isFinite(minWeightFactor)
    || minWeightFactor <= 0
    || minWeightFactor > 1
  ) {
    throw new Error(`minWeightFactor must be a finite fraction in (0, 1] (got ${String(minWeightFactor)})`);
  }
  if (typeof bonusMultiplier !== 'number' || !Number.isFinite(bonusMultiplier) || bonusMultiplier < 0) {
    throw new Error(`bonusMultiplier must be a finite non-negative multiplier (got ${String(bonusMultiplier)})`);
  }
  const idle = assertEpochs(idleEpochs, 'idleEpochs');
  const floor = minWeightFactor * w0;
  const earned = w0 * agePenalties(penalties, 0) * bonusMultiplier;
  const anchor = earned >= w0 ? w0 : floor;
  const weight = anchor + (earned - anchor) * Math.exp(-PENALTY_AGING_LAMBDA * idle);
  return Math.max(floor, weight);
}
