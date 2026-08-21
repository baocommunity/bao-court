// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/** Pure fail-closed state machine for one BAO Court DKG attempt. */

import {
  HEX_32,
  assertBeforeDeadline as assertBeforeDeadlineCore,
  assertBlamedIdx,
  assertNow,
  assertPositiveDeadline,
  assertRosterMember,
  normalizeCeremonyRoster,
} from './courtCeremonyCore';

export type CourtDkgPhase =
  | 'parameters_confirmed'
  | 'dkg_round_1'
  | 'dkg_round_2'
  | 'transcript_signing'
  | 'certified'
  | 'backed_up'
  | 'expired'
  | 'delivery_failed'
  | 'aborted_peer'
  | 'aborted_coordinator'
  | 'aborted_network'
  | 'incompatible_suite';

export type CourtDkgFailurePhase = Extract<
  CourtDkgPhase,
  | 'delivery_failed'
  | 'aborted_peer'
  | 'aborted_coordinator'
  | 'aborted_network'
  | 'incompatible_suite'
>;

export interface CourtDkgFailure {
  readonly phase: CourtDkgFailurePhase | 'expired';
  readonly reason: string;
  readonly blamedIdx?: number;
}

export interface CourtDkgMachineState {
  readonly sessionHash: string;
  readonly participantIndices: readonly number[];
  readonly deadline: number;
  readonly phase: CourtDkgPhase;
  readonly round1Participants: readonly number[];
  readonly round2Participants: readonly number[];
  readonly transcriptCertifiers: readonly number[];
  readonly transcriptHash?: string;
  readonly candidateGroupPubkey?: string;
  /** Unavailable until every participant certifies the exact transcript. */
  readonly certifiedGroupPubkey?: string;
  readonly backupVerified: boolean;
  readonly failure?: CourtDkgFailure;
}

export type CourtDkgMachineEvent =
  | { readonly type: 'start'; readonly now: number }
  | { readonly type: 'accept_round_1'; readonly idx: number; readonly now: number }
  | { readonly type: 'accept_round_2'; readonly idx: number; readonly now: number }
  | {
      readonly type: 'finalize_transcript';
      readonly transcriptHash: string;
      readonly candidateGroupPubkey: string;
      readonly now: number;
    }
  | {
      readonly type: 'accept_certification';
      readonly idx: number;
      readonly transcriptHash: string;
      readonly now: number;
    }
  | { readonly type: 'confirm_backup'; readonly now: number }
  | { readonly type: 'tick'; readonly now: number }
  | {
      readonly type: 'abort';
      readonly phase: CourtDkgFailurePhase;
      readonly reason: string;
      readonly blamedIdx?: number;
    };

export class CourtDkgTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourtDkgTransitionError';
  }
}

const GROUP_KEY = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;

/** Phases that may only enter state through a validated `abort` event. */
const ABORT_PHASES = new Set<CourtDkgPhase>([
  'delivery_failed',
  'aborted_peer',
  'aborted_coordinator',
  'aborted_network',
  'incompatible_suite',
]);

const TERMINAL_PHASES = new Set<CourtDkgPhase>([
  'backed_up',
  'expired',
  'delivery_failed',
  'aborted_peer',
  'aborted_coordinator',
  'aborted_network',
  'incompatible_suite',
]);

function addSorted(values: readonly number[], idx: number): readonly number[] {
  if (values.includes(idx)) return values;
  return [...values, idx].sort((a, b) => a - b);
}

function assertParticipant(state: CourtDkgMachineState, idx: number): void {
  assertRosterMember(state.participantIndices, idx, 'participant', CourtDkgTransitionError);
}

function assertBeforeDeadline(state: CourtDkgMachineState, now: number): void {
  assertBeforeDeadlineCore(
    now,
    state.deadline,
    'DKG message arrived at or after the ceremony deadline',
    CourtDkgTransitionError,
  );
}

function expire(state: CourtDkgMachineState, now: number): CourtDkgMachineState {
  assertNow(now, CourtDkgTransitionError);
  if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') return state;
  if (now < state.deadline) return state;
  return {
    ...state,
    phase: 'expired',
    failure: { phase: 'expired', reason: 'The DKG deadline passed before unanimous certification.' },
  };
}

export function createCourtDkgMachine(params: {
  readonly sessionHash: string;
  readonly participantIndices: readonly number[];
  readonly deadline: number;
}): CourtDkgMachineState {
  if (typeof params.sessionHash !== 'string' || !HEX_32.test(params.sessionHash)) {
    throw new CourtDkgTransitionError('sessionHash must be 32-byte lowercase hex');
  }
  assertPositiveDeadline(params.deadline, 'deadline', CourtDkgTransitionError);
  const participants = normalizeCeremonyRoster(
    params.participantIndices,
    'DKG',
    CourtDkgTransitionError,
  );
  return {
    sessionHash: params.sessionHash,
    participantIndices: participants,
    deadline: params.deadline,
    phase: 'parameters_confirmed',
    round1Participants: [],
    round2Participants: [],
    transcriptCertifiers: [],
    backupVerified: false,
  };
}

export function reduceCourtDkgMachine(
  state: CourtDkgMachineState,
  event: CourtDkgMachineEvent,
): CourtDkgMachineState {
  if (event.type === 'tick') return expire(state, event.now);
  if (event.type === 'abort') {
    if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') {
      throw new CourtDkgTransitionError(`cannot abort DKG from ${state.phase}`);
    }
    // Only reducer-defined failure phases may be injected as aborts — a
    // caller cannot cast an arbitrary phase (e.g. 'certified') into state.
    if (!ABORT_PHASES.has(event.phase)) {
      throw new CourtDkgTransitionError(`invalid DKG abort phase: ${String(event.phase)}`);
    }
    // Ensure the caller cannot forge a peer-blame by supplying an unverified
    // blamedIdx — the index must be a valid roster participant.
    assertBlamedIdx(event.blamedIdx, state.participantIndices, 'participant', CourtDkgTransitionError);
    return {
      ...state,
      phase: event.phase,
      failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
    };
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtDkgTransitionError(`cannot process ${event.type} after ${state.phase}`);
  }

  if (event.type === 'start') {
    assertBeforeDeadline(state, event.now);
    if (state.phase !== 'parameters_confirmed') {
      throw new CourtDkgTransitionError(`cannot start DKG from ${state.phase}`);
    }
    return { ...state, phase: 'dkg_round_1' };
  }

  if (event.type === 'accept_round_1') {
    assertBeforeDeadline(state, event.now);
    assertParticipant(state, event.idx);
    if (state.phase !== 'dkg_round_1') {
      throw new CourtDkgTransitionError(`cannot accept round 1 data during ${state.phase}`);
    }
    const accepted = addSorted(state.round1Participants, event.idx);
    return {
      ...state,
      round1Participants: accepted,
      phase: accepted.length === state.participantIndices.length ? 'dkg_round_2' : state.phase,
    };
  }

  if (event.type === 'accept_round_2') {
    assertBeforeDeadline(state, event.now);
    assertParticipant(state, event.idx);
    if (state.phase !== 'dkg_round_2') {
      throw new CourtDkgTransitionError(`cannot accept round 2 data during ${state.phase}`);
    }
    return { ...state, round2Participants: addSorted(state.round2Participants, event.idx) };
  }

  if (event.type === 'finalize_transcript') {
    assertBeforeDeadline(state, event.now);
    if (
      state.phase !== 'dkg_round_2'
      || state.round2Participants.length !== state.participantIndices.length
    ) {
      throw new CourtDkgTransitionError('cannot finalize before every participant completes round 2');
    }
    if (
      typeof event.transcriptHash !== 'string'
      || typeof event.candidateGroupPubkey !== 'string'
      || !HEX_32.test(event.transcriptHash)
      || !GROUP_KEY.test(event.candidateGroupPubkey)
    ) {
      throw new CourtDkgTransitionError('transcript hash or candidate group key has invalid encoding');
    }
    return {
      ...state,
      phase: 'transcript_signing',
      transcriptHash: event.transcriptHash,
      candidateGroupPubkey: event.candidateGroupPubkey,
    };
  }

  if (event.type === 'accept_certification') {
    assertBeforeDeadline(state, event.now);
    assertParticipant(state, event.idx);
    if (state.phase !== 'transcript_signing' || !state.transcriptHash || !state.candidateGroupPubkey) {
      throw new CourtDkgTransitionError(`cannot certify transcript during ${state.phase}`);
    }
    if (event.transcriptHash !== state.transcriptHash) {
      return {
        ...state,
        phase: 'aborted_peer',
        failure: {
          phase: 'aborted_peer',
          blamedIdx: event.idx,
          reason: 'A participant certified a different DKG transcript.',
        },
      };
    }
    const certifiers = addSorted(state.transcriptCertifiers, event.idx);
    if (certifiers.length !== state.participantIndices.length) {
      return { ...state, transcriptCertifiers: certifiers };
    }
    return {
      ...state,
      phase: 'certified',
      transcriptCertifiers: certifiers,
      certifiedGroupPubkey: state.candidateGroupPubkey,
    };
  }

  if (event.type === 'confirm_backup') {
    // Backup confirmation is a LOCAL event (the juror validated its own
    // recovery data), not a peer message, so it is not bounded by the
    // ceremony deadline. A certified machine must never be stranded: without
    // this, a certification at the deadline could never reach `backed_up`
    // and was frozen in `certified` forever.
    assertNow(event.now, CourtDkgTransitionError);
    if (state.phase !== 'certified' || !state.certifiedGroupPubkey) {
      throw new CourtDkgTransitionError('cannot confirm recovery data before DKG certification');
    }
    return { ...state, phase: 'backed_up', backupVerified: true };
  }

  return state;
}
