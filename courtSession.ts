// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Canonical identity for a BAO Court ceremony.
 *
 * This module deliberately contains no React, relay, signer, or secret-key
 * logic. Browser clients, agents, and future cryptographic adapters must all
 * derive the same session hash from the same validated public parameters.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const COURT_SESSION_VERSION = 1 as const;
export const COURT_SESSION_DOMAIN = 'BAO-Court/SessionParameters/v1';

export const COURT_ENVIRONMENTS = ['demo', 'signet', 'mainnet'] as const;
export type CourtEnvironment = (typeof COURT_ENVIRONMENTS)[number];

/**
 * No suite is production-enabled yet. The ChillDKG identifier is reserved for
 * the future vector-verified adapter and must not be used to describe the
 * current Pedersen implementation.
 */
export const COURT_CRYPTO_SUITES = [
  'pedpop-v1-experimental',
  'chilldkg-0.3+bip445-draft',
] as const;
export type CourtCryptoSuite = (typeof COURT_CRYPTO_SUITES)[number];

export type CourtParticipantRole = 'juror' | 'juror-coordinator';

export interface CourtSessionParticipant {
  /** Sequential, one-based FROST participant index. */
  readonly idx: number;
  /** Lowercase 32-byte Nostr public key. */
  readonly nostrPubkey: string;
  /** Lowercase 33-byte compressed secp256k1 Court host public key. */
  readonly hostPubkey: string;
  /** Stable reference to the externally verified bond evidence. */
  readonly bondRef: string;
  /** Exactly one participant coordinates a particular ceremony attempt. */
  readonly role: CourtParticipantRole;
}

export interface CourtSessionParameters {
  readonly version: typeof COURT_SESSION_VERSION;
  readonly environment: CourtEnvironment;
  readonly cryptoSuite: CourtCryptoSuite;
  readonly disputeEventId: string;
  readonly disputeId: string;
  readonly marketId: string;
  readonly marketEventId: string;
  readonly selectionEventId: string;
  readonly blockHash: string;
  readonly blockHeight: number;
  readonly participants: readonly CourtSessionParticipant[];
  readonly threshold: number;
  /** Frozen, ordered, non-empty outcome strings accepted by this jury. */
  readonly allowedOutcomes: readonly string[];
  readonly attempt: number;
  /** Unix timestamp in seconds. */
  readonly createdAt: number;
  /** Unix timestamp in seconds. */
  readonly deadline: number;
}

export type CourtSessionValidationCode =
  | 'invalid_shape'
  | 'unsupported_version'
  | 'unsupported_environment'
  | 'unsupported_suite'
  | 'suite_not_allowed_on_mainnet'
  | 'invalid_identifier'
  | 'invalid_hex'
  | 'invalid_number'
  | 'invalid_participant_count'
  | 'invalid_participant_index'
  | 'invalid_participant_key'
  | 'duplicate_participant_key'
  | 'duplicate_bond'
  | 'invalid_coordinator_count'
  | 'invalid_threshold'
  | 'invalid_outcome'
  | 'duplicate_outcome'
  | 'invalid_deadline'
  | 'participant_not_found'
  | 'participant_binding_mismatch';

export class CourtSessionValidationError extends Error {
  readonly code: CourtSessionValidationCode;

  constructor(code: CourtSessionValidationCode, message: string) {
    super(message);
    this.name = 'CourtSessionValidationError';
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const COMPRESSED_KEY = /^(02|03)[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PARTICIPANTS = 1_000;
const MAX_OUTCOMES = 256;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_OUTCOME_BYTES = 256;
const MAX_BOND_REF_BYTES = 512;
const MAX_U32 = 0xffff_ffff;
const MAX_SAFE_U64 = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new CourtSessionValidationError(
      'invalid_shape',
      `${field} contains unsupported field ${unexpected}`,
    );
  }
}

function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

function assertCanonicalText(
  value: unknown,
  field: string,
  maxBytes: number,
  code: CourtSessionValidationCode,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value !== value.normalize('NFC')
    || CONTROL_CHARACTERS.test(value)
    || textEncoder.encode(value).length > maxBytes
  ) {
    throw new CourtSessionValidationError(
      code,
      `${field} must be non-empty canonical UTF-8 without surrounding whitespace or control characters`,
    );
  }
}

function assertHex32(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtSessionValidationError(
      'invalid_hex',
      `${field} must be 32-byte lowercase hex`,
    );
  }
}

function assertSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = MAX_SAFE_U64,
): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new CourtSessionValidationError(
      'invalid_number',
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
}

function assertHostPubkey(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !COMPRESSED_KEY.test(value)) {
    throw new CourtSessionValidationError(
      'invalid_participant_key',
      `${field} must be a lowercase compressed secp256k1 public key`,
    );
  }

  try {
    secp256k1.Point.fromHex(value);
  } catch {
    throw new CourtSessionValidationError(
      'invalid_participant_key',
      `${field} is not a valid secp256k1 point`,
    );
  }
}

function validateParticipant(
  value: unknown,
  expectedIdx: number,
): asserts value is CourtSessionParticipant {
  if (!isRecord(value)) {
    throw new CourtSessionValidationError(
      'invalid_shape',
      `participants[${expectedIdx - 1}] must be an object`,
    );
  }
  assertExactKeys(
    value,
    ['idx', 'nostrPubkey', 'hostPubkey', 'bondRef', 'role'],
    `participants[${expectedIdx - 1}]`,
  );

  assertSafeInteger(value.idx, `participants[${expectedIdx - 1}].idx`, 1, MAX_U32);
  if (value.idx !== expectedIdx) {
    throw new CourtSessionValidationError(
      'invalid_participant_index',
      `participant indices must be sequential and ordered; expected ${expectedIdx}`,
    );
  }
  assertHex32(value.nostrPubkey, `participants[${expectedIdx - 1}].nostrPubkey`);
  assertHostPubkey(value.hostPubkey, `participants[${expectedIdx - 1}].hostPubkey`);
  assertCanonicalText(
    value.bondRef,
    `participants[${expectedIdx - 1}].bondRef`,
    MAX_BOND_REF_BYTES,
    'invalid_identifier',
  );
  if (value.role !== 'juror' && value.role !== 'juror-coordinator') {
    throw new CourtSessionValidationError(
      'invalid_shape',
      `participants[${expectedIdx - 1}].role is unsupported`,
    );
  }
}

/**
 * Validate the complete public identity of one Court ceremony.
 *
 * Mainnet is deliberately rejected until a suite passes the rollout gates.
 */
export function assertCourtSessionParameters(
  value: unknown,
): asserts value is CourtSessionParameters {
  if (!isRecord(value)) {
    throw new CourtSessionValidationError('invalid_shape', 'session parameters must be an object');
  }
  assertExactKeys(
    value,
    [
      'version',
      'environment',
      'cryptoSuite',
      'disputeEventId',
      'disputeId',
      'marketId',
      'marketEventId',
      'selectionEventId',
      'blockHash',
      'blockHeight',
      'participants',
      'threshold',
      'allowedOutcomes',
      'attempt',
      'createdAt',
      'deadline',
    ],
    'session parameters',
  );
  if (value.version !== COURT_SESSION_VERSION) {
    throw new CourtSessionValidationError('unsupported_version', 'unsupported Court session version');
  }
  if (!isOneOf(COURT_ENVIRONMENTS, value.environment)) {
    throw new CourtSessionValidationError('unsupported_environment', 'unsupported Court environment');
  }
  if (!isOneOf(COURT_CRYPTO_SUITES, value.cryptoSuite)) {
    throw new CourtSessionValidationError('unsupported_suite', 'unsupported Court crypto suite');
  }
  if (value.environment === 'mainnet') {
    throw new CourtSessionValidationError(
      'suite_not_allowed_on_mainnet',
      `${value.cryptoSuite} has not passed the BAO Court mainnet activation gate`,
    );
  }

  assertHex32(value.disputeEventId, 'disputeEventId');
  assertCanonicalText(value.disputeId, 'disputeId', MAX_IDENTIFIER_BYTES, 'invalid_identifier');
  assertCanonicalText(value.marketId, 'marketId', MAX_IDENTIFIER_BYTES, 'invalid_identifier');
  assertHex32(value.marketEventId, 'marketEventId');
  assertHex32(value.selectionEventId, 'selectionEventId');
  assertHex32(value.blockHash, 'blockHash');
  assertSafeInteger(value.blockHeight, 'blockHeight', 0);
  assertSafeInteger(value.threshold, 'threshold', 1, MAX_U32);
  assertSafeInteger(value.attempt, 'attempt', 0, MAX_U32);
  assertSafeInteger(value.createdAt, 'createdAt', 0);
  assertSafeInteger(value.deadline, 'deadline', 0);
  if (value.deadline <= value.createdAt) {
    throw new CourtSessionValidationError(
      'invalid_deadline',
      'deadline must be later than createdAt',
    );
  }

  if (
    !Array.isArray(value.participants)
    || value.participants.length === 0
    || value.participants.length > MAX_PARTICIPANTS
  ) {
    throw new CourtSessionValidationError(
      'invalid_participant_count',
      `participants must contain between 1 and ${MAX_PARTICIPANTS} entries`,
    );
  }

  const nostrPubkeys = new Set<string>();
  const hostPubkeys = new Set<string>();
  const bondRefs = new Set<string>();
  let coordinatorCount = 0;
  value.participants.forEach((participant, offset) => {
    validateParticipant(participant, offset + 1);
    if (nostrPubkeys.has(participant.nostrPubkey) || hostPubkeys.has(participant.hostPubkey)) {
      throw new CourtSessionValidationError(
        'duplicate_participant_key',
        'participant Nostr and Court host keys must each be unique',
      );
    }
    if (bondRefs.has(participant.bondRef)) {
      throw new CourtSessionValidationError(
        'duplicate_bond',
        'each participant must have distinct bond evidence',
      );
    }
    nostrPubkeys.add(participant.nostrPubkey);
    hostPubkeys.add(participant.hostPubkey);
    bondRefs.add(participant.bondRef);
    if (participant.role === 'juror-coordinator') coordinatorCount += 1;
  });

  if (coordinatorCount !== 1) {
    throw new CourtSessionValidationError(
      'invalid_coordinator_count',
      'exactly one selected juror must coordinate each ceremony attempt',
    );
  }
  if (value.threshold > value.participants.length) {
    throw new CourtSessionValidationError(
      'invalid_threshold',
      'threshold cannot exceed the participant count',
    );
  }

  if (
    !Array.isArray(value.allowedOutcomes)
    || value.allowedOutcomes.length < 2
    || value.allowedOutcomes.length > MAX_OUTCOMES
  ) {
    throw new CourtSessionValidationError(
      'invalid_outcome',
      `allowedOutcomes must contain between 2 and ${MAX_OUTCOMES} outcomes`,
    );
  }
  const outcomes = new Set<string>();
  value.allowedOutcomes.forEach((outcome, index) => {
    assertCanonicalText(
      outcome,
      `allowedOutcomes[${index}]`,
      MAX_OUTCOME_BYTES,
      'invalid_outcome',
    );
    if (outcomes.has(outcome)) {
      throw new CourtSessionValidationError('duplicate_outcome', 'allowed outcomes must be unique');
    }
    outcomes.add(outcome);
  });
}

/**
 * Length-prefixed canonical binary writer shared by every Court hash domain.
 * Delimiter-joined attacker-controlled strings must never be hashed directly.
 */
export class CanonicalWriter {
  private readonly chunks: Uint8Array[] = [];

  u8(value: number): void {
    this.chunks.push(Uint8Array.of(value));
  }

  u32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    this.chunks.push(bytes);
  }

  u64(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
    this.chunks.push(bytes);
  }

  bytes(value: Uint8Array): void {
    this.u32(value.length);
    this.chunks.push(value);
  }

  text(value: string): void {
    this.bytes(textEncoder.encode(value));
  }

  hex(value: string): void {
    this.bytes(hexToBytes(value));
  }

  finish(): Uint8Array {
    const length = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

const ENVIRONMENT_IDS: Readonly<Record<CourtEnvironment, number>> = {
  demo: 0,
  signet: 1,
  mainnet: 2,
};

const SUITE_IDS: Readonly<Record<CourtCryptoSuite, number>> = {
  'pedpop-v1-experimental': 0,
  'chilldkg-0.3+bip445-draft': 1,
};

const ROLE_IDS: Readonly<Record<CourtParticipantRole, number>> = {
  juror: 0,
  'juror-coordinator': 1,
};

/** Return the canonical binary encoding used by the Court session hash. */
export function encodeCourtSessionParameters(value: CourtSessionParameters): Uint8Array {
  assertCourtSessionParameters(value);
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.u8(ENVIRONMENT_IDS[value.environment]);
  writer.u8(SUITE_IDS[value.cryptoSuite]);
  writer.hex(value.disputeEventId);
  writer.text(value.disputeId);
  writer.text(value.marketId);
  writer.hex(value.marketEventId);
  writer.hex(value.selectionEventId);
  writer.hex(value.blockHash);
  writer.u64(value.blockHeight);
  writer.u32(value.participants.length);
  for (const participant of value.participants) {
    writer.u32(participant.idx);
    writer.hex(participant.nostrPubkey);
    writer.hex(participant.hostPubkey);
    writer.text(participant.bondRef);
    writer.u8(ROLE_IDS[participant.role]);
  }
  writer.u32(value.threshold);
  writer.u32(value.allowedOutcomes.length);
  value.allowedOutcomes.forEach((outcome) => writer.text(outcome));
  writer.u32(value.attempt);
  writer.u64(value.createdAt);
  writer.u64(value.deadline);
  return writer.finish();
}

/** Derive the lowercase SHA-256 Court session identifier. */
export function hashCourtSessionParameters(value: CourtSessionParameters): string {
  const encoded = encodeCourtSessionParameters(value);
  const domain = textEncoder.encode(COURT_SESSION_DOMAIN);
  const input = new Uint8Array(domain.length + encoded.length);
  input.set(domain, 0);
  input.set(encoded, domain.length);
  return bytesToHex(sha256(input));
}

/** Find a selected participant by their canonical one-based index. */
export function getCourtSessionParticipant(
  value: CourtSessionParameters,
  idx: number,
): CourtSessionParticipant {
  assertCourtSessionParameters(value);
  assertSafeInteger(idx, 'idx', 1, MAX_U32);
  const participant = value.participants[idx - 1];
  if (!participant || participant.idx !== idx) {
    throw new CourtSessionValidationError(
      'participant_not_found',
      `participant ${idx} is not in this Court session`,
    );
  }
  return participant;
}

/**
 * Bind a protocol event's signed author and claimed keys to one roster entry.
 */
export function assertCourtParticipantBinding(
  value: CourtSessionParameters,
  claimedIdx: number,
  eventAuthor: string,
  claimedHostPubkey?: string,
): CourtSessionParticipant {
  const participant = getCourtSessionParticipant(value, claimedIdx);
  assertHex32(eventAuthor, 'eventAuthor');
  if (eventAuthor !== participant.nostrPubkey) {
    throw new CourtSessionValidationError(
      'participant_binding_mismatch',
      `event author does not match Court participant ${claimedIdx}`,
    );
  }
  if (claimedHostPubkey !== undefined) {
    assertHostPubkey(claimedHostPubkey, 'claimedHostPubkey');
    if (claimedHostPubkey !== participant.hostPubkey) {
      throw new CourtSessionValidationError(
        'participant_binding_mismatch',
        `Court host key does not match participant ${claimedIdx}`,
      );
    }
  }
  return participant;
}
