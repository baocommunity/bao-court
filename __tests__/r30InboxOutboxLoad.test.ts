// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round-30 transport campaign — INBOX / OUTBOX UNDER LOAD AND ADVERSITY.
 *
 * Four families:
 *
 *   A. A 10k-event flood that is 90% duplicates: dedupe must hold, provenance
 *      must stay per-relay, and the durable form must stay bounded (measured
 *      in serialized bytes — a deterministic proxy for memory, unlike
 *      `heapUsed` which jitters with GC).
 *   B. Provenance overflow: a wrap delivered by more relays than the record
 *      cap (round-30 finding — this used to make the snapshot unrestorable).
 *   C. Capacity/eviction semantics at MAX_RECORDS: fail-closed at the bound,
 *      duplicates still accepted at the bound, drained records never silently
 *      evicted.
 *   D. Outbox exactly-once under a partial relay failure: a message that
 *      reached 2 of 3 relays is retried with the SAME wrap template, the
 *      recipient dedupes by wrap id, acks once, and the ack is idempotent
 *      under redelivery. Plus canonical-key collisions across message
 *      boundaries.
 */

import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';

import {
  COURT_GIFT_WRAP_KIND,
  CourtInbox,
  createCourtInbox,
  type CourtInboxRecord,
} from '../courtInbox';
import {
  COURT_DELIVERY_ACK_KIND,
  CourtOutbox,
  createCourtOutbox,
  hashCourtOutboxMessage,
} from '../courtOutbox';
import { wrapProtocolEvent } from '../nip59';
import { SeckeyCourtSigner } from '../courtSigner';

const T0 = 1_787_000_000;

// ---------------------------------------------------------------------------
// Cheap synthetic wraps
// ---------------------------------------------------------------------------

/**
 * Build a shape-valid gift wrap without signing. `ingest` validates the wrap
 * ID against the exact bytes (NIP-01 serialization) and the sig SHAPE, and
 * performs no signature verification — so a synthetic wrap exercises the real
 * ingest gates at a fraction of the cost. Anything that must survive `drain`
 * is built with the real `wrapProtocolEvent` instead.
 */
function syntheticWrap(recipientPubkey: string, marker: number, createdAt = T0): NostrEvent {
  const base = {
    pubkey: 'aa'.repeat(32),
    created_at: createdAt,
    kind: COURT_GIFT_WRAP_KIND,
    tags: [['p', recipientPubkey]],
    content: JSON.stringify({ marker }),
  };
  return { ...base, id: getEventHash(base as NostrEvent), sig: 'bb'.repeat(64) } as NostrEvent;
}

// ---------------------------------------------------------------------------
// A. 10k-event flood, 90% duplicates
// ---------------------------------------------------------------------------

describe('A. 10k-event flood with 90% duplicates', () => {
  it('keeps exactly one record per wrap and one provenance entry per relay', { timeout: 120_000 }, () => {
    const recipient = getPublicKey(generateSecretKey());
    const inbox = createCourtInbox({ myPubkey: recipient });

    const UNIQUE = 1_000;
    const RELAYS = 10;
    const wraps = Array.from({ length: UNIQUE }, (_, i) => syntheticWrap(recipient, i));
    const relays = Array.from({ length: RELAYS }, (_, i) => `wss://relay-${i}.example`);

    const startedAt = Date.now();
    let duplicates = 0;
    let fresh = 0;
    // 10,000 ingest calls: every wrap from every relay (9,000 are duplicates).
    for (let round = 0; round < RELAYS; round += 1) {
      for (let i = 0; i < UNIQUE; i += 1) {
        const result = inbox.ingest(wraps[i]!, relays[round]!, T0 + round);
        if (result.duplicate) duplicates += 1;
        else fresh += 1;
      }
    }
    const elapsedMs = Date.now() - startedAt;

    expect(duplicates).toBe(UNIQUE * (RELAYS - 1));
    expect(fresh).toBe(UNIQUE);
    expect(duplicates + fresh).toBe(10_000);

    const records = inbox.listRecords();
    expect(records).toHaveLength(UNIQUE);
    for (const record of records) {
      expect(record.relays).toHaveLength(RELAYS);
      expect(record.relays).toEqual([...relays].sort());
      expect(record.firstSeen).toBe(T0);
      expect(record.lastSeen).toBe(T0 + RELAYS - 1);
      expect(record.drained).toBe(false);
    }

    // Bounded durable form: ~1 KB per wrap is the whole budget, so 1,000
    // records must serialize to a few MB at most, not to 10,000 copies.
    const snapshotBytes = JSON.stringify(inbox.snapshot()).length;
    expect(snapshotBytes).toBeLessThan(4 * 1024 * 1024);
    expect(snapshotBytes).toBeGreaterThan(UNIQUE * 200); // sanity: real payloads

    // Restart restores the same dedupe state.
    const restored = CourtInbox.fromSnapshot(
      JSON.parse(JSON.stringify(inbox.snapshot())),
      recipient,
    );
    expect(restored.listRecords()).toHaveLength(UNIQUE);

    // The whole flood replayed again changes nothing.
    for (let round = 0; round < RELAYS; round += 1) {
      for (let i = 0; i < UNIQUE; i += 1) {
        expect(inbox.ingest(wraps[i]!, relays[round]!, T0 + 100).duplicate).toBe(true);
      }
    }
    expect(inbox.listRecords()).toHaveLength(UNIQUE);

    // Hard bound on the ingest loop (~25k calls/s means the gates are O(1)).
    expect(elapsedMs).toBeLessThan(120_000);
  });
});

// ---------------------------------------------------------------------------
// B. Provenance overflow (round-30 finding)
// ---------------------------------------------------------------------------

describe('B. provenance overflow cannot brick the durable inbox', () => {
  it('caps a single wrap\'s provenance and keeps the snapshot restorable', () => {
    const recipient = getPublicKey(generateSecretKey());
    const inbox = createCourtInbox({ myPubkey: recipient });
    const wrap = syntheticWrap(recipient, 1);

    for (let i = 0; i < 70; i += 1) {
      inbox.ingest(wrap, `wss://relay-${String(i).padStart(2, '0')}.example`, T0 + i);
    }
    const record = inbox.listRecords()[0]!;
    // The cap is 64 distinct sources: the FIRST 64 by delivery order win.
    expect(record.relays).toHaveLength(64);
    expect(record.relays).toContain('wss://relay-00.example');
    expect(record.relays).toContain('wss://relay-63.example');
    expect(record.relays).not.toContain('wss://relay-64.example');
    // lastSeen still advances even when provenance is full.
    expect(record.lastSeen).toBe(T0 + 69);

    // The durable form is accepted (this is the regression: it used to fail
    // with corrupt_snapshot, losing every message in the inbox).
    const restored = CourtInbox.fromSnapshot(
      JSON.parse(JSON.stringify(inbox.snapshot())),
      recipient,
    );
    expect(restored.listRecords()[0]!.relays).toHaveLength(64);

    // Re-delivery from an already-recorded source stays a no-op.
    const again = inbox.ingest(wrap, 'wss://relay-07.example', T0 + 200);
    expect(again.duplicate).toBe(true);
    expect(again.record.relays).toHaveLength(64);
  });

  it('a record with 65 relay URLs is still rejected when restored from a TAMPERED snapshot', () => {
    const recipient = getPublicKey(generateSecretKey());
    const inbox = createCourtInbox({ myPubkey: recipient });
    const wrap = syntheticWrap(recipient, 2);
    inbox.ingest(wrap, 'wss://relay-a.example', T0);
    const snapshot = JSON.parse(JSON.stringify(inbox.snapshot())) as {
      records: { relays: string[] }[];
    };
    snapshot.records[0]!.relays = Array.from({ length: 65 }, (_, i) => `wss://evil-${i}.example`);
    expect(() => CourtInbox.fromSnapshot(snapshot, recipient)).toThrowError(/bounded array/);
  });
});

// ---------------------------------------------------------------------------
// C. Per-relay provenance, capacity, eviction
// ---------------------------------------------------------------------------

describe('C. per-relay provenance and capacity semantics', () => {
  it('mixes provenance per relay without ever merging different wraps', () => {
    const recipient = getPublicKey(generateSecretKey());
    const inbox = createCourtInbox({ myPubkey: recipient });
    const wrapA = syntheticWrap(recipient, 10);
    const wrapB = syntheticWrap(recipient, 11);

    inbox.ingest(wrapA, 'wss://relay-x.example', T0);
    inbox.ingest(wrapB, 'wss://relay-y.example', T0);
    inbox.ingest(wrapA, 'wss://relay-y.example', T0 + 1);

    const records = inbox.listRecords();
    expect(records).toHaveLength(2);
    const byId = new Map(records.map((r) => [r.wrapId, r] as const));
    expect(byId.get(wrapA.id)!.relays).toEqual(['wss://relay-x.example', 'wss://relay-y.example']);
    expect(byId.get(wrapB.id)!.relays).toEqual(['wss://relay-y.example']);
  });

  it('rejects a hostile relay identifier rather than storing it as provenance', () => {
    const recipient = getPublicKey(generateSecretKey());
    const inbox = createCourtInbox({ myPubkey: recipient });
    const wrap = syntheticWrap(recipient, 12);
    expect(() => inbox.ingest(wrap, ' wss://relay-x.example', T0)).toThrowError(/relayUrl/);
    expect(() => inbox.ingest(wrap, '', T0)).toThrowError(/relayUrl/);
    expect(() => inbox.ingest(wrap, `wss://${'x'.repeat(600)}`, T0)).toThrowError(/relayUrl/);
    expect(inbox.listRecords()).toHaveLength(0);
  });

  it('fails closed at MAX_RECORDS but still dedupes known wraps at the bound', { timeout: 300_000 }, () => {
    const recipient = getPublicKey(generateSecretKey());
    const inbox = createCourtInbox({ myPubkey: recipient });
    const CAP = 100_000;
    let first: NostrEvent | null = null;
    for (let i = 0; i < CAP; i += 1) {
      const wrap = syntheticWrap(recipient, i);
      if (i === 0) first = wrap;
      inbox.ingest(wrap, 'wss://relay.example', T0);
    }
    expect(inbox.listRecords()).toHaveLength(CAP);

    // A brand-new wrap is refused (no silent eviction of existing messages).
    expect(() => inbox.ingest(syntheticWrap(recipient, CAP), 'wss://relay.example', T0))
      .toThrowError(/capacity/i);
    expect(inbox.listRecords()).toHaveLength(CAP);

    // A known wrap still ingests: the dedupe path runs before the capacity gate.
    const known = inbox.ingest(first!, 'wss://relay-2.example', T0 + 5);
    expect(known.duplicate).toBe(true);
    expect(known.record.relays).toHaveLength(2);
    expect(inbox.listRecords()).toHaveLength(CAP);
  });
});

// ---------------------------------------------------------------------------
// D. Outbox exactly-once under partial failure + canonical-key collisions
// ---------------------------------------------------------------------------

describe('D. outbox exactly-once delivery under a partial relay failure', () => {
  it('retries the SAME wrap template and the recipient acks exactly once', async () => {
    const senderSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    const sessionHash = 'ab'.repeat(32);
    const payload = JSON.stringify({ share: 'ff'.repeat(48), phaseNonce: 'n1' });
    const wrap = wrapProtocolEvent(
      { kind: 39003, tags: [['dispute', sessionHash]], content: payload, created_at: T0 } as never,
      senderSk,
      recipientPk,
    );

    const outbox = createCourtOutbox({
      initialRetrySeconds: 30,
      maxRetrySeconds: 3_600,
      deadlineSeconds: 86_400,
    });
    const entry = outbox.enqueue(
      { sessionHash, innerKind: 39003, recipientPubkey: recipientPk, payload, wrap },
      T0,
    );
    expect(outbox.dueEntries(T0)).toHaveLength(1);

    // Attempt 1: broadcast to 3 relays. A and C accept, B times out — and the
    // host cannot tell whether B's copy reached the recipient or not.
    outbox.markSent(entry.messageKey, T0);
    const deliveries: string[] = [];
    const relays = ['wss://relay-a.example', 'wss://relay-b.example', 'wss://relay-c.example'];
    const recipientInbox = createCourtInbox({ myPubkey: recipientPk });
    for (const relay of relays) {
      if (relay === 'wss://relay-b.example') continue; // simulated timeout
      deliveries.push(wrap.id);
      recipientInbox.ingest(wrap, relay, T0);
    }
    expect(deliveries).toEqual([wrap.id, wrap.id]);

    const signer = new SeckeyCourtSigner(recipientSk);
    const firstDrain = await recipientInbox.drain(signer);
    expect(firstDrain).toHaveLength(1);
    expect(firstDrain[0]!.relays).toEqual(['wss://relay-a.example', 'wss://relay-c.example']);

    // No ack yet → the entry is still due after the backoff, and the retry
    // rebroadcasts the STORED template byte-for-byte (same wrap id).
    expect(outbox.getEntry(entry.messageKey)!.status).toBe('sent');
    const dueAt = outbox.getEntry(entry.messageKey)!.nextRetryAt;
    expect(dueAt).toBe(T0 + 30);
    expect(outbox.dueEntries(T0 + 29)).toHaveLength(0);
    const due = outbox.dueEntries(dueAt);
    expect(due).toHaveLength(1);
    expect(due[0]!.wrap.content).toBe(wrap.content);
    expect(due[0]!.wrap.id).toBe(wrap.id);

    // Attempt 2 reaches relay B (and re-reaches A): the recipient re-ingests
    // the SAME wrap id from a new relay. Dedupe holds; the drain is empty.
    outbox.markSent(entry.messageKey, dueAt);
    const secondIngest = recipientInbox.ingest(wrap, 'wss://relay-b.example', dueAt);
    expect(secondIngest.duplicate).toBe(true);
    expect(secondIngest.record.relays).toEqual([...relays].sort());
    expect(await recipientInbox.drain(signer)).toEqual([]);

    // The recipient acks the logical message key exactly once.
    const messageKey = entry.messageKey;
    const ack = finalizeEvent(
      {
        kind: COURT_DELIVERY_ACK_KIND,
        created_at: dueAt + 1,
        tags: [['m', messageKey], ['e', wrap.id]],
        content: '',
      },
      recipientSk,
    );
    const acked = outbox.recordAck(ack, dueAt + 1);
    expect(acked.status).toBe('acked');
    expect(acked.attempts).toBe(2);
    expect(acked.ackEventId).toBe(ack.id);
    expect(outbox.dueEntries(dueAt + 3_600)).toHaveLength(0);

    // Redelivering the ack (relays re-serve addressable acks) is idempotent.
    for (let i = 0; i < 5; i += 1) {
      const again = outbox.recordAck(ack, dueAt + 10 + i);
      expect(again.status).toBe('acked');
      expect(again.ackedAt).toBe(dueAt + 1);
      expect(again.ackEventId).toBe(ack.id);
    }

    // A snapshot makes the exactly-once state durable and re-verifiable.
    const restored = CourtOutbox.fromSnapshot(JSON.parse(JSON.stringify(outbox.snapshot())));
    expect(restored.getEntry(messageKey)!.status).toBe('acked');
    expect(restored.getEntry(messageKey)!.ackEventId).toBe(ack.id);
    expect(restored.dueEntries(dueAt + 86_400)).toHaveLength(0);

    // The sender identity is stable across the retry path (no re-wrap).
    expect(senderPk).toBe(getPublicKey(senderSk));
  });

  it('a re-wrap of the same logical message is one entry, not a second send', async () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const sessionHash = 'cd'.repeat(32);
    const payload = JSON.stringify({ vote: 'YES' });

    const outbox = createCourtOutbox({
      initialRetrySeconds: 30, maxRetrySeconds: 3_600, deadlineSeconds: 86_400,
    });
    const template = (wrap: NostrEvent) => ({
      kind: wrap.kind,
      content: wrap.content,
      tags: wrap.tags as string[][],
      created_at: wrap.created_at,
      pubkey: wrap.pubkey,
      id: wrap.id,
      sig: wrap.sig,
    });
    const wrap1 = wrapProtocolEvent(
      { kind: 39004, tags: [['dispute', sessionHash]], content: payload, created_at: T0 } as never,
      senderSk,
      recipientPk,
    );
    // Same logical message, re-wrapped later: different ephemeral key, id, and
    // rumor created_at — the wire identity changes completely.
    const wrap2 = wrapProtocolEvent(
      { kind: 39004, tags: [['dispute', sessionHash]], content: payload, created_at: T0 + 60 } as never,
      senderSk,
      recipientPk,
    );
    expect(wrap2.id).not.toBe(wrap1.id);

    const first = outbox.enqueue(
      { sessionHash, innerKind: 39004, recipientPubkey: recipientPk, payload, wrap: template(wrap1) },
      T0,
    );
    outbox.markSent(first.messageKey, T0);
    const second = outbox.enqueue(
      { sessionHash, innerKind: 39004, recipientPubkey: recipientPk, payload, wrap: template(wrap2) },
      T0 + 60,
    );
    expect(second.messageKey).toBe(first.messageKey);
    expect(second.attempts).toBe(1); // enqueue never resets or re-adds
    expect(outbox.listEntries()).toHaveLength(1);

    // The recipient really would see TWO distinct rumors if both went out —
    // which is exactly why wire-level dedupe is not enough and the semantic
    // (message-key) dedupe above is the one that matters.
    const inbox = createCourtInbox({ myPubkey: recipientPk });
    inbox.ingest(wrap1, 'wss://relay.example', T0);
    inbox.ingest(wrap2, 'wss://relay.example', T0 + 60);
    expect(inbox.listRecords()).toHaveLength(2);
    const drained = await inbox.drain(new SeckeyCourtSigner(recipientSk));
    expect(drained).toHaveLength(2);
    expect(new Set(drained.map((m) => m.rumor.id)).size).toBe(2);
    expect(drained[0]!.rumor.content).toBe(drained[1]!.rumor.content);
  });
});

describe('D2. canonical message key: no boundary or payload collisions', () => {
  const base = {
    sessionHash: '11'.repeat(32),
    innerKind: 39004,
    recipientPubkey: '22'.repeat(32),
    payload: 'ab',
  };

  it('is deterministic and sensitive to a one-byte payload change', () => {
    expect(hashCourtOutboxMessage(base)).toBe(hashCourtOutboxMessage({ ...base }));
    expect(hashCourtOutboxMessage(base)).not.toBe(hashCourtOutboxMessage({ ...base, payload: 'ac' }));
    expect(hashCourtOutboxMessage(base)).not.toBe(hashCourtOutboxMessage({ ...base, payload: 'ab ' }));
  });

  it('cannot be made ambiguous by shifting a byte across field boundaries', () => {
    const keys = new Set([
      // payload boundary shifts
      hashCourtOutboxMessage({ ...base, payload: 'ab', innerKind: 39004 }),
      hashCourtOutboxMessage({ ...base, payload: 'a', innerKind: 39004 }),
      hashCourtOutboxMessage({ ...base, payload: 'b', innerKind: 39004 }),
      // kind cross-feed: a payload that looks like a kind integer
      hashCourtOutboxMessage({ ...base, payload: '39004', innerKind: 39004 }),
      // session/recipient swap
      hashCourtOutboxMessage({ ...base, sessionHash: '22'.repeat(32), recipientPubkey: '11'.repeat(32) }),
      // kind shift with the payload held fixed
      hashCourtOutboxMessage({ ...base, innerKind: 39005 }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('keeps a wrap id and a message key distinct (different domains)', () => {
    const wrapId = '33'.repeat(32);
    expect(hashCourtOutboxMessage(base)).not.toBe(wrapId);
    // Same bytes in a different field give a different key.
    expect(hashCourtOutboxMessage({ ...base, payload: '33'.repeat(32) }))
      .not.toBe(hashCourtOutboxMessage({ ...base, payload: '33'.repeat(32), innerKind: 1 }));
  });
});

// Keep the record type import honest for readers.
export type _Record = CourtInboxRecord;
