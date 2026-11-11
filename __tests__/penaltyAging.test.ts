// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * penaltyAging — the r30-4 pairing: a decaying commitment must be accompanied
 * by penalty AGEING, or the ramp simply replaces the cliff it removed
 * (`docs/proofs/economics/06-expert-verify.tex.md` §4).
 *
 * The numbers pinned here are the document's own:
 *
 *   - the shipped decay's loop averages 0.6298 (6 active / 6 idle) and 0.7225
 *     (1/6) against the pre-R23 cliff's 0.5000 — the ramp dominates at EVERY
 *     finite cycle, which is the finding;
 *   - the fix pair is (anchor at the floor) + (penalties aged at the same
 *     λ = ln2/3, on the PARTICIPATING clock). Its cycle average is the floor at
 *     every split, so it never exceeds the cliff at any finite cycle, and it is
 *     strictly below the shipped ramp at every epoch.
 *
 * What this file deliberately does NOT claim: for a PARTIALLY penalised juror
 * (floor < earned < w0) the pair can exceed the flat 6-epoch cliff on short
 * cycles (the cliff holds the penalty and then jumps to w0 while the pair eases
 * toward the floor). The universal statement — the one asserted below — is that
 * the pair is never worse than the RAMP it replaces, and that the pair's value
 * at the floor never exceeds the cliff.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_WEIGHT_FACTOR,
  PENALTY_AGING_HALF_LIFE_EPOCHS,
  PENALTY_AGING_LAMBDA,
  agePenalties,
  pairedJurorWeight,
} from '../penaltyAging';

const CLIFF_EPOCHS = 6; // `jurorReputationWeight`: idle expiry was 6 epochs

/** The pre-R23 cliff's cycle average (06 §4.2): floor for min(I,6), then w0. */
function cliffCycleAverage(F: number, I: number, floor = 0.5, w0 = 1): number {
  const active = floor * F;
  const idleBeforeReset = floor * Math.min(I, CLIFF_EPOCHS);
  const afterReset = w0 * Math.max(0, I - CLIFF_EPOCHS);
  return (active + idleBeforeReset + afterReset) / (F + I);
}

/** The shipped (unanchored) decay's cycle average: the farmer at the floor. */
function rampCycleAverage(F: number, I: number, floor = 0.5, w0 = 1): number {
  let idle = 0;
  for (let i = 1; i <= I; i += 1) idle += w0 + (floor - w0) * Math.exp(-PENALTY_AGING_LAMBDA * i);
  return (floor * F + idle) / (F + I);
}

/** The paired cycle average: active = floor (a refreshed penalty), idle = paired weight. */
function pairedCycleAverage(F: number, I: number, w0 = 1): number {
  let idle = 0;
  for (let i = 1; i <= I; i += 1) {
    idle += pairedJurorWeight({ w0, penalties: [{ factor: DEFAULT_MIN_WEIGHT_FACTOR }], idleEpochs: i });
  }
  const active = F * pairedJurorWeight({ w0, penalties: [{ factor: DEFAULT_MIN_WEIGHT_FACTOR }], idleEpochs: 0 });
  return (active + idle) / (F + I);
}

describe('agePenalties — one clock for restitution and probation', () => {
  it('ages at the SAME λ as the commitment (half-life 3 participating epochs)', () => {
    expect(PENALTY_AGING_LAMBDA).toBe(Math.LN2 / 3);
    expect(PENALTY_AGING_HALF_LIFE_EPOCHS).toBe(3);
    expect(agePenalties([{ factor: 0.8 }], 0)).toBeCloseTo(0.8, 12);
    expect(agePenalties([{ factor: 0.8 }], 3)).toBeCloseTo(0.9, 12); // half the deviation served
    expect(agePenalties([{ factor: 0.8 }], 6)).toBeCloseTo(0.95, 12);
    expect(agePenalties([{ factor: 0.8 }], 9)).toBeCloseTo(0.975, 12);
  });

  it('is the identity for no penalties, and multiplies independent ones', () => {
    expect(agePenalties([], 12)).toBe(1);
    expect(agePenalties([{ factor: 1 }], 5)).toBe(1);
    expect(agePenalties([{ factor: 0.8 }, { factor: 0.8 }], 0)).toBeCloseTo(0.64, 12);
    // Ageing is per penalty: an old one is nearly repaired, a fresh one is not.
    expect(agePenalties([{ factor: 0.8, ageEpochs: 3 }], 0)).toBeCloseTo(0.9, 12);
    expect(agePenalties([{ factor: 0.8, ageEpochs: 15 }], 0)).toBeGreaterThan(0.99);
  });

  it('adds the served age and the new epochs (one timeline, not two)', () => {
    expect(agePenalties([{ factor: 0.8, ageEpochs: 3 }], 3))
      .toBeCloseTo(agePenalties([{ factor: 0.8 }], 6), 12);
  });

  it('is monotone non-decreasing in participation and in the factor', () => {
    let previous = -1;
    for (const epochs of [0, 1, 2, 3, 6, 12, 50, 1_000]) {
      const value = agePenalties([{ factor: 0.6 }, { factor: 0.8 }], epochs);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
    expect(agePenalties([{ factor: 0.5 }], 3)).toBeLessThan(agePenalties([{ factor: 0.8 }], 3));
  });

  it('fails closed on malformed records', () => {
    expect(() => agePenalties([{ factor: 0 }], 0)).toThrow(/factor/);
    expect(() => agePenalties([{ factor: 1.2 }], 0)).toThrow(/factor/);
    expect(() => agePenalties([{ factor: Number.NaN }], 0)).toThrow(/factor/);
    expect(() => agePenalties([{ factor: 0.8, ageEpochs: -1 }], 0)).toThrow(/ageEpochs/);
    expect(() => agePenalties([{ factor: 0.8 }], -1)).toThrow(/epochs/);
    expect(() => agePenalties('nope' as unknown as [])).toThrow(/array/);
  });
});

describe('pairedJurorWeight — the anchor, and why idleness buys nothing', () => {
  it('a penalised juror is pinned at or below the floor however long it idles', () => {
    const floored = pairedJurorWeight({ w0: 1, penalties: [{ factor: 0.5 }], idleEpochs: 0 });
    expect(floored).toBeCloseTo(0.5, 12);
    for (const idle of [1, 3, 6, 12, 100, 10_000]) {
      expect(pairedJurorWeight({ w0: 1, penalties: [{ factor: 0.5 }], idleEpochs: idle }))
        .toBeCloseTo(0.5, 12);
    }
  });

  it('is NON-INCREASING in idleness for every penalty strength (the ramp is gone)', () => {
    for (const factor of [0.5, 0.6, 0.7, 0.8, 0.95]) {
      let previous = Number.POSITIVE_INFINITY;
      for (let idle = 0; idle <= 20; idle += 1) {
        const weight = pairedJurorWeight({ w0: 1, penalties: [{ factor }], idleEpochs: idle });
        expect(weight, `factor=${factor} idle=${idle}`).toBeLessThanOrEqual(previous + 1e-12);
        expect(weight).toBeGreaterThanOrEqual(DEFAULT_MIN_WEIGHT_FACTOR - 1e-12);
        previous = weight;
      }
    }
  });

  it('recovery is bought with PARTICIPATION: only the served-age clock raises the weight', () => {
    const unserved = pairedJurorWeight({ w0: 1, penalties: [{ factor: 0.8 }], idleEpochs: 0 });
    const idled = pairedJurorWeight({ w0: 1, penalties: [{ factor: 0.8 }], idleEpochs: 6 });
    const served = pairedJurorWeight({ w0: 1, penalties: [{ factor: 0.8, ageEpochs: 6 }], idleEpochs: 0 });
    expect(idled).toBeLessThan(unserved); // waiting costs weight
    expect(served).toBeGreaterThan(unserved); // working buys it back
    expect(served).toBeCloseTo(0.95, 12);
  });

  it('a bonus still fades toward w0 with idleness (the shipped direction is kept)', () => {
    expect(pairedJurorWeight({ w0: 1, bonusMultiplier: 1.2, idleEpochs: 0 })).toBeCloseTo(1.2, 12);
    expect(pairedJurorWeight({ w0: 1, bonusMultiplier: 1.2, idleEpochs: 3 })).toBeCloseTo(1.1, 12);
    expect(pairedJurorWeight({ w0: 1, bonusMultiplier: 1.2, idleEpochs: 1_000 })).toBeCloseTo(1, 6);
  });

  it('respects a custom floor and a custom w0', () => {
    expect(pairedJurorWeight({ w0: 2, penalties: [{ factor: 0.3 }], minWeightFactor: 0.6 }))
      .toBeCloseTo(1.2, 12);
    expect(() => pairedJurorWeight({ w0: 0 })).toThrow(/w0/);
    expect(() => pairedJurorWeight({ w0: 1, minWeightFactor: 0 })).toThrow(/minWeightFactor/);
    expect(() => pairedJurorWeight({ w0: 1, idleEpochs: -1 })).toThrow(/idleEpochs/);
  });
});

describe('the paired curve against the cliff it replaced (06 §4.2 Finding 4.1)', () => {
  it('the shipped ramp DOES dominate the cliff — the finding, pinned', () => {
    // Both numbers the document publishes: 0.6298 vs 0.5000 at 6/6, 0.7225 vs
    // 0.5000 at 1/6. If the host's decay ever changes shape, this fails.
    expect(rampCycleAverage(6, 6)).toBeCloseTo(0.6298, 4);
    expect(rampCycleAverage(1, 6)).toBeCloseTo(0.7225, 4);
    expect(cliffCycleAverage(6, 6)).toBeCloseTo(0.5, 12);
    expect(cliffCycleAverage(1, 6)).toBeCloseTo(0.5, 12);
    expect(rampCycleAverage(6, 6)).toBeGreaterThan(cliffCycleAverage(6, 6));
    expect(rampCycleAverage(1, 6)).toBeGreaterThan(cliffCycleAverage(1, 6));
  });

  it('the PAIRED curve never exceeds the cliff at any finite cycle', () => {
    for (let F = 1; F <= 8; F += 1) {
      for (let I = 0; I <= 24; I += 1) {
        const paired = pairedCycleAverage(F, I);
        const cliff = cliffCycleAverage(F, I);
        expect(paired, `F=${F} I=${I}`).toBeLessThanOrEqual(cliff + 1e-12);
      }
    }
    // The loop value the ramp handed back (+26.0 % at 6/6) is exactly zero.
    expect(pairedCycleAverage(6, 6) - cliffCycleAverage(6, 6)).toBeCloseTo(0, 12);
  });

  it('the paired curve is never worse than the ramp it replaces, at any split', () => {
    for (let F = 1; F <= 8; F += 1) {
      for (let I = 0; I <= 24; I += 1) {
        expect(pairedCycleAverage(F, I), `F=${F} I=${I}`)
          .toBeLessThanOrEqual(rampCycleAverage(F, I) + 1e-12);
      }
    }
  });
});
