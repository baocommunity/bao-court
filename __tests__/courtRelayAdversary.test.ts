// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Adversarial tests for the Court multi-relay transport layer.
 *
 * Threat model: a malicious relay can drop, replay, reorder, duplicate,
 * withhold, delay, and forge events; malicious peers can forge or replay
 * acks; a tampered local store can hand back corrupted snapshots. Every
 * module is expected to fail closed — these tests prove it with real
 * Schnorr keys and injected clocks (no Date.now in assertions).
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { nip59 } from 'nostr-tools';
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  verifyEvent,
  verifiedSymbol,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';

import {
  COURT_GIFT_WRAP_KIND,
  COURT_INBOX_PUBLIC_KINDS,
  COURT_INBOX_SNAPSHOT_VERSION,
  CourtInbox,
  CourtInboxError,
  buildCourtSubscriptions,
  classifyInboundEvent,
  createCourtInbox,
  publishToGroup,
  readFromGroup,
  type CourtInboxClassifyParams,
  type CourtInboxErrorCode,
  type CourtRelayConnection,
  type CourtRelayFilter,
} from '../courtInbox';
import {
  COURT_DELIVERY_ACK_KIND,
  CourtOutbox,
  CourtOutboxError,
  createCourtOutbox,
  hashCourtOutboxMessage,
  type CourtOutboxEnqueueInput,
  type CourtOutboxErrorCode,
  type CourtOutboxWrapTemplate,
} from '../courtOutbox';
import { bindCourtProtocolEvent } from '../courtProtocolEvents';
import { hashCourtSessionParameters, type CourtSessionParameters } from '../courtSession';
import {
  SeckeyCourtSigner,
  unwrapProtocolEventWithSigner,
  unwrapProtocolEventsWithSigner,
  wrapProtocolEventWithSigner,
  type CourtEventSigner,
} from '../courtSigner';
import { BAO_COURT_VOTE_COMMIT_KIND, buildVoteCommitEvent } from '../events';

/* ------------------------------------------------------------------------- */
/* Inbox fixtures (mirrors courtInbox.test.ts)                                */
/* ------------------------------------------------------------------------- */

function secret(byte: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = byte;
  return value;
}

function nostrPubkey(byte: number): string {
  return bytesToHex(schnorr.getPublicKey(secret(byte)));
}

function hostPubkey(byte: number): string {
  return bytesToHex(secp256k1.getPublicKey(secret(byte), true));
}

const OUTSIDER_BYTE = 9;
const SESSION_CREATED = 1_787_000_000;

function parameters(): CourtSessionParameters {
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: 'pedpop-v1-experimental',
    disputeEventId: '11'.repeat(32),
    disputeId: 'dispute:inbox:1',
    marketId: 'market-inbox',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_777,
    participants: [
      {
        idx: 1,
        nostrPubkey: nostrPubkey(1),
        hostPubkey: hostPubkey(11),
        bondRef: 'signet:bond:inbox-one',
        role: 'juror-coordinator',
      },
      {
        idx: 2,
        nostrPubkey: nostrPubkey(2),
        hostPubkey: hostPubkey(12),
        bondRef: 'signet:bond:inbox-two',
        role: 'juror',
      },
      {
        idx: 3,
        nostrPubkey: nostrPubkey(3),
        hostPubkey: hostPubkey(13),
        bondRef: 'signet:bond:inbox-three',
        role: 'juror',
      },
    ],
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 1,
    createdAt: SESSION_CREATED,
    deadline: SESSION_CREATED + 3_600,
  };
}

const MY_BYTE = 2;
const MY_PUBKEY = nostrPubkey(MY_BYTE);

function classifyParams(): CourtInboxClassifyParams {
  return { session: parameters(), myPubkey: MY_PUBKEY };
}

function boundVoteCommitTemplate(signerByte: number, createdAt: number): EventTemplate {
  const legacy = buildVoteCommitEvent({
    disputeId: parameters().disputeId,
    jurorIdx: signerByte,
    commitHash: '55'.repeat(32),
  });
  const bound = bindCourtProtocolEvent(legacy, parameters(), signerByte);
  return { ...bound, created_at: createdAt };
}

function signTemplate(template: EventTemplate, signerByte: number): NostrEvent {
  return finalizeEvent(template, secret(signerByte));
}

function rumorTemplate(createdAt: number, marker: string): Omit<NostrEvent, 'id' | 'sig' | 'pubkey'> {
  return {
    kind: BAO_COURT_VOTE_COMMIT_KIND,
    created_at: createdAt,
    tags: [['dispute', parameters().disputeId]],
    content: JSON.stringify({ marker }),
  };
}

async function wrapTo(
  rumor: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
  recipientPubkey: string,
  senderByte = 1,
): Promise<NostrEvent> {
  return wrapProtocolEventWithSigner(rumor, new SeckeyCourtSigner(secret(senderByte)), recipientPubkey);
}

function expectInboxError(fn: () => unknown, code: CourtInboxErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtInboxError);
    expect((error as CourtInboxError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtInboxError with code ${code}`);
}

function jsonRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** Structural fake wrap: shape-valid, no crypto. Ingest is shape-only. */
function fakeWrap(overrides: Record<string, unknown> = {}): NostrEvent {
  return {
    kind: COURT_GIFT_WRAP_KIND,
    id: 'ab'.repeat(32),
    pubkey: 'cd'.repeat(32),
    sig: 'ef'.repeat(64),
    created_at: 0,
    content: 'payload',
    tags: [['p', MY_PUBKEY]],
    ...overrides,
  } as unknown as NostrEvent;
}

class FakeRelay implements CourtRelayConnection {
  returnCalls = 0;

  constructor(
    readonly url: string,
    private readonly behavior: {
      readonly failPublish?: boolean;
      readonly events?: readonly NostrEvent[];
      readonly throwOnSubscribe?: boolean;
      /** next() rejects with Error('stream died') when reaching this index. */
      readonly failAtIndex?: number;
      /** next() yields {done:false, value:undefined} at this index. */
      readonly undefinedAtIndex?: number;
    } = {},
  ) {}

  publish(): Promise<void> {
    if (this.behavior.failPublish) {
      return Promise.reject(new Error(`relay ${this.url} down`));
    }
    return Promise.resolve();
  }

  subscribe(_filters: readonly CourtRelayFilter[]): AsyncIterable<NostrEvent> {
    if (this.behavior.throwOnSubscribe) {
      throw new Error('subscribe blew up');
    }
    const events = this.behavior.events ?? [];
    const failAt = this.behavior.failAtIndex;
    const undefinedAt = this.behavior.undefinedAtIndex;
    const relay = this;
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<NostrEvent>> {
            if (failAt !== undefined && index === failAt) {
              index += 1;
              return Promise.reject(new Error('stream died'));
            }
            if (undefinedAt !== undefined && index === undefinedAt) {
              index += 1;
              return Promise.resolve({ done: false, value: undefined as unknown as NostrEvent });
            }
            if (index >= events.length) {
              return Promise.resolve({ done: true, value: undefined });
            }
            const event = events[index] as NostrEvent;
            index += 1;
            return Promise.resolve({ done: false, value: event });
          },
          return(): Promise<IteratorResult<NostrEvent>> {
            relay.returnCalls += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Outbox fixtures (mirrors courtOutbox.test.ts)                              */
/* ------------------------------------------------------------------------- */

const RECIPIENT_SECKEY = new Uint8Array(32).fill(1);
const OTHER_SECKEY = new Uint8Array(32).fill(2);
const RECIPIENT_PUBKEY = getPublicKey(RECIPIENT_SECKEY);
const OTHER_PUBKEY = getPublicKey(OTHER_SECKEY);

const SESSION = '11'.repeat(32);
const OTHER_SESSION = '22'.repeat(32);
const WRAP_ID_A = 'aa'.repeat(32);
const WRAP_ID_B = 'bb'.repeat(32);
const WRAP_PUBKEY = '33'.repeat(32);
const WRAP_SIG = 'ab'.repeat(64);
const PAYLOAD = JSON.stringify({ kind: 39004, dispute: 'd-1', round: 1 });

const PARAMS = { initialRetrySeconds: 10, maxRetrySeconds: 100, deadlineSeconds: 10_000 };

function wrapTemplate(id: string, overrides: Partial<CourtOutboxWrapTemplate> = {}): CourtOutboxWrapTemplate {
  return {
    kind: 1059,
    content: `ciphertext-for-${id.slice(0, 4)}`,
    tags: [['p', RECIPIENT_PUBKEY]],
    created_at: 400,
    pubkey: WRAP_PUBKEY,
    id,
    sig: WRAP_SIG,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CourtOutboxEnqueueInput> = {}): CourtOutboxEnqueueInput {
  return {
    sessionHash: SESSION,
    innerKind: 39004,
    recipientPubkey: RECIPIENT_PUBKEY,
    payload: PAYLOAD,
    wrap: wrapTemplate(WRAP_ID_A),
    ...overrides,
  };
}

function makeOutbox(params = PARAMS): CourtOutbox {
  return createCourtOutbox(params);
}

function signAck(
  seckey: Uint8Array,
  messageKey: string,
  wrapId: string,
  overrides: Partial<Pick<NostrEvent, 'kind' | 'content' | 'created_at'>> = {},
): NostrEvent {
  return finalizeEvent(
    {
      kind: overrides.kind ?? COURT_DELIVERY_ACK_KIND,
      created_at: overrides.created_at ?? 500,
      tags: [
        ['m', messageKey],
        ['e', wrapId],
      ],
      content: overrides.content ?? '',
    },
    seckey,
  );
}

function expectOutboxError(fn: () => unknown, code: CourtOutboxErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtOutboxError);
    expect((error as CourtOutboxError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtOutboxError with code ${code}`);
}

/** Mutable view of a JSON-round-tripped outbox snapshot. */
interface MutableOutboxSnapshot {
  version: number;
  params: Record<string, number>;
  entries: Record<string, unknown>[];
}

/** Mutable view of a JSON-round-tripped inbox snapshot. */
interface MutableInboxSnapshot {
  version: number;
  myPubkey: string;
  records: Record<string, unknown>[];
}

function ackedOutbox(): { outbox: CourtOutbox; key: string; ack: NostrEvent } {
  const outbox = makeOutbox();
  const entry = outbox.enqueue(makeInput(), 0);
  outbox.markSent(entry.messageKey, 0);
  const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
  outbox.recordAck(ack, 5);
  return { outbox, key: entry.messageKey, ack };
}

function sentOutbox(): { outbox: CourtOutbox; key: string } {
  const outbox = makeOutbox();
  const entry = outbox.enqueue(makeInput(), 0);
  outbox.markSent(entry.messageKey, 0);
  return { outbox, key: entry.messageKey };
}

/* ------------------------------------------------------------------------- */
/* Signer fixtures (mirrors courtSigner.test.ts)                              */
/* ------------------------------------------------------------------------- */

const ALICE_SECKEY = '1'.repeat(64);
const BOB_SECKEY = '2'.repeat(64);
const CAROL_SECKEY = '3'.repeat(64);

const alice = new SeckeyCourtSigner(ALICE_SECKEY);
const bob = new SeckeyCourtSigner(BOB_SECKEY);
const carol = new SeckeyCourtSigner(CAROL_SECKEY);

const ALICE_PUB = alice.getPublicKey();
const BOB_PUB = bob.getPublicKey();
const CAROL_PUB = carol.getPublicKey();

const TEMPLATE = {
  kind: 32123,
  content: '{"share":"deadbeef"}',
  tags: [['dispute', 'dispute-1']],
  created_at: 1_750_000_000,
};

/** Signer decorator whose encrypt/decrypt are vi.fn spies over a real key. */
class SpySigner implements CourtEventSigner {
  readonly encryptSpy;
  readonly decryptSpy;
  private readonly inner: SeckeyCourtSigner;

  constructor(seckey: string) {
    this.inner = new SeckeyCourtSigner(seckey);
    this.encryptSpy = vi.fn((peer: string, plaintext: string) => this.inner.nip44Encrypt(peer, plaintext));
    this.decryptSpy = vi.fn((peer: string, ciphertext: string) => this.inner.nip44Decrypt(peer, ciphertext));
  }

  getPublicKey(): string {
    return this.inner.getPublicKey();
  }

  signEvent(
    template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
  ): Promise<NostrEvent> {
    return this.inner.signEvent(template);
  }

  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return this.encryptSpy(peerPubkey, plaintext) as Promise<string>;
  }

  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.decryptSpy(peerPubkey, ciphertext) as Promise<string>;
  }
}

/** Forge-reseal-rewrap: the canonical attacker wrap builder. */
async function resealAndRewrap(rumor: unknown, recipientPubkey = BOB_PUB): Promise<NostrEvent> {
  const sealContent = await alice.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  const seal = await alice.signEvent({
    kind: 13,
    content: sealContent,
    created_at: 1_750_000_000,
    tags: [],
  });
  return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
}

/* ------------------------------------------------------------------------- */
/* Forge: inbound classification and ingest gates                             */
/* ------------------------------------------------------------------------- */

describe('forge: a relay that rewrites wrap address tags cannot reach plaintext', () => {
  it('a foreign wrap with an attacker-appended p-tag classifies structurally but drains to nothing', async () => {
    const foreign = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'foreign'), nostrPubkey(3));
    const forged: NostrEvent = {
      kind: COURT_GIFT_WRAP_KIND,
      id: 'ab'.repeat(32),
      pubkey: foreign.pubkey,
      sig: 'cd'.repeat(64),
      created_at: foreign.created_at,
      content: foreign.content,
      tags: [...foreign.tags, ['p', MY_PUBKEY]],
    };

    // Classification is structural only: the p-tag is present, so the wrap
    // category applies — acceptance here is never protocol acceptance.
    expect(classifyInboundEvent(forged, classifyParams())).toEqual({
      accepted: true,
      category: 'gift-wrap',
    });

    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    const ingested = inbox.ingest(forged, 'wss://relay-a.example', 1_000);
    expect(ingested.duplicate).toBe(false);

    // The ciphertext is encrypted to nostrPubkey(3): the signer-backed unwrap
    // fails and the record is drained without ever yielding a rumor.
    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toEqual([]);
    expect(inbox.getRecord(forged.id)?.drained).toBe(true);
    expect(inbox.listRecords()).toHaveLength(1);
  });

  it('malformed p-tag variants never count as addressed', () => {
    const variants: unknown[][][] = [
      [['P', MY_PUBKEY]], // uppercase marker
      [['p']], // missing value
      [['p', MY_PUBKEY.toUpperCase()]], // uppercase hex value
      [[MY_PUBKEY]], // pubkey in marker position
      [['x', 'p', MY_PUBKEY]], // value in wrong slot
    ];
    for (const tags of variants) {
      const wrap = fakeWrap({ tags });
      expect(classifyInboundEvent(wrap, classifyParams())).toEqual({
        accepted: false,
        reason: 'not_addressed_to_me',
      });
      const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
      expectInboxError(() => inbox.ingest(wrap, 'wss://relay-a.example', 1_000), 'wrong_recipient');
      expect(inbox.listRecords()).toHaveLength(0);
    }
  });

  it('a relay that grafts an attacker p-tag onto someone else\'s wrap fails closed at decrypt', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const grafted = { ...wrap, tags: [...wrap.tags, ['p', CAROL_PUB]] };
    // Carol passes the address gate, but the content is NIP-44 encrypted to
    // Bob, so her decrypt throws inside the catch-all.
    await expect(unwrapProtocolEventWithSigner(grafted, carol)).resolves.toBeNull();
  });
});

describe('forge: classification boundary conditions', () => {
  it('accepts a protocol event at exactly session.createdAt and rejects one second earlier', () => {
    expect(
      classifyInboundEvent(
        signTemplate(boundVoteCommitTemplate(1, SESSION_CREATED), 1),
        classifyParams(),
      ),
    ).toEqual({ accepted: true, category: 'protocol' });
    expect(
      classifyInboundEvent(
        signTemplate(boundVoteCommitTemplate(1, SESSION_CREATED - 1), 1),
        classifyParams(),
      ),
    ).toEqual({ accepted: false, reason: 'stale_session' });
  });

  it('rejects a roster-signed ack replayed from a previous session epoch as stale', () => {
    const ack: EventTemplate = {
      kind: COURT_DELIVERY_ACK_KIND,
      created_at: SESSION_CREATED - 1,
      tags: [
        ['m', '66'.repeat(32)],
        ['e', '77'.repeat(32)],
      ],
      content: '',
    };
    expect(classifyInboundEvent(signTemplate(ack, 1), classifyParams())).toEqual({
      accepted: false,
      reason: 'stale_session',
    });
  });

  it('out-of-range kinds are malformed and in-range non-Court kinds are wrong_kind', () => {
    const base = {
      tags: [] as string[][],
      content: '',
      pubkey: nostrPubkey(1),
      created_at: SESSION_CREATED + 10,
    };
    for (const kind of [65_536, -1, 1059.5]) {
      expect(classifyInboundEvent({ ...base, kind }, classifyParams())).toEqual({
        accepted: false,
        reason: 'malformed_event',
      });
    }
    expect(classifyInboundEvent({ ...base, kind: 65_535 }, classifyParams())).toEqual({
      accepted: false,
      reason: 'wrong_kind',
    });
  });

  it('a wrap\'s created_at is never a freshness gate', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'fresh'), MY_PUBKEY);
    for (const created_at of [0, Number.MAX_SAFE_INTEGER]) {
      expect(classifyInboundEvent({ ...wrap, created_at }, classifyParams())).toEqual({
        accepted: true,
        category: 'gift-wrap',
      });
    }
  });

  it('ack classification is structural and does not verify the m-tag binding', () => {
    const ackWith = (tags: string[][], signerByte: number): NostrEvent =>
      signTemplate(
        { kind: COURT_DELIVERY_ACK_KIND, created_at: SESSION_CREATED + 10, tags, content: '' },
        signerByte,
      );
    expect(
      classifyInboundEvent(
        ackWith(
          [
            ['m', '66'.repeat(32)],
            ['m', '77'.repeat(32)],
            ['e', '88'.repeat(32)],
          ],
          1,
        ),
        classifyParams(),
      ),
    ).toEqual({ accepted: true, category: 'delivery-ack' });
    expect(
      classifyInboundEvent(ackWith([['e', '88'.repeat(32)]], 1), classifyParams()),
    ).toEqual({ accepted: true, category: 'delivery-ack' });
    expect(
      classifyInboundEvent(
        ackWith(
          [
            ['m', '66'.repeat(32)],
            ['e', '77'.repeat(32)],
          ],
          OUTSIDER_BYTE,
        ),
        classifyParams(),
      ),
    ).toEqual({ accepted: false, reason: 'author_not_in_roster' });
  });
});

/* ------------------------------------------------------------------------- */
/* Replay/duplicate: inbox ingest                                             */
/* ------------------------------------------------------------------------- */

describe('replay: inbox ingest dedupe cannot be used to overwrite or re-deliver', () => {
  it('a different wrap reusing a known wrap id never overwrites the stored record', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'dedupe'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);

    // Relay B delivers a different wrap object carrying the SAME wrap id.
    const spoof: NostrEvent = {
      kind: COURT_GIFT_WRAP_KIND,
      id: wrap.id,
      pubkey: 'ee'.repeat(32),
      sig: 'ef'.repeat(64),
      created_at: wrap.created_at,
      content: 'attacker-controlled-bytes',
      tags: [['p', MY_PUBKEY]],
    } as unknown as NostrEvent;
    const second = inbox.ingest(spoof, 'wss://relay-b.example', 1_050);
    expect(second.duplicate).toBe(true);

    const record = inbox.getRecord(wrap.id);
    expect(record?.wrap.content).toBe(wrap.content);
    expect(record?.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);

    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.rumor.content ?? '{}').marker).toBe('dedupe');
  });

  it('a wrap re-delivered after drain never re-decrypts or double-delivers', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'once'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    const first = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(first).toHaveLength(1);

    expect(inbox.ingest(wrap, 'wss://relay-a.example', 2_000).duplicate).toBe(true);
    expect(inbox.ingest(wrap, 'wss://relay-b.example', 3_000).duplicate).toBe(true);
    expect(inbox.getRecord(wrap.id)?.drained).toBe(true);
    await expect(inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
  });

  it('lastSeen never regresses when a replay arrives with an earlier now', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'clock'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    inbox.ingest(wrap, 'wss://relay-b.example', 1_100);
    const replayed = inbox.ingest(wrap, 'wss://relay-c.example', 500);
    expect(replayed.duplicate).toBe(true);
    expect(replayed.record.firstSeen).toBe(1_000);
    expect(replayed.record.lastSeen).toBe(1_100);
    expect(replayed.record.relays).toEqual([
      'wss://relay-a.example',
      'wss://relay-b.example',
      'wss://relay-c.example',
    ]);
  });

  it('caller-side mutation of the wrap or of returned records cannot corrupt inbox state', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'isolation'), MY_PUBKEY);
    const originalContent = wrap.content;
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);

    // Mutate the caller's event object after ingest.
    (wrap.tags as string[][]).push(['x', 'y']);
    (wrap as { content: string }).content = 'junk';
    const record = inbox.getRecord(wrap.id);
    expect(record?.wrap.content).toBe(originalContent);
    expect(record?.wrap.tags.some((tag) => tag[0] === 'x')).toBe(false);

    // Mutate the records handed back to the caller.
    (record?.relays as string[]).push('wss://evil.example');
    (record?.wrap.tags as string[][]).push(['z', 'z']);
    const listed = inbox.listRecords()[0];
    (listed?.wrap as { content: string }).content = 'junk2';

    const reread = inbox.getRecord(wrap.id);
    expect(reread?.wrap.content).toBe(originalContent);
    expect(reread?.relays).toEqual(['wss://relay-a.example']);
    expect(reread?.wrap.tags.some((tag) => tag[0] === 'z')).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Forge: ingest input hygiene                                                */
/* ------------------------------------------------------------------------- */

describe('forge: ingest input hygiene', () => {
  it('rejects NaN, fractional, negative, and unsafe-integer now values', () => {
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    for (const now of [NaN, 1.5, -1, 2 ** 53, Infinity]) {
      expectInboxError(() => inbox.ingest(fakeWrap(), 'wss://relay-a.example', now), 'malformed');
    }
    // Zero is the accepted lower boundary.
    expect(inbox.ingest(fakeWrap(), 'wss://relay-a.example', 0).duplicate).toBe(false);
  });

  it('rejects untrimmed or over-length relay URLs and accepts a 512-byte URL', () => {
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    expectInboxError(
      () => inbox.ingest(fakeWrap({ id: '01'.repeat(32) }), ' wss://relay-a.example', 0),
      'malformed',
    );
    expectInboxError(
      () => inbox.ingest(fakeWrap({ id: '02'.repeat(32) }), 'wss://relay-a.example ', 0),
      'malformed',
    );
    const oversized = `wss://${'a'.repeat(507)}`; // 513 bytes
    expect(new TextEncoder().encode(oversized).length).toBe(513);
    expectInboxError(() => inbox.ingest(fakeWrap({ id: '03'.repeat(32) }), oversized, 0), 'malformed');
    const atLimit = `wss://${'a'.repeat(506)}`; // 512 bytes
    expect(new TextEncoder().encode(atLimit).length).toBe(512);
    expect(inbox.ingest(fakeWrap({ id: '04'.repeat(32) }), atLimit, 0).duplicate).toBe(false);
  });

  it('enforces wrap content/tag/tag-item byte and count caps at the boundary', () => {
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    let id = 0;
    const nextId = (): string => {
      id += 1;
      return id.toString(16).padStart(64, '0');
    };
    const ingest = (wrap: NostrEvent): void => {
      inbox.ingest(wrap, 'wss://relay-a.example', 0);
    };

    // Content cap: 256 KiB accepted, +1 rejected.
    ingest(fakeWrap({ id: nextId(), content: 'x'.repeat(256 * 1024) }));
    expectInboxError(
      () => ingest(fakeWrap({ id: nextId(), content: 'x'.repeat(256 * 1024 + 1) })),
      'malformed',
    );

    // Tag count cap: 128 accepted, 129 rejected.
    const filler = Array.from({ length: 127 }, () => ['t', 'v']);
    ingest(fakeWrap({ id: nextId(), tags: [['p', MY_PUBKEY], ...filler] }));
    expectInboxError(
      () =>
        ingest(
          fakeWrap({ id: nextId(), tags: [['p', MY_PUBKEY], ...filler, ['t', 'v']] }),
        ),
      'malformed',
    );

    // Tag item count cap: 16 accepted, 17 rejected.
    const tag16 = ['p', MY_PUBKEY, ...Array.from({ length: 14 }, () => 'x')];
    ingest(fakeWrap({ id: nextId(), tags: [tag16] }));
    const tag17 = ['p', MY_PUBKEY, ...Array.from({ length: 15 }, () => 'x')];
    expectInboxError(() => ingest(fakeWrap({ id: nextId(), tags: [tag17] })), 'malformed');

    // Tag item byte cap: 1024 accepted, 1025 rejected.
    ingest(fakeWrap({ id: nextId(), tags: [['p', MY_PUBKEY], ['t', 'x'.repeat(1_024)]] }));
    expectInboxError(
      () => ingest(fakeWrap({ id: nextId(), tags: [['p', MY_PUBKEY], ['t', 'x'.repeat(1_025)]] })),
      'malformed',
    );
  });

  it('accepts MAX_RECORDS distinct wraps and rejects the next new wrap id', () => {
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    for (let i = 0; i < 100_000; i += 1) {
      inbox.ingest(fakeWrap({ id: i.toString(16).padStart(64, '0') }), 'wss://relay-a.example', i);
    }
    expect(inbox.listRecords()).toHaveLength(100_000);
    // The 100_001st distinct wrap id exceeds capacity.
    expectInboxError(
      () => inbox.ingest(fakeWrap({ id: 'ff'.repeat(32) }), 'wss://relay-a.example', 100_000),
      'capacity_exceeded',
    );
    // Idempotent redelivery of a known id is not capacity-gated.
    const dupe = inbox.ingest(fakeWrap({ id: (0).toString(16).padStart(64, '0') }), 'wss://relay-b.example', 100_001);
    expect(dupe.duplicate).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Forge: drain against malicious wraps                                       */
/* ------------------------------------------------------------------------- */

describe('forge: drain verifies every wrap and contains failures per record', () => {
  it('a batch of one valid and two forged wraps yields only the valid rumor', async () => {
    const valid = await wrapTo(rumorTemplate(SESSION_CREATED + 100, 'valid'), MY_PUBKEY);

    // Garbage: shape-valid wrap with undecryptable content.
    const garbage = fakeWrap({
      id: 'ab'.repeat(32),
      content: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
      created_at: SESSION_CREATED,
    });

    // Hand-crafted rumor-id forgery: the rumor id does not commit to contents.
    const sender = new SeckeyCourtSigner(secret(1));
    const forgedRumor = {
      kind: BAO_COURT_VOTE_COMMIT_KIND,
      created_at: SESSION_CREATED + 100,
      tags: [['dispute', parameters().disputeId]],
      content: JSON.stringify({ marker: 'forged' }),
      pubkey: sender.getPublicKey(),
      id: 'ff'.repeat(32),
    };
    const sealContent = await sender.nip44Encrypt(MY_PUBKEY, JSON.stringify(forgedRumor));
    const seal = await sender.signEvent({
      kind: 13,
      content: sealContent,
      created_at: 1_750_000_000,
      tags: [],
    });
    const forgedWrap = nip59.createWrap(seal, MY_PUBKEY) as NostrEvent;

    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(valid, 'wss://relay-a.example', 1_000);
    inbox.ingest(garbage, 'wss://relay-a.example', 1_001);
    inbox.ingest(forgedWrap, 'wss://relay-b.example', 1_002);

    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.rumor.content ?? '{}').marker).toBe('valid');
    expect(inbox.getRecord(garbage.id)?.drained).toBe(true);
    expect(inbox.getRecord(forgedWrap.id)?.drained).toBe(true);
    await expect(inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
  });

  it('a malicious peer\'s seal signed by A carrying a rumor authored by B is dropped', async () => {
    const signer1 = new SeckeyCourtSigner(secret(1));
    const rumor = {
      kind: BAO_COURT_VOTE_COMMIT_KIND,
      created_at: SESSION_CREATED + 100,
      tags: [['dispute', parameters().disputeId]],
      content: JSON.stringify({ marker: 'impersonated' }),
      pubkey: nostrPubkey(3),
    } as NostrEvent;
    rumor.id = getEventHash(rumor);
    const sealContent = await signer1.nip44Encrypt(MY_PUBKEY, JSON.stringify(rumor));
    const seal = await signer1.signEvent({
      kind: 13,
      content: sealContent,
      created_at: 1_750_000_000,
      tags: [],
    });
    const wrap = nip59.createWrap(seal, MY_PUBKEY) as NostrEvent;

    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    await expect(inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
    expect(inbox.getRecord(wrap.id)?.drained).toBe(true);
  });

  it('equal created_at rumors are drained in rumor-id order regardless of ingest order', async () => {
    const senderPub = nostrPubkey(1);
    const templateA = rumorTemplate(SESSION_CREATED + 100, 'aaa');
    const templateB = rumorTemplate(SESSION_CREATED + 100, 'bbb');
    const idA = getEventHash({ ...templateA, pubkey: senderPub } as NostrEvent);
    const idB = getEventHash({ ...templateB, pubkey: senderPub } as NostrEvent);
    expect(idA).not.toBe(idB);
    const [smallerId, largerTemplate, smallerTemplate] =
      idA < idB ? [idA, templateB, templateA] : [idB, templateA, templateB];

    const wrapLarger = await wrapTo(largerTemplate, MY_PUBKEY);
    const wrapSmaller = await wrapTo(smallerTemplate, MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    // Ingest the lexicographically larger rumor id first.
    inbox.ingest(wrapLarger, 'wss://relay-a.example', 1_000);
    inbox.ingest(wrapSmaller, 'wss://relay-b.example', 1_001);

    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(2);
    expect(messages[0]?.rumor.id).toBe(smallerId);
    expect((messages[0]?.rumor.id ?? '') < (messages[1]?.rumor.id ?? '')).toBe(true);
    expect(messages[0]?.wrapIds).toHaveLength(1);
    expect(messages[0]?.relays).toHaveLength(1);
  });

  it('a signer whose nip44Decrypt throws on every wrap is swallowed per record', async () => {
    const throwingSigner: CourtEventSigner = {
      getPublicKey: () => MY_PUBKEY,
      signEvent: () => Promise.reject(new Error('unused')),
      nip44Encrypt: () => Promise.reject(new Error('unused')),
      nip44Decrypt: () => Promise.reject(new Error('decrypt blew up')),
    };
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(fakeWrap({ id: 'aa'.repeat(32) }), 'wss://relay-a.example', 1_000);
    inbox.ingest(fakeWrap({ id: 'bb'.repeat(32) }), 'wss://relay-b.example', 1_001);

    await expect(inbox.drain(throwingSigner)).resolves.toEqual([]);
    expect(inbox.getRecord('aa'.repeat(32))?.drained).toBe(true);
    expect(inbox.getRecord('bb'.repeat(32))?.drained).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Withhold/drop: relay group publish and read policy                         */
/* ------------------------------------------------------------------------- */

describe('withhold: publish fan-out never rejects and captures every failure', () => {
  const event = signTemplate(
    { kind: 1, created_at: SESSION_CREATED + 1, tags: [], content: 'x' },
    1,
  );

  it('a total partition still resolves the publish report', async () => {
    const report = await publishToGroup(event, [
      new FakeRelay('wss://a.example', { failPublish: true }),
      new FakeRelay('wss://b.example', { failPublish: true }),
    ]);
    expect(report.delivered).toEqual([]);
    expect(report.results).toHaveLength(2);
    for (const result of report.results) {
      expect(result.ok).toBe(false);
      expect(result.error).toContain('down');
    }
  });

  it('non-Error rejection reasons are stringified into per-relay error capture', async () => {
    const stringRejector: CourtRelayConnection = {
      url: 'wss://string.example',
      publish: () => Promise.reject('boom'),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    };
    const objectRejector: CourtRelayConnection = {
      url: 'wss://object.example',
      publish: () => Promise.reject({ code: 500 }),
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    };
    const report = await publishToGroup(event, [stringRejector, objectRejector]);
    expect(report.results[0]).toEqual({ url: 'wss://string.example', ok: false, error: 'boom' });
    expect(report.results[1]?.ok).toBe(false);
    expect(report.results[1]?.error).toBe(String({ code: 500 }));
  });

  it('an empty relay group publishes nothing and resolves', async () => {
    await expect(publishToGroup(event, [])).resolves.toEqual({ results: [], delivered: [] });
  });
});

describe('withhold: read merge survives censoring and dying relays', () => {
  it('an event served by only one of two relays is still delivered', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'censor'), MY_PUBKEY);
    const relays = [
      new FakeRelay('wss://relay-a.example', { events: [] }),
      new FakeRelay('wss://relay-b.example', { events: [wrap] }),
    ];
    const deliveries: { id: string; relayUrl: string }[] = [];
    for await (const delivery of readFromGroup(relays, [{ kinds: [COURT_GIFT_WRAP_KIND] }])) {
      deliveries.push({ id: delivery.event.id, relayUrl: delivery.relayUrl });
    }
    expect(deliveries).toEqual([{ id: wrap.id, relayUrl: 'wss://relay-b.example' }]);
  });

  it('a mid-stream next() rejection ends only the failing relay', async () => {
    const eventA = signTemplate({ kind: 1, created_at: SESSION_CREATED + 1, tags: [], content: 'a' }, 1);
    const eventB1 = signTemplate({ kind: 1, created_at: SESSION_CREATED + 2, tags: [], content: 'b1' }, 1);
    const eventB2 = signTemplate({ kind: 1, created_at: SESSION_CREATED + 3, tags: [], content: 'b2' }, 1);
    const relays = [
      new FakeRelay('wss://relay-a.example', { events: [eventA], failAtIndex: 1 }),
      new FakeRelay('wss://relay-b.example', { events: [eventB1, eventB2] }),
    ];
    const deliveries: { id: string; relayUrl: string }[] = [];
    for await (const delivery of readFromGroup(relays, [{ kinds: [1] }])) {
      deliveries.push({ id: delivery.event.id, relayUrl: delivery.relayUrl });
    }
    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter((d) => d.relayUrl === 'wss://relay-a.example').map((d) => d.id))
      .toEqual([eventA.id]);
    expect(deliveries.filter((d) => d.relayUrl === 'wss://relay-b.example').map((d) => d.id).sort())
      .toEqual([eventB1.id, eventB2.id].sort());
  });

  it('a relay yielding undefined with done:false is treated as end-of-stream for that relay only', async () => {
    const eventB = signTemplate({ kind: 1, created_at: SESSION_CREATED + 1, tags: [], content: 'b' }, 1);
    const relays = [
      new FakeRelay('wss://relay-a.example', { undefinedAtIndex: 0 }),
      new FakeRelay('wss://relay-b.example', { events: [eventB] }),
    ];
    const deliveries: string[] = [];
    for await (const delivery of readFromGroup(relays, [{ kinds: [1] }])) {
      deliveries.push(`${delivery.relayUrl}:${delivery.event.id}`);
    }
    expect(deliveries).toEqual([`wss://relay-b.example:${eventB.id}`]);
  });

  it('an early consumer break closes every underlying subscription', async () => {
    const mk = (content: string): NostrEvent =>
      signTemplate({ kind: 1, created_at: SESSION_CREATED + 1, tags: [], content }, 1);
    const relayA = new FakeRelay('wss://relay-a.example', { events: [mk('a')] });
    const relayB = new FakeRelay('wss://relay-b.example', { events: [mk('b')] });
    const relayC = new FakeRelay('wss://relay-c.example', { events: [mk('c')] });
    let count = 0;
    for await (const _delivery of readFromGroup([relayA, relayB, relayC], [{ kinds: [1] }])) {
      count += 1;
      break;
    }
    expect(count).toBe(1);
    expect(relayA.returnCalls).toBe(1);
    expect(relayB.returnCalls).toBe(1);
    expect(relayC.returnCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Subscription scoping                                                       */
/* ------------------------------------------------------------------------- */

describe('subscription scoping cannot be widened by crafted session input', () => {
  it('clamps the wrap lookback at zero when the session starts inside the 2-day window', () => {
    const session: CourtSessionParameters = {
      ...parameters(),
      createdAt: 1_000,
      deadline: 4_600,
    };
    const [publicFilter, wrapFilter] = buildCourtSubscriptions({ session, myPubkey: MY_PUBKEY });
    expect(wrapFilter?.since).toBe(0);
    expect(publicFilter?.since).toBe(1_000);
    expect(publicFilter?.['#session']).toEqual([hashCourtSessionParameters(session)]);
  });

  it('sorts filter authors even when roster pubkeys are not in sorted order', () => {
    // nostrPubkey(1) > nostrPubkey(5) > nostrPubkey(8) lexicographically, so
    // roster order is not sorted order.
    const session: CourtSessionParameters = {
      ...parameters(),
      participants: [
        {
          idx: 1,
          nostrPubkey: nostrPubkey(1),
          hostPubkey: hostPubkey(11),
          bondRef: 'signet:bond:adv-one',
          role: 'juror-coordinator',
        },
        {
          idx: 2,
          nostrPubkey: nostrPubkey(5),
          hostPubkey: hostPubkey(12),
          bondRef: 'signet:bond:adv-two',
          role: 'juror',
        },
        {
          idx: 3,
          nostrPubkey: nostrPubkey(8),
          hostPubkey: hostPubkey(13),
          bondRef: 'signet:bond:adv-three',
          role: 'juror',
        },
      ],
    };
    const rosterOrder = session.participants.map((p) => p.nostrPubkey);
    expect(rosterOrder).not.toEqual([...rosterOrder].sort());
    const [publicFilter] = buildCourtSubscriptions({ session, myPubkey: MY_PUBKEY });
    expect(publicFilter?.authors).toEqual([...rosterOrder].sort());
  });

  it('rejects an unsorted roster outright instead of silently canonicalizing it', () => {
    // Session validation requires sequential, ordered participant indices;
    // a reordered roster is invalid input, not a normalization opportunity.
    const reversed: CourtSessionParameters = {
      ...parameters(),
      participants: [...parameters().participants].reverse(),
    };
    expect(() => buildCourtSubscriptions({ session: reversed, myPubkey: MY_PUBKEY })).toThrow(
      /sequential and ordered/,
    );
  });

  it('keeps the public filter free of #p and the wrap filter free of authors/#session', () => {
    const filters = buildCourtSubscriptions({ session: parameters(), myPubkey: MY_PUBKEY });
    expect(filters).toHaveLength(2);
    const [publicFilter, wrapFilter] = filters;
    expect(publicFilter && '#p' in publicFilter).toBe(false);
    for (const kind of COURT_INBOX_PUBLIC_KINDS) {
      expect(publicFilter?.kinds).toContain(kind);
    }
    expect(wrapFilter && 'authors' in wrapFilter).toBe(false);
    expect(wrapFilter && '#session' in wrapFilter).toBe(false);
    expect(wrapFilter?.kinds).toEqual([COURT_GIFT_WRAP_KIND]);
  });
});

/* ------------------------------------------------------------------------- */
/* Store tamper: inbox snapshots                                              */
/* ------------------------------------------------------------------------- */

describe('store tamper: inbox snapshot restore re-validates everything', () => {
  async function populatedInbox(): Promise<{ inbox: CourtInbox; wrap: NostrEvent }> {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 100, 'persisted'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    inbox.ingest(wrap, 'wss://relay-b.example', 1_050);
    return { inbox, wrap };
  }

  it('rejects duplicate provenance URLs and oversized relays arrays', async () => {
    const { inbox } = await populatedInbox();
    const good = inbox.snapshot();

    const duplicated = jsonRoundTrip(good) as MutableInboxSnapshot;
    (duplicated.records[0] as { relays: string[] }).relays = [
      'wss://relay-a.example',
      'wss://relay-a.example',
    ];
    expectInboxError(() => CourtInbox.fromSnapshot(jsonRoundTrip(duplicated), MY_PUBKEY), 'corrupt_snapshot');

    const oversized = jsonRoundTrip(good) as MutableInboxSnapshot;
    (oversized.records[0] as { relays: string[] }).relays = Array.from(
      { length: 65 },
      (_, i) => `wss://relay-${i}.example`,
    );
    expectInboxError(() => CourtInbox.fromSnapshot(jsonRoundTrip(oversized), MY_PUBKEY), 'corrupt_snapshot');
  });

  it('rejects tampered record fields', async () => {
    const { inbox } = await populatedInbox();
    const good = inbox.snapshot();
    const mutations: ((snapshot: MutableInboxSnapshot) => void)[] = [
      (s) => {
        (s.records[0] as { wrap: Record<string, unknown> }).wrap.kind = 13;
      },
      (s) => {
        (s.records[0] as { wrap: Record<string, unknown> }).wrap.sig = 'zz'.repeat(64);
      },
      (s) => {
        (s.records[0] as { drained: unknown }).drained = 'yes';
      },
      (s) => {
        (s.records[0] as { firstSeen: number }).firstSeen = -1;
      },
      (s) => {
        (s.records[0] as { firstSeen: number }).firstSeen = 1.5;
      },
    ];
    for (const mutate of mutations) {
      const tampered = jsonRoundTrip(good) as MutableInboxSnapshot;
      mutate(tampered);
      expectInboxError(
        () => CourtInbox.fromSnapshot(jsonRoundTrip(tampered), MY_PUBKEY),
        'corrupt_snapshot',
      );
    }
  });

  it('rejects a snapshot with more than MAX_RECORDS records', () => {
    const records = [];
    for (let i = 0; i < 100_001; i += 1) {
      const id = i.toString(16).padStart(64, '0');
      records.push({
        wrapId: id,
        wrap: {
          kind: COURT_GIFT_WRAP_KIND,
          id,
          pubkey: 'cd'.repeat(32),
          sig: 'ef'.repeat(64),
          created_at: 0,
          content: '',
          tags: [['p', MY_PUBKEY]],
        },
        relays: ['wss://a.example'],
        firstSeen: 0,
        lastSeen: 0,
        drained: false,
      });
    }
    const snapshot = {
      version: COURT_INBOX_SNAPSHOT_VERSION,
      myPubkey: MY_PUBKEY,
      records,
    };
    expectInboxError(
      () => CourtInbox.fromSnapshot(jsonRoundTrip(snapshot), MY_PUBKEY),
      'corrupt_snapshot',
    );
  });

  it('a malformed expectedMyPubkey argument throws malformed, not corrupt_snapshot', async () => {
    const { inbox } = await populatedInbox();
    const snapshot = jsonRoundTrip(inbox.snapshot());
    for (const bad of ['bad', 'zz'.repeat(32)]) {
      try {
        CourtInbox.fromSnapshot(snapshot, bad);
        throw new Error('expected CourtInboxError');
      } catch (error) {
        expect(error).toBeInstanceOf(CourtInboxError);
        expect((error as CourtInboxError).code).toBe('malformed');
        expect((error as CourtInboxError).message).toContain('expectedMyPubkey');
      }
    }
  });

  it('drained state survives a restart and a replayed wrap is never re-decrypted', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 100, 'restart'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    const first = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(first).toHaveLength(1);

    const restored = CourtInbox.fromSnapshot(jsonRoundTrip(inbox.snapshot()), MY_PUBKEY);
    await expect(restored.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);

    // Relay replays the same wrap after the restart: idempotent, still drained.
    const reingest = restored.ingest(wrap, 'wss://relay-b.example', 2_000);
    expect(reingest.duplicate).toBe(true);
    expect(restored.getRecord(wrap.id)?.drained).toBe(true);
    await expect(restored.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
  });

  it('a restored wrap is re-verified at drain: content tampering drops it, sig tampering is not load-bearing', async () => {
    const { inbox, wrap } = await populatedInbox();
    const good = inbox.snapshot();

    // The wrap-layer sig is the ephemeral NIP-59 outer signature, which the
    // unwrap path deliberately never verifies; restore is structural, so the
    // tampered sig restores fine and the rumor still verifies at drain.
    const sigTampered = jsonRoundTrip(good) as MutableInboxSnapshot;
    (sigTampered.records[0] as { wrap: Record<string, unknown> }).wrap.sig = '00'.repeat(64);
    const restoredSig = CourtInbox.fromSnapshot(jsonRoundTrip(sigTampered), MY_PUBKEY);
    const messages = await restoredSig.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);

    // The load-bearing layers (address tag, encrypted content, seal, rumor
    // commitment) are verified at drain: a tampered content drops the record.
    const contentTampered = jsonRoundTrip(good) as MutableInboxSnapshot;
    (contentTampered.records[0] as { wrap: Record<string, unknown> }).wrap.content = '00'.repeat(64);
    const restoredContent = CourtInbox.fromSnapshot(jsonRoundTrip(contentTampered), MY_PUBKEY);
    await expect(restoredContent.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
    expect(restoredContent.getRecord(wrap.id)?.drained).toBe(true);
  });

  it('restore deep-copies: mutating the snapshot input cannot corrupt the inbox', async () => {
    const { inbox } = await populatedInbox();
    const snapshot = jsonRoundTrip(inbox.snapshot()) as MutableInboxSnapshot;
    const restored = CourtInbox.fromSnapshot(snapshot, MY_PUBKEY);

    const record = snapshot.records[0] as {
      wrap: { tags: string[][] };
      relays: string[];
    };
    record.wrap.tags.push(['x', 'y']);
    record.relays.length = 0;

    const reread = restored.listRecords();
    expect(reread).toHaveLength(1);
    expect(reread[0]?.wrap.tags.some((tag) => tag[0] === 'x')).toBe(false);
    expect(reread[0]?.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);
  });
});

/* ------------------------------------------------------------------------- */
/* Withhold/drop: outbox blackout, deadline, and clock games                  */
/* ------------------------------------------------------------------------- */

describe('withhold: outbox retry schedule under a total relay blackout', () => {
  it('drives the full backoff schedule then buries the message at the deadline', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const key = entry.messageKey;

    // The relay drops every gift wrap and every ack: the host retries exactly
    // on the due schedule until the deadline.
    const sentAt: number[] = [];
    let now = 0;
    while (now < PARAMS.deadlineSeconds) {
      const due = outbox.dueEntries(now);
      if (due.length === 0) break;
      expect(due.map((e) => e.messageKey)).toEqual([key]);
      const sent = outbox.markSent(key, now);
      sentAt.push(now);
      now = sent.nextRetryAt;
    }
    expect(sentAt.slice(0, 6)).toEqual([0, 10, 30, 70, 150, 250]);
    expect(sentAt[sentAt.length - 1]).toBe(9_950);
    expect(outbox.getEntry(key)?.attempts).toBe(sentAt.length);

    expect(outbox.dueEntries(PARAMS.deadlineSeconds)).toEqual([]);
    expect(outbox.expireOverdue(PARAMS.deadlineSeconds)).toEqual([key]);
    expect(outbox.getEntry(key)?.status).toBe('dead');

    // A genuinely valid ack arriving via a side channel after death is dead.
    const ack = signAck(RECIPIENT_SECKEY, key, WRAP_ID_A);
    expectOutboxError(() => outbox.recordAck(ack, PARAMS.deadlineSeconds), 'message_dead');
    expectOutboxError(() => outbox.markSent(key, PARAMS.deadlineSeconds), 'message_dead');
    // Re-enqueue of the same logical message returns the dead entry unchanged.
    expect(outbox.enqueue(makeInput(), PARAMS.deadlineSeconds + 1).status).toBe('dead');
  });

  it('accepts a withheld ack at deadline-1 and rejects it at exactly the deadline', () => {
    const first = makeOutbox();
    const entry = first.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    const result = first.recordAck(ack, PARAMS.deadlineSeconds - 1);
    expect(result.status).toBe('acked');
    expect(result.ackedAt).toBe(PARAMS.deadlineSeconds - 1);

    const second = makeOutbox();
    const other = second.enqueue(makeInput(), 0);
    const lateAck = signAck(RECIPIENT_SECKEY, other.messageKey, WRAP_ID_A);
    expectOutboxError(
      () => second.recordAck(lateAck, PARAMS.deadlineSeconds),
      'message_dead',
    );
  });

  it('a rewound host clock during retries neither extends the deadline nor resurrects the entry', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const key = entry.messageKey;

    outbox.markSent(key, 100);
    // A delayed retry fires with a stale timestamp: the module permits the
    // send, backoff stays monotonic in attempts, and the deadline is anchored
    // to enqueuedAt — immune to the rewind.
    const regressed = outbox.markSent(key, 50);
    expect(regressed.attempts).toBe(2);
    expect(regressed.nextRetryAt).toBe(70);
    expect(regressed.deadline).toBe(PARAMS.deadlineSeconds);

    expect(outbox.dueEntries(PARAMS.deadlineSeconds)).toEqual([]);
    expect(outbox.expireOverdue(PARAMS.deadlineSeconds)).toEqual([key]);
    const ack = signAck(RECIPIENT_SECKEY, key, WRAP_ID_A);
    expectOutboxError(() => outbox.recordAck(ack, PARAMS.deadlineSeconds + 1), 'message_dead');
  });
});

/* ------------------------------------------------------------------------- */
/* Replay/forge: outbox acks                                                  */
/* ------------------------------------------------------------------------- */

describe('replay: byte-identical ack re-service is idempotent forever', () => {
  it('the same ack event replayed before and after the deadline preserves the original ack', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    // Byte-identical copies as a relay would re-serve them over JSON.
    const wire = (): NostrEvent => jsonRoundTrip(ack) as NostrEvent;

    const first = outbox.recordAck(wire(), 5);
    expect(first.status).toBe('acked');

    for (const now of [6, PARAMS.deadlineSeconds + 1_000]) {
      const replayed = outbox.recordAck(wire(), now);
      expect(replayed.status).toBe('acked');
      expect(replayed.ackEventId).toBe(ack.id);
      expect(replayed.ackedAt).toBe(5);
    }
  });
});

describe('forge: tampered ack events never verify, even with a cached verdict', () => {
  it('object-spread tamper of the ack id fails signature verification', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    // Spread preserves finalizeEvent's cached-verdict symbol; the verifier
    // reconstructs a plain candidate, so the forged id still fails.
    const forged = { ...ack, id: 'ff'.repeat(32) };
    expectOutboxError(() => outbox.recordAck(forged, 1), 'ack_invalid_signature');
    expect(outbox.getEntry(entry.messageKey)?.status).toBe('queued');
  });

  it('object-spread tamper of the pubkey while keeping the original sig fails verification', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    const forged = { ...ack, pubkey: OTHER_PUBKEY };
    expectOutboxError(() => outbox.recordAck(forged, 1), 'ack_invalid_signature');
    expect(outbox.getEntry(entry.messageKey)?.status).toBe('queued');
  });

  it('object-spread splice of the m tag onto a different live entry fails verification', () => {
    const outbox = makeOutbox();
    const entryA = outbox.enqueue(makeInput(), 0);
    const entryB = outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 0);
    const ackForA = signAck(RECIPIENT_SECKEY, entryA.messageKey, WRAP_ID_A);
    // The tampered 'm' tag names a REAL entry in the same outbox — the
    // signature gate fires before any message routing on the tag.
    const forged = { ...ackForA, tags: [['m', entryB.messageKey], ['e', WRAP_ID_A]] };
    expectOutboxError(() => outbox.recordAck(forged, 1), 'ack_invalid_signature');
    expect(outbox.getEntry(entryA.messageKey)?.status).toBe('queued');
    expect(outbox.getEntry(entryB.messageKey)?.status).toBe('queued');
  });

  it('a legitimate roster peer cannot ack a message addressed to a different peer', () => {
    const outbox = makeOutbox();
    outbox.enqueue(makeInput(), 0); // entry A: recipient RECIPIENT_PUBKEY
    const entryB = outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 0);
    // RECIPIENT_SECKEY is a legitimate peer — for entry A — but entry B is
    // bound to OTHER_PUBKEY. Roster membership confers no cross-message
    // authority.
    const crossAck = signAck(RECIPIENT_SECKEY, entryB.messageKey, WRAP_ID_A);
    expectOutboxError(() => outbox.recordAck(crossAck, 1), 'ack_author_mismatch');
  });

  it('the kind gate fires before signature verification on genuinely signed wrong-kind events', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    for (const kind of [1, COURT_DELIVERY_ACK_KIND + 1]) {
      const wrongKind = finalizeEvent(
        {
          kind,
          created_at: 500,
          tags: [
            ['m', entry.messageKey],
            ['e', WRAP_ID_A],
          ],
          content: '',
        },
        RECIPIENT_SECKEY,
      );
      expectOutboxError(() => outbox.recordAck(wrongKind, 1), 'malformed');
    }
  });

  it('an ack whose m tag carries the wrap id instead of the message key is an unknown message', () => {
    const outbox = makeOutbox();
    outbox.enqueue(makeInput(), 0);
    // WRAP_ID_A is 64-hex, so structural gates pass — but no entry has that
    // logical key; the wrap id namespace is never confused with message keys.
    const ack = signAck(RECIPIENT_SECKEY, WRAP_ID_A, WRAP_ID_A);
    expectOutboxError(() => outbox.recordAck(ack, 1), 'unknown_message');
  });

  it('the first m tag wins and a malformed first tag fails closed', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = finalizeEvent(
      {
        kind: COURT_DELIVERY_ACK_KIND,
        created_at: 500,
        tags: [
          ['m', 'not-hex'],
          ['m', entry.messageKey],
          ['e', WRAP_ID_A],
        ],
        content: '',
      },
      RECIPIENT_SECKEY,
    );
    expectOutboxError(() => outbox.recordAck(ack, 1), 'malformed');
  });
});

describe('reorder: outbox tolerates relay reordering without losing gates', () => {
  it('an ack arriving before any send attempt transitions queued -> acked and still gates sends', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    const result = outbox.recordAck(ack, 1);
    expect(result.status).toBe('acked');
    expect(result.ackedAt).toBe(1);
    expectOutboxError(() => outbox.markSent(entry.messageKey, 2), 'invalid_transition');
  });
});

/* ------------------------------------------------------------------------- */
/* Store tamper: outbox snapshots                                             */
/* ------------------------------------------------------------------------- */

describe('store tamper: outbox snapshot restore re-verifies acked state', () => {
  it('a symbol-carrying forged ack event injected into an acked entry fails re-verification', () => {
    const { outbox, ack } = ackedOutbox();
    const snapshot = jsonRoundTrip(outbox.snapshot()) as MutableOutboxSnapshot;
    // The host hands a LIVE object to the store: the spread preserves
    // finalizeEvent's cached-verdict symbol, bypassing the JSON round-trip
    // for this one field. inspectAckEvent reconstructs a plain candidate, so
    // the forgery still fails.
    snapshot.entries[0]!.ackEvent = { ...ack, content: 'forged' };
    expectOutboxError(() => CourtOutbox.fromSnapshot(snapshot), 'corrupt_snapshot');
  });

  it('an ackEventId that disagrees with the stored ack event is rejected', () => {
    const { outbox } = ackedOutbox();
    const snapshot = jsonRoundTrip(outbox.snapshot()) as MutableOutboxSnapshot;
    snapshot.entries[0]!.ackEventId = 'ff'.repeat(32);
    expectOutboxError(() => CourtOutbox.fromSnapshot(snapshot), 'corrupt_snapshot');
  });

  it('a stored ack validly signed by a non-recipient is rejected', () => {
    const { outbox, key } = ackedOutbox();
    const snapshot = jsonRoundTrip(outbox.snapshot()) as MutableOutboxSnapshot;
    // Genuinely signed, correctly bound to this message — wrong author.
    const wrongAuthor = signAck(OTHER_SECKEY, key, WRAP_ID_A);
    snapshot.entries[0]!.ackEvent = jsonRoundTrip(wrongAuthor);
    snapshot.entries[0]!.ackEventId = wrongAuthor.id;
    expectOutboxError(() => CourtOutbox.fromSnapshot(snapshot), 'corrupt_snapshot');
  });

  it('ack fields smuggled onto a non-acked entry are rejected', () => {
    const { outbox, key } = sentOutbox();
    const good = (): MutableOutboxSnapshot => jsonRoundTrip(outbox.snapshot()) as MutableOutboxSnapshot;

    const withId = good();
    withId.entries[0]!.ackEventId = 'ff'.repeat(32);
    expectOutboxError(() => CourtOutbox.fromSnapshot(withId), 'corrupt_snapshot');

    const full = good();
    const ack = signAck(RECIPIENT_SECKEY, key, WRAP_ID_A);
    full.entries[0]!.ackedAt = 5;
    full.entries[0]!.ackEventId = ack.id;
    full.entries[0]!.ackEvent = jsonRoundTrip(ack);
    expectOutboxError(() => CourtOutbox.fromSnapshot(full), 'corrupt_snapshot');
  });

  it('lifecycle field incoherence is rejected in every direction', () => {
    const { outbox } = sentOutbox();
    const good = (): MutableOutboxSnapshot => jsonRoundTrip(outbox.snapshot()) as MutableOutboxSnapshot;

    // deadline not later than enqueuedAt (also no longer matches the policy).
    const deadlineNotLater = good();
    deadlineNotLater.entries[0]!.deadline = deadlineNotLater.entries[0]!.enqueuedAt;
    expectOutboxError(() => CourtOutbox.fromSnapshot(deadlineNotLater), 'corrupt_snapshot');

    // nextRetryAt before enqueuedAt.
    const earlyRetry = good();
    earlyRetry.entries[0]!.nextRetryAt = (earlyRetry.entries[0]!.enqueuedAt as number) - 1;
    expectOutboxError(() => CourtOutbox.fromSnapshot(earlyRetry), 'corrupt_snapshot');

    // lastSentAt before enqueuedAt.
    const earlySent = good();
    earlySent.entries[0]!.lastSentAt = (earlySent.entries[0]!.enqueuedAt as number) - 1;
    expectOutboxError(() => CourtOutbox.fromSnapshot(earlySent), 'corrupt_snapshot');

    // status 'sent' with zero attempts.
    const sentNoAttempts = good();
    sentNoAttempts.entries[0]!.attempts = 0;
    expectOutboxError(() => CourtOutbox.fromSnapshot(sentNoAttempts), 'corrupt_snapshot');

    // negative attempts.
    const negativeAttempts = good();
    negativeAttempts.entries[0]!.attempts = -1;
    expectOutboxError(() => CourtOutbox.fromSnapshot(negativeAttempts), 'corrupt_snapshot');
  });

  it('message-key recomputation catches tampered logical fields', () => {
    const { outbox } = sentOutbox();
    const good = (): MutableOutboxSnapshot => jsonRoundTrip(outbox.snapshot()) as MutableOutboxSnapshot;

    const tamperedSession = good();
    tamperedSession.entries[0]!.sessionHash = OTHER_SESSION;
    expectOutboxError(() => CourtOutbox.fromSnapshot(tamperedSession), 'corrupt_snapshot');

    const tamperedKind = good();
    tamperedKind.entries[0]!.innerKind = 39_005;
    expectOutboxError(() => CourtOutbox.fromSnapshot(tamperedKind), 'corrupt_snapshot');
  });

  it('a restored acked entry stays idempotent under ack replay and re-enqueue', () => {
    const { outbox, key, ack } = ackedOutbox();
    const restored = CourtOutbox.fromSnapshot(jsonRoundTrip(outbox.snapshot()));
    expect(restored.getEntry(key)?.status).toBe('acked');
    expect(restored.getEntry(key)?.ackEventId).toBe(ack.id);

    // Relay replays the same ack long after the deadline: idempotent.
    const replayed = restored.recordAck(
      jsonRoundTrip(ack) as NostrEvent,
      PARAMS.deadlineSeconds + 1_000,
    );
    expect(replayed.status).toBe('acked');
    expect(replayed.ackEventId).toBe(ack.id);
    expect(replayed.ackedAt).toBe(5);

    // Re-enqueue of the same logical message (new wrap id) returns the acked
    // entry; no duplicate is created.
    const reenqueued = restored.enqueue(makeInput({ wrap: wrapTemplate(WRAP_ID_B) }), PARAMS.deadlineSeconds + 2_000);
    expect(reenqueued.status).toBe('acked');
    expect(restored.listEntries()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Forge/hygiene: outbox mutation isolation and input bounds                  */
/* ------------------------------------------------------------------------- */

describe('forge: outbox mutation isolation and input bounds', () => {
  it('caller mutation of the enqueued input wrap cannot corrupt the entry', () => {
    const outbox = makeOutbox();
    const input = makeInput();
    const entry = outbox.enqueue(input, 0);

    (input.wrap.tags[0] as string[])[1] = 'ff'.repeat(32);
    (input.wrap as { content: string }).content = 'tampered';
    (input.wrap as { id: string }).id = WRAP_ID_B;

    const stored = outbox.getEntry(entry.messageKey);
    expect(stored?.wrap.tags[0]?.[1]).toBe(RECIPIENT_PUBKEY);
    expect(stored?.wrap.content).toBe(`ciphertext-for-${WRAP_ID_A.slice(0, 4)}`);
    expect(stored?.wrap.id).toBe(WRAP_ID_A);
  });

  it('caller mutation of the ack event and of returned entries cannot corrupt the entry', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const sent = outbox.markSent(entry.messageKey, 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    const ackedEntry = outbox.recordAck(ack, 5);

    // Mutate the caller's ack object after acceptance.
    (ack as { content: string }).content = 'x';
    (ack.tags[0] as string[])[1] = 'ff'.repeat(32);
    // Mutate the entries handed back by markSent/recordAck.
    (sent as { status: string }).status = 'dead';
    (ackedEntry as { status: string }).status = 'dead';
    ((ackedEntry.ackEvent as NostrEvent).tags[0] as string[])[1] = 'ff'.repeat(32);

    const stored = outbox.getEntry(entry.messageKey);
    expect(stored?.status).toBe('acked');
    expect(stored?.ackEvent?.content).toBe('');
    expect(stored?.ackEvent?.tags[0]?.[1]).toBe(entry.messageKey);
  });

  it('non-hex or uppercase message keys and invalid now values are rejected on every public method', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);

    expectOutboxError(() => outbox.getEntry('ZZ'), 'malformed');
    expectOutboxError(() => outbox.markSent(entry.messageKey.toUpperCase(), 0), 'malformed');
    expectOutboxError(() => outbox.recordAck(ack, NaN), 'malformed');
    expectOutboxError(() => outbox.dueEntries(-1), 'malformed');
    expectOutboxError(() => outbox.expireOverdue(1.5), 'malformed');
  });

  it('oversized payloads and oversized wrap contents are rejected', () => {
    const outbox = makeOutbox();
    expectOutboxError(
      () => outbox.enqueue(makeInput({ payload: 'x'.repeat(128 * 1024 + 1) }), 0),
      'malformed',
    );
    expectOutboxError(
      () =>
        outbox.enqueue(
          makeInput({ wrap: wrapTemplate(WRAP_ID_A, { content: 'x'.repeat(256 * 1024 + 1) }) }),
          0,
        ),
      'malformed',
    );
  });

  it('expireOverdue buries multiple overdue entries in deterministic sorted-key order', () => {
    const payloadOne = JSON.stringify({ kind: 39004, n: 1 });
    const payloadTwo = JSON.stringify({ kind: 39004, n: 2 });
    const keyOne = hashCourtOutboxMessage({
      sessionHash: SESSION,
      innerKind: 39004,
      recipientPubkey: RECIPIENT_PUBKEY,
      payload: payloadOne,
    });
    const keyTwo = hashCourtOutboxMessage({
      sessionHash: SESSION,
      innerKind: 39004,
      recipientPubkey: RECIPIENT_PUBKEY,
      payload: payloadTwo,
    });
    // Insert in anti-sorted order to prove the return value is sorted.
    const [firstPayload, secondPayload] = keyOne > keyTwo ? [payloadOne, payloadTwo] : [payloadTwo, payloadOne];
    const outbox = makeOutbox();
    outbox.enqueue(makeInput({ payload: firstPayload }), 0);
    outbox.enqueue(makeInput({ payload: secondPayload }), 0);
    const live = outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 9_990);

    const buried = outbox.expireOverdue(PARAMS.deadlineSeconds);
    expect(buried).toEqual([keyOne, keyTwo].sort());
    expect(outbox.getEntry(keyOne)?.status).toBe('dead');
    expect(outbox.getEntry(keyTwo)?.status).toBe('dead');
    expect(outbox.getEntry(live.messageKey)?.status).toBe('queued');
  });
});

/* ------------------------------------------------------------------------- */
/* Forge: signer unwrap gates                                                 */
/* ------------------------------------------------------------------------- */

describe('forge: unwrap gates fire before any decrypt attempt', () => {
  it('decrypt is never attempted when the wrap p-tag does not match the signer pubkey', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, CAROL_PUB);
    const bobSpy = new SpySigner(BOB_SECKEY);
    await expect(unwrapProtocolEventWithSigner(wrap, bobSpy)).resolves.toBeNull();
    expect(bobSpy.decryptSpy.mock.calls).toHaveLength(0);
  });

  it('a wrap with no p-tag at all is rejected pre-decrypt', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const bobSpy = new SpySigner(BOB_SECKEY);
    await expect(unwrapProtocolEventWithSigner({ ...wrap, tags: [] }, bobSpy)).resolves.toBeNull();
    expect(bobSpy.decryptSpy.mock.calls).toHaveLength(0);
  });

  it('wrong-kind wraps are rejected before any decrypt', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    for (const kind of [4, 13, 14, 1, 0]) {
      const bobSpy = new SpySigner(BOB_SECKEY);
      await expect(unwrapProtocolEventWithSigner({ ...wrap, kind }, bobSpy)).resolves.toBeNull();
      expect(bobSpy.decryptSpy.mock.calls).toHaveLength(0);
    }
  });

  it('structurally malformed wraps return null instead of throwing', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const malformed: unknown[] = [
      null,
      'giftwrap',
      {},
      { ...wrap, tags: 'p' },
      { ...wrap, tags: [42] },
      { ...wrap, tags: [['p']] },
    ];
    for (const input of malformed) {
      await expect(
        unwrapProtocolEventWithSigner(input as NostrEvent, bob),
      ).resolves.toBeNull();
    }
  });
});

describe('forge: tampered inner layers are caught by commitment checks', () => {
  async function validRumor(): Promise<NostrEvent> {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const rumor = await unwrapProtocolEventWithSigner(wrap, bob);
    expect(rumor).not.toBeNull();
    return rumor as NostrEvent;
  }

  it('rumor tags tampered after signing are caught by id recomputation', async () => {
    const rumor = await validRumor();
    // Keep the original id; tamper the field the disputeId filter trusts.
    const tampered = { ...rumor, tags: [['dispute', 'dispute-999']] };
    const wrap = await resealAndRewrap(tampered);
    await expect(unwrapProtocolEventWithSigner(wrap, bob)).resolves.toBeNull();
  });

  it('rumor created_at or kind tampered after signing is caught by id recomputation', async () => {
    const rumor = await validRumor();
    const tamperedTime = await resealAndRewrap({ ...rumor, created_at: rumor.created_at + 1 });
    await expect(unwrapProtocolEventWithSigner(tamperedTime, bob)).resolves.toBeNull();
    const tamperedKind = await resealAndRewrap({ ...rumor, kind: 32_999 });
    await expect(unwrapProtocolEventWithSigner(tamperedKind, bob)).resolves.toBeNull();
  });

  it('a structurally invalid rumor returns null without throwing', async () => {
    const rumor = await validRumor();
    // getEventHash cannot serialize non-array tags and throws inside the
    // catch-all; a claimed id string routes through that recomputation.
    const withBogusId = await resealAndRewrap({ ...rumor, tags: 'not-an-array', id: 'ff'.repeat(32) });
    await expect(unwrapProtocolEventWithSigner(withBogusId, bob)).resolves.toBeNull();
    const withoutId = await resealAndRewrap({ ...rumor, tags: 'not-an-array', id: undefined });
    await expect(unwrapProtocolEventWithSigner(withoutId, bob)).resolves.toBeNull();
  });

  it('a seal author differing from the rumor author is dropped even with a consistent rumor id', async () => {
    // Alice (the legitimate seal author) seals a rumor claiming Carol's
    // pubkey; the id is self-consistent over the Carol-claiming rumor.
    const rumorClaimsCarol = { ...TEMPLATE, pubkey: CAROL_PUB } as NostrEvent;
    rumorClaimsCarol.id = getEventHash(rumorClaimsCarol);
    const wrap = await resealAndRewrap(rumorClaimsCarol);
    await expect(unwrapProtocolEventWithSigner(wrap, bob)).resolves.toBeNull();
  });

  it('seal fields tampered after signing — kind flip and content swap — are both rejected', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const sealJson = await bob.nip44Decrypt(wrap.pubkey, wrap.content);
    const seal = JSON.parse(sealJson) as NostrEvent;

    // Kind flip: the seal kind gate fires even though the signature is valid
    // for kind 13.
    const kindFlipped = nip59.createWrap({ ...seal, kind: 14 } as NostrEvent, BOB_PUB) as NostrEvent;
    await expect(unwrapProtocolEventWithSigner(kindFlipped, bob)).resolves.toBeNull();

    // Content swap: ciphertext for a different valid rumor no longer matches
    // the seal's signed id.
    const otherRumor = { ...TEMPLATE, content: '{"share":"cafe"}', pubkey: ALICE_PUB } as NostrEvent;
    otherRumor.id = getEventHash(otherRumor);
    const otherCiphertext = await alice.nip44Encrypt(BOB_PUB, JSON.stringify(otherRumor));
    const contentSwapped = nip59.createWrap({ ...seal, content: otherCiphertext } as NostrEvent, BOB_PUB) as NostrEvent;
    await expect(unwrapProtocolEventWithSigner(contentSwapped, bob)).resolves.toBeNull();
  });

  it('a signer whose nip44Decrypt resolves non-JSON garbage yields null, not an exception', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const garbageDecrypt: CourtEventSigner = {
      getPublicKey: () => BOB_PUB,
      signEvent: (template) => bob.signEvent(template),
      nip44Encrypt: (peer, plaintext) => bob.nip44Encrypt(peer, plaintext),
      nip44Decrypt: () => Promise.resolve('not-json{{{'),
    };
    await expect(unwrapProtocolEventWithSigner(wrap, garbageDecrypt)).resolves.toBeNull();
  });
});

describe('replay/reorder: batch unwrap dedupes by rumor id across distinct wraps', () => {
  it('two distinct valid wraps sealing the same rumor deduplicate to one rumor', async () => {
    const wrap1 = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const wrap2 = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    expect(wrap1.id).not.toBe(wrap2.id);
    const rumors = await unwrapProtocolEventsWithSigner([wrap1, wrap2], bob);
    expect(rumors).toHaveLength(1);
    expect(rumors[0]?.content).toBe(TEMPLATE.content);
  });

  it('a reordered batch with a re-sent copy yields distinct rumors in first-seen order', async () => {
    const templateB = { ...TEMPLATE, content: '{"share":"cafe"}' };
    const wrapA = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const wrapB = await wrapProtocolEventWithSigner(templateB, alice, BOB_PUB);
    const rumors = await unwrapProtocolEventsWithSigner([wrapB, wrapA, wrapB], bob);
    expect(rumors).toHaveLength(2);
    expect(rumors[0]?.content).toBe(templateB.content);
    expect(rumors[1]?.content).toBe(TEMPLATE.content);
  });

  it('the disputeId filter excludes rumors with no dispute tag at all', async () => {
    const wrap = await wrapProtocolEventWithSigner({ ...TEMPLATE, tags: [] }, alice, BOB_PUB);
    await expect(
      unwrapProtocolEventsWithSigner([wrap], bob, { disputeId: 'dispute-1' }),
    ).resolves.toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Forge: malicious signer at wrap time                                       */
/* ------------------------------------------------------------------------- */

describe('forge: a malicious signer cannot make wrap emit an invalid seal', () => {
  function evilSigner(signEvent: CourtEventSigner['signEvent']): CourtEventSigner {
    return {
      getPublicKey: () => ALICE_PUB,
      signEvent,
      nip44Encrypt: (peer, plaintext) => alice.nip44Encrypt(peer, plaintext),
      nip44Decrypt: (peer, ciphertext) => alice.nip44Decrypt(peer, ciphertext),
    };
  }

  it('a validly signed seal of the wrong kind is rejected', async () => {
    const evil = evilSigner((template) => alice.signEvent({ ...template, kind: 14 }));
    await expect(wrapProtocolEventWithSigner(TEMPLATE, evil, BOB_PUB)).rejects.toThrow(
      /invalid NIP-59 seal/,
    );
  });

  it('a seal signed under a different key than advertised is rejected', async () => {
    const evil = evilSigner((template) => carol.signEvent(template));
    await expect(wrapProtocolEventWithSigner(TEMPLATE, evil, BOB_PUB)).rejects.toThrow(
      /invalid NIP-59 seal/,
    );
  });

  it('a seal with an invalid signature and no cache stamp is rejected via verifyEvent', async () => {
    const evil = evilSigner(async (template) => {
      const signed = await alice.signEvent(template);
      // Fresh plain object: correct kind and pubkey, garbage signature, and
      // no verifiedSymbol stamp (explicit field copy, not a spread).
      return {
        id: signed.id,
        pubkey: signed.pubkey,
        sig: '00'.repeat(64),
        kind: signed.kind,
        created_at: signed.created_at,
        content: signed.content,
        tags: signed.tags,
      } as NostrEvent;
    });
    await expect(wrapProtocolEventWithSigner(TEMPLATE, evil, BOB_PUB)).rejects.toThrow(
      /invalid NIP-59 seal/,
    );
  });

  it('a finalizeEvent-stamped seal tampered after stamping is rejected at the wrap boundary', async () => {
    const aliceBytes = hexToBytes(ALICE_SECKEY);
    const evil = evilSigner((template) => {
      const sealed = finalizeEvent(template, aliceBytes);
      // finalizeEvent stamps verifiedSymbol; the tampered spread keeps it, so
      // a naive verifyEvent would short-circuit on the cached verdict.
      sealed.sig = '00'.repeat(64);
      return Promise.resolve({ ...sealed } as NostrEvent);
    });

    // The wrap path verifies a reconstructed plain-object copy of the
    // signer-returned seal, so no cached verdict survives and the tampered
    // signature fails verification before any wrap is emitted.
    await expect(wrapProtocolEventWithSigner(TEMPLATE, evil, BOB_PUB)).rejects.toThrow(
      /invalid NIP-59 seal/,
    );
  });

  it('a JSON round-trip of a stamped seal drops verifiedSymbol so tampered spreads never verify from the wire', () => {
    const aliceBytes = hexToBytes(ALICE_SECKEY);
    const seal = finalizeEvent(
      { kind: 13, content: 'x', created_at: 1_750_000_000, tags: [] },
      aliceBytes,
    ) as NostrEvent & Record<symbol, unknown>;
    expect(seal[verifiedSymbol]).toBe(true);
    // Tamper after stamping, then cross the wire boundary.
    (seal as { content: string }).content = 'tampered';
    const wireSeal = JSON.parse(JSON.stringify(seal)) as NostrEvent & Record<symbol, unknown>;
    expect(wireSeal[verifiedSymbol]).toBeUndefined();
    // This pins the invariant the unwrap path relies on at the verifyEvent
    // boundary: a wire seal can never carry a cached verdict.
    expect(verifyEvent(wireSeal)).toBe(false);
  });
});
