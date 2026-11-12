// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Shared invariants for BAO Court ceremony machines (DKG, voting, signing).
 *
 * Each ceremony machine used to re-implement the same guards — timestamp
 * validation, roster membership, deadline enforcement, participant caps, and
 * blame validation — in parallel, so every protocol-hardening landed in three
 * files at once. This module concentrates that core so the invariants are
 * defined and tested once; each machine keeps its own public error class and
 * passes it in, so the exported surface (create/reduce/error/state types) is
 * unchanged.
 *
 * The helpers are ceremony-agnostic: they take the machine's error constructor
 * and the noun used in error messages ("participant", "voter", "signer").
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Error constructor accepted by the ceremony-core guards. */
export type CourtTransitionErrorCtor = new (message: string) => Error;

/** Canonical 32-byte lowercase-hex value (session hashes, salts, ids). */
export const HEX_32 = /^[0-9a-f]{64}$/;

/** Maximum roster size for any ceremony — bounds reducer resource use. */
export const MAX_CEREMONY_PARTICIPANTS = 10_000;

/**
 * Validate that `now` is a non-negative safe integer (a Unix timestamp).
 */
export function assertNow(now: number, ErrorCtor: CourtTransitionErrorCtor): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ErrorCtor('now must be a non-negative Unix timestamp');
  }
}

/**
 * Assert that `idx` is a member of the certified roster.
 *
 * @param noun singular noun for the roster member ("participant", "voter", "signer")
 */
export function assertRosterMember(
  roster: readonly number[],
  idx: number,
  noun: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  if (!roster.includes(idx)) {
    throw new ErrorCtor(`${noun} ${idx} is outside the certified roster`);
  }
}

const canonicalTextEncoder = new TextEncoder();
const canonicalTextDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * True when `value` is exactly the canonical decoding of its own UTF-8
 * bytes. Encoding replaces lone surrogates with U+FFFD, so two DISTINCT
 * strings (`'A\uD800'` and `'A\uFFFD'`) share one canonical byte form:
 * accepting both would let two ballot outcomes hash identically while the
 * tally counts them as different keys, splitting one canonical outcome
 * across two buckets and making the winner order-dependent. Outcomes must
 * therefore round-trip, which rejects lone surrogates at the boundary.
 */
export function isCanonicalUtf8Text(value: string): boolean {
  try {
    return canonicalTextDecoder.decode(canonicalTextEncoder.encode(value)) === value;
  } catch {
    return false;
  }
}

/**
 * Fail closed on a restored or tampered state whose array fields were
 * replaced by non-array values. Guards that call `.includes` / `.find` /
 * `.map` would otherwise crash with an uncaught TypeError, and a string
 * allowlist would admit substring matches (`'YES'.includes('Y')`) outside
 * the frozen ballot.
 */
export function assertStateArrays(
  state: Record<string, unknown>,
  fields: readonly string[],
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  for (const field of fields) {
    if (!Array.isArray(state[field])) {
      throw new ErrorCtor(`${field} must be an array`);
    }
  }
}

/**
 * Assert that a message arrives strictly before the ceremony deadline.
 */
export function assertBeforeDeadline(
  now: number,
  deadline: number,
  message: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  assertNow(now, ErrorCtor);
  if (now >= deadline) {
    throw new ErrorCtor(message);
  }
}

/**
 * Validate that a deadline is a positive safe integer (a Unix timestamp).
 */
export function assertPositiveDeadline(
  deadline: number,
  field: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    throw new ErrorCtor(`${field} must be a positive Unix timestamp`);
  }
}

/**
 * Copy and validate the participant roster: non-empty, capped, and exactly
 * the sequential integers 1..n. Returns the validated copy.
 *
 * @param noun phrase naming the ceremony ("DKG", "voting", "signing")
 */
export function normalizeCeremonyRoster(
  participantIndices: readonly number[],
  noun: string,
  ErrorCtor: CourtTransitionErrorCtor,
): number[] {
  if (!Array.isArray(participantIndices)) {
    throw new ErrorCtor('participantIndices must be an array');
  }
  if (participantIndices.length === 0) {
    throw new ErrorCtor(`${noun} requires at least one participant`);
  }
  if (participantIndices.length > MAX_CEREMONY_PARTICIPANTS) {
    throw new ErrorCtor(
      'participantIndices length exceeds maximum of ' + MAX_CEREMONY_PARTICIPANTS,
    );
  }
  const participants = [...participantIndices];
  participants.forEach((idx, offset) => {
    if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
      throw new ErrorCtor('participant indices must be ordered and sequential');
    }
  });
  return participants;
}

/**
 * Validate an abort's blamedIdx: if supplied it must be a positive safe
 * integer naming a roster member, so a caller cannot forge a peer-blame
 * against an unverified index.
 */
export function assertBlamedIdx(
  blamedIdx: number | undefined,
  roster: readonly number[],
  noun: string,
  ErrorCtor: CourtTransitionErrorCtor,
): void {
  if (blamedIdx === undefined) return;
  if (!Number.isSafeInteger(blamedIdx) || blamedIdx < 1) {
    throw new ErrorCtor('blamedIdx must be a positive integer');
  }
  assertRosterMember(roster, blamedIdx, noun, ErrorCtor);
}

// ---------------------------------------------------------------------------
// Replay vs equivocation — collapse byte-identical signed records FIRST
// ---------------------------------------------------------------------------

/**
 * The identity of a signed record.
 *
 * A Nostr event id is `sha256` over the serialised event, so two records
 * carrying the SAME id ARE the same bytes and the same signature: a relay that
 * duplicates and re-delivers a record cannot produce a second identity without
 * forging a signature. For a record that carries no signed event the identity
 * falls back to the `sha256` of its canonical JSON payload, so the collapse is
 * total rather than silently skipping the record.
 *
 * Returns `null` only when the record has neither an event id nor a payload —
 * i.e. it cannot be attributed to a signer at all, and must not be reasoned
 * about as if it were a signed claim.
 */
export function signedRecordIdentity(
  event: { readonly id?: string | undefined } | undefined,
  payload?: unknown,
): string | null {
  const id = event?.id;
  if (typeof id === 'string' && HEX_32.test(id.toLowerCase())) {
    return `id:${id.toLowerCase()}`;
  }
  if (payload !== undefined) {
    return `payload:${bytesToHex(sha256(canonicalJsonBytes(payload)))}`;
  }
  return null;
}

/** One record, reduced to what the collapse needs: who it is attributed to and its identity. */
export interface SignedRecordIdentity {
  /** Attribution key — the signer plus the round/phase it claims (e.g. `dkg-commit:2:2`). */
  readonly key: string | number;
  /** `signedRecordIdentity(...)`; `null` means "not attributable, skip". */
  readonly identity: string | null;
}

/** Result of collapsing a stream of signed records by attribution key. */
export interface CollapsedSignedRecords<K extends string | number = string | number> {
  /** First occurrence per key, in arrival order: key → record identity. */
  readonly distinct: Map<K, string>;
  /** Records that repeated an identity already seen for their key (a REPLAY). */
  readonly duplicates: number;
  /** Records that are not attributable at all (no event id, no payload). */
  readonly unattributable: number;
  /**
   * Keys that produced two DIFFERENT identities — the only thing that is
   * actually equivocation. Each entry carries the first identity seen and the
   * first conflicting one, so blame names the signer and both claims.
   */
  readonly equivocations: Array<{ readonly key: K; readonly first: string; readonly conflicting: string }>;
}

/**
 * Collapse byte-identical signed records BEFORE any equivocation reasoning.
 *
 * The protocol invariant this encodes: *one signer may publish exactly one
 * claim per (round, phase) — but re-delivery of the SAME signed claim is not a
 * second claim.* A relay that duplicates and late-redelivers records is
 * exercising idempotency, not Byzantine behaviour, and accusing an honest juror
 * of equivocation is a worse failure than missing one: the whole point of the
 * blame machinery is to blame correctly.
 *
 * Identity is the record's own signed event id (or payload hash), never its
 * arrival position — so the same event delivered twice, in either order, with
 * any number of copies between, collapses to one entry and zero accusations.
 * Two records that share a key but differ in identity are reported as
 * equivocations, and only those.
 *
 * Callers MUST pass an attribution key that includes the signer AND the round
 * and phase it claims: the same signer publishing different records in
 * different phases is normal, not equivocation.
 */
export function collapseSignedRecords<K extends string | number>(
  records: readonly SignedRecordIdentity[],
): CollapsedSignedRecords<K> {
  const distinct = new Map<K, string>();
  const equivocations: Array<{ key: K; first: string; conflicting: string }> = [];
  const alreadyBlamed = new Set<K>();
  let duplicates = 0;
  let unattributable = 0;
  for (const record of records) {
    if (record.identity === null) {
      unattributable += 1;
      continue;
    }
    const key = record.key as K;
    const existing = distinct.get(key);
    if (existing === undefined) {
      distinct.set(key, record.identity);
      continue;
    }
    if (existing === record.identity) {
      duplicates += 1;
      continue;
    }
    // A second, DIFFERENT identity for the same signer+round+phase. Report each
    // key once: the blame names the signer, not every further copy it sends.
    if (!alreadyBlamed.has(key)) {
      alreadyBlamed.add(key);
      equivocations.push({ key, first: existing, conflicting: record.identity });
    }
  }
  return { distinct, duplicates, unattributable, equivocations };
}

/**
 * Canonical JSON bytes: object keys sorted at every depth, so two payloads that
 * differ only in key order hash identically. Rejects values JSON cannot
 * represent faithfully (functions, `undefined` inside arrays) rather than
 * hashing a lossy form.
 */
function canonicalJsonBytes(value: unknown): Uint8Array {
  return canonicalTextEncoder.encode(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  }
  if (kind === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported ${kind}`);
}
