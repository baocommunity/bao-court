// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Certified legacy-suite recovery envelopes for BAO Court FROST shares.
 *
 * Scope: migration-grade recovery for the LEGACY suite only
 * (`pedpop-v1-experimental`). ChillDKG common recovery data is a later phase
 * and is deliberately rejected here with `unsupported_suite`.
 *
 * A recovery envelope is a two-layer self-backup: an outer routing wrapper
 * (untrusted metadata + ciphertext) and an inner NIP-44 self-encrypted payload
 * carrying the full session parameters, the exact DKG record, and the juror's
 * FROST secret share, all bound by an integrity hash under
 * `BAO-Court/RecoveryEnvelope/v1`.
 *
 * Self-decryption is NECESSARY but NEVER SUFFICIENT for trust: NIP-44 v2 is an
 * AEAD without key commitment, so any party that could ever invoke
 * `nip44_encrypt` on the juror's signer can mint validly self-decrypting
 * ciphertexts containing anything, and relays can replay superseded envelopes.
 * Restore therefore treats the decrypted payload exactly like `courtOutbox.ts`
 * treats a snapshot: re-derive, re-verify, never trust self-asserted fields.
 * The local secret share and the independently supplied session parameters are
 * the cryptographic roots; the group key, every verification share, the local
 * public share, and both session hashes are recomputed from them using the
 * SAME curve functions `dkg.ts` / `independentDkg.computeKey()` use.
 *
 * Secret hygiene (honest guarantees): the FROST share exists in this module
 * only as a hex string — JavaScript strings cannot be reliably zeroized, so
 * this module guarantees the share never leaves the process (it appears only
 * inside the NIP-44 ciphertext and in the single typed `CourtRecoveredShare`
 * output), makes a best-effort to avoid retaining references beyond the call
 * scope, and cannot guarantee erasure from runtime memory. Hosts must never
 * cache, log, snapshot, or place the recovered share in TanStack /
 * localStorage / URL state.
 *
 * Two-secret doctrine: this module never imports the Court host-key module
 * (host-key material), never touches settlement keeper/HTLC secrets, and
 * never accepts a raw `nsec` — all private-key operations go through the
 * injected `CourtEventSigner`. It performs no socket, storage, or timer I/O;
 * event templates only. Every time-dependent function takes a required
 * injected `now` (Unix seconds); this module never reads a wall clock or a
 * randomness source directly.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { EventTemplate } from 'nostr-tools/pure';
import {
  CanonicalWriter,
  CourtSessionValidationError,
  assertCourtSessionParameters,
  encodeCourtSessionParameters,
  hashCourtSessionParameters,
  type CourtSessionParameters,
} from './courtSession';
import type { CourtEventSigner } from './courtSigner';
import { evaluateCommitments, pointToXOnlyHex } from './dkg';
import { BAO_COURT_SHARE_BACKUP_KIND } from './dkgMessages';
import type { DkgRecord } from './types';

/** Recovery envelope schema version. */
export const COURT_RECOVERY_ENVELOPE_VERSION = 1 as const;

/** Canonical hashing domain for the recovery payload integrity hash. */
export const COURT_RECOVERY_ENVELOPE_DOMAIN = 'BAO-Court/RecoveryEnvelope/v1';

/**
 * The only suite this module migrates. ChillDKG common recovery data is a
 * later phase; any other suite string fails closed with `unsupported_suite`.
 */
export const COURT_RECOVERY_LEGACY_SUITE = 'pedpop-v1-experimental' as const;

/**
 * Recovery envelopes reuse the existing self-backup kind; the
 * `['v', 'recovery-envelope:1']` tag discriminates them from legacy
 * un-versioned share backups and host-key backup payloads.
 */
export const COURT_RECOVERY_ENVELOPE_KIND = BAO_COURT_SHARE_BACKUP_KIND;

/**
 * Machine-readable failure codes for every recovery gate. Restore fails
 * closed: nothing is returned unless every recomputation check passes.
 */
export type CourtRecoveryErrorCode =
  | 'malformed'
  | 'unsupported_version'
  | 'unsupported_suite'
  | 'wrong_identity'
  | 'encrypt_failed'
  | 'decrypt_failed'
  | 'integrity_mismatch'
  | 'envelope_binding_mismatch'
  | 'session_invalid'
  | 'session_hash_mismatch'
  | 'wrong_session'
  | 'session_parameters_mismatch'
  | 'identity_not_in_roster'
  | 'roster_binding_mismatch'
  | 'dkg_record_malformed'
  | 'record_session_mismatch'
  | 'invalid_curve_point'
  | 'invalid_share_scalar'
  | 'group_key_mismatch'
  | 'verification_share_mismatch'
  | 'local_share_mismatch'
  | 'certificate_mismatch';

/** Error thrown by every fail-closed recovery gate. */
export class CourtRecoveryError extends Error {
  readonly code: CourtRecoveryErrorCode;

  constructor(code: CourtRecoveryErrorCode, message: string) {
    super(message);
    this.name = 'CourtRecoveryError';
    this.code = code;
  }
}

/**
 * Outer routing envelope. Every field is untrusted transport metadata: the
 * session hash is re-derived from the decrypted payload, the juror pubkey is
 * checked against the signer, and `createdAt` is never security-relevant.
 */
export interface CourtRecoveryEnvelopeV1 {
  readonly version: typeof COURT_RECOVERY_ENVELOPE_VERSION;
  readonly cryptoSuite: typeof COURT_RECOVERY_LEGACY_SUITE;
  /** Routing/filter only; re-derived from the decrypted payload on restore. */
  readonly sessionHash: string;
  /** X-only Nostr identity of the juror; must equal the signer pubkey. */
  readonly jurorPubkey: string;
  /** Informational only; never used for security decisions. */
  readonly createdAt: number;
  /** NIP-44 v2 ciphertext to the juror's own pubkey. */
  readonly ciphertext: string;
}

/**
 * Inner encrypted payload. The `integrityHash` covers every other field via
 * {@link hashCourtRecoveryPayload}; recomputation — not this hash — is the
 * root of trust on restore.
 */
export interface CourtRecoveryPayloadV1 {
  readonly version: typeof COURT_RECOVERY_ENVELOPE_VERSION;
  readonly cryptoSuite: typeof COURT_RECOVERY_LEGACY_SUITE;
  /** Canonical `BAO-Court/SessionParameters/v1` hash of the embedded session. */
  readonly sessionHash: string;
  /** Embedded for self-description; NEVER trusted — re-hashed and compared. */
  readonly sessionParameters: CourtSessionParameters;
  /** One-based local FROST participant index. */
  readonly jurorIdx: number;
  /** Local juror's Nostr identity; must equal the signer pubkey and roster. */
  readonly jurorNostrPubkey: string;
  /** The exact DKG record being backed up. */
  readonly dkgRecord: DkgRecord;
  /** The FROST secret share; exists only inside the encrypted layer. */
  readonly localShareSeckey: string;
  /** Injected-clock timestamp at backup creation; informational only. */
  readonly backedUpAt: number;
  /** SHA-256 integrity hash over the canonical binary encoding of the rest. */
  readonly integrityHash: string;
}

/** Payload without its integrity hash — the input to the canonical hash. */
type CourtRecoveryPayloadCoreV1 = Omit<CourtRecoveryPayloadV1, 'integrityHash'>;

/**
 * Optional certification anchor for restore. For the legacy suite the anchor
 * is the unanimous-roster recomputation itself; when transcript certification
 * lands, hosts pass its certificate reference here without a format change.
 */
export interface CourtRecoveryCertificateRef {
  /** Must equal the payload's session hash. */
  readonly sessionHash: string;
  /** 33-byte compressed group public key; must equal the RECOMPUTED key. */
  readonly groupPubkey: string;
  /** Optional transcript certification hash (32-byte lowercase hex). */
  readonly transcriptHash?: string;
}

/**
 * The recovered FROST secret share — the ONLY secret output of this module.
 * WARNING: never cache, log, snapshot, or place in TanStack / localStorage /
 * URL state; feed it directly into a signing session and drop the reference.
 */
export interface CourtRecoveredShare {
  readonly idx: number;
  readonly seckey: string;
}

/** Successful restore output: recomputed DKG material plus the secret share. */
export interface CourtRecoveredDkg {
  /** Deep copy of the HOST-SUPPLIED session parameters, never the envelope's. */
  readonly sessionParameters: CourtSessionParameters;
  readonly jurorIdx: number;
  /**
   * Reconstructed record whose group key and verification shares are taken
   * from recomputed curve points, not from the envelope's claims.
   */
  readonly record: DkgRecord;
  readonly share: CourtRecoveredShare;
}

const Point = secp256k1.Point;
const CURVE_ORDER = secp256k1.Point.Fn.ORDER;
type CurvePoint = InstanceType<typeof Point>;

const textEncoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const COMPRESSED_KEY = /^(02|03)[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_CIPHERTEXT_BYTES = 128 * 1024;
const MAX_PARTICIPANTS = 1_000;
/** Restores tolerate unsynchronized device clocks up to this skew. */
const MAX_CREATED_AT_SKEW_SECONDS = 300;
const RECOVERY_ENVELOPE_TAG = 'recovery-envelope:1';

/** Function declaration (not a const arrow) so `never` narrowing works. */
function fail(code: CourtRecoveryErrorCode, message: string): never {
  throw new CourtRecoveryError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
  code: CourtRecoveryErrorCode,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    fail(code, `${field} contains unsupported field ${unexpected}`);
  }
}

function assertHex32(
  value: unknown,
  field: string,
  code: CourtRecoveryErrorCode,
): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    fail(code, `${field} must be 32-byte lowercase hex`);
  }
}

function assertCompressedKey(
  value: unknown,
  field: string,
  code: CourtRecoveryErrorCode,
): asserts value is string {
  if (typeof value !== 'string' || !COMPRESSED_KEY.test(value)) {
    fail(code, `${field} must be a lowercase compressed secp256k1 public key`);
  }
}

function assertSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  code: CourtRecoveryErrorCode,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail(code, `${field} must be a safe integer >= ${minimum}`);
  }
}

function assertCanonicalText(
  value: unknown,
  field: string,
  code: CourtRecoveryErrorCode,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value !== value.normalize('NFC')
    || CONTROL_CHARACTERS.test(value)
    || textEncoder.encode(value).length > MAX_IDENTIFIER_BYTES
  ) {
    fail(code, `${field} must be non-empty canonical UTF-8`);
  }
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    fail('malformed', 'now must be a non-negative Unix timestamp in seconds');
  }
}

function digestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = textEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/** Length-fixed constant-time hex comparison for integrity checks. */
function equalHexConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

interface NormalizedVerificationShare {
  readonly idx: number;
  readonly pubkey: string;
}

interface NormalizedVssCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly commits: readonly string[];
}

interface NormalizedDkgRecord {
  readonly marketId: string;
  readonly disputeId: string;
  readonly threshold: number;
  readonly participants: number;
  readonly groupPubkey: string;
  readonly groupPubkeyXOnly: string;
  readonly verificationShares: readonly NormalizedVerificationShare[];
  readonly jurorPubkeys: readonly string[];
  readonly vssCommitments: readonly NormalizedVssCommitment[];
}

/**
 * Structurally validate and deep-copy a DKG record. Every shape failure here
 * is `dkg_record_malformed`; semantic binding to a session happens separately.
 */
function normalizeDkgRecord(value: unknown): NormalizedDkgRecord {
  if (!isRecord(value)) {
    fail('dkg_record_malformed', 'dkgRecord must be an object');
  }
  assertExactKeys(
    value,
    [
      'marketId',
      'disputeId',
      'threshold',
      'participants',
      'groupPubkey',
      'groupPubkeyXOnly',
      'verificationShares',
      'jurorPubkeys',
      'vssCommitments',
    ],
    'dkgRecord',
    'dkg_record_malformed',
  );
  assertCanonicalText(value.marketId, 'dkgRecord.marketId', 'dkg_record_malformed');
  assertCanonicalText(value.disputeId, 'dkgRecord.disputeId', 'dkg_record_malformed');
  assertSafeInteger(value.threshold, 'dkgRecord.threshold', 1, 'dkg_record_malformed');
  assertSafeInteger(value.participants, 'dkgRecord.participants', 1, 'dkg_record_malformed');
  if (value.participants > MAX_PARTICIPANTS) {
    fail('dkg_record_malformed', `dkgRecord.participants must be at most ${MAX_PARTICIPANTS}`);
  }
  assertCompressedKey(value.groupPubkey, 'dkgRecord.groupPubkey', 'dkg_record_malformed');
  assertHex32(value.groupPubkeyXOnly, 'dkgRecord.groupPubkeyXOnly', 'dkg_record_malformed');

  if (!Array.isArray(value.verificationShares)) {
    fail('dkg_record_malformed', 'dkgRecord.verificationShares must be an array');
  }
  const verificationShares = value.verificationShares.map((entry, offset) => {
    if (!isRecord(entry)) {
      fail('dkg_record_malformed', `dkgRecord.verificationShares[${offset}] must be an object`);
    }
    assertExactKeys(entry, ['idx', 'pubkey'], `dkgRecord.verificationShares[${offset}]`, 'dkg_record_malformed');
    assertSafeInteger(entry.idx, `dkgRecord.verificationShares[${offset}].idx`, 1, 'dkg_record_malformed');
    assertHex32(entry.pubkey, `dkgRecord.verificationShares[${offset}].pubkey`, 'dkg_record_malformed');
    return { idx: entry.idx, pubkey: entry.pubkey };
  });

  if (!Array.isArray(value.jurorPubkeys)) {
    fail('dkg_record_malformed', 'dkgRecord.jurorPubkeys must be an array');
  }
  const jurorPubkeys = value.jurorPubkeys.map((entry, offset) => {
    assertHex32(entry, `dkgRecord.jurorPubkeys[${offset}]`, 'dkg_record_malformed');
    return entry;
  });

  if (!Array.isArray(value.vssCommitments)) {
    fail('dkg_record_malformed', 'dkgRecord.vssCommitments must be an array');
  }
  const vssCommitments = value.vssCommitments.map((entry, offset) => {
    if (!isRecord(entry)) {
      fail('dkg_record_malformed', `dkgRecord.vssCommitments[${offset}] must be an object`);
    }
    assertExactKeys(entry, ['idx', 'pubkey', 'commits'], `dkgRecord.vssCommitments[${offset}]`, 'dkg_record_malformed');
    assertSafeInteger(entry.idx, `dkgRecord.vssCommitments[${offset}].idx`, 1, 'dkg_record_malformed');
    assertHex32(entry.pubkey, `dkgRecord.vssCommitments[${offset}].pubkey`, 'dkg_record_malformed');
    if (!Array.isArray(entry.commits)) {
      fail('dkg_record_malformed', `dkgRecord.vssCommitments[${offset}].commits must be an array`);
    }
    const commits = entry.commits.map((commit, commitOffset) => {
      assertCompressedKey(
        commit,
        `dkgRecord.vssCommitments[${offset}].commits[${commitOffset}]`,
        'dkg_record_malformed',
      );
      return commit;
    });
    return { idx: entry.idx, pubkey: entry.pubkey, commits };
  });

  return {
    marketId: value.marketId,
    disputeId: value.disputeId,
    threshold: value.threshold,
    participants: value.participants,
    groupPubkey: value.groupPubkey,
    groupPubkeyXOnly: value.groupPubkeyXOnly,
    verificationShares,
    jurorPubkeys,
    vssCommitments,
  };
}

/**
 * Validate host/envelope session parameters, enforcing the legacy-suite
 * scope. `CourtSessionValidationError` is wrapped as `session_invalid` with
 * the inner code preserved in the message.
 */
function normalizeSessionParameters(value: unknown): CourtSessionParameters {
  if (!isRecord(value)) {
    fail('session_invalid', 'sessionParameters must be an object');
  }
  try {
    assertCourtSessionParameters(value);
  } catch (error) {
    if (error instanceof CourtSessionValidationError) {
      fail('session_invalid', `sessionParameters failed validation (${error.code}): ${error.message}`);
    }
    throw error;
  }
  if (value.cryptoSuite !== COURT_RECOVERY_LEGACY_SUITE) {
    fail(
      'unsupported_suite',
      `recovery only supports the legacy suite ${COURT_RECOVERY_LEGACY_SUITE}`,
    );
  }
  return structuredClone(value) as CourtSessionParameters;
}

/** Canonical JSON object for session parameters (fixed key order). */
function sessionParametersJson(value: CourtSessionParameters): Record<string, unknown> {
  return {
    version: value.version,
    environment: value.environment,
    cryptoSuite: value.cryptoSuite,
    disputeEventId: value.disputeEventId,
    disputeId: value.disputeId,
    marketId: value.marketId,
    marketEventId: value.marketEventId,
    selectionEventId: value.selectionEventId,
    blockHash: value.blockHash,
    blockHeight: value.blockHeight,
    participants: value.participants.map((participant) => ({
      idx: participant.idx,
      nostrPubkey: participant.nostrPubkey,
      hostPubkey: participant.hostPubkey,
      bondRef: participant.bondRef,
      role: participant.role,
    })),
    threshold: value.threshold,
    allowedOutcomes: [...value.allowedOutcomes],
    attempt: value.attempt,
    createdAt: value.createdAt,
    deadline: value.deadline,
  };
}

/** Canonical JSON object for a DKG record (fixed key order). */
function dkgRecordJson(value: NormalizedDkgRecord): Record<string, unknown> {
  return {
    marketId: value.marketId,
    disputeId: value.disputeId,
    threshold: value.threshold,
    participants: value.participants,
    groupPubkey: value.groupPubkey,
    groupPubkeyXOnly: value.groupPubkeyXOnly,
    verificationShares: value.verificationShares.map((entry) => ({
      idx: entry.idx,
      pubkey: entry.pubkey,
    })),
    jurorPubkeys: [...value.jurorPubkeys],
    vssCommitments: value.vssCommitments.map((entry) => ({
      idx: entry.idx,
      pubkey: entry.pubkey,
      commits: [...entry.commits],
    })),
  };
}

/**
 * Canonical binary encoding of a recovery payload (minus its integrity hash)
 * under {@link COURT_RECOVERY_ENVELOPE_DOMAIN}. The session parameters are
 * encoded with the Phase 1 `encodeCourtSessionParameters` verbatim so roster /
 * session encoding can never drift between modules. All shapes are validated
 * before encoding; failures throw typed `CourtRecoveryError`s.
 */
export function encodeCourtRecoveryPayloadV1(core: CourtRecoveryPayloadCoreV1): Uint8Array {
  if (!isRecord(core)) {
    fail('malformed', 'recovery payload core must be an object');
  }
  if (core.version !== COURT_RECOVERY_ENVELOPE_VERSION) {
    fail('unsupported_version', 'unsupported recovery payload version');
  }
  if (core.cryptoSuite !== COURT_RECOVERY_LEGACY_SUITE) {
    fail('unsupported_suite', `recovery only supports ${COURT_RECOVERY_LEGACY_SUITE}`);
  }
  assertHex32(core.sessionHash, 'sessionHash', 'malformed');
  let sessionEncoding: Uint8Array;
  try {
    sessionEncoding = encodeCourtSessionParameters(core.sessionParameters);
  } catch (error) {
    if (error instanceof CourtSessionValidationError) {
      fail('session_invalid', `sessionParameters failed validation (${error.code}): ${error.message}`);
    }
    throw error;
  }
  assertSafeInteger(core.jurorIdx, 'jurorIdx', 1, 'malformed');
  assertHex32(core.jurorNostrPubkey, 'jurorNostrPubkey', 'malformed');
  const record = normalizeDkgRecord(core.dkgRecord);
  assertHex32(core.localShareSeckey, 'localShareSeckey', 'invalid_share_scalar');
  assertSafeInteger(core.backedUpAt, 'backedUpAt', 0, 'malformed');

  const writer = new CanonicalWriter();
  writer.u8(core.version);
  writer.text(core.cryptoSuite);
  writer.hex(core.sessionHash);
  writer.bytes(sessionEncoding);
  writer.u32(core.jurorIdx);
  writer.hex(core.jurorNostrPubkey);
  writer.text(record.marketId);
  writer.text(record.disputeId);
  writer.u32(record.threshold);
  writer.u32(record.participants);
  writer.hex(record.groupPubkey);
  writer.hex(record.groupPubkeyXOnly);
  writer.u32(record.verificationShares.length);
  for (const entry of record.verificationShares) {
    writer.u32(entry.idx);
    writer.hex(entry.pubkey);
  }
  writer.u32(record.jurorPubkeys.length);
  for (const pubkey of record.jurorPubkeys) {
    writer.hex(pubkey);
  }
  writer.u32(record.vssCommitments.length);
  for (const entry of record.vssCommitments) {
    writer.u32(entry.idx);
    writer.hex(entry.pubkey);
    writer.u32(entry.commits.length);
    for (const commit of entry.commits) {
      writer.hex(commit);
    }
  }
  writer.hex(core.localShareSeckey);
  writer.u64(core.backedUpAt);
  return writer.finish();
}

/** Integrity hash of a recovery payload core under the versioned domain. */
export function hashCourtRecoveryPayload(core: CourtRecoveryPayloadCoreV1): string {
  return digestDomain(COURT_RECOVERY_ENVELOPE_DOMAIN, encodeCourtRecoveryPayloadV1(core));
}

/**
 * Deterministic JSON serialization of a recovery payload — fixed key order at
 * every level so identical payloads serialize byte-identically regardless of
 * input object key ordering. This JSON is the NIP-44 plaintext; the integrity
 * hash is computed over the canonical BINARY encoding, never over this JSON.
 */
export function serializeCourtRecoveryPayloadV1(payload: CourtRecoveryPayloadV1): string {
  if (!isRecord(payload)) {
    fail('malformed', 'recovery payload must be an object');
  }
  assertHex32(payload.integrityHash, 'integrityHash', 'malformed');
  const sessionParameters = normalizeSessionParameters(payload.sessionParameters);
  const record = normalizeDkgRecord(payload.dkgRecord);
  if (payload.version !== COURT_RECOVERY_ENVELOPE_VERSION) {
    fail('unsupported_version', 'unsupported recovery payload version');
  }
  if (payload.cryptoSuite !== COURT_RECOVERY_LEGACY_SUITE) {
    fail('unsupported_suite', `recovery only supports ${COURT_RECOVERY_LEGACY_SUITE}`);
  }
  assertHex32(payload.sessionHash, 'sessionHash', 'malformed');
  assertSafeInteger(payload.jurorIdx, 'jurorIdx', 1, 'malformed');
  assertHex32(payload.jurorNostrPubkey, 'jurorNostrPubkey', 'malformed');
  assertHex32(payload.localShareSeckey, 'localShareSeckey', 'invalid_share_scalar');
  assertSafeInteger(payload.backedUpAt, 'backedUpAt', 0, 'malformed');
  return JSON.stringify({
    version: payload.version,
    cryptoSuite: payload.cryptoSuite,
    sessionHash: payload.sessionHash,
    sessionParameters: sessionParametersJson(sessionParameters),
    jurorIdx: payload.jurorIdx,
    jurorNostrPubkey: payload.jurorNostrPubkey,
    dkgRecord: dkgRecordJson(record),
    localShareSeckey: payload.localShareSeckey,
    backedUpAt: payload.backedUpAt,
    integrityHash: payload.integrityHash,
  });
}

/**
 * Structurally validate an outer envelope. When `now` is supplied, a
 * `createdAt` more than MAX_CREATED_AT_SKEW_SECONDS in the future fails
 * closed (`malformed`) — unsynchronized restore devices are tolerated, gross
 * timestamp tampering is not.
 */
function assertEnvelopeShape(
  value: unknown,
  now?: number,
): asserts value is CourtRecoveryEnvelopeV1 {
  if (!isRecord(value)) {
    fail('malformed', 'recovery envelope must be an object');
  }
  assertExactKeys(
    value,
    ['version', 'cryptoSuite', 'sessionHash', 'jurorPubkey', 'createdAt', 'ciphertext'],
    'recovery envelope',
    'malformed',
  );
  assertSafeInteger(value.version, 'envelope.version', 0, 'malformed');
  if (value.version !== COURT_RECOVERY_ENVELOPE_VERSION) {
    fail('unsupported_version', `unsupported recovery envelope version ${value.version}`);
  }
  if (typeof value.cryptoSuite !== 'string') {
    fail('malformed', 'envelope.cryptoSuite must be a string');
  }
  if (value.cryptoSuite !== COURT_RECOVERY_LEGACY_SUITE) {
    fail('unsupported_suite', `unsupported recovery crypto suite ${value.cryptoSuite}`);
  }
  assertHex32(value.sessionHash, 'envelope.sessionHash', 'malformed');
  assertHex32(value.jurorPubkey, 'envelope.jurorPubkey', 'malformed');
  assertSafeInteger(value.createdAt, 'envelope.createdAt', 0, 'malformed');
  if (now !== undefined && value.createdAt > now + MAX_CREATED_AT_SKEW_SECONDS) {
    fail('malformed', 'envelope.createdAt is implausibly far in the future');
  }
  if (
    typeof value.ciphertext !== 'string'
    || value.ciphertext.length === 0
    || value.ciphertext.length > MAX_CIPHERTEXT_BYTES
  ) {
    fail('malformed', 'envelope.ciphertext must be a non-empty bounded string');
  }
}

/**
 * Validate and normalize a decrypted payload into a fresh core object plus
 * its claimed integrity hash. Nothing here trusts the payload — this only
 * establishes that it is well-formed enough to recompute over.
 */
function normalizePayload(value: unknown): {
  readonly core: CourtRecoveryPayloadCoreV1;
  readonly integrityHash: string;
} {
  if (!isRecord(value)) {
    fail('malformed', 'recovery payload must be an object');
  }
  assertExactKeys(
    value,
    [
      'version',
      'cryptoSuite',
      'sessionHash',
      'sessionParameters',
      'jurorIdx',
      'jurorNostrPubkey',
      'dkgRecord',
      'localShareSeckey',
      'backedUpAt',
      'integrityHash',
    ],
    'recovery payload',
    'malformed',
  );
  assertSafeInteger(value.version, 'payload.version', 0, 'malformed');
  if (value.version !== COURT_RECOVERY_ENVELOPE_VERSION) {
    fail('unsupported_version', `unsupported recovery payload version ${value.version}`);
  }
  if (typeof value.cryptoSuite !== 'string') {
    fail('malformed', 'payload.cryptoSuite must be a string');
  }
  if (value.cryptoSuite !== COURT_RECOVERY_LEGACY_SUITE) {
    fail('unsupported_suite', `unsupported recovery crypto suite ${value.cryptoSuite}`);
  }
  assertHex32(value.sessionHash, 'payload.sessionHash', 'malformed');
  const sessionParameters = normalizeSessionParameters(value.sessionParameters);
  assertSafeInteger(value.jurorIdx, 'payload.jurorIdx', 1, 'malformed');
  assertHex32(value.jurorNostrPubkey, 'payload.jurorNostrPubkey', 'malformed');
  const record = normalizeDkgRecord(value.dkgRecord);
  assertHex32(value.localShareSeckey, 'payload.localShareSeckey', 'invalid_share_scalar');
  assertSafeInteger(value.backedUpAt, 'payload.backedUpAt', 0, 'malformed');
  assertHex32(value.integrityHash, 'payload.integrityHash', 'malformed');
  return {
    core: {
      version: COURT_RECOVERY_ENVELOPE_VERSION,
      cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
      sessionHash: value.sessionHash,
      sessionParameters,
      jurorIdx: value.jurorIdx,
      jurorNostrPubkey: value.jurorNostrPubkey,
      dkgRecord: record as DkgRecord,
      localShareSeckey: value.localShareSeckey,
      backedUpAt: value.backedUpAt,
    },
    integrityHash: value.integrityHash,
  };
}

/**
 * The certification battery shared by creation and restore: structural record
 * validation, record/session binding, and full curve recomputation using the
 * SAME functions `dkg.ts` and `independentDkg.computeKey()` use
 * (`evaluateCommitments`, the `Point.ZERO` fold, `pointToXOnlyHex`). Returns a
 * reconstructed record whose group key and verification shares come from the
 * recomputed points — never from the claimed record.
 */
function certifyDkgMaterial(params: {
  readonly sessionParameters: CourtSessionParameters;
  readonly record: unknown;
  readonly jurorIdx: number;
  readonly localShareSeckey: string;
}): DkgRecord {
  const session = params.sessionParameters;
  const roster = session.participants;
  const record = normalizeDkgRecord(params.record);
  const n = roster.length;

  if (
    record.verificationShares.length !== record.participants
    || record.jurorPubkeys.length !== record.participants
    || record.vssCommitments.length !== record.participants
  ) {
    fail('dkg_record_malformed', 'dkgRecord arrays must each contain `participants` entries');
  }
  record.verificationShares.forEach((entry, offset) => {
    if (entry.idx !== offset + 1) {
      fail('dkg_record_malformed', 'verification share indices must be exactly 1..n in order');
    }
  });
  record.vssCommitments.forEach((entry, offset) => {
    if (entry.idx !== offset + 1) {
      fail('dkg_record_malformed', 'VSS commitment indices must be exactly 1..n in order');
    }
    if (entry.commits.length !== record.threshold) {
      fail('dkg_record_malformed', 'each VSS commitment set must contain `threshold` commits');
    }
  });

  if (
    record.marketId !== session.marketId
    || record.disputeId !== session.disputeId
    || record.threshold !== session.threshold
    || record.participants !== n
  ) {
    fail('record_session_mismatch', 'dkgRecord does not match the session parameters');
  }
  record.jurorPubkeys.forEach((pubkey, offset) => {
    if (pubkey !== roster[offset].nostrPubkey) {
      fail('dkg_record_malformed', 'dkgRecord.jurorPubkeys must match the session roster');
    }
  });
  record.vssCommitments.forEach((entry, offset) => {
    if (entry.pubkey !== roster[offset].nostrPubkey) {
      fail('dkg_record_malformed', 'dkgRecord.vssCommitments pubkeys must match the session roster');
    }
  });

  let commitmentPoints: CurvePoint[][];
  try {
    commitmentPoints = record.vssCommitments.map((entry) =>
      entry.commits.map((commit) => Point.fromHex(commit)),
    );
  } catch {
    fail('invalid_curve_point', 'a VSS commitment is not a valid secp256k1 point');
  }

  let groupPoint: CurvePoint;
  try {
    groupPoint = commitmentPoints.reduce(
      (sum, commits) => sum.add(commits[0]),
      Point.ZERO,
    );
  } catch {
    fail('invalid_curve_point', 'group-key recomputation hit an invalid curve point');
  }
  // Serializing the identity throws an untyped noble error — a forged
  // commitment set that sums to infinity must fail typed and closed.
  if (groupPoint.equals(Point.ZERO)) {
    fail('group_key_mismatch', 'recomputed group key is the point at infinity');
  }
  const groupPubkey = groupPoint.toHex(true);
  const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
  if (groupPubkey !== record.groupPubkey || groupPubkeyXOnly !== record.groupPubkeyXOnly) {
    fail('group_key_mismatch', 'claimed group key does not match the recomputed VSS commitments');
  }

  let verificationPoints: CurvePoint[];
  try {
    verificationPoints = roster.map((participant) => {
      const idx = BigInt(participant.idx);
      return commitmentPoints.reduce(
        (sum, commits) => sum.add(evaluateCommitments(commits, idx)),
        Point.ZERO,
      );
    });
  } catch {
    fail('invalid_curve_point', 'verification-share recomputation hit an invalid curve point');
  }
  verificationPoints.forEach((point) => {
    if (point.equals(Point.ZERO)) {
      fail(
        'verification_share_mismatch',
        'a recomputed verification share is the point at infinity',
      );
    }
  });
  const verificationShares = roster.map((participant, offset) => ({
    idx: participant.idx,
    pubkey: pointToXOnlyHex(verificationPoints[offset]),
  }));
  verificationShares.forEach((entry, offset) => {
    if (entry.pubkey !== record.verificationShares[offset].pubkey) {
      fail(
        'verification_share_mismatch',
        `verification share for juror ${entry.idx} does not match the recomputed commitments`,
      );
    }
  });

  assertHex32(params.localShareSeckey, 'localShareSeckey', 'invalid_share_scalar');
  const scalar = BigInt(`0x${params.localShareSeckey}`);
  if (scalar <= 0n || scalar >= CURVE_ORDER) {
    fail('invalid_share_scalar', 'local share is not a canonical secp256k1 scalar');
  }
  if (params.jurorIdx < 1 || params.jurorIdx > n) {
    fail('roster_binding_mismatch', 'jurorIdx is outside the session roster');
  }
  // Full-point comparison: an x-only check would certify the negated share
  // (n - s), which produces invalid partial signatures under the recorded
  // group key. The recomputed point carries the correct parity.
  if (!Point.BASE.multiply(scalar).equals(verificationPoints[params.jurorIdx - 1])) {
    fail(
      'local_share_mismatch',
      'local secret share does not derive the recomputed verification share',
    );
  }

  return {
    marketId: session.marketId,
    disputeId: session.disputeId,
    threshold: session.threshold,
    participants: n,
    groupPubkey,
    groupPubkeyXOnly,
    verificationShares,
    jurorPubkeys: roster.map((participant) => participant.nostrPubkey),
    vssCommitments: record.vssCommitments.map((entry) => ({
      idx: entry.idx,
      pubkey: entry.pubkey,
      commits: [...entry.commits],
    })),
  };
}

async function signerPubkey(signer: CourtEventSigner): Promise<string> {
  let pubkey: string;
  try {
    pubkey = await signer.getPublicKey();
  } catch {
    fail('malformed', 'signer did not return a usable public key');
  }
  assertHex32(pubkey, 'signer pubkey', 'malformed');
  return pubkey;
}

/**
 * Create a certified legacy recovery envelope for the local juror's share.
 *
 * Certify-before-backup: the same recomputation battery as restore runs over
 * the supplied record/share/session BEFORE anything is encrypted — this
 * module never encrypts state it would later reject. The payload is NIP-44
 * encrypted to the juror's own pubkey through the signer interface only.
 *
 * The returned envelope is a fresh deep copy; the share exists only inside
 * the ciphertext. `now` is the injected clock stamped into `createdAt` and
 * `backedUpAt` (both informational).
 */
export async function createCourtRecoveryEnvelope(params: {
  readonly signer: CourtEventSigner;
  /** Independently sourced session parameters for the attempt being backed up. */
  readonly sessionParameters: CourtSessionParameters;
  /** The DKG record produced by the certified ceremony. */
  readonly record: DkgRecord;
  /** The local juror's FROST share. */
  readonly share: CourtRecoveredShare;
  /** Injected clock (Unix seconds). */
  readonly now: number;
}): Promise<CourtRecoveryEnvelopeV1> {
  assertNow(params.now);
  const sessionParameters = normalizeSessionParameters(params.sessionParameters);
  const ownerPubkey = await signerPubkey(params.signer);

  assertSafeInteger(params.share?.idx, 'share.idx', 1, 'malformed');
  if (params.share.idx > sessionParameters.participants.length) {
    fail('roster_binding_mismatch', 'share.idx is outside the session roster');
  }
  const rosterEntry = sessionParameters.participants[params.share.idx - 1];
  if (rosterEntry.nostrPubkey !== ownerPubkey) {
    fail('roster_binding_mismatch', 'signer pubkey does not match the roster entry for share.idx');
  }
  assertHex32(params.share.seckey, 'share.seckey', 'invalid_share_scalar');

  const record = certifyDkgMaterial({
    sessionParameters,
    record: params.record,
    jurorIdx: params.share.idx,
    localShareSeckey: params.share.seckey,
  });

  const sessionHash = hashCourtSessionParameters(sessionParameters);
  const core: CourtRecoveryPayloadCoreV1 = {
    version: COURT_RECOVERY_ENVELOPE_VERSION,
    cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
    sessionHash,
    sessionParameters,
    jurorIdx: params.share.idx,
    jurorNostrPubkey: ownerPubkey,
    dkgRecord: record,
    localShareSeckey: params.share.seckey,
    backedUpAt: params.now,
  };
  const payload: CourtRecoveryPayloadV1 = {
    ...core,
    integrityHash: hashCourtRecoveryPayload(core),
  };
  const plaintext = serializeCourtRecoveryPayloadV1(payload);

  let ciphertext: string;
  try {
    ciphertext = await params.signer.nip44Encrypt(ownerPubkey, plaintext);
  } catch {
    fail('encrypt_failed', 'signer failed to NIP-44 encrypt the recovery payload');
  }
  // Certify-before-backup extends to transport: never emit an envelope the
  // restore path would reject as oversized.
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    fail('malformed', 'recovery payload exceeds the maximum ciphertext size');
  }

  return {
    version: COURT_RECOVERY_ENVELOPE_VERSION,
    cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
    sessionHash,
    jurorPubkey: ownerPubkey,
    createdAt: params.now,
    ciphertext,
  };
}

/**
 * Restore a legacy FROST share from a recovery envelope by FULL
 * RECOMPUTATION. Self-decryption is never sufficient for trust: every claim
 * in the decrypted payload is re-derived and re-verified against the
 * independently supplied session parameters and the curve math itself.
 *
 * Exact fail-closed sequence (each step throws the listed code):
 * outer structure (`malformed`/`unsupported_version`/`unsupported_suite`,
 * `createdAt > now + 300` rejected), identity gate (`wrong_identity`),
 * decrypt (`decrypt_failed`), payload structure (`malformed`/...), integrity
 * recomputation (`integrity_mismatch`), outer/inner binding
 * (`envelope_binding_mismatch`), session self-consistency
 * (`session_invalid`/`session_hash_mismatch`), independent session binding
 * (`wrong_session`/`session_parameters_mismatch`), roster binding
 * (`identity_not_in_roster`/`roster_binding_mismatch`), DKG record structure
 * (`dkg_record_malformed`/`record_session_mismatch`), full curve
 * recomputation (`invalid_curve_point`/`group_key_mismatch`/
 * `verification_share_mismatch`/`invalid_share_scalar`/`local_share_mismatch`),
 * optional certificate anchor (`certificate_mismatch`).
 *
 * `params.sessionParameters` must be reconstructed independently (dispute /
 * selection / block events) — NEVER taken from the envelope. `params.now` is
 * the required injected clock. The recovered share is the only secret output;
 * see the warning on {@link CourtRecoveredShare}.
 */
export async function restoreCourtRecovery(
  envelope: unknown,
  params: {
    readonly signer: CourtEventSigner;
    /** Independently sourced session parameters; NEVER from the envelope. */
    readonly sessionParameters: CourtSessionParameters;
    /** Optional certification anchor (transcript certificate reference). */
    readonly certificate?: CourtRecoveryCertificateRef;
    /** Injected clock (Unix seconds); required. */
    readonly now: number;
  },
): Promise<CourtRecoveredDkg> {
  assertNow(params.now);

  // 1. Outer structure.
  assertEnvelopeShape(envelope, params.now);

  // 2. Identity gate: another juror's backup, or the wrong signer/device.
  const ownerPubkey = await signerPubkey(params.signer);
  if (envelope.jurorPubkey !== ownerPubkey) {
    fail('wrong_identity', 'envelope belongs to a different juror identity');
  }

  // 3. Decrypt through the signer only.
  let plaintext: string;
  try {
    plaintext = await params.signer.nip44Decrypt(ownerPubkey, envelope.ciphertext);
  } catch {
    fail('decrypt_failed', 'recovery ciphertext does not decrypt for this signer');
  }

  // 4. Payload structure.
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    fail('malformed', 'recovery payload is not valid JSON');
  }
  const { core, integrityHash } = normalizePayload(parsed);

  // 5. Integrity: recompute the domain hash over the canonical encoding.
  const recomputedIntegrity = hashCourtRecoveryPayload(core);
  if (!equalHexConstantTime(recomputedIntegrity, integrityHash)) {
    fail('integrity_mismatch', 'recovery payload integrity hash does not match its contents');
  }

  // 6. Outer/inner binding: reject spliced wrappers.
  if (
    envelope.sessionHash !== core.sessionHash
    || envelope.cryptoSuite !== core.cryptoSuite
    || envelope.jurorPubkey !== core.jurorNostrPubkey
  ) {
    fail('envelope_binding_mismatch', 'outer envelope does not match the encrypted payload');
  }

  // 7. Session self-consistency of the embedded parameters.
  const embeddedSessionHash = hashCourtSessionParameters(core.sessionParameters);
  if (embeddedSessionHash !== core.sessionHash) {
    fail('session_hash_mismatch', 'embedded session parameters do not hash to the claimed session hash');
  }

  // 8. Independent session binding — the replay/superseded-epoch kill switch.
  const hostSession = normalizeSessionParameters(params.sessionParameters);
  if (hashCourtSessionParameters(hostSession) !== core.sessionHash) {
    fail('wrong_session', 'envelope belongs to a different dispute, attempt, or epoch');
  }
  if (
    !equalBytes(
      encodeCourtSessionParameters(hostSession),
      encodeCourtSessionParameters(core.sessionParameters),
    )
  ) {
    fail('session_parameters_mismatch', 'embedded session parameters differ from the independent copy');
  }

  // 9. Roster binding.
  const roster = hostSession.participants;
  const rosterEntry = roster.find((participant) => participant.nostrPubkey === ownerPubkey);
  if (!rosterEntry) {
    fail('identity_not_in_roster', 'signer identity is not in this session roster');
  }
  if (core.jurorIdx > roster.length || roster[core.jurorIdx - 1].nostrPubkey !== ownerPubkey) {
    fail('roster_binding_mismatch', 'jurorIdx does not bind the signer identity to the roster');
  }
  if (core.jurorNostrPubkey !== ownerPubkey) {
    fail('roster_binding_mismatch', 'payload juror identity does not match the signer');
  }

  // 10-11. DKG record structure + full curve recomputation.
  const record = certifyDkgMaterial({
    sessionParameters: hostSession,
    record: core.dkgRecord,
    jurorIdx: core.jurorIdx,
    localShareSeckey: core.localShareSeckey,
  });

  // 12. Optional certificate anchor.
  if (params.certificate !== undefined) {
    const certificate = params.certificate;
    if (!isRecord(certificate)) {
      fail('malformed', 'certificate must be an object');
    }
    assertExactKeys(
      certificate,
      ['sessionHash', 'groupPubkey', 'transcriptHash'],
      'certificate',
      'malformed',
    );
    assertHex32(certificate.sessionHash, 'certificate.sessionHash', 'malformed');
    assertCompressedKey(certificate.groupPubkey, 'certificate.groupPubkey', 'malformed');
    if (certificate.transcriptHash !== undefined) {
      assertHex32(certificate.transcriptHash, 'certificate.transcriptHash', 'malformed');
    }
    if (certificate.sessionHash !== core.sessionHash) {
      fail('certificate_mismatch', 'certificate binds to a different session');
    }
    if (certificate.groupPubkey !== record.groupPubkey) {
      fail('certificate_mismatch', 'certificate group key does not match the recomputed group key');
    }
  }

  // 13. Emit: host-supplied session, recomputed record, and the only secret.
  return {
    sessionParameters: structuredClone(hostSession),
    jurorIdx: core.jurorIdx,
    record,
    share: { idx: core.jurorIdx, seckey: core.localShareSeckey },
  };
}

interface NostrEventLike {
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly pubkey?: string;
  readonly created_at?: number;
  readonly id?: string;
}

/** Canonical JSON form of an outer envelope (fixed key order). */
function envelopeJson(envelope: CourtRecoveryEnvelopeV1): string {
  return JSON.stringify({
    version: envelope.version,
    cryptoSuite: envelope.cryptoSuite,
    sessionHash: envelope.sessionHash,
    jurorPubkey: envelope.jurorPubkey,
    createdAt: envelope.createdAt,
    ciphertext: envelope.ciphertext,
  });
}

/**
 * Build an unsigned kind-39100 event template carrying a recovery envelope.
 * The `['v', 'recovery-envelope:1']` tag discriminates it from legacy
 * un-versioned share backups and host-key backups on the same kind. The host
 * gift-wraps the event to itself via the Phase 4 outbox; this module never
 * publishes and never verifies relay-served Nostr signatures. `params.now` is
 * the required injected clock for `created_at`.
 */
export function buildCourtRecoveryEnvelopeEvent(
  envelope: CourtRecoveryEnvelopeV1,
  params: {
    readonly disputeId: string;
    readonly jurorIdx: number;
    readonly now: number;
  },
): EventTemplate {
  assertNow(params.now);
  assertEnvelopeShape(envelope);
  assertCanonicalText(params.disputeId, 'disputeId', 'malformed');
  assertSafeInteger(params.jurorIdx, 'jurorIdx', 1, 'malformed');
  return {
    kind: COURT_RECOVERY_ENVELOPE_KIND,
    created_at: params.now,
    tags: [
      ['d', `${params.disputeId}:recovery:${params.jurorIdx}`],
      ['e', params.disputeId, '', 'root'],
      ['dispute', params.disputeId],
      ['session', envelope.sessionHash],
      ['suite', envelope.cryptoSuite],
      ['juror', String(params.jurorIdx), envelope.jurorPubkey],
      ['v', RECOVERY_ENVELOPE_TAG],
      ['alt', `BAO Court legacy recovery envelope for juror ${params.jurorIdx}`],
    ],
    content: envelopeJson(envelope),
  };
}

/**
 * Parse a candidate kind-39100 event into a recovery envelope, or return
 * null. Discrimination only — legacy un-versioned backups, host-key backups
 * (`['v', 'host-key-backup:1']`), wrong kinds, malformed contents, and
 * tag/content splices all return null. A parsed envelope is STILL untrusted;
 * all security decisions route through {@link restoreCourtRecovery}.
 */
export function parseCourtRecoveryEnvelopeEvent(
  event: NostrEventLike,
): CourtRecoveryEnvelopeV1 | null {
  try {
    if (!isRecord(event)) return null;
    if (event.kind !== COURT_RECOVERY_ENVELOPE_KIND) return null;
    if (!Array.isArray(event.tags)) return null;
    if (typeof event.content !== 'string' || event.content.length === 0) return null;
    const versionTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'v');
    if (!versionTag || versionTag[1] !== RECOVERY_ENVELOPE_TAG) return null;

    const content: unknown = JSON.parse(event.content);
    assertEnvelopeShape(content);

    const sessionTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'session');
    const suiteTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'suite');
    const jurorTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'juror');
    if (
      sessionTag?.[1] !== content.sessionHash
      || suiteTag?.[1] !== content.cryptoSuite
      || jurorTag?.[2] !== content.jurorPubkey
    ) {
      return null;
    }

    return {
      version: COURT_RECOVERY_ENVELOPE_VERSION,
      cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
      sessionHash: content.sessionHash,
      jurorPubkey: content.jurorPubkey,
      createdAt: content.createdAt,
      ciphertext: content.ciphertext,
    };
  } catch {
    return null;
  }
}
