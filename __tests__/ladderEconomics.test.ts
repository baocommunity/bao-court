// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * ladderEconomics — the escalation cap and the per-round bond schedule, pinned
 * to the numbers `docs/proofs/economics/06-expert-verify.tex.md` publishes (§1).
 *
 * Two different integers live in that document and they must not be confused:
 *
 *   - the FLIP round (06 §1.3, "flip round" column) is `ceil(boundary)` — the
 *     first round at which the unmerited challenger's expected profit turns
 *     POSITIVE: **7** at `a_f = 0.9`, 5 at 0.85, 4 at 0.80, 3 at 0.75, 2 at 0.70;
 *   - the CAP (06 §1.5's boxed rule) is `floor(boundary)` — the deepest round
 *     that is still unprofitable: 6 at 0.9 (the machine's ceiling clamps it to
 *     5), 4 at 0.85, 3 at 0.80, 2 at 0.75, 1 at 0.70.
 *
 * A cap of 6 is safe; a cap of 7 is exactly the profitable round, which is why
 * the reducer's ceiling (`MAX_LADDER_ROUNDS = 5`) is below the boundary at
 * `a_f = 0.9` and why `deriveMaxLadderRounds` clamps rather than rounds up.
 * The tests below ASSERT the sign rather than trusting the formula: the EV must
 * be negative at the cap and positive at the flip round.
 */

import { describe, expect, it } from 'vitest';

import {
  cumulativeLadderBondMultiple,
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  escalationBondMultiple,
  escalationOptionEv,
  ladderCapWithinBound,
  ladderSignBoundary,
} from '../ladderEconomics';
import { MAX_LADDER_ROUNDS } from '../confirmationMachineCore';

const SPEC = { rho: 0.03, beta: 0.03 } as const; // A4: 3 % reward, 3 % bond
const ESCROW = { rho: 0.03, beta: 0.05 } as const; // escrow.ts's 5 % bond

describe('the sign boundary and the two derived rounds (06 §1.2–§1.5)', () => {
  it('reproduces the published flip-round column: 7 / 5 / 4 / 3 / 2', () => {
    const rows: Array<[number, number]> = [
      [0.9, 7],  // A4
      [0.85, 5],
      [0.8, 4],
      [0.75, 3],
      [0.7, 2],
    ];
    for (const [a_f, flip] of rows) {
      expect(deriveLadderFlipRound({ a_f, ...SPEC }), `a_f=${a_f}`).toBe(flip);
    }
  });

  it('derives the SAFE cap (floor), clamped to the machine ceiling: 5 / 4 / 3 / 2 / 1', () => {
    const rows: Array<[number, number]> = [
      [0.9, MAX_LADDER_ROUNDS], // derivation 6, machine ceiling 5
      [0.85, 4],
      [0.8, 3],
      [0.75, 2],
      [0.7, 1],
    ];
    for (const [a_f, cap] of rows) {
      expect(deriveMaxLadderRounds({ a_f, ...SPEC }), `a_f=${a_f}`).toBe(cap);
    }
  });

  it('pins the escrow-bond row: flip round 10, cap clamped, boundary 9.31', () => {
    expect(ladderSignBoundary({ a_f: 0.9, ...ESCROW })).toBeCloseTo(9.31, 2);
    expect(deriveLadderFlipRound({ a_f: 0.9, ...ESCROW })).toBe(10);
    expect(deriveMaxLadderRounds({ a_f: 0.9, ...ESCROW })).toBe(MAX_LADDER_ROUNDS);
  });

  it('the cap is the SIGN boundary, not a round number: EV < 0 at the cap, > 0 from the flip round', () => {
    for (const a_f of [0.9, 0.85, 0.8, 0.75, 0.7]) {
      const cap = deriveMaxLadderRounds({ a_f, ...SPEC });
      for (let round = 0; round <= cap; round += 1) {
        expect(escalationOptionEv({ a_f, ...SPEC, rounds: round }), `a_f=${a_f} R=${round}`)
          .toBeLessThan(0);
      }
      const flip = deriveLadderFlipRound({ a_f, ...SPEC });
      expect(escalationOptionEv({ a_f, ...SPEC, rounds: flip }), `a_f=${a_f} flip=${flip}`)
        .toBeGreaterThan(0);
    }
  });

  it('reproduces 06 §1.2\'s shipped-cap and protocol-cap EV rows (−1.860 % and −0.543 %)', () => {
    expect(escalationOptionEv({ a_f: 0.9, ...SPEC, rounds: 2 })).toBeCloseTo(-0.0186, 6);
    expect(escalationOptionEv({ a_f: 0.9, ...SPEC, rounds: 5 })).toBeCloseTo(-0.0054294, 7);
    // The escrow bond row of the same table.
    expect(escalationOptionEv({ a_f: 0.9, ...ESCROW, rounds: 2 })).toBeCloseTo(-0.0348, 6);
  });

  it('is MONOTONE: a less accurate jury must never be given a deeper ladder', () => {
    let previousCap = Number.POSITIVE_INFINITY;
    let previousFlip = Number.POSITIVE_INFINITY;
    for (const a_f of [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5]) {
      const cap = deriveMaxLadderRounds({ a_f, ...SPEC });
      const flip = deriveLadderFlipRound({ a_f, ...SPEC });
      expect(cap).toBeLessThanOrEqual(previousCap);
      expect(flip).toBeLessThanOrEqual(previousFlip);
      previousCap = cap;
      previousFlip = flip;
    }
    // ...and a bigger bond (lower ρ/(ρ+β)) buys a deeper ladder, never a shorter one.
    let previousBondCap = 0;
    for (const beta of [0.01, 0.03, 0.05, 0.1, 0.2]) {
      const cap = deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta });
      expect(cap).toBeGreaterThanOrEqual(previousBondCap);
      previousBondCap = cap;
    }
  });

  it('a perfect jury (a_f = 1) never flips and keeps the ceiling', () => {
    expect(deriveMaxLadderRounds({ a_f: 1, ...SPEC })).toBe(MAX_LADDER_ROUNDS);
    expect(deriveLadderFlipRound({ a_f: 1, ...SPEC })).toBe(Number.POSITIVE_INFINITY);
    for (let round = 0; round <= MAX_LADDER_ROUNDS; round += 1) {
      expect(escalationOptionEv({ a_f: 1, ...SPEC, rounds: round })).toBeLessThan(0);
    }
  });

  it('fails closed on malformed parameters (a caller bug, never a silent default)', () => {
    expect(() => deriveMaxLadderRounds({ a_f: 0, ...SPEC })).toThrow(/a_f/);
    expect(() => deriveMaxLadderRounds({ a_f: 1.2, ...SPEC })).toThrow(/a_f/);
    expect(() => deriveMaxLadderRounds({ a_f: Number.NaN, ...SPEC })).toThrow(/a_f/);
    expect(() => deriveMaxLadderRounds({ a_f: 0.9, rho: 0, beta: 0.03 })).toThrow(/rho/);
    expect(() => deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta: -1 })).toThrow(/beta/);
    expect(() => escalationOptionEv({ a_f: 0.9, ...SPEC, rounds: 1.5 })).toThrow(/rounds/);
    expect(() => escalationOptionEv({ a_f: 0.9, ...SPEC, rounds: -1 })).toThrow(/rounds/);
  });
});

describe('the host pre-flight gate (06 §1.5 + §7 item 5)', () => {
  it('accepts a cap inside the bound and refuses one above it', () => {
    expect(ladderCapWithinBound({ a_f: 0.9, ...SPEC, maxLadderRounds: 2 }))
      .toEqual({ ok: true, derivedCap: MAX_LADDER_ROUNDS, flipRound: 7 });
    // 0.75 admits only 2: the shipped 2 passes, 3 does not.
    expect(ladderCapWithinBound({ a_f: 0.75, ...SPEC, maxLadderRounds: 2 }).ok).toBe(true);
    expect(ladderCapWithinBound({ a_f: 0.75, ...SPEC, maxLadderRounds: 3 }).ok).toBe(false);
    expect(ladderCapWithinBound({ a_f: 0.7, ...SPEC, maxLadderRounds: 2 }).ok).toBe(false);
    expect(() => ladderCapWithinBound({ a_f: 0.9, ...SPEC, maxLadderRounds: 6 })).toThrow(/maxLadderRounds/);
  });
});

describe('the per-round bond schedule (02-ladder Theorem 2, quoted in 06 §1.1)', () => {
  it('prices each round at 3^R b₀ and reaches the published 4/13/40/121/364×', () => {
    expect([0, 1, 2, 3, 4, 5].map(escalationBondMultiple)).toEqual([1, 3, 9, 27, 81, 243]);
    expect([1, 2, 3, 4, 5].map(cumulativeLadderBondMultiple)).toEqual([4, 13, 40, 121, 364]);
    // Round 0 is the case's own challenge bond.
    expect(cumulativeLadderBondMultiple(0)).toBe(1);
  });

  it('makes depth cost 3× per rung — the marginal cost the shipped machine charged as 0', () => {
    for (let round = 1; round <= MAX_LADDER_ROUNDS; round += 1) {
      expect(escalationBondMultiple(round) / escalationBondMultiple(round - 1)).toBe(3);
    }
    // The option 06 §1.1 said the mechanism gave away at R = 5: 363 b₀ on top of
    // the challenge bond (C₅ = 364 b₀, of which 1 is the membership bond).
    expect(cumulativeLadderBondMultiple(5) - 1).toBe(363);
  });

  it('refuses a round outside the ladder', () => {
    expect(() => escalationBondMultiple(-1)).toThrow(/round/);
    expect(() => escalationBondMultiple(MAX_LADDER_ROUNDS + 2)).toThrow(/round/);
    expect(() => cumulativeLadderBondMultiple(1.5)).toThrow(/round/);
  });
});
