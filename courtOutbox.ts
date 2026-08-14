// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Encrypted durable outbox for BAO Court protocol messages.
 *
 * Court state machines hand this module fully-formed NIP-59 gift-wrap events
 * addressed to roster peers. The outbox guarantees at-most-once semantics per
 * logical message: the dedupe key is a canonical hash over the session hash,
 * inner kind, recipient pubkey, and canonical payload — never the gift-wrap
 * event id — so re-wrapping the same logical message (new ephemeral key, new
 * wrap id) dedupes to the same entry.
 *
 * Entry lifecycle: queued -> sent -> acked, plus dead when the per-message
 * deadline passes without an acknowledgement. Retries use doubling backoff
 * (initialRetrySeconds, capped at maxRetrySeconds) until deadlineSeconds
 * after enqueue. Acknowledgements are Nostr events of kind
 * {@link COURT_DELIVERY_ACK_KIND} signed by the addressed recipient,
 * referencing the logical message key (['m', key]) and the wrap id they
 * observed (['e', id]); the 'm' tag is the authoritative binding.
 *
 * The outbox performs no I/O of its own: every time-dependent method takes an
 * explicit `now` (Unix seconds), and persistence goes through the injected
 * {@link OutboxStorage}, which hosts must implement atomically (write-temp-
 * then-rename or equivalent). The stored wrap template lets a host
 * rebroadcast the exact same gift wrap after a crash.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { CanonicalWriter } from './courtSession';

/** Canonical hashing domain for the logical outbox message key. */
export const COURT_OUTBOX_MESSAGE_DOMAIN = 'BAO-Court/OutboxMessage/v1';

/**
 * Addressable Nostr kind for Court delivery acknowledgements. An ack carries
 * ['m', messageKey] and ['e', wrapEventId] tags and is signed by the
 * addressed recipient of the original gift wrap.
 */
export const COURT_DELIVERY_ACK_KIND = 39008;

/** Snapshot schema version persisted through {@link OutboxStorage}. */
export const COURT_OUTBOX_SNAPSHOT_VERSION = 1 as const;

/** Default retry policy: 30s initial backoff, 1h cap, 24h delivery deadline. */
export const COURT_OUTBOX_DEFAULT_PARAMS = {
  initialRetrySeconds: 30,
  maxRetrySeconds: 3600,
  deadlineSeconds: 86_400,
} as const;

const textEncoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const MAX_NOSTR_KIND = 65_535;
const MAX_ENTRIES = 100_000;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_WRAP_CONTENT_BYTES = 256 * 1024;
const MAX_WRAP_TAGS = 128;
const MAX_WRAP_TAG_ITEMS = 16;
const MAX_WRAP_TAG_ITEM_BYTES = 1024;

/** Lifecycle status of one logical outbox message. */
export type CourtOutboxEntryStatus = 'queued' | 'sent' | 'acked' | 'dead';

/** Typed failure for every outbox rejection; `code` is machine-readable. */
export type CourtOutboxErrorCode =
  | 'unknown_message'
  | 'ack_author_mismatch'
  | 'ack_invalid_signature'
  | 'message_dead'
  | 'malformed'
  | 'invalid_transition'
  | 'corrupt_snapshot';

/** Error thrown by every fail-closed outbox gate. */
export class CourtOutboxError extends Error {
  readonly code: CourtOutboxErrorCode;

  constructor(code: CourtOutboxErrorCode, message: string) {
    super(message);
    this.name = 'CourtOutboxError';
    this.code = code;
  }
}

/** Retry/deadline policy shared by every entry in one outbox. */
export interface CourtOutboxRetryParams {
  /** Backoff after the first send; doubles per attempt up to the cap. */
  readonly initialRetrySeconds: number;
  /** Maximum backoff between send attempts. */
  readonly maxRetrySeconds: number;
  /** Seconds after enqueue beyond which an unacked message is dead. */
  readonly deadlineSeconds: number;
}

/** Creation parameters; `storage` optionally binds crash-safe persistence. */
export interface CourtOutboxParams extends CourtOutboxRetryParams {
  readonly storage?: OutboxStorage;
}

/**
 * Host-provided durable storage. Implementations MUST persist snapshots
 * atomically; both synchronous and asynchronous hosts are supported.
 */
export interface OutboxStorage {
  load(): Promise<unknown> | unknown;
  save(snapshot: CourtOutboxSnapshot): Promise<void> | void;
}

/**
 * Stored gift-wrap template (kind/content/tags/created_at plus
 * pubkey/id/sig when the wrap is already signed) so a host can rebroadcast
 * the exact wrap after a crash without re-wrapping.
 */
export interface CourtOutboxWrapTemplate {
  readonly kind: number;
  readonly content: string;
  readonly tags: readonly (readonly string[])[];
  readonly created_at: number;
  readonly pubkey?: string;
  readonly id?: string;
  readonly sig?: string;
}

/** Input to {@link CourtOutbox.enqueue}: the logical message plus its wrap. */
export interface CourtOutboxEnqueueInput {
  /** Lowercase 32-byte Court session hash the message is bound to. */
  readonly sessionHash: string;
  /** Nostr kind of the inner (rumor) protocol event. */
  readonly innerKind: number;
  /** Lowercase 32-byte Nostr pubkey of the addressed roster peer. */
  readonly recipientPubkey: string;
  /**
   * Canonical serialization of the inner message (host-defined, stable
   * across re-wraps). Opaque to the outbox; feeds the dedupe hash only.
   */
  readonly payload: string;
  /** The gift wrap the host will broadcast for this logical message. */
  readonly wrap: CourtOutboxWrapTemplate;
}

/** One logical message tracked by the outbox. Immutable; replaced on change. */
export interface CourtOutboxEntry {
  /** Canonical logical message key ({@link hashCourtOutboxMessage}). */
  readonly messageKey: string;
  readonly sessionHash: string;
  readonly innerKind: number;
  readonly recipientPubkey: string;
  readonly payload: string;
  readonly wrap: CourtOutboxWrapTemplate;
  readonly status: CourtOutboxEntryStatus;
  /** Number of send attempts recorded via markSent. */
  readonly attempts: number;
  readonly enqueuedAt: number;
  /** Unix seconds; at or after this time an unacked entry is dead. */
  readonly deadline: number;
  /** Earliest time the entry appears in dueEntries again. */
  readonly nextRetryAt: number;
  readonly lastSentAt?: number;
  readonly ackedAt?: number;
  /** Event id of the accepted acknowledgement. */
  readonly ackEventId?: string;
  /**
   * The full verified ack event, retained so snapshot restore can re-verify
   * it instead of trusting self-asserted acked state.
   */
  readonly ackEvent?: NostrEvent;
}

/** JSON-safe durable form of the whole outbox. */
export interface CourtOutboxSnapshot {
  readonly version: typeof COURT_OUTBOX_SNAPSHOT_VERSION;
  readonly params: CourtOutboxRetryParams;
  readonly entries: readonly CourtOutboxEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = textEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

function fail(code: CourtOutboxErrorCode, message: string): never {
  throw new CourtOutboxError(code, message);
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    fail('malformed', 'now must be a non-negative Unix timestamp in seconds');
  }
}

function assertHex32(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    fail('malformed', `${field} must be 32-byte lowercase hex`);
  }
}

function assertBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
  allowEmpty: boolean,
): asserts value is string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || textEncoder.encode(value).length > maxBytes
  ) {
    fail('malformed', `${field} must be a string of at most ${maxBytes} bytes`);
  }
}

function assertWrapTemplate(value: unknown): asserts value is CourtOutboxWrapTemplate {
  if (!isRecord(value)) fail('malformed', 'wrap template must be an object');
  if (
    !Number.isSafeInteger(value.kind)
    || (value.kind as number) < 0
    || (value.kind as number) > MAX_NOSTR_KIND
  ) {
    fail('malformed', 'wrap.kind must be a valid Nostr kind');
  }
  assertBoundedText(value.content, 'wrap.content', MAX_WRAP_CONTENT_BYTES, true);
  if (
    !Number.isSafeInteger(value.created_at)
    || (value.created_at as number) < 0
  ) {
    fail('malformed', 'wrap.created_at must be a non-negative Unix timestamp');
  }
  if (!Array.isArray(value.tags) || value.tags.length > MAX_WRAP_TAGS) {
    fail('malformed', `wrap.tags must be an array of at most ${MAX_WRAP_TAGS} tags`);
  }
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || tag.length > MAX_WRAP_TAG_ITEMS) {
      fail('malformed', 'wrap tags must be bounded arrays');
    }
    for (const item of tag) {
      assertBoundedText(item, 'wrap tag item', MAX_WRAP_TAG_ITEM_BYTES, true);
    }
  }
  if (value.pubkey !== undefined) assertHex32(value.pubkey, 'wrap.pubkey');
  if (value.id !== undefined) assertHex32(value.id, 'wrap.id');
  if (
    value.sig !== undefined
    && (typeof value.sig !== 'string' || !HEX_64.test(value.sig))
  ) {
    fail('malformed', 'wrap.sig must be 64-byte lowercase hex');
  }
}

function assertRetryParams(value: CourtOutboxRetryParams): void {
  const { initialRetrySeconds, maxRetrySeconds, deadlineSeconds } = value;
  if (
    !Number.isSafeInteger(initialRetrySeconds)
    || !Number.isSafeInteger(maxRetrySeconds)
    || !Number.isSafeInteger(deadlineSeconds)
    || initialRetrySeconds < 1
    || maxRetrySeconds < initialRetrySeconds
    || deadlineSeconds < 1
  ) {
    fail(
      'malformed',
      'retry params must be positive safe integers with initialRetrySeconds <= maxRetrySeconds',
    );
  }
}

function copyWrap(wrap: CourtOutboxWrapTemplate): CourtOutboxWrapTemplate {
  return {
    kind: wrap.kind,
    content: wrap.content,
    tags: wrap.tags.map((tag) => [...tag]),
    created_at: wrap.created_at,
    ...(wrap.pubkey !== undefined ? { pubkey: wrap.pubkey } : {}),
    ...(wrap.id !== undefined ? { id: wrap.id } : {}),
    ...(wrap.sig !== undefined ? { sig: wrap.sig } : {}),
  };
}

function copyAckEvent(ack: NostrEvent): NostrEvent {
  return {
    id: ack.id,
    pubkey: ack.pubkey,
    sig: ack.sig,
    kind: ack.kind,
    created_at: ack.created_at,
    content: ack.content,
    tags: ack.tags.map((tag) => [...tag]),
  };
}

function copyEntry(entry: CourtOutboxEntry): CourtOutboxEntry {
  return {
    ...entry,
    wrap: copyWrap(entry.wrap),
    ...(entry.ackEvent !== undefined ? { ackEvent: copyAckEvent(entry.ackEvent) } : {}),
  };
}

type AckInspection =
  | { readonly ok: true; readonly id: string; readonly pubkey: string; readonly messageKey: string; readonly wrapId: string; readonly event: NostrEvent }
  | { readonly ok: false; readonly reason: 'malformed' | 'ack_invalid_signature' };

/**
 * Structurally validate and signature-verify a delivery ack event. The
 * caller binds the author/message/deadline semantics; this helper only
 * answers "is this a well-formed, authentically signed kind-39008 ack".
 *
 * Verification runs over a reconstructed plain object: finalizeEvent and
 * verifyEvent cache their verdict in a non-JSON-enumerable symbol that
 * object spreads preserve, so a tampered copy of a once-valid event must
 * never reach the verifier with its cached verdict attached.
 */
function inspectAckEvent(ackEvent: unknown): AckInspection {
  if (!isRecord(ackEvent) || ackEvent.kind !== COURT_DELIVERY_ACK_KIND) {
    return { ok: false, reason: 'malformed' };
  }
  if (!Array.isArray(ackEvent.tags)) return { ok: false, reason: 'malformed' };
  const tags = ackEvent.tags as readonly unknown[];
  const mTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'm') as
    | readonly unknown[]
    | undefined;
  const eTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'e') as
    | readonly unknown[]
    | undefined;
  const messageKey = mTag?.[1];
  const wrapId = eTag?.[1];
  if (typeof messageKey !== 'string' || !HEX_32.test(messageKey)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof wrapId !== 'string' || !HEX_32.test(wrapId)) {
    return { ok: false, reason: 'malformed' };
  }

  const candidate: NostrEvent = {
    id: ackEvent.id,
    pubkey: ackEvent.pubkey,
    sig: ackEvent.sig,
    kind: COURT_DELIVERY_ACK_KIND,
    created_at: ackEvent.created_at,
    content: ackEvent.content,
    // Boundary copy: the stored ack event must never alias the caller's
    // tags array, or late mutation of the input would rewrite persisted
    // state and later snapshot verification.
    tags: tags.map((tag) => [...(tag as string[])]),
  } as NostrEvent;
  let signatureValid = false;
  try {
    signatureValid = verifyEvent(candidate);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: 'ack_invalid_signature' };
  return {
    ok: true,
    id: candidate.id,
    pubkey: candidate.pubkey,
    messageKey,
    wrapId,
    event: candidate,
  };
}

function compareEntries(a: CourtOutboxEntry, b: CourtOutboxEntry): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.messageKey < b.messageKey ? -1 : a.messageKey > b.messageKey ? 1 : 0;
}

/**
 * Canonical logical message key: the dedupe identity of one Court message.
 *
 * Hashes sessionHash, inner kind, recipient pubkey, and the canonical payload
 * under {@link COURT_OUTBOX_MESSAGE_DOMAIN} — deliberately NOT the gift-wrap
 * event id, so a re-wrap of the same logical message lands on the same entry.
 * Recipients use the same function to build the ['m', key] ack tag.
 */
export function hashCourtOutboxMessage(params: {
  readonly sessionHash: string;
  readonly innerKind: number;
  readonly recipientPubkey: string;
  readonly payload: string;
}): string {
  const writer = new CanonicalWriter();
  writer.hex(params.sessionHash);
  writer.u32(params.innerKind);
  writer.hex(params.recipientPubkey);
  writer.text(params.payload);
  return digestDomain(COURT_OUTBOX_MESSAGE_DOMAIN, writer.finish());
}

/**
 * Durable, fail-closed outbox for Court protocol gift wraps.
 *
 * All mutating methods replace entry objects immutably and are synchronous;
 * call {@link persist} after mutations to flush a snapshot to storage.
 */
export class CourtOutbox {
  private readonly params: CourtOutboxRetryParams;
  private readonly storage?: OutboxStorage;
  private readonly entries = new Map<string, CourtOutboxEntry>();

  private constructor(params: CourtOutboxParams) {
    assertRetryParams(params);
    this.params = {
      initialRetrySeconds: params.initialRetrySeconds,
      maxRetrySeconds: params.maxRetrySeconds,
      deadlineSeconds: params.deadlineSeconds,
    };
    this.storage = params.storage;
  }

  /** Retry backoff after the n-th send attempt (1-based), capped at the max. */
  private backoffSeconds(attempt: number): number {
    let delay = this.params.initialRetrySeconds;
    for (let i = 1; i < attempt && delay < this.params.maxRetrySeconds; i += 1) {
      delay = Math.min(delay * 2, this.params.maxRetrySeconds);
    }
    return delay;
  }

  private requireEntry(messageKey: string): CourtOutboxEntry {
    assertHex32(messageKey, 'messageKey');
    const entry = this.entries.get(messageKey);
    if (!entry) fail('unknown_message', 'no outbox entry for this logical message key');
    return entry;
  }

  /**
   * Enqueue a logical message for delivery. Idempotent: if the canonical
   * message key already exists (including as dead/acked), the existing entry
   * is returned unchanged and the new wrap template is discarded.
   */
  enqueue(input: CourtOutboxEnqueueInput, now: number): CourtOutboxEntry {
    assertNow(now);
    if (!isRecord(input)) fail('malformed', 'enqueue input must be an object');
    assertHex32(input.sessionHash, 'sessionHash');
    if (
      !Number.isSafeInteger(input.innerKind)
      || input.innerKind < 0
      || input.innerKind > MAX_NOSTR_KIND
    ) {
      fail('malformed', 'innerKind must be a valid Nostr kind');
    }
    assertHex32(input.recipientPubkey, 'recipientPubkey');
    assertBoundedText(input.payload, 'payload', MAX_PAYLOAD_BYTES, false);
    assertWrapTemplate(input.wrap);

    const messageKey = hashCourtOutboxMessage({
      sessionHash: input.sessionHash,
      innerKind: input.innerKind,
      recipientPubkey: input.recipientPubkey,
      payload: input.payload,
    });
    const existing = this.entries.get(messageKey);
    if (existing) return copyEntry(existing);

    if (this.entries.size >= MAX_ENTRIES) {
      fail('malformed', `outbox capacity of ${MAX_ENTRIES} entries exceeded`);
    }
    const entry: CourtOutboxEntry = {
      messageKey,
      sessionHash: input.sessionHash,
      innerKind: input.innerKind,
      recipientPubkey: input.recipientPubkey,
      payload: input.payload,
      wrap: copyWrap(input.wrap),
      status: 'queued',
      attempts: 0,
      enqueuedAt: now,
      deadline: now + this.params.deadlineSeconds,
      nextRetryAt: now,
    };
    this.entries.set(messageKey, entry);
    return copyEntry(entry);
  }

  /**
   * Record a send attempt for an entry: queued -> sent (or sent -> sent for a
   * retry), scheduling the next retry with doubling backoff. Rejects sends of
   * dead, deadline-exceeded, or already-acked messages.
   */
  markSent(messageKey: string, now: number): CourtOutboxEntry {
    assertNow(now);
    const entry = this.requireEntry(messageKey);
    if (entry.status === 'dead' || now >= entry.deadline) {
      fail('message_dead', 'cannot send a message past its delivery deadline');
    }
    if (entry.status === 'acked') {
      fail('invalid_transition', 'cannot send an already-acknowledged message');
    }
    const attempts = entry.attempts + 1;
    const next: CourtOutboxEntry = {
      ...entry,
      status: 'sent',
      attempts,
      lastSentAt: now,
      nextRetryAt: now + this.backoffSeconds(attempts),
    };
    this.entries.set(messageKey, next);
    return copyEntry(next);
  }

  /**
   * Entries whose send (or retry) is due at `now`: live queued/sent entries
   * with nextRetryAt <= now and deadline still ahead, ordered by nextRetryAt
   * then message key. Pure query; use {@link expireOverdue} to bury entries
   * whose deadline has passed.
   */
  dueEntries(now: number): readonly CourtOutboxEntry[] {
    assertNow(now);
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (entry.status === 'queued' || entry.status === 'sent')
          && entry.nextRetryAt <= now
          && now < entry.deadline,
      )
      .sort((a, b) => {
        if (a.nextRetryAt !== b.nextRetryAt) return a.nextRetryAt - b.nextRetryAt;
        return compareEntries(a, b);
      })
      .map(copyEntry);
  }

  /**
   * Transition every live entry whose deadline has passed to dead. Returns
   * the affected message keys, sorted for determinism.
   */
  expireOverdue(now: number): readonly string[] {
    assertNow(now);
    const buried: string[] = [];
    for (const entry of this.entries.values()) {
      if ((entry.status === 'queued' || entry.status === 'sent') && now >= entry.deadline) {
        this.entries.set(entry.messageKey, { ...entry, status: 'dead' });
        buried.push(entry.messageKey);
      }
    }
    return buried.sort();
  }

  /**
   * Accept a signed delivery acknowledgement.
   *
   * The ack must be a well-formed {@link COURT_DELIVERY_ACK_KIND} event with
   * ['m', messageKey] and ['e', wrapId] tags (malformed), reference a known
   * message (unknown_message), carry a valid Schnorr signature
   * (ack_invalid_signature), and be authored by the addressed recipient
   * (ack_author_mismatch). Re-acking an acked message is idempotent —
   * relays legitimately re-serve addressable acks after the deadline, so an
   * authentic duplicate for an already-acked entry returns the entry rather
   * than failing. Acks for dead or deadline-exceeded unacked messages are
   * rejected (message_dead). The verified ack event is retained on the entry
   * so snapshot restore can re-verify it.
   */
  recordAck(ackEvent: unknown, now: number): CourtOutboxEntry {
    assertNow(now);
    const inspected = inspectAckEvent(ackEvent);
    if (!inspected.ok) {
      fail(
        inspected.reason,
        inspected.reason === 'malformed'
          ? `ack must be a kind ${COURT_DELIVERY_ACK_KIND} event with ['m', messageKey] and ['e', wrapEventId] tags`
          : 'ack event signature does not verify',
      );
    }

    const entry = this.entries.get(inspected.messageKey);
    if (!entry) fail('unknown_message', 'ack references an unknown logical message');
    if (inspected.pubkey !== entry.recipientPubkey) {
      fail('ack_author_mismatch', 'ack must be signed by the addressed recipient');
    }
    // Idempotent re-ack: an authentic duplicate for an already-acked entry is
    // benign relay behavior, never a fault — regardless of the deadline.
    if (entry.status === 'acked') return copyEntry(entry);
    if (entry.status === 'dead' || now >= entry.deadline) {
      fail('message_dead', 'cannot acknowledge a message past its delivery deadline');
    }

    const next: CourtOutboxEntry = {
      ...entry,
      status: 'acked',
      ackedAt: now,
      ackEventId: inspected.id,
      ackEvent: copyAckEvent(inspected.event),
    };
    this.entries.set(inspected.messageKey, next);
    return copyEntry(next);
  }

  /** Look up one entry by logical message key, or undefined if absent. */
  getEntry(messageKey: string): CourtOutboxEntry | undefined {
    assertHex32(messageKey, 'messageKey');
    const entry = this.entries.get(messageKey);
    return entry ? copyEntry(entry) : undefined;
  }

  /** All entries, ordered by enqueue time then message key. */
  listEntries(): readonly CourtOutboxEntry[] {
    return [...this.entries.values()].sort(compareEntries).map(copyEntry);
  }

  /** JSON-safe deep-copied snapshot suitable for atomic persistence. */
  snapshot(): CourtOutboxSnapshot {
    return {
      version: COURT_OUTBOX_SNAPSHOT_VERSION,
      params: { ...this.params },
      entries: this.listEntries(),
    };
  }

  /** Persist the current snapshot through the bound storage, if any. */
  async persist(): Promise<void> {
    if (!this.storage) return;
    await this.storage.save(this.snapshot());
  }

  /** Create an empty outbox with a validated retry policy. */
  static create(params: CourtOutboxParams): CourtOutbox {
    return new CourtOutbox(params);
  }

  /**
   * Validate and rehydrate an outbox from a snapshot. Every structural,
   * cryptographic-shape, and coherence check failing rejects the whole
   * snapshot with code corrupt_snapshot — a tampered store must never
   * resurrect or duplicate in-flight messages.
   *
   * Coherence enforced here: message keys are recomputed from the logical
   * message; deadlines must equal enqueuedAt + the snapshot's own retry
   * policy (so a tampered store cannot push a dead message's deadline into
   * the future without also forging the policy); lifecycle fields must be
   * mutually consistent; and every 'acked' entry must carry its full ack
   * event, which is re-verified (structure, Schnorr signature, recipient
   * authorship, message-key binding) rather than trusted.
   *
   * Residual trust: the snapshot's retry policy is self-asserted, so a
   * store tamperer who also forges policy values can move deadlines within
   * policy-plausible bounds. Hosts SHOULD integrity-protect the persisted
   * snapshot (MAC or authenticated encryption at rest); these checks bound
   * — they cannot eliminate — what a fully tampered store can attempt.
   */
  static fromSnapshot(data: unknown, storage?: OutboxStorage): CourtOutbox {
    // Function declaration, not a const arrow: TypeScript only narrows unions
    // on calls to never-returning functions when the callee is a declaration.
    function corrupt(message: string): never {
      return fail('corrupt_snapshot', message);
    }
    const snapshot: Record<string, unknown> = isRecord(data)
      ? data
      : corrupt('snapshot must be an object');
    if (snapshot.version !== COURT_OUTBOX_SNAPSHOT_VERSION) {
      corrupt('unsupported snapshot version');
    }
    const params: Record<string, unknown> = isRecord(snapshot.params)
      ? snapshot.params
      : corrupt('snapshot params must be an object');
    let outbox: CourtOutbox;
    try {
      outbox = new CourtOutbox({
        initialRetrySeconds: params.initialRetrySeconds as number,
        maxRetrySeconds: params.maxRetrySeconds as number,
        deadlineSeconds: params.deadlineSeconds as number,
        storage,
      });
    } catch (error) {
      if (error instanceof CourtOutboxError) corrupt(error.message);
      throw error;
    }
    const entries: readonly unknown[] = Array.isArray(snapshot.entries)
      ? snapshot.entries
      : corrupt('snapshot entries must be an array');
    if (entries.length > MAX_ENTRIES) {
      corrupt(`snapshot entries must contain at most ${MAX_ENTRIES} entries`);
    }

    for (const raw of entries) {
      const entry = restoreEntry(raw, outbox.params.deadlineSeconds);
      if (outbox.entries.has(entry.messageKey)) {
        corrupt('snapshot contains duplicate logical message keys');
      }
      outbox.entries.set(entry.messageKey, entry);
    }
    return outbox;
  }

  /**
   * Load and validate the persisted snapshot from storage. Returns null when
   * the host has never persisted (first boot); a present-but-corrupt snapshot
   * throws CourtOutboxError with code corrupt_snapshot.
   */
  static async load(storage: OutboxStorage): Promise<CourtOutbox | null> {
    const data = await storage.load();
    if (data === null || data === undefined) return null;
    return CourtOutbox.fromSnapshot(data, storage);
  }
}

/** Create an empty outbox with a validated retry policy. */
export function createCourtOutbox(params: CourtOutboxParams): CourtOutbox {
  return CourtOutbox.create(params);
}

function restoreEntry(raw: unknown, deadlineSeconds: number): CourtOutboxEntry {
  // See fromSnapshot: declaration form is required for never-call narrowing.
  function corrupt(message: string): never {
    return fail('corrupt_snapshot', message);
  }
  const record: Record<string, unknown> = isRecord(raw)
    ? raw
    : corrupt('entry must be an object');
  try {
    assertHex32(record.messageKey, 'entry.messageKey');
    assertHex32(record.sessionHash, 'entry.sessionHash');
    if (
      !Number.isSafeInteger(record.innerKind)
      || (record.innerKind as number) < 0
      || (record.innerKind as number) > MAX_NOSTR_KIND
    ) {
      corrupt('entry.innerKind must be a valid Nostr kind');
    }
    assertHex32(record.recipientPubkey, 'entry.recipientPubkey');
    assertBoundedText(record.payload, 'entry.payload', MAX_PAYLOAD_BYTES, false);
    assertWrapTemplate(record.wrap);
    if (
      record.status !== 'queued'
      && record.status !== 'sent'
      && record.status !== 'acked'
      && record.status !== 'dead'
    ) {
      corrupt('entry.status is not a known lifecycle status');
    }
    const status = record.status as CourtOutboxEntryStatus;
    if (!Number.isSafeInteger(record.attempts) || (record.attempts as number) < 0) {
      corrupt('entry.attempts must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(record.enqueuedAt) || (record.enqueuedAt as number) < 0) {
      corrupt('entry.enqueuedAt must be a non-negative Unix timestamp');
    }
    if (
      !Number.isSafeInteger(record.deadline)
      || (record.deadline as number) <= (record.enqueuedAt as number)
    ) {
      corrupt('entry.deadline must be later than enqueuedAt');
    }
    // The deadline is fully derivable from data this snapshot already
    // validates; a tampered store must not be able to move it independently.
    if ((record.deadline as number) !== (record.enqueuedAt as number) + deadlineSeconds) {
      corrupt('entry.deadline does not match the snapshot retry policy');
    }
    if (
      !Number.isSafeInteger(record.nextRetryAt)
      || (record.nextRetryAt as number) < (record.enqueuedAt as number)
    ) {
      corrupt('entry.nextRetryAt must be at or after enqueuedAt');
    }
    if (status === 'queued' && record.attempts !== 0) {
      corrupt('a queued entry cannot have recorded send attempts');
    }
    if (status === 'sent' && (record.attempts as number) < 1) {
      corrupt('a sent entry must have at least one send attempt');
    }
    if (record.lastSentAt !== undefined) {
      if (
        !Number.isSafeInteger(record.lastSentAt)
        || (record.lastSentAt as number) < (record.enqueuedAt as number)
      ) {
        corrupt('entry.lastSentAt must be at or after enqueuedAt');
      }
    }
    if (status === 'acked') {
      if (!Number.isSafeInteger(record.ackedAt) || (record.ackedAt as number) < 0) {
        corrupt('an acked entry must carry ackedAt');
      }
      assertHex32(record.ackEventId, 'entry.ackEventId');
      // Never trust self-asserted acked state: the full ack event must be
      // present and re-verify against this entry.
      const inspected = inspectAckEvent(record.ackEvent);
      if (!inspected.ok) {
        corrupt('an acked entry must carry a well-formed, validly signed ack event');
      }
      if (inspected.messageKey !== (record.messageKey as string)) {
        corrupt('the stored ack event does not reference this logical message');
      }
      if (inspected.pubkey !== (record.recipientPubkey as string)) {
        corrupt('the stored ack event is not authored by the addressed recipient');
      }
      if (inspected.id !== (record.ackEventId as string)) {
        corrupt('entry.ackEventId does not match the stored ack event');
      }
    } else if (
      record.ackedAt !== undefined
      || record.ackEventId !== undefined
      || record.ackEvent !== undefined
    ) {
      corrupt('only an acked entry may carry ack fields');
    }
  } catch (error) {
    if (error instanceof CourtOutboxError) {
      if (error.code === 'corrupt_snapshot') throw error;
      corrupt(error.message);
    }
    throw error;
  }

  const entry = record as unknown as CourtOutboxEntry;
  const expectedKey = hashCourtOutboxMessage({
    sessionHash: entry.sessionHash,
    innerKind: entry.innerKind,
    recipientPubkey: entry.recipientPubkey,
    payload: entry.payload,
  });
  if (expectedKey !== entry.messageKey) {
    corrupt('entry message key does not match its logical message');
  }

  const restored: CourtOutboxEntry = {
    messageKey: entry.messageKey,
    sessionHash: entry.sessionHash,
    innerKind: entry.innerKind,
    recipientPubkey: entry.recipientPubkey,
    payload: entry.payload,
    wrap: copyWrap(entry.wrap),
    status: entry.status,
    attempts: entry.attempts,
    enqueuedAt: entry.enqueuedAt,
    deadline: entry.deadline,
    nextRetryAt: entry.nextRetryAt,
    ...(entry.lastSentAt !== undefined ? { lastSentAt: entry.lastSentAt } : {}),
    ...(entry.ackedAt !== undefined ? { ackedAt: entry.ackedAt } : {}),
    ...(entry.ackEventId !== undefined ? { ackEventId: entry.ackEventId } : {}),
    ...(entry.ackEvent !== undefined ? { ackEvent: copyAckEvent(entry.ackEvent) } : {}),
  };
  return restored;
}
