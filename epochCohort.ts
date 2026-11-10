// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { CourtError, CourtErrorOptions } from './errors';
import { HEX_32 } from './courtCeremonyCore';
import { CanonicalWriter } from './courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Epoch-cohort session parameters for standing FROST cohorts (universal
 * confirmation redesign).
 *
 * A standing cohort runs DKG once per epoch and reuses the group key across
 * many confirmations. The cohort record is the publicly verifiable anchor:
 * it binds the epoch id, cohort index, group pubkey, threshold, roster size,
 * validity window, and crypto suite into one canonical hash that session
 * parameters, attestations, and handoff events can reference.
 *
 * Rotation rules encoded here (the rest is host policy):
 * - epochs are sequential (`epochId` increments by one);
 * - a rotation to the SAME group key is rejected — rotation that does not
 *   change the key is a no-op, not an epoch;
 * - the new cohort's window must start strictly after the old cohort's
 *   window started (time moves forward);
 * - `hashCourtEpochHandoff` binds old cohort → new cohort so validators can
 *   resolve any historical epoch's key from a signed handoff chain.
 *
 * This module is pure: no storage, no transport, no clock.
 */

export const COURT_EPOCH_COHORT_DOMAIN = 'BAO-Court/EpochCohort/v1';
export const COURT_EPOCH_HANDOFF_DOMAIN = 'BAO-Court/EpochHandoff/v1';

export interface CourtEpochCohort {
  readonly epochId: number;
  readonly cohortIndex: number;
  /** 32-byte lowercase hex x-only group public key of the cohort. */
  readonly cohortPubkey: string;
  /** FROST signing threshold within the cohort. */
  readonly threshold: number;
  /** Roster size the DKG was run over. */
  readonly participantCount: number;
  /** Epoch validity window, in epoch seconds. */
  readonly startsAtSec: number;
  readonly endsAtSec: number;
  /** Crypto-suite id (e.g. `pedpop-v1-experimental`). */
  readonly suite: string;
}

export class CourtEpochCohortError extends CourtError {
  constructor(message: string, options?: CourtErrorOptions) {
    super('EPOCH_COHORT', message, options);
  }
}

const MAX_SUITE_BYTES = 128;

function assertSafeUint32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CourtEpochCohortError(`${label} must be a safe integer in [0, 4294967295]`);
  }
}

function assertSafeUint64(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CourtEpochCohortError(`${label} must be a safe non-negative integer`);
  }
}

function assertHex32(value: string, label: string): void {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtEpochCohortError(`${label} must be 32-byte lowercase hex`);
  }
}

/**
 * Validate and freeze one epoch-cohort record. Duplicate cohort keys within
 * one epoch are rejected by the caller's registry, not here — this function
 * only enforces the record's internal consistency.
 */
export function createCourtEpochCohort(params: {
  readonly epochId: number;
  readonly cohortIndex: number;
  readonly cohortPubkey: string;
  readonly threshold: number;
  readonly participantCount: number;
  readonly startsAtSec: number;
  readonly endsAtSec: number;
  readonly suite: string;
}): CourtEpochCohort {
  assertSafeUint32(params.epochId, 'epochId');
  assertSafeUint32(params.cohortIndex, 'cohortIndex');
  assertHex32(params.cohortPubkey, 'cohortPubkey');
  assertSafeUint32(params.threshold, 'threshold');
  if (params.threshold < 1) {
    throw new CourtEpochCohortError('threshold must be at least 1');
  }
  assertSafeUint32(params.participantCount, 'participantCount');
  if (
    params.participantCount < 1
    || params.participantCount > 300
  ) {
    // Standing cohorts are capped at 300 (201 recommended): unanimous-roster
    // DKG livelocks beyond that. The cap is protocol policy, not math.
    throw new CourtEpochCohortError('participantCount must be in [1, 300] (unanimous-DKG cap)');
  }
  if (params.threshold > params.participantCount) {
    throw new CourtEpochCohortError('threshold must not exceed participantCount');
  }
  assertSafeUint64(params.startsAtSec, 'startsAtSec');
  assertSafeUint64(params.endsAtSec, 'endsAtSec');
  if (params.endsAtSec <= params.startsAtSec) {
    throw new CourtEpochCohortError('endsAtSec must be later than startsAtSec');
  }
  if (
    typeof params.suite !== 'string'
    || params.suite.length === 0
    || new TextEncoder().encode(params.suite).length > MAX_SUITE_BYTES
  ) {
    throw new CourtEpochCohortError('suite must be a non-empty bounded string');
  }
  return Object.freeze({ ...params });
}

/** Canonical cohort hash — the anchor session parameters and attestations cite. */
export function hashCourtEpochCohort(cohort: CourtEpochCohort): string {
  const writer = new CanonicalWriter();
  writer.u8(1);
  writer.u32(cohort.epochId);
  writer.u32(cohort.cohortIndex);
  writer.hex(cohort.cohortPubkey);
  writer.u32(cohort.threshold);
  writer.u32(cohort.participantCount);
  writer.u64(cohort.startsAtSec);
  writer.u64(cohort.endsAtSec);
  writer.text(cohort.suite);
  const prefix = new TextEncoder().encode(COURT_EPOCH_COHORT_DOMAIN);
  const encoded = writer.finish();
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/**
 * Canonical handoff hash binding the previous cohort to the next. The old
 * cohort signs this (threshold signature) when rotating; validators walking
 * a handoff chain can resolve any historical epoch's group key without
 * trusting the coordinator.
 */
export function hashCourtEpochHandoff(params: {
  readonly previousCohortHash: string;
  readonly nextCohortHash: string;
  readonly activatedAtSec: number;
}): string {
  assertHex32(params.previousCohortHash, 'previousCohortHash');
  assertHex32(params.nextCohortHash, 'nextCohortHash');
  assertSafeUint64(params.activatedAtSec, 'activatedAtSec');
  const writer = new CanonicalWriter();
  writer.u8(1);
  writer.hex(params.previousCohortHash);
  writer.hex(params.nextCohortHash);
  writer.u64(params.activatedAtSec);
  const prefix = new TextEncoder().encode(COURT_EPOCH_HANDOFF_DOMAIN);
  const encoded = writer.finish();
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/**
 * Rotation ordering rules. Throws (fail-closed) when the proposed next
 * cohort violates them; returns the previous cohort's hash otherwise, ready
 * to be bound into a handoff.
 */
export function assertEpochRotationOrdering(
  previous: CourtEpochCohort,
  next: CourtEpochCohort,
): string {
  if (next.epochId !== previous.epochId + 1) {
    throw new CourtEpochCohortError('epoch ids must increment by exactly one per rotation');
  }
  if (next.cohortPubkey === previous.cohortPubkey) {
    throw new CourtEpochCohortError(
      'rotation must change the group key — same-key rotation is a no-op, never an epoch',
    );
  }
  if (next.startsAtSec <= previous.startsAtSec) {
    throw new CourtEpochCohortError('cohort windows must move forward in time');
  }
  return hashCourtEpochCohort(previous);
}
