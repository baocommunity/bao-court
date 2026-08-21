// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Shared invariants for BAO Court ceremony machines (DKG, voting, signing).
 *
 * Each ceremony machine used to re-implement the same guards — timestamp
 * validation, roster membership, deadline enforcement, participant caps, and
 * blame validation — in parallel, so every protocol-hardening landed in three
 * files at once. This module concentrates that core so the invariants are
 * defined and tested once; each machine keeps its own public error class and
 * passes it in, so the exported surface (create/reduce/error/state types) is
 * unchanged.
 *
 * The helpers are ceremony-agnostic: they take the machine's error constructor
 * and the noun used in error messages ("participant", "voter", "signer").
 */

/** Error constructor accepted by the ceremony-core guards. */
export type CourtTransitionErrorCtor = new (message: string) => Error;

/** Canonical 32-byte lowercase-hex value (session hashes, salts, ids). */
export const HEX_32 = /^[0-9a-f]{64}$/;

/** Maximum roster size for any ceremony — bounds reducer resource use. */
export const MAX_CEREMONY_PARTICIPANTS = 10_000;

/**
 * Validate that `now` is a non-negative safe integer (a Unix timestamp).
 */
export function assertNow(now: number, ErrorCtor: CourtTransitionErrorCtor): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ErrorCtor('now must be a non-negative Unix timestamp');
  }
}

/**
 * Assert that `idx` is a member of the certified roster.
 *
 * @param noun singular noun for the roster member ("participant", "voter", "signer")
 */
export function assertRosterMember(
  roster: readonly number[],
  idx: number,
  noun: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  if (!roster.includes(idx)) {
    throw new ErrorCtor(`${noun} ${idx} is outside the certified roster`);
  }
}

/**
 * Assert that a message arrives strictly before the ceremony deadline.
 */
export function assertBeforeDeadline(
  now: number,
  deadline: number,
  message: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  assertNow(now, ErrorCtor);
  if (now >= deadline) {
    throw new ErrorCtor(message);
  }
}

/**
 * Validate that a deadline is a positive safe integer (a Unix timestamp).
 */
export function assertPositiveDeadline(
  deadline: number,
  field: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    throw new ErrorCtor(`${field} must be a positive Unix timestamp`);
  }
}

/**
 * Copy and validate the participant roster: non-empty, capped, and exactly
 * the sequential integers 1..n. Returns the validated copy.
 *
 * @param noun phrase naming the ceremony ("DKG", "voting", "signing")
 */
export function normalizeCeremonyRoster(
  participantIndices: readonly number[],
  noun: string,
  ErrorCtor: CourtTransitionErrorCtor,
): number[] {
  if (participantIndices.length === 0) {
    throw new ErrorCtor(`${noun} requires at least one participant`);
  }
  if (participantIndices.length > MAX_CEREMONY_PARTICIPANTS) {
    throw new ErrorCtor(
      'participantIndices length exceeds maximum of ' + MAX_CEREMONY_PARTICIPANTS,
    );
  }
  const participants = [...participantIndices];
  participants.forEach((idx, offset) => {
    if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
      throw new ErrorCtor('participant indices must be ordered and sequential');
    }
  });
  return participants;
}

/**
 * Validate an abort's blamedIdx: if supplied it must be a positive safe
 * integer naming a roster member, so a caller cannot forge a peer-blame
 * against an unverified index.
 */
export function assertBlamedIdx(
  blamedIdx: number | undefined,
  roster: readonly number[],
  noun: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  if (blamedIdx === undefined) return;
  if (!Number.isSafeInteger(blamedIdx) || blamedIdx < 1) {
    throw new ErrorCtor('blamedIdx must be a positive integer');
  }
  assertRosterMember(roster, blamedIdx, noun, ErrorCtor);
}
