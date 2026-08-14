// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Court-scoped NIP-46 signer capabilities.
 *
 * When a juror connects a remote signer (NIP-46 bunker) or browser extension
 * (NIP-07) to a Court ceremony, the host must constrain exactly what that
 * signer will sign or encrypt for this ceremony. A `CourtSignerCapability`
 * is the strict, fail-closed record of that constraint: it binds one Court
 * session hash, crypto suite, environment, the full certified roster, the
 * roster peers this signer may encrypt to / decrypt from, an explicit event
 * kind allowlist, a ceremony phase scope, and a validity window.
 *
 * The capability record is pure data with a canonical encoding and hash
 * (domain `BAO-Court/SignerCapability/v1`) so the signer, the host, and any
 * auditor derive the identical capability identifier from the same fields.
 * `assertCourtCapabilityAction` is the enforcement gate: every signer
 * request (sign event, nip44_encrypt, nip44_decrypt) must pass it before the
 * request is forwarded to the signer. Any violation throws a typed
 * `CourtCapabilityError`; there is no permissive path.
 *
 * This module performs no I/O. The clock is injected as an explicit `now`
 * (unix seconds); storage, revocation, and request journaling belong to the
 * host.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  CanonicalWriter,
  COURT_CRYPTO_SUITES,
  COURT_ENVIRONMENTS,
  type CourtCryptoSuite,
  type CourtEnvironment,
} from './courtSession';

export const COURT_CAPABILITY_VERSION = 1 as const;
export const COURT_SIGNER_CAPABILITY_DOMAIN = 'BAO-Court/SignerCapability/v1';

/** Concrete ceremony phases an action can belong to. */
export const COURT_CEREMONY_PHASES = ['dkg', 'vote', 'signing'] as const;
export type CourtCeremonyPhase = (typeof COURT_CEREMONY_PHASES)[number];

/** Phase scope granted by a capability; 'all' spans the whole ceremony. */
export const COURT_CAPABILITY_PHASE_SCOPES = [...COURT_CEREMONY_PHASES, 'all'] as const;
export type CourtCapabilityPhaseScope = (typeof COURT_CAPABILITY_PHASE_SCOPES)[number];

/**
 * The strict Court-scoped signer capability record. All pubkey lists are
 * sorted, unique, lowercase 32-byte hex; `allowedPeers` is a non-empty subset
 * of `roster`. The validity window is half-open: valid at `notBefore`,
 * expired at `notAfter`.
 */
export interface CourtSignerCapability {
  readonly version: typeof COURT_CAPABILITY_VERSION;
  /** Canonical Court session hash this signer is bound to. */
  readonly sessionHash: string;
  readonly cryptoSuite: CourtCryptoSuite;
  readonly environment: CourtEnvironment;
  /** Full sorted roster of juror Nostr pubkeys for the session. */
  readonly roster: readonly string[];
  /** Roster peers this signer may encrypt to / decrypt from. */
  readonly allowedPeers: readonly string[];
  /** Explicit allowlist of Nostr event kinds (never a forbidden-kind list). */
  readonly allowedKinds: readonly number[];
  readonly phaseScope: CourtCapabilityPhaseScope;
  /** Unix seconds; the capability is not valid before this instant. */
  readonly notBefore: number;
  /** Unix seconds; the capability is expired at and after this instant. */
  readonly notAfter: number;
}

/**
 * One requested signer operation. `network` is matched against the
 * capability's `environment`; `phase` must be a concrete ceremony phase;
 * `peerPubkey` is present for NIP-44 encrypt/decrypt requests and omitted
 * for pure signing requests.
 */
export interface CourtCapabilityAction {
  readonly sessionHash: string;
  readonly suite: CourtCryptoSuite;
  readonly network: CourtEnvironment;
  readonly kind: number;
  readonly peerPubkey?: string;
  readonly phase: CourtCeremonyPhase;
  readonly signerPubkey: string;
}

export type CourtCapabilityErrorCode =
  | 'expired'
  | 'not_yet_valid'
  | 'session_mismatch'
  | 'suite_mismatch'
  | 'network_mismatch'
  | 'kind_not_allowed'
  | 'peer_not_allowed'
  | 'signer_not_in_roster'
  | 'phase_mismatch'
  | 'malformed';

export class CourtCapabilityError extends Error {
  readonly code: CourtCapabilityErrorCode;

  constructor(code: CourtCapabilityErrorCode, message: string) {
    super(message);
    this.name = 'CourtCapabilityError';
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const MAX_ROSTER = 1_000;
const MAX_KINDS = 256;
const MAX_NOSTR_KIND = 65_535;

const PHASE_SCOPE_IDS: Readonly<Record<CourtCapabilityPhaseScope, number>> = {
  dkg: 0,
  vote: 1,
  signing: 2,
  all: 3,
};

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
    throw new CourtCapabilityError('malformed', `${field} contains unsupported field ${unexpected}`);
  }
}

function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

function assertHex32(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtCapabilityError('malformed', `${field} must be 32-byte lowercase hex`);
  }
}

function assertUnixSeconds(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CourtCapabilityError('malformed', `${field} must be a non-negative Unix timestamp`);
  }
}

function assertKindNumber(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_NOSTR_KIND
  ) {
    throw new CourtCapabilityError(
      'malformed',
      `${field} must be an integer Nostr event kind between 0 and ${MAX_NOSTR_KIND}`,
    );
  }
}

/**
 * Validate a sorted-unique list of 32-byte hex pubkeys. Court capabilities
 * are canonical records: callers must sort, never the encoder, so an
 * out-of-order list is rejected rather than silently rewritten.
 */
function assertSortedUniqueHex32List(
  value: unknown,
  field: string,
  maximum: number,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new CourtCapabilityError(
      'malformed',
      `${field} must contain between 1 and ${maximum} entries`,
    );
  }
  value.forEach((entry, offset) => {
    assertHex32(entry, `${field}[${offset}]`);
    if (offset > 0 && value[offset - 1] >= entry) {
      throw new CourtCapabilityError(
        'malformed',
        `${field} must be strictly sorted and free of duplicates`,
      );
    }
  });
}

function assertSortedUniqueKindList(
  value: unknown,
  field: string,
): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KINDS) {
    throw new CourtCapabilityError(
      'malformed',
      `${field} must contain between 1 and ${MAX_KINDS} entries`,
    );
  }
  value.forEach((kind, offset) => {
    assertKindNumber(kind, `${field}[${offset}]`);
    if (offset > 0 && value[offset - 1] >= kind) {
      throw new CourtCapabilityError(
        'malformed',
        `${field} must be strictly sorted and free of duplicates`,
      );
    }
  });
}

function suiteId(suite: CourtCryptoSuite): number {
  const id = COURT_CRYPTO_SUITES.indexOf(suite);
  if (id < 0) {
    throw new CourtCapabilityError('malformed', `unsupported Court crypto suite ${suite}`);
  }
  return id;
}

function environmentId(environment: CourtEnvironment): number {
  const id = COURT_ENVIRONMENTS.indexOf(environment);
  if (id < 0) {
    throw new CourtCapabilityError('malformed', `unsupported Court environment ${environment}`);
  }
  return id;
}

/**
 * Validate a complete Court signer capability. Every field is checked:
 * version, hex encodings, sorted-unique pubkey lists, the peer-in-roster
 * subset rule, the kind allowlist, the phase scope, and the validity window
 * (`notAfter` strictly later than `notBefore`). Any violation throws
 * {@link CourtCapabilityError} with code `malformed`.
 */
export function assertCourtSignerCapability(
  value: unknown,
): asserts value is CourtSignerCapability {
  if (!isRecord(value)) {
    throw new CourtCapabilityError('malformed', 'capability must be an object');
  }
  assertExactKeys(
    value,
    [
      'version',
      'sessionHash',
      'cryptoSuite',
      'environment',
      'roster',
      'allowedPeers',
      'allowedKinds',
      'phaseScope',
      'notBefore',
      'notAfter',
    ],
    'capability',
  );
  if (value.version !== COURT_CAPABILITY_VERSION) {
    throw new CourtCapabilityError('malformed', 'unsupported Court capability version');
  }
  assertHex32(value.sessionHash, 'sessionHash');
  if (!isOneOf(COURT_CRYPTO_SUITES, value.cryptoSuite)) {
    throw new CourtCapabilityError('malformed', 'unsupported Court crypto suite');
  }
  if (!isOneOf(COURT_ENVIRONMENTS, value.environment)) {
    throw new CourtCapabilityError('malformed', 'unsupported Court environment');
  }

  assertSortedUniqueHex32List(value.roster, 'roster', MAX_ROSTER);
  assertSortedUniqueHex32List(value.allowedPeers, 'allowedPeers', MAX_ROSTER);
  const roster = new Set<string>(value.roster);
  for (const peer of value.allowedPeers) {
    if (!roster.has(peer)) {
      throw new CourtCapabilityError(
        'malformed',
        'allowedPeers must be a subset of the certified roster',
      );
    }
  }

  assertSortedUniqueKindList(value.allowedKinds, 'allowedKinds');

  if (!isOneOf(COURT_CAPABILITY_PHASE_SCOPES, value.phaseScope)) {
    throw new CourtCapabilityError('malformed', 'unsupported Court capability phase scope');
  }
  assertUnixSeconds(value.notBefore, 'notBefore');
  assertUnixSeconds(value.notAfter, 'notAfter');
  if (value.notAfter <= value.notBefore) {
    throw new CourtCapabilityError('malformed', 'notAfter must be later than notBefore');
  }
}

/**
 * Validate every field and return the capability as a frozen canonical copy.
 * This is the only supported construction path for untrusted input.
 */
export function createCourtCapability(params: CourtSignerCapability): CourtSignerCapability {
  assertCourtSignerCapability(params);
  return Object.freeze({
    version: params.version,
    sessionHash: params.sessionHash,
    cryptoSuite: params.cryptoSuite,
    environment: params.environment,
    roster: Object.freeze([...params.roster]),
    allowedPeers: Object.freeze([...params.allowedPeers]),
    allowedKinds: Object.freeze([...params.allowedKinds]),
    phaseScope: params.phaseScope,
    notBefore: params.notBefore,
    notAfter: params.notAfter,
  });
}

/** Return the canonical binary encoding used by the Court capability hash. */
export function encodeCourtCapability(value: CourtSignerCapability): Uint8Array {
  assertCourtSignerCapability(value);
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.sessionHash);
  writer.u8(suiteId(value.cryptoSuite));
  writer.u8(environmentId(value.environment));
  writer.u32(value.roster.length);
  for (const juror of value.roster) {
    writer.hex(juror);
  }
  writer.u32(value.allowedPeers.length);
  for (const peer of value.allowedPeers) {
    writer.hex(peer);
  }
  writer.u32(value.allowedKinds.length);
  for (const kind of value.allowedKinds) {
    writer.u32(kind);
  }
  writer.u8(PHASE_SCOPE_IDS[value.phaseScope]);
  writer.u64(value.notBefore);
  writer.u64(value.notAfter);
  return writer.finish();
}

/** Derive the lowercase SHA-256 Court signer capability identifier. */
export function hashCourtCapability(value: CourtSignerCapability): string {
  const encoded = encodeCourtCapability(value);
  const domain = textEncoder.encode(COURT_SIGNER_CAPABILITY_DOMAIN);
  const input = new Uint8Array(domain.length + encoded.length);
  input.set(domain, 0);
  input.set(encoded, domain.length);
  return bytesToHex(sha256(input));
}

function assertActionShape(value: unknown): asserts value is CourtCapabilityAction {
  if (!isRecord(value)) {
    throw new CourtCapabilityError('malformed', 'capability action must be an object');
  }
  assertExactKeys(
    value,
    ['sessionHash', 'suite', 'network', 'kind', 'peerPubkey', 'phase', 'signerPubkey'],
    'capability action',
  );
  assertHex32(value.sessionHash, 'action.sessionHash');
  if (!isOneOf(COURT_CRYPTO_SUITES, value.suite)) {
    throw new CourtCapabilityError('malformed', 'action names an unsupported Court crypto suite');
  }
  if (!isOneOf(COURT_ENVIRONMENTS, value.network)) {
    throw new CourtCapabilityError('malformed', 'action names an unsupported Court environment');
  }
  assertKindNumber(value.kind, 'action.kind');
  if (!isOneOf(COURT_CEREMONY_PHASES, value.phase)) {
    throw new CourtCapabilityError('malformed', 'action phase must be a concrete ceremony phase');
  }
  assertHex32(value.signerPubkey, 'action.signerPubkey');
  if (value.peerPubkey !== undefined) {
    assertHex32(value.peerPubkey, 'action.peerPubkey');
  }
}

/**
 * Enforce a Court signer capability against one requested signer operation.
 *
 * The capability is re-validated before any check so a corrupted or
 * deserialized record fails closed. Checks run in a fixed order — malformed
 * input, validity window, session binding, suite, network, roster
 * membership, kind allowlist, phase scope, peer allowlist — and the first
 * violation throws {@link CourtCapabilityError}. Returns void on success.
 *
 * The window is half-open: `now < notBefore` throws `not_yet_valid` and
 * `now >= notAfter` throws `expired`.
 */
export function assertCourtCapabilityAction(
  capability: CourtSignerCapability,
  action: CourtCapabilityAction,
  now: number,
): void {
  assertCourtSignerCapability(capability);
  assertActionShape(action);
  assertUnixSeconds(now, 'now');

  if (now < capability.notBefore) {
    throw new CourtCapabilityError('not_yet_valid', 'capability is not valid before notBefore');
  }
  if (now >= capability.notAfter) {
    throw new CourtCapabilityError('expired', 'capability expired at notAfter');
  }
  if (action.sessionHash !== capability.sessionHash) {
    throw new CourtCapabilityError(
      'session_mismatch',
      'action is bound to a different Court session',
    );
  }
  if (action.suite !== capability.cryptoSuite) {
    throw new CourtCapabilityError(
      'suite_mismatch',
      'action names a different Court crypto suite',
    );
  }
  if (action.network !== capability.environment) {
    throw new CourtCapabilityError(
      'network_mismatch',
      'action names a different Court environment',
    );
  }
  if (!capability.roster.includes(action.signerPubkey)) {
    throw new CourtCapabilityError(
      'signer_not_in_roster',
      'the requesting signer is not a certified roster juror',
    );
  }
  if (!capability.allowedKinds.includes(action.kind)) {
    throw new CourtCapabilityError('kind_not_allowed', 'event kind is outside the allowlist');
  }
  if (capability.phaseScope !== 'all' && action.phase !== capability.phaseScope) {
    throw new CourtCapabilityError(
      'phase_mismatch',
      'action phase is outside the capability phase scope',
    );
  }
  if (action.peerPubkey !== undefined && !capability.allowedPeers.includes(action.peerPubkey)) {
    throw new CourtCapabilityError(
      'peer_not_allowed',
      'peer is outside the allowed recipient/requester set',
    );
  }
}

/**
 * Human-readable approval summary for interactive signers. Display text
 * only — the cryptographic authority is the capability record and its
 * canonical hash, never this string.
 */
export function describeCourtCapability(value: CourtSignerCapability): string {
  assertCourtSignerCapability(value);
  return [
    `BAO Court signer capability ${hashCourtCapability(value)}`,
    `session=${value.sessionHash}`,
    `suite=${value.cryptoSuite}`,
    `environment=${value.environment}`,
    `phase=${value.phaseScope}`,
    `kinds=${value.allowedKinds.join(',')}`,
    `peers=${value.allowedPeers.length} of ${value.roster.length} roster jurors`,
    `valid=[${value.notBefore}, ${value.notAfter})`,
  ].join(' ');
}
