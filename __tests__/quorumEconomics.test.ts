// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * quorumEconomics — the capture arithmetic of a sub-supermajority confirm
 * quorum (R30, `docs/proofs/economics/06-expert-verify.tex.md` §3 / r30-3).
 *
 * Every expected value here is a number published in
 * `docs/proofs/economics/05-review-gapfills.tex.md` §1.3 or §3, or derived in
 * 06 §3 — so a drift in either direction (code or document) fails a test.
 */

import { describe, expect, it } from 'vitest';
import { captureProbability, quorumCapCorrection } from '../quorumEconomics';

const third = { numerator: 1, denominator: 3 } as const;

describe('captureProbability — exact binomial upper tail (Model D)', () => {
  it('reproduces the published 3-of-5 figure EXACTLY: 51/243', () => {
    const p = captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: third });
    expect(p.numerator).toBe(51n);
    expect(p.denominator).toBe(243n);
    expect(p.value).toBeCloseTo(51 / 243, 15);
  });

  it('reproduces the published 4-of-5 figure EXACTLY: 11/243', () => {
    const p = captureProbability({ panelSize: 5, quorum: 4, adversaryWeight: third });
    expect(p.numerator).toBe(11n);
    expect(p.denominator).toBe(243n);
    expect(p.value).toBeCloseTo(11 / 243, 15);
  });

  it('matches 05 §1.3 rows: 0.2099 (3-of-5) and 0.4813 (3-of-5 at rho=0.49)', () => {
    expect(captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: third }).value)
      .toBeCloseTo(0.209877, 6);
    expect(captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 49, denominator: 100 } }).value)
      .toBeCloseTo(0.481255, 6);
    // ... and the old code default of 1 confirmation, which R25 removed: 0.8683.
    expect(captureProbability({ panelSize: 5, quorum: 1, adversaryWeight: third }).value)
      .toBeCloseTo(0.868313, 6);
  });

  it('matches the shipped ladder rows of 05 §1.3 at rho = 1/3', () => {
    const rows: Array<[number, number, number]> = [
      // N, q = ceil(2N/3), published value
      [15, 10, 8.504e-3],
      [45, 30, 5.001e-6],
      [135, 90, 2.735e-15],
    ];
    for (const [panelSize, quorum, expected] of rows) {
      const p = captureProbability({ panelSize, quorum, adversaryWeight: third });
      expect(p.value / expected).toBeCloseTo(1, 3);
    }
  });

  it('is a probability: monotonically increasing in the adversary share', () => {
    let previous = -1;
    for (const numerator of [0, 10, 20, 30, 40, 49, 50, 100]) {
      const value = captureProbability({
        panelSize: 5, quorum: 3, adversaryWeight: { numerator, denominator: 100 },
      }).value;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it('is 0 below the threshold share and 1 at a full share', () => {
    const none = captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 0, denominator: 100 } });
    expect(none.numerator).toBe(0n);
    expect(none.value).toBe(0);
    const all = captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 100, denominator: 100 } });
    expect(all.value).toBeCloseTo(1, 15);
  });

  it('is strictly decreasing in the quorum (5 seats, rho = 1/3)', () => {
    const values = [1, 2, 3, 4, 5].map((quorum) =>
      captureProbability({ panelSize: 5, quorum, adversaryWeight: third }).value);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
  });

  it('fails closed on malformed input', () => {
    expect(() => captureProbability({ panelSize: 0, quorum: 1, adversaryWeight: third })).toThrow(/panelSize/);
    expect(() => captureProbability({ panelSize: 2.5, quorum: 1, adversaryWeight: third })).toThrow(/panelSize/);
    expect(() => captureProbability({ panelSize: 5, quorum: 0, adversaryWeight: third })).toThrow(/quorum/);
    expect(() => captureProbability({ panelSize: 5, quorum: 6, adversaryWeight: third })).toThrow(/quorum/);
    expect(() => captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 4, denominator: 3 } }))
      .toThrow(/numerator/);
    expect(() => captureProbability({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 1, denominator: 0 } }))
      .toThrow(/denominator/);
  });
});

describe('quorumCapCorrection — kappa, the sub-supermajority factor', () => {
  it('is EXACTLY 51/11 = 4.63636… for 3-of-5 at rho = 1/3', () => {
    const kappa = quorumCapCorrection({ panelSize: 5, quorum: 3, adversaryWeight: third });
    expect(kappa).toBeCloseTo(51 / 11, 12);
  });

  it('matches the 06 §3 kappa table across the weight-share range', () => {
    const table: Array<[number, number, number]> = [
      [1, 3, 4.6364],
      [2, 5, 3.6471],
      [9, 20, 3.1007],
      [49, 100, 2.7461],
    ];
    for (const [numerator, denominator, expected] of table) {
      const kappa = quorumCapCorrection({
        panelSize: 5, quorum: 3, adversaryWeight: { numerator, denominator },
      });
      expect(kappa).toBeCloseTo(expected, 3);
    }
  });

  it('is exactly 1 at the shipped supermajority default and below 1 above it', () => {
    for (const panelSize of [3, 5, 15, 45, 135]) {
      const supermajority = Math.ceil((2 * panelSize) / 3);
      expect(quorumCapCorrection({ panelSize, quorum: supermajority, adversaryWeight: third })).toBeCloseTo(1, 12);
      if (supermajority < panelSize) {
        expect(quorumCapCorrection({ panelSize, quorum: supermajority + 1, adversaryWeight: third }))
          .toBeLessThan(1);
      }
    }
  });

  it('signals the 3-of-5 exposure: kappa > 1 for every weaker quorum', () => {
    for (const quorum of [1, 2, 3]) {
      expect(quorumCapCorrection({ panelSize: 5, quorum, adversaryWeight: third })).toBeGreaterThan(1);
    }
  });

  it('fails closed when kappa is 0/0 (a zero weight share has no defined correction)', () => {
    // Both tails are exactly zero at rho = 0, so the ratio is undefined; a host
    // must price a worst-case share it can name, never a zero one.
    expect(() => quorumCapCorrection({
      panelSize: 5, quorum: 3, adversaryWeight: { numerator: 0, denominator: 100 },
    })).toThrow(/κ is undefined/);
  });
});
