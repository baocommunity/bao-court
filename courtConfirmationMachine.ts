// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import {
  HEX_32,
  MAX_CEREMONY_PARTICIPANTS,
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
 *                          ladder_vote_closed -> resolve_round ─┐
 *           ┌───────────────────────────────────────────────────┤
 *           ├─ (round === maxLadderRounds) -> fee_settlement -> final
 *           └─ (rounds remain)            -> round_resolved
 *                                             ├─ concede  -> fee_settlement -> final
 *                                             └─ escalate -> ladder_pending (next round)
 *
 * Confirmations are public endorsements (no commit/reveal — the confirmation
 * is itself the juror's signed statement). A challenge must carry a verified
 * bond witness (the host verifies the bond BEFORE dispatching the event; the
 * reducer binds the witness hash so any observer can re-verify). A challenged
 * case runs mass-vote ladder rounds: round r's panel votes publicly, the
 * majority outcome against the proposal decides, and a round that overturns
 * the proposal flags every confirming juror for clawback (reason
 * `overturned_confirmation`, once). When round r's winner differs from round
 * r-1's winner, round r-1's majority voters are flagged for clawback with
 * reason `round_flip` (they followed an outcome the next panel rejected).
 *
 * Multi-round ladder (per the universal-confirmation proposal §4.2): round
 * panels grow host-side (reference sizes r1=15, r2=45, r3=135 jurors —
 * FROST-subset selection is host policy; this machine only tracks rounds and
 * votes). `params.maxLadderRounds` (default 2, bounded 1..5) caps the round
 * count. `open_ladder_round` may carry an expanded per-round roster
 * (`roundRoster`); superset-of-previous is NOT required, but indices must be
 * valid (sequential 1..N, N ≤ 10_000) and the effective round roster must
 * have ≥ 3 members. Escalation is host-driven and explicit: after every
 * round resolution with rounds remaining the machine parks in
 * `round_resolved`, where the host plays `escalate` (next round pending) or
 * `concede` (the current round's outcome becomes final) — the machine never
 * auto-escalates and never auto-concedes. When the last permitted round
 * resolves, the machine proceeds directly to `fee_settlement`. Finality:
 * the verdict at `finalize` is the LAST resolved round's winner, backed by
 * that round's winning-vote event ids (or the confirmation ids when never
 * challenged); `outcomeHistory` records every round's
 * {round, outcome, winnerEventIds, winnerIndices} append-only for host-side
 * reputation scoring (final-round weight 1.0, earlier rounds 0.5 — scoring
 * itself is host policy).
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
  | 'round_resolved'
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
  /** True when the proposed outcome survived (the last resolved round's winner equals it). */
  readonly upheld: boolean;
}

/**
 * Append-only record of one resolved ladder round's outcome (multi-round
 * ladder, universal-confirmation proposal §4.2). `winnerEventIds` are the
 * winning voters' event ids (sorted lexicographically); `winnerIndices` the
 * matching roster indices, retained so a later flip-flop can flag the
 * previous round's majority without re-keeping whole vote ledgers.
 */
export interface CourtRoundOutcomeRecord {
  readonly round: number;
  readonly outcome: string;
  readonly winnerEventIds: readonly string[];
  readonly winnerIndices: readonly number[];
}

interface LadderRound {
  readonly round: number;
  readonly voteDeadline: number;
  readonly votes: readonly CourtMassVoteRecord[];
  /**
   * This round's panel. Defaults to the case roster when the host opens the
   * round without an explicit expansion (or on pre-0.9 snapshots). Sequential
   * 1..N, N ≥ 3.
   */
  readonly roundRoster?: readonly number[];
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
  /**
   * Maximum ladder rounds permitted for this case (1..5, default 2). When
   * round `maxLadderRounds` resolves, the case proceeds to fee_settlement;
   * earlier resolutions park in `round_resolved` for the host's explicit
   * escalate/concede decision.
   */
  readonly maxLadderRounds: number;
  /**
   * Append-only history of resolved rounds' outcomes (frozen). The final
   * verdict is the last entry; hosts derive reputation scores from the
   * per-round coherence with the final outcome.
   */
  readonly outcomeHistory: readonly CourtRoundOutcomeRecord[];
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
      /**
       * Optional expanded panel for THIS round (sequential indices 1..N,
       * N ≥ 3, N ≤ 10_000). Superset of the previous round's roster is NOT
       * required; when omitted the case roster is the round panel.
       */
      readonly roundRoster?: readonly number[];
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
  | {
      /** Host-driven escalation: next ladder round becomes pending. */
      readonly type: 'escalate';
      readonly now: number;
    }
  | {
      /** Host concedes: the current round's outcome becomes final. */
      readonly type: 'concede';
      readonly now: number;
    }
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
/** Ladder bounds: rounds are capped 1..5 (default 2); a round panel has ≥ 3 seats. */
const MAX_LADDER_ROUNDS = 5;
const DEFAULT_LADDER_ROUNDS = 2;
const MIN_ROUND_ROSTER = 3;

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

/**
 * Effective panel for the current ladder round: the round's explicit roster
 * when the host opened one, else the case roster. Mass votes are validated
 * against the ROUND panel (round rosters may grow or change between rounds).
 */
function roundRosterOf(state: CourtConfirmationMachineState): readonly number[] {
  return state.ladder?.roundRoster ?? state.participantIndices;
}

function assertRoundParticipant(state: CourtConfirmationMachineState, idx: number): void {
  assertRosterMember(roundRosterOf(state), idx, 'mass vote participant', CourtConfirmationTransitionError);
}

/**
 * Validate an `open_ladder_round` roster expansion: sequential indices 1..N
 * within the ceremony-participant bound, with at least MIN_ROUND_ROSTER
 * seats. Superset-of-previous-round is deliberately NOT required — per the
 * universal-confirmation proposal §4.2 the host may reconstitute each
 * round's panel (FROST-subset selection is host policy).
 */
function normalizeRoundRoster(roundRoster: readonly number[]): readonly number[] {
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
  /**
   * The juror panel: sequential indices 1..N with N ≥ 3 (round-3 finding
   * r3-6, fail-closed at creation). The confirmation quorum semantics and
   * the ladder's round-panel barrier presuppose a panel of at least
   * MIN_ROUND_ROSTER seats — a 2-member case roster could never resolve a
   * challenged case (the default round panel IS the case roster, and the
   * ledger barrier demands ≥ 3 round-panel members), so such a machine is
   * rejected up front instead of dead-ending mid-challenge.
   */
  readonly participantIndices: readonly number[];
  readonly confirmQuorum?: number;
  readonly confirmDeadline: number;
  readonly challengeDeadline: number;
  /**
   * Maximum ladder rounds (1..5, default 2). Round r resolving with
   * r === maxLadderRounds settles fees directly; earlier resolutions park in
   * `round_resolved` awaiting an explicit host `escalate`/`concede`.
   */
  readonly maxLadderRounds?: number;
}): CourtConfirmationMachineState {
  assertHex32(params.sessionHash, 'sessionHash must be 32-byte lowercase hex');
  assertHex32(params.proposalHash, 'proposalHash must be 32-byte lowercase hex');
  assertBoundedOutcome(params.proposedOutcome, 'proposedOutcome must be a non-empty bounded string');
  const participants = normalizeCeremonyRoster(
    params.participantIndices,
    'confirmation',
    CourtConfirmationTransitionError,
  );
  // Fail closed at creation (round-3 finding r3-6): the confirmation quorum
  // and the ladder's round-panel barrier (MIN_ROUND_ROSTER) presuppose a
  // panel of ≥ 3 seats — a 2-member case roster could confirm (quorum ≤ 2)
  // but could NEVER resolve a challenged case, because the default round
  // panel is the case roster and close_ladder_round/resolve_round reject a
  // < 3-seat panel. Rejecting here keeps every reachable state resolvable.
  if (participants.length < MIN_ROUND_ROSTER) {
    throw new CourtConfirmationTransitionError(
      `confirmation roster must contain at least ${MIN_ROUND_ROSTER} participants`,
    );
  }
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
  const maxLadderRounds = params.maxLadderRounds ?? DEFAULT_LADDER_ROUNDS;
  if (
    !Number.isSafeInteger(maxLadderRounds)
    || maxLadderRounds < 1
    || maxLadderRounds > MAX_LADDER_ROUNDS
  ) {
    throw new CourtConfirmationTransitionError(
      `maxLadderRounds must be a safe integer in [1, ${MAX_LADDER_ROUNDS}]`,
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
    maxLadderRounds,
    outcomeHistory: [],
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
    ['participantIndices', 'allowedOutcomes', 'confirmations', 'challenges', 'fees', 'clawbackFlags', 'outcomeHistory'],
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
    // `ladder_vote_closed`, `round_resolved` and `fee_settlement` are one
    // step from (or at) a mandatory explicit transition — a tick must not
    // expire them (mirrors the vote machine's `reveal_closed` exemption).
    // `round_resolved` waits on the host's appeal decision (`escalate` /
    // `concede`); the appeal window itself is host policy, not a deadline
    // this machine tracks.
    if (TERMINAL_PHASES.has(state.phase) || state.phase === 'ladder_vote_closed' || state.phase === 'round_resolved' || state.phase === 'fee_settlement' || state.phase === 'ladder_pending') {
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
    // Defense in depth: a hand-restored `ladder_pending` snapshot cannot
    // open a round beyond the case's frozen ladder cap (the legal path —
    // `escalate` — already refuses to exceed it).
    if (event.round > state.maxLadderRounds) {
      throw new CourtConfirmationTransitionError(
        `ladder round ${event.round} exceeds maxLadderRounds ${state.maxLadderRounds}`,
      );
    }
    assertPositiveDeadline(event.voteDeadline, 'voteDeadline', CourtConfirmationTransitionError);
    assertBeforeDeadline(event.now, event.voteDeadline, 'cannot open a ladder round with a past vote deadline');
    const roundRoster = event.roundRoster === undefined
      ? state.participantIndices
      : normalizeRoundRoster(event.roundRoster);
    return freezeState({
      ...state,
      phase: 'ladder_vote_open',
      ladderRound: event.round,
      ladder: { round: event.round, voteDeadline: event.voteDeadline, votes: [], roundRoster },
    });
  }

  if (event.type === 'accept_mass_vote') {
    if (state.phase !== 'ladder_vote_open' || !state.ladder) {
      throw new CourtConfirmationTransitionError(`cannot accept mass votes during ${state.phase}`);
    }
    assertBeforeDeadline(event.now, state.ladder.voteDeadline, 'mass vote arrived at or after the round deadline');
    assertRoundParticipant(state, event.idx);
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
    const winnerEventIds = (counts.get(winner) ?? []).map((e) => e.toLowerCase()).sort();
    const winnerIndices = state.ladder.votes
      .filter((v) => v.outcome === winner)
      .map((v) => v.idx);
    // Append-only outcome history (multi-round ladder §4.2): the final
    // verdict is the LAST resolved round; hosts score per-round coherence
    // against the final outcome (final round 1.0, earlier 0.5 — host-side).
    const outcomeHistory: CourtRoundOutcomeRecord[] = [
      ...state.outcomeHistory,
      { round, outcome: winner, winnerEventIds, winnerIndices },
    ];
    let clawbackFlags = state.clawbackFlags;
    if (!upheld) {
      // The proposal was overturned: every confirming juror is flagged for
      // fee clawback. Flagging is a state transition, never a side effect,
      // and idempotent per (idx, reason): later rounds that also reject the
      // proposal must not duplicate the original confirmers' flags.
      const alreadyFlagged = new Set(
        clawbackFlags.filter((f) => f.reason === 'overturned_confirmation').map((f) => f.idx),
      );
      const flags = state.confirmations
        .filter((c) => !alreadyFlagged.has(c.idx))
        .map((c) => ({ idx: c.idx, reason: 'overturned_confirmation', round }));
      if (flags.length > 0) {
        clawbackFlags = [...clawbackFlags, ...flags];
      }
    }
    // Flip-flop rule (§4.2): when round r's winner differs from round r-1's
    // winner, round r-1's majority voters followed an outcome the next panel
    // rejected — flag them for clawback with reason `round_flip`, idempotent
    // per (idx, reason, round).
    const previous = state.outcomeHistory[state.outcomeHistory.length - 1];
    if (previous && previous.outcome !== winner) {
      const alreadyFlipped = new Set(
        clawbackFlags
          .filter((f) => f.reason === 'round_flip' && f.round === previous.round)
          .map((f) => f.idx),
      );
      const flipFlags = previous.winnerIndices
        .filter((idx) => !alreadyFlipped.has(idx))
        .map((idx) => ({ idx, reason: 'round_flip', round: previous.round }));
      if (flipFlags.length > 0) {
        clawbackFlags = [...clawbackFlags, ...flipFlags];
      }
    }
    // Compatibility rule: the final permitted round settles fees directly
    // (the v0.8.5 single-round flow with maxLadderRounds = 1, or the last
    // round of a longer ladder); any earlier resolution parks in
    // `round_resolved` where the host plays `escalate` or `concede` — the
    // machine never auto-escalates and never auto-concedes.
    const isFinalRound = round >= state.maxLadderRounds;
    return freezeState({
      ...state,
      phase: isFinalRound ? 'fee_settlement' : 'round_resolved',
      clawbackFlags,
      outcomeHistory,
      verdict: {
        outcome: winner,
        supportingEventIds: [],
        verdictHash: '',
        upheld,
      },
    });
  }

  if (event.type === 'escalate') {
    if (state.phase !== 'round_resolved') {
      throw new CourtConfirmationTransitionError(
        `cannot escalate during ${state.phase}`,
      );
    }
    // Fail closed: a hand-restored snapshot parked at round_resolved with
    // the cap already reached must not re-open the ladder.
    if (state.ladderRound >= state.maxLadderRounds) {
      throw new CourtConfirmationTransitionError(
        `maxLadderRounds ${state.maxLadderRounds} already reached at round ${state.ladderRound}`,
      );
    }
    return freezeState({ ...state, phase: 'ladder_pending' });
  }

  if (event.type === 'concede') {
    if (state.phase !== 'round_resolved') {
      throw new CourtConfirmationTransitionError(
        `cannot concede during ${state.phase}`,
      );
    }
    // The pending verdict (the current round's outcome) becomes final; the
    // host settles fees and finalize mints the verdict from the last
    // resolved round's winning votes.
    return freezeState({ ...state, phase: 'fee_settlement' });
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
    // Finality (multi-round ladder §4.2): the verdict is the LAST resolved
    // round's winner. A challenged case is backed by that round's
    // winning-vote event ids; an never-challenged case by the confirmation
    // ledger. (v0.8.5 backed an upheld challenged round with confirmations;
    // the ladder spec pins the evidence to the round that decided.)
    const supportingEventIds = state.challenges.length === 0 && pending.upheld
      ? state.confirmations.map((c) => c.eventId.toLowerCase()).sort()
      : (state.ladder?.votes ?? [])
          .filter((v) => v.outcome === pending.outcome)
          .map((v) => v.eventId.toLowerCase())
          .sort();
    // Fail closed (round-3 finding r3-1): a final verdict needs at least one
    // supporting event. On live paths this is unreachable —
    // close_confirmations enforces the quorum (so the never-challenged path
    // always has ≥ confirmQuorum ≥ 1 confirmation events) and resolve_round
    // refuses an empty vote ledger (so the winner has ≥ 1 event id) — but a
    // hand-restored snapshot with an emptied confirmation ledger used to
    // reach hashCourtVerdict with zero ids, escaping the VOTE machine's
    // foreign CourtVoteTransitionError out of THIS machine. Throw the
    // confirmation machine's own typed error instead.
    if (supportingEventIds.length === 0) {
      throw new CourtConfirmationTransitionError(
        'cannot finalize a verdict with zero supporting event ids — an upheld confirmation needs a quorum of confirmations, a resolved round needs winning votes',
      );
    }
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
