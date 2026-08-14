// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

import {
  wrapProtocolEvent,
  unwrapProtocolEvent,
  unwrapProtocolEvents,
  getPubkeyFromSeckey,
} from '../nip59';

describe('NIP-59 helpers', () => {
  const senderSeckey = generateSecretKey();
  const senderPubkey = getPublicKey(senderSeckey);
  const recipientSeckey = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSeckey);

  it('wraps and unwraps a protocol event', () => {
    const inner = {
      kind: 39003,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['dispute', 'd'.repeat(64)]],
      content: JSON.stringify({ encryptedShare: 'secret' }),
    };

    const wrap = wrapProtocolEvent(inner, senderSeckey, recipientPubkey);
    expect(wrap.kind).toBe(1059);

    const unwrapped = unwrapProtocolEvent(wrap as ReturnType<typeof finalizeEvent>, recipientSeckey);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped?.kind).toBe(39003);
    expect(unwrapped?.pubkey).toBe(senderPubkey);
    expect(unwrapped?.content).toBe(inner.content);
  });

  it('returns null for invalid wraps', () => {
    const fakeWrap = {
      kind: 1059,
      pubkey: 'a'.repeat(64),
      created_at: 0,
      tags: [['p', recipientPubkey]],
      content: 'not-valid-nip44',
      id: 'x',
      sig: 'x',
    };
    expect(unwrapProtocolEvent(fakeWrap, recipientSeckey)).toBeNull();
  });

  it('filters unwrapped events by kind and dispute', () => {
    const disputeId = 'd'.repeat(64);
    const inner = {
      kind: 39003,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['dispute', disputeId]],
      content: JSON.stringify({ encryptedShare: 'secret' }),
    };

    const wrap = wrapProtocolEvent(inner, senderSeckey, recipientPubkey);

    const rumors = unwrapProtocolEvents([wrap], recipientSeckey, {
      kinds: [39003],
      disputeId,
    });
    expect(rumors).toHaveLength(1);

    const wrongKind = unwrapProtocolEvents([wrap], recipientSeckey, {
      kinds: [39004],
      disputeId,
    });
    expect(wrongKind).toHaveLength(0);

    const wrongDispute = unwrapProtocolEvents([wrap], recipientSeckey, {
      kinds: [39003],
      disputeId: 'x'.repeat(64),
    });
    expect(wrongDispute).toHaveLength(0);
  });

  it('derives a pubkey from a secret key', () => {
    expect(getPubkeyFromSeckey(senderSeckey)).toBe(senderPubkey);
  });
});
