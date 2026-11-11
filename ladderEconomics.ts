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
 * Two numbers, and why both are exported
 * --------------------------------------
 * `deriveMaxLadderRounds` returns the SAFE cap (the floor): the deepest round
 * a challenger may reach with `E[π] < 0`. `deriveLadderFlipRound` returns the
 * first UNSAFE round (the ceiling, one higher unless the ratio is an exact
 * integer) — the number 06 §1.3 prints in its "flip round" column (7 at
 * `a_f = 0.9`, 5 at 0.85, 3 at 0.75) and the one a monitoring alert should
 * fire on. Shipping the cap at the flip round would legalise the one round that
 * is profitable, so the two are deliberately separate values.
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

/**
 * The exact sign boundary `ln(ρ/(ρ+β)) / ln(a_f)` — the round at which a
 * challenger's expected profit crosses zero. Exported so the two derived
 * integers below (and any host telemetry) share one evaluation.
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
 * The SAFE ladder cap: the deepest escalation round with `E[π] < 0`, i.e.
 *
 *     floor( ln(ρ/(ρ+β)) / ln(a_f) ),  capped at MAX_LADDER_ROUNDS.
 *
 * 06 §1.5's interim parameter rule, in code. Because the machine's own ceiling
 * is `MAX_LADDER_ROUNDS` (5), a derivation above it is reported as the ceiling
 * rather than as an unreachable number.
 *
 * **`0` means "no depth is safe" (R33, r33-6).** When `a_f` is at or below
 * `ρ/(ρ+β)` — a jury that is no better than a coin on manufactured disputes, at
 * `β = ρ` an accuracy of ½ — the sign boundary is `≤ 1`, so round 1 itself is
 * already profitable and no legal ladder may be opened. The earlier version
 * clamped that to `1` and its own contract ("E[π] < 0 for every R ≤ derived")
 * was false there; `ladderCapWithinBound` then blessed the profitable cap. The
 * clamp only applies upwards now.
 *
 * Monotone non-increasing in `a_f` (a less accurate jury must not be given a
 * deeper ladder) and non-decreasing in `β`.
 *
 * @example
 * ```ts
 * deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta: 0.03 }); // 5 (derivation 6, ceiling 5)
 * deriveMaxLadderRounds({ a_f: 0.75, rho: 0.03, beta: 0.03 }); // 2 (derivation 2.41)
 * deriveMaxLadderRounds({ a_f: 0.45, rho: 0.03, beta: 0.03 }); // 0 (no safe depth)
 * ```
 */
export function deriveMaxLadderRounds(params: LadderParameters): number {
  const boundary = ladderSignBoundary(params);
  if (!Number.isFinite(boundary)) return MAX_LADDER_ROUNDS;
  // `boundary === 1` is break-even at round 1 (E[π] = 0), not safe: the
  // contract is strictly negative.
  if (boundary <= 1) return 0;
  return Math.min(MAX_LADDER_ROUNDS, Math.floor(boundary));
}

/**
 * The first UNSAFE round — `ceil(ln(ρ/(ρ+β)) / ln(a_f))`, at least 1 — i.e.
 * the round at which `E[π]` becomes positive. This is 06 §1.3's "flip round"
 * column (7 at `a_f = 0.9`, 5 at 0.85, 3 at 0.75) and the number a pre-flight
 * alert should watch: a configured cap at or above it prices the option for
 * the challenger. It is deliberately NOT the cap (see `deriveMaxLadderRounds`).
 *
 * Returns `Number.POSITIVE_INFINITY` at `a_f = 1`.
 */
export function deriveLadderFlipRound(params: LadderParameters): number {
  const boundary = ladderSignBoundary(params);
  if (!Number.isFinite(boundary)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(boundary));
}

/**
 * The unmerited challenger's expected profit after escalating to round `R`, in
 * units of V: `E[π(R)] = (1 − a_f^R)·ρ − a_f^R·β` (06 §1.2). `R = 0` is
 * conceding and yields `−β`.
 *
 * This is the function the cap is derived from; it is exported so a host (or a
 * test) can ASSERT the bound instead of trusting it: `E[π(R)] < 0` for every
 * `R <= deriveMaxLadderRounds(...)` and `> 0` from `deriveLadderFlipRound(...)`
 * up.
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
 * a cap is inside the bound iff it is BELOW the flip round, i.e. iff
 * `E[π(cap)] < 0` strictly. That is the same comparison for every non-integer
 * boundary, and it is the only correct one when the boundary is `≤ 1` — the
 * case where `derivedCap` is `0` (no safe depth) and a naive `cap <= derivedCap`
 * would still be false, but the old `derivedCap = 1` clamp made it TRUE. A host
 * that only reads `derivedCap` must therefore treat `0` as "refuse every
 * ladder", which is what the number means.
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
  const derivedCap = deriveMaxLadderRounds(params);
  const flipRound = deriveLadderFlipRound(params);
  return {
    ok: maxLadderRounds < flipRound,
    derivedCap,
    flipRound,
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
