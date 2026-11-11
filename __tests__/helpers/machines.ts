// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Create+drive helpers for the three pure ceremony state machines.
 *
 * The machine factories (`createCourtVoteMachine` /
 * `createCourtConfirmationMachine`) take a dozen fields; scenario steppers
 * ("drive to `fee_settlement` with a NO challenge", "close reveals with this
 * outcome split") are 15–40 lines each. Before this module, EVERY suite that
 * touched a machine hand-rolled its own factory + steppers — five copies of
 * "build a vote machine", six of "build a confirmation machine" — with
 * drifting deadlines and event-id conventions. These helpers are the single
 * set; the defaults follow the adversarialMachines convention.
 *
 * determinism: every helper is clock-literal (fixed `now` values, never
 * `Date.now()`) and key-free — see docs/TESTING_GUIDE.md ("Determinism
 * rules").
 */
import {
  createCourtVoteMachine,
  hashCourtVoteCommit,
  reduceCourtVoteMachine,
  type CourtVoteMachineState,
} from '../../courtVoteMachine';
import {
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../../courtConfirmationMachine';
import {
  createCourtSigningMachine,
  type CourtSigningMachineState,
} from '../../courtSigningMachine';
import {
  createCourtDkgMachine,
  type CourtDkgMachineState,
} from '../../courtDkgMachine';
import { padHexId, hexId } from './ids';

// ---------------------------------------------------------------------------
// Vote machine
// ---------------------------------------------------------------------------

export interface VoteMachineOpts {
  readonly sessionHash?: string;
  readonly participantIndices?: readonly number[];
  readonly allowedOutcomes?: readonly string[];
  readonly commitDeadline?: number;
  readonly revealDeadline?: number;
}

export const VOTE_DEFAULTS = {
  sessionHash: '11'.repeat(32),
  participantIndices: [1, 2, 3],
  allowedOutcomes: ['YES', 'NO'],
  commitDeadline: 100,
  revealDeadline: 200,
} as const;

export const VOTE_SALT = 'aa'.repeat(32);

/** Create a vote machine with house defaults (override any field). */
export function voteMachine(opts: VoteMachineOpts = {}): CourtVoteMachineState {
  return createCourtVoteMachine({
    sessionHash: opts.sessionHash ?? VOTE_DEFAULTS.sessionHash,
    participantIndices: [...(opts.participantIndices ?? VOTE_DEFAULTS.participantIndices)],
    allowedOutcomes: [...(opts.allowedOutcomes ?? VOTE_DEFAULTS.allowedOutcomes)],
    commitDeadline: opts.commitDeadline ?? VOTE_DEFAULTS.commitDeadline,
    revealDeadline: opts.revealDeadline ?? VOTE_DEFAULTS.revealDeadline,
  });
}

/** An `accept_commit` event: session-bound commit hash, house event-id/now conventions. */
export function voteCommitEvent(
  idx: number,
  outcome: string,
  opts: { readonly salt?: string; readonly eventId?: string; readonly now?: number; readonly sessionHash?: string } = {},
) {
  const sessionHash = opts.sessionHash ?? VOTE_DEFAULTS.sessionHash;
  return {
    type: 'accept_commit' as const,
    idx,
    commitHash: hashCourtVoteCommit({
      sessionHash,
      outcome,
      salt: opts.salt ?? VOTE_SALT,
    }),
    eventId: opts.eventId ?? padHexId(`c${idx}0`),
    now: opts.now ?? 10 + idx,
  };
}

/** An `accept_reveal` event matching `voteCommitEvent` (same salt/event-id conventions). */
export function voteRevealEvent(
  idx: number,
  outcome: string,
  opts: { readonly salt?: string; readonly eventId?: string; readonly now?: number } = {},
) {
  return {
    type: 'accept_reveal' as const,
    idx,
    outcome,
    salt: opts.salt ?? VOTE_SALT,
    eventId: opts.eventId ?? padHexId(`a${idx}0`),
    now: opts.now ?? 150 + idx,
  };
}

/** Drive from `commit_open` to `reveal_open` (close_commits + open_reveals). */
export function voteToRevealsOpen(
  state: CourtVoteMachineState,
  opts: { readonly commitDeadline?: number } = {},
): CourtVoteMachineState {
  const commitDeadline = opts.commitDeadline ?? VOTE_DEFAULTS.commitDeadline;
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: commitDeadline });
  return reduceCourtVoteMachine(state, { type: 'open_reveals', now: commitDeadline + 1 });
}

/** Commit+reveal one event per outcome, ending just after `close_reveals`. */
export function voteClosedReveals(
  outcomes: readonly string[],
  opts: Omit<VoteMachineOpts, 'allowedOutcomes'> = {},
): CourtVoteMachineState {
  let state = voteMachine({
    ...opts,
    allowedOutcomes: ['YES', 'NO', ...outcomes.filter((o) => o !== 'YES' && o !== 'NO')],
  });
  outcomes.forEach((outcome, offset) => {
    state = reduceCourtVoteMachine(state, voteCommitEvent(offset + 1, outcome));
  });
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: VOTE_DEFAULTS.commitDeadline });
  state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: VOTE_DEFAULTS.commitDeadline + 1 });
  outcomes.forEach((outcome, offset) => {
    state = reduceCourtVoteMachine(state, voteRevealEvent(offset + 1, outcome));
  });
  return reduceCourtVoteMachine(state, { type: 'close_reveals', now: VOTE_DEFAULTS.revealDeadline });
}

// ---------------------------------------------------------------------------
// Confirmation machine
// ---------------------------------------------------------------------------

export interface ConfirmationMachineOpts {
  readonly sessionHash?: string;
  readonly proposalHash?: string;
  readonly proposedOutcome?: string;
  readonly allowedOutcomes?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly participantIndices?: readonly number[];
  readonly confirmQuorum?: number;
  readonly confirmDeadline?: number;
  readonly challengeDeadline?: number;
  readonly maxLadderRounds?: number;
}

export const CONFIRM_DEFAULTS = {
  sessionHash: '11'.repeat(32),
  proposalHash: '33'.repeat(32),
  proposedOutcome: 'YES',
  allowedOutcomes: ['YES', 'NO'],
  participantIndices: [1, 2, 3],
  confirmQuorum: 1,
  confirmDeadline: 100,
  challengeDeadline: 200,
} as const;

/** Create a confirmation machine with house defaults (override any field). */
export function confirmationMachine(opts: ConfirmationMachineOpts = {}): CourtConfirmationMachineState {
  return createCourtConfirmationMachine({
    sessionHash: opts.sessionHash ?? CONFIRM_DEFAULTS.sessionHash,
    proposalHash: opts.proposalHash ?? CONFIRM_DEFAULTS.proposalHash,
    proposedOutcome: opts.proposedOutcome ?? CONFIRM_DEFAULTS.proposedOutcome,
    allowedOutcomes: [...(opts.allowedOutcomes ?? CONFIRM_DEFAULTS.allowedOutcomes)],
    ...(opts.evidenceIds !== undefined ? { evidenceIds: [...opts.evidenceIds] } : {}),
    participantIndices: [...(opts.participantIndices ?? CONFIRM_DEFAULTS.participantIndices)],
    confirmQuorum: opts.confirmQuorum ?? CONFIRM_DEFAULTS.confirmQuorum,
    confirmDeadline: opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline,
    challengeDeadline: opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline,
    ...(opts.maxLadderRounds !== undefined ? { maxLadderRounds: opts.maxLadderRounds } : {}),
  });
}

/** The canonical per-idx confirmation hash binding for a session/proposal pair. */
export function confirmHashFor(idx: number, sessionHash = CONFIRM_DEFAULTS.sessionHash, proposalHash = CONFIRM_DEFAULTS.proposalHash): string {
  return hashCourtConfirmation({ sessionHash, proposalHash, idx });
}

/** An `accept_confirmation` event with house event-id/now conventions. */
export function confirmationAcceptEvent(
  idx: number,
  opts: { readonly eventId?: string; readonly now?: number; readonly sessionHash?: string; readonly proposalHash?: string } = {},
) {
  return {
    type: 'accept_confirmation' as const,
    idx,
    confirmHash: confirmHashFor(idx, opts.sessionHash, opts.proposalHash),
    eventId: opts.eventId ?? hexId('a'),
    now: opts.now ?? 10,
  };
}

/** Drive to any `CourtConfirmationMachineState['phase']` (adversarialMachines ladder path). */
export function confirmationAt(phase: CourtConfirmationMachineState['phase']): CourtConfirmationMachineState {
  let state = confirmationMachine();
  if (phase === 'confirm_open') return state;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_confirmation', idx: 1, confirmHash: confirmHashFor(1), eventId: padHexId('f10'), now: 10,
  });
  if (phase === 'confirm_closed') {
    return reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 100 });
  }
  state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 100 });
  state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: 101 });
  if (phase === 'challenge_window') return state;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_challenge', idx: 2, bondTxid: '55'.repeat(32), bondProofHash: '66'.repeat(32), eventId: padHexId('f20'), now: 150,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 200 });
  if (phase === 'ladder_pending') return state;
  state = reduceCourtConfirmationMachine(state, { type: 'open_ladder_round', round: 1, voteDeadline: 400, now: 201 });
  if (phase === 'ladder_vote_open') return state;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: padHexId('f30'), now: 250,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 400 });
  if (phase === 'ladder_vote_closed') return state;
  state = reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: 401 });
  if (phase === 'round_resolved') return state;
  // Round 1 of a maxLadderRounds=2 case parks in round_resolved; reaching
  // fee_settlement requires the host's explicit concede (or escalate to
  // round 2 and resolve it).
  state = reduceCourtConfirmationMachine(state, { type: 'concede', now: 401 });
  if (phase === 'fee_settlement') return state;
  return reduceCourtConfirmationMachine(state, { type: 'finalize', now: 402 }); // final
}

/** Drive the no-challenge happy path up to `fee_settlement` (quorum-style machine). */
export function confirmHappyPath(opts: ConfirmationMachineOpts = {}): CourtConfirmationMachineState {
  const sessionHash = opts.sessionHash ?? CONFIRM_DEFAULTS.sessionHash;
  const proposalHash = opts.proposalHash ?? CONFIRM_DEFAULTS.proposalHash;
  let s = confirmationMachine(opts);
  for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash, proposalHash, idx }),
      eventId: hexId(ev),
      now: (opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline) - 1000 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: (opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline) + 100 });
  return reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline });
}

/** `accept_mass_vote` payload for a ladder round. */
export function massVote(idx: number, outcome: string, eventId: string, now: number) {
  return { type: 'accept_mass_vote' as const, idx, outcome, eventId, now };
}

/** Drive the challenge path up to `fee_settlement` with the given round-1 vote split. */
export function confirmChallengedTo(
  votes: ReadonlyArray<readonly [number, 'YES' | 'NO', string]>,
  opts: ConfirmationMachineOpts = {},
): CourtConfirmationMachineState {
  const sessionHash = opts.sessionHash ?? CONFIRM_DEFAULTS.sessionHash;
  const proposalHash = opts.proposalHash ?? CONFIRM_DEFAULTS.proposalHash;
  let s = confirmationMachine(opts);
  for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash, proposalHash, idx }),
      eventId: hexId(ev),
      now: (opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline) - 1000 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: (opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline) + 100 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: hexId('d'),
    bondProofHash: hexId('e'),
    eventId: hexId('f'),
    now: (opts.confirmDeadline ?? CONFIRM_DEFAULTS.confirmDeadline) + 500,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline });
  s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: (opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline) + 1000, now: (opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline) + 100 });
  for (const [idx, outcome, ev] of votes) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote',
      idx,
      outcome,
      eventId: hexId(ev),
      now: (opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline) + 200 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: (opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline) + 1000 });
  s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: (opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline) + 1100 });
  // Round 1 of a maxLadderRounds=2 case parks in round_resolved; the host
  // concedes to settle with the round outcome (multi-round ladder, 0.9).
  return reduceCourtConfirmationMachine(s, { type: 'concede', now: (opts.challengeDeadline ?? CONFIRM_DEFAULTS.challengeDeadline) + 1150 });
}

// ---------------------------------------------------------------------------
// Confirmation escalation witnesses (SPEC §9.2 / INV-ESC)
// ---------------------------------------------------------------------------

/** House challenger x-only pubkey for escalation witnesses. */
export const ESCALATION_PUBKEY = hexId('7');
/** House escalation-request hash. */
export const ESCALATION_REQUEST = hexId('8');

/**
 * A VALID challenger escalation for the state's next ladder round: derives
 * `roundIndex` and the bond witness from the state, so it is legal exactly when
 * the state is parked at `round_resolved` below the ladder cap. Override any
 * witness field to build a deliberately invalid one.
 */
export function escalateEvent(
  state: CourtConfirmationMachineState,
  now: number,
  overrides: Partial<{
    authority: 'challenger' | 'host';
    challengerIdx: number | null;
    challengerPubkey: string | null;
    requestHash: string | null;
    bondProofHash: string | null;
    roundIndex: number;
  }> = {},
) {
  const base = challengerEscalationEvent(state, now, {
    challengerPubkey: ESCALATION_PUBKEY,
    requestHash: ESCALATION_REQUEST,
  });
  return { ...base, ...overrides };
}

/** A syntactic `escalate` with NO authority witness (must be a typed error). */
export function unwitnessedEscalate(now: number) {
  return { type: 'escalate' as const, now } as unknown as CourtConfirmationMachineEvent;
}

// ---------------------------------------------------------------------------
// Signing / DKG machine factories
// ---------------------------------------------------------------------------

export interface SigningMachineOpts {
  readonly sessionHash?: string;
  readonly verdictHash?: string;
  readonly outcome?: string;
  readonly participantIndices?: readonly number[];
  readonly threshold?: number;
  readonly attempt?: number;
  readonly deadline?: number;
}

/** Create a signing machine with house defaults (override any field). */
export function signingMachine(opts: SigningMachineOpts = {}): CourtSigningMachineState {
  return createCourtSigningMachine({
    sessionHash: opts.sessionHash ?? CONFIRM_DEFAULTS.sessionHash,
    verdictHash: opts.verdictHash ?? CONFIRM_DEFAULTS.proposalHash,
    outcome: opts.outcome ?? 'yes',
    participantIndices: [...(opts.participantIndices ?? CONFIRM_DEFAULTS.participantIndices)],
    threshold: opts.threshold ?? 2,
    attempt: opts.attempt ?? 0,
    deadline: opts.deadline ?? 500,
  });
}

export interface DkgMachineOpts {
  readonly sessionHash?: string;
  readonly participantIndices?: readonly number[];
  readonly deadline?: number;
}

/** Create a DKG machine with house defaults (override any field). */
export function dkgMachine(opts: DkgMachineOpts = {}): CourtDkgMachineState {
  return createCourtDkgMachine({
    sessionHash: opts.sessionHash ?? CONFIRM_DEFAULTS.sessionHash,
    participantIndices: [...(opts.participantIndices ?? [1, 2])],
    deadline: opts.deadline ?? 1000,
  });
}

// ---------------------------------------------------------------------------
// Generic sequence driver
// ---------------------------------------------------------------------------

/** Dispatch a sequence, returning the final state (first throw propagates). */
export function drive<S, E>(
  state: S,
  events: readonly E[],
  reduce: (state: S, event: E) => S,
): S {
  let current = state;
  for (const event of events) current = reduce(current, event);
  return current;
}
