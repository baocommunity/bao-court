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
  CourtEscalationRecord,
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
  if (state.escalationLog) {
    for (const record of state.escalationLog) Object.freeze(record);
    Object.freeze(state.escalationLog);
  }
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
 * Restore-time barrier for the append-only escalation witness log
 * (round-3 finding r29-2, INV-ESC-8).
 *
 * The log is an audit artifact that hosts read to attribute misconduct (who
 * escalated, against which request and bond) and to price fees. Until v0.12.1
 * nothing re-verified it: a hand-restored `fee_settlement` snapshot could
 * APPEND a fabricated record — naming a juror who never escalated, a round
 * that was never opened, or a bond that juror never posted — and finalize
 * minted a canonical verdict on top of it. The verdict hash deliberately does
 * not cover the log (it must not: the log is not an adjudicating input), so
 * the barrier is what keeps the audit trail honest.
 *
 * Rules, each mirroring something the live path guarantees:
 *  - rounds are a consecutive `2..k` sequence (one record per escalation, the
 *    first opens round 2) and never name a round the case did not open;
 *  - timestamps are finite and non-decreasing (the reducer's clock ledger);
 *  - a `challenger` record names a roster participant whose OWN accepted
 *    challenge bond is the recorded hash (r29-1), and carries a per-round bond
 *    witness that is neither that membership bond nor one an earlier round
 *    already consumed — mandatory when the case sets `requireRoundBond` (R31);
 *  - a `host` record requires the frozen `hostEscalation` policy and carries
 *    no challenger witness.
 *
 * A SHORT log is accepted on purpose **only for a case that never opted into
 * the per-round bond** (R33, r33-5): a pre-0.12 snapshot legitimately has no
 * entries, and refusing those would make legacy snapshots un-finalizable
 * (round-3 target 1.5). That exemption is exactly the free option once a round
 * bond exists, because deleting a record also un-consumes its bond hash — the
 * hash becomes reusable for a later rung. So the barrier demands a COMPLETE
 * ledger whenever it can tell what complete means:
 *
 *  - `log.length > 0` — the case records escalations, so it must have one
 *    record per opened round (`ladderRound − 1`, or `ladderRound` while a
 *    round is pending). Deleting ANY entry, including the last, is refused;
 *  - `requireRoundBond === true` — the strict policy is never allowed to fall
 *    back to the legacy shape, so a log emptied of every entry is refused too.
 *
 * A legacy case (`requireRoundBond` absent/false) with no records keeps the
 * documented deletion residual: it is indistinguishable from a pre-0.12 state,
 * which is why the strict policy is the one a new deployment must choose.
 */
export function assertValidEscalationLog(state: CourtConfirmationMachineState): void {
  const log = state.escalationLog;
  if (!Array.isArray(log)) {
    throw new CourtConfirmationTransitionError('escalation log must be an array');
  }
  if (log.length > MAX_LADDER_ROUNDS) {
    throw new CourtConfirmationTransitionError(
      `escalation log exceeds the ${MAX_LADDER_ROUNDS}-round ladder bound`,
    );
  }
  // Completeness (R33, r33-5): one record per escalation, and an escalation
  // opens exactly one round. `ladder_pending` is the one phase between the two
  // halves of that move (escalate appends, open_ladder_round advances
  // `ladderRound`), so the offset differs there by one.
  const expectedRecords = Math.max(
    0,
    state.phase === 'ladder_pending' ? state.ladderRound : state.ladderRound - 1,
  );
  if (log.length !== expectedRecords && (log.length > 0 || state.requireRoundBond === true)) {
    throw new CourtConfirmationTransitionError(
      `escalation log is incomplete: ${log.length} record(s) for ${state.ladderRound} opened round(s) `
      + `(expected ${expectedRecords}) — a restored snapshot must not drop an escalation, because a `
      + 'dropped record also un-consumes the per-round bond it paid with',
    );
  }
  let previousAt = Number.NEGATIVE_INFINITY;
  const seenRoundBonds = new Set<string>();
  for (let offset = 0; offset < log.length; offset += 1) {
    const record: unknown = log[offset];
    if (typeof record !== 'object' || record === null) {
      throw new CourtConfirmationTransitionError('escalation log contains a malformed record');
    }
    const { round, authority, challengerIdx, challengerPubkey, requestHash, bondProofHash, at } =
      record as CourtEscalationRecord;
    // Legacy records (v0.12) predate the per-round witness; an ABSENT field is
    // read as `null` (membership semantics), exactly as the reducer does.
    const roundBondProofHash: string | null =
      (record as { readonly roundBondProofHash?: string | null }).roundBondProofHash ?? null;
    if (!Number.isSafeInteger(round) || round !== offset + 2) {
      throw new CourtConfirmationTransitionError(
        'escalation log rounds must be a consecutive 2..k sequence',
      );
    }
    if (round > state.ladderRound) {
      throw new CourtConfirmationTransitionError(
        'escalation log records a round the case never opened',
      );
    }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < previousAt) {
      throw new CourtConfirmationTransitionError(
        'escalation log timestamps must be finite and non-decreasing',
      );
    }
    previousAt = at;
    if (authority === 'challenger') {
      if (
        typeof challengerIdx !== 'number'
        || !Number.isSafeInteger(challengerIdx)
        || !state.participantIndices.includes(challengerIdx)
      ) {
        throw new CourtConfirmationTransitionError(
          'escalation log challenger is not a case-roster participant',
        );
      }
      assertHex32(challengerPubkey as string, 'escalation log challenger pubkey must be 32-byte lowercase hex');
      assertHex32(requestHash as string, 'escalation log request hash must be 32-byte lowercase hex');
      assertHex32(bondProofHash as string, 'escalation log bond proof hash must be 32-byte lowercase hex');
      if (!state.challenges.some((c) => c.idx === challengerIdx && c.bondProofHash === bondProofHash)) {
        throw new CourtConfirmationTransitionError(
          'escalation log record is not bound to that challenger\'s accepted bond',
        );
      }
      // Per-round bond consumption (R31, r30-1): the whole point of the
      // witness is that a round costs a FRESH bond. A record that reuses the
      // membership bond, or a hash an earlier round already consumed, would
      // restore the free option on a restored snapshot even though the live
      // reducer refuses it — so the barrier re-derives the same property.
      if (roundBondProofHash !== null) {
        assertHex32(
          roundBondProofHash,
          'escalation log round bond proof hash must be 32-byte lowercase hex',
        );
        if (roundBondProofHash === bondProofHash) {
          throw new CourtConfirmationTransitionError(
            'escalation log round bond must be distinct from the membership (challenge) bond',
          );
        }
        // Same rule the reducer applies (R33, r33-1): no accepted challenge
        // bond of ANY juror may be relabelled as a per-round bond.
        if (state.challenges.some((c) => c.bondProofHash === roundBondProofHash)) {
          throw new CourtConfirmationTransitionError(
            'escalation log round bond is an accepted challenge (membership) bond of this case',
          );
        }
        if (seenRoundBonds.has(roundBondProofHash)) {
          throw new CourtConfirmationTransitionError(
            'escalation log reuses a per-round bond witness across rounds',
          );
        }
        seenRoundBonds.add(roundBondProofHash);
      } else if (state.requireRoundBond === true && state.hostEscalation !== true) {
        throw new CourtConfirmationTransitionError(
          'escalation log records a challenger escalation without the per-round bond this case requires',
        );
      }
    } else if (authority === 'host') {
      if (state.hostEscalation !== true) {
        throw new CourtConfirmationTransitionError(
          'escalation log records a host escalation the frozen policy does not permit',
        );
      }
      if (
        challengerIdx !== null
        || challengerPubkey !== null
        || requestHash !== null
        || bondProofHash !== null
        || roundBondProofHash !== null
      ) {
        throw new CourtConfirmationTransitionError(
          'host escalation log record must not carry a challenger witness',
        );
      }
    } else {
      throw new CourtConfirmationTransitionError(
        'escalation log authority must be "challenger" or "host"',
      );
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
