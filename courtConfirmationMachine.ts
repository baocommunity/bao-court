// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import {
  HEX_32,
  assertBeforeDeadline as assertBeforeDeadlineCore,
  assertNow,
  assertPositiveDeadline,
  assertRosterMember,
  assertStateArrays,
  isCanonicalUtf8Text,
  normalizeCeremonyRoster,
} from './courtCeremonyCore';
import {
  compareOutcomeUtf8,
  hashCourtVerdict,
} from './courtVoteMachine';
// Note (cross-module round 2, SEQUENCE-6): this machine intentionally reuses
// the vote machine's COURT_VERDICT_DOMAIN via hashCourtVerdict — a
// confirmation verdict and a mass-vote verdict with identical
// (sessionHash, outcome, supportingEventIds) hash identically BY DESIGN
// (same evidence semantics, one verdict domain). The machines draw their
// supporting ids from different event universes (confirmation events vs
// commit/reveal events), so substituting one universe for the other changes
// the hash and fails batch/proof verification. Dispute attestations use the
// separate DisputeVerdict/v1 domain (hashDisputeVerdict) and cannot be
// confused with either.
import { CanonicalWriter } from './courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Pure fail-closed state machine for one BAO Court universal-confirmation
 * case (v1).
 *
 * Every market outcome — disputed or not — is confirmed by a juror panel:
 *
 *   confirm_open -> confirm_closed -> challenge_window
 *     ├─ (no challenge) -> fee_settlement -> final
 *     └─ (challenge)    -> ladder_pending -> ladder_vote_open ->
 *                          ladder_vote_closed -> fee_settlement -> final
 *
 * Confirmations are public endorsements (no commit/reveal — the confirmation
 * is itself the juror's signed statement). A challenge must carry a verified
 * bond witness (the host verifies the bond BEFORE dispatching the event; the
 * reducer binds the witness hash so any observer can re-verify). A challenged
 * case runs one mass-vote ladder round: roster jurors vote publicly, the
 * majority outcome against the proposal decides, and an overturned proposal
 * flags every confirming juror for clawback (reason `overturned_confirmation`).
 *
 * Scope note (v1): the ladder resolves in a single round. Multi-round
 * escalation (5 -> 15 -> ... -> mass vote) and per-round vote-set Merkle
 * roots are specified in the universal-confirmation proposal and will extend
 * this machine in a later minor version.
 *
 * This module performs no network or Nostr signature verification; the event
 * boundary must authenticate authors and roster indices before dispatching
 * events into the reducer. Hosts inject clocks by passing `now`; the machine
 * is deterministic, freeze-safe, and snapshot-friendly (plain JSON state).
 */

export const COURT_CONFIRMATION_DOMAIN = 'BAO-Court/Confirm/v1';

export type CourtConfirmationPhase =
  | 'confirm_open'
  | 'confirm_closed'
  | 'challenge_window'
  | 'ladder_pending'
  | 'ladder_vote_open'
  | 'ladder_vote_closed'
  | 'fee_settlement'
  | 'final'
  | 'expired'
  | 'aborted';

export interface CourtConfirmationFailure {
  readonly phase: 'expired' | 'aborted';
  readonly reason: string;
}

export interface CourtConfirmationRecord {
  readonly idx: number;
  readonly confirmHash: string;
  readonly eventId: string;
}

export interface CourtChallengeRecord {
  readonly idx: number;
  /** 32-byte lowercase hex transaction id of the escrowed challenge bond. */
  readonly bondTxid: string;
  /**
   * 32-byte lowercase hex hash of the verified bond-ownership witness. The
   * host verifies the witness against the bond UTXO BEFORE dispatching this
   * event; the reducer binds the hash so observers can re-verify later.
   */
  readonly bondProofHash: string;
  readonly eventId: string;
}

export interface CourtMassVoteRecord {
  readonly idx: number;
  readonly outcome: string;
  readonly eventId: string;
}

export interface CourtClawbackFlag {
  readonly idx: number;
  readonly reason: string;
  readonly round: number;
}

export interface CourtConfirmationVerdict {
  readonly outcome: string;
  /** Supporting event ids, sorted lexicographically for canonical hashing. */
  readonly supportingEventIds: readonly string[];
  readonly verdictHash: string;
  /** True when the proposed outcome survived the challenge window/round. */
  readonly upheld: boolean;
}

interface LadderRound {
  readonly round: number;
  readonly voteDeadline: number;
  readonly votes: readonly CourtMassVoteRecord[];
}

export interface CourtConfirmationMachineState {
  readonly sessionHash: string;
  readonly proposalHash: string;
  readonly proposedOutcome: string;
  readonly allowedOutcomes: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly participantIndices: readonly number[];
  readonly confirmQuorum: number;
  readonly confirmDeadline: number;
  readonly challengeDeadline: number;
  /** Greatest caller-supplied timestamp accepted by the reducer. */
  readonly latestTimestamp: number;
  readonly phase: CourtConfirmationPhase;
  readonly confirmations: readonly CourtConfirmationRecord[];
  readonly challenges: readonly CourtChallengeRecord[];
  /** Current ladder round; undefined until a challenge advances the case. */
  readonly ladder?: LadderRound;
  /** Highest ladder round opened so far (0 = none). */
  readonly ladderRound: number;
  readonly clawbackFlags: readonly CourtClawbackFlag[];
  /** Fee-ledger event ids recorded for this case (bonds forfeit, fees paid). */
  readonly fees: readonly string[];
  readonly verdict?: CourtConfirmationVerdict;
  readonly failure?: CourtConfirmationFailure;
}

export type CourtConfirmationMachineEvent =
  | {
      readonly type: 'accept_confirmation';
      readonly idx: number;
      readonly confirmHash: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_confirmations'; readonly now: number }
  | { readonly type: 'open_challenge_window'; readonly now: number }
  | {
      readonly type: 'accept_challenge';
      readonly idx: number;
      readonly bondTxid: string;
      readonly bondProofHash: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_challenge_window'; readonly now: number }
  | {
      readonly type: 'open_ladder_round';
      readonly round: number;
      readonly voteDeadline: number;
      readonly now: number;
    }
  | {
      readonly type: 'accept_mass_vote';
      readonly idx: number;
      readonly outcome: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_ladder_round'; readonly now: number }
  | { readonly type: 'resolve_round'; readonly now: number }
  | { readonly type: 'record_fee'; readonly feeEventId: string; readonly now: number }
  | { readonly type: 'flag_clawback'; readonly idx: number; readonly reason: string; readonly now: number }
  | { readonly type: 'finalize'; readonly now: number }
  | { readonly type: 'tick'; readonly now: number }
  | { readonly type: 'abort'; readonly reason: string };

export class CourtConfirmationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourtConfirmationTransitionError';
  }
}

const textEncoder = new TextEncoder();
const MAX_OUTCOME_BYTES = 256;
const MAX_CONFIRMATIONS = 10_000;
const MAX_CHALLENGES = 10_000;
const MAX_MASS_VOTES = 10_000;
const MAX_CLAWBACK_FLAGS = 10_000;
const MAX_FEES = 256;
const MAX_EVIDENCE_IDS = 256;
const MAX_REASON_BYTES = 64;

const TERMINAL_PHASES = new Set<CourtConfirmationPhase>(['final', 'expired', 'aborted']);

/** Phases a clock tick may expire, with the deadline that governs each. */
const TICK_DEADLINES: Partial<Record<CourtConfirmationPhase, (s: CourtConfirmationMachineState) => number>> = {
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

function assertParticipant(state: CourtConfirmationMachineState, idx: number): void {
  assertRosterMember(state.participantIndices, idx, 'confirmation participant', CourtConfirmationTransitionError);
}

function assertBeforeDeadline(now: number, deadline: number, message: string): void {
  assertBeforeDeadlineCore(now, deadline, message, CourtConfirmationTransitionError);
}

function assertBoundedOutcome(outcome: string, message: string): void {
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

function assertHex32(value: string, message: string): void {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtConfirmationTransitionError(message);
  }
}

/**
 * Freeze the state graph so no holder of a returned reference can mutate
 * frozen configuration, ledgers, or verdicts between transitions (mirrors
 * the vote machine's freeze discipline).
 */
function freezeState(state: CourtConfirmationMachineState): CourtConfirmationMachineState {
  for (const record of state.confirmations) Object.freeze(record);
  for (const record of state.challenges) Object.freeze(record);
  if (state.ladder) {
    for (const vote of state.ladder.votes) Object.freeze(vote);
    Object.freeze(state.ladder.votes);
    Object.freeze(state.ladder);
  }
  for (const flag of state.clawbackFlags) Object.freeze(flag);
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
 * Ledger barrier: every mass vote must identify a roster participant, name an
 * allowed outcome, carry well-formed ids, and be unique per index and event
 * id. Used before close_ladder_round and resolve_round so a tampered (or
 * hand-restored) ledger is caught before the outcome is locked in.
 */
function assertValidMassVoteLedger(state: CourtConfirmationMachineState): void {
  const ladder = state.ladder;
  if (!ladder || !Array.isArray(ladder.votes)) {
    throw new CourtConfirmationTransitionError('ladder state is missing or malformed');
  }
  const seenIndices = new Set<number>();
  const seenEventIds = new Set<string>();
  for (const vote of ladder.votes) {
    if (typeof vote !== 'object' || vote === null) {
      throw new CourtConfirmationTransitionError('ladder state contains a malformed vote record');
    }
    assertParticipant(state, vote.idx);
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
function assertValidConfirmationLedger(state: CourtConfirmationMachineState): void {
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

export function createCourtConfirmationMachine(params: {
  readonly sessionHash: string;
  /** 32-byte lowercase hex commitment to the proposed outcome + evidence. */
  readonly proposalHash: string;
  readonly proposedOutcome: string;
  readonly allowedOutcomes: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly participantIndices: readonly number[];
  readonly confirmQuorum?: number;
  readonly confirmDeadline: number;
  readonly challengeDeadline: number;
}): CourtConfirmationMachineState {
  assertHex32(params.sessionHash, 'sessionHash must be 32-byte lowercase hex');
  assertHex32(params.proposalHash, 'proposalHash must be 32-byte lowercase hex');
  assertBoundedOutcome(params.proposedOutcome, 'proposedOutcome must be a non-empty bounded string');
  const participants = normalizeCeremonyRoster(
    params.participantIndices,
    'confirmation',
    CourtConfirmationTransitionError,
  );
  if (
    !Array.isArray(params.allowedOutcomes)
    || params.allowedOutcomes.length < 2
    || params.allowedOutcomes.length > 256
  ) {
    throw new CourtConfirmationTransitionError('allowedOutcomes must contain 2..256 outcomes');
  }
  const outcomes = [...params.allowedOutcomes];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    assertBoundedOutcome(outcome, 'allowed outcomes must be non-empty bounded strings');
    if (seen.has(outcome)) {
      throw new CourtConfirmationTransitionError('allowed outcomes must be unique');
    }
    seen.add(outcome);
  }
  if (!outcomes.includes(params.proposedOutcome)) {
    throw new CourtConfirmationTransitionError(
      'proposedOutcome must be a member of allowedOutcomes',
    );
  }
  const evidenceIds = params.evidenceIds ?? [];
  if (!Array.isArray(evidenceIds) || evidenceIds.length > MAX_EVIDENCE_IDS) {
    throw new CourtConfirmationTransitionError(
      `evidenceIds must contain at most ${MAX_EVIDENCE_IDS} entries`,
    );
  }
  for (const id of evidenceIds) {
    assertHex32(id, 'evidence ids must be 32-byte lowercase hex');
  }
  const confirmQuorum = params.confirmQuorum ?? 1;
  if (
    !Number.isSafeInteger(confirmQuorum)
    || confirmQuorum < 1
    || confirmQuorum > participants.length
  ) {
    throw new CourtConfirmationTransitionError(
      'confirmQuorum must be a safe integer in [1, roster size]',
    );
  }
  assertPositiveDeadline(params.confirmDeadline, 'confirmDeadline', CourtConfirmationTransitionError);
  if (
    !Number.isSafeInteger(params.challengeDeadline)
    || params.challengeDeadline <= params.confirmDeadline
  ) {
    throw new CourtConfirmationTransitionError(
      'challengeDeadline must be later than confirmDeadline',
    );
  }
  return freezeState({
    sessionHash: params.sessionHash,
    proposalHash: params.proposalHash,
    proposedOutcome: params.proposedOutcome,
    allowedOutcomes: outcomes,
    evidenceIds: [...evidenceIds],
    participantIndices: participants,
    confirmQuorum,
    confirmDeadline: params.confirmDeadline,
    challengeDeadline: params.challengeDeadline,
    latestTimestamp: 0,
    phase: 'confirm_open',
    confirmations: [],
    challenges: [],
    ladderRound: 0,
    clawbackFlags: [],
    fees: [],
  });
}

export function reduceCourtConfirmationMachine(
  state: CourtConfirmationMachineState,
  event: CourtConfirmationMachineEvent,
): CourtConfirmationMachineState {
  // Fail closed on a non-object event (a null/undefined event would crash
  // with an uncaught TypeError on property access below).
  if (event === null || typeof event !== 'object') {
    throw new CourtConfirmationTransitionError('event must be an object');
  }
  // Fail closed on a tampered or hand-restored state whose configuration or
  // ledger fields were replaced by non-array values (an uncaught TypeError
  // in the guards below, or a string allowlist admitting substring matches
  // outside the frozen ballot).
  assertStateArrays(
    state as unknown as Record<string, unknown>,
    ['participantIndices', 'allowedOutcomes', 'confirmations', 'challenges', 'fees', 'clawbackFlags'],
    CourtConfirmationTransitionError,
  );
  if (
    state.ladder !== undefined
    && (typeof state.ladder !== 'object' || state.ladder === null || !Array.isArray(state.ladder.votes))
  ) {
    throw new CourtConfirmationTransitionError('ladder state is missing or malformed');
  }
  // Monotonic non-decreasing clock for every time-bearing event; `abort`
  // carries no clock (mirrors the vote machine).
  if (event.type !== 'abort') {
    assertNow(event.now, CourtConfirmationTransitionError);
    if (event.now < state.latestTimestamp) {
      throw new CourtConfirmationTransitionError(
        'now must not precede a previously observed timestamp',
      );
    }
    state = { ...state, latestTimestamp: event.now };
  }

  if (event.type === 'tick') {
    // `ladder_vote_closed` and `fee_settlement` are one step from (or at) a
    // mandatory explicit transition — a tick must not expire them (mirrors
    // the vote machine's `reveal_closed` exemption).
    if (TERMINAL_PHASES.has(state.phase) || state.phase === 'ladder_vote_closed' || state.phase === 'fee_settlement' || state.phase === 'ladder_pending') {
      return freezeState(state);
    }
    const deadline = TICK_DEADLINES[state.phase]?.(state);
    if (deadline === undefined || event.now < deadline) {
      return freezeState(state);
    }
    return freezeState({
      ...state,
      phase: 'expired',
      failure: { phase: 'expired', reason: `The ${state.phase} deadline passed before resolution.` },
    });
  }

  if (event.type === 'abort') {
    if (TERMINAL_PHASES.has(state.phase)) {
      throw new CourtConfirmationTransitionError(`cannot abort confirmation from ${state.phase}`);
    }
    return freezeState({
      ...state,
      phase: 'aborted',
      failure: { phase: 'aborted', reason: event.reason },
    });
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtConfirmationTransitionError(`cannot process ${event.type} after ${state.phase}`);
  }

  if (event.type === 'accept_confirmation') {
    if (state.phase !== 'confirm_open') {
      throw new CourtConfirmationTransitionError(
        `cannot accept confirmations during ${state.phase}`,
      );
    }
    assertBeforeDeadline(event.now, state.confirmDeadline, 'confirmation arrived at or after the confirm deadline');
    assertParticipant(state, event.idx);
    assertHex32(event.confirmHash, 'confirmation hash must be 32-byte lowercase hex');
    assertHex32(event.eventId, 'confirmation event id must be 32-byte lowercase hex');
    const expected = hashCourtConfirmation({
      sessionHash: state.sessionHash,
      proposalHash: state.proposalHash,
      idx: event.idx,
    });
    if (expected !== event.confirmHash) {
      throw new CourtConfirmationTransitionError(
        `confirmation from participant ${event.idx} does not match the canonical confirmation hash`,
      );
    }
    if (state.confirmations.length >= MAX_CONFIRMATIONS) {
      throw new CourtConfirmationTransitionError(
        `confirmation ledger exceeds maximum of ${MAX_CONFIRMATIONS} entries`,
      );
    }
    const existing = state.confirmations.find((c) => c.idx === event.idx);
    if (existing) {
      if (existing.confirmHash === event.confirmHash && existing.eventId === event.eventId) {
        return freezeState(state);
      }
      throw new CourtConfirmationTransitionError(
        `participant ${event.idx} published a conflicting confirmation`,
      );
    }
    return freezeState({
      ...state,
      confirmations: [
        ...state.confirmations,
        { idx: event.idx, confirmHash: event.confirmHash, eventId: event.eventId },
      ],
    });
  }

  if (event.type === 'close_confirmations') {
    if (state.phase !== 'confirm_open') {
      throw new CourtConfirmationTransitionError(`cannot close confirmations during ${state.phase}`);
    }
    if (event.now < state.confirmDeadline) {
      throw new CourtConfirmationTransitionError(
        'cannot close confirmations before the confirm deadline',
      );
    }
    // Fail closed: a quorum that never formed must be expired by a tick (or
    // aborted by the host), never silently closed.
    if (state.confirmations.length < state.confirmQuorum) {
      throw new CourtConfirmationTransitionError(
        `confirm quorum not met: ${state.confirmations.length}/${state.confirmQuorum}`,
      );
    }
    return freezeState({ ...state, phase: 'confirm_closed' });
  }

  if (event.type === 'open_challenge_window') {
    if (state.phase !== 'confirm_closed') {
      throw new CourtConfirmationTransitionError(
        `cannot open the challenge window during ${state.phase}`,
      );
    }
    assertBeforeDeadline(event.now, state.challengeDeadline, 'cannot open the challenge window at or after the challenge deadline');
    return freezeState({ ...state, phase: 'challenge_window' });
  }

  if (event.type === 'accept_challenge') {
    if (state.phase !== 'challenge_window') {
      throw new CourtConfirmationTransitionError(
        `cannot accept challenges during ${state.phase}`,
      );
    }
    assertBeforeDeadline(event.now, state.challengeDeadline, 'challenge arrived at or after the challenge deadline');
    assertParticipant(state, event.idx);
    assertHex32(event.bondTxid, 'challenge bond txid must be 32-byte lowercase hex');
    assertHex32(event.bondProofHash, 'challenge bond proof hash must be 32-byte lowercase hex');
    assertHex32(event.eventId, 'challenge event id must be 32-byte lowercase hex');
    if (state.challenges.length >= MAX_CHALLENGES) {
      throw new CourtConfirmationTransitionError(
        `challenge ledger exceeds maximum of ${MAX_CHALLENGES} entries`,
      );
    }
    const existing = state.challenges.find((c) => c.idx === event.idx);
    if (existing) {
      if (
        existing.bondTxid === event.bondTxid &&
        existing.bondProofHash === event.bondProofHash &&
        existing.eventId === event.eventId
      ) {
        return freezeState(state);
      }
      throw new CourtConfirmationTransitionError(
        `participant ${event.idx} published a conflicting challenge`,
      );
    }
    return freezeState({
      ...state,
      challenges: [
        ...state.challenges,
        { idx: event.idx, bondTxid: event.bondTxid, bondProofHash: event.bondProofHash, eventId: event.eventId },
      ],
    });
  }

  if (event.type === 'close_challenge_window') {
    if (state.phase !== 'challenge_window') {
      throw new CourtConfirmationTransitionError(
        `cannot close the challenge window during ${state.phase}`,
      );
    }
    if (event.now < state.challengeDeadline) {
      throw new CourtConfirmationTransitionError(
        'cannot close the challenge window before the challenge deadline',
      );
    }
    return freezeState({
      ...state,
      phase: state.challenges.length > 0 ? 'ladder_pending' : 'fee_settlement',
      // The no-challenge path resolves immediately: the proposal stands and
      // finalize computes the canonical verdict from the confirmation ledger.
      verdict:
        state.challenges.length > 0
          ? state.verdict
          : { outcome: state.proposedOutcome, supportingEventIds: [], verdictHash: '', upheld: true },
    });
  }

  if (event.type === 'open_ladder_round') {
    if (state.phase !== 'ladder_pending') {
      throw new CourtConfirmationTransitionError(
        `cannot open a ladder round during ${state.phase}`,
      );
    }
    if (
      !Number.isSafeInteger(event.round)
      || event.round !== state.ladderRound + 1
    ) {
      throw new CourtConfirmationTransitionError(
        `ladder rounds must be consecutive: expected ${state.ladderRound + 1}`,
      );
    }
    assertPositiveDeadline(event.voteDeadline, 'voteDeadline', CourtConfirmationTransitionError);
    assertBeforeDeadline(event.now, event.voteDeadline, 'cannot open a ladder round with a past vote deadline');
    return freezeState({
      ...state,
      phase: 'ladder_vote_open',
      ladderRound: event.round,
      ladder: { round: event.round, voteDeadline: event.voteDeadline, votes: [] },
    });
  }

  if (event.type === 'accept_mass_vote') {
    if (state.phase !== 'ladder_vote_open' || !state.ladder) {
      throw new CourtConfirmationTransitionError(`cannot accept mass votes during ${state.phase}`);
    }
    assertBeforeDeadline(event.now, state.ladder.voteDeadline, 'mass vote arrived at or after the round deadline');
    assertParticipant(state, event.idx);
    if (typeof event.outcome !== 'string' || !state.allowedOutcomes.includes(event.outcome)) {
      throw new CourtConfirmationTransitionError(
        'mass vote names an outcome outside the frozen allowlist',
      );
    }
    assertHex32(event.eventId, 'mass vote event id must be 32-byte lowercase hex');
    if (state.ladder.votes.length >= MAX_MASS_VOTES) {
      throw new CourtConfirmationTransitionError(
        `mass vote ledger exceeds maximum of ${MAX_MASS_VOTES} entries`,
      );
    }
    const existing = state.ladder.votes.find((v) => v.idx === event.idx);
    if (existing) {
      if (existing.outcome === event.outcome && existing.eventId === event.eventId) {
        return freezeState(state);
      }
      throw new CourtConfirmationTransitionError(
        `participant ${event.idx} published a conflicting mass vote`,
      );
    }
    return freezeState({
      ...state,
      ladder: {
        ...state.ladder,
        votes: [...state.ladder.votes, { idx: event.idx, outcome: event.outcome, eventId: event.eventId }],
      },
    });
  }

  if (event.type === 'close_ladder_round') {
    if (state.phase !== 'ladder_vote_open' || !state.ladder) {
      throw new CourtConfirmationTransitionError(`cannot close the ladder round during ${state.phase}`);
    }
    if (event.now < state.ladder.voteDeadline) {
      throw new CourtConfirmationTransitionError(
        'cannot close the ladder round before the round deadline',
      );
    }
    assertValidMassVoteLedger(state);
    return freezeState({ ...state, phase: 'ladder_vote_closed' });
  }

  if (event.type === 'resolve_round') {
    if (state.phase !== 'ladder_vote_closed' || !state.ladder) {
      throw new CourtConfirmationTransitionError(`cannot resolve a round during ${state.phase}`);
    }
    assertValidMassVoteLedger(state);
    assertValidConfirmationLedger(state);
    if (state.ladder.votes.length === 0) {
      throw new CourtConfirmationTransitionError('cannot resolve a round without any valid mass vote');
    }
    // Majority outcome; ties break deterministically exactly as the vote
    // machine's tally (lexicographic unsigned UTF-8 byte order).
    const counts = new Map<string, string[]>();
    for (const vote of state.ladder.votes) {
      const list = counts.get(vote.outcome) ?? [];
      list.push(vote.eventId);
      counts.set(vote.outcome, list);
    }
    let winner = '';
    let winnerCount = -1;
    for (const [outcome, eventIds] of counts.entries()) {
      if (
        eventIds.length > winnerCount ||
        (eventIds.length === winnerCount && compareOutcomeUtf8(outcome, winner) < 0)
      ) {
        winner = outcome;
        winnerCount = eventIds.length;
      }
    }
    const upheld = winner === state.proposedOutcome;
    const round = state.ladder.round;
    let clawbackFlags = state.clawbackFlags;
    if (!upheld) {
      // The proposal was overturned: every confirming juror is flagged for
      // fee clawback. Flagging is a state transition, never a side effect.
      const flags = state.confirmations.map((c) => ({
        idx: c.idx,
        reason: 'overturned_confirmation',
        round,
      }));
      clawbackFlags = [...state.clawbackFlags, ...flags];
    }
    return freezeState({
      ...state,
      phase: 'fee_settlement',
      clawbackFlags,
      verdict: {
        outcome: winner,
        supportingEventIds: [],
        verdictHash: '',
        upheld,
      },
    });
  }

  if (event.type === 'record_fee') {
    assertHex32(event.feeEventId, 'fee event id must be 32-byte lowercase hex');
    if (state.fees.includes(event.feeEventId)) {
      return freezeState(state);
    }
    if (state.fees.length >= MAX_FEES) {
      throw new CourtConfirmationTransitionError(
        `fee ledger exceeds maximum of ${MAX_FEES} entries`,
      );
    }
    return freezeState({ ...state, fees: [...state.fees, event.feeEventId] });
  }

  if (event.type === 'flag_clawback') {
    if (state.phase !== 'fee_settlement') {
      throw new CourtConfirmationTransitionError(
        `cannot flag clawbacks during ${state.phase}`,
      );
    }
    assertParticipant(state, event.idx);
    if (
      typeof event.reason !== 'string'
      || event.reason.length === 0
      || textEncoder.encode(event.reason).length > MAX_REASON_BYTES
    ) {
      throw new CourtConfirmationTransitionError('clawback reason must be a non-empty bounded string');
    }
    if (
      state.clawbackFlags.some((f) => f.idx === event.idx && f.reason === event.reason)
    ) {
      return freezeState(state);
    }
    if (state.clawbackFlags.length >= MAX_CLAWBACK_FLAGS) {
      throw new CourtConfirmationTransitionError(
        `clawback ledger exceeds maximum of ${MAX_CLAWBACK_FLAGS} entries`,
      );
    }
    return freezeState({
      ...state,
      clawbackFlags: [
        ...state.clawbackFlags,
        { idx: event.idx, reason: event.reason, round: state.ladderRound },
      ],
    });
  }

  if (event.type === 'finalize') {
    if (state.phase !== 'fee_settlement') {
      throw new CourtConfirmationTransitionError(`cannot finalize during ${state.phase}`);
    }
    // Ledger barrier (cross-module round 2, SEQUENCE-4): the confirmation
    // ledger becomes the verdict's supporting event ids, so a restored or
    // hand-tampered snapshot is re-verified against the canonical
    // confirmation bindings before any verdict hash is minted. The verdict
    // is a pure function of the verified ledgers: clawback-flag history is
    // deliberately NOT an input, so replaying the same pre-finalize
    // snapshot with a different flag history yields the identical
    // verdictHash (deterministic double-finalize protection).
    assertValidConfirmationLedger(state);
    const pending = state.verdict;
    if (!pending) {
      throw new CourtConfirmationTransitionError('cannot finalize without a resolved round');
    }
    const supportingEventIds = pending.upheld
      ? state.confirmations.map((c) => c.eventId.toLowerCase()).sort()
      : (state.ladder?.votes ?? [])
          .filter((v) => v.outcome === pending.outcome)
          .map((v) => v.eventId.toLowerCase())
          .sort();
    const verdictHash = hashCourtVerdict({
      sessionHash: state.sessionHash,
      outcome: pending.outcome,
      supportingEventIds,
    });
    return freezeState({
      ...state,
      phase: 'final',
      verdict: {
        outcome: pending.outcome,
        supportingEventIds,
        verdictHash,
        upheld: pending.upheld,
      },
    });
  }

  // Unreachable for well-typed events; fail closed instead of silently
  // returning an unfrozen clock-advanced copy for a hostile unknown type.
  const unknownType = (event as { readonly type?: unknown }).type;
  throw new CourtConfirmationTransitionError(`unknown confirmation event type: ${String(unknownType)}`);
}
