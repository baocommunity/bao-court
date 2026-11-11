// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * quorumEconomics — the CAPTURE ARITHMETIC of a confirm quorum, as a pure
 * function of state this machine already records.
 *
 * Why this module exists
 * ----------------------
 * `confirmationMachineCore.ts` derives the supermajority quorum ⌈2N/3⌉ and the
 * factory records `quorumBelowSupermajority` when a host supplies a weaker one
 * (R25; `docs/proofs/economics/05-review-gapfills.tex.md` §1.3). The
 * *consequence* of that flag was only ever quoted from a table in a document:
 * the probability that an adversary holding weight share ρ captures the panel,
 * and the factor by which a sub-supermajority quorum multiplies it. A host that
 * prices the flag — the economic cap of `bao.markets`
 * `packages/markets/services/bao-markets/courtEconomicRatio.ts`, or a
 * pre-flight gate — would have to re-derive that arithmetic at its own call
 * site, which is exactly the "one value, one derivation" defect R28 fixed for
 * γ. This module is that arithmetic, once, exactly, from the same state the
 * machine already has.
 *
 * The model (05 §1.1, "Model D")
 * ------------------------------
 * The shipped draw is an exponential race with rate $w_j$
 * (`selection.ts` `weightedPriority`), so a seat goes to the adversary with
 * probability ρ = its weight share. Seats are filled independently, hence
 *
 *   X ~ Bin(N, ρ),  capture ⟺ X ≥ q,  π(N, q, ρ) = Σ_{k=q}^{N} C(N,k) ρ^k (1−ρ)^{N−k}
 *
 * which is an UPPER bound on the true probability: the shipped draw samples
 * WITHOUT replacement (hypergeometric), whose tail is thinner at the same mean
 * (05 §1.1 caveat 2). The bound errs on the side of the attacker, deliberately.
 *
 * What this does NOT say (read before using the numbers)
 * ------------------------------------------------------
 * `quorumCapCorrection()` returns κ = π(N, q, ρ) / π(N, ⌈2N/3⌉, ρ) — how much
 * MORE likely a sub-supermajority quorum is to be captured than the shipped
 * default. The economic cap must NOT simply be divided by κ: the cap
 * (`docs/proofs/economics/05-review-gapfills.tex.md` (5.2)) charges the
 * attacker the bribe price with the prize unweighted, i.e. it is stated at
 * π = 1, the strictest member of the π-family. Under that reading a weaker
 * quorum *tightens* the true cap (higher π ⇒ smaller V_max), it does not loosen
 * it. The full argument, with both readings and the ρ at which the cap starts
 * to bind, is `docs/proofs/economics/06-expert-verify.tex.md` §3 (r30-3).
 * κ is exported because a host needs it for the two places the quorum really
 * bites: the OWNERSHIP route (05 §1's capture table) and the P+ε FREE-ATTACK
 * threshold (05 §3: the bribe's expected cost is max(0, 1−2π)X, i.e. zero once
 * the captured verdict survives with probability ≥ ½).
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Fail-closed on
 * malformed input (non-integer sizes, an out-of-range quorum, a malformed
 * share) — every throw is a caller bug, never a runtime state.
 */

/** An adversary's weight share as an exact rational, ρ = numerator / denominator. */
export interface AdversaryWeightShare {
  /** Non-negative integer; must not exceed `denominator`. */
  readonly numerator: number;
  /** Positive integer (the share's denominator). */
  readonly denominator: number;
}

/** The exact binomial upper tail, plus its double-precision evaluation. */
export interface CaptureProbability {
  /** Panel size N (seats). */
  readonly panelSize: number;
  /** Confirm threshold q: capture ⟺ at least q seats are adversary-held. */
  readonly quorum: number;
  /** Exact numerator over the common denominator ρ_den^N. */
  readonly numerator: bigint;
  /** Exact denominator (the share denominator raised to the panel size). */
  readonly denominator: bigint;
  /**
   * The same tail in double precision (≤ 15 significant digits, scaled so it is
   * representable even when the exact ratio is far below 1e-308).
   */
  readonly value: number;
}

/** Hard ceilings that keep the BigInt arithmetic bounded (seats / share grid). */
const MAX_PANEL_SIZE = 10_000;
const MAX_SHARE_DENOMINATOR = 1_000_000;

function assertPanelSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PANEL_SIZE) {
    throw new Error(`panelSize must be a safe integer in [1, ${MAX_PANEL_SIZE}] (got ${String(value)})`);
  }
  return value;
}

function assertQuorum(quorum: unknown, panelSize: number): number {
  if (typeof quorum !== 'number' || !Number.isSafeInteger(quorum) || quorum < 1 || quorum > panelSize) {
    throw new Error(`quorum must be a safe integer in [1, panelSize=${panelSize}] (got ${String(quorum)})`);
  }
  return quorum;
}

function assertShare(share: AdversaryWeightShare): { numerator: bigint; denominator: bigint } {
  const { numerator, denominator } = share ?? ({} as AdversaryWeightShare);
  if (!Number.isSafeInteger(denominator) || denominator < 1 || denominator > MAX_SHARE_DENOMINATOR) {
    throw new Error(
      `adversaryWeight.denominator must be a safe integer in [1, ${MAX_SHARE_DENOMINATOR}] (got ${String(denominator)})`,
    );
  }
  if (!Number.isSafeInteger(numerator) || numerator < 0 || numerator > denominator) {
    throw new Error(
      `adversaryWeight.numerator must be a safe integer in [0, ${denominator}] (got ${String(numerator)})`,
    );
  }
  return { numerator: BigInt(numerator), denominator: BigInt(denominator) };
}

/** C(n, k) as an exact integer (multiplicative form — no factorials). */
function binomial(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let value = 1n;
  for (let i = 0n; i < BigInt(k); i++) {
    value = (value * (BigInt(n) - i)) / (i + 1n);
  }
  return value;
}

/**
 * Convert an exact probability (0 ≤ num/den ≤ 1) to a double without losing the
 * exponent: both sides are scaled by a power of ten chosen from the ratio's own
 * decimal magnitude, so a 1e-400 probability still converts (to ~0 or a
 * denormal, never to NaN).
 */
function exactRatioToNumber(num: bigint, den: bigint): number {
  if (num === 0n) return 0;
  const magnitude = num.toString().length - den.toString().length; // ≈ floor(log10(ratio))
  const scaled = (num * 10n ** BigInt(30 - Math.min(0, magnitude))) / den;
  return Number(scaled) / 10 ** (30 - Math.min(0, magnitude));
}

/**
 * The probability that at least `quorum` of `panelSize` seats are held by an
 * adversary with weight share ρ (exact binomial upper tail, Model D).
 *
 * Throws on a non-integer panel/quorum, an out-of-range quorum, or a malformed
 * share — callers should treat a throw as a bug in their own arithmetic.
 *
 * Complexity: O(panelSize) BigInt multiplications; panelSize ≤ 10,000.
 *
 * @example
 * ```ts
 * // 3-of-5 at a one-third weight share: 51/243 ≈ 0.2099 (05 §1.3 Finding 1.1)
 * const p = captureProbability({
 *   panelSize: 5, quorum: 3, adversaryWeight: { numerator: 1, denominator: 3 },
 * });
 * // → numerator 51n, denominator 243n, value ≈ 0.209877
 * ```
 */
export function captureProbability(input: {
  readonly panelSize: number;
  readonly quorum: number;
  readonly adversaryWeight: AdversaryWeightShare;
}): CaptureProbability {
  const panelSize = assertPanelSize(input.panelSize);
  const quorum = assertQuorum(input.quorum, panelSize);
  const { numerator: p, denominator: q } = assertShare(input.adversaryWeight);
  const complement = q - p;
  let numerator = 0n;
  for (let k = quorum; k <= panelSize; k++) {
    numerator += binomial(panelSize, k) * p ** BigInt(k) * complement ** BigInt(panelSize - k);
  }
  return {
    panelSize,
    quorum,
    numerator,
    denominator: q ** BigInt(panelSize),
    value: exactRatioToNumber(numerator, q ** BigInt(panelSize)),
  };
}

/**
 * κ — how much more likely a panel is to be captured at quorum `q` than at the
 * shipped supermajority ⌈2N/3⌉, at the same adversary weight share.
 *
 * κ = 1 exactly when `quorum === ⌈2N/3⌉` (the R25 default), > 1 for every weaker
 * quorum, and < 1 for a stronger one. 3-of-5 at ρ = ⅓ gives the exact 51/11 =
 * 4.6364 (05 §1.3). Read the module header before applying it to a market cap:
 * the cap is the π = 1 slice and is NOT divided by κ (06 §3).
 *
 * @example
 * ```ts
 * quorumCapCorrection({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 1, denominator: 3 } });
 * // → 4.63636…  (51/243 ÷ 11/243)
 * ```
 */
export function quorumCapCorrection(input: {
  readonly panelSize: number;
  readonly quorum: number;
  readonly adversaryWeight: AdversaryWeightShare;
}): number {
  const panelSize = assertPanelSize(input.panelSize);
  const quorum = assertQuorum(input.quorum, panelSize);
  const supermajority = Math.ceil((2 * panelSize) / 3);
  const weak = captureProbability({ panelSize, quorum, adversaryWeight: input.adversaryWeight });
  const strong = captureProbability({ panelSize, quorum: supermajority, adversaryWeight: input.adversaryWeight });
  if (strong.value === 0) {
    throw new Error(
      `quorumCapCorrection: the ⌈2N/3⌉ quorum ${supermajority}/${panelSize} has zero capture probability at this share — κ is undefined`,
    );
  }
  // Both factors are probabilities in (0, 1], so their double evaluations are
  // well-scaled; dividing the evaluations keeps the exponent that a direct
  // BigInt→Number conversion of q^N would lose.
  return weak.value / strong.value;
}
