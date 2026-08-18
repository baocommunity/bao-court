// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Pure fail-closed state machine for one BAO Court voting ceremony.
 *
 * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
 * tally_final. The allowed outcome set is frozen at creation, each roster
 * participant may commit exactly once, a reveal must match that participant's
 * exact session-bound commit, and the tally input is the deterministic set of
 * valid reveals at the close boundary.
 *
 * This module performs no network or Nostr signature verification; the event
 * boundary must authenticate authors and roster indices before dispatching
 * events into the reducer.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CanonicalWriter } from './courtSession';

export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';

export type CourtVotePhase =
  | 'commit_open'
  | 'commit_closed'
  | 'reveal_open'
  | 'reveal_closed'
  | 'tally_final'
  | 'expired'
  | 'aborted';

export interface CourtVoteFailure {
  readonly phase: 'expired' | 'aborted';
  readonly reason: string;
}

export interface CourtVoteCommitRecord {
  readonly idx: number;
  readonly commitHash: string;
  readonly eventId: string;
}

export interface CourtVoteRevealRecord {
  readonly idx: number;
  readonly outcome: string;
  readonly salt: string;
  readonly eventId: string;
}

export interface CourtVerdict {
  readonly outcome: string;
  /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
  readonly supportingEventIds: readonly string[];
  readonly verdictHash: string;
}

export interface CourtVoteMachineState {
  readonly sessionHash: string;
  readonly participantIndices: readonly number[];
  readonly allowedOutcomes: readonly string[];
  readonly commitDeadline: number;
  readonly revealDeadline: number;
  readonly phase: CourtVotePhase;
  readonly commits: readonly CourtVoteCommitRecord[];
  readonly reveals: readonly CourtVoteRevealRecord[];
  readonly verdict?: CourtVerdict;
  readonly failure?: CourtVoteFailure;
}

export type CourtVoteMachineEvent =
  | {
      readonly type: 'accept_commit';
      readonly idx: number;
      readonly commitHash: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_commits'; readonly now: number }
  | { readonly type: 'open_reveals'; readonly now: number }
  | {
      readonly type: 'accept_reveal';
      readonly idx: number;
      readonly outcome: string;
      readonly salt: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_reveals'; readonly now: number }
  | { readonly type: 'finalize_tally'; readonly now: number }
  | { readonly type: 'tick'; readonly now: number }
  | { readonly type: 'abort'; readonly reason: string };

export class CourtVoteTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourtVoteTransitionError';
  }
}

const textEncoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const MAX_OUTCOMES = 256;
const MAX_OUTCOME_BYTES = 256;

const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);

/**
 * Canonical session-bound vote commitment hash.
 *
 * Binding the session hash into every commit makes votes unreplayable across
 * disputes, attempts, and crypto suites. The encoding is length-prefixed so
 * outcome/salt boundaries can never be ambiguous.
 */
export function hashCourtVoteCommit(params: {
  readonly sessionHash: string;
  readonly outcome: string;
  readonly salt: string;
}): string {
  const writer = new CanonicalWriter();
  writer.hex(params.sessionHash);
  writer.text(params.outcome);
  writer.hex(params.salt);
  return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
}

/**
 * Canonical verdict hash binding the session, the winning outcome, and the
 * exact supporting reveal event ids.
 */
export function hashCourtVerdict(params: {
  readonly sessionHash: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
}): string {
  const writer = new CanonicalWriter();
  writer.hex(params.sessionHash);
  writer.text(params.outcome);
  writer.u32(params.supportingEventIds.length);
  for (const eventId of params.supportingEventIds) {
    writer.hex(eventId);
  }
  return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
}

function digestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = textEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/**
 * Canonical dispute verdict commitment — the statement a kind-39007
 * attestation binds into its signed message.
 *
 * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
 * over canonical length-prefixed fields. Order-independent (event ids are
 * sorted before hashing) and unambiguous, so every juror, coordinator, and
 * observer derives the same commitment from the same public vote ledger. Any
 * observer can recompute it from the attestation's supporting `e` tags and
 * verify the court really attested the tally winner.
 */
export function hashDisputeVerdict(params: {
  readonly disputeId: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
}): string {
  const writer = new CanonicalWriter();
  writer.hex(params.disputeId);
  writer.text(params.outcome);
  const sorted = [...params.supportingEventIds].sort();
  writer.u32(sorted.length);
  for (const id of sorted) {
    writer.hex(id);
  }
  return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
  }
}

function assertParticipant(state: CourtVoteMachineState, idx: number): void {
  if (!state.participantIndices.includes(idx)) {
    throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
  }
}

function assertBeforeDeadline(now: number, deadline: number, message: string): void {
  assertNow(now);
  if (now >= deadline) {
    throw new CourtVoteTransitionError(message);
  }
}

export function createCourtVoteMachine(params: {
  readonly sessionHash: string;
  readonly participantIndices: readonly number[];
  readonly allowedOutcomes: readonly string[];
  readonly commitDeadline: number;
  readonly revealDeadline: number;
}): CourtVoteMachineState {
  if (!HEX_32.test(params.sessionHash)) {
    throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
  }
  if (params.participantIndices.length === 0) {
    throw new CourtVoteTransitionError('voting requires at least one participant');
  }
  const participants = [...params.participantIndices];
  participants.forEach((idx, offset) => {
    if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
      throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
    }
  });
  if (
    !Array.isArray(params.allowedOutcomes) ||
    params.allowedOutcomes.length < 2 ||
    params.allowedOutcomes.length > MAX_OUTCOMES
  ) {
    throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
  }
  const outcomes = [...params.allowedOutcomes];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (
      typeof outcome !== 'string' ||
      outcome.length === 0 ||
      textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
    ) {
      throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
    }
    if (seen.has(outcome)) {
      throw new CourtVoteTransitionError('allowed outcomes must be unique');
    }
    seen.add(outcome);
  }
  if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
    throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
  }
  if (
    !Number.isSafeInteger(params.revealDeadline) ||
    params.revealDeadline <= params.commitDeadline
  ) {
    throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
  }
  return {
    sessionHash: params.sessionHash,
    participantIndices: participants,
    allowedOutcomes: outcomes,
    commitDeadline: params.commitDeadline,
    revealDeadline: params.revealDeadline,
    phase: 'commit_open',
    commits: [],
    reveals: [],
  };
}

export function reduceCourtVoteMachine(
  state: CourtVoteMachineState,
  event: CourtVoteMachineEvent,
): CourtVoteMachineState {
  if (event.type === 'tick') {
    assertNow(event.now);
    // `reveal_closed` means close_reveals already ran at/after the deadline and
    // finalize_tally remains legal afterwards — a clock tick must not expire a
    // ceremony that is one step from finalization (mirrors the DKG machine's
    // exemption of its post-deadline `certified` phase).
    if (
      TERMINAL_PHASES.has(state.phase)
      || state.phase === 'reveal_closed'
      || event.now < state.revealDeadline
    ) {
      return state;
    }
    return {
      ...state,
      phase: 'expired',
      failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
    };
  }
  if (event.type === 'abort') {
    if (TERMINAL_PHASES.has(state.phase)) {
      throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
    }
    return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
  }

  if (event.type === 'accept_commit') {
    assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
    assertParticipant(state, event.idx);
    if (state.phase !== 'commit_open') {
      throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
    }
    if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
      throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
    }
    const existing = state.commits.find((c) => c.idx === event.idx);
    if (existing) {
      if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
        return state;
      }
      throw new CourtVoteTransitionError(
        `participant ${event.idx} published a conflicting vote commit`,
      );
    }
    return {
      ...state,
      commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
    };
  }

  if (event.type === 'close_commits') {
    assertNow(event.now);
    if (state.phase !== 'commit_open') {
      throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
    }
    if (event.now < state.commitDeadline) {
      throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
    }
    return { ...state, phase: 'commit_closed' };
  }

  if (event.type === 'open_reveals') {
    assertNow(event.now);
    if (state.phase !== 'commit_closed') {
      throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
    }
    return { ...state, phase: 'reveal_open' };
  }

  if (event.type === 'accept_reveal') {
    assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
    assertParticipant(state, event.idx);
    if (state.phase !== 'reveal_open') {
      throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
    }
    if (!state.allowedOutcomes.includes(event.outcome)) {
      throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
    }
    if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
      throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
    }
    const commit = state.commits.find((c) => c.idx === event.idx);
    if (!commit) {
      throw new CourtVoteTransitionError(
        `participant ${event.idx} revealed without a prior session commit`,
      );
    }
    const expected = hashCourtVoteCommit({
      sessionHash: state.sessionHash,
      outcome: event.outcome,
      salt: event.salt,
    });
    if (expected !== commit.commitHash) {
      throw new CourtVoteTransitionError(
        `vote reveal from participant ${event.idx} does not match its commit`,
      );
    }
    const existing = state.reveals.find((r) => r.idx === event.idx);
    if (existing) {
      if (
        existing.outcome === event.outcome &&
        existing.salt === event.salt &&
        existing.eventId === event.eventId
      ) {
        return state;
      }
      throw new CourtVoteTransitionError(
        `participant ${event.idx} published a conflicting vote reveal`,
      );
    }
    return {
      ...state,
      reveals: [
        ...state.reveals,
        { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
      ],
    };
  }

  if (event.type === 'close_reveals') {
    assertNow(event.now);
    if (state.phase !== 'reveal_open') {
      throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
    }
    if (event.now < state.revealDeadline) {
      throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
    }
    return { ...state, phase: 'reveal_closed' };
  }

  if (event.type === 'finalize_tally') {
    assertNow(event.now);
    if (state.phase !== 'reveal_closed') {
      throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
    }
    if (state.reveals.length === 0) {
      throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
    }
    const counts = new Map<string, string[]>();
    for (const reveal of state.reveals) {
      const list = counts.get(reveal.outcome) ?? [];
      list.push(reveal.eventId);
      counts.set(reveal.outcome, list);
    }
    let winner = '';
    let winnerCount = -1;
    for (const [outcome, eventIds] of counts.entries()) {
      if (
        eventIds.length > winnerCount ||
        (eventIds.length === winnerCount && outcome < winner)
      ) {
        winner = outcome;
        winnerCount = eventIds.length;
      }
    }
    const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
    const verdict: CourtVerdict = {
      outcome: winner,
      supportingEventIds,
      verdictHash: hashCourtVerdict({
        sessionHash: state.sessionHash,
        outcome: winner,
        supportingEventIds,
      }),
    };
    return { ...state, phase: 'tally_final', verdict };
  }

  return state;
}
