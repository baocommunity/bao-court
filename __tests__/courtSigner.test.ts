// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { nip59 } from 'nostr-tools';
import { getEventHash } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  SeckeyCourtSigner,
  Nip44SignerCrypto,
  unwrapProtocolEventsWithSigner,
  unwrapProtocolEventWithSigner,
  wrapProtocolEventWithSigner,
  type CourtEventSigner,
} from '../courtSigner';
import { Nip44SeckeyCrypto } from '../nip44Crypto';
import { unwrapProtocolEvent, wrapProtocolEvent } from '../nip59';

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

/**
 * Simulates an external signer (NIP-07/NIP-46): every call is async and the
 * secret key never leaves the object. Proves the Court transport path works
 * against the narrow signer surface only.
 */
class MockBunkerSigner implements CourtEventSigner {
  private readonly inner: SeckeyCourtSigner;

  constructor(seckey: string) {
    this.inner = new SeckeyCourtSigner(seckey);
  }

  private async delay(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async getPublicKey(): Promise<string> {
    await this.delay();
    return this.inner.getPublicKey();
  }

  async signEvent(
    template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
  ): Promise<NostrEvent> {
    await this.delay();
    return this.inner.signEvent(template);
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    await this.delay();
    return this.inner.nip44Encrypt(peerPubkey, plaintext);
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    await this.delay();
    return this.inner.nip44Decrypt(peerPubkey, ciphertext);
  }
}

describe('signer-backed private transport', () => {
  it('round-trips a gift wrap between two external signers', async () => {
    const bunkerAlice = new MockBunkerSigner(ALICE_SECKEY);
    const bunkerBob = new MockBunkerSigner(BOB_SECKEY);

    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, bunkerAlice, BOB_PUB);
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toContainEqual(['p', BOB_PUB]);

    const rumor = await unwrapProtocolEventWithSigner(wrap, bunkerBob);
    expect(rumor).not.toBeNull();
    expect(rumor!.kind).toBe(TEMPLATE.kind);
    expect(rumor!.content).toBe(TEMPLATE.content);
    expect(rumor!.tags).toEqual(TEMPLATE.tags);
    expect(rumor!.pubkey).toBe(ALICE_PUB);
  });

  it('interoperates with the legacy seckey helpers in both directions', async () => {
    // signer wrap -> legacy unwrap
    const wrapFromSigner = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const legacyUnwrapped = unwrapProtocolEvent(wrapFromSigner, BOB_SECKEY);
    expect(legacyUnwrapped).not.toBeNull();
    expect(legacyUnwrapped!.content).toBe(TEMPLATE.content);
    expect(legacyUnwrapped!.pubkey).toBe(ALICE_PUB);

    // legacy wrap -> signer unwrap
    const legacyWrap = wrapProtocolEvent(TEMPLATE, ALICE_SECKEY, BOB_PUB);
    const signerUnwrapped = await unwrapProtocolEventWithSigner(legacyWrap, bob);
    expect(signerUnwrapped).not.toBeNull();
    expect(signerUnwrapped!.content).toBe(TEMPLATE.content);
  });

  it('adapts a signer to the Nip44Crypto interface', async () => {
    const aliceCrypto = new Nip44SignerCrypto(new MockBunkerSigner(ALICE_SECKEY));
    const ciphertext = await aliceCrypto.encrypt('secret share', BOB_PUB);
    const bobCrypto = new Nip44SignerCrypto(new MockBunkerSigner(BOB_SECKEY));
    await expect(bobCrypto.decrypt(ciphertext, ALICE_PUB)).resolves.toBe('secret share');
  });

  it('rejects wraps not addressed to the recipient', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    await expect(unwrapProtocolEventWithSigner(wrap, carol)).resolves.toBeNull();
  });

  it('rejects malformed, corrupted, and wrong-kind wraps', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);

    await expect(
      unwrapProtocolEventWithSigner({ ...wrap, kind: 13 }, bob),
    ).resolves.toBeNull();

    const corrupted = { ...wrap, content: wrap.content.slice(0, -4) + 'AAAA' };
    await expect(unwrapProtocolEventWithSigner(corrupted, bob)).resolves.toBeNull();
  });

  it('rejects a seal signed by anyone but the rumor author', async () => {
    // Attacker (Carol) forges a rumor claiming Alice's pubkey, seals it with
    // her own key, and wraps it to Bob. NIP-59 requires seal.pubkey ===
    // rumor.pubkey.
    const forgedRumor = {
      ...TEMPLATE,
      pubkey: ALICE_PUB,
    } as NostrEvent;
    forgedRumor.id = getEventHash(forgedRumor);
    const sealContent = await carol.nip44Encrypt(BOB_PUB, JSON.stringify(forgedRumor));
    const seal = await carol.signEvent({
      kind: 13,
      content: sealContent,
      created_at: 1_750_000_000,
      tags: [],
    });
    const wrap = nip59.createWrap(seal, BOB_PUB) as NostrEvent;

    await expect(unwrapProtocolEventWithSigner(wrap, bob)).resolves.toBeNull();
  });

  it('rejects a rumor whose id does not commit to its contents', async () => {
    // Alice builds a valid wrap; we re-seal a tampered rumor (valid seal
    // signature, but the rumor id no longer matches its contents).
    const validWrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const validRumor = await unwrapProtocolEventWithSigner(validWrap, bob);
    expect(validRumor).not.toBeNull();

    const tamperedRumor = { ...validRumor!, content: '{"share":"attacker"}' };
    const sealContent = await alice.nip44Encrypt(BOB_PUB, JSON.stringify(tamperedRumor));
    const seal = await alice.signEvent({
      kind: 13,
      content: sealContent,
      created_at: 1_750_000_000,
      tags: [],
    });
    const wrap = nip59.createWrap(seal, BOB_PUB) as NostrEvent;

    await expect(unwrapProtocolEventWithSigner(wrap, bob)).resolves.toBeNull();
  });

  it('rejects a seal with an invalid signature', async () => {
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    // Decrypt the wrap layer as Bob, corrupt the seal signature, re-wrap.
    const sealJson = await bob.nip44Decrypt(wrap.pubkey, wrap.content);
    const seal = JSON.parse(sealJson) as NostrEvent;
    seal.sig = seal.sig.replace(/.$/, seal.sig.endsWith('0') ? '1' : '0');
    const rewrapped = nip59.createWrap(seal, BOB_PUB) as NostrEvent;

    await expect(unwrapProtocolEventWithSigner(rewrapped, bob)).resolves.toBeNull();
  });

  it('deduplicates and filters batch unwraps like the legacy helper', async () => {
    const shareWrap = await wrapProtocolEventWithSigner(TEMPLATE, alice, BOB_PUB);
    const otherKind = await wrapProtocolEventWithSigner(
      { ...TEMPLATE, kind: 32999 },
      alice,
      BOB_PUB,
    );
    const otherDispute = await wrapProtocolEventWithSigner(
      { ...TEMPLATE, tags: [['dispute', 'dispute-2']] },
      alice,
      BOB_PUB,
    );

    const all = await unwrapProtocolEventsWithSigner(
      [shareWrap, shareWrap, otherKind, otherDispute],
      bob,
    );
    expect(all).toHaveLength(3);

    const sharesOnly = await unwrapProtocolEventsWithSigner(
      [shareWrap, otherKind, otherDispute],
      bob,
      { kinds: [TEMPLATE.kind], disputeId: 'dispute-1' },
    );
    expect(sharesOnly).toHaveLength(1);
    expect(sharesOnly[0].content).toBe(TEMPLATE.content);
  });

  it('rejects invalid recipient pubkeys at wrap time', async () => {
    await expect(
      wrapProtocolEventWithSigner(TEMPLATE, alice, 'not-a-pubkey'),
    ).rejects.toThrow(/hex/);
  });
});

describe('secret-key boundary copies', () => {
  it('SeckeyCourtSigner copies caller buffers: later mutation cannot corrupt it', async () => {
    const buffer = hexToBytes(ALICE_SECKEY);
    const signer = new SeckeyCourtSigner(buffer);
    // Zeroizing/mutating the caller's buffer after construction must not
    // change (or "destroy") the signer.
    buffer.fill(0);
    expect(signer.getPublicKey()).toBe(ALICE_PUB);
    const wrap = await wrapProtocolEventWithSigner(TEMPLATE, signer, BOB_PUB);
    const [unwrapped] = await unwrapProtocolEventsWithSigner([wrap], bob);
    expect(unwrapped.content).toBe(TEMPLATE.content);
  });

  it('Nip44SeckeyCrypto copies caller buffers: later mutation cannot corrupt it', () => {
    const buffer = hexToBytes(ALICE_SECKEY);
    const crypto = new Nip44SeckeyCrypto(buffer);
    buffer.fill(0xff);
    const ciphertext = crypto.encrypt('boundary-check', BOB_PUB);
    const reference = new Nip44SeckeyCrypto(ALICE_SECKEY);
    expect(crypto.decrypt(ciphertext, BOB_PUB)).toBe('boundary-check');
    expect(reference.decrypt(ciphertext, BOB_PUB)).toBe('boundary-check');
  });

  it('rejects seckey buffers that are not 32 bytes', () => {
    expect(() => new SeckeyCourtSigner(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => new Nip44SeckeyCrypto(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});
