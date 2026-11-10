// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { CourtError, CourtErrorOptions } from './errors';
import {
  HEX_32,
  assertBeforeDeadline as assertBeforeDeadlineCore,
  assertBlamedIdx,
  assertNow,
  assertPositiveDeadline,
  assertRosterMember,
  assertStateArrays,
  isCanonicalUtf8Text,
  normalizeCeremonyRoster,
} from './courtCeremonyCore';

/**
 * Pure fail-closed state machine for one BAO Court FROST signing attempt.
 *
 * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
 * aggregate -> attestation_published.
 *
 * The signing-session hash binds the Court session hash, the frozen verdict
 * hash, the exact outcome, the signing attempt, the threshold, and the signer
 * set. Changing any bound field requires a new machine for a new attempt and
 * invalidates every prior nonce commitment. Each roster signer may publish
 * exactly one nonce commitment per attempt; a conflicting second commitment
 * is nonce equivocation and aborts the attempt with blame.
 *
 * This module performs no FROST cryptographic verification; the boundary must
 * verify partial signatures against the certified verification shares and the
 * finalized commitment set before dispatching events into the reducer.
 *
 * Pipeline role: final stage of the dispute pipeline (paper §5, ceremony
 * tail) — turns a frozen verdict hash into a published kind-39007
 * attestation via one FROST signing attempt (paper §2 for the FROST
 * round structure).
 *
 * Purity: factory and reducer are pure functions of (state, event) with an
 * injected clock (`now` on each event); no I/O, no randomness, no wall
 * clock. All hash inputs go through `CanonicalWriter`.
 *
 * Invariants: INV-SIGN-1 … INV-SIGN-15 in docs/FORMAL_INVARIANTS.md §6,
 * including the A-1 signer-set contract and the F-12 monotonic clock
 * ledger; verified by exhaustive model checking
 * (`__tests__/modelChecking.test.ts`).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isValidSecp256k1Point } from './crypto';
import { CanonicalWriter } from './courtSession';

/**
 * Domain string for canonical signing-session hashes (session + verdict +
 * outcome + attempt + threshold + signer set).
 */
export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';

/**
 * Phases of one FROST signing attempt: `intent` → `nonce_commit` →
 * `commitment_set_final` → `partial_sign` → `aggregate` →
 * `attestation_published`, with terminal-failure phases `expired`,
 * `aborted_peer` (equivocation/blame), `aborted_coordinator`, and
 * `aborted_network`.
 */
export type CourtSigningPhase =
  | 'intent'
  | 'nonce_commit'
  | 'commitment_set_final'
  | 'partial_sign'
  | 'aggregate'
  | 'attestation_published'
  | 'expired'
  | 'aborted_peer'
  | 'aborted_coordinator'
  | 'aborted_network';

/**
 * The abort-family phases: which party caused the abort (a signer/peer, the
 * coordinator, or the network layer).
 */
export type CourtSigningFailurePhase = Extract<
  CourtSigningPhase,
  'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
>;

/**
 * Terminal failure of a signing attempt: deadline expiry or one of the
 * abort phases, a human-readable reason, and optionally the blamed roster
 * index (nonce equivocation, invalid partial).
 */
export interface CourtSigningFailure {
  readonly phase: CourtSigningFailurePhase | 'expired';
  readonly reason: string;
  readonly blamedIdx?: number;
}

export interface CourtSigningCommitmentRecord {
  readonly idx: number;
  readonly binderPn: string;
  readonly hiddenPn: string;
}

export interface CourtSigningPartialRecord {
  readonly idx: number;
  readonly psig: string;
}

/** One accepted nonce commitment: roster index + binder/hidden public nonces. */
export interface CourtSigningCommitmentRecord {
  readonly idx: number;
  readonly binderPn: string;
  readonly hiddenPn: string;
}

/** One accepted partial signature: roster index + hex partial sig. */
export interface CourtSigningPartialRecord {
  readonly idx: number;
  readonly psig: string;
}

/**
 * Immutable state of one FROST signing attempt. Deep-frozen by factory and
 * reducer; `latestTimestamp` is the monotonic-clock ledger (INV-SIGN/F-12);
 * `finalizedSignerSet` is the frozen sorted signer set whose commitments
 * define the signing context (A-1).
 */
export interface CourtSigningMachineState {
  readonly signingSessionHash: string;
  readonly sessionHash: string;
  readonly verdictHash: string;
  readonly outcome: string;
  readonly participantIndices: readonly number[];
  readonly threshold: number;
  readonly attempt: number;
  readonly deadline: number;
  /** Greatest caller-supplied timestamp accepted by the reducer. */
  readonly latestTimestamp: number;
  readonly phase: CourtSigningPhase;
  readonly commitments: readonly CourtSigningCommitmentRecord[];
  /** Frozen, sorted signer set whose commitments define the signing context. */
  readonly finalizedSignerSet?: readonly number[];
  readonly partials: readonly CourtSigningPartialRecord[];
  readonly signature?: string;
  readonly attestationEventId?: string;
  readonly failure?: CourtSigningFailure;
}

/**
 * Input events for the signing reducer: `start`, `accept_commitment`,
 * `close_commitments`, `accept_partial`, `aggregate`, `publish`, `tick`,
 * and `abort` (with failure phase, reason, and optional blamed index). Every
 * time-bearing event carries its own `now` (injected clock).
 */
export type CourtSigningMachineEvent =
  | { readonly type: 'start'; readonly now: number }
  | {
      readonly type: 'accept_commitment';
      readonly idx: number;
      readonly binderPn: string;
      readonly hiddenPn: string;
      readonly now: number;
    }
  | { readonly type: 'close_commitments'; readonly now: number }
  | {
      readonly type: 'accept_partial';
      readonly idx: number;
      readonly psig: string;
      readonly now: number;
    }
  | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
  | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
  | { readonly type: 'tick'; readonly now: number }
  | {
      readonly type: 'abort';
      readonly phase: CourtSigningFailurePhase;
      readonly reason: string;
      readonly blamedIdx?: number;
    };

/**
 * Error thrown for any illegal signing-machine transition or malformed
 * input. Code: `SIGNING_TRANSITION` (docs/FORMAL_INVARIANTS.md §15).
 */
export class CourtSigningTransitionError extends CourtError {
  constructor(message: string, options?: CourtErrorOptions) {
    super('SIGNING_TRANSITION', message, options);
  }
}

const textEncoder = new TextEncoder();
const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
const MAX_PARTIAL_SIGNATURES = 10_000;
const MAX_OUTCOME_BYTES = 256;

const ABORT_PHASES = new Set<CourtSigningPhase>([
  'aborted_peer',
  'aborted_coordinator',
  'aborted_network',
]);

const TERMINAL_PHASES = new Set<CourtSigningPhase>([
  'attestation_published',
  'expired',
  'aborted_peer',
  'aborted_coordinator',
  'aborted_network',
]);

/**
 * Freeze a signing-machine state so no holder of a returned reference can
 * mutate the frozen configuration, ledgers, or failure between transitions
 * (mirrors the vote machine's freeze discipline).
 */
function freezeCourtSigningMachineState(state: CourtSigningMachineState): CourtSigningMachineState {
  for (const commitment of state.commitments) Object.freeze(commitment);
  for (const partial of state.partials) Object.freeze(partial);
  Object.freeze(state.commitments);
  Object.freeze(state.partials);
  Object.freeze(state.participantIndices);
  if (state.finalizedSignerSet) Object.freeze(state.finalizedSignerSet);
  if (state.failure) Object.freeze(state.failure);
  return Object.freeze(state);
}

/**
 * Canonical hash binding every field that defines one signing attempt. A
 * FROST nonce commitment may be consumed only under exactly one such hash.
 */
export function hashCourtSigningSession(params: {
  readonly sessionHash: string;
  readonly verdictHash: string;
  readonly outcome: string;
  readonly participantIndices: readonly number[];
  readonly threshold: number;
  readonly attempt: number;
}): string {
  const writer = new CanonicalWriter();
  writer.hex(params.sessionHash);
  writer.hex(params.verdictHash);
  writer.text(params.outcome);
  writer.u32(params.participantIndices.length);
  for (const idx of params.participantIndices) {
    writer.u32(idx);
  }
  writer.u32(params.threshold);
  writer.u32(params.attempt);
  const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
  const encoded = writer.finish();
  const input = new Uint8Array(domain.length + encoded.length);
  input.set(domain, 0);
  input.set(encoded, domain.length);
  return bytesToHex(sha256(input));
}

function assertParticipant(state: CourtSigningMachineState, idx: number): void {
  assertRosterMember(state.participantIndices, idx, 'signer', CourtSigningTransitionError);
}

/**
 * Validate every persisted signing record at reducer entry so a restored or
 * tampered snapshot cannot bypass the distinct-signer thresholds: commitment
 * records must be canonical points from distinct roster signers, the finalized
 * signer set must exactly match the distinct sorted commitment indices, and
 * partial records must belong to that set with well-formed signatures. This
 * also fails closed (CourtSigningTransitionError) instead of crashing with a
 * TypeError on malformed array/record shapes.
 */
function assertSigningRecordInvariants(state: CourtSigningMachineState): void {
  if (!Array.isArray(state.commitments) || !Array.isArray(state.partials)) {
    throw new CourtSigningTransitionError('signing state ledgers must be arrays');
  }
  // Fail closed on a tampered roster before any roster-membership guard
  // dereferences it (an uncaught TypeError on `.includes`).
  assertStateArrays(
    state as unknown as Record<string, unknown>,
    ['participantIndices'],
    CourtSigningTransitionError,
  );
  // Re-derive the signing session hash from the persisted fields: a restored
  // or hand-tampered snapshot whose outcome, threshold, roster, or attempt
  // was edited without re-signing the binding is rejected before any
  // commitment or partial is accepted against it.
  let expectedSigningSessionHash: string;
  try {
    expectedSigningSessionHash = hashCourtSigningSession({
      sessionHash: state.sessionHash,
      verdictHash: state.verdictHash,
      outcome: state.outcome,
      participantIndices: state.participantIndices,
      threshold: state.threshold,
      attempt: state.attempt,
    });
  } catch {
    throw new CourtSigningTransitionError('signing state has malformed session-binding fields');
  }
  if (state.signingSessionHash !== expectedSigningSessionHash) {
    throw new CourtSigningTransitionError(
      'signing state does not match its signing session hash',
    );
  }
  const commitmentIndices = new Set<number>();
  for (const commitment of state.commitments) {
    if (typeof commitment !== 'object' || commitment === null) {
      throw new CourtSigningTransitionError('signing state contains a malformed nonce commitment');
    }
    if (
      typeof commitment.idx !== 'number'
      || !Number.isSafeInteger(commitment.idx)
      || typeof commitment.binderPn !== 'string'
      || typeof commitment.hiddenPn !== 'string'
      || !isValidSecp256k1Point(commitment.binderPn)
      || !isValidSecp256k1Point(commitment.hiddenPn)
    ) {
      throw new CourtSigningTransitionError('signing state contains a malformed nonce commitment');
    }
    assertParticipant(state, commitment.idx);
    if (commitmentIndices.has(commitment.idx)) {
      throw new CourtSigningTransitionError(`duplicate stored nonce commitment for signer ${commitment.idx}`);
    }
    commitmentIndices.add(commitment.idx);
  }

  if (state.finalizedSignerSet !== undefined) {
    if (!Array.isArray(state.finalizedSignerSet)) {
      throw new CourtSigningTransitionError('finalized signer set must be an array');
    }
    const expected = [...commitmentIndices].sort((a, b) => a - b);
    if (
      state.finalizedSignerSet.length !== expected.length ||
      state.finalizedSignerSet.some((idx, offset) => idx !== expected[offset])
    ) {
      throw new CourtSigningTransitionError('finalized signer set does not match stored commitments');
    }
  }

  const partialIndices = new Set<number>();
  for (const partial of state.partials) {
    if (typeof partial !== 'object' || partial === null) {
      throw new CourtSigningTransitionError('signing state contains a malformed partial signature');
    }
    if (
      typeof partial.idx !== 'number'
      || !Number.isSafeInteger(partial.idx)
      || typeof partial.psig !== 'string'
      || !HEX_32.test(partial.psig)
    ) {
      throw new CourtSigningTransitionError('signing state contains a malformed partial signature');
    }
    if (!state.finalizedSignerSet?.includes(partial.idx)) {
      throw new CourtSigningTransitionError(
        `stored partial signer ${partial.idx} is not in the finalized commitment set`,
      );
    }
    if (partialIndices.has(partial.idx)) {
      throw new CourtSigningTransitionError(`duplicate stored partial signature for signer ${partial.idx}`);
    }
    partialIndices.add(partial.idx);
  }
}

function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
  assertBeforeDeadlineCore(
    now,
    state.deadline,
    'signing message arrived at or after the attempt deadline',
    CourtSigningTransitionError,
  );
}

/**
 * Create the initial state of one FROST signing attempt (phase `intent`).
 *
 * Validates and freezes the configuration: 32-byte-hex session and verdict
 * hashes, a bounded canonical outcome, a canonical roster (≤ 10 000),
 * 1 ≤ threshold ≤ n, and a positive deadline. The attempt number binds the
 * machine to one signing attempt; every later attempt gets a fresh machine
 * (invalidating prior nonce commitments).
 *
 * @returns A deep-frozen initial {@link CourtSigningMachineState}.
 * @throws {@link CourtSigningTransitionError} on any malformed parameter.
 */
export function createCourtSigningMachine(params: {
  readonly sessionHash: string;
  readonly verdictHash: string;
  readonly outcome: string;
  readonly participantIndices: readonly number[];
  readonly threshold: number;
  readonly attempt: number;
  readonly deadline: number;
}): CourtSigningMachineState {
  if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
    throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
  }
  if (
    typeof params.outcome !== 'string' ||
    params.outcome.length === 0 ||
    textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES ||
    !isCanonicalUtf8Text(params.outcome)
  ) {
    throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
  }
  const participants = normalizeCeremonyRoster(
    params.participantIndices,
    'signing',
    CourtSigningTransitionError,
  );
  if (
    !Number.isSafeInteger(params.threshold) ||
    params.threshold < 1 ||
    params.threshold > participants.length
  ) {
    throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
  }
  if (params.threshold > MAX_PARTIAL_SIGNATURES) {
    throw new CourtSigningTransitionError(
      'threshold must be at most ' + MAX_PARTIAL_SIGNATURES,
    );
  }
  if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
    throw new CourtSigningTransitionError('attempt must be a non-negative integer');
  }
  assertPositiveDeadline(params.deadline, 'deadline', CourtSigningTransitionError);
  // Bound the outcome length to prevent memory exhaustion from unbounded strings.
  if (params.outcome.length > 4096) {
    throw new CourtSigningTransitionError('outcome must be at most 4096 bytes');
  }
  return freezeCourtSigningMachineState({
    signingSessionHash: hashCourtSigningSession({
      sessionHash: params.sessionHash,
      verdictHash: params.verdictHash,
      outcome: params.outcome,
      participantIndices: participants,
      threshold: params.threshold,
      attempt: params.attempt,
    }),
    sessionHash: params.sessionHash,
    verdictHash: params.verdictHash,
    outcome: params.outcome,
    participantIndices: participants,
    threshold: params.threshold,
    attempt: params.attempt,
    deadline: params.deadline,
    latestTimestamp: 0,
    phase: 'intent',
    commitments: [],
    partials: [],
  });
}

/**
 * Apply one event to the signing-machine state and return the next state.
 *
 * Pure and fail-closed: validates event shape, state array fields (tamper
 * barrier), monotonic non-decreasing `now`, and phase legality before any
 * transition. Duplicate nonce commitments abort with blame; aggregation
 * happens outside the machine (the `aggregate` event carries the already
 * verified final signature).
 *
 * @returns A new deep-frozen state; the input state is never mutated.
 * @throws {@link CourtSigningTransitionError} on any illegal transition.
 */
export function reduceCourtSigningMachine(
  state: CourtSigningMachineState,
  event: CourtSigningMachineEvent,
): CourtSigningMachineState {
  // Fail closed on a non-object event (a null/undefined event would crash
  // with an uncaught TypeError on property access below).
  if (event === null || typeof event !== 'object') {
    throw new CourtSigningTransitionError('event must be an object');
  }
  assertSigningRecordInvariants(state);

  // Monotonic clock ledger (finding F-12): every time-bearing event must be
  // monotonically non-decreasing, exactly as the vote/confirmation machines
  // enforce — a restored snapshot cannot admit an old-timestamped replay that
  // a still-live ceremony would have rejected. `abort` carries no clock and
  // leaves the ledger unchanged. Restore semantics (minor-compat): v0.9.1
  // snapshots predate this field; `?? 0` initializes the ledger to 0 on
  // restore and the first time-bearing event writes it.
  if (event.type !== 'abort') {
    assertNow(event.now, CourtSigningTransitionError);
    if (event.now < (state.latestTimestamp ?? 0)) {
      throw new CourtSigningTransitionError('now must not precede a previously observed timestamp');
    }
    state = { ...state, latestTimestamp: event.now };
  }

  switch (event.type) {
    case 'tick': return onTick(state, event);
    case 'abort': return onAbort(state, event);
    default: break;
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
  }

  switch (event.type) {
    case 'start': return onStart(state, event);
    case 'accept_commitment': return onAcceptCommitment(state, event);
    case 'close_commitments': return onCloseCommitments(state, event);
    case 'accept_partial': return onAcceptPartial(state, event);
    case 'aggregate': return onAggregate(state, event);
    case 'publish': return onPublish(state, event);
    default: break;
  }

  // Unreachable for well-typed events; fail closed instead of silently
  // returning state for a hostile unknown type.
  const unknownType = (event as { readonly type?: unknown }).type;
  throw new CourtSigningTransitionError(`unknown signing event type: ${String(unknownType)}`);
}

/** Apply a `tick`: expire the ceremony when the signing deadline has passed. */
function onTick(state: CourtSigningMachineState, event: Extract<CourtSigningMachineEvent, { type: 'tick' }>): CourtSigningMachineState {
  // Validate the deadline hasn't been tampered with — if state is restored
  // from an unsafe spread of a corrupted snapshot, catch it here.
  if (!Number.isSafeInteger(state.deadline) || state.deadline < 1) {
    throw new CourtSigningTransitionError(
      'signing state has a corrupted deadline',
    );
  }
  assertNow(event.now, CourtSigningTransitionError);
  if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) {
    return freezeCourtSigningMachineState(state);
  }
  return freezeCourtSigningMachineState({
    ...state,
    phase: 'expired',
    failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
  });
}

/** Apply an `abort`: operator or peer-blame cancel from a live phase. */
function onAbort(state: CourtSigningMachineState, event: Extract<CourtSigningMachineEvent, { type: 'abort' }>): CourtSigningMachineState {
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
  }
  // Only reducer-defined failure phases may be injected as aborts — a
  // caller cannot cast an arbitrary phase (e.g. 'aggregate') into state.
  if (!ABORT_PHASES.has(event.phase)) {
    throw new CourtSigningTransitionError(`invalid signing abort phase: ${String(event.phase)}`);
  }
  // Ensure the caller cannot forge a peer-blame by supplying an unverified
  // blamedIdx — the index must be a valid roster participant.
  assertBlamedIdx(event.blamedIdx, state.participantIndices, 'signer', CourtSigningTransitionError);
  return freezeCourtSigningMachineState({
    ...state,
    phase: event.phase,
    failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
  });
}

/** Apply a `start`: intent → nonce_commit. */
function onStart(
  state: CourtSigningMachineState,
  event: Extract<CourtSigningMachineEvent, { type: 'start' }>,
): CourtSigningMachineState {
  assertBeforeDeadline(state, event.now);
  if (state.phase !== 'intent') {
    throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
  }
  return freezeCourtSigningMachineState({ ...state, phase: 'nonce_commit' });
}

/** Apply an `accept_commitment`: bind a signer's two nonce points. */
function onAcceptCommitment(
  state: CourtSigningMachineState,
  event: Extract<CourtSigningMachineEvent, { type: 'accept_commitment' }>,
): CourtSigningMachineState {
  assertBeforeDeadline(state, event.now);
  assertParticipant(state, event.idx);
  if (state.phase !== 'nonce_commit') {
    throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
  }
  // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
  // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
  // machine must not reject the x-only form. Beyond shape, the bytes must
  // decode to a real curve point so malformed nonces cannot poison the
  // binding-factor computation downstream.
  if (!isValidSecp256k1Point(event.binderPn) || !isValidSecp256k1Point(event.hiddenPn)) {
    throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
  }
  const existing = state.commitments.find((c) => c.idx === event.idx);
  if (existing) {
    if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
      // `state` is the clock-advanced copy — freeze it (INV-SIGN-15).
      return freezeCourtSigningMachineState(state);
    }
    return freezeCourtSigningMachineState({
      ...state,
      phase: 'aborted_peer',
      failure: {
        phase: 'aborted_peer',
        blamedIdx: event.idx,
        reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
      },
    });
  }
  return freezeCourtSigningMachineState({
    ...state,
    commitments: [
      ...state.commitments,
      { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
    ],
  });
}

/** Apply a `close_commitments`: freeze the signer set at/above threshold. */
function onCloseCommitments(
  state: CourtSigningMachineState,
  event: Extract<CourtSigningMachineEvent, { type: 'close_commitments' }>,
): CourtSigningMachineState {
  assertBeforeDeadline(state, event.now);
  if (state.phase !== 'nonce_commit') {
    throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
  }
  if (state.commitments.length < state.threshold) {
    throw new CourtSigningTransitionError(
      `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
    );
  }
  const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
  return freezeCourtSigningMachineState({ ...state, phase: 'commitment_set_final', finalizedSignerSet });
}

/** Apply an `accept_partial`: verify and record one partial signature. */
function onAcceptPartial(
  state: CourtSigningMachineState,
  event: Extract<CourtSigningMachineEvent, { type: 'accept_partial' }>,
): CourtSigningMachineState {
  assertBeforeDeadline(state, event.now);
  if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
    throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
  }
  if (!state.finalizedSignerSet?.includes(event.idx)) {
    throw new CourtSigningTransitionError(
      `signer ${event.idx} is not in the finalized commitment set`,
    );
  }
  // Reject malformed state — the partial signature must be well-formed hex.
  if (!/^[0-9a-fA-F]{64}$/.test(event.psig)) {
    throw new CourtSigningTransitionError(
      'partial signature must be 64-char lowercase hex',
    );
  }
  if (!HEX_32.test(event.psig)) {
    throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
  }
  const existing = state.partials.find((p) => p.idx === event.idx);
  if (existing) {
    // `state` is the clock-advanced copy — freeze it (INV-SIGN-15).
    if (existing.psig === event.psig) return freezeCourtSigningMachineState(state);
    return freezeCourtSigningMachineState({
      ...state,
      phase: 'aborted_peer',
      failure: {
        phase: 'aborted_peer',
        blamedIdx: event.idx,
        reason: 'A signer published conflicting partial signatures for this signing attempt.',
      },
    });
  }
  // Verify that the partial signature index is unique — duplicates would
  // bypass the distinct-signer threshold check and inflate the partial count.
  const seenIdxs = new Set(state.partials.map((p) => p.idx));
  if (seenIdxs.has(event.idx)) {
    throw new CourtSigningTransitionError(
      `duplicate partial signature from signer ${event.idx}`,
    );
  }
  return freezeCourtSigningMachineState({
    ...state,
    phase: 'partial_sign',
    partials: [...state.partials, { idx: event.idx, psig: event.psig }],
  });
}

/** Apply an `aggregate`: combine partials into the final signature. */
function onAggregate(
  state: CourtSigningMachineState,
  event: Extract<CourtSigningMachineEvent, { type: 'aggregate' }>,
): CourtSigningMachineState {
  assertBeforeDeadline(state, event.now);
  if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
    throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
  }
  if (state.partials.length < state.threshold) {
    throw new CourtSigningTransitionError(
      `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
    );
  }
  if (!SCHNORR_SIGNATURE.test(event.signature)) {
    throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
  }
  return freezeCourtSigningMachineState({ ...state, phase: 'aggregate', signature: event.signature });
}

/** Apply a `publish`: bind the attestation event id and reach the final phase. */
function onPublish(
  state: CourtSigningMachineState,
  event: Extract<CourtSigningMachineEvent, { type: 'publish' }>,
): CourtSigningMachineState {
  assertBeforeDeadline(state, event.now);
  if (state.phase !== 'aggregate' || !state.signature) {
    throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
  }
  if (!HEX_32.test(event.attestationEventId)) {
    throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
  }
  return freezeCourtSigningMachineState({ ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId });
}
