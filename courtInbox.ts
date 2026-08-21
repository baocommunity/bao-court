// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Recipient inbox and relay-group transport policy for BAO Court.
 *
 * This module is the receiving half of the Court's authenticated multi-relay
 * transport. It is deliberately I/O-free: the host owns every socket and
 * injects relay connections behind the {@link CourtRelayConnection}
 * interface, feeds gift wraps into {@link CourtInbox.ingest} with an explicit
 * `now`, and pulls verified inner rumors back out with
 * {@link CourtInbox.drain}. No `Date.now`, no network, no secret keys — the
 * signer surface from `courtSigner.ts` performs all decryption.
 *
 * Three responsibilities:
 *
 * 1. **Scoped subscriptions** ({@link buildCourtSubscriptions}) — from the
 *    validated session parameters, derive deterministic relay filters that
 *    (a) restrict public Court protocol kinds to roster authors bound to the
 *    session hash, and (b) restrict kind-1059 gift-wrap scans to wraps
 *    p-tagged to the local juror, both scoped to the session start time.
 *
 * 2. **Inbound classification** ({@link classifyInboundEvent}) — a total,
 *    never-throwing accept/reject gate with a typed reason union. Structural
 *    classification only; acceptance here never constitutes protocol
 *    acceptance (that remains the strict parsers' job in
 *    `courtProtocolEvents.ts`).
 *
 * 3. **The inbox itself** ({@link CourtInbox}) — deduplicates gift wraps by
 *    wrap id across every relay in the group, records per-relay provenance
 *    and first/last-seen timestamps, rejects wraps not p-tagged to the local
 *    pubkey *before* any decryption can occur, and drains verified inner
 *    rumors (NIP-59 semantics via the signer) sorted by `created_at`.
 *    Snapshots are JSON-safe and versioned; corrupted snapshots are rejected
 *    with a typed {@link CourtInboxError}.
 *
 * Relay-group policy ({@link publishToGroup}, {@link readFromGroup}):
 * writes fan out to every write relay with per-relay error capture — one
 * failing relay never rejects the batch — and reads merge every read relay's
 * subscription stream, tagging each event with the relay that delivered it.
 */

import type { Event as NostrEvent } from 'nostr-tools/pure';
import {
  assertCourtSessionParameters,
  hashCourtSessionParameters,
  type CourtSessionParameters,
} from './courtSession';
import { classifyCourtProtocolEvent } from './courtProtocolEvents';
import {
  unwrapProtocolEventWithSigner,
  type CourtEventSigner,
} from './courtSigner';
import { COURT_DELIVERY_ACK_KIND } from './courtOutbox';
import {
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_FROST_REVEAL_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
} from './events';

/** NIP-59 gift-wrap kind scanned by every Court recipient. */
export const COURT_GIFT_WRAP_KIND = 1059;

/** Snapshot schema version persisted by {@link CourtInbox.snapshot}. */
export const COURT_INBOX_SNAPSHOT_VERSION = 1 as const;

/**
 * NIP-59 randomizes seal/wrap timestamps up to two days into the past, so a
 * wrap published at the session start can carry a `created_at` two days
 * earlier. Wrap scans must look back this far or legitimate wraps are missed.
 */
export const COURT_WRAP_LOOKBACK_SECONDS = 2 * 24 * 60 * 60;

/**
 * Public Court kinds a recipient subscribes to with roster-author scoping:
 * the five session-bound protocol kinds plus signed delivery
 * acknowledgements (authored by roster peers, bound via their `m` tag).
 */
export const COURT_INBOX_PUBLIC_KINDS = [
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_FROST_REVEAL_KIND,
  COURT_DELIVERY_ACK_KIND,
] as const;

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const MAX_NOSTR_KIND = 65_535;
const MAX_RECORDS = 100_000;
const MAX_RELAYS_PER_RECORD = 64;
const MAX_RELAY_URL_BYTES = 512;
const MAX_WRAP_CONTENT_BYTES = 256 * 1024;
const MAX_WRAP_TAGS = 128;
const MAX_WRAP_TAG_ITEMS = 16;
const MAX_WRAP_TAG_ITEM_BYTES = 1024;

const textEncoder = new TextEncoder();

/** Typed failure for every inbox gate; `code` is machine-readable. */
export type CourtInboxErrorCode =
  | 'malformed'
  | 'wrong_recipient'
  | 'capacity_exceeded'
  | 'corrupt_snapshot';

/** Error thrown by every fail-closed inbox gate. */
export class CourtInboxError extends Error {
  readonly code: CourtInboxErrorCode;

  constructor(code: CourtInboxErrorCode, message: string) {
    super(message);
    this.name = 'CourtInboxError';
    this.code = code;
  }
}

function fail(code: CourtInboxErrorCode, message: string): never {
  throw new CourtInboxError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function assertRelayUrl(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || textEncoder.encode(value).length > MAX_RELAY_URL_BYTES
  ) {
    fail('malformed', 'relayUrl must be a non-empty bounded string');
  }
}

/* ------------------------------------------------------------------------- */
/* Relay abstraction                                                          */
/* ------------------------------------------------------------------------- */

/**
 * A Nostr relay filter as constructed by {@link buildCourtSubscriptions}.
 * Plain JSON-safe data; relay clients (nostr-tools, nostrify, nostr-relaypool)
 * all accept this shape.
 */
export interface CourtRelayFilter {
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
  readonly since?: number;
  readonly '#p'?: readonly string[];
  readonly '#session'?: readonly string[];
}

/**
 * Host-injected relay connection. The inbox module never opens sockets;
 * implementations wrap whatever relay client the host already runs.
 * `subscribe` streams events matching the filters until the host closes the
 * subscription (the returned iterable ends or its `return()` is called).
 */
export interface CourtRelayConnection {
  /** Stable relay identifier (typically the WebSocket URL). */
  readonly url: string;
  /** Publish one signed event; rejects on relay-level failure. */
  publish(event: NostrEvent): Promise<void>;
  /** Stream events matching the given filters. */
  subscribe(filters: readonly CourtRelayFilter[]): AsyncIterable<NostrEvent>;
}

/** Per-relay outcome of a {@link publishToGroup} fan-out. */
export interface CourtRelayPublishResult {
  readonly url: string;
  readonly ok: boolean;
  /** Human-readable failure message when ok is false. */
  readonly error?: string;
}

/** Aggregate report of a group publish; always resolves, never rejects. */
export interface CourtRelayPublishReport {
  readonly results: readonly CourtRelayPublishResult[];
  /** URLs of relays that accepted the event, in group order. */
  readonly delivered: readonly string[];
}

/**
 * Publish one event to every relay in the group.
 *
 * Write policy is publish-to-all: each relay is attempted independently and
 * failures are captured per relay. The returned promise never rejects — a
 * partition of one relay must not silence the others, and the caller decides
 * how many deliveries are enough.
 */
export async function publishToGroup(
  event: NostrEvent,
  relays: readonly CourtRelayConnection[],
): Promise<CourtRelayPublishReport> {
  const settled = await Promise.allSettled(relays.map((relay) => relay.publish(event)));
  const results: CourtRelayPublishResult[] = settled.map((outcome, index) => {
    const url = relays[index]?.url ?? `relay#${index}`;
    if (outcome.status === 'fulfilled') return { url, ok: true };
    const reason: unknown = outcome.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    return { url, ok: false, error: message };
  });
  return { results, delivered: results.filter((r) => r.ok).map((r) => r.url) };
}

/** One event delivered by {@link readFromGroup}, tagged with its source. */
export interface CourtGroupDelivery {
  readonly event: NostrEvent;
  /** URL of the relay that delivered this event. */
  readonly relayUrl: string;
}

/**
 * Merge the subscription streams of every relay in the group into one async
 * iterable of provenance-tagged deliveries.
 *
 * Read policy is read-from-all: duplicates across relays are expected and
 * left to the consumer ({@link CourtInbox} dedupes by wrap id). When the
 * consumer stops iterating, every underlying subscription is closed. A relay
 * whose stream throws contributes an immediate end-of-stream for that relay;
 * it never terminates the merged stream for the others.
 */
export async function* readFromGroup(
  relays: readonly CourtRelayConnection[],
  filters: readonly CourtRelayFilter[],
): AsyncGenerator<CourtGroupDelivery, void, undefined> {
  interface Pending {
    readonly index: number;
    readonly promise: Promise<{ index: number; result: IteratorResult<NostrEvent> }>;
  }
  const iterators: (AsyncIterator<NostrEvent> | undefined)[] = relays.map((relay) => {
    try {
      return relay.subscribe(filters)[Symbol.asyncIterator]();
    } catch {
      return undefined;
    }
  });
  const pendings = new Set<Pending>();
  const arm = (index: number): void => {
    const iterator = iterators[index];
    if (!iterator) return;
    const pending: Pending = {
      index,
      promise: iterator.next().then(
        (result) => ({ index, result }),
        () => ({ index, result: { done: true, value: undefined } as IteratorResult<NostrEvent> }),
      ),
    };
    pendings.add(pending);
  };
  for (let index = 0; index < iterators.length; index += 1) arm(index);
  try {
    while (pendings.size > 0) {
      const raced = await Promise.race([...pendings].map((p) => p.promise));
      for (const pending of pendings) {
        if (pending.index === raced.index) {
          pendings.delete(pending);
          break;
        }
      }
      if (raced.result.done || raced.result.value === undefined) {
        iterators[raced.index] = undefined;
        continue;
      }
      const relayUrl = relays[raced.index]?.url ?? `relay#${raced.index}`;
      yield { event: raced.result.value, relayUrl };
      arm(raced.index);
    }
  } finally {
    await Promise.allSettled(
      iterators.map((iterator) => iterator?.return?.(undefined) as Promise<unknown> | undefined),
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Scoped subscription construction                                           */
/* ------------------------------------------------------------------------- */

/** Parameters for {@link buildCourtSubscriptions}. */
export interface CourtSubscriptionParams {
  /** Validated public session parameters (session start = createdAt). */
  readonly session: CourtSessionParameters;
  /** Local recipient's x-only Nostr pubkey (64-char lowercase hex). */
  readonly myPubkey: string;
}

/**
 * Build the deterministic, canonical relay filters for one Court recipient.
 *
 * Two filters are produced, in a fixed order:
 *
 * 1. Public protocol traffic: the Court protocol/ack kinds, restricted to
 *    roster authors (sorted) and to events carrying this session's hash in
 *    their `session` tag, `since` the session start.
 * 2. Private traffic: kind-1059 gift wraps p-tagged to `myPubkey`, `since`
 *    the session start minus the NIP-59 backdating window
 *    ({@link COURT_WRAP_LOOKBACK_SECONDS}) so wraps whose randomized
 *    `created_at` predates the session are still seen.
 *
 * Same inputs always produce deep-equal output: kinds and authors are sorted,
 * and no wall-clock or random state is consulted.
 */
export function buildCourtSubscriptions(
  params: CourtSubscriptionParams,
): readonly CourtRelayFilter[] {
  if (!isRecord(params)) fail('malformed', 'subscription params must be an object');
  assertCourtSessionParameters(params.session);
  assertHex32(params.myPubkey, 'myPubkey');

  const authors = params.session.participants
    .map((participant) => participant.nostrPubkey)
    .sort();
  const kinds = [...COURT_INBOX_PUBLIC_KINDS].sort((a, b) => a - b);
  const sessionHash = hashCourtSessionParameters(params.session);
  const since = params.session.createdAt;

  return [
    { kinds, authors, since, '#session': [sessionHash] },
    {
      kinds: [COURT_GIFT_WRAP_KIND],
      '#p': [params.myPubkey],
      since: Math.max(0, since - COURT_WRAP_LOOKBACK_SECONDS),
    },
  ];
}

/* ------------------------------------------------------------------------- */
/* Inbound classification                                                     */
/* ------------------------------------------------------------------------- */

/** Machine-readable rejection reasons from {@link classifyInboundEvent}. */
export type CourtInboxRejectReason =
  /** Input is not a structurally plausible Nostr event. */
  | 'malformed_event'
  /** Kind is neither a public Court kind nor a gift wrap. */
  | 'wrong_kind'
  /** Public-kind author (or ack signer) is not a roster Nostr pubkey. */
  | 'author_not_in_roster'
  /** Gift wrap carries no 'p' tag for the local recipient pubkey. */
  | 'not_addressed_to_me'
  /** Public event predates the session start. */
  | 'stale_session'
  /** Event is an unbound legacy Court event (history only). */
  | 'legacy_event'
  /** Event mixes bound and unbound structure; never acceptable. */
  | 'invalid_binding'
  /** Bound event's session tag names a different session hash. */
  | 'session_mismatch';

/** Accepted inbound categories from {@link classifyInboundEvent}. */
export type CourtInboxCategory = 'protocol' | 'delivery-ack' | 'gift-wrap';

/** Total (never-throwing) verdict of {@link classifyInboundEvent}. */
export type CourtInboxClassification =
  | { readonly accepted: true; readonly category: CourtInboxCategory }
  | { readonly accepted: false; readonly reason: CourtInboxRejectReason };

/** Parameters for {@link classifyInboundEvent}. */
export interface CourtInboxClassifyParams {
  readonly session: CourtSessionParameters;
  /** Local recipient's x-only Nostr pubkey for gift-wrap address checks. */
  readonly myPubkey: string;
}

function isHex32(value: unknown): value is string {
  return typeof value === 'string' && HEX_32.test(value);
}

/**
 * Classify one inbound relay event against the session and roster.
 *
 * This function is total: adversarial input of any shape yields a typed
 * rejection reason, never a throw. Acceptance is structural only — a bound
 * protocol event must still pass `parseCourtProtocolEvent` (signature,
 * binding, content) before any state machine consumes it, and a gift wrap
 * must still survive signer-backed NIP-59 unwrap verification.
 */
export function classifyInboundEvent(
  event: unknown,
  params: CourtInboxClassifyParams,
): CourtInboxClassification {
  try {
    if (!isRecord(event)) return { accepted: false, reason: 'malformed_event' };
    if (
      typeof event.kind !== 'number'
      || !Number.isSafeInteger(event.kind)
      || event.kind < 0
      || event.kind > MAX_NOSTR_KIND
      || !Array.isArray(event.tags)
      || !event.tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))
      || typeof event.content !== 'string'
      || !isHex32(event.pubkey)
      || !Number.isSafeInteger(event.created_at)
      || (event.created_at as number) < 0
    ) {
      return { accepted: false, reason: 'malformed_event' };
    }
    assertCourtSessionParameters(params.session);
    assertHex32(params.myPubkey, 'myPubkey');

    const session = params.session;

    if (event.kind === COURT_GIFT_WRAP_KIND) {
      const addressed = (event.tags as readonly string[][]).some(
        (tag) => tag[0] === 'p' && tag[1] === params.myPubkey,
      );
      // NIP-59 backdating makes created_at meaningless on wraps; the p-tag is
      // the only structural gate before decryption.
      return addressed
        ? { accepted: true, category: 'gift-wrap' }
        : { accepted: false, reason: 'not_addressed_to_me' };
    }

    if (!(COURT_INBOX_PUBLIC_KINDS as readonly number[]).includes(event.kind)) {
      return { accepted: false, reason: 'wrong_kind' };
    }

    const roster = new Set(session.participants.map((p) => p.nostrPubkey));
    if (!roster.has(event.pubkey as string)) {
      return { accepted: false, reason: 'author_not_in_roster' };
    }
    if ((event.created_at as number) < session.createdAt) {
      return { accepted: false, reason: 'stale_session' };
    }

    // Delivery acks are bound by their ['m', key] tag, not session tags; the
    // outbox performs full signature/author verification on consumption.
    if (event.kind === COURT_DELIVERY_ACK_KIND) {
      return { accepted: true, category: 'delivery-ack' };
    }

    const structural = classifyCourtProtocolEvent({
      tags: event.tags as string[][],
      content: event.content as string,
    });
    if (structural === 'legacy') return { accepted: false, reason: 'legacy_event' };
    if (structural === 'invalid') return { accepted: false, reason: 'invalid_binding' };

    const sessionTag = (event.tags as readonly string[][]).find((tag) => tag[0] === 'session');
    if (sessionTag?.[1] !== hashCourtSessionParameters(session)) {
      return { accepted: false, reason: 'session_mismatch' };
    }
    return { accepted: true, category: 'protocol' };
  } catch {
    return { accepted: false, reason: 'malformed_event' };
  }
}

/* ------------------------------------------------------------------------- */
/* The inbox                                                                  */
/* ------------------------------------------------------------------------- */

/** Stored gift wrap, kept verbatim so drain can verify it after a restart. */
export interface CourtInboxWrap {
  readonly kind: number;
  readonly content: string;
  readonly tags: readonly (readonly string[])[];
  readonly created_at: number;
  readonly pubkey: string;
  readonly id: string;
  readonly sig: string;
}

/** One deduplicated gift wrap tracked by the inbox. Immutable on change. */
export interface CourtInboxRecord {
  /** Gift-wrap event id; the dedupe identity across relays. */
  readonly wrapId: string;
  readonly wrap: CourtInboxWrap;
  /** Sorted relay URLs that delivered this wrap (provenance). */
  readonly relays: readonly string[];
  /** Unix seconds of first delivery. */
  readonly firstSeen: number;
  /** Unix seconds of most recent delivery. */
  readonly lastSeen: number;
  /** Whether drain has already attempted this wrap. */
  readonly drained: boolean;
}

/** Creation parameters for {@link CourtInbox.create}. */
export interface CourtInboxParams {
  /** Local recipient's x-only Nostr pubkey (64-char lowercase hex). */
  readonly myPubkey: string;
}

/** JSON-safe durable form of the whole inbox. */
export interface CourtInboxSnapshot {
  readonly version: typeof COURT_INBOX_SNAPSHOT_VERSION;
  readonly myPubkey: string;
  readonly records: readonly CourtInboxRecord[];
}

/** One verified inner rumor produced by {@link CourtInbox.drain}. */
export interface CourtInboxMessage {
  /** The verified NIP-59 inner rumor (unsigned by construction). */
  readonly rumor: NostrEvent;
  /** Ids of the wraps that carried this rumor. */
  readonly wrapIds: readonly string[];
  /** Sorted relay URLs that delivered any of those wraps. */
  readonly relays: readonly string[];
}

/** Result of {@link CourtInbox.ingest}. */
export interface CourtInboxIngestResult {
  readonly record: CourtInboxRecord;
  /** True when the wrap id was already known (multi-relay redelivery). */
  readonly duplicate: boolean;
}

function assertWrapShape(value: unknown): asserts value is NostrEvent {
  if (!isRecord(value)) fail('malformed', 'wrap event must be an object');
  if (value.kind !== COURT_GIFT_WRAP_KIND) {
    fail('malformed', `inbox accepts only kind ${COURT_GIFT_WRAP_KIND} gift wraps`);
  }
  assertHex32(value.id, 'wrap.id');
  assertHex32(value.pubkey, 'wrap.pubkey');
  if (typeof value.sig !== 'string' || !HEX_64.test(value.sig)) {
    fail('malformed', 'wrap.sig must be 64-byte lowercase hex');
  }
  if (!Number.isSafeInteger(value.created_at) || (value.created_at as number) < 0) {
    fail('malformed', 'wrap.created_at must be a non-negative Unix timestamp');
  }
  if (typeof value.content !== 'string'
    || textEncoder.encode(value.content).length > MAX_WRAP_CONTENT_BYTES) {
    fail('malformed', `wrap.content must be a string of at most ${MAX_WRAP_CONTENT_BYTES} bytes`);
  }
  if (!Array.isArray(value.tags) || value.tags.length > MAX_WRAP_TAGS) {
    fail('malformed', `wrap.tags must be an array of at most ${MAX_WRAP_TAGS} tags`);
  }
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || tag.length > MAX_WRAP_TAG_ITEMS) {
      fail('malformed', 'wrap tags must be bounded arrays');
    }
    for (const item of tag) {
      if (
        typeof item !== 'string'
        || textEncoder.encode(item).length > MAX_WRAP_TAG_ITEM_BYTES
      ) {
        fail('malformed', 'wrap tag items must be bounded strings');
      }
    }
  }
}

function copyWrap(wrap: NostrEvent): CourtInboxWrap {
  return {
    kind: wrap.kind,
    content: wrap.content,
    tags: wrap.tags.map((tag) => [...tag]),
    created_at: wrap.created_at,
    pubkey: wrap.pubkey,
    id: wrap.id,
    sig: wrap.sig,
  };
}

function copyRecord(record: CourtInboxRecord): CourtInboxRecord {
  return {
    ...record,
    wrap: { ...record.wrap, tags: record.wrap.tags.map((tag) => [...tag]) },
    relays: [...record.relays],
  };
}

function compareRecords(a: CourtInboxRecord, b: CourtInboxRecord): number {
  if (a.firstSeen !== b.firstSeen) return a.firstSeen - b.firstSeen;
  return a.wrapId < b.wrapId ? -1 : a.wrapId > b.wrapId ? 1 : 0;
}

/**
 * Recipient inbox for Court gift wraps over a relay group.
 *
 * Ingest dedupes by wrap id (the same wrap arriving from three relays is one
 * record with three provenance entries) and refuses wraps not p-tagged to
 * `myPubkey` before they are stored — so no code path can ever attempt to
 * decrypt a wrap addressed to someone else. Drain then re-checks the address
 * through the signer-backed NIP-59 unwrap, which verifies every layer.
 */
export class CourtInbox {
  private readonly myPubkey: string;
  private readonly records = new Map<string, CourtInboxRecord>();

  private constructor(params: CourtInboxParams) {
    if (!isRecord(params)) fail('malformed', 'inbox params must be an object');
    assertHex32(params.myPubkey, 'myPubkey');
    this.myPubkey = params.myPubkey;
  }

  /** Create an empty inbox for one recipient pubkey. */
  static create(params: CourtInboxParams): CourtInbox {
    return new CourtInbox(params);
  }

  /** The recipient pubkey this inbox accepts wraps for. */
  get recipientPubkey(): string {
    return this.myPubkey;
  }

  /**
   * Ingest one gift wrap delivered by `relayUrl` at `now` (Unix seconds).
   *
   * Rejects, with a typed {@link CourtInboxError}:
   * - malformed wraps (`malformed`) — kind, id, pubkey, sig, tags, content
   *   are all shape-checked and bounded;
   * - wraps whose tags carry no `['p', myPubkey]` (`wrong_recipient`) — this
   *   check runs before storage and before any decrypt-capable code path;
   * - wraps beyond the capacity bound (`capacity_exceeded`).
   *
   * Re-delivery of a known wrap id is idempotent: the relay is added to the
   * record's provenance and `lastSeen` advances; `firstSeen` never moves.
   */
  ingest(wrapEvent: unknown, relayUrl: string, now: number): CourtInboxIngestResult {
    assertNow(now);
    assertRelayUrl(relayUrl);
    assertWrapShape(wrapEvent);

    // Recipient gate first: a wrap not addressed to this inbox is rejected
    // before storage, long before any signer/decrypt path exists.
    const addressed = wrapEvent.tags.some(
      (tag) => tag[0] === 'p' && tag[1] === this.myPubkey,
    );
    if (!addressed) {
      fail('wrong_recipient', 'gift wrap is not addressed to this inbox recipient');
    }

    const existing = this.records.get(wrapEvent.id);
    if (existing) {
      const relays = existing.relays.includes(relayUrl)
        ? existing.relays
        : [...existing.relays, relayUrl].sort();
      const next: CourtInboxRecord = {
        ...existing,
        relays,
        lastSeen: Math.max(existing.lastSeen, now),
      };
      this.records.set(existing.wrapId, next);
      return { record: copyRecord(next), duplicate: true };
    }

    if (this.records.size >= MAX_RECORDS) {
      fail('capacity_exceeded', `inbox capacity of ${MAX_RECORDS} records exceeded`);
    }
    const record: CourtInboxRecord = {
      wrapId: wrapEvent.id,
      wrap: copyWrap(wrapEvent),
      relays: [relayUrl],
      firstSeen: now,
      lastSeen: now,
      drained: false,
    };
    this.records.set(record.wrapId, record);
    return { record: copyRecord(record), duplicate: false };
  }

  /**
   * Drain all undrained wraps: NIP-59-unwrap each through the signer and
   * return the verified inner rumors sorted by `created_at` (ties broken by
   * rumor id for determinism).
   *
   * Follows `unwrapProtocolEventsWithSigner` semantics per wrap so each
   * message keeps its provenance: every layer is verified (address, seal
   * signature, seal-author == rumor-author, rumor id commitment). Wraps that
   * fail verification are marked drained and dropped — junk never retries
   * and never throws out of drain. Rumors arriving via multiple wraps
   * (re-wrapped duplicates) are merged into one message with combined
   * provenance. Every attempted record is marked drained.
   */
  async drain(signer: CourtEventSigner): Promise<readonly CourtInboxMessage[]> {
    const pending = [...this.records.values()]
      .filter((record) => !record.drained)
      .sort(compareRecords);

    const byRumorId = new Map<
      string,
      { rumor: NostrEvent; wrapIds: string[]; relays: Set<string> }
    >();
    for (const record of pending) {
      let rumor: NostrEvent | null = null;
      try {
        rumor = await unwrapProtocolEventWithSigner(record.wrap as unknown as NostrEvent, signer);
      } catch (err) {
        // If the signer fails transiently, do NOT mark the wrap as drained —
        // it should be retried on the next drain call once the signer recovers.
        // Only wraps that either unwrap cleanly or explicitly return null
        // (invalid structure) are permanently dropped.
        this.records.set(record.wrapId, { ...record, drained: false });
        return Array.from(byRumorId.values()).map((entry): CourtInboxMessage => ({
          rumor: entry.rumor,
          wrapIds: entry.wrapIds,
          relays: [...entry.relays].sort(),
        }));
      }
      this.records.set(record.wrapId, { ...record, drained: true });
      if (!rumor || typeof rumor.id !== 'string') continue;
      const existing = byRumorId.get(rumor.id);
      if (existing) {
        existing.wrapIds.push(record.wrapId);
        for (const url of record.relays) existing.relays.add(url);
      } else {
        byRumorId.set(rumor.id, {
          rumor,
          wrapIds: [record.wrapId],
          relays: new Set(record.relays),
        });
      }
    }

    return [...byRumorId.values()]
      .map((entry): CourtInboxMessage => ({
        rumor: entry.rumor,
        wrapIds: entry.wrapIds,
        relays: [...entry.relays].sort(),
      }))
      .sort((a, b) => {
        if (a.rumor.created_at !== b.rumor.created_at) {
          return a.rumor.created_at - b.rumor.created_at;
        }
        return a.rumor.id < b.rumor.id ? -1 : a.rumor.id > b.rumor.id ? 1 : 0;
      });
  }

  /** Look up one record by wrap id, or undefined if absent. */
  getRecord(wrapId: string): CourtInboxRecord | undefined {
    if (!HEX_32.test(wrapId)) return undefined;
    const record = this.records.get(wrapId);
    return record ? copyRecord(record) : undefined;
  }

  /** All records, ordered by first-seen time then wrap id. */
  listRecords(): readonly CourtInboxRecord[] {
    return [...this.records.values()].sort(compareRecords).map(copyRecord);
  }

  /** JSON-safe deep-copied snapshot suitable for atomic persistence. */
  snapshot(): CourtInboxSnapshot {
    return {
      version: COURT_INBOX_SNAPSHOT_VERSION,
      myPubkey: this.myPubkey,
      records: this.listRecords(),
    };
  }

  /**
   * Validate and rehydrate an inbox from a snapshot. Any structural or
   * coherence failure — wrong version, duplicate wrap ids, empty provenance,
   * `lastSeen < firstSeen`, a wrap not addressed to the snapshot's own
   * recipient, or a recipient mismatch against `expectedMyPubkey` — rejects
   * the whole snapshot with code corrupt_snapshot.
   */
  static fromSnapshot(data: unknown, expectedMyPubkey?: string): CourtInbox {
    const corrupt = (message: string): never => fail('corrupt_snapshot', message);
    const snapshot: Record<string, unknown> = isRecord(data)
      ? data
      : corrupt('snapshot must be an object');
    if (snapshot.version !== COURT_INBOX_SNAPSHOT_VERSION) {
      corrupt('unsupported snapshot version');
    }
    try {
      assertHex32(snapshot.myPubkey, 'snapshot.myPubkey');
    } catch (error) {
      if (error instanceof CourtInboxError) corrupt(error.message);
      throw error;
    }
    if (expectedMyPubkey !== undefined) {
      try {
        assertHex32(expectedMyPubkey, 'expectedMyPubkey');
      } catch (error) {
        if (error instanceof CourtInboxError) {
          throw new CourtInboxError('malformed', error.message);
        }
        throw error;
      }
      if (snapshot.myPubkey !== expectedMyPubkey) {
        corrupt('snapshot recipient does not match the expected pubkey');
      }
    }
    const rawRecords: readonly unknown[] = Array.isArray(snapshot.records)
      ? snapshot.records
      : corrupt('snapshot records must be an array');
    if (rawRecords.length > MAX_RECORDS) {
      corrupt(`snapshot records must contain at most ${MAX_RECORDS} entries`);
    }

    const inbox = new CourtInbox({ myPubkey: snapshot.myPubkey as string });
    for (const raw of rawRecords) {
      const record = restoreRecord(raw, snapshot.myPubkey as string);
      if (inbox.records.has(record.wrapId)) {
        corrupt('snapshot contains duplicate wrap ids');
      }
      inbox.records.set(record.wrapId, record);
    }
    return inbox;
  }
}

/** Create an empty inbox for one recipient pubkey. */
export function createCourtInbox(params: CourtInboxParams): CourtInbox {
  return CourtInbox.create(params);
}

function restoreRecord(raw: unknown, myPubkey: string): CourtInboxRecord {
  const corrupt = (message: string): never => fail('corrupt_snapshot', message);
  const record: Record<string, unknown> = isRecord(raw)
    ? raw
    : corrupt('record must be an object');

  const rawRelays: unknown = record.relays;
  try {
    assertHex32(record.wrapId, 'record.wrapId');
    assertWrapShape(record.wrap);
    if (!Array.isArray(rawRelays)
      || rawRelays.length === 0
      || rawRelays.length > MAX_RELAYS_PER_RECORD) {
      corrupt('record.relays must be a non-empty bounded array');
    }
    const relayUrls = rawRelays as readonly unknown[];
    for (const url of relayUrls) assertRelayUrl(url);
    if (new Set(relayUrls).size !== relayUrls.length) {
      corrupt('record.relays must not contain duplicates');
    }
    if (!Number.isSafeInteger(record.firstSeen) || (record.firstSeen as number) < 0) {
      corrupt('record.firstSeen must be a non-negative Unix timestamp');
    }
    if (
      !Number.isSafeInteger(record.lastSeen)
      || (record.lastSeen as number) < (record.firstSeen as number)
    ) {
      corrupt('record.lastSeen must be at or after firstSeen');
    }
    if (typeof record.drained !== 'boolean') {
      corrupt('record.drained must be a boolean');
    }
  } catch (error) {
    if (error instanceof CourtInboxError) {
      if (error.code === 'corrupt_snapshot') throw error;
      corrupt(error.message);
    }
    throw error;
  }

  const wrap = record.wrap as unknown as NostrEvent;
  if (wrap.id !== record.wrapId) {
    corrupt('record wrap id does not match its stored wrap');
  }
  const addressed = wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === myPubkey);
  if (!addressed) {
    corrupt('record wrap is not addressed to the snapshot recipient');
  }

  return {
    wrapId: record.wrapId,
    wrap: copyWrap(wrap),
    relays: [...(rawRelays as readonly string[])].sort(),
    firstSeen: record.firstSeen as number,
    lastSeen: record.lastSeen as number,
    drained: record.drained as boolean,
  };
}
