// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/** Strict, versioned event boundary for upgraded BAO Court ceremonies. */

import {
  verifyEvent,
  type Event,
  type EventTemplate,
  type VerifiedEvent,
} from 'nostr-tools/pure';
import {
  COURT_SESSION_VERSION,
  assertCourtParticipantBinding,
  assertCourtSessionParameters,
  CourtSessionValidationError,
  getCourtSessionParticipant,
  hashCourtSessionParameters,
  type CourtCryptoSuite,
  type CourtSessionParameters,
  type CourtSessionParticipant,
} from './courtSession';
import {
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_FROST_REVEAL_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
} from './events';
import { isValidSecp256k1Point, type DkgProofOfKnowledge } from './crypto';
import { HEX_32, isRecord } from './courtEventParseCore';

export type CourtProtocolEventClassification = 'bound-v1' | 'legacy' | 'invalid';

export type CourtProtocolEventErrorCode =
  | 'invalid_signature'
  | 'unexpected_kind'
  | 'invalid_content'
  | 'reserved_content'
  | 'missing_tag'
  | 'duplicate_tag'
  | 'invalid_tag'
  | 'tag_content_mismatch'
  | 'wrong_session'
  | 'wrong_suite'
  | 'wrong_attempt'
  | 'wrong_dispute'
  | 'participant_binding_mismatch';

export class CourtProtocolEventError extends Error {
  readonly code: CourtProtocolEventErrorCode;

  constructor(code: CourtProtocolEventErrorCode, message: string) {
    super(message);
    this.name = 'CourtProtocolEventError';
    this.code = code;
  }
}

export interface CourtProtocolBinding {
  readonly version: typeof COURT_SESSION_VERSION;
  readonly session: string;
  readonly suite: CourtCryptoSuite;
  readonly attempt: number;
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly nostrPubkey: string;
  readonly hostPubkey: string;
}

export interface ParsedCourtProtocolEvent {
  readonly event: VerifiedEvent;
  readonly binding: CourtProtocolBinding;
  readonly participant: CourtSessionParticipant;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ParsedLegacyCourtEvent {
  readonly event: VerifiedEvent;
  readonly legacy: true;
}

export interface ParsedBoundDkgCommitment extends ParsedCourtProtocolEvent {
  readonly threshold: number;
  readonly phaseNonce: string;
  readonly proofOfKnowledge: DkgProofOfKnowledge;
  readonly commitments: readonly string[];
}

export interface ParsedBoundVoteCommit extends ParsedCourtProtocolEvent {
  readonly commitHash: string;
}

export interface ParsedBoundVoteReveal extends ParsedCourtProtocolEvent {
  readonly outcome: string;
  readonly salt: string;
}

export interface ParsedBoundFrostCommit extends ParsedCourtProtocolEvent {
  readonly commitmentPackage: {
    readonly idx: number;
    readonly binder_pn: string;
    readonly hidden_pn: string;
  };
}

export interface ParsedBoundFrostReveal extends ParsedCourtProtocolEvent {
  readonly frostPubkey: string;
  readonly publicNonce: {
    readonly idx: number;
    readonly binder_pn: string;
    readonly hidden_pn: string;
  };
  readonly partialSig: string;
}

const REQUIRED_TAGS = [
  'session',
  'suite',
  'attempt',
  'dispute',
  'juror',
  'p',
  'host',
] as const;
const UPGRADE_MARKER_TAGS = ['session', 'suite', 'attempt', 'host'] as const;
const RESERVED_CONTENT_KEY = 'court';
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/;
const MAX_U32 = 0xffff_ffff;

function isVerifiedEvent(event: Event): event is VerifiedEvent {
  try {
    // Verify a fresh data-only copy so a cached verification symbol on a
    // previously checked object cannot survive later mutation.
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

function parseContent(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new CourtProtocolEventError(
      'invalid_content',
      'Court protocol event content must be one JSON object',
    );
  }
}

function parseCanonicalUint(value: string, field: string): number {
  if (!CANONICAL_UINT.test(value)) {
    throw new CourtProtocolEventError('invalid_tag', `${field} must be a canonical unsigned integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_U32) {
    throw new CourtProtocolEventError('invalid_tag', `${field} is outside the uint32 range`);
  }
  return parsed;
}

function uniqueTag(event: Pick<Event, 'tags'>, name: string): string[] {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length === 0) {
    throw new CourtProtocolEventError('missing_tag', `missing required ${name} tag`);
  }
  if (matches.length !== 1) {
    throw new CourtProtocolEventError('duplicate_tag', `expected exactly one ${name} tag`);
  }
  const tag = matches[0];
  if (tag.length !== 2 || !tag[1]) {
    throw new CourtProtocolEventError('invalid_tag', `${name} tag must contain exactly one value`);
  }
  return tag;
}

function assertExactBindingKeys(value: Record<string, unknown>): void {
  const expected = new Set([
    'version',
    'session',
    'suite',
    'attempt',
    'disputeId',
    'jurorIdx',
    'nostrPubkey',
    'hostPubkey',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new CourtProtocolEventError(
      'invalid_content',
      'Court protocol binding contains missing or unsupported fields',
    );
  }
}

function assertExactPayloadKeys(
  payload: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): void {
  const expected = new Set(expectedKeys);
  const keys = Object.keys(payload);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new CourtProtocolEventError(
      'invalid_content',
      'Court event payload contains missing or unsupported fields',
    );
  }
}

function requiredString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new CourtProtocolEventError('invalid_content', `${field} has an invalid value`);
  }
  return value;
}

function requiredUint(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new CourtProtocolEventError('invalid_content', `${field} must be a uint32`);
  }
  return value;
}

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new CourtProtocolEventError(
      'tag_content_mismatch',
      `${field} differs between Court tags and content`,
    );
  }
}

function assertStringArrayEqual(
  actual: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (
    !Array.isArray(actual)
    || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    throw new CourtProtocolEventError(
      'tag_content_mismatch',
      `${field} differs between Court tags and content`,
    );
  }
}

function repeatedTags(event: Pick<Event, 'tags'>, name: string): string[] {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length === 0) {
    throw new CourtProtocolEventError('missing_tag', `missing required ${name} tag`);
  }
  if (matches.some((tag) => tag.length !== 2 || !tag[1])) {
    throw new CourtProtocolEventError('invalid_tag', `${name} tags must each contain one value`);
  }
  return matches.map((tag) => tag[1]);
}

function assertMatchingPayloadField(
  payload: Record<string, unknown>,
  key: string,
  expected: string | number,
): void {
  if (key in payload && payload[key] !== expected) {
    throw new CourtProtocolEventError(
      'tag_content_mismatch',
      `${key} disagrees with the canonical Court binding`,
    );
  }
}

function makeBinding(
  params: CourtSessionParameters,
  participant: CourtSessionParticipant,
): CourtProtocolBinding {
  return {
    version: COURT_SESSION_VERSION,
    session: hashCourtSessionParameters(params),
    suite: params.cryptoSuite,
    attempt: params.attempt,
    disputeId: params.disputeId,
    jurorIdx: participant.idx,
    nostrPubkey: participant.nostrPubkey,
    hostPubkey: participant.hostPubkey,
  };
}

/**
 * Upgrade an unsigned legacy-compatible template with an exact Court binding.
 * The caller must then sign the returned template with the bound Nostr key.
 */
export function bindCourtProtocolEvent(
  template: EventTemplate,
  params: CourtSessionParameters,
  jurorIdx: number,
): EventTemplate {
  assertCourtSessionParameters(params);
  const participant = getCourtSessionParticipant(params, jurorIdx);
  const binding = makeBinding(params, participant);
  const payload = parseContent(template.content);
  if (RESERVED_CONTENT_KEY in payload) {
    throw new CourtProtocolEventError(
      'reserved_content',
      `event payload already contains reserved ${RESERVED_CONTENT_KEY} data`,
    );
  }
  assertMatchingPayloadField(payload, 'disputeId', binding.disputeId);
  assertMatchingPayloadField(payload, 'jurorIdx', binding.jurorIdx);
  assertMatchingPayloadField(payload, 'jurorPubkey', binding.nostrPubkey);

  const reservedTags = new Set<string>(REQUIRED_TAGS);
  const applicationTags = template.tags.filter((tag) => !reservedTags.has(tag[0]));
  return {
    ...template,
    tags: [
      ...applicationTags,
      ['session', binding.session],
      ['suite', binding.suite],
      ['attempt', String(binding.attempt)],
      ['dispute', binding.disputeId],
      ['juror', String(binding.jurorIdx)],
      ['p', binding.nostrPubkey],
      ['host', binding.hostPubkey],
    ],
    content: JSON.stringify({ ...payload, [RESERVED_CONTENT_KEY]: binding }),
  };
}

/** Strictly parse a signed upgraded Court event. Throws closed on ambiguity. */
export function parseCourtProtocolEvent(
  event: Event,
  params: CourtSessionParameters,
  expectedKinds: readonly number[],
): ParsedCourtProtocolEvent {
  assertCourtSessionParameters(params);
  if (!isVerifiedEvent(event)) {
    throw new CourtProtocolEventError('invalid_signature', 'Court protocol event signature is invalid');
  }
  if (!expectedKinds.includes(event.kind)) {
    throw new CourtProtocolEventError('unexpected_kind', `unexpected Court event kind ${event.kind}`);
  }

  const session = uniqueTag(event, 'session')[1];
  const suite = uniqueTag(event, 'suite')[1];
  const attempt = parseCanonicalUint(uniqueTag(event, 'attempt')[1], 'attempt');
  const disputeId = uniqueTag(event, 'dispute')[1];
  const jurorIdx = parseCanonicalUint(uniqueTag(event, 'juror')[1], 'juror');
  const nostrPubkey = uniqueTag(event, 'p')[1];
  const hostPubkey = uniqueTag(event, 'host')[1];

  const expectedSession = hashCourtSessionParameters(params);
  if (session !== expectedSession) {
    throw new CourtProtocolEventError('wrong_session', 'event belongs to a different Court session');
  }
  if (suite !== params.cryptoSuite) {
    throw new CourtProtocolEventError('wrong_suite', 'event crypto suite does not match the session');
  }
  if (attempt !== params.attempt) {
    throw new CourtProtocolEventError('wrong_attempt', 'event attempt does not match the session');
  }
  if (disputeId !== params.disputeId) {
    throw new CourtProtocolEventError('wrong_dispute', 'event dispute does not match the session');
  }

  let participant: CourtSessionParticipant;
  try {
    participant = assertCourtParticipantBinding(params, jurorIdx, event.pubkey, hostPubkey);
  } catch (err) {
    // A wrong-author / wrong-host-key event is a property of the EVENT, so it
    // must surface as a typed CourtProtocolEventError — never as the session
    // layer's CourtSessionValidationError, which fail-closed handling would
    // not catch. assertCourtSessionParameters above still reports genuine
    // host-side session misuse as a session error.
    if (err instanceof CourtSessionValidationError) {
      throw new CourtProtocolEventError('participant_binding_mismatch', err.message);
    }
    throw err;
  }
  if (nostrPubkey !== participant.nostrPubkey) {
    throw new CourtProtocolEventError(
      'tag_content_mismatch',
      'p tag does not match the signed Court participant',
    );
  }

  const content = parseContent(event.content);
  const bindingValue = content[RESERVED_CONTENT_KEY];
  if (!isRecord(bindingValue)) {
    throw new CourtProtocolEventError('invalid_content', 'missing Court protocol content binding');
  }
  assertExactBindingKeys(bindingValue);
  const expectedBinding = makeBinding(params, participant);
  for (const [key, expected] of Object.entries(expectedBinding)) {
    if (bindingValue[key] !== expected) {
      throw new CourtProtocolEventError(
        'tag_content_mismatch',
        `${key} differs between Court tags, content, or session parameters`,
      );
    }
  }

  const payload = { ...content };
  delete payload[RESERVED_CONTENT_KEY];
  assertMatchingPayloadField(payload, 'disputeId', expectedBinding.disputeId);
  assertMatchingPayloadField(payload, 'jurorIdx', expectedBinding.jurorIdx);
  assertMatchingPayloadField(payload, 'jurorPubkey', expectedBinding.nostrPubkey);
  return { event, binding: expectedBinding, participant, payload };
}

/** Classify structure only; classification never constitutes acceptance. */
export function classifyCourtProtocolEvent(
  event: Pick<Event, 'tags' | 'content'>,
): CourtProtocolEventClassification {
  const presentTags = REQUIRED_TAGS.filter((name) => event.tags.some((tag) => tag[0] === name));
  const markerTags = UPGRADE_MARKER_TAGS.filter((name) => event.tags.some((tag) => tag[0] === name));
  let hasContentBinding = false;
  try {
    const content: unknown = JSON.parse(event.content);
    hasContentBinding = isRecord(content) && RESERVED_CONTENT_KEY in content;
  } catch {
    return 'invalid';
  }
  if (markerTags.length === 0 && !hasContentBinding) return 'legacy';
  if (presentTags.length === REQUIRED_TAGS.length && hasContentBinding) return 'bound-v1';
  return 'invalid';
}

/** Read a signed legacy event for an explicitly labelled history/demo view. */
export function parseLegacyCourtEventForHistory(
  event: Event,
  expectedKinds: readonly number[],
): ParsedLegacyCourtEvent {
  if (!isVerifiedEvent(event)) {
    throw new CourtProtocolEventError('invalid_signature', 'legacy Court event signature is invalid');
  }
  if (!expectedKinds.includes(event.kind)) {
    throw new CourtProtocolEventError('unexpected_kind', `unexpected legacy Court event kind ${event.kind}`);
  }
  if (classifyCourtProtocolEvent(event) !== 'legacy') {
    throw new CourtProtocolEventError(
      'invalid_content',
      'event is not an unbound legacy Court event',
    );
  }
  return { event, legacy: true };
}

/** Strict DKG commitment parser for upgraded ceremonies. */
export function parseBoundDkgCommitmentEvent(
  event: Event,
  params: CourtSessionParameters,
): ParsedBoundDkgCommitment {
  const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_DKG_COMMITMENT_KIND]);
  const threshold = parseCanonicalUint(uniqueTag(event, 'threshold')[1], 'threshold');
  const phaseNonce = uniqueTag(event, 'phase_nonce')[1];
  const pokNonce = uniqueTag(event, 'pok_n')[1];
  const pokResponse = uniqueTag(event, 'pok_z')[1];
  const commitments = repeatedTags(event, 'commit');
  if (threshold !== params.threshold) {
    throw new CourtProtocolEventError('tag_content_mismatch', 'DKG threshold differs from the session');
  }
  if (!HEX_32.test(phaseNonce) || !HEX_POINT.test(pokNonce) || !HEX_32.test(pokResponse)) {
    throw new CourtProtocolEventError('invalid_tag', 'DKG proof or phase nonce has invalid encoding');
  }
  if (commitments.length !== threshold || commitments.some((value) => !HEX_POINT.test(value))) {
    throw new CourtProtocolEventError(
      'invalid_tag',
      'DKG commitment count or point encoding does not match the threshold',
    );
  }

  assertExactPayloadKeys(
    parsed.payload,
    ['disputeId', 'jurorIdx', 'threshold', 'phaseNonce', 'pok', 'vssCommits'],
  );
  assertEqual(requiredUint(parsed.payload.threshold, 'threshold'), threshold, 'threshold');
  assertEqual(requiredString(parsed.payload.phaseNonce, 'phaseNonce', HEX_32), phaseNonce, 'phaseNonce');
  const pok = parsed.payload.pok;
  if (!isRecord(pok)) {
    throw new CourtProtocolEventError('invalid_content', 'pok must be an object');
  }
  assertExactPayloadKeys(pok, ['nonce', 'response']);
  assertEqual(requiredString(pok.nonce, 'pok.nonce', HEX_POINT), pokNonce, 'pok.nonce');
  assertEqual(requiredString(pok.response, 'pok.response', HEX_32), pokResponse, 'pok.response');
  assertStringArrayEqual(parsed.payload.vssCommits, commitments, 'vssCommits');
  return {
    ...parsed,
    threshold,
    phaseNonce,
    proofOfKnowledge: { nonce: pokNonce, response: pokResponse },
    commitments,
  };
}

/** Strict vote-commit parser for upgraded ceremonies. */
export function parseBoundVoteCommitEvent(
  event: Event,
  params: CourtSessionParameters,
): ParsedBoundVoteCommit {
  const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_VOTE_COMMIT_KIND]);
  const commitHash = uniqueTag(event, 'commit')[1];
  if (!HEX_32.test(commitHash)) {
    throw new CourtProtocolEventError('invalid_tag', 'vote commitment must be 32-byte lowercase hex');
  }
  assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'commitHash']);
  assertEqual(requiredString(parsed.payload.commitHash, 'commitHash', HEX_32), commitHash, 'commitHash');
  return { ...parsed, commitHash };
}

/** Strict vote-reveal parser for upgraded ceremonies. */
export function parseBoundVoteRevealEvent(
  event: Event,
  params: CourtSessionParameters,
): ParsedBoundVoteReveal {
  const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_VOTE_REVEAL_KIND]);
  const outcome = uniqueTag(event, 'outcome')[1];
  const salt = uniqueTag(event, 'salt')[1];
  if (!params.allowedOutcomes.includes(outcome)) {
    throw new CourtProtocolEventError('invalid_tag', 'vote outcome is not permitted by the session');
  }
  if (!HEX_32.test(salt)) {
    throw new CourtProtocolEventError('invalid_tag', 'vote salt must be 32-byte lowercase hex');
  }
  assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'outcome', 'salt']);
  assertEqual(requiredString(parsed.payload.outcome, 'outcome'), outcome, 'outcome');
  assertEqual(requiredString(parsed.payload.salt, 'salt', HEX_32), salt, 'salt');
  return { ...parsed, outcome, salt };
}

/** Strict FROST nonce-commitment parser for upgraded ceremonies. */
export function parseBoundFrostCommitEvent(
  event: Event,
  params: CourtSessionParameters,
): ParsedBoundFrostCommit {
  const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_FROST_COMMIT_KIND]);
  const binder = uniqueTag(event, 'binder_pn')[1];
  const hidden = uniqueTag(event, 'hidden_pn')[1];
  // Shape + curve membership: a hex string that is not an actual secp256k1
  // point would otherwise poison the FROST binding-factor computation.
  if (!isValidSecp256k1Point(binder) || !isValidSecp256k1Point(hidden)) {
    throw new CourtProtocolEventError('invalid_tag', 'FROST nonce commitments have invalid encoding');
  }
  assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'commitmentPackage']);
  const commitment = parsed.payload.commitmentPackage;
  if (!isRecord(commitment)) {
    throw new CourtProtocolEventError('invalid_content', 'commitmentPackage must be an object');
  }
  assertExactPayloadKeys(commitment, ['idx', 'binder_pn', 'hidden_pn']);
  assertEqual(requiredUint(commitment.idx, 'commitmentPackage.idx'), parsed.participant.idx, 'idx');
  assertEqual(requiredString(commitment.binder_pn, 'binder_pn', HEX_POINT), binder, 'binder_pn');
  assertEqual(requiredString(commitment.hidden_pn, 'hidden_pn', HEX_POINT), hidden, 'hidden_pn');
  return {
    ...parsed,
    commitmentPackage: { idx: parsed.participant.idx, binder_pn: binder, hidden_pn: hidden },
  };
}

/** Strict FROST partial-signature parser for upgraded ceremonies. */
export function parseBoundFrostRevealEvent(
  event: Event,
  params: CourtSessionParameters,
): ParsedBoundFrostReveal {
  const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_FROST_REVEAL_KIND]);
  const frostPubkey = uniqueTag(event, 'pk')[1];
  const binder = uniqueTag(event, 'nonce_binder')[1];
  const hidden = uniqueTag(event, 'nonce_hidden')[1];
  const partialSig = uniqueTag(event, 'psig')[1];
  if (
    !isValidSecp256k1Point(frostPubkey)
    || !isValidSecp256k1Point(binder)
    || !isValidSecp256k1Point(hidden)
    || !HEX_BYTES.test(partialSig)
    || partialSig.length > 512
  ) {
    throw new CourtProtocolEventError('invalid_tag', 'FROST reveal has invalid encoding');
  }
  assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'publicNonce', 'partialSig', 'frostPubkey']);
  const nonce = parsed.payload.publicNonce;
  if (!isRecord(nonce)) {
    throw new CourtProtocolEventError('invalid_content', 'publicNonce must be an object');
  }
  assertExactPayloadKeys(nonce, ['idx', 'binder_pn', 'hidden_pn']);
  assertEqual(requiredUint(nonce.idx, 'publicNonce.idx'), parsed.participant.idx, 'idx');
  assertEqual(requiredString(nonce.binder_pn, 'nonce_binder', HEX_POINT), binder, 'nonce_binder');
  assertEqual(requiredString(nonce.hidden_pn, 'nonce_hidden', HEX_POINT), hidden, 'nonce_hidden');
  assertEqual(requiredString(parsed.payload.partialSig, 'partialSig', HEX_BYTES), partialSig, 'partialSig');
  // The content frostPubkey must agree with the pk tag.
  assertEqual(requiredString(parsed.payload.frostPubkey, 'frostPubkey', HEX_POINT), frostPubkey, 'frostPubkey');
  return {
    ...parsed,
    frostPubkey,
    publicNonce: { idx: parsed.participant.idx, binder_pn: binder, hidden_pn: hidden },
    partialSig,
  };
}
