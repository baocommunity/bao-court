// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  COURT_GIFT_WRAP_KIND,
  COURT_INBOX_PUBLIC_KINDS,
  COURT_INBOX_SNAPSHOT_VERSION,
  COURT_WRAP_LOOKBACK_SECONDS,
  CourtInbox,
  CourtInboxError,
  buildCourtSubscriptions,
  classifyInboundEvent,
  createCourtInbox,
  publishToGroup,
  readFromGroup,
  type CourtInboxClassifyParams,
  type CourtInboxErrorCode,
  type CourtInboxSnapshot,
  type CourtRelayConnection,
  type CourtRelayFilter,
} from '../courtInbox';
import { COURT_DELIVERY_ACK_KIND } from '../courtOutbox';
import { bindCourtProtocolEvent } from '../courtProtocolEvents';
import { hashCourtSessionParameters, type CourtSessionParameters } from '../courtSession';
import {
  SeckeyCourtSigner,
  unwrapProtocolEventWithSigner,
  wrapProtocolEventWithSigner,
  type CourtEventSigner,
} from '../courtSigner';
import { BAO_COURT_VOTE_COMMIT_KIND, buildVoteCommitEvent } from '../events';

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

function freshBoundEvent(signerByte = 1): NostrEvent {
  return signTemplate(boundVoteCommitTemplate(signerByte, SESSION_CREATED + 10), signerByte);
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

class FakeRelay implements CourtRelayConnection {
  constructor(
    readonly url: string,
    private readonly behavior: {
      readonly failPublish?: boolean;
      readonly events?: readonly NostrEvent[];
      readonly throwOnSubscribe?: boolean;
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
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<NostrEvent>> {
            if (index >= events.length) {
              return Promise.resolve({ done: true, value: undefined });
            }
            const event = events[index];
            index += 1;
            return Promise.resolve({ done: false, value: event as NostrEvent });
          },
        };
      },
    };
  }
}

describe('buildCourtSubscriptions', () => {
  it('restricts public kinds to sorted roster authors bound to the session', () => {
    const session = parameters();
    const [publicFilter, wrapFilter] = buildCourtSubscriptions({
      session,
      myPubkey: MY_PUBKEY,
    });

    const expectedKinds = [...COURT_INBOX_PUBLIC_KINDS].sort((a, b) => a - b);
    expect(publicFilter?.kinds).toEqual(expectedKinds);
    expect(publicFilter?.kinds).toContain(COURT_DELIVERY_ACK_KIND);
    expect(publicFilter?.authors).toEqual(
      session.participants.map((p) => p.nostrPubkey).sort(),
    );
    expect(publicFilter?.since).toBe(session.createdAt);
    expect(publicFilter?.['#session']).toEqual([hashCourtSessionParameters(session)]);

    expect(wrapFilter?.kinds).toEqual([COURT_GIFT_WRAP_KIND]);
    expect(wrapFilter?.['#p']).toEqual([MY_PUBKEY]);
    expect(wrapFilter?.since).toBe(session.createdAt - COURT_WRAP_LOOKBACK_SECONDS);
    expect(wrapFilter && 'authors' in wrapFilter ? wrapFilter.authors : undefined).toBeUndefined();
  });

  it('is deterministic and canonical across calls', () => {
    const first = buildCourtSubscriptions({ session: parameters(), myPubkey: MY_PUBKEY });
    const second = buildCourtSubscriptions({ session: parameters(), myPubkey: MY_PUBKEY });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('rejects malformed recipient pubkeys', () => {
    expectInboxError(
      () => buildCourtSubscriptions({ session: parameters(), myPubkey: 'npub1nope' }),
      'malformed',
    );
  });
});

describe('classifyInboundEvent', () => {
  it('accepts a bound roster protocol event', () => {
    const verdict = classifyInboundEvent(freshBoundEvent(1), classifyParams());
    expect(verdict).toEqual({ accepted: true, category: 'protocol' });
  });

  it('rejects non-Court kinds', () => {
    const event = signTemplate(
      { kind: 1, created_at: SESSION_CREATED + 10, tags: [], content: 'hello' },
      1,
    );
    expect(classifyInboundEvent(event, classifyParams())).toEqual({
      accepted: false,
      reason: 'wrong_kind',
    });
  });

  it('rejects bound events signed outside the roster', () => {
    const event = signTemplate(
      boundVoteCommitTemplate(1, SESSION_CREATED + 10),
      OUTSIDER_BYTE,
    );
    expect(classifyInboundEvent(event, classifyParams())).toEqual({
      accepted: false,
      reason: 'author_not_in_roster',
    });
  });

  it('rejects events predating the session start', () => {
    const event = signTemplate(
      boundVoteCommitTemplate(1, SESSION_CREATED - 60),
      1,
    );
    expect(classifyInboundEvent(event, classifyParams())).toEqual({
      accepted: false,
      reason: 'stale_session',
    });
  });

  it('rejects events bound to a different session hash', () => {
    const template = boundVoteCommitTemplate(1, SESSION_CREATED + 10);
    const tampered: EventTemplate = {
      ...template,
      tags: template.tags.map((tag) =>
        tag[0] === 'session' ? ['session', 'ff'.repeat(32)] : tag,
      ),
    };
    expect(classifyInboundEvent(signTemplate(tampered, 1), classifyParams())).toEqual({
      accepted: false,
      reason: 'session_mismatch',
    });
  });

  it('rejects unbound legacy events as history-only', () => {
    const legacy: EventTemplate = {
      ...buildVoteCommitEvent({
        disputeId: parameters().disputeId,
        jurorIdx: 1,
        commitHash: '55'.repeat(32),
      }),
      created_at: SESSION_CREATED + 10,
    };
    expect(classifyInboundEvent(signTemplate(legacy, 1), classifyParams())).toEqual({
      accepted: false,
      reason: 'legacy_event',
    });
  });

  it('rejects events that mix bound and unbound structure', () => {
    const legacy: EventTemplate = {
      ...buildVoteCommitEvent({
        disputeId: parameters().disputeId,
        jurorIdx: 1,
        commitHash: '55'.repeat(32),
      }),
      created_at: SESSION_CREATED + 10,
    };
    const mixed: EventTemplate = {
      ...legacy,
      tags: [...legacy.tags, ['session', hashCourtSessionParameters(parameters())]],
    };
    expect(classifyInboundEvent(signTemplate(mixed, 1), classifyParams())).toEqual({
      accepted: false,
      reason: 'invalid_binding',
    });
  });

  it('accepts roster-signed delivery acks and rejects outsider acks', () => {
    const ack: EventTemplate = {
      kind: COURT_DELIVERY_ACK_KIND,
      created_at: SESSION_CREATED + 10,
      tags: [
        ['m', '66'.repeat(32)],
        ['e', '77'.repeat(32)],
      ],
      content: '',
    };
    expect(classifyInboundEvent(signTemplate(ack, 1), classifyParams())).toEqual({
      accepted: true,
      category: 'delivery-ack',
    });
    expect(classifyInboundEvent(signTemplate(ack, OUTSIDER_BYTE), classifyParams())).toEqual({
      accepted: false,
      reason: 'author_not_in_roster',
    });
  });

  it('accepts gift wraps addressed to me and rejects the rest', async () => {
    const mine = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'mine'), MY_PUBKEY);
    expect(classifyInboundEvent(mine, classifyParams())).toEqual({
      accepted: true,
      category: 'gift-wrap',
    });

    const theirs = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'theirs'), nostrPubkey(3));
    expect(classifyInboundEvent(theirs, classifyParams())).toEqual({
      accepted: false,
      reason: 'not_addressed_to_me',
    });
  });

  it('never throws on adversarial input', () => {
    const junk: unknown[] = [
      null,
      undefined,
      'event',
      42,
      {},
      { kind: '1059' },
      { kind: COURT_GIFT_WRAP_KIND },
      { kind: BAO_COURT_VOTE_COMMIT_KIND, tags: 'nope', content: '', pubkey: MY_PUBKEY, created_at: 1 },
      { kind: BAO_COURT_VOTE_COMMIT_KIND, tags: [], content: '', pubkey: 'zz', created_at: 1 },
      { kind: BAO_COURT_VOTE_COMMIT_KIND, tags: [['p', 1]], content: '', pubkey: MY_PUBKEY, created_at: 1 },
      { kind: BAO_COURT_VOTE_COMMIT_KIND, tags: [], content: '{', pubkey: MY_PUBKEY, created_at: SESSION_CREATED + 1 },
    ];
    for (const input of junk) {
      const verdict = classifyInboundEvent(input, classifyParams());
      expect(verdict.accepted).toBe(false);
    }
  });
});

describe('CourtInbox ingest and multi-relay dedupe', () => {
  it('dedupes a wrap across relays and records provenance', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'dedupe'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });

    const first = inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    expect(first.duplicate).toBe(false);
    expect(first.record.firstSeen).toBe(1_000);
    expect(first.record.lastSeen).toBe(1_000);
    expect(first.record.relays).toEqual(['wss://relay-a.example']);

    const second = inbox.ingest(wrap, 'wss://relay-b.example', 1_050);
    expect(second.duplicate).toBe(true);
    expect(second.record.firstSeen).toBe(1_000);
    expect(second.record.lastSeen).toBe(1_050);
    expect(second.record.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);

    const third = inbox.ingest(wrap, 'wss://relay-a.example', 1_100);
    expect(third.duplicate).toBe(true);
    expect(third.record.relays).toHaveLength(2);
    expect(third.record.lastSeen).toBe(1_100);

    expect(inbox.listRecords()).toHaveLength(1);
  });

  it('rejects wraps not addressed to the recipient', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'foreign'), nostrPubkey(3));
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    expectInboxError(() => inbox.ingest(wrap, 'wss://relay-a.example', 1_000), 'wrong_recipient');
    expect(inbox.listRecords()).toHaveLength(0);
  });

  it('rejects malformed wraps and relay urls', async () => {
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    expectInboxError(() => inbox.ingest(null, 'wss://relay-a.example', 1_000), 'malformed');
    expectInboxError(() => inbox.ingest({ kind: COURT_GIFT_WRAP_KIND }, 'wss://relay-a.example', 1_000), 'malformed');
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'url'), MY_PUBKEY);
    expectInboxError(() => inbox.ingest(wrap, '', 1_000), 'malformed');
    expectInboxError(
      () => inbox.ingest({ ...wrap, kind: 1 }, 'wss://relay-a.example', 1_000),
      'malformed',
    );
    expectInboxError(
      () => inbox.ingest({ ...wrap, id: 'not-hex' }, 'wss://relay-a.example', 1_000),
      'malformed',
    );
  });
});

describe('wrong-recipient wraps never reach decryption', () => {
  class ExplodingDecryptSigner implements CourtEventSigner {
    private readonly inner = new SeckeyCourtSigner(secret(MY_BYTE));

    /** Counting, not just throwing: downstream layers swallow per-record
     *  errors, so a throw alone cannot prove the guard held. */
    decryptCalls = 0;

    getPublicKey(): string {
      return this.inner.getPublicKey();
    }

    signEvent(
      template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
    ): Promise<NostrEvent> {
      return this.inner.signEvent(template);
    }

    nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
      return this.inner.nip44Encrypt(peerPubkey, plaintext);
    }

    nip44Decrypt(): Promise<string> {
      this.decryptCalls += 1;
      throw new Error('decrypt must never be called for foreign wraps');
    }
  }

  it('rejects the foreign wrap at ingest and drain never decrypts', async () => {
    const foreign = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'spy'), nostrPubkey(3));
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    expectInboxError(() => inbox.ingest(foreign, 'wss://relay-a.example', 1_000), 'wrong_recipient');

    const signer = new ExplodingDecryptSigner();
    await expect(inbox.drain(signer)).resolves.toEqual([]);
    expect(signer.decryptCalls).toBe(0);

    // Even if a foreign wrap were forced past ingest, the signer-backed unwrap
    // itself refuses to decrypt wraps without a matching p tag.
    const unwrapSigner = new ExplodingDecryptSigner();
    await expect(unwrapProtocolEventWithSigner(foreign, unwrapSigner)).resolves.toBeNull();
    expect(unwrapSigner.decryptCalls).toBe(0);
  });
});

describe('CourtInbox drain', () => {
  it('unwraps with the signer and returns rumors sorted by created_at', async () => {
    const wraps = await Promise.all([
      wrapTo(rumorTemplate(SESSION_CREATED + 300, 'third'), MY_PUBKEY),
      wrapTo(rumorTemplate(SESSION_CREATED + 100, 'first'), MY_PUBKEY),
      wrapTo(rumorTemplate(SESSION_CREATED + 200, 'second'), MY_PUBKEY),
    ]);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    wraps.forEach((wrap, index) => {
      inbox.ingest(wrap, `wss://relay-${index}.example`, 1_000 + index);
    });

    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages.map((m) => JSON.parse(m.rumor.content).marker)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(messages.map((m) => m.rumor.created_at)).toEqual([
      SESSION_CREATED + 100,
      SESSION_CREATED + 200,
      SESSION_CREATED + 300,
    ]);
    expect(messages[0]?.wrapIds).toHaveLength(1);
    expect(messages[0]?.relays).toHaveLength(1);

    // Everything is drained now; a second drain is empty.
    await expect(inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
  });

  it('merges re-wrapped duplicates into one message with combined provenance', async () => {
    const rumor = rumorTemplate(SESSION_CREATED + 100, 'duplicate');
    const wrapA = await wrapTo(rumor, MY_PUBKEY);
    const wrapB = await wrapTo(rumor, MY_PUBKEY);
    expect(wrapA.id).not.toBe(wrapB.id);

    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrapA, 'wss://relay-a.example', 1_000);
    inbox.ingest(wrapB, 'wss://relay-b.example', 1_010);

    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);
    expect([...(messages[0]?.wrapIds ?? [])].sort()).toEqual([wrapA.id, wrapB.id].sort());
    expect(messages[0]?.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);
  });

  it('drops tampered wraps without throwing and marks them drained', async () => {
    const good = await wrapTo(rumorTemplate(SESSION_CREATED + 100, 'good'), MY_PUBKEY);
    const tampered: NostrEvent = { ...good, content: 'AA'.repeat(64) };
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(tampered, 'wss://relay-a.example', 1_000);

    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toEqual([]);
    expect(inbox.getRecord(tampered.id)?.drained).toBe(true);
    await expect(inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)))).resolves.toEqual([]);
  });
});

describe('publishToGroup', () => {
  it('fans out to every relay and captures per-relay failures', async () => {
    const event = signTemplate(
      { kind: COURT_DELIVERY_ACK_KIND, created_at: SESSION_CREATED + 10, tags: [['m', '66'.repeat(32)], ['e', '77'.repeat(32)]], content: '' },
      1,
    );
    const relays = [
      new FakeRelay('wss://relay-a.example'),
      new FakeRelay('wss://relay-b.example', { failPublish: true }),
      new FakeRelay('wss://relay-c.example'),
    ];

    const report = await publishToGroup(event, relays);
    expect(report.delivered).toEqual(['wss://relay-a.example', 'wss://relay-c.example']);
    expect(report.results).toHaveLength(3);
    expect(report.results[0]).toEqual({ url: 'wss://relay-a.example', ok: true });
    expect(report.results[1]?.ok).toBe(false);
    expect(report.results[1]?.error).toContain('relay wss://relay-b.example down');
    expect(report.results[2]).toEqual({ url: 'wss://relay-c.example', ok: true });
  });
});

describe('readFromGroup', () => {
  it('merges every relay stream with provenance and survives a broken relay', async () => {
    const eventA = signTemplate(
      { kind: 1, created_at: SESSION_CREATED + 1, tags: [], content: 'a' },
      1,
    );
    const eventB = signTemplate(
      { kind: 1, created_at: SESSION_CREATED + 2, tags: [], content: 'b' },
      2,
    );
    const relays = [
      new FakeRelay('wss://relay-a.example', { events: [eventA] }),
      new FakeRelay('wss://broken.example', { throwOnSubscribe: true }),
      new FakeRelay('wss://relay-b.example', { events: [eventB, eventA] }),
    ];

    const deliveries: { id: string; relayUrl: string }[] = [];
    for await (const delivery of readFromGroup(relays, [{ kinds: [1] }])) {
      deliveries.push({ id: delivery.event.id, relayUrl: delivery.relayUrl });
    }

    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter((d) => d.relayUrl === 'wss://relay-a.example')).toHaveLength(1);
    expect(deliveries.filter((d) => d.relayUrl === 'wss://relay-b.example')).toHaveLength(2);
    expect(deliveries.some((d) => d.relayUrl === 'wss://broken.example')).toBe(false);
  });
});

describe('CourtInbox snapshots', () => {
  async function populatedInbox(): Promise<{ inbox: CourtInbox; wrapId: string }> {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 100, 'persisted'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    inbox.ingest(wrap, 'wss://relay-b.example', 1_050);
    return { inbox, wrapId: wrap.id };
  }

  it('round-trips through JSON and keeps provenance and drain state', async () => {
    const { inbox } = await populatedInbox();
    const restored = CourtInbox.fromSnapshot(jsonRoundTrip(inbox.snapshot()), MY_PUBKEY);

    expect(restored.recipientPubkey).toBe(MY_PUBKEY);
    expect(restored.listRecords()).toEqual(inbox.listRecords());

    const messages = await restored.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.rumor.content ?? '{}').marker).toBe('persisted');
    expect(messages[0]?.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);
    expect(restored.getRecord(messages[0]?.wrapIds[0] ?? '')?.drained).toBe(true);
  });

  it('rejects corrupted snapshots with a typed error', async () => {
    const { inbox } = await populatedInbox();
    const good = inbox.snapshot();

    const mutations: ((snapshot: CourtInboxSnapshot) => unknown)[] = [
      () => null,
      () => 'not a snapshot',
      (s) => ({ ...s, version: 2 }),
      (s) => ({ ...s, myPubkey: 'bad' }),
      (s) => ({ ...s, records: 'nope' }),
      (s) => ({ ...s, records: [...s.records, s.records[0]] }),
      (s) => ({
        ...s,
        records: s.records.map((r) => ({ ...r, lastSeen: r.firstSeen - 1 })),
      }),
      (s) => ({
        ...s,
        records: s.records.map((r) => ({ ...r, relays: [] })),
      }),
      (s) => ({
        ...s,
        records: s.records.map((r) => ({
          ...r,
          wrap: { ...r.wrap, tags: [['p', nostrPubkey(3)]] },
        })),
      }),
      (s) => ({
        ...s,
        records: s.records.map((r) => ({ ...r, wrapId: 'ab'.repeat(32) })),
      }),
    ];

    for (const mutate of mutations) {
      expectInboxError(() => CourtInbox.fromSnapshot(jsonRoundTrip(mutate(good))), 'corrupt_snapshot');
    }
  });

  it('rejects snapshots restored for a different recipient', async () => {
    const { inbox } = await populatedInbox();
    expectInboxError(
      () => CourtInbox.fromSnapshot(jsonRoundTrip(inbox.snapshot()), nostrPubkey(3)),
      'corrupt_snapshot',
    );
  });

  it('stamps the snapshot with its schema version', async () => {
    const { inbox } = await populatedInbox();
    expect(inbox.snapshot().version).toBe(COURT_INBOX_SNAPSHOT_VERSION);
  });
});
