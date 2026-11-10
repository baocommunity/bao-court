// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Canonical identity for a BAO Court ceremony.
 *
 * This module deliberately contains no React, relay, signer, or secret-key
 * logic. Browser clients, agents, and future cryptographic adapters must all
 * derive the same session hash from the same validated public parameters.
 *
 * Pipeline role: identity layer under every ceremony stage — the validated
 * session parameters and their canonical hash bind votes, signatures,
 * attestations, and transcripts to exactly one ceremony (paper §3, §11;
 * CanonicalWriter grammar normative in docs/FORMAL_INVARIANTS.md §1.2).
 *
 * Purity: encoding, hashing, and validation are pure functions; no I/O, no
 * randomness, no clock. The only `Error` subtype is
 * {@link CourtSessionValidationError} (fail-closed, code-bearing).
 */

import { CourtError } from './errors';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** Schema version of the session-parameters encoding (currently `1`). */
export const COURT_SESSION_VERSION = 1 as const;
/** Domain string prefixing canonical session-parameter hashes. */
export const COURT_SESSION_DOMAIN = 'BAO-Court/SessionParameters/v1';

/**
 * The deployment environments a session may target. `mainnet` restricts
 * crypto suites (see {@link COURT_CRYPTO_SUITES}).
 */
export const COURT_ENVIRONMENTS = ['demo', 'signet', 'mainnet'] as const;
/** One of the deployment environments in {@link COURT_ENVIRONMENTS}. */
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
/**
 * One of the DKG crypto-suite identifiers in {@link COURT_CRYPTO_SUITES}.
 * Only `pedpop-v1-experimental` is currently exercised by the Pedersen
 * adapter; the ChillDKG identifier is reserved.
 */
export type CourtCryptoSuite = (typeof COURT_CRYPTO_SUITES)[number];

/** Role of a session participant: plain juror, or juror that coordinates the attempt. */
export type CourtParticipantRole = 'juror' | 'juror-coordinator';

/**
 * One ceremony participant: FROST index, Nostr key, Court host key, bond
 * reference, and role. All keys are validated lowercase hex of exact length.
 */
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

/**
 * The full validated public parameter set of one ceremony attempt — the
 * canonical preimage of the session hash. Every field is shape-, length-, and
 * cross-consistency-checked by {@link assertCourtSessionParameters}.
 */
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

/**
 * Machine-readable failure codes for session-parameter validation
 * (`invalid_shape`, `unsupported_version`, `unsupported_environment`,
 * `unsupported_suite`, `suite_not_allowed_on_mainnet`,
 * `invalid_identifier`, `invalid_hex`, `invalid_number`,
 * `invalid_participant_count`, `invalid_participant_index`,
 * `invalid_participant_key`, `duplicate_participant_key`,
 * `duplicate_bond`, `invalid_coordinator_count`, `invalid_threshold`,
 * `invalid_outcome`, `duplicate_outcome`, `invalid_deadline`,
 * `participant_not_found`, `participant_binding_mismatch`).
 */
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

/**
 * Error thrown when session parameters or participant bindings fail
 * validation. `code` is always one of {@link CourtSessionValidationCode};
 * see docs/FORMAL_INVARIANTS.md §15 for the taxonomy entry.
 */
export class CourtSessionValidationError extends CourtError {
  declare readonly code: CourtSessionValidationCode;

  constructor(code: CourtSessionValidationCode, message: string) {
    super(code, message);
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
/**
 * Validate an unknown value as a complete {@link CourtSessionParameters}
 * record: exact key set, supported version/environment/suite, hex-shaped
 * identifiers, canonical participant list (≤ 1000, unique keys, exactly one
 * coordinator), threshold within roster bounds, bounded unique outcomes, and
 * consistent deadlines. O(n) over participants + outcomes.
 *
 * @throws {@link CourtSessionValidationError} with a
 *         {@link CourtSessionValidationCode} on the first violated rule.
 *
 * @example
 * ```ts
 * const params = JSON.parse(serialized);
 * assertCourtSessionParameters(params); // narrows the type
 * const sessionHash = hashCourtSessionParameters(params);
 * ```
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
 *
 * Encoding contract (differential-parity pinned): byte output is IDENTICAL to
 * the original chunk-list implementation — this is a performance re-implementation
 * that writes into one pre-sized, geometrically-grown buffer instead of
 * allocating a chunk per field and concatenating in {@link finish}. The
 * validation behaviour (fail-closed ranges, hex checks) is unchanged.
 */
export class CanonicalWriter {
  private buf: Uint8Array = new Uint8Array(128);
  private view: DataView = new DataView(this.buf.buffer);
  private len: number = 0;

  /** Grow the backing buffer geometrically so `len + need` bytes fit. */
  private ensure(need: number): void {
    const required = this.len + need;
    if (required <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len), 0);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new CourtSessionValidationError(
        'invalid_number',
        'u8 field must be an integer in [0, 255]',
      );
    }
    this.ensure(1);
    this.buf[this.len] = value;
    this.len += 1;
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new CourtSessionValidationError(
        'invalid_number',
        'u32 field must be an integer in [0, 4294967295]',
      );
    }
    this.ensure(4);
    this.view.setUint32(this.len, value, false);
    this.len += 4;
  }

  u64(value: number): void {
    // Safe integers are bounded by 2^53-1 < 2^64, so a safe non-negative
    // integer is always representable and cannot wrap in setBigUint64.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CourtSessionValidationError(
        'invalid_number',
        'u64 field must be a safe non-negative integer',
      );
    }
    this.ensure(8);
    // Big-endian hi/lo split — byte-identical to setBigUint64(BigInt(value))
    // for every safe non-negative integer, without the BigInt allocation.
    this.view.setUint32(this.len, Math.floor(value / 0x1_0000_0000), false);
    this.view.setUint32(this.len + 4, value % 0x1_0000_0000, false);
    this.len += 8;
  }

  bytes(value: Uint8Array): void {
    this.u32(value.length);
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
  }

  text(value: string): void {
    this.bytes(textEncoder.encode(value));
  }

  hex(value: string): void {
    this.bytes(hexToBytes(value));
  }

  finish(): Uint8Array {
    // Exact-size copy: same shape as the original implementation's output
    // (a fresh, exactly-length array), never an interior view of the
    // growable buffer — callers may hold or mutate the result freely.
    return this.buf.slice(0, this.len);
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

/**
 * Derive the canonical binary encoding of validated session parameters —
 * the exact preimage of the Court session hash (paper §3; CanonicalWriter
 * grammar, docs/FORMAL_INVARIANTS.md §1.2). Deterministic across runtimes;
 * O(n) over participants + outcomes.
 *
 * @throws {@link CourtSessionValidationError} when the parameters are
 *         invalid (validation runs before encoding).
 */
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

/**
 * Derive the canonical Court session identifier:
 * `SHA-256(SessionParameters/v1 ‖ encode(params))` — the 32-byte lowercase
 * hex string every ceremony event, vote, signature, and attestation binds
 * to. Pure; O(n) over participants + outcomes.
 *
 * @throws {@link CourtSessionValidationError} when the parameters are
 *         invalid.
 *
 * @example
 * ```ts
 * const sessionHash = hashCourtSessionParameters(params);
 * const machine = createCourtVoteMachine({
 *   sessionHash,
 *   participantIndices: params.participants.map(p => p.idx),
 *   allowedOutcomes: params.allowedOutcomes,
 *   commitDeadline: params.createdAt + 3600,
 *   revealDeadline: params.deadline,
 * });
 * ```
 */
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
