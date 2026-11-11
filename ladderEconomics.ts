// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * ladderEconomics — the ESCALATION ARITHMETIC of the multi-round ladder, as
 * pure functions of the parameters the host already owns.
 *
 * Why this module exists
 * ----------------------
 * `docs/proofs/economics/06-expert-verify.tex.md` §1 (r30-1) shows that the
 * shipped escalation cost is `ΔC_{r+1} = 0` for every round: `accept_challenge`
 * is the only event that admits a bond, and `escalate` carries no amount, so
 * one payment funds the whole ladder. §1.3 then derives the rule a host must
 * apply when it caps the ladder — a rule that was only ever quoted from a
 * document, so each operator had to re-derive it (the "one value, one
 * derivation" defect R28 fixed for γ and R30 fixed for κ):
 *
 *     maxLadderRounds ≤ floor( ln(ρ/(ρ+β)) / ln(a_f) )
 *
 * with `a_f` the jury's measured accuracy on manufactured disputes, `ρ` the
 * reward on a win and `β` the bond (both in units of the market value V).
 * Below the bound the unmerited challenger's expected profit is negative; at
 * the next round it is positive and the ladder is a profitable option.
 *
 * The exported bound is the PREDICATE, evaluated exactly (R52)
 * -----------------------------------------------------------
 * The hand rule above is a real-valued expression; evaluating it with `log`
 * and `floor` rounds the wrong way at an exact-integer boundary (e.g.
 * `a_f = ½, β = 3ρ`, where `E[π](2) = 0` exactly): `floor` names the
 * BREAK-EVEN round, which the safety contract — STRICT `E[π](d) < 0` —
 * excludes. The exported number disagreed with the published gate by one round
 * at those points (report-vs-decision mismatch, H-2), so the bound is now
 * defined by the integer inequality Lean proves (`Ladder.safe`,
 * `safe_depth_bound` in `proofs/lean4/LadderBound.lean`):
 *
 *     safe(d)  ⟺  R·D^d < A^d·(R+B)     (a_f = A/D, ρ = R/S, β = B/S)
 *
 * Every parameter is converted to the exact rational its decimal text names
 * (`0.03` → `3/100`, not the nearest double) and the comparison is done in
 * `BigInt`. There is no logarithm and no floating-point comparison left on the
 * decision path, so an exact boundary cannot round in either direction, and
 * `β = 3ρ` — exact in decimal policy arithmetic, off by an ulp in binary — is
 * seen as the boundary the document derives *for the decimal the parameter
 * names*.
 *
 * ROUND 11 MEASURED THE EDGE OF THAT SENTENCE (r11-5). The input is a `number`,
 * and a number is rationalised as `String(value)` — its own shortest
 * round-trip text — so a policy constant expressed by ARITHMETIC carries the
 * binary fuzz into the bound: `beta: 3 * 0.1` names `0.30000000000000004`, a
 * DIFFERENT rational from `0.3`, and at the exact boundary `a_f = ½, β = 3ρ`
 * that spelling returns cap 2 where the strict predicate allows 1 — with
 * `ladderCapWithinBound` reporting `ok: true` for the break-even round. The
 * exactness this module proves is exactness about the PARAMETER VALUE, never
 * about the policy it was computed from. A host that must sit on the boundary
 * passes the literal decimal (`beta: 0.3`); a host that wants to pass policy
 * TEXT has no route today (string parameters are refused by design — the
 * `a_f as a string` pin in `__tests__/reviewRound5.test.ts`), which is the
 * deferred half of the finding (see `docs/REVIEW_ROUND_11.md` §4).
 *
 * Boundary semantics, stated once
 * ------------------------------
 * The returned depth is the largest STRICTLY-profitable-to-refuse depth for the
 * challenger (`E[π](d) < 0`, i.e. `R·D^d < A^d·(R+B)`, i.e. `d < flipRound`);
 * **the break-even depth is not included**. `0` means no depth is safe.
 *
 * Two numbers, and why both are exported
 * --------------------------------------
 * `deriveMaxLadderRounds` returns the SAFE cap: the deepest round a challenger
 * may reach with `E[π] < 0` (always `flipRound − 1`, clamped to the machine
 * ceiling). `deriveLadderFlipRound` returns the first UNSAFE round — the number
 * 06 §1.3 prints in its "flip round" column (7 at `a_f = 0.9`, 5 at 0.85, 3 at
 * 0.75) and the one a monitoring alert should fire on. Because the flip round
 * includes the break-even round, the two differ by exactly one even when the
 * boundary is an exact integer; there is no parameter point at which the cap
 * names the break-even round.
 *
 * Companion: the per-round bond schedule
 * --------------------------------------
 * The machine-level half of r30-1 (the per-round bond witness, R31) is priced
 * by the host. `docs/proofs/economics/02-ladder.tex.md` Theorem 2 fixes the
 * shape: escalation round R costs `ΔC_R = 3^R b₀` on top of the case's
 * challenge bond `b₀`, so reaching round R costs `(3^(R+1) − 1)/2 · b₀`
 * (4/13/40/121/364× at R = 1..5). `escalationBondMultiple` /
 * `cumulativeLadderBondMultiple` are that schedule, so a host that prices a
 * round does not have to re-derive it — and so a test can fail if the package
 * ever ships a schedule that disagrees with the document.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Every throw is a
 * caller bug (a non-finite accuracy, a non-positive reward/bond, a round
 * outside the ladder), never a runtime state.
 */

import { MAX_LADDER_ROUNDS } from './confirmationMachineCore';

/** The ladder parameters, in the units 06 §1 uses (ρ and β as fractions of V). */
export interface LadderParameters {
  /**
   * Jury accuracy on MANUFACTURED disputes (06 §1.3 A4) — the probability an
   * honest panel rejects the challenger's manufactured round. In (0, 1];
   * `1` means the ladder never becomes profitable at any finite depth.
   */
  readonly a_f: number;
  /** Reward on a win (the challenger's prize), as a fraction of the market value V; > 0. */
  readonly rho: number;
  /** The case's challenge bond, as a fraction of V; > 0. */
  readonly beta: number;
}

function assertLadderParameters(params: LadderParameters): { a_f: number; rho: number; beta: number } {
  const { a_f, rho, beta } = params ?? ({} as LadderParameters);
  if (typeof a_f !== 'number' || !Number.isFinite(a_f) || a_f <= 0 || a_f > 1) {
    throw new Error(`a_f must be a finite accuracy in (0, 1] (got ${String(a_f)})`);
  }
  if (typeof rho !== 'number' || !Number.isFinite(rho) || rho <= 0) {
    throw new Error(`rho must be a finite positive reward (got ${String(rho)})`);
  }
  if (typeof beta !== 'number' || !Number.isFinite(beta) || beta <= 0) {
    throw new Error(`beta must be a finite positive bond (got ${String(beta)})`);
  }
  return { a_f, rho, beta };
}

function assertRounds(rounds: unknown): number {
  if (typeof rounds !== 'number' || !Number.isSafeInteger(rounds) || rounds < 0) {
    throw new Error(`rounds must be a non-negative safe integer (got ${String(rounds)})`);
  }
  return rounds;
}

/** An exact rational, `n / d` with `d > 0`, as `BigInt`. */
interface ExactRational {
  readonly n: bigint;
  readonly d: bigint;
}

/**
 * The exact rational a host's number NAMES: the shortest decimal that
 * round-trips to it (ECMA-262's `Number::toString`), parsed exactly.
 * `0.03` becomes `3/100`, not the nearest double `5404319552844595/2^59`,
 * because the ladder parameters are decimal policy numbers (ρ = 3 %, β = 9 %)
 * and the document's exact-boundary families (`β = 3ρ`, `a_f = ½`) are exact in
 * THAT arithmetic — this is what makes `E[π](2) = 0` land on the boundary the
 * economics doc says it does.
 *
 * Lossless in the sense that matters: the text parsed back is the same double
 * (`Number::toString` round-trips), so no parameter is silently changed; only
 * the 1-ulp fuzz of the binary encoding is removed before the comparison.
 */
const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/;
function exactRational(value: number): ExactRational {
  const text = String(value);
  const match = DECIMAL_TEXT.exec(text);
  if (!match) {
    // Non-finite values are refused by `assertLadderParameters`; this keeps the
    // invariant local (a NaN/Infinity cannot silently become a rational).
    throw new Error(`cannot rationalise ${text} as a finite decimal`);
  }
  const [, sign, integerDigits, fractionDigits = '', exponentDigits] = match;
  let n = BigInt(integerDigits + fractionDigits);
  let d = 10n ** BigInt(fractionDigits.length);
  const exponent = Number(exponentDigits ?? '0');
  if (exponent > 0) n *= 10n ** BigInt(exponent);
  else if (exponent < 0) d *= 10n ** BigInt(-exponent);
  return { n: sign === '-' ? -n : n, d };
}

/** The three ladder parameters as exact rationals. */
interface ExactLadder {
  readonly a: ExactRational;
  readonly reward: ExactRational;
  readonly bond: ExactRational;
}

function exactLadderParameters(params: LadderParameters): ExactLadder {
  const { a_f, rho, beta } = assertLadderParameters(params);
  const a = exactRational(a_f);
  const reward = exactRational(rho);
  const bond = exactRational(beta);
  if (a.n <= 0n || a.d <= 0n || reward.n <= 0n || bond.n <= 0n) {
    // Unreachable through the public API (`assertLadderParameters` refuses a
    // non-positive or non-finite parameter); kept as a load-bearing invariant
    // because the integer inequality below assumes both sides are positive.
    throw new Error('ladder parameters must reduce to positive exact rationals');
  }
  return { a, reward, bond };
}

/**
 * The Lean predicate `Ladder.safe` — `E[π](d) < 0` STRICTLY — in integers.
 *
 * Multiplying `ρ < a_f^d·(ρ+β)` through by the positive `rd·bd·D^d` gives
 *
 *     R·D^d < A^d·(R+B),   R = rn·bd,  B = bn·rd
 *
 * (`ρ` and `β` share the denominator `S = rd·bd`, which cancels). No
 * division, no logarithm, no floating point: an exact-integer boundary is
 * decided by `BigInt` comparison, so it cannot round in either direction.
 * `d = 0` is always safe (`safe_zero`: conceding forfeits `β > 0`).
 */
function strictlySafeAtDepth(exact: ExactLadder, d: number): boolean {
  const A = exact.a.n;
  const D = exact.a.d;
  const R = exact.reward.n * exact.bond.d;
  const B = exact.bond.n * exact.reward.d;
  let powerA = 1n;
  let powerD = 1n;
  for (let i = 0; i < d; i += 1) {
    powerA *= A;
    powerD *= D;
  }
  return R * powerD < powerA * (R + B);
}

/** `deriveMaxLadderRounds` over an already-rationalised parameter set. */
function capFromExact(exact: ExactLadder): number {
  // The safe set is an INITIAL SEGMENT (`safe_monotone` in LadderBound.lean), so
  // the cap is the round before the first unsafe one. Depth 0 is always safe
  // (`safe_zero`), hence the scan starts at 1 and `0` already means "no legal
  // round is safe" (r33-6).
  for (let d = 1; d <= MAX_LADDER_ROUNDS; d += 1) {
    if (!strictlySafeAtDepth(exact, d)) return d - 1;
  }
  return MAX_LADDER_ROUNDS;
}

/**
 * The exact sign boundary `ln(ρ/(ρ+β)) / ln(a_f)` — the round at which a
 * challenger's expected profit crosses zero (break-even). **Telemetry only:**
 * neither the cap nor the gate reads it (both decide on the exact integer
 * inequality, R52) — it is exported so a host's dashboards can quote the
 * real-valued crossing that the two integers straddle.
 *
 * Returns `Number.POSITIVE_INFINITY` at `a_f = 1` (a perfect jury never makes
 * the ladder profitable, so the boundary is unbounded).
 */
export function ladderSignBoundary(params: LadderParameters): number {
  const { a_f, rho, beta } = assertLadderParameters(params);
  if (a_f === 1) return Number.POSITIVE_INFINITY;
  return Math.log(rho / (rho + beta)) / Math.log(a_f);
}

/**
 * The SAFE ladder cap, **definitionally the safe predicate**: the largest
 * `d ∈ {0, …, MAX_LADDER_ROUNDS}` with `E[π](d) < 0` strictly, i.e. exactly
 * `max{d : R·D^d < A^d·(R+B)}` — the integer form Lean proves
 * (`Ladder.safe_depth_bound`: `safe d ↔ d < flipRound`). Because the cap is the
 * round *below* the first unsafe one, it is always `flipRound − 1` (clamped),
 * including at an exact-integer boundary where the old `floor(ln…)` evaluation
 * returned the break-even round itself (R52, H-2).
 *
 * The machine's own ceiling is `MAX_LADDER_ROUNDS` (5), so a larger exact
 * answer is reported as the ceiling rather than as an unreachable number.
 *
 * **`0` means "no depth is safe" (R33, r33-6).** When `a_f` is at or below
 * `ρ/(ρ+β)` — a jury no better than a coin on manufactured disputes, at `β = ρ`
 * an accuracy of ½ — round 1 itself is already break-even or profitable, so no
 * legal ladder may be opened. The earlier version clamped that to `1` and its
 * own contract ("E[π] < 0 for every R ≤ derived") was false there;
 * `ladderCapWithinBound` then blessed the profitable cap. The clamp only
 * applies upwards now.
 *
 * Monotone **non-decreasing in `a_f`** (a more accurate jury may only get a
 * deeper ladder; equivalently: a less accurate jury must not be given a deeper
 * one — the direction was stated backwards until review round 41, which
 * measured the grid 0.30…0.95 → caps 0…5 rather than trusting the sentence)
 * and non-decreasing in `β` (`derivedCap_mono_accuracy` / `_mono_bond`).
 *
 * @example
 * ```ts
 * deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta: 0.03 }); // 5 (derivation 6, ceiling 5)
 * deriveMaxLadderRounds({ a_f: 0.75, rho: 0.03, beta: 0.03 }); // 2 (derivation 2.41)
 * deriveMaxLadderRounds({ a_f: 0.45, rho: 0.03, beta: 0.03 }); // 0 (no safe depth)
 * deriveMaxLadderRounds({ a_f: 0.5, rho: 1, beta: 3 });        // 1 (boundary 2 = break-even, excluded)
 *
 * deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: 0.3 });    // 1 (β = 3ρ exactly)
 * deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: 3 * 0.1 });// 2 (β = 0.30000000000000004,
 *                                                             //    the ulp spelling — r11-5)
 * ```
 */
export function deriveMaxLadderRounds(params: LadderParameters): number {
  return capFromExact(exactLadderParameters(params));
}

/**
 * The first UNSAFE round — the smallest `d ≥ 1` with `not (E[π](d) < 0)`, i.e.
 * the round at which `E[π]` reaches zero or turns positive (the break-even
 * round is included: `break_even_not_safe`). This is 06 §1.3's "flip round"
 * column (7 at `a_f = 0.9`, 5 at 0.85, 3 at 0.75) and the number a pre-flight
 * alert should watch: a configured cap at or above it prices the option for the
 * challenger. It is deliberately NOT the cap (see `deriveMaxLadderRounds`).
 *
 * Evaluated exactly (integer form) for every round a legal cap could reach
 * (`1 … MAX_LADDER_ROUNDS + 1`), so `flipRound = cap + 1` unclamped even at an
 * exact-integer boundary. Deeper than the machine's ceiling the number is only
 * telemetry, and the logarithmic boundary rounded up is reported instead — no
 * legal cap can reach it either way.
 *
 * Returns `Number.POSITIVE_INFINITY` at `a_f = 1` (`perfect_jury_all_depths_safe`).
 */
export function deriveLadderFlipRound(params: LadderParameters): number {
  const exact = exactLadderParameters(params);
  for (let d = 1; d <= MAX_LADDER_ROUNDS + 1; d += 1) {
    if (!strictlySafeAtDepth(exact, d)) return d;
  }
  const boundary = ladderSignBoundary(params);
  if (!Number.isFinite(boundary)) return Number.POSITIVE_INFINITY;
  return Math.max(MAX_LADDER_ROUNDS + 2, Math.ceil(boundary));
}

/**
 * The unmerited challenger's expected profit after escalating to round `R`, in
 * units of V: `E[π(R)] = (1 − a_f^R)·ρ − a_f^R·β` (06 §1.2). `R = 0` is
 * conceding and yields `−β`.
 *
 * This is the function the cap is derived from; it is exported so a host (or a
 * test) can ASSERT the bound instead of trusting it: `E[π(R)] < 0` for every
 * `R <= deriveMaxLadderRounds(...)` and `>= 0` from `deriveLadderFlipRound(...)`
 * up. Note that the DERIVATION does not use this evaluation — it decides on the
 * exact integer inequality (R52) — so the two agree to within IEEE-754
 * resolution at the boundary and agree exactly everywhere else.
 */
export function escalationOptionEv(params: LadderParameters & { readonly rounds: number }): number {
  const { a_f, rho, beta } = assertLadderParameters(params);
  const rounds = assertRounds(params.rounds);
  const survive = a_f ** rounds;
  return (1 - survive) * rho - survive * beta;
}

/**
 * Does a configured cap respect the derived bound? The host pre-flight gate of
 * 06 §1.5 / §7 item 5: re-measure `a_f`, then re-derive the cap. Returns the
 * verdict plus both derived numbers so a refusal message can quote them.
 *
 * `ok` is decided by the SIGN, not by comparing with `derivedCap` (R33, r33-6):
 * a cap is inside the bound iff `E[π](cap) < 0` strictly, evaluated with the
 * SAME exact-integer predicate that produces `derivedCap` (R52). That makes the
 * gate and the exported number the same predicate by construction:
 * `ok ⟺ maxLadderRounds ≤ derivedCap`, i.e. `ok ⟺ maxLadderRounds < flipRound`,
 * at every parameter point — including an exact-integer boundary, where the old
 * `floor(ln…)` cap named the break-even round while this gate refused it. A host
 * that only reads `derivedCap` must treat `0` as "refuse every ladder", which is
 * what the number means.
 */
export function ladderCapWithinBound(params: LadderParameters & { readonly maxLadderRounds: number }): {
  readonly ok: boolean;
  readonly derivedCap: number;
  readonly flipRound: number;
} {
  const { maxLadderRounds } = params;
  if (
    typeof maxLadderRounds !== 'number'
    || !Number.isSafeInteger(maxLadderRounds)
    || maxLadderRounds < 1
    || maxLadderRounds > MAX_LADDER_ROUNDS
  ) {
    throw new Error(
      `maxLadderRounds must be a safe integer in [1, ${MAX_LADDER_ROUNDS}] (got ${String(maxLadderRounds)})`,
    );
  }
  // One rationalisation, one predicate: `ok` and `derivedCap` cannot disagree.
  const exact = exactLadderParameters(params);
  const derivedCap = capFromExact(exact);
  return {
    ok: strictlySafeAtDepth(exact, maxLadderRounds),
    derivedCap,
    flipRound: deriveLadderFlipRound(params),
  };
}

/**
 * `ΔC_R / b₀` — the marginal bond for escalation round `R` per Theorem 2:
 * `3^R` (round 0 is the case's own challenge bond, `1×`). 06 §1.5 warns that a
 * host doubling this (`escrow.ts`'s `2^(r−1)`) under-prices the ladder by
 * `2^(r−1)/3^r`; this module is the spec side of that reconciliation.
 */
export function escalationBondMultiple(round: number): number {
  const r = assertRounds(round);
  if (r > MAX_LADDER_ROUNDS + 1) {
    throw new Error(`round must be within the ladder (got ${r})`);
  }
  return 3 ** r;
}

/**
 * `C_R / b₀` — the CUMULATIVE bond to reach round `R`: `(3^(R+1) − 1)/2` for
 * `R >= 1`, and `1` for `R = 0` (the challenge bond alone). Theorem 2's
 * 4/13/40/121/364× at `R = 1..5` (02-ladder, quoted in 06 §1.1).
 */
export function cumulativeLadderBondMultiple(round: number): number {
  const r = assertRounds(round);
  if (r > MAX_LADDER_ROUNDS + 1) {
    throw new Error(`round must be within the ladder (got ${r})`);
  }
  if (r === 0) return 1;
  return (3 ** (r + 1) - 1) / 2;
}
