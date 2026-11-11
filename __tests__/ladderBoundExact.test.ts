// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE EXPORTED LADDER BOUND IS THE SAFE PREDICATE — exact-integer property test
 * (R52; closes the round-46a finding, report-vs-decision mismatch class H-2).
 *
 * The defect this file locks out
 * ------------------------------
 * `deriveMaxLadderRounds` used to evaluate `floor(ln(ρ/(ρ+β)) / ln a_f)`. At an
 * EXACT-INTEGER boundary (`a_f = ½, β = 3ρ`, so `E[π](2) = 0` exactly) `floor`
 * and `ceil` coincide, so the exported cap named the BREAK-EVEN round — the one
 * round the safety predicate EXCLUDES, because the contract is strict
 * (`E[π](d) < 0`). The published gate `ladderCapWithinBound` refused that very
 * cap: the number a host reads and the decision the gate makes disagreed by one
 * round. The cap is now the predicate itself, evaluated in `BigInt` on the exact
 * rational each parameter names:
 *
 *     safe(d)  ⟺  E[π](d) < 0  ⟺  R·D^d < A^d·(R+B)   (a_f = A/D, ρ = R/S, β = B/S)
 *
 * Boundary semantics: the returned depth is the largest STRICTLY-profitable-to-
 * refuse depth; the break-even depth is NOT included (it is `flipRound`).
 *
 * What each assertion mirrors in `proofs/lean4/LadderBound.lean`
 * ------------------------------------------------------------------
 *   `safe` (def)              the predicate itself: `R·D^d < A^d·(R+B)`; every
 *                             cap assertion below is checked against an
 *                             INDEPENDENT exact-rational evaluation of
 *                             `E[π](d) = ρ(1 − a_f^d) − a_f^d·β` (reduced
 *                             fractions, own decimal parser — the module's
 *                             scaled-inequality arithmetic is never reused).
 *   `safe_zero`               `d = 0` is always safe (`E[π](0) = −β`), so the cap
 *                             is never negative and `0` means "no legal depth".
 *   `break_even_not_safe`     `¬safe(cap + 1)`: the successor of the cap is at or
 *                             above break-even — the round that used to leak out.
 *   `safe_monotone`           the safe set is an INITIAL SEGMENT: every depth
 *                             `≤ cap` is safe (the cap is a complete description).
 *   `derivedCap`,
 *   `safe_depth_bound`        `cap = flipRound − 1` (unclamped) and
 *                             `safe(d) ⟺ d < flipRound`; `ladderCapWithinBound().ok`
 *                             is the same predicate, so `ok(cap)` is true and
 *                             `ok(cap + 1)` is false.
 *   `flipRound_spec`          the flip round is unsafe and every shallower round
 *                             is safe — recomputed here by the oracle.
 *   `derivedCapZero_no_safe_depth`
 *                             `cap = 0` ⇒ every legal round (`d ≥ 1`) is
 *                             unprofitable-to-refuse, so the gate refuses all of
 *                             them (the r33-6 case).
 *   `unsafe_witness`,
 *   `exists_unsafe`           the ladder is not a free option: at the explicit
 *                             witness depth `d = A·B` the challenger's expected
 *                             profit is `≥ 0`, recomputed through the module's
 *                             own exported `escalationOptionEv`.
 *   `perfect_jury_all_depths_safe`
 *                             `a_f = 1` ⇒ nothing is ever profitable ⇒ ceiling.
 *   `derivedCap_mono_accuracy`,
 *   `derivedCap_mono_bond`    the cap is non-decreasing in `a_f` and in `β`.
 *
 * Grid: 23 accuracies × 20 (ρ, β) economies = 460 configurations, including the
 * exact-integer families `a_f ∈ {½, ⅓, ⅔, ¾}`, `β = kρ` for `k = 1..5`, the
 * `a_f = ½` powers `β = (2^d − 1)ρ` (exact boundaries at `d = 3, 4, 5`), and the
 * `u/v` rational families (`9/16 = (¾)²`, `4/9 ≈ (⅔)²`).
 */

import { describe, expect, it } from 'vitest';

import {
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  escalationOptionEv,
  ladderCapWithinBound,
  ladderSignBoundary,
  type LadderParameters,
} from '../ladderEconomics';
import { MAX_LADDER_ROUNDS } from '../confirmationMachineCore';

// ─────────────────────────────────────────────────────────────────────────────
// An INDEPENDENT exact implementation (deliberately not the module's)
//
// The module converts each parameter to `n/d` and evaluates the SCALED
// inequality `R·D^d < A^d·(R+B)`. Here we instead evaluate `E[π](d)` itself as
// a reduced rational and take its sign, with a separate decimal parser. Two
// different routes to the same predicate: an algebra slip in either shows up as
// a disagreement.
// ─────────────────────────────────────────────────────────────────────────────

interface Frac {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function frac(n: bigint, d: bigint): Frac {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

/** The rational the decimal text of `x` names (`0.03` → 3/100). */
function fromDecimal(x: number): Frac {
  const text = String(x);
  const neg = text.startsWith('-');
  const unsigned = neg ? text.slice(1) : text;
  const [mantissa, expText] = unsigned.split('e');
  const exponent = expText === undefined ? 0 : Number(expText);
  const [whole, tail = ''] = mantissa.split('.');
  const digits = `${whole}${tail}`;
  // value = digits · 10^(exponent − |tail|)
  const shift = exponent - tail.length;
  const n0 = BigInt(digits);
  const n = shift >= 0 ? n0 * 10n ** BigInt(shift) : n0;
  const d = shift >= 0 ? 1n : 10n ** BigInt(-shift);
  return frac(neg ? -n : n, d);
}

const ONE: Frac = { n: 1n, d: 1n };

function mul(a: Frac, b: Frac): Frac {
  return frac(a.n * b.n, a.d * b.d);
}

function sub(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d - b.n * a.d, a.d * b.d);
}

function pow(a: Frac, d: number): Frac {
  let acc = ONE;
  for (let i = 0; i < d; i += 1) acc = mul(acc, a);
  return acc;
}

/** `E[π](d) = ρ·(1 − a_f^d) − a_f^d·β`, exactly, in lowest terms. */
function exactEv(params: LadderParameters, d: number): Frac {
  const a = fromDecimal(params.a_f);
  const rho = fromDecimal(params.rho);
  const beta = fromDecimal(params.beta);
  const survive = pow(a, d);
  return sub(mul(rho, sub(ONE, survive)), mul(survive, beta));
}

/** `ρ/(ρ+β)` as a fraction (one reduction, no per-operation gcd). */
function riskRatio(params: LadderParameters): Frac {
  const rho = fromDecimal(params.rho);
  const beta = fromDecimal(params.beta);
  const numerator = rho.n * beta.d;
  const denominator = rho.n * beta.d + beta.n * rho.d;
  return frac(numerator, denominator);
}

/** `a_f^d` as a numerator/denominator pair (single exponentiation, no gcd). */
function accuracyPower(params: LadderParameters, d: number): Frac {
  const a = fromDecimal(params.a_f);
  return { n: a.n ** BigInt(d), d: a.d ** BigInt(d) };
}

/** Sign of `x − y` for positive rationals. */
function compare(x: Frac, y: Frac): number {
  const left = x.n * y.d;
  const right = y.n * x.d;
  return left === right ? 0 : left > right ? 1 : -1;
}

/** The Lean predicate `safe`: `E[π](d) < 0` strictly. */
function exactSafe(params: LadderParameters, d: number): boolean {
  // E[π](d) < 0 ⟺ ρ < a_f^d·(ρ+β) ⟺ ρ/(ρ+β) < a_f^d
  return compare(accuracyPower(params, d), riskRatio(params)) > 0;
}

/** `max{d ∈ 0..MAX : E[π](d) < 0}`, with `0` when even `d = 1` is not safe. */
function oracleCap(params: LadderParameters): number {
  for (let d = 1; d <= MAX_LADDER_ROUNDS; d += 1) {
    if (!exactSafe(params, d)) return d - 1;
  }
  return MAX_LADDER_ROUNDS;
}

/** The first unsafe depth in the window a legal cap can reach, or `null`. */
function oracleFlip(params: LadderParameters): number | null {
  for (let d = 1; d <= MAX_LADDER_ROUNDS + 1; d += 1) {
    if (!exactSafe(params, d)) return d;
  }
  return null;
}

const label = (p: LadderParameters): string => `a_f=${p.a_f} rho=${p.rho} beta=${p.beta}`;

// ─────────────────────────────────────────────────────────────────────────────
// The grid
// ─────────────────────────────────────────────────────────────────────────────

const ACCURACIES: ReadonlyArray<number> = [
  1, 0.99, 0.95, 0.9, 0.875, 0.85, 0.8, 0.75, 0.7, 2 / 3, 0.65, 0.625, 0.6,
  0.55, 0.5, 0.45, 0.4, 1 / 3, 0.3, 0.25, 0.2, 0.125, 0.1,
];

const ECONOMIES: ReadonlyArray<{ rho: number; beta: number }> = [
  { rho: 1, beta: 1 }, // β = kρ, k = 1
  { rho: 1, beta: 2 }, // k = 2
  { rho: 1, beta: 3 }, // k = 3 — the exact-integer boundary at a_f = ½
  { rho: 1, beta: 4 }, // k = 4
  { rho: 1, beta: 5 }, // k = 5
  { rho: 1, beta: 7 }, // (½)³ = ⅛ — boundary 3
  { rho: 1, beta: 15 }, // (½)⁴ = 1/16 — boundary 4
  { rho: 1, beta: 31 }, // (½)⁵ = 1/32 — boundary 5
  { rho: 9, beta: 7 }, // (¾)² = 9/16 — boundary 2
  { rho: 4, beta: 5 }, // (⅔)² ≈ 4/9 — near-boundary family
  { rho: 1, beta: 0.5 },
  { rho: 1, beta: 0.25 },
  { rho: 2, beta: 1 },
  { rho: 3, beta: 1 },
  { rho: 1, beta: 10 },
  { rho: 0.03, beta: 0.03 }, // 06 §1's spec pair
  { rho: 0.03, beta: 0.05 }, // escrow.ts's 5 % bond
  { rho: 0.05, beta: 0.01 }, // reward-heavy
  { rho: 0.01, beta: 0.09 }, // bond-heavy
  { rho: 0.3, beta: 0.9 }, // the spec pair ×10 (β = 3ρ again)
];

const GRID: ReadonlyArray<LadderParameters> = ACCURACIES.flatMap((a_f) =>
  ECONOMIES.map((economy) => ({ a_f, ...economy })),
);

// ─────────────────────────────────────────────────────────────────────────────
// §1  The cap IS `safe` — on the whole grid
// ─────────────────────────────────────────────────────────────────────────────

describe('R52 §1 — `derivedCap` is the largest d with E[π](d) < 0 (Lean: safe, safe_depth_bound)', () => {
  it(`matches an independent exact evaluation over ${GRID.length} configurations`, () => {
    for (const params of GRID) {
      expect({ case: label(params), cap: deriveMaxLadderRounds(params) })
        .toEqual({ case: label(params), cap: oracleCap(params) });
    }
  });

  it('safe is an INITIAL SEGMENT: every depth up to the cap is strictly unprofitable (safe_monotone)', () => {
    for (const params of GRID) {
      const cap = deriveMaxLadderRounds(params);
      for (let d = 0; d <= cap; d += 1) {
        expect({ case: label(params), d, safe: exactSafe(params, d) })
          .toEqual({ case: label(params), d, safe: true });
      }
      // break_even_not_safe: below the ceiling the successor is never inside the
      // bound (at the ceiling the cap is clamped, so "successor" is out of range).
      if (cap < MAX_LADDER_ROUNDS) {
        expect({ case: label(params), successorSafe: exactSafe(params, cap + 1) })
          .toEqual({ case: label(params), successorSafe: false });
      }
    }
  });

  it('the cap and the gate are the SAME predicate: ok(cap) true, ok(cap + 1) false (safe_depth_bound)', () => {
    for (const params of GRID) {
      const cap = deriveMaxLadderRounds(params);
      const verdict = ladderCapWithinBound({ ...params, maxLadderRounds: Math.max(1, cap) });
      // The gate reports the cap it derived — the number a host quotes.
      expect({ case: label(params), derivedCap: verdict.derivedCap })
        .toEqual({ case: label(params), derivedCap: cap });
      if (cap === 0) {
        // derivedCapZero_no_safe_depth: no legal depth may be admitted.
        for (let d = 1; d <= MAX_LADDER_ROUNDS; d += 1) {
          expect({ case: label(params), d, ok: ladderCapWithinBound({ ...params, maxLadderRounds: d }).ok })
            .toEqual({ case: label(params), d, ok: false });
        }
        continue;
      }
      expect({ case: label(params), ok: verdict.ok }).toEqual({ case: label(params), ok: true });
      if (cap + 1 <= MAX_LADDER_ROUNDS) {
        expect({ case: label(params), cap: cap + 1, ok: ladderCapWithinBound({ ...params, maxLadderRounds: cap + 1 }).ok })
          .toEqual({ case: label(params), cap: cap + 1, ok: false });
      }
    }
  });

  it('cap = flipRound - 1 unclamped; the flip round is the first unsafe depth (derivedCap, flipRound_spec)', () => {
    for (const params of GRID) {
      const cap = deriveMaxLadderRounds(params);
      const flip = deriveLadderFlipRound(params);
      const oracle = oracleFlip(params);
      if (oracle === null) {
        // No unsafe depth inside the window a legal cap can reach: the cap is the
        // ceiling (clamped), and the reported flip round is beyond it.
        expect(cap).toBe(MAX_LADDER_ROUNDS);
        expect(flip).toBeGreaterThan(MAX_LADDER_ROUNDS);
      } else {
        expect({ case: label(params), flip }).toEqual({ case: label(params), flip: oracle });
        expect(Math.min(MAX_LADDER_ROUNDS, flip - 1)).toBe(cap);
      }
    }
  });

  it('is monotone — non-decreasing in a_f and in β (derivedCap_mono_accuracy, derivedCap_mono_bond)', () => {
    for (const economy of ECONOMIES) {
      let previous = -1;
      for (const a_f of [...ACCURACIES].reverse()) {
        const cap = deriveMaxLadderRounds({ a_f, ...economy });
        expect({ a_f, cap: cap >= previous }).toEqual({ a_f, cap: true });
        previous = cap;
      }
    }
    for (const a_f of ACCURACIES) {
      let previous = -1;
      for (const beta of [0.25, 0.5, 1, 2, 3, 4, 5, 7, 15, 31]) {
        const cap = deriveMaxLadderRounds({ a_f, rho: 1, beta });
        expect({ a_f, beta, cap: cap >= previous }).toEqual({ a_f, beta, cap: true });
        previous = cap;
      }
    }
  });

  it('a perfect jury never flips and keeps the ceiling (perfect_jury_all_depths_safe)', () => {
    for (const economy of ECONOMIES) {
      const params = { a_f: 1, ...economy };
      expect(deriveMaxLadderRounds(params)).toBe(MAX_LADDER_ROUNDS);
      expect(deriveLadderFlipRound(params)).toBe(Number.POSITIVE_INFINITY);
      for (let d = 0; d <= MAX_LADDER_ROUNDS; d += 1) expect(exactSafe(params, d)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  The pinned boundary table (round 46a's finding)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every row is an EXACT-INTEGER boundary (`a_f^d = ρ/(ρ+β)`), i.e. a depth where
 * `E[π](d) = 0` exactly — the case `floor(ln…)` reported as a safe cap. `old` is
 * the value the pre-R52 implementation returned (the break-even round); `flip`
 * is the boundary itself, which is not safe.
 */
const BOUNDARY_TABLE: ReadonlyArray<{
  readonly a_f: number;
  readonly rho: number;
  readonly beta: number;
  readonly flip: number;
  readonly old: number;
}> = [
  { a_f: 0.5, rho: 1, beta: 1, flip: 1, old: 0 }, // (½)¹ = ½ — old was right
  { a_f: 0.5, rho: 1, beta: 3, flip: 2, old: 2 }, // (½)² = ¼ — the pinned case
  { a_f: 0.5, rho: 1, beta: 7, flip: 3, old: 3 }, // (½)³ = ⅛
  { a_f: 0.5, rho: 1, beta: 15, flip: 4, old: 4 }, // (½)⁴ = 1/16
  { a_f: 0.5, rho: 1, beta: 31, flip: 5, old: 5 }, // (½)⁵ = 1/32
  { a_f: 0.5, rho: 0.03, beta: 0.09, flip: 2, old: 2 }, // 06 §1's units, β = 3ρ
  { a_f: 0.5, rho: 0.03, beta: 0.21, flip: 3, old: 3 },
  { a_f: 0.75, rho: 9, beta: 7, flip: 2, old: 2 }, // (¾)² = 9/16
  { a_f: 0.25, rho: 1, beta: 3, flip: 1, old: 0 }, // (¼)¹ = ¼ — old was right
  { a_f: 0.2, rho: 1, beta: 4, flip: 1, old: 0 }, // (⅕)¹ = ⅕ — old was right
];

describe('R52 §2 — the boundary table: the cap stops below break-even (break_even_not_safe)', () => {
  it('returns flipRound - 1 (or 0), never the break-even round', () => {
    for (const row of BOUNDARY_TABLE) {
      const params = { a_f: row.a_f, rho: row.rho, beta: row.beta };
      // The boundary is an exact integer: the real-valued quote agrees with the
      // integer index, so this is the family where the two used to collide.
      expect({ case: label(params), boundary: ladderSignBoundary(params) })
        .toEqual({ case: label(params), boundary: row.flip });
      expect({ case: label(params), cap: deriveMaxLadderRounds(params) })
        .toEqual({ case: label(params), cap: Math.max(0, row.flip - 1) });
      expect({ case: label(params), flip: deriveLadderFlipRound(params) })
        .toEqual({ case: label(params), flip: row.flip });
      // Break-even at the flip round, strictly unprofitable below it.
      expect(exactEv(params, row.flip).n).toBe(0n);
      if (row.flip > 1) expect(exactSafe(params, row.flip - 1)).toBe(true);
    }
  });

  it('the pre-R52 values (floor of the log) named the break-even round on every row with flip >= 2', () => {
    // A regression table, not an oracle: `old` is what the retired definition
    // returned, and every `old >= 2` row named the break-even round.
    const wrong = BOUNDARY_TABLE.filter((row) => row.old !== Math.max(0, row.flip - 1));
    expect(wrong.map((row) => `${row.a_f}/${row.rho}/${row.beta}: ${row.old} -> ${row.flip - 1}`)).toEqual([
      '0.5/1/3: 2 -> 1',
      '0.5/1/7: 3 -> 2',
      '0.5/1/15: 4 -> 3',
      '0.5/1/31: 5 -> 4',
      '0.5/0.03/0.09: 2 -> 1',
      '0.5/0.03/0.21: 3 -> 2',
      '0.75/9/7: 2 -> 1',
    ]);
    // …and the gate already refused every one of those rows, which is exactly
    // the report-vs-decision mismatch this round removed.
    for (const row of wrong) {
      const params = { a_f: row.a_f, rho: row.rho, beta: row.beta };
      expect({ case: label(params), ok: ladderCapWithinBound({ ...params, maxLadderRounds: row.old }).ok })
        .toEqual({ case: label(params), ok: false });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  The Lean witness `d = A·B`: the ladder is not a free option
// ─────────────────────────────────────────────────────────────────────────────

describe('R52 §3 — `unsafe_witness`: at d = A·B the challenger is not down (Lean: exists_unsafe)', () => {
  /**
   * `LadderBound.lean` proves `¬safe A D R B (A·B)` for `a_f = A/D < 1`,
   * `ρ = R/S > 0`, `β = B/S > 0`: no finite bond funds an unbounded option. The
   * witness depth is the product of the accuracy's numerator and the bond's
   * numerator — computed here from the decimal parameters with the oracle's own
   * parser, then evaluated through the MODULE's exported EV.
   */
  it('recomputes the witness depth from the module exports and finds a non-negative EV', () => {
    // The witness `d = A·B` must stay inside the float range, so the rows are
    // chosen with a small bond numerator (`B` is β's numerator over the shared
    // denominator `S = rd·bd`). `a_f = ⅔` is exercised in the cap grid instead.
    const cases: ReadonlyArray<{ a_f: number; rho: number; beta: number }> = [
      { a_f: 0.5, rho: 1, beta: 3 }, // A=1, B=3  ⇒ d = 3
      { a_f: 0.9, rho: 0.03, beta: 0.03 }, // A=9, B=300 ⇒ d = 2700
      { a_f: 0.75, rho: 9, beta: 7 }, // A=3, B=7  ⇒ d = 21
      { a_f: 0.1, rho: 1, beta: 2 }, // A=1, B=2  ⇒ d = 2
      { a_f: 0.6, rho: 0.03, beta: 0.05 }, // the escrow bond
    ];
    for (const params of cases) {
      const accuracy = fromDecimal(params.a_f);
      // R and B share the denominator S = rd·bd, exactly as in the Lean statement.
      const R = fromDecimal(params.rho).n * fromDecimal(params.beta).d;
      const B = fromDecimal(params.beta).n * fromDecimal(params.rho).d;
      expect(accuracy.n > 0n && accuracy.n < accuracy.d).toBe(true); // a_f ∈ (0,1) — A1
      expect(R > 0n && B > 0n).toBe(true); // ρ, β > 0 — A2
      const witness = accuracy.n * B; // d = A·B
      expect(witness > 0n).toBe(true);
      const depth = Number(witness);
      expect(Number.isSafeInteger(depth)).toBe(true);
      // Unsafe at the witness in EXACT arithmetic…
      expect({ case: label(params), safe: exactSafe(params, depth) })
        .toEqual({ case: label(params), safe: false });
      // …and through the module's own exported evaluation.
      expect({ case: label(params), ev: escalationOptionEv({ ...params, rounds: depth }) >= 0 })
        .toEqual({ case: label(params), ev: true });
      // The witness is deeper than the first unsafe round: the ladder always ends.
      expect(depth).toBeGreaterThanOrEqual(deriveLadderFlipRound(params));
    }
  });
});
