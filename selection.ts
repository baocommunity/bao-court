// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Deterministic, verifiable jury selection for the BAO Court / FROST oracle.
 */

import { CourtArgumentError, CourtSelectionError } from './errors';
import { sha256 } from '@noble/hashes/sha2.js';
import type { JurorProfile, SelectedJuror } from './types';

export interface SelectionParams {
  readonly disputeEventId: string;
  readonly blockHash: string;
  readonly marketCategory: string;
  readonly marketVolumeSats: number;
  readonly jurySize?: number;
  readonly backupCount?: number;
  readonly minWotScore?: number;
  readonly minAccountAgeDays?: number;
  readonly minStakeSats?: number;
  /** Pubkeys that must be excluded from selection (e.g. previously failed selected sets). */
  readonly excludedPubkeys?: readonly string[];
  /**
   * Fixed reference time (unix seconds) for the account-age eligibility
   * check. Pass a stable value anchored to the dispute (e.g. the dispute
   * event's `created_at` or the seed block time) so that
   * {@link verifyJurySelection} stays reproducible over time. Defaults to
   * the current time.
   */
  readonly referenceTimeSec?: number;
  /**
   * Optional reputation-derived weight per juror, enabling zero-stake
   * phase-0 pools. When supplied it replaces the stake-derived weight for
   * every juror: expected selection probability becomes proportional to
   * `weight / Σweights` through the same exponential-clock draw, jurors
   * with weight <= 0 are ineligible, and the draw/verify pipeline is
   * otherwise identical to the stake path.
   *
   * The function MUST be a pure, deterministic function of the juror
   * record alone. {@link verifyJurySelection} recomputes it on whatever
   * params the verifier holds, so anything time-based, random, or read
   * from mutable external state makes the roster unverifiable.
   *
   * Reputation inputs must eventually be snapshot-pinned (e.g. committed
   * as a `reputationRoot` the disputing parties agree on when the dispute
   * opens) so every party weights the exact same snapshot. That
   * integration is future work; callers today must pin their inputs by
   * construction (pass the same frozen juror records).
   */
  readonly weightFn?: (juror: JurorProfile) => number;
  /**
   * Waive the `stakeCapacitySats >= 1% of marketVolumeSats` gate so
   * zero-stake phase-0 jurors can be seated. Only the volume gate is
   * waived: `minStakeSats`, WoT, age, category, and commitment checks all
   * still apply, so a zero-stake pool must also lower `minStakeSats`
   * explicitly. With no effect on the default stake-weighted path unless
   * the flag is set.
   */
  readonly zeroStakeAllowed?: boolean;
}

const DEFAULT_PARAMS = {
  jurySize: 5,
  backupCount: 2,
  minWotScore: 80,
  minAccountAgeDays: 7,
  minStakeSats: 10_000,
};

function validateHex(hex: string, expectedBytes: number): void {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== expectedBytes * 2) {
    throw new CourtArgumentError('SELECTION_ARGUMENT', `Invalid hex string, expected ${expectedBytes} bytes`);
  }
}

/**
 * Fully-resolved selection parameters (defaults applied). The optional
 * `weightFn` / `zeroStakeAllowed` flags stay optional after resolution —
 * there is no default weight function, only the default stake path.
 */
export interface ResolvedSelectionParams
  extends Omit<Required<SelectionParams>, 'weightFn' | 'zeroStakeAllowed'> {
  readonly weightFn?: (juror: JurorProfile) => number;
  readonly zeroStakeAllowed?: boolean;
}

function validateInputs(params: SelectionParams): ResolvedSelectionParams {
  validateHex(params.disputeEventId, 32);
  validateHex(params.blockHash, 32);
  return {
    jurySize: params.jurySize ?? DEFAULT_PARAMS.jurySize,
    backupCount: params.backupCount ?? DEFAULT_PARAMS.backupCount,
    minWotScore: params.minWotScore ?? DEFAULT_PARAMS.minWotScore,
    minAccountAgeDays: params.minAccountAgeDays ?? DEFAULT_PARAMS.minAccountAgeDays,
    minStakeSats: params.minStakeSats ?? DEFAULT_PARAMS.minStakeSats,
    disputeEventId: params.disputeEventId,
    blockHash: params.blockHash,
    marketCategory: params.marketCategory,
    marketVolumeSats: params.marketVolumeSats,
    excludedPubkeys: params.excludedPubkeys ?? [],
    referenceTimeSec: params.referenceTimeSec ?? Math.floor(Date.now() / 1000),
    weightFn: params.weightFn,
    zeroStakeAllowed: params.zeroStakeAllowed,
  };
}

function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new CourtArgumentError('SELECTION_ARGUMENT', 'Invalid hex string');
  }
  // Lookup-table decode — byte-identical to the previous regex + parseInt
  // loop for every input the regex accepted, and rejects (throws) on exactly
  // the same strings (odd length, any non-hex character). ~2.3× faster on
  // the selection hot path (one 64-hex pubkey per juror per draw).
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const hi = HEX_CHAR_VALUE[hex.charCodeAt(i * 2)]!;
    const lo = HEX_CHAR_VALUE[hex.charCodeAt(i * 2 + 1)]!;
    // 0xFF sentinel flags every non-hex byte, including non-ASCII code units.
    if (hi === 0xff || lo === 0xff) throw new CourtArgumentError('SELECTION_ARGUMENT', 'Invalid hex string');
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
}

const HEX_CHAR_VALUE = /* @__PURE__ */ (() => {
  const table = new Uint8Array(256).fill(0xff);
  for (let i = 0; i < 10; i += 1) table[48 + i] = i; // '0'..'9'
  for (let i = 0; i < 6; i += 1) {
    table[65 + i] = 10 + i; // 'A'..'F'
    table[97 + i] = 10 + i; // 'a'..'f'
  }
  return table;
})();

export function deriveSelectionSeed(
  disputeEventId: string,
  blockHash: string,
): Uint8Array {
  return sha256(
    new Uint8Array([
      ...bytesFromHex(disputeEventId),
      ...bytesFromHex(blockHash),
    ]),
  );
}

export function jurorRandomValue(seed: Uint8Array, pubkey: string): number {
  // Single pre-sized concat — byte-identical input to the previous
  // `[...seed, ...bytesFromHex(pubkey)]` spread, without the intermediate
  // array copies (the draw dominates selectJury at large rosters).
  const pubkeyBytes = bytesFromHex(pubkey);
  const input = new Uint8Array(seed.length + pubkeyBytes.length);
  input.set(seed, 0);
  input.set(pubkeyBytes, seed.length);
  const digest = sha256(input);
  // Read the first four bytes as an unsigned 32-bit integer.
  const u32 =
    digest[0]! * 2 ** 24 +
    digest[1]! * 2 ** 16 +
    digest[2]! * 2 ** 8 +
    digest[3]!;
  return u32 / 2 ** 32;
}

export function quadraticPriority(random: number, stakeSats: number): number {
  let r = random;
  if (r <= 0) r = Number.MIN_VALUE;
  if (r >= 1) r = 1 - Number.EPSILON;
  return -Math.log(r) / Math.sqrt(Math.max(1, stakeSats));
}

/**
 * Weighted generalization of {@link quadraticPriority}: the same
 * exponential-clock lottery, but with an explicit weight instead of
 * `sqrt(stake)`. With `r` uniform on (0, 1), `-ln(r)` is Exp(1)-distributed,
 * so `Exp(1) / weight` is an exponential clock of rate `weight` and the
 * minimum clock over the pool wins with probability
 * `weight / Σweights` — exactly how `quadraticPriority` already makes
 * P(win) ∝ `sqrt(stake)`. Fail-closed: a non-finite or non-positive weight
 * throws rather than silently skewing the draw.
 */
export function weightedPriority(random: number, weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new CourtArgumentError('SELECTION_ARGUMENT', `Invalid juror weight: ${weight} (must be finite and positive)`);
  }
  let r = random;
  if (r <= 0) r = Number.MIN_VALUE;
  if (r >= 1) r = 1 - Number.EPSILON;
  return -Math.log(r) / weight;
}

/**
 * Resolve a juror's selection weight, validating the caller-supplied
 * `weightFn` output fail-closed. A negative or non-finite weight is a
 * caller/reputation-feed bug, not a merely unlucky juror, so it hard-throws
 * at selection time; a weight of exactly 0 is a legitimate "not weighted
 * in" verdict handled as ineligibility by {@link filterEligibleJurors}.
 */
function jurorWeight(j: JurorProfile, weightFn: (juror: JurorProfile) => number): number {
  const w = weightFn(j);
  if (!Number.isFinite(w) || w < 0) {
    throw new CourtArgumentError('SELECTION_ARGUMENT', 
      `Invalid juror weight for ${j.nostrPubkey}: ${w} (weightFn must return finite non-negative numbers)`,
    );
  }
  return w;
}

export function filterEligibleJurors(
  pool: readonly JurorProfile[],
  params: ResolvedSelectionParams,
): JurorProfile[] {
  const nowSec = params.referenceTimeSec;
  const minAgeSec = params.minAccountAgeDays * 24 * 60 * 60;
  const excluded = new Set(params.excludedPubkeys);
  return pool.filter((j) => {
    if (j.wotScore < params.minWotScore) return false;
    if (j.stakeCapacitySats < params.minStakeSats) return false;
    // A future registration timestamp is self-attested and cannot be
    // trusted to prove age — fail-closed rather than treating it as
    // arbitrarily old (a negative age would pass the threshold below).
    if (j.registeredAt > nowSec) return false;
    if (nowSec - j.registeredAt < minAgeSec) return false;
    if (!j.categories.includes(params.marketCategory)) return false;
    // The 1%-of-market-volume gate keeps casual stake sizes out of
    // economically meaningful disputes; `zeroStakeAllowed` waives it for
    // phase-0 reputation-weighted pools. Every other gate (minStakeSats
    // included) still applies in that mode.
    if (!params.zeroStakeAllowed && j.stakeCapacitySats < params.marketVolumeSats * 0.01) {
      return false;
    }
    // If a stake commitment is present, it must be confirmed.
    if (j.stakeCommitment && j.stakeCommitment.status !== 'confirmed') return false;
    // Exclude pubkeys that were part of a previously failed selected set.
    if (excluded.has(j.nostrPubkey)) return false;
    // In weightFn mode, a weight of 0 opts the juror out entirely. Negative
    // or non-finite weights are a caller bug and hard-throw (fail-closed).
    if (params.weightFn && jurorWeight(j, params.weightFn) <= 0) return false;
    return true;
  });
}

export interface JuryWithBackups {
  readonly selected: SelectedJuror[];
  readonly backups: SelectedJuror[];
}

/**
 * Score every eligible juror (exponential-clock priority) and rank them.
 *
 * Performance shape (perf round 9): records stay LIGHT ({ juror ref,
 * priority }) through the O(n log n) rank — the previous version materialised
 * two full `{...juror}` copies per juror and assigned idx to every pool
 * member even though callers only ever consume the top `jurySize +
 * backupCount`. The comparator is byte-identical to the original (priority
 * ascending, exact ties by pubkey ascending), so the ranking — and therefore
 * the selection draw — is bit-identical; {@link jurorRandomValue}'s faster
 * hex decode produces the same u32 draws (differential-parity pinned).
 */
function scoreAndSort(
  pool: readonly JurorProfile[],
  seed: Uint8Array,
  params: ResolvedSelectionParams,
): Array<{ juror: JurorProfile; priority: number }> {
  return pool
    .map((j) => ({
      juror: j,
      priority: params.weightFn
      ? // Weight mode: exponential clock of rate `weightFn(j)`, so
        // P(wins a slot) ∝ weight / Σweights. Same seed → same clocks.
        weightedPriority(jurorRandomValue(seed, j.nostrPubkey), jurorWeight(j, params.weightFn))
      : // Default stake path, byte-identical to the legacy behaviour.
        quadraticPriority(jurorRandomValue(seed, j.nostrPubkey), j.stakeCapacitySats),
    }))
    .sort(
      (a, b) =>
        a.priority - b.priority
        // Exact-priority ties resolve by pubkey ascending, so the ordering is
        // independent of pool insertion order and reselections are fully
        // reproducible.
        || (a.juror.nostrPubkey < b.juror.nostrPubkey ? -1 : a.juror.nostrPubkey > b.juror.nostrPubkey ? 1 : 0),
    );
}

/** Materialise the top `limit` ranked records as 1-based-indexed SelectedJurors. */
function toSelectedJurors(
  ranked: Array<{ juror: JurorProfile; priority: number }>,
  limit: number,
): SelectedJuror[] {
  const selected: SelectedJuror[] = new Array(Math.min(limit, ranked.length));
  for (let i = 0; i < selected.length; i += 1) {
    const entry = ranked[i]!;
    selected[i] = { ...entry.juror, priority: entry.priority, idx: i + 1 };
  }
  return selected;
}

export function selectJury(
  pool: readonly JurorProfile[],
  params: SelectionParams,
): SelectedJuror[] {
  const p = validateInputs(params);
  const eligible = filterEligibleJurors(pool, p);
  if (eligible.length < p.jurySize) {
    throw new CourtSelectionError('SELECTION_STATE', `Insufficient eligible jurors: ${eligible.length} < ${p.jurySize}`, { invariant: 'INV-SEL-6' });
  }
  const seed = deriveSelectionSeed(p.disputeEventId, p.blockHash);
  return toSelectedJurors(scoreAndSort(eligible, seed, p), p.jurySize);
}

export function selectJuryWithBackups(
  pool: readonly JurorProfile[],
  params: SelectionParams,
): JuryWithBackups {
  const p = validateInputs(params);
  const eligible = filterEligibleJurors(pool, p);
  if (eligible.length < p.jurySize) {
    throw new CourtSelectionError('SELECTION_STATE', `Insufficient eligible jurors: ${eligible.length} < ${p.jurySize}`, { invariant: 'INV-SEL-6' });
  }

  const seed = deriveSelectionSeed(p.disputeEventId, p.blockHash);
  const totalNeeded = p.jurySize + p.backupCount;
  const scored = toSelectedJurors(scoreAndSort(eligible, seed, p), totalNeeded);

  return {
    selected: scored.slice(0, p.jurySize),
    backups: scored.slice(p.jurySize),
  };
}

/**
 * Recompute the draw and compare it against a claimed roster. Works
 * identically in both modes: it re-runs {@link selectJury} with the SAME
 * params object the selector used, so when a `weightFn` was supplied the
 * verifier must pass the identical function (pure and deterministic — see
 * the {@link SelectionParams.weightFn} docstring) plus the same
 * `zeroStakeAllowed` flag, or verification fails. Any error during the
 * recompute (e.g. an invalid weight) returns `false` — fail-closed.
 */
export function verifyJurySelection(
  pool: readonly JurorProfile[],
  selected: readonly SelectedJuror[],
  params: SelectionParams,
): boolean {
  try {
    const expected = selectJury(pool, params);
    if (expected.length !== selected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].nostrPubkey !== selected[i].nostrPubkey) return false;
      if (expected[i].idx !== selected[i].idx) return false;
      if (Math.abs(expected[i].priority - selected[i].priority) > 1e-12) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
