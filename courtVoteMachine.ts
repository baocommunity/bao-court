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
  /** Greatest caller-supplied timestamp accepted by the reducer. */
  readonly latestTimestamp: number;
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
const COURT_COMMIT_VERSION_BIT = 0x8;
const LEGACY_COMMIT_VERSION_MASK = 0x7;
const MAX_OUTCOMES = 256;
const MAX_PARTICIPANTS = 10_000;
const MAX_OUTCOME_BYTES = 256;
const MAX_REVEALS = 10_000;

const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);

/**
 * Protocol tie-break order: lexicographic unsigned UTF-8 byte order. This is
 * the canonical outcome serialization (CanonicalWriter.text), so the winner of
 * a tied count is defined identically across every implementation and runtime
 * — JavaScript's default `<` compares UTF-16 code units, which diverges from
 * UTF-8 byte order for supplementary-plane characters.
 */
export function compareOutcomeUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let i = 0; i < length; i += 1) {
    const difference = leftBytes[i] - rightBytes[i];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

/**
 * Canonical session-bound vote commitment hash.
 *
 * Binding the session hash into every commit makes votes unreplayable across
 * disputes, attempts, and crypto suites. The encoding is length-prefixed so
 * outcome/salt boundaries can never be ambiguous. Inputs are validated before
 * any encoding or hashing so a caller cannot allocate unbounded preimages or
 * commit to malformed (coercible) values.
 */
export function hashCourtVoteCommit(params: {
  readonly sessionHash: string;
  readonly outcome: string;
  readonly salt: string;
}): string {
  if (
    typeof params.sessionHash !== 'string'
    || params.sessionHash.length !== 64
    || !HEX_32.test(params.sessionHash)
  ) {
    throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
  }
  if (
    typeof params.outcome !== 'string'
    || params.outcome.length === 0
    || params.outcome.length > MAX_OUTCOME_BYTES
    || textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
  ) {
    throw new CourtVoteTransitionError('outcome must be a non-empty bounded string');
  }
  if (
    typeof params.salt !== 'string'
    || params.salt.length !== 64
    || !HEX_32.test(params.salt)
  ) {
    throw new CourtVoteTransitionError('salt must be 32-byte lowercase hex');
  }
  const writer = new CanonicalWriter();
  writer.hex(params.sessionHash);
  writer.text(params.outcome);
  writer.hex(params.salt);
  const digest = digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
  // Set the high nibble to distinguish from legacy sessionless commitments.
  return (Number.parseInt(digest[0], 16) | COURT_COMMIT_VERSION_BIT).toString(16) + digest.slice(1);
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
  if (
    typeof params.sessionHash !== 'string'
    || params.sessionHash.length !== 64
    || !HEX_32.test(params.sessionHash)
  ) {
    throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
  }
  if (
    typeof params.outcome !== 'string'
    || params.outcome.length === 0
    || params.outcome.length > MAX_OUTCOME_BYTES
    || textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
  ) {
    throw new CourtVoteTransitionError('outcome must be a non-empty bounded string');
  }
  if (!Array.isArray(params.supportingEventIds) || params.supportingEventIds.length === 0) {
    throw new CourtVoteTransitionError('supportingEventIds must contain at least one reveal event id');
  }
  for (const eventId of params.supportingEventIds) {
    if (typeof eventId !== 'string' || !HEX_32.test(eventId)) {
      throw new CourtVoteTransitionError('supporting event ids must be 32-byte lowercase hex');
    }
  }
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
 *
 * Inputs are validated to the reducer's canonical input language: a primitive
 * 32-byte lowercase hex dispute id, a non-empty bounded outcome, and at least
 * one canonical reveal event id. This prevents the exported helper from
 * producing signable hashes for malformed or evidence-free verdict tuples.
 */
export function hashDisputeVerdict(params: {
  readonly disputeId: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
}): string {
  if (
    typeof params.disputeId !== 'string'
    || params.disputeId.length !== 64
    || !HEX_32.test(params.disputeId)
  ) {
    throw new CourtVoteTransitionError('disputeId must be 32-byte lowercase hex');
  }
  if (
    typeof params.outcome !== 'string'
    || params.outcome.length === 0
    || params.outcome.length > MAX_OUTCOME_BYTES
    || textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
  ) {
    throw new CourtVoteTransitionError('outcome must be a non-empty bounded string');
  }
  if (!Array.isArray(params.supportingEventIds) || params.supportingEventIds.length === 0) {
    throw new CourtVoteTransitionError('supportingEventIds must contain at least one reveal event id');
  }
  for (const id of params.supportingEventIds) {
    if (typeof id !== 'string' || id.length !== 64 || !HEX_32.test(id)) {
      throw new CourtVoteTransitionError('supporting event ids must be 32-byte lowercase hex');
    }
  }

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

/**
 * Deep-freeze a vote-machine state so no holder of the returned reference can
 * mutate the frozen configuration, ledger records, verdict, or failure —
 * tampering with `allowedOutcomes` or `participantIndices` would otherwise let
 * a caller expand the ballot or admit non-roster votes between transitions.
 */
function freezeCourtVoteMachineState(state: CourtVoteMachineState): CourtVoteMachineState {
  for (const commit of state.commits) Object.freeze(commit);
  for (const reveal of state.reveals) Object.freeze(reveal);
  Object.freeze(state.participantIndices);
  Object.freeze(state.allowedOutcomes);
  Object.freeze(state.commits);
  Object.freeze(state.reveals);
  if (state.verdict) {
    Object.freeze(state.verdict.supportingEventIds);
    Object.freeze(state.verdict);
  }
  if (state.failure) Object.freeze(state.failure);
  return Object.freeze(state);
}

/**
 * Verify that the reveal ledger is internally consistent: each reveal
 * identifies a roster participant, names a valid outcome, carries a well-
 * formed primitive salt / event id, has a unique index and event id, and
 * matches its prior session-bound commit. Used as a barrier before
 * close_reveals and finalize_tally so that any tampered (or hand-restored)
 * ledger is caught before the verdict is locked in.
 */
function assertValidRevealLedger(state: CourtVoteMachineState): void {
  if (!Array.isArray(state.commits) || !Array.isArray(state.reveals)) {
    throw new CourtVoteTransitionError('vote state ledgers must be arrays');
  }
  const seenIndices = new Set<number>();
  const seenEventIds = new Set<string>();
  for (const reveal of state.reveals) {
    if (typeof reveal !== 'object' || reveal === null) {
      throw new CourtVoteTransitionError('vote state contains a malformed reveal record');
    }
    assertParticipant(state, reveal.idx);
    if (typeof reveal.outcome !== 'string' || !state.allowedOutcomes.includes(reveal.outcome)) {
      throw new CourtVoteTransitionError(
        'vote reveal names an outcome outside the frozen allowlist',
      );
    }
    if (
      typeof reveal.salt !== 'string'
      || typeof reveal.eventId !== 'string'
      || !HEX_32.test(reveal.salt)
      || !HEX_32.test(reveal.eventId)
    ) {
      throw new CourtVoteTransitionError(
        'vote reveal salt and event id must be 32-byte lowercase hex',
      );
    }
    if (seenIndices.has(reveal.idx)) {
      throw new CourtVoteTransitionError(
        `participant ${reveal.idx} has duplicate vote reveals`,
      );
    }
    if (seenEventIds.has(reveal.eventId)) {
      throw new CourtVoteTransitionError('vote reveal event ids must be unique');
    }
    seenIndices.add(reveal.idx);
    seenEventIds.add(reveal.eventId);
    const commit = state.commits.find((c) => c.idx === reveal.idx);
    if (!commit) {
      throw new CourtVoteTransitionError(
        `participant ${reveal.idx} revealed without a prior session commit`,
      );
    }
    const expected = hashCourtVoteCommit({
      sessionHash: state.sessionHash,
      outcome: reveal.outcome,
      salt: reveal.salt,
    });
    if (expected !== commit.commitHash) {
      throw new CourtVoteTransitionError(
        `vote reveal from participant ${reveal.idx} does not match its commit`,
      );
    }
  }
}

export function createCourtVoteMachine(params: {
  readonly sessionHash: string;
  readonly participantIndices: readonly number[];
  readonly allowedOutcomes: readonly string[];
  readonly commitDeadline: number;
  readonly revealDeadline: number;
}): CourtVoteMachineState {
  if (typeof params.sessionHash !== 'string' || !HEX_32.test(params.sessionHash)) {
    throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
  }
  if (params.participantIndices.length === 0) {
    throw new CourtVoteTransitionError('voting requires at least one participant');
  }
  if (params.participantIndices.length > MAX_PARTICIPANTS) {
    throw new CourtVoteTransitionError(
      'participantIndices length exceeds maximum of ' + MAX_PARTICIPANTS,
    );
  }
  const participants = [...params.participantIndices];
  participants.forEach((idx, offset) => {
    if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
      throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
    }
  });
  if (
    !Array.isArray(params.allowedOutcomes) ||
    params.allowedOutcomes.length < 2
  ) {
    throw new CourtVoteTransitionError(
      `allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`,
    );
  }
  if (params.allowedOutcomes.length > MAX_OUTCOMES) {
    throw new CourtVoteTransitionError(
      `allowedOutcomes length ${params.allowedOutcomes.length} exceeds maximum of ${MAX_OUTCOMES}`,
    );
  }
  const outcomes = [...params.allowedOutcomes];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (
      typeof outcome !== 'string' ||
      outcome.length === 0
    ) {
      throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
    }
    const outcomeBytes = textEncoder.encode(outcome);
    if (outcomeBytes.length === 0 || outcomeBytes.length > MAX_OUTCOME_BYTES) {
      throw new CourtVoteTransitionError('allowed outcomes must be bounded strings');
    }
    // Reject outcomes with surrogate pairs or incomplete UTF-8 sequences.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(outcomeBytes);
    } catch {
      throw new CourtVoteTransitionError('allowed outcomes must be valid UTF-8');
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
  return freezeCourtVoteMachineState({
    sessionHash: params.sessionHash,
    participantIndices: participants,
    allowedOutcomes: outcomes,
    commitDeadline: params.commitDeadline,
    revealDeadline: params.revealDeadline,
    latestTimestamp: 0,
    phase: 'commit_open',
    commits: [],
    reveals: [],
  });
}

export function reduceCourtVoteMachine(
  state: CourtVoteMachineState,
  event: CourtVoteMachineEvent,
): CourtVoteMachineState {
  // Every time-bearing event must be monotonically non-decreasing: a caller
  // that restores or replays state cannot roll the clock back to re-admit
  // reveals after a later close, or hold the ceremony open past a deadline
  // that a later event already observed. `abort` carries no clock.
  if (event.type !== 'abort') {
    assertNow(event.now);
    if (event.now < state.latestTimestamp) {
      throw new CourtVoteTransitionError('now must not precede a previously observed timestamp');
    }
    state = { ...state, latestTimestamp: event.now };
  }

  if (event.type === 'tick') {
    // `reveal_closed` means close_reveals already ran at/after the deadline and
    // finalize_tally remains legal afterwards — a clock tick must not expire a
    // ceremony that is one step from finalization (mirrors the DKG machine's
    // exemption of its post-deadline `certified` phase).
    if (
      TERMINAL_PHASES.has(state.phase)
      || state.phase === 'reveal_closed'
      || event.now < state.revealDeadline
    ) {
      return freezeCourtVoteMachineState(state);
    }
    return freezeCourtVoteMachineState({
      ...state,
      phase: 'expired',
      failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
    });
  }
  if (event.type === 'abort') {
    if (TERMINAL_PHASES.has(state.phase)) {
      throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
    }
    return freezeCourtVoteMachineState({
      ...state,
      phase: 'aborted',
      failure: { phase: 'aborted', reason: event.reason },
    });
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
    if (
      typeof event.commitHash !== 'string'
      || typeof event.eventId !== 'string'
      || !HEX_32.test(event.commitHash)
      || !HEX_32.test(event.eventId)
    ) {
      throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
    }
    // Reject legacy sessionless format commits — they use a different domain
    // and can never match a reveal against this session-bound verifier.
    if ((Number.parseInt(event.commitHash[0], 16) & COURT_COMMIT_VERSION_BIT) === 0) {
      throw new CourtVoteTransitionError(
        'vote commit uses a legacy sessionless format',
      );
    }
    const existing = state.commits.find((c) => c.idx === event.idx);
    if (existing) {
      if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
        return freezeCourtVoteMachineState(state);
      }
      throw new CourtVoteTransitionError(
        `participant ${event.idx} published a conflicting vote commit`,
      );
    }
    return freezeCourtVoteMachineState({
      ...state,
      commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
    });
  }

  if (event.type === 'close_commits') {
    if (state.phase !== 'commit_open') {
      throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
    }
    if (event.now < state.commitDeadline) {
      throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
    }
    return freezeCourtVoteMachineState({ ...state, phase: 'commit_closed' });
  }

  if (event.type === 'open_reveals') {
    assertBeforeDeadline(event.now, state.revealDeadline, 'cannot open vote reveals at or after the reveal deadline');
    if (state.phase !== 'commit_closed') {
      throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
    }
    return freezeCourtVoteMachineState({ ...state, phase: 'reveal_open' });
  }

  if (event.type === 'accept_reveal') {
    assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
    assertParticipant(state, event.idx);
    if (state.phase !== 'reveal_open') {
      throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
    }
    if (state.reveals.length >= MAX_REVEALS) {
      throw new CourtVoteTransitionError(
        `reveal ledger exceeds maximum of ${MAX_REVEALS} entries`,
      );
    }
    if (typeof event.outcome !== 'string' || !state.allowedOutcomes.includes(event.outcome)) {
      throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
    }
    if (
      typeof event.salt !== 'string'
      || typeof event.eventId !== 'string'
      || !HEX_32.test(event.salt)
      || !HEX_32.test(event.eventId)
    ) {
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
        return freezeCourtVoteMachineState(state);
      }
      throw new CourtVoteTransitionError(
        `participant ${event.idx} published a conflicting vote reveal`,
      );
    }
    return freezeCourtVoteMachineState({
      ...state,
      reveals: [
        ...state.reveals,
        { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
      ],
    });
  }

  if (event.type === 'close_reveals') {
    if (state.phase !== 'reveal_open') {
      throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
    }
    if (event.now < state.revealDeadline) {
      throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
    }
    // Validate the reveal ledger before freezing it so no caller can tamper
    // with the verified reveal set before finalization.
    assertValidRevealLedger(state);
    return freezeCourtVoteMachineState({ ...state, phase: 'reveal_closed' });
  }

  if (event.type === 'finalize_tally') {
    if (state.phase !== 'reveal_closed') {
      throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
    }
    // Re-verify the frozen ledger — if finalize_tally is called on a
    // corrupted machine (e.g. via unsafe spread of an older state), this
    // catches it before the verdict is committed.
    assertValidRevealLedger(state);
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
        (eventIds.length === winnerCount && compareOutcomeUtf8(outcome, winner) < 0)
      ) {
        winner = outcome;
        winnerCount = eventIds.length;
      }
    }
    // Canonical sort: lowercase the event IDs before sorting so that
    // casing differences don't produce different verdicts.
    const supportingEventIds = [...(counts.get(winner) ?? [])].map(
      (id) => id.toLowerCase(),
    );
    supportingEventIds.sort();
    const verdict: CourtVerdict = {
      outcome: winner,
      supportingEventIds,
      verdictHash: hashCourtVerdict({
        sessionHash: state.sessionHash,
        outcome: winner,
        supportingEventIds,
      }),
    };
    return freezeCourtVoteMachineState({ ...state, phase: 'tally_final', verdict });
  }

  return state;
}
