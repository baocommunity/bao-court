// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Deterministic, verifiable jury selection for the BAO Court / FROST oracle.
 */

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
    throw new Error(`Invalid hex string, expected ${expectedBytes} bytes`);
  }
}

function validateInputs(params: SelectionParams): Required<SelectionParams> {
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
  };
}

function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

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
  const digest = sha256(
    new Uint8Array([...seed, ...bytesFromHex(pubkey)]),
  );
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

export function filterEligibleJurors(
  pool: readonly JurorProfile[],
  params: Required<SelectionParams>,
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
    if (j.stakeCapacitySats < params.marketVolumeSats * 0.01) return false;
    // If a stake commitment is present, it must be confirmed.
    if (j.stakeCommitment && j.stakeCommitment.status !== 'confirmed') return false;
    // Exclude pubkeys that were part of a previously failed selected set.
    if (excluded.has(j.nostrPubkey)) return false;
    return true;
  });
}

export interface JuryWithBackups {
  readonly selected: SelectedJuror[];
  readonly backups: SelectedJuror[];
}

function scoreAndSort(
  pool: readonly JurorProfile[],
  seed: Uint8Array,
): Array<SelectedJuror & { priority: number }> {
  return pool
    .map((j) => ({
      ...j,
      priority: quadraticPriority(jurorRandomValue(seed, j.nostrPubkey), j.stakeCapacitySats),
      idx: 0,
    }))
    .sort(
      (a, b) =>
        a.priority - b.priority
        // Exact-priority ties resolve by pubkey ascending, so the ordering is
        // independent of pool insertion order and reselections are fully
        // reproducible.
        || (a.nostrPubkey < b.nostrPubkey ? -1 : a.nostrPubkey > b.nostrPubkey ? 1 : 0),
    )
    .map((j, i) => ({ ...j, idx: i + 1 }));
}

export function selectJury(
  pool: readonly JurorProfile[],
  params: SelectionParams,
): SelectedJuror[] {
  const p = validateInputs(params);
  const eligible = filterEligibleJurors(pool, p);
  if (eligible.length < p.jurySize) {
    throw new Error(`Insufficient eligible jurors: ${eligible.length} < ${p.jurySize}`);
  }
  const seed = deriveSelectionSeed(p.disputeEventId, p.blockHash);
  return scoreAndSort(eligible, seed).slice(0, p.jurySize);
}

export function selectJuryWithBackups(
  pool: readonly JurorProfile[],
  params: SelectionParams,
): JuryWithBackups {
  const p = validateInputs(params);
  const eligible = filterEligibleJurors(pool, p);
  if (eligible.length < p.jurySize) {
    throw new Error(`Insufficient eligible jurors: ${eligible.length} < ${p.jurySize}`);
  }

  const seed = deriveSelectionSeed(p.disputeEventId, p.blockHash);
  const totalNeeded = p.jurySize + p.backupCount;
  const scored = scoreAndSort(eligible, seed).slice(0, totalNeeded);

  return {
    selected: scored.slice(0, p.jurySize),
    backups: scored.slice(p.jurySize),
  };
}

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
