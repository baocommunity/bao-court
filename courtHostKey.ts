// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Encrypted Court host-key lifecycle for the BAO Court ChillDKG upgrade.
 *
 * The Court host key is the long-lived secp256k1 key each juror uses for
 * ChillDKG transcript signatures, share encryption, and deterministic
 * recovery. This module owns its full lifecycle: CSPRNG generation, a
 * zeroizing secret handle ({@link CourtHostKey}), a NIP-44 self-encrypted
 * backup envelope with full restore-time recomputation, a public
 * identity<->host-key attestation that rides the existing juror candidacy
 * event (kind 39001) via `hostkey`/`supersedes` tags, rotation with a
 * supersession chain, and the roster-binding gate that runs before
 * `parameters_confirmed`.
 *
 * Two-secret doctrine: the host key is identity-adjacent material only. This
 * module contains no DKG/FROST share math and no settlement keeper-secret
 * code, and it must never import `courtRecovery.ts` (which owns the FROST
 * share recovery branch).
 *
 * No socket I/O and no storage: the module builds and parses event TEMPLATES.
 * Gift-wrapping and publication are the host's Phase 4 outbox concern. Every
 * time-dependent check takes an injected `now` (unix seconds); there is no
 * wall-clock access anywhere in this module.
 *
 * Secret hygiene (destroy / zeroize semantics — what JS can realistically
 * guarantee):
 *
 * - Guaranteed: the module's own Uint8Array is overwritten on destroy(); no
 *   module API ever returns the secret; post-destroy use fails closed.
 * - Best-effort: intermediate byte arrays created during backup encoding are
 *   zeroized in the same call frame.
 * - Not guaranteed in JS: immutable strings (the backup JSON, any hex the
 *   host derived) may persist until GC; JITs may keep copies in
 *   registers/spill slots; there is no mlock/core-dump protection. Hosts
 *   must therefore never stringify a CourtHostKey, never put it in TanStack
 *   Query/localStorage/devtools, and must scope its lifetime to the
 *   ceremony. The restore path minimizes string lifetime by zeroizing what
 *   it can and dropping references immediately.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';

import {
  CanonicalWriter,
  getCourtSessionParticipant,
  type CourtSessionParameters,
} from './courtSession';
import type { CourtEventSigner } from './courtSigner';
import { BAO_COURT_SHARE_BACKUP_KIND } from './dkgMessages';

/** Backup envelope/payload schema version. */
export const COURT_HOST_KEY_BACKUP_VERSION = 1 as const;
/** Attestation schema version. */
export const COURT_HOST_KEY_ATTESTATION_VERSION = 1 as const;
/** Canonical hash domain for the inner backup payload integrity hash. */
export const COURT_HOST_KEY_BACKUP_DOMAIN = 'BAO-Court/HostKeyBackup/v1';
/** Canonical hash domain for the outer backup envelope hash. */
export const COURT_HOST_KEY_BACKUP_ENVELOPE_DOMAIN = 'BAO-Court/HostKeyBackupEnvelope/v1';
/** Canonical hash domain for the attestation hash (preimage excludes `hostSignature`). */
export const COURT_HOST_KEY_ATTESTATION_DOMAIN = 'BAO-Court/HostKeyAttestation/v1';
/** Canonical hash domain for the rotation digest signed by the old host key. */
export const COURT_HOST_KEY_SUPERSESSION_DOMAIN = 'BAO-Court/HostKeySupersession/v1';

/** Discriminating `v` tag value for host-key backups on the shared self-backup kind. */
const HOST_KEY_BACKUP_TRANSPORT_TAG = 'host-key-backup:1';
/** Tolerated clock skew for backups restored on devices with unsynchronized clocks. */
const FUTURE_SKEW_SECONDS = 300;
const MAX_CIPHERTEXT_CHARS = 65_536;
const MAX_U32 = 0xffff_ffff;
const MAX_SAFE_U64 = Number.MAX_SAFE_INTEGER;

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const COMPRESSED_KEY = /^(02|03)[0-9a-f]{64}$/;

const textEncoder = new TextEncoder();

/** Machine-readable failure codes for every host-key operation. */
export type CourtHostKeyErrorCode =
  | 'malformed'
  | 'unsupported_version'
  | 'integrity_mismatch'
  | 'envelope_hash_mismatch'
  | 'wrong_identity'
  | 'key_mismatch'
  | 'invalid_signature'
  | 'event_signature_invalid'
  | 'tag_mismatch'
  | 'roster_binding_mismatch'
  | 'supersession_mismatch'
  | 'chain_conflict'
  | 'destroyed';

/** Typed error for every host-key failure; `code` is the machine-readable reason. */
export class CourtHostKeyError extends Error {
  readonly code: CourtHostKeyErrorCode;

  constructor(code: CourtHostKeyErrorCode, message: string) {
    super(message);
    this.name = 'CourtHostKeyError';
    this.code = code;
  }
}

function fail(code: CourtHostKeyErrorCode, message: string): never {
  throw new CourtHostKeyError(code, message);
}

/**
 * Read the signer's Nostr identity, failing typed and closed. The signer's
 * own error is never propagated: its message is signer-controlled and may
 * carry secret material it was handed.
 */
async function signerIdentity(signer: CourtEventSigner): Promise<string> {
  let pubkey: string;
  try {
    pubkey = await signer.getPublicKey();
  } catch {
    fail('malformed', 'signer did not return a usable public key');
  }
  assertHex32(pubkey, 'signer public key');
  return pubkey;
}

/**
 * Public outer host-key backup envelope. Indexable by the host (via
 * `hostPubkey`) without decrypting; `envelopeHash` commits to every field.
 */
export interface CourtHostKeyBackupEnvelope {
  readonly version: typeof COURT_HOST_KEY_BACKUP_VERSION;
  /** 32-byte hex Nostr identity that encrypted this backup to itself. */
  readonly ownerPubkey: string;
  /** 33-byte compressed hex Court host public key — public index. */
  readonly hostPubkey: string;
  /** NIP-44 v2 ciphertext, owner -> owner, of the inner payload record. */
  readonly ciphertext: string;
  /** 32-byte hex SHA-256 committing to version/ownerPubkey/hostPubkey/ciphertext. */
  readonly envelopeHash: string;
}

/**
 * Canonical public attestation binding a Nostr identity to a Court host key.
 * The `hostSignature` is by the NEW host key over the attestation hash; the
 * `supersedes.supersessionSignature` (rotation only) is by the OLD host key
 * over the supersession digest. Neither is forgeable by the other side.
 */
export interface CourtHostKeyAttestation {
  readonly version: typeof COURT_HOST_KEY_ATTESTATION_VERSION;
  /** Nostr identity pubkey (32-byte hex) — the juror. */
  readonly nostrPubkey: string;
  /** Court host public key (33-byte compressed hex). */
  readonly hostPubkey: string;
  /** Unix seconds; MUST equal the carrying event's `created_at`. */
  readonly createdAt: number;
  /** Rotation link; null for a first-generation key. */
  readonly supersedes: {
    /** Previous host key (33-byte compressed hex). */
    readonly hostPubkey: string;
    /** {@link hashCourtHostKeyAttestation} of the previous attestation. */
    readonly attestationHash: string;
    /** BIP-340 signature BY THE OLD host key over the supersession digest. */
    readonly supersessionSignature: string;
  } | null;
  /** BIP-340 signature BY THE NEW host key over this attestation's hash. */
  readonly hostSignature: string;
}

/** Result of {@link rotateCourtHostKey}: the fresh key plus its supersession attestation. */
export interface RotateCourtHostKeyResult {
  readonly key: CourtHostKey;
  readonly attestation: CourtHostKeyAttestation;
}

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
    fail('malformed', `${field} contains unsupported field ${unexpected}`);
  }
  for (const key of allowedKeys) {
    if (!(key in value)) {
      fail('malformed', `${field} is missing required field ${key}`);
    }
  }
}

function assertHex32(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    fail('malformed', `${field} must be 32-byte lowercase hex`);
  }
}

function assertHex64(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    fail('malformed', `${field} must be 64-byte lowercase hex`);
  }
}

function assertHostPubkey(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !COMPRESSED_KEY.test(value)) {
    fail('malformed', `${field} must be a lowercase compressed secp256k1 public key`);
  }
  try {
    secp256k1.Point.fromHex(value);
  } catch {
    fail('malformed', `${field} is not a valid secp256k1 point`);
  }
}

function assertU64(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_SAFE_U64
  ) {
    fail('malformed', `${field} must be a non-negative safe integer`);
  }
}

function assertVersion(value: unknown, expected: number, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('malformed', `${field} must be an integer version`);
  }
  if (value !== expected) {
    fail('unsupported_version', `${field} version ${value} is not supported`);
  }
}

function digestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = textEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/** X-only (BIP-340) hex form of a compressed secp256k1 public key. */
function xOnlyOf(compressedHex: string): string {
  return compressedHex.slice(2);
}

function schnorrVerifyHex(
  signatureHex: string,
  digestHex: string,
  xOnlyPubkeyHex: string,
): boolean {
  try {
    return schnorr.verify(
      hexToBytes(signatureHex),
      hexToBytes(digestHex),
      hexToBytes(xOnlyPubkeyHex),
    );
  } catch {
    return false;
  }
}

/**
 * Secret-side Court host-key handle. The secret has exactly one owner (this
 * object), is never returned by any API, and is zeroized by {@link destroy}.
 * All accessors and methods throw `CourtHostKeyError('destroyed')` after
 * destruction.
 */
export class CourtHostKey {
  /**
   * Runtime-private (`#`) so no reflection, enumeration, or casting trick can
   * reach the secret — the class surface provably never exposes it.
   */
  #seckey: Uint8Array;
  private readonly compressedPublicKeyHex: string;
  private readonly xOnlyHex: string;
  private readonly created: number;
  private isDestroyed = false;

  /**
   * @internal Construction is module-internal: hosts obtain instances only
   * from {@link generateCourtHostKey}, {@link restoreCourtHostKeyFromBackup},
   * or {@link rotateCourtHostKey}. The constructor validates and copies the
   * given bytes; the caller remains responsible for zeroizing its own copy.
   */
  constructor(seckey: Uint8Array, createdAt: number) {
    if (!(seckey instanceof Uint8Array) || seckey.length !== 32) {
      fail('malformed', 'host secret key must be 32 bytes');
    }
    assertU64(createdAt, 'createdAt');
    let compressed: Uint8Array;
    let xOnly: Uint8Array;
    try {
      compressed = secp256k1.getPublicKey(seckey, true);
      xOnly = schnorr.getPublicKey(seckey);
    } catch {
      fail('malformed', 'host secret key is not a valid secp256k1 scalar');
    }
    this.#seckey = new Uint8Array(seckey);
    this.compressedPublicKeyHex = bytesToHex(compressed);
    this.xOnlyHex = bytesToHex(xOnly);
    this.created = createdAt;
  }

  /** 33-byte compressed secp256k1 public key, lowercase hex (roster form). */
  get publicKeyHex(): string {
    this.assertLive();
    return this.compressedPublicKeyHex;
  }

  /** 32-byte x-only public key, lowercase hex (BIP-340 verification form). */
  get xOnlyPublicKeyHex(): string {
    this.assertLive();
    return this.xOnlyHex;
  }

  /** Unix seconds, from the injected clock at generation/restore. */
  get createdAt(): number {
    this.assertLive();
    return this.created;
  }

  /** Whether {@link destroy} has run. Readable after destruction. */
  get destroyed(): boolean {
    return this.isDestroyed;
  }

  /**
   * BIP-340 Schnorr signature (64-byte hex) over a 32-byte digest the module
   * itself computed. Module-internal contract: within this package only the
   * attestation/rotation paths call this method; hosts must never call it
   * with attacker-chosen digests. BIP-340's internal even-Y normalization
   * makes verification against the x-only key sound regardless of the
   * compressed key's parity byte.
   */
  signDigest(digest: Uint8Array): string {
    this.assertLive();
    if (!(digest instanceof Uint8Array) || digest.length !== 32) {
      fail('malformed', 'digest must be 32 bytes');
    }
    return bytesToHex(schnorr.sign(digest, this.#seckey));
  }

  /**
   * Create a NIP-44 self-encrypted backup envelope of this key for the
   * identity behind `signer`. This is the ONLY way the raw secret leaves the
   * instance, and it leaves only inside ciphertext: the transient byte copy
   * is zeroized in the same call frame and no accessor on this class ever
   * returns secret material. Signer errors are rethrown as typed
   * `CourtHostKeyError`s without the original message — a hostile signer's
   * error text is signer-controlled and may embed the plaintext it was
   * handed.
   */
  async createBackupEnvelope(signer: CourtEventSigner): Promise<CourtHostKeyBackupEnvelope> {
    this.assertLive();
    const ownerPubkey = await signerIdentity(signer);

    const seckeyBytes = new Uint8Array(this.#seckey);
    try {
      const preimage = {
        version: COURT_HOST_KEY_BACKUP_VERSION,
        ownerPubkey,
        hostPubkey: this.compressedPublicKeyHex,
        hostSeckey: bytesToHex(seckeyBytes),
        createdAt: this.created,
      };
      const payload: CourtHostKeyBackupPayload = {
        ...preimage,
        integrity: backupPayloadIntegrityOf(preimage),
      };
      // The JSON string holding the secret hex is an unavoidable JS transient
      // (module header); it is dropped immediately after encryption.
      let ciphertext: string;
      try {
        ciphertext = await signer.nip44Encrypt(ownerPubkey, JSON.stringify(payload));
      } catch {
        fail('malformed', 'signer failed to NIP-44 encrypt the host-key backup');
      }
      return freezeEnvelope({
        version: COURT_HOST_KEY_BACKUP_VERSION,
        ownerPubkey,
        hostPubkey: this.compressedPublicKeyHex,
        ciphertext,
        envelopeHash: envelopeHashOf({
          version: COURT_HOST_KEY_BACKUP_VERSION,
          ownerPubkey,
          hostPubkey: this.compressedPublicKeyHex,
          ciphertext,
        }),
      });
    } finally {
      seckeyBytes.fill(0);
    }
  }

  /** Best-effort zeroization (see module header). Idempotent. */
  destroy(): void {
    if (!this.isDestroyed) {
      this.#seckey.fill(0);
      this.isDestroyed = true;
    }
  }

  private assertLive(): void {
    if (this.isDestroyed) {
      fail('destroyed', 'Court host key has been destroyed');
    }
  }
}

/**
 * Generate a fresh Court host key from the CSPRNG. The compressed public key
 * is on-curve by construction. `now` is the injected clock (unix seconds)
 * recorded as the key's creation time.
 */
export function generateCourtHostKey(params: { readonly now: number }): CourtHostKey {
  if (!isRecord(params)) {
    fail('malformed', 'generation params must be an object');
  }
  assertU64(params.now, 'now');
  const raw = generateSecretKey();
  try {
    return new CourtHostKey(raw, params.now);
  } finally {
    raw.fill(0);
  }
}

/** Inner backup payload record; never exported — produced/consumed in-module only. */
interface CourtHostKeyBackupPayload {
  readonly version: typeof COURT_HOST_KEY_BACKUP_VERSION;
  readonly ownerPubkey: string;
  readonly hostPubkey: string;
  readonly hostSeckey: string;
  readonly createdAt: number;
  readonly integrity: string;
}

function assertBackupPayloadShape(value: unknown): asserts value is CourtHostKeyBackupPayload {
  if (!isRecord(value)) {
    fail('malformed', 'backup payload must be an object');
  }
  assertExactKeys(
    value,
    ['version', 'ownerPubkey', 'hostPubkey', 'hostSeckey', 'createdAt', 'integrity'],
    'backup payload',
  );
  assertVersion(value.version, COURT_HOST_KEY_BACKUP_VERSION, 'backup payload');
  assertHex32(value.ownerPubkey, 'backup payload ownerPubkey');
  assertHostPubkey(value.hostPubkey, 'backup payload hostPubkey');
  assertHex32(value.hostSeckey, 'backup payload hostSeckey');
  assertU64(value.createdAt, 'backup payload createdAt');
  assertHex32(value.integrity, 'backup payload integrity');
}

/** Canonical encoding of the backup payload preimage (everything except `integrity`). */
function encodeBackupPayloadPreimage(
  value: Omit<CourtHostKeyBackupPayload, 'integrity'>,
): Uint8Array {
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.ownerPubkey);
  writer.hex(value.hostPubkey);
  writer.hex(value.hostSeckey);
  writer.u64(value.createdAt);
  return writer.finish();
}

function backupPayloadIntegrityOf(
  value: Omit<CourtHostKeyBackupPayload, 'integrity'>,
): string {
  return digestDomain(COURT_HOST_KEY_BACKUP_DOMAIN, encodeBackupPayloadPreimage(value));
}

function assertBackupEnvelopeShape(
  value: unknown,
): asserts value is CourtHostKeyBackupEnvelope {
  if (!isRecord(value)) {
    fail('malformed', 'backup envelope must be an object');
  }
  assertExactKeys(
    value,
    ['version', 'ownerPubkey', 'hostPubkey', 'ciphertext', 'envelopeHash'],
    'backup envelope',
  );
  assertVersion(value.version, COURT_HOST_KEY_BACKUP_VERSION, 'backup envelope');
  assertHex32(value.ownerPubkey, 'backup envelope ownerPubkey');
  assertHostPubkey(value.hostPubkey, 'backup envelope hostPubkey');
  if (
    typeof value.ciphertext !== 'string'
    || value.ciphertext.length === 0
    || value.ciphertext.length > MAX_CIPHERTEXT_CHARS
  ) {
    fail('malformed', 'backup envelope ciphertext must be a non-empty bounded string');
  }
  assertHex32(value.envelopeHash, 'backup envelope envelopeHash');
}

function envelopeHashOf(value: {
  readonly version: number;
  readonly ownerPubkey: string;
  readonly hostPubkey: string;
  readonly ciphertext: string;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.ownerPubkey);
  writer.hex(value.hostPubkey);
  writer.text(value.ciphertext);
  return digestDomain(COURT_HOST_KEY_BACKUP_ENVELOPE_DOMAIN, writer.finish());
}

function freezeEnvelope(
  value: CourtHostKeyBackupEnvelope,
): CourtHostKeyBackupEnvelope {
  return Object.freeze({
    version: value.version,
    ownerPubkey: value.ownerPubkey,
    hostPubkey: value.hostPubkey,
    ciphertext: value.ciphertext,
    envelopeHash: value.envelopeHash,
  });
}

/**
 * Create a NIP-44 self-encrypted backup of `key` for the identity behind
 * `signer`. The secret transits as plaintext only inside the signer's NIP-44
 * session-key derivation; intermediate byte copies are zeroized before
 * return (see the module header for the honest JS guarantee limits).
 */
export async function createCourtHostKeyBackup(
  key: CourtHostKey,
  signer: CourtEventSigner,
): Promise<CourtHostKeyBackupEnvelope> {
  if (!(key instanceof CourtHostKey)) {
    fail('malformed', 'key must be a CourtHostKey');
  }
  return key.createBackupEnvelope(signer);
}

/**
 * Restore a Court host key from its backup envelope. Every check is a
 * recomputation, never a trust decision, in a strictly ordered sequence:
 * envelope shape, outer envelope hash, signer-identity match, NIP-44
 * decrypt, payload shape, payload integrity, secret->public key derivation
 * cross-checked against BOTH the payload and the envelope, and a
 * future-dated `createdAt` rejection (with a 300-second clock-skew
 * tolerance under the injected `now`). The first failure throws; nothing is
 * partially trusted.
 */
export async function restoreCourtHostKeyFromBackup(
  envelope: unknown,
  signer: CourtEventSigner,
  params: { readonly now: number },
): Promise<CourtHostKey> {
  if (!isRecord(params)) {
    fail('malformed', 'restore params must be an object');
  }
  assertU64(params.now, 'now');
  assertBackupEnvelopeShape(envelope);
  if (envelopeHashOf(envelope) !== envelope.envelopeHash) {
    fail('envelope_hash_mismatch', 'backup envelope hash does not match its contents');
  }

  const ownerPubkey = await signerIdentity(signer);
  if (ownerPubkey !== envelope.ownerPubkey) {
    fail('wrong_identity', 'backup belongs to a different Nostr identity');
  }

  let json: string;
  try {
    json = await signer.nip44Decrypt(ownerPubkey, envelope.ciphertext);
  } catch {
    fail('malformed', 'backup does not decrypt for this signer');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('malformed', 'backup payload is not valid JSON');
  }
  assertBackupPayloadShape(parsed);
  if (backupPayloadIntegrityOf(parsed) !== parsed.integrity) {
    fail('integrity_mismatch', 'backup payload integrity hash does not match its contents');
  }

  // Recompute, never trust: the decrypted secret must derive the recorded
  // host key, and inner and outer records must agree on everything.
  let derivedHostPubkey: string;
  try {
    derivedHostPubkey = bytesToHex(secp256k1.getPublicKey(hexToBytes(parsed.hostSeckey), true));
  } catch {
    fail('key_mismatch', 'backup secret is not a valid secp256k1 scalar');
  }
  if (derivedHostPubkey !== parsed.hostPubkey) {
    fail('key_mismatch', 'backup secret does not derive the recorded host public key');
  }
  if (parsed.hostPubkey !== envelope.hostPubkey) {
    fail('key_mismatch', 'inner payload and outer envelope host public keys disagree');
  }
  if (parsed.ownerPubkey !== envelope.ownerPubkey) {
    fail('key_mismatch', 'inner payload and outer envelope owner public keys disagree');
  }
  if (parsed.createdAt > params.now + FUTURE_SKEW_SECONDS) {
    fail('malformed', 'backup is dated in the future');
  }

  const seckeyBytes = hexToBytes(parsed.hostSeckey);
  try {
    return new CourtHostKey(seckeyBytes, parsed.createdAt);
  } finally {
    seckeyBytes.fill(0);
  }
}

type CourtHostKeySupersession = NonNullable<CourtHostKeyAttestation['supersedes']>;

/** Attestation preimage: every committed field; the hash excludes `hostSignature`. */
interface CourtHostKeyAttestationPreimage {
  readonly version: typeof COURT_HOST_KEY_ATTESTATION_VERSION;
  readonly nostrPubkey: string;
  readonly hostPubkey: string;
  readonly createdAt: number;
  readonly supersedes: CourtHostKeySupersession | null;
}

function assertSupersessionShape(value: unknown): asserts value is CourtHostKeySupersession {
  if (!isRecord(value)) {
    fail('malformed', 'attestation supersedes must be an object or null');
  }
  assertExactKeys(
    value,
    ['hostPubkey', 'attestationHash', 'supersessionSignature'],
    'attestation supersedes',
  );
  assertHostPubkey(value.hostPubkey, 'attestation supersedes hostPubkey');
  assertHex32(value.attestationHash, 'attestation supersedes attestationHash');
  assertHex64(value.supersessionSignature, 'attestation supersedes supersessionSignature');
}

function assertAttestationPreimageShape(
  value: unknown,
): asserts value is CourtHostKeyAttestationPreimage {
  if (!isRecord(value)) {
    fail('malformed', 'attestation must be an object');
  }
  assertVersion(value.version, COURT_HOST_KEY_ATTESTATION_VERSION, 'attestation');
  assertHex32(value.nostrPubkey, 'attestation nostrPubkey');
  assertHostPubkey(value.hostPubkey, 'attestation hostPubkey');
  assertU64(value.createdAt, 'attestation createdAt');
  if (value.supersedes !== null) {
    assertSupersessionShape(value.supersedes);
  }
}

/**
 * Strict validator for untrusted attestation input: exact keys, version,
 * hex forms, on-curve host keys, and nested supersession shape.
 */
export function assertCourtHostKeyAttestation(
  value: unknown,
): asserts value is CourtHostKeyAttestation {
  if (!isRecord(value)) {
    fail('malformed', 'attestation must be an object');
  }
  assertExactKeys(
    value,
    ['version', 'nostrPubkey', 'hostPubkey', 'createdAt', 'supersedes', 'hostSignature'],
    'attestation',
  );
  assertAttestationPreimageShape(value);
  assertHex64(value.hostSignature, 'attestation hostSignature');
}

function encodeAttestationPreimage(value: CourtHostKeyAttestationPreimage): Uint8Array {
  assertAttestationPreimageShape(value);
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.nostrPubkey);
  writer.hex(value.hostPubkey);
  writer.u64(value.createdAt);
  writer.u8(value.supersedes === null ? 0 : 1);
  if (value.supersedes !== null) {
    writer.hex(value.supersedes.hostPubkey);
    writer.hex(value.supersedes.attestationHash);
    writer.hex(value.supersedes.supersessionSignature);
  }
  return writer.finish();
}

/**
 * Canonical binary encoding of the attestation PREIMAGE under
 * 'BAO-Court/HostKeyAttestation/v1'. By design this excludes `hostSignature`
 * (the host key signs the hash of this preimage; the signature is stored
 * alongside). The supersession signature IS inside the preimage, since it is
 * made by a different key before the new key signs.
 */
export function encodeCourtHostKeyAttestation(value: CourtHostKeyAttestation): Uint8Array {
  assertCourtHostKeyAttestation(value);
  return encodeAttestationPreimage(value);
}

/**
 * Derive the lowercase SHA-256 attestation identifier. The preimage excludes
 * `hostSignature` — see {@link encodeCourtHostKeyAttestation}.
 */
export function hashCourtHostKeyAttestation(value: CourtHostKeyAttestation): string {
  return digestDomain(COURT_HOST_KEY_ATTESTATION_DOMAIN, encodeCourtHostKeyAttestation(value));
}

function hashAttestationPreimage(value: CourtHostKeyAttestationPreimage): string {
  return digestDomain(COURT_HOST_KEY_ATTESTATION_DOMAIN, encodeAttestationPreimage(value));
}

/**
 * Supersession digest signed by the OLD host key at rotation. The preimage
 * binds the new attestation's identity tuple plus the rotation link —
 * u8(version), hex(nostrPubkey), hex(new hostPubkey), u64(createdAt),
 * hex(previous hostPubkey), hex(previous attestationHash) — under
 * 'BAO-Court/HostKeySupersession/v1'. It deliberately excludes the
 * supersession signature itself (that would be circular) and the new
 * attestation's `hostSignature` (not yet created).
 */
function supersessionDigestOf(value: {
  readonly version: number;
  readonly nostrPubkey: string;
  readonly hostPubkey: string;
  readonly createdAt: number;
  readonly previousHostPubkey: string;
  readonly previousAttestationHash: string;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.nostrPubkey);
  writer.hex(value.hostPubkey);
  writer.u64(value.createdAt);
  writer.hex(value.previousHostPubkey);
  writer.hex(value.previousAttestationHash);
  return digestDomain(COURT_HOST_KEY_SUPERSESSION_DOMAIN, writer.finish());
}

/** Verify every self-contained signature on an attestation. */
function assertAttestationSignatures(value: CourtHostKeyAttestation): void {
  const hash = hashCourtHostKeyAttestation(value);
  if (!schnorrVerifyHex(value.hostSignature, hash, xOnlyOf(value.hostPubkey))) {
    fail('invalid_signature', 'host signature does not verify against the attested host key');
  }
  if (value.supersedes !== null) {
    const digest = supersessionDigestOf({
      version: value.version,
      nostrPubkey: value.nostrPubkey,
      hostPubkey: value.hostPubkey,
      createdAt: value.createdAt,
      previousHostPubkey: value.supersedes.hostPubkey,
      previousAttestationHash: value.supersedes.attestationHash,
    });
    if (
      !schnorrVerifyHex(
        value.supersedes.supersessionSignature,
        digest,
        xOnlyOf(value.supersedes.hostPubkey),
      )
    ) {
      fail('invalid_signature', 'supersession signature does not verify against the previous host key');
    }
  }
}

/** Verify a rotation link against its predecessor attestation. */
function assertSupersessionLink(
  value: CourtHostKeyAttestation,
  previous: CourtHostKeyAttestation,
): void {
  assertCourtHostKeyAttestation(previous);
  const supersedes = value.supersedes;
  if (supersedes === null) {
    fail('supersession_mismatch', 'attestation does not supersede the previous attestation');
  }
  if (supersedes.attestationHash !== hashCourtHostKeyAttestation(previous)) {
    fail('supersession_mismatch', 'supersession references a different previous attestation');
  }
  if (supersedes.hostPubkey !== previous.hostPubkey) {
    fail('supersession_mismatch', 'supersession references a different previous host key');
  }
  if (value.nostrPubkey !== previous.nostrPubkey) {
    fail('supersession_mismatch', 'rotation must preserve the Nostr identity');
  }
  if (value.createdAt <= previous.createdAt) {
    fail('supersession_mismatch', 'attestation timestamps must strictly increase along a rotation chain');
  }
}

function freezeAttestation(
  value: CourtHostKeyAttestation,
): CourtHostKeyAttestation {
  return Object.freeze({
    version: value.version,
    nostrPubkey: value.nostrPubkey,
    hostPubkey: value.hostPubkey,
    createdAt: value.createdAt,
    supersedes: value.supersedes === null
      ? null
      : Object.freeze({
          hostPubkey: value.supersedes.hostPubkey,
          attestationHash: value.supersedes.attestationHash,
          supersessionSignature: value.supersedes.supersessionSignature,
        }),
    hostSignature: value.hostSignature,
  });
}

/**
 * Build (and freeze) an attestation for `key` bound to `nostrPubkey` at the
 * injected `now`. When `supersedes` is given (rotation), the previous host
 * key co-signs the supersession digest; the previous key must match the
 * previous attestation and the identity and monotonic-timestamp invariants
 * are enforced here as well as at verification.
 */
export function createCourtHostKeyAttestation(
  key: CourtHostKey,
  params: {
    readonly now: number;
    /** Must equal the identity signer's pubkey; the host checks this. */
    readonly nostrPubkey: string;
    readonly supersedes?: {
      /** Previous host key; signs the supersession digest. */
      readonly previousKey: CourtHostKey;
      readonly previousAttestation: CourtHostKeyAttestation;
    };
  },
): CourtHostKeyAttestation {
  if (!(key instanceof CourtHostKey)) {
    fail('malformed', 'key must be a CourtHostKey');
  }
  if (key.destroyed) {
    fail('destroyed', 'Court host key has been destroyed');
  }
  if (!isRecord(params)) {
    fail('malformed', 'attestation params must be an object');
  }
  assertU64(params.now, 'now');
  assertHex32(params.nostrPubkey, 'nostrPubkey');

  let supersedes: CourtHostKeySupersession | null = null;
  if (params.supersedes !== undefined) {
    const { previousKey, previousAttestation } = params.supersedes;
    if (!(previousKey instanceof CourtHostKey)) {
      fail('malformed', 'previousKey must be a CourtHostKey');
    }
    if (previousKey.destroyed) {
      fail('destroyed', 'previous Court host key has been destroyed');
    }
    assertCourtHostKeyAttestation(previousAttestation);
    if (previousKey.publicKeyHex !== previousAttestation.hostPubkey) {
      fail('supersession_mismatch', 'previous key does not match the previous attestation');
    }
    if (previousAttestation.nostrPubkey !== params.nostrPubkey) {
      fail('supersession_mismatch', 'rotation must preserve the Nostr identity');
    }
    if (params.now <= previousAttestation.createdAt) {
      fail('supersession_mismatch', 'rotation timestamp must be later than the previous attestation');
    }
    const previousHash = hashCourtHostKeyAttestation(previousAttestation);
    const digest = supersessionDigestOf({
      version: COURT_HOST_KEY_ATTESTATION_VERSION,
      nostrPubkey: params.nostrPubkey,
      hostPubkey: key.publicKeyHex,
      createdAt: params.now,
      previousHostPubkey: previousKey.publicKeyHex,
      previousAttestationHash: previousHash,
    });
    supersedes = {
      hostPubkey: previousKey.publicKeyHex,
      attestationHash: previousHash,
      supersessionSignature: previousKey.signDigest(hexToBytes(digest)),
    };
  }

  const preimage: CourtHostKeyAttestationPreimage = {
    version: COURT_HOST_KEY_ATTESTATION_VERSION,
    nostrPubkey: params.nostrPubkey,
    hostPubkey: key.publicKeyHex,
    createdAt: params.now,
    supersedes,
  };
  const hash = hashAttestationPreimage(preimage);
  return freezeAttestation({ ...preimage, hostSignature: key.signDigest(hexToBytes(hash)) });
}

/**
 * Tags to append to the juror candidacy (kind 39001) or capability event
 * template BEFORE `signer.signEvent`: the host-key attestation rides the
 * existing event, so no new event kind is minted. The verifier requires
 * exactly one `hostkey` tag and, when rotating, exactly one `supersedes`
 * tag whose values match the recomputed attestation hash.
 */
export function courtHostKeyAttestationTags(value: CourtHostKeyAttestation): string[][] {
  assertCourtHostKeyAttestation(value);
  const hash = hashCourtHostKeyAttestation(value);
  const tags: string[][] = [['hostkey', value.hostPubkey, hash, value.hostSignature]];
  if (value.supersedes !== null) {
    tags.push([
      'supersedes',
      value.supersedes.attestationHash,
      value.supersedes.hostPubkey,
      value.supersedes.supersessionSignature,
    ]);
  }
  return tags;
}

function reconstructEventForVerification(event: NostrEvent): NostrEvent {
  if (!isRecord(event)) {
    fail('malformed', 'carrying event must be an object');
  }
  assertHex32(event.id, 'event id');
  assertHex32(event.pubkey, 'event pubkey');
  assertHex64(event.sig, 'event sig');
  if (typeof event.kind !== 'number' || !Number.isSafeInteger(event.kind) || event.kind < 0 || event.kind > MAX_U32) {
    fail('malformed', 'event kind must be a non-negative safe integer');
  }
  assertU64(event.created_at, 'event created_at');
  if (typeof event.content !== 'string') {
    fail('malformed', 'event content must be a string');
  }
  if (!Array.isArray(event.tags)) {
    fail('malformed', 'event tags must be an array');
  }
  const tags = event.tags.map((tag, index) => {
    if (!Array.isArray(tag) || tag.some((element) => typeof element !== 'string')) {
      fail('malformed', `event tag ${index} must be an array of strings`);
    }
    return [...tag];
  });
  // Reconstructed plain object with explicit field copies: finalizeEvent /
  // verifyEvent cache their verdict in a symbol that object spreads
  // preserve, so verification must never run over a spread or a
  // signer-returned object directly.
  return {
    id: event.id,
    pubkey: event.pubkey,
    sig: event.sig,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags,
  } as NostrEvent;
}

/**
 * Full verification of a carrying event + attestation pair.
 *
 * - Rebuilds the event as a plain object and `verifyEvent()`s it
 *   (cache-trap safe).
 * - Requires `event.pubkey === attestation.nostrPubkey` and
 *   `event.created_at === attestation.createdAt`.
 * - Requires exactly one `hostkey` tag (and, when the attestation
 *   supersedes, exactly one `supersedes` tag) whose values match the
 *   attestation and the RECOMPUTED attestation hash — never the carried
 *   one.
 * - Verifies `hostSignature` against the attested host key, and (when
 *   superseding) `supersessionSignature` against the PREVIOUS host key over
 *   the supersession digest. When `options.previousAttestation` is
 *   supplied, the supersession link is cross-checked against it.
 *
 * Returns a validated frozen deep copy; failures throw CourtHostKeyError.
 */
export function verifyCourtHostKeyAttestationEvent(
  event: NostrEvent,
  attestation: unknown,
  options?: { readonly previousAttestation?: CourtHostKeyAttestation },
): CourtHostKeyAttestation {
  assertCourtHostKeyAttestation(attestation);
  const candidate = reconstructEventForVerification(event);
  if (!verifyEvent(candidate)) {
    fail('event_signature_invalid', 'carrying Nostr event fails signature verification');
  }
  if (candidate.pubkey !== attestation.nostrPubkey) {
    fail('tag_mismatch', 'carrying event author does not match the attested Nostr identity');
  }
  if (candidate.created_at !== attestation.createdAt) {
    fail('tag_mismatch', 'carrying event created_at does not match the attestation');
  }

  const attestationHash = hashCourtHostKeyAttestation(attestation);
  const hostkeyTags = candidate.tags.filter((tag) => tag[0] === 'hostkey');
  if (hostkeyTags.length !== 1) {
    fail('tag_mismatch', 'exactly one hostkey tag is required');
  }
  const hostkeyTag = hostkeyTags[0];
  if (
    hostkeyTag.length !== 4
    || hostkeyTag[1] !== attestation.hostPubkey
    || hostkeyTag[2] !== attestationHash
    || hostkeyTag[3] !== attestation.hostSignature
  ) {
    fail('tag_mismatch', 'hostkey tag disagrees with the recomputed attestation');
  }

  const supersedesTags = candidate.tags.filter((tag) => tag[0] === 'supersedes');
  if (attestation.supersedes === null) {
    if (supersedesTags.length !== 0) {
      fail('tag_mismatch', 'first-generation attestation must not carry a supersedes tag');
    }
  } else {
    if (supersedesTags.length !== 1) {
      fail('tag_mismatch', 'exactly one supersedes tag is required for a rotation attestation');
    }
    const supersedesTag = supersedesTags[0];
    if (
      supersedesTag.length !== 4
      || supersedesTag[1] !== attestation.supersedes.attestationHash
      || supersedesTag[2] !== attestation.supersedes.hostPubkey
      || supersedesTag[3] !== attestation.supersedes.supersessionSignature
    ) {
      fail('tag_mismatch', 'supersedes tag disagrees with the attestation');
    }
  }

  assertAttestationSignatures(attestation);
  if (attestation.supersedes !== null && options?.previousAttestation !== undefined) {
    assertSupersessionLink(attestation, options.previousAttestation);
  }
  return freezeAttestation(attestation);
}

/**
 * Rotate to a fresh host key: generates a new key and returns it together
 * with a supersession attestation co-signed by the old key. The caller
 * decides whether to `destroy()` the old key (recommended once the new
 * backup and attestation are durably published). Because the session hash
 * commits `hostPubkey`, rotation is only valid BETWEEN ceremonies; a juror
 * that rotates must be re-rostered in a fresh attempt.
 */
export function rotateCourtHostKey(params: {
  readonly now: number;
  readonly previousKey: CourtHostKey;
  readonly previousAttestation: CourtHostKeyAttestation;
  readonly nostrPubkey: string;
}): RotateCourtHostKeyResult {
  if (!isRecord(params)) {
    fail('malformed', 'rotation params must be an object');
  }
  const key = generateCourtHostKey({ now: params.now });
  try {
    const attestation = createCourtHostKeyAttestation(key, {
      now: params.now,
      nostrPubkey: params.nostrPubkey,
      supersedes: {
        previousKey: params.previousKey,
        previousAttestation: params.previousAttestation,
      },
    });
    return { key, attestation };
  } catch (error) {
    key.destroy();
    throw error;
  }
}

/**
 * Validate a complete rotation chain in order: the first link must be a
 * first-generation attestation, every link's signatures must verify, and
 * every subsequent link must supersede its predecessor (hash, host key,
 * identity, and strictly increasing timestamps).
 */
export function assertCourtHostKeyChain(
  chain: readonly CourtHostKeyAttestation[],
): void {
  if (!Array.isArray(chain) || chain.length === 0) {
    fail('malformed', 'chain must be a non-empty array of attestations');
  }
  const first = chain[0];
  assertCourtHostKeyAttestation(first);
  if (first.supersedes !== null) {
    fail('supersession_mismatch', 'the first chain link must be a first-generation attestation');
  }
  assertAttestationSignatures(first);
  for (let index = 1; index < chain.length; index += 1) {
    const link = chain[index];
    assertCourtHostKeyAttestation(link);
    assertAttestationSignatures(link);
    assertSupersessionLink(link, chain[index - 1]);
  }
}

/**
 * Replay-safe chain-head resolution over an unordered set of published
 * attestations. Every attestation is fully validated (shape + signatures),
 * the set must contain exactly one first-generation attestation, every
 * supersession link must reference an attestation in the set, and exactly
 * one unreferenced head must remain. A relay or peer replaying an old
 * attestation loses to the chain head; two valid competing heads
 * (double-rotation) is `chain_conflict` and fails closed — the host must
 * treat the juror as unbound until the dispute is resolved out of band.
 */
export function resolveCurrentCourtHostKeyAttestation(
  attestations: readonly CourtHostKeyAttestation[],
): CourtHostKeyAttestation {
  if (!Array.isArray(attestations) || attestations.length === 0) {
    fail('malformed', 'attestations must be a non-empty array');
  }
  const byHash = new Map<string, CourtHostKeyAttestation>();
  for (const attestation of attestations) {
    assertCourtHostKeyAttestation(attestation);
    assertAttestationSignatures(attestation);
    const hash = hashCourtHostKeyAttestation(attestation);
    if (!byHash.has(hash)) {
      byHash.set(hash, attestation);
    }
  }

  const nodes = [...byHash.values()];
  const geneses = nodes.filter((node) => node.supersedes === null);
  if (geneses.length === 0) {
    fail('supersession_mismatch', 'the set contains no first-generation attestation');
  }
  if (geneses.length > 1) {
    fail('chain_conflict', 'the set contains multiple first-generation attestations');
  }

  const referenced = new Set<string>();
  for (const node of nodes) {
    if (node.supersedes === null) continue;
    const previous = byHash.get(node.supersedes.attestationHash);
    if (previous === undefined) {
      fail('supersession_mismatch', 'supersession references an attestation outside the set');
    }
    if (node.supersedes.hostPubkey !== previous.hostPubkey) {
      fail('supersession_mismatch', 'supersession references a different previous host key');
    }
    if (node.nostrPubkey !== previous.nostrPubkey) {
      fail('supersession_mismatch', 'rotation must preserve the Nostr identity');
    }
    if (node.createdAt <= previous.createdAt) {
      fail('supersession_mismatch', 'attestation timestamps must strictly increase along a rotation chain');
    }
    referenced.add(node.supersedes.attestationHash);
  }

  const heads = nodes.filter((node) => !referenced.has(hashCourtHostKeyAttestation(node)));
  if (heads.length !== 1) {
    fail('chain_conflict', 'the set contains competing attestation heads');
  }
  return freezeAttestation(heads[0]);
}

/**
 * Bind a VERIFIED attestation to a session roster entry: the roster
 * participant must exist and both the attested Nostr identity and host key
 * must match the committed entry. Runs in addition to the existing
 * `assertCourtParticipantBinding` (which binds a live protocol event's
 * author to the roster); the two compose — the protocol event proves "this
 * Nostr key acts as idx", the attestation proves "this Nostr key
 * legitimately owns the roster's host key". This gate runs per roster
 * member at `parameters_confirmed`, before `dkg_round_1`.
 */
export function assertRosterHostKeyBinding(
  params: CourtSessionParameters,
  idx: number,
  attestation: CourtHostKeyAttestation,
): void {
  assertCourtHostKeyAttestation(attestation);
  const participant = getCourtSessionParticipant(params, idx);
  if (attestation.nostrPubkey !== participant.nostrPubkey) {
    fail('roster_binding_mismatch', 'attested Nostr identity does not match the roster entry');
  }
  if (attestation.hostPubkey !== participant.hostPubkey) {
    fail('roster_binding_mismatch', 'attested host key does not match the roster entry');
  }
}

/** Minimal event shape the transport parser discriminates on. */
interface HostKeyBackupEventLike {
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly pubkey?: string;
  readonly created_at?: number;
  readonly id?: string;
}

/**
 * Build a kind 39100 self-backup event TEMPLATE carrying a host-key backup
 * envelope, discriminated from legacy share backups and recovery envelopes
 * by the `['v', 'host-key-backup:1']` tag and indexed by
 * `['hostkey', hostPubkey]`. The template must be gift-wrapped to the owner
 * and published by the host's outbox; this module performs no I/O.
 */
export function buildCourtHostKeyBackupEvent(
  envelope: CourtHostKeyBackupEnvelope,
  params: { readonly now: number },
): EventTemplate {
  if (!isRecord(params)) {
    fail('malformed', 'event params must be an object');
  }
  assertU64(params.now, 'now');
  assertBackupEnvelopeShape(envelope);
  if (envelopeHashOf(envelope) !== envelope.envelopeHash) {
    fail('envelope_hash_mismatch', 'backup envelope hash does not match its contents');
  }
  return {
    kind: BAO_COURT_SHARE_BACKUP_KIND,
    created_at: params.now,
    tags: [
      ['v', HOST_KEY_BACKUP_TRANSPORT_TAG],
      ['hostkey', envelope.hostPubkey],
    ],
    content: JSON.stringify(envelope),
  };
}

/**
 * Parse a kind 39100 event as a host-key backup envelope. Returns null for
 * anything that is not exactly this artifact — legacy share backups,
 * recovery envelopes, tampered hashes, and tag/content disagreements all
 * discriminate to null (matching `parseShareBackupEvent` semantics). All
 * security decisions route through the typed-error
 * {@link restoreCourtHostKeyFromBackup}; never parse-then-trust.
 */
export function parseCourtHostKeyBackupEvent(
  event: HostKeyBackupEventLike,
): CourtHostKeyBackupEnvelope | null {
  try {
    if (!isRecord(event) || event.kind !== BAO_COURT_SHARE_BACKUP_KIND) return null;
    if (!Array.isArray(event.tags)) return null;
    const vTags = event.tags.filter((tag) => Array.isArray(tag) && tag[0] === 'v');
    if (vTags.length !== 1 || vTags[0][1] !== HOST_KEY_BACKUP_TRANSPORT_TAG) return null;
    const hostkeyTags = event.tags.filter((tag) => Array.isArray(tag) && tag[0] === 'hostkey');
    if (hostkeyTags.length !== 1 || hostkeyTags[0].length !== 2) return null;
    if (typeof event.content !== 'string') return null;

    const parsed: unknown = JSON.parse(event.content);
    assertBackupEnvelopeShape(parsed);
    if (envelopeHashOf(parsed) !== parsed.envelopeHash) return null;
    if (parsed.hostPubkey !== hostkeyTags[0][1]) return null;
    return freezeEnvelope(parsed);
  } catch {
    return null;
  }
}
