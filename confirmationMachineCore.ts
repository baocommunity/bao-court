// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

// Guards, ledger barriers, and the canonical confirmation hash for the
// universal-confirmation machine (extracted from `courtConfirmationMachine.ts`
// — see that file for the module contract). Every guard fails closed with
// {@link CourtConfirmationTransitionError}; every hash input goes through
// `CanonicalWriter`.

import {
  HEX_32,
  MAX_CEREMONY_PARTICIPANTS,
  assertBeforeDeadline as assertBeforeDeadlineCore,
  assertRosterMember,
  isCanonicalUtf8Text,
  normalizeCeremonyRoster,
} from './courtCeremonyCore';
import { CanonicalWriter } from './courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  COURT_CONFIRMATION_DOMAIN,
  CourtConfirmationPhase,
  CourtConfirmationMachineState,
  CourtRoundOutcomeRecord,
  CourtConfirmationTransitionError,
} from './confirmationMachineTypes';

export const textEncoder = new TextEncoder();
export const MAX_OUTCOME_BYTES = 256;
export const MAX_CONFIRMATIONS = 10_000;
export const MAX_CHALLENGES = 10_000;
export const MAX_MASS_VOTES = 10_000;
export const MAX_CLAWBACK_FLAGS = 10_000;
export const MAX_FEES = 256;
export const MAX_EVIDENCE_IDS = 256;
export const MAX_REASON_BYTES = 64;
/** Ladder bounds: rounds are capped 1..5 (default 2); a round panel has ≥ 3 seats. */
export const MAX_LADDER_ROUNDS = 5;
export const DEFAULT_LADDER_ROUNDS = 2;
export const MIN_ROUND_ROSTER = 3;

/**
 * The supermajority confirm quorum for an N-seat roster: ⌈2N/3⌉.
 *
 * This is the threshold the threat model names (PO-1) and the one the capture
 * table in `docs/proofs/economics/05-review-gapfills.tex.md` §1 assumes:
 * 4-of-5, 10-of-15, 30-of-45, 90-of-135. R25 makes it the FACTORY DEFAULT
 * (it used to be 1) and keeps it exported so hosts can compare their own
 * policy against it (`state.quorumBelowSupermajority` is derived from it).
 */
export function confirmSupermajority(rosterSize: number): number {
  return Math.ceil((2 * rosterSize) / 3);
}

export const TERMINAL_PHASES = new Set<CourtConfirmationPhase>(['final', 'expired', 'aborted']);

/** Phases a clock tick may expire, with the deadline that governs each. */
export const TICK_DEADLINES: Partial<Record<CourtConfirmationPhase, (s: CourtConfirmationMachineState) => number>> = {
  confirm_open: (s) => s.confirmDeadline,
  confirm_closed: (s) => s.challengeDeadline,
  challenge_window: (s) => s.challengeDeadline,
  ladder_vote_open: (s) => s.ladder?.voteDeadline ?? Number.MAX_SAFE_INTEGER,
};

/**
 * Canonical session- and proposal-bound confirmation hash. A juror's public
 * endorsement is the hash of the session, the exact proposal, and the juror's
 * roster index — replay-proof across sessions and proposals, and re-derivable
 * by any observer from public inputs.
 */
export function hashCourtConfirmation(params: {
  readonly sessionHash: string;
  readonly proposalHash: string;
  readonly idx: number;
}): string {
  if (typeof params.sessionHash !== 'string' || !HEX_32.test(params.sessionHash)) {
    throw new CourtConfirmationTransitionError('sessionHash must be 32-byte lowercase hex');
  }
  if (typeof params.proposalHash !== 'string' || !HEX_32.test(params.proposalHash)) {
    throw new CourtConfirmationTransitionError('proposalHash must be 32-byte lowercase hex');
  }
  if (!Number.isSafeInteger(params.idx) || params.idx < 1) {
    throw new CourtConfirmationTransitionError('idx must be a positive safe integer');
  }
  const writer = new CanonicalWriter();
  writer.hex(params.sessionHash);
  writer.hex(params.proposalHash);
  writer.u32(params.idx);
  const prefix = textEncoder.encode(COURT_CONFIRMATION_DOMAIN);
  const input = new Uint8Array(prefix.length + writer.finish().length);
  input.set(prefix, 0);
  input.set(writer.finish(), prefix.length);
  return bytesToHex(sha256(input));
}

export function assertParticipant(state: CourtConfirmationMachineState, idx: number): void {
  assertRosterMember(state.participantIndices, idx, 'confirmation participant', CourtConfirmationTransitionError);
}

/**
 * Effective panel for the current ladder round: the round's explicit roster
 * when the host opened one, else the case roster. Mass votes are validated
 * against the ROUND panel (round rosters may grow or change between rounds).
 */
function roundRosterOf(state: CourtConfirmationMachineState): readonly number[] {
  return state.ladder?.roundRoster ?? state.participantIndices;
}

export function assertRoundParticipant(state: CourtConfirmationMachineState, idx: number): void {
  assertRosterMember(roundRosterOf(state), idx, 'mass vote participant', CourtConfirmationTransitionError);
}

/**
 * Validate an `open_ladder_round` roster expansion: sequential indices 1..N
 * within the ceremony-participant bound, with at least MIN_ROUND_ROSTER
 * seats. Superset-of-previous-round is deliberately NOT required — per the
 * universal-confirmation proposal §4.2 the host may reconstitute each
 * round's panel (FROST-subset selection is host policy).
 */
export function normalizeRoundRoster(roundRoster: readonly number[]): readonly number[] {
  const roster = normalizeCeremonyRoster(roundRoster, 'round roster', CourtConfirmationTransitionError);
  if (roster.length < MIN_ROUND_ROSTER) {
    throw new CourtConfirmationTransitionError(
      `round roster must contain at least ${MIN_ROUND_ROSTER} participants`,
    );
  }
  if (roster.length > MAX_CEREMONY_PARTICIPANTS) {
    throw new CourtConfirmationTransitionError(
      `round roster length exceeds maximum of ${MAX_CEREMONY_PARTICIPANTS}`,
    );
  }
  return roster;
}

export function assertBeforeDeadline(now: number, deadline: number, message: string): void {
  assertBeforeDeadlineCore(now, deadline, message, CourtConfirmationTransitionError);
}

export function assertBoundedOutcome(outcome: string, message: string): void {
  if (
    typeof outcome !== 'string'
    || outcome.length === 0
    || textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
    || !isCanonicalUtf8Text(outcome)
  ) {
    throw new CourtConfirmationTransitionError(message);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(textEncoder.encode(outcome));
  } catch {
    throw new CourtConfirmationTransitionError(message);
  }
}

export function assertHex32(value: string, message: string): void {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtConfirmationTransitionError(message);
  }
}

/**
 * Freeze the state graph so no holder of a returned reference can mutate
 * frozen configuration, ledgers, or verdicts between transitions (mirrors
 * the vote machine's freeze discipline).
 */
export function freezeState(state: CourtConfirmationMachineState): CourtConfirmationMachineState {
  for (const record of state.confirmations) Object.freeze(record);
  for (const record of state.challenges) Object.freeze(record);
  if (state.ladder) {
    for (const vote of state.ladder.votes) Object.freeze(vote);
    Object.freeze(state.ladder.votes);
    Object.freeze(state.ladder.roundRoster);
    Object.freeze(state.ladder);
  }
  for (const flag of state.clawbackFlags) Object.freeze(flag);
  if (state.outcomeHistory) {
    for (const record of state.outcomeHistory) {
      Object.freeze(record.winnerEventIds);
      Object.freeze(record.winnerIndices);
      Object.freeze(record);
    }
    Object.freeze(state.outcomeHistory);
  }
  Object.freeze(state.confirmations);
  Object.freeze(state.challenges);
  Object.freeze(state.clawbackFlags);
  Object.freeze(state.fees);
  Object.freeze(state.participantIndices);
  Object.freeze(state.allowedOutcomes);
  Object.freeze(state.evidenceIds);
  if (state.verdict) {
    Object.freeze(state.verdict.supportingEventIds);
    Object.freeze(state.verdict);
  }
  if (state.failure) Object.freeze(state.failure);
  return Object.freeze(state);
}

/**
 * Restore-time barrier for the append-only outcome history (finding F-3):
 * every persisted round record must re-verify before it locks value in —
  the history is a consecutive 1..k round sequence (append-only, one record
  per resolved round, never reordered or gapped), each outcome is a member of
  the frozen ballot, winner event ids are unique well-formed hex, and winner
  indices are unique valid ceremony participant indices. Used at
  `resolve_round` (a hand-restored history would otherwise direct
  `round_flip` clawbacks at arbitrary indices via `previous.winnerIndices`)
  and at `finalize`, the two points where the history feeds the machine's
  outputs.
 */
export function assertValidOutcomeHistory(state: CourtConfirmationMachineState): void {
  const history = state.outcomeHistory;
  if (!Array.isArray(history)) {
    throw new CourtConfirmationTransitionError('outcome history must be an array');
  }
  // Cross-check: history records are produced only by resolve_round, which is
  // reachable only through the challenge path — a never-challenged case with
  // a non-empty history is a forged snapshot.
  if (history.length > 0 && (!Array.isArray(state.challenges) || state.challenges.length === 0)) {
    throw new CourtConfirmationTransitionError(
      'outcome history records exist but the case was never challenged',
    );
  }
  for (let offset = 0; offset < history.length; offset += 1) {
    const record: unknown = history[offset];
    if (typeof record !== 'object' || record === null) {
      throw new CourtConfirmationTransitionError('outcome history contains a malformed record');
    }
    const { round, outcome, winnerEventIds, winnerIndices } = record as CourtRoundOutcomeRecord;
    // Append-only + consecutive: the record at offset i must be round i+1 —
    // a restored snapshot with a gap, reorder, or forged round number is
    // rejected here instead of steering clawbacks.
    if (!Number.isSafeInteger(round) || round !== offset + 1) {
      throw new CourtConfirmationTransitionError(
        'outcome history rounds must be a consecutive 1..k sequence',
      );
    }
    if (typeof outcome !== 'string' || !state.allowedOutcomes.includes(outcome)) {
      throw new CourtConfirmationTransitionError(
        'outcome history names an outcome outside the frozen allowlist',
      );
    }
    if (!Array.isArray(winnerEventIds) || winnerEventIds.length === 0) {
      throw new CourtConfirmationTransitionError(
        'outcome history record has no winning event ids',
      );
    }
    const seenEventIds = new Set<string>();
    for (const eventId of winnerEventIds) {
      assertHex32(eventId, 'outcome history winner event ids must be 32-byte lowercase hex');
      if (seenEventIds.has(eventId)) {
        throw new CourtConfirmationTransitionError('outcome history winner event ids must be unique');
      }
      seenEventIds.add(eventId);
    }
    if (!Array.isArray(winnerIndices) || winnerIndices.length === 0) {
      throw new CourtConfirmationTransitionError(
        'outcome history record has no winner indices',
      );
    }
    const seenIndices = new Set<number>();
    for (const idx of winnerIndices) {
      if (
        typeof idx !== 'number'
        || !Number.isSafeInteger(idx)
        || idx < 1
        || idx > MAX_CEREMONY_PARTICIPANTS
      ) {
        throw new CourtConfirmationTransitionError(
          'outcome history winner indices must be valid ceremony participant indices',
        );
      }
      if (seenIndices.has(idx)) {
        throw new CourtConfirmationTransitionError('outcome history winner indices must be unique');
      }
      seenIndices.add(idx);
    }
  }
}

/**
 * Ledger barrier: every mass vote must identify a roster participant, name an
 * allowed outcome, carry well-formed ids, and be unique per index and event
 * id. Used before close_ladder_round and resolve_round so a tampered (or
 * hand-restored) ledger is caught before the outcome is locked in.
 */
export function assertValidMassVoteLedger(state: CourtConfirmationMachineState): void {
  const ladder = state.ladder;  if (!ladder || !Array.isArray(ladder.votes)) {
    throw new CourtConfirmationTransitionError('ladder state is missing or malformed');
  }
  // A hand-restored round roster must re-verify (sequential 1..N, N ≥ 3)
  // before any of its votes lock an outcome in.
  if (ladder.roundRoster !== undefined) normalizeRoundRoster(ladder.roundRoster);
  const seenIndices = new Set<number>();
  const seenEventIds = new Set<string>();
  for (const vote of ladder.votes) {
    if (typeof vote !== 'object' || vote === null) {
      throw new CourtConfirmationTransitionError('ladder state contains a malformed vote record');
    }
    assertRoundParticipant(state, vote.idx);
    if (typeof vote.outcome !== 'string' || !state.allowedOutcomes.includes(vote.outcome)) {
      throw new CourtConfirmationTransitionError(
        'mass vote names an outcome outside the frozen allowlist',
      );
    }
    assertHex32(vote.eventId, 'mass vote event id must be 32-byte lowercase hex');
    if (seenIndices.has(vote.idx)) {
      throw new CourtConfirmationTransitionError(
        `participant ${vote.idx} has duplicate mass votes in round ${ladder.round}`,
      );
    }
    if (seenEventIds.has(vote.eventId)) {
      throw new CourtConfirmationTransitionError('mass vote event ids must be unique');
    }
    seenIndices.add(vote.idx);
    seenEventIds.add(vote.eventId);
  }
}

/**
 * Ledger barrier for the confirmation and challenge ledgers (the mass-vote
 * barrier's counterpart): every persisted record must re-verify against the
 * machine's own canonical bindings, so a restored or hand-tampered snapshot
 * cannot feed `finalize`/`resolve_round` from records that were never
 * accepted through `accept_confirmation`/`accept_challenge`. Recomputes each
 * confirmation's canonical hash (sessionHash + proposalHash + idx) and
 * re-checks roster membership, hex well-formedness, per-index uniqueness,
 * and event-id uniqueness for both ledgers. Called at the two points where
 * these ledgers lock value in: `resolve_round` (clawback flags from the
 * confirmation ledger) and `finalize` (verdict supporting event ids).
 */
export function assertValidConfirmationLedger(state: CourtConfirmationMachineState): void {
  const seenConfirmIndices = new Set<number>();
  const seenConfirmEventIds = new Set<string>();
  for (const record of state.confirmations) {
    if (typeof record !== 'object' || record === null) {
      throw new CourtConfirmationTransitionError('confirmation ledger contains a malformed record');
    }
    assertParticipant(state, record.idx);
    if (
      typeof record.confirmHash !== 'string'
      || typeof record.eventId !== 'string'
      || !HEX_32.test(record.eventId)
    ) {
      throw new CourtConfirmationTransitionError('confirmation ledger contains a malformed record');
    }
    // Re-derive the canonical confirmation hash: a hand-restored record
    // whose confirmHash was never accepted (or whose idx was reassigned)
    // is caught here instead of feeding the verdict's supporting set.
    const expected = hashCourtConfirmation({
      sessionHash: state.sessionHash,
      proposalHash: state.proposalHash,
      idx: record.idx,
    });
    if (record.confirmHash !== expected) {
      throw new CourtConfirmationTransitionError(
        `confirmation record for participant ${record.idx} does not match the canonical confirmation hash`,
      );
    }
    if (seenConfirmIndices.has(record.idx)) {
      throw new CourtConfirmationTransitionError(
        `participant ${record.idx} has duplicate confirmation records`,
      );
    }
    if (seenConfirmEventIds.has(record.eventId)) {
      throw new CourtConfirmationTransitionError('confirmation event ids must be unique');
    }
    seenConfirmIndices.add(record.idx);
    seenConfirmEventIds.add(record.eventId);
  }
  const seenChallengeIndices = new Set<number>();
  const seenChallengeEventIds = new Set<string>();
  for (const record of state.challenges) {
    if (typeof record !== 'object' || record === null) {
      throw new CourtConfirmationTransitionError('challenge ledger contains a malformed record');
    }
    assertParticipant(state, record.idx);
    assertHex32(record.bondTxid, 'challenge bond txid must be 32-byte lowercase hex');
    assertHex32(record.bondProofHash, 'challenge bond proof hash must be 32-byte lowercase hex');
    assertHex32(record.eventId, 'challenge event id must be 32-byte lowercase hex');
    if (seenChallengeIndices.has(record.idx)) {
      throw new CourtConfirmationTransitionError(
        `participant ${record.idx} has duplicate challenge records`,
      );
    }
    if (seenChallengeEventIds.has(record.eventId)) {
      throw new CourtConfirmationTransitionError('challenge event ids must be unique');
    }
    seenChallengeIndices.add(record.idx);
    seenChallengeEventIds.add(record.eventId);
  }
}
