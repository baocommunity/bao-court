// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import {
  HEX_32,
  assertBeforeDeadline as assertBeforeDeadlineCore,
  assertBlamedIdx,
  assertNow,
  assertPositiveDeadline,
  assertRosterMember,
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
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isValidSecp256k1Point } from './crypto';
import { CanonicalWriter } from './courtSession';

export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';

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

export type CourtSigningFailurePhase = Extract<
  CourtSigningPhase,
  'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
>;

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

export interface CourtSigningMachineState {
  readonly signingSessionHash: string;
  readonly sessionHash: string;
  readonly verdictHash: string;
  readonly outcome: string;
  readonly participantIndices: readonly number[];
  readonly threshold: number;
  readonly attempt: number;
  readonly deadline: number;
  readonly phase: CourtSigningPhase;
  readonly commitments: readonly CourtSigningCommitmentRecord[];
  /** Frozen, sorted signer set whose commitments define the signing context. */
  readonly finalizedSignerSet?: readonly number[];
  readonly partials: readonly CourtSigningPartialRecord[];
  readonly signature?: string;
  readonly attestationEventId?: string;
  readonly failure?: CourtSigningFailure;
}

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

export class CourtSigningTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourtSigningTransitionError';
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
    textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
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
  return {
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
    phase: 'intent',
    commitments: [],
    partials: [],
  };
}

export function reduceCourtSigningMachine(
  state: CourtSigningMachineState,
  event: CourtSigningMachineEvent,
): CourtSigningMachineState {
  assertSigningRecordInvariants(state);

  if (event.type === 'tick') {
    // Validate the deadline hasn't been tampered with — if state is restored
    // from an unsafe spread of a corrupted snapshot, catch it here.
    if (!Number.isSafeInteger(state.deadline) || state.deadline < 1) {
      throw new CourtSigningTransitionError(
        'signing state has a corrupted deadline',
      );
    }
    assertNow(event.now, CourtSigningTransitionError);
    if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
    return {
      ...state,
      phase: 'expired',
      failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
    };
  }
  if (event.type === 'abort') {
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
    return {
      ...state,
      phase: event.phase,
      failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
    };
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
  }

  if (event.type === 'start') {
    assertBeforeDeadline(state, event.now);
    if (state.phase !== 'intent') {
      throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
    }
    return { ...state, phase: 'nonce_commit' };
  }

  if (event.type === 'accept_commitment') {
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
        return state;
      }
      return {
        ...state,
        phase: 'aborted_peer',
        failure: {
          phase: 'aborted_peer',
          blamedIdx: event.idx,
          reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
        },
      };
    }
    return {
      ...state,
      commitments: [
        ...state.commitments,
        { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
      ],
    };
  }

  if (event.type === 'close_commitments') {
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
    return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
  }

  if (event.type === 'accept_partial') {
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
      if (existing.psig === event.psig) return state;
      return {
        ...state,
        phase: 'aborted_peer',
        failure: {
          phase: 'aborted_peer',
          blamedIdx: event.idx,
          reason: 'A signer published conflicting partial signatures for this signing attempt.',
        },
      };
    }
    // Verify that the partial signature index is unique — duplicates would
    // bypass the distinct-signer threshold check and inflate the partial count.
    const seenIdxs = new Set(state.partials.map((p) => p.idx));
    if (seenIdxs.has(event.idx)) {
      throw new CourtSigningTransitionError(
        `duplicate partial signature from signer ${event.idx}`,
      );
    }
    return {
      ...state,
      phase: 'partial_sign',
      partials: [...state.partials, { idx: event.idx, psig: event.psig }],
    };
  }

  if (event.type === 'aggregate') {
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
    return { ...state, phase: 'aggregate', signature: event.signature };
  }

  if (event.type === 'publish') {
    assertBeforeDeadline(state, event.now);
    if (state.phase !== 'aggregate' || !state.signature) {
      throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
    }
    if (!HEX_32.test(event.attestationEventId)) {
      throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
    }
    return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
  }

  return state;
}
