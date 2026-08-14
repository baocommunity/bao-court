// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/pure';

import {
  COURT_DELIVERY_ACK_KIND,
  CourtOutbox,
  CourtOutboxError,
  createCourtOutbox,
  hashCourtOutboxMessage,
  type CourtOutboxEnqueueInput,
  type CourtOutboxEntry,
  type CourtOutboxErrorCode,
  type CourtOutboxSnapshot,
  type CourtOutboxWrapTemplate,
  type OutboxStorage,
} from '../courtOutbox';

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

function jsonRoundTrip(snapshot: CourtOutboxSnapshot): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}

class MemoryStorage implements OutboxStorage {
  data: unknown;

  load(): unknown {
    return this.data;
  }

  save(snapshot: CourtOutboxSnapshot): void {
    this.data = jsonRoundTrip(snapshot);
  }
}

describe('Court outbox logical message key', () => {
  it('is stable across re-wraps and changes with any logical field', () => {
    const base = hashCourtOutboxMessage({
      sessionHash: SESSION,
      innerKind: 39004,
      recipientPubkey: RECIPIENT_PUBKEY,
      payload: PAYLOAD,
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      hashCourtOutboxMessage({
        sessionHash: SESSION,
        innerKind: 39004,
        recipientPubkey: RECIPIENT_PUBKEY,
        payload: PAYLOAD,
      }),
    ).toBe(base);
    expect(
      hashCourtOutboxMessage({
        sessionHash: OTHER_SESSION,
        innerKind: 39004,
        recipientPubkey: RECIPIENT_PUBKEY,
        payload: PAYLOAD,
      }),
    ).not.toBe(base);
    expect(
      hashCourtOutboxMessage({
        sessionHash: SESSION,
        innerKind: 39005,
        recipientPubkey: RECIPIENT_PUBKEY,
        payload: PAYLOAD,
      }),
    ).not.toBe(base);
    expect(
      hashCourtOutboxMessage({
        sessionHash: SESSION,
        innerKind: 39004,
        recipientPubkey: OTHER_PUBKEY,
        payload: PAYLOAD,
      }),
    ).not.toBe(base);
    expect(
      hashCourtOutboxMessage({
        sessionHash: SESSION,
        innerKind: 39004,
        recipientPubkey: RECIPIENT_PUBKEY,
        payload: `${PAYLOAD} `,
      }),
    ).not.toBe(base);
  });
});

describe('Court outbox enqueue and dedupe', () => {
  it('dedupes a re-wrap of the same logical message to one entry', () => {
    const outbox = makeOutbox();
    const first = outbox.enqueue(makeInput(), 100);
    const rewrapped = outbox.enqueue(
      makeInput({ wrap: wrapTemplate(WRAP_ID_B, { created_at: 401, content: 'different-ciphertext' }) }),
      200,
    );
    expect(rewrapped.messageKey).toBe(first.messageKey);
    expect(outbox.listEntries()).toHaveLength(1);
    // The first wrap template is retained for crash-safe rebroadcast.
    expect(outbox.getEntry(first.messageKey)?.wrap.id).toBe(WRAP_ID_A);
    expect(outbox.getEntry(first.messageKey)?.enqueuedAt).toBe(100);
  });

  it('is idempotent for an identical re-enqueue', () => {
    const outbox = makeOutbox();
    const first = outbox.enqueue(makeInput(), 100);
    const second = outbox.enqueue(makeInput(), 100);
    // Idempotent: same logical entry — but never the same object reference,
    // so host-side mutation cannot bypass transition gates.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(outbox.listEntries()).toHaveLength(1);
  });

  it('isolates internal state from host-side mutation of returned entries', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 100);
    (entry as { status: string }).status = 'acked';
    (entry as { nextRetryAt: number }).nextRetryAt = 0;
    (entry.wrap.tags as string[][])[0][0] = 'tampered';

    const fresh = outbox.getEntry(entry.messageKey);
    expect(fresh?.status).toBe('queued');
    expect(fresh?.nextRetryAt).toBe(100);
    expect(fresh?.wrap.tags[0][0]).not.toBe('tampered');

    const listed = outbox.listEntries()[0];
    (listed as { status: string }).status = 'acked';
    expect(outbox.getEntry(entry.messageKey)?.status).toBe('queued');

    const due = outbox.dueEntries(100)[0];
    (due as { status: string }).status = 'acked';
    expect(outbox.getEntry(entry.messageKey)?.status).toBe('queued');
  });

  it('tracks distinct logical messages as distinct entries', () => {
    const outbox = makeOutbox();
    outbox.enqueue(makeInput(), 100);
    outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 100);
    outbox.enqueue(makeInput({ payload: JSON.stringify({ kind: 39004, round: 2 }) }), 100);
    expect(outbox.listEntries()).toHaveLength(3);
  });

  it('rejects malformed enqueue input', () => {
    const outbox = makeOutbox();
    expectOutboxError(
      () => outbox.enqueue(makeInput({ sessionHash: 'ZZ' }), 100),
      'malformed',
    );
    expectOutboxError(
      () => outbox.enqueue(makeInput({ innerKind: -1 }), 100),
      'malformed',
    );
    expectOutboxError(
      () => outbox.enqueue(makeInput({ recipientPubkey: RECIPIENT_PUBKEY.toUpperCase() }), 100),
      'malformed',
    );
    expectOutboxError(() => outbox.enqueue(makeInput({ payload: '' }), 100), 'malformed');
    expectOutboxError(
      () => outbox.enqueue(makeInput({ wrap: wrapTemplate('not-hex') }), 100),
      'malformed',
    );
    expectOutboxError(() => outbox.enqueue(makeInput(), -1), 'malformed');
  });

  it('rejects invalid retry params at creation', () => {
    expectOutboxError(
      () => makeOutbox({ initialRetrySeconds: 0, maxRetrySeconds: 100, deadlineSeconds: 10 }),
      'malformed',
    );
    expectOutboxError(
      () => makeOutbox({ initialRetrySeconds: 200, maxRetrySeconds: 100, deadlineSeconds: 10 }),
      'malformed',
    );
    expectOutboxError(
      () => makeOutbox({ initialRetrySeconds: 10, maxRetrySeconds: 100, deadlineSeconds: 0 }),
      'malformed',
    );
  });
});

describe('Court outbox retry scheduling', () => {
  it('doubles backoff per attempt up to the cap across injected time steps', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const key = entry.messageKey;

    // Immediately due for the first send.
    expect(outbox.dueEntries(0).map((e) => e.messageKey)).toEqual([key]);

    let current = outbox.markSent(key, 0);
    expect(current.status).toBe('sent');
    expect(current.attempts).toBe(1);
    expect(current.lastSentAt).toBe(0);
    expect(current.nextRetryAt).toBe(10); // initial backoff
    expect(outbox.dueEntries(9)).toHaveLength(0);
    expect(outbox.dueEntries(10)).toHaveLength(1);

    current = outbox.markSent(key, 10);
    expect(current.attempts).toBe(2);
    expect(current.nextRetryAt).toBe(30); // 10 * 2

    current = outbox.markSent(key, 30);
    expect(current.nextRetryAt).toBe(70); // 10 * 4

    current = outbox.markSent(key, 70);
    expect(current.nextRetryAt).toBe(150); // 10 * 8

    current = outbox.markSent(key, 150);
    expect(current.nextRetryAt).toBe(250); // 10 * 16 = 160 -> capped at 100

    current = outbox.markSent(key, 250);
    expect(current.nextRetryAt).toBe(350); // stays capped
    expect(current.attempts).toBe(6);
  });

  it('orders due entries by nextRetryAt then message key', () => {
    const outbox = makeOutbox();
    const a = outbox.enqueue(makeInput(), 0);
    const b = outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 0);
    outbox.markSent(a.messageKey, 0);
    outbox.markSent(b.messageKey, 5);
    const due = outbox.dueEntries(15);
    expect(due.map((e) => e.messageKey)).toEqual([a.messageKey, b.messageKey]);
  });

  it('rejects markSent for unknown and acknowledged messages', () => {
    const outbox = makeOutbox();
    expectOutboxError(() => outbox.markSent('cc'.repeat(32), 0), 'unknown_message');
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    outbox.recordAck(ack, 1);
    expectOutboxError(() => outbox.markSent(entry.messageKey, 2), 'invalid_transition');
  });
});

describe('Court outbox deadline handling', () => {
  it('buries overdue entries and rejects their sends and acks', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    outbox.markSent(entry.messageKey, 0);

    // Past the deadline the entry is no longer due even before sweeping.
    expect(outbox.dueEntries(PARAMS.deadlineSeconds)).toHaveLength(0);

    const buried = outbox.expireOverdue(PARAMS.deadlineSeconds);
    expect(buried).toEqual([entry.messageKey]);
    expect(outbox.getEntry(entry.messageKey)?.status).toBe('dead');

    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    expectOutboxError(
      () => outbox.recordAck(ack, PARAMS.deadlineSeconds),
      'message_dead',
    );
    expectOutboxError(
      () => outbox.markSent(entry.messageKey, PARAMS.deadlineSeconds),
      'message_dead',
    );
    // Re-enqueue of a dead logical message remains idempotent.
    expect(outbox.enqueue(makeInput(), PARAMS.deadlineSeconds + 1).status).toBe('dead');
  });

  it('recordAck rejects a live entry once its deadline has passed even unswept', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    expectOutboxError(
      () => outbox.recordAck(ack, PARAMS.deadlineSeconds),
      'message_dead',
    );
  });

  it('expireOverdue leaves acked and live entries untouched', () => {
    const outbox = makeOutbox();
    const acked = outbox.enqueue(makeInput(), 0);
    outbox.recordAck(signAck(RECIPIENT_SECKEY, acked.messageKey, WRAP_ID_A), 1);
    const live = outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 9_990);
    const buried = outbox.expireOverdue(10_500);
    expect(buried).toEqual([]);
    expect(outbox.getEntry(acked.messageKey)?.status).toBe('acked');
    expect(outbox.getEntry(live.messageKey)?.status).toBe('queued');
  });
});

describe('Court outbox signed acknowledgements', () => {
  it('accepts a valid recipient-signed ack and stops scheduling retries', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    outbox.markSent(entry.messageKey, 0);

    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    const result = outbox.recordAck(ack, 5);
    expect(result.status).toBe('acked');
    expect(result.ackedAt).toBe(5);
    expect(result.ackEventId).toBe(ack.id);
    expect(outbox.dueEntries(1_000)).toHaveLength(0);
  });

  it('is idempotent for a second valid ack of the same message', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const first = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    outbox.recordAck(first, 5);
    const second = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A, { created_at: 600 });
    const result = outbox.recordAck(second, 6);
    expect(result.status).toBe('acked');
    expect(result.ackEventId).toBe(first.id);
  });

  it('returns idempotently for an authentic re-ack after the deadline', () => {
    // Relays legitimately re-serve addressable (kind 39008) acks long after
    // the delivery deadline; an authentic duplicate for an already-acked
    // entry is never a fault.
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const first = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    outbox.recordAck(first, 5);

    const late = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A, {
      created_at: PARAMS.deadlineSeconds + 500,
    });
    const result = outbox.recordAck(late, PARAMS.deadlineSeconds + 500);
    expect(result.status).toBe('acked');
    expect(result.ackEventId).toBe(first.id);
  });

  it('rejects acks for unknown logical messages', () => {
    const outbox = makeOutbox();
    outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, 'dd'.repeat(32), WRAP_ID_A);
    expectOutboxError(() => outbox.recordAck(ack, 1), 'unknown_message');
  });

  it('rejects acks with invalid signatures', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    // Tamper via JSON (as a forged event would arrive from a relay): the
    // nostr-tools verified-symbol cache must not launder a modified event.
    const tampered = JSON.parse(JSON.stringify(ack)) as NostrEvent;
    tampered.content = 'forged';
    expectOutboxError(() => outbox.recordAck(tampered, 1), 'ack_invalid_signature');
    const badSig = JSON.parse(JSON.stringify(ack)) as NostrEvent;
    badSig.sig = '00'.repeat(64);
    expectOutboxError(() => outbox.recordAck(badSig, 1), 'ack_invalid_signature');
  });

  it('does not trust the nostr-tools verified-symbol cache on tampered spreads', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);
    // Object spreads preserve symbol keys, so this forged event still carries
    // finalizeEvent's cached verification marker.
    const forged = { ...ack, content: 'forged' };
    expectOutboxError(() => outbox.recordAck(forged, 1), 'ack_invalid_signature');
  });

  it('rejects acks signed by anyone but the addressed recipient', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const ack = signAck(OTHER_SECKEY, entry.messageKey, WRAP_ID_A);
    expectOutboxError(() => outbox.recordAck(ack, 1), 'ack_author_mismatch');
  });

  it('rejects malformed acks', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    const valid = signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A);

    expectOutboxError(() => outbox.recordAck(null, 1), 'malformed');
    expectOutboxError(() => outbox.recordAck({ ...valid, kind: 1 }, 1), 'malformed');
    expectOutboxError(
      () => outbox.recordAck({ ...valid, tags: [['e', WRAP_ID_A]] }, 1),
      'malformed',
    );
    expectOutboxError(
      () => outbox.recordAck({ ...valid, tags: [['m', entry.messageKey]] }, 1),
      'malformed',
    );
    expectOutboxError(
      () =>
        outbox.recordAck(
          { ...valid, tags: [['m', 'not-hex'], ['e', WRAP_ID_A]] },
          1,
        ),
      'malformed',
    );
  });
});

describe('Court outbox snapshot and restore', () => {
  function midLifecycleOutbox(): { outbox: CourtOutbox; key: string } {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    outbox.markSent(entry.messageKey, 0);
    outbox.enqueue(makeInput({ recipientPubkey: OTHER_PUBKEY }), 5);
    return { outbox, key: entry.messageKey };
  }

  it('restores a JSON round-tripped snapshot and continues mid-lifecycle', () => {
    const { outbox, key } = midLifecycleOutbox();
    const restored = CourtOutbox.fromSnapshot(jsonRoundTrip(outbox.snapshot()));

    expect(restored.listEntries()).toHaveLength(2);
    const entry = restored.getEntry(key);
    expect(entry?.status).toBe('sent');
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextRetryAt).toBe(10);
    expect(entry?.wrap.id).toBe(WRAP_ID_A);

    // Retry schedule continues exactly where it left off.
    expect(restored.dueEntries(9)).toHaveLength(1); // the OTHER_PUBKEY entry (due at 5)
    expect(restored.dueEntries(10)).toHaveLength(2);
    const retried = restored.markSent(key, 10);
    expect(retried.nextRetryAt).toBe(30);

    // Dedupe identity survives the restore.
    const rewrapped = restored.enqueue(
      makeInput({ wrap: wrapTemplate(WRAP_ID_B) }),
      11,
    );
    expect(rewrapped.messageKey).toBe(key);
    expect(restored.listEntries()).toHaveLength(2);

    // Acks still verify against the restored recipient binding.
    const ack = signAck(RECIPIENT_SECKEY, key, WRAP_ID_A);
    expect(restored.recordAck(ack, 12).status).toBe('acked');
  });

  it('snapshot output is JSON-safe and deeply copied', () => {
    const { outbox, key } = midLifecycleOutbox();
    const snapshot = outbox.snapshot();
    const raw = JSON.parse(JSON.stringify(snapshot)) as CourtOutboxSnapshot;
    (raw.entries[0].wrap.tags[0] as string[])[1] = 'ff'.repeat(32);
    expect(outbox.getEntry(key)?.wrap.tags[0][1]).toBe(RECIPIENT_PUBKEY);
  });

  it('rejects corrupt snapshots', () => {
    const { outbox } = midLifecycleOutbox();
    const valid = () => jsonRoundTrip(outbox.snapshot()) as {
      version: number;
      params: Record<string, number>;
      entries: Record<string, unknown>[];
    };

    expectOutboxError(() => CourtOutbox.fromSnapshot(null), 'corrupt_snapshot');
    expectOutboxError(() => CourtOutbox.fromSnapshot('garbage'), 'corrupt_snapshot');

    const wrongVersion = valid();
    wrongVersion.version = 2;
    expectOutboxError(() => CourtOutbox.fromSnapshot(wrongVersion), 'corrupt_snapshot');

    const badParams = valid();
    badParams.params = { initialRetrySeconds: 50, maxRetrySeconds: 10, deadlineSeconds: 100 };
    expectOutboxError(() => CourtOutbox.fromSnapshot(badParams), 'corrupt_snapshot');

    const tamperedKey = valid();
    tamperedKey.entries[0].messageKey = 'ee'.repeat(32);
    expectOutboxError(() => CourtOutbox.fromSnapshot(tamperedKey), 'corrupt_snapshot');

    const tamperedStatus = valid();
    tamperedStatus.entries[0].status = 'delivered';
    expectOutboxError(() => CourtOutbox.fromSnapshot(tamperedStatus), 'corrupt_snapshot');

    const queuedWithAttempts = valid();
    queuedWithAttempts.entries[1].status = 'queued';
    queuedWithAttempts.entries[1].attempts = 3;
    expectOutboxError(() => CourtOutbox.fromSnapshot(queuedWithAttempts), 'corrupt_snapshot');

    const ackedWithoutAckFields = valid();
    ackedWithoutAckFields.entries[0].status = 'acked';
    expectOutboxError(
      () => CourtOutbox.fromSnapshot(ackedWithoutAckFields),
      'corrupt_snapshot',
    );

    const duplicated = valid();
    duplicated.entries = [duplicated.entries[0], duplicated.entries[0]];
    expectOutboxError(() => CourtOutbox.fromSnapshot(duplicated), 'corrupt_snapshot');

    const badWrap = valid();
    (badWrap.entries[0].wrap as Record<string, unknown>).sig = 'xx';
    expectOutboxError(() => CourtOutbox.fromSnapshot(badWrap), 'corrupt_snapshot');
  });

  it('rejects snapshots that move deadlines or resurrect dead messages', () => {
    const { outbox, key } = midLifecycleOutbox();
    outbox.expireOverdue(PARAMS.deadlineSeconds); // bury the sent entry as dead
    const valid = () => jsonRoundTrip(outbox.snapshot()) as {
      version: number;
      params: Record<string, number>;
      entries: Record<string, unknown>[];
    };

    // Resurrection attempt: dead -> sent with a deadline pushed forward.
    const resurrected = valid();
    const victim = resurrected.entries.find((entry) => entry.messageKey === key)!;
    victim.status = 'sent';
    victim.attempts = 1;
    victim.lastSentAt = victim.enqueuedAt;
    victim.nextRetryAt = victim.enqueuedAt;
    victim.deadline = (victim.enqueuedAt as number) + 1_000_000;
    expectOutboxError(() => CourtOutbox.fromSnapshot(resurrected), 'corrupt_snapshot');

    // The honest form of the same entry restores as dead and stays dead.
    const honest = CourtOutbox.fromSnapshot(valid());
    expect(honest.getEntry(key)?.status).toBe('dead');
    expectOutboxError(
      () => honest.recordAck(signAck(RECIPIENT_SECKEY, key, WRAP_ID_A), PARAMS.deadlineSeconds + 1),
      'message_dead',
    );
  });

  it('rejects self-asserted acked state without a re-verifiable ack event', () => {
    const outbox = makeOutbox();
    const entry = outbox.enqueue(makeInput(), 0);
    outbox.markSent(entry.messageKey, 0);
    outbox.recordAck(signAck(RECIPIENT_SECKEY, entry.messageKey, WRAP_ID_A), 5);

    const valid = () => jsonRoundTrip(outbox.snapshot()) as {
      version: number;
      params: Record<string, number>;
      entries: Record<string, unknown>[];
    };

    // Honest acked snapshot restores.
    expect(
      CourtOutbox.fromSnapshot(valid()).getEntry(entry.messageKey)?.status,
    ).toBe('acked');

    // Dropping the ack event makes the acked state self-asserted.
    const dropped = valid();
    delete dropped.entries[0].ackEvent;
    expectOutboxError(() => CourtOutbox.fromSnapshot(dropped), 'corrupt_snapshot');

    // A forged ack event fails signature re-verification.
    const forged = valid();
    const forgedAck = forged.entries[0].ackEvent as Record<string, unknown>;
    forgedAck.content = 'forged';
    expectOutboxError(() => CourtOutbox.fromSnapshot(forged), 'corrupt_snapshot');

    // An ack event for a different message does not bind to this entry.
    const otherOutbox = makeOutbox();
    const otherEntry = otherOutbox.enqueue(
      makeInput({ recipientPubkey: OTHER_PUBKEY }),
      0,
    );
    const otherAcked = valid();
    otherAcked.entries[0].ackEvent = JSON.parse(
      JSON.stringify(signAck(RECIPIENT_SECKEY, otherEntry.messageKey, WRAP_ID_A)),
    );
    expectOutboxError(() => CourtOutbox.fromSnapshot(otherAcked), 'corrupt_snapshot');
  });
});

describe('Court outbox storage integration', () => {
  it('persists snapshots and reloads them through injected storage', async () => {
    const storage = new MemoryStorage();
    const outbox = createCourtOutbox({ ...PARAMS, storage });
    const entry = outbox.enqueue(makeInput(), 0);
    outbox.markSent(entry.messageKey, 0);
    await outbox.persist();

    const loaded = await CourtOutbox.load(storage);
    expect(loaded).not.toBeNull();
    expect(loaded?.getEntry(entry.messageKey)?.status).toBe('sent');
    expect(loaded?.snapshot()).toEqual(outbox.snapshot());
  });

  it('returns null when no snapshot was ever persisted', async () => {
    const storage = new MemoryStorage();
    expect(await CourtOutbox.load(storage)).toBeNull();
  });

  it('surfaces a corrupted store as corrupt_snapshot', async () => {
    const storage = new MemoryStorage();
    storage.data = { version: 1, params: PARAMS, entries: [{ bogus: true }] };
    await expect(CourtOutbox.load(storage)).rejects.toMatchObject({
      name: 'CourtOutboxError',
      code: 'corrupt_snapshot',
    });
  });

  it('supports asynchronous storage hosts', async () => {
    let stored: unknown;
    const storage: OutboxStorage = {
      load: () => Promise.resolve(stored),
      save: (snapshot: CourtOutboxSnapshot) => {
        stored = jsonRoundTrip(snapshot);
        return Promise.resolve();
      },
    };
    const outbox = createCourtOutbox({ ...PARAMS, storage });
    outbox.enqueue(makeInput(), 0);
    await outbox.persist();
    const loaded = await CourtOutbox.load(storage);
    expect(loaded?.listEntries()).toHaveLength(1);
  });
});
