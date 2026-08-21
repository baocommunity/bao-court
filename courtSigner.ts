// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Signer-backed private transport for BAO Court protocol messages.
 *
 * Every private Court message (DKG shares, complaints, backups, refresh
 * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
 * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
 * process memory. This module provides the same capabilities through a
 * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
 * signers, hardware-backed agents) so production jurors never expose an
 * `nsec` to the Court host.
 *
 * The signer surface is intentionally narrow: public key, event signing, and
 * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
 * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
 * `nip44_decrypt`).
 *
 * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
 * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
 * seal author equals the rumor author, and recomputes the rumor id. A gift
 * wrap that fails any check is rejected (returns null), never partially
 * trusted.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';
import { nip59 } from 'nostr-tools';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
import {
  assertUnwrapBatchSize,
  filterUnwrappedRumors,
  type UnwrapFilterOptions,
} from './courtUnwrapCore';

const SEAL_KIND = 13;
const GIFT_WRAP_KIND = 1059;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

const HEX_64 = /^[0-9a-f]{64}$/;

/** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
function randomNowSeconds(): number {
  return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
}

function assertHex64(value: string, label: string): void {
  if (!HEX_64.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase hex string`);
  }
}

/**
 * Minimal external signer surface required for Court private transport.
 * Implementations MUST NOT expose the secret key.
 */
export interface CourtEventSigner {
  /** The signer's x-only public key (64-char hex). */
  getPublicKey(): Promise<string> | string;
  /** Sign an event template; the signer fills pubkey, id, and sig. */
  signEvent(
    template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
  ): Promise<NostrEvent>;
  /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}

/**
 * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
 * signer-backed keys work everywhere the Court already accepts encryption
 * providers (DKG sessions, backups, complaints).
 */
export class Nip44SignerCrypto implements Nip44Crypto {
  constructor(private readonly signer: CourtEventSigner) {}

  encrypt(plaintext: string, peerPubkey: string): Promise<string> {
    assertHex64(peerPubkey, 'peer pubkey');
    return this.signer.nip44Encrypt(peerPubkey, plaintext);
  }

  decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
    assertHex64(peerPubkey, 'peer pubkey');
    return this.signer.nip44Decrypt(peerPubkey, ciphertext);
  }
}

/**
 * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
 * demo rooms, and local tooling — production jurors should use a real
 * external signer. Keeping this adapter means the entire private-transport
 * stack has exactly one code path regardless of key custody.
 */
export class SeckeyCourtSigner implements CourtEventSigner {
  private readonly seckey: Uint8Array;
  private readonly crypto: Nip44SeckeyCrypto;

  constructor(seckey: string | Uint8Array) {
    // Copy at the boundary: caller-supplied buffers must never alias our
    // secret, or later mutation/zeroization of the source silently corrupts
    // (or "destroys") this signer.
    this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
    if (this.seckey.length !== 32) {
      throw new Error('seckey must be 32 bytes');
    }
    this.crypto = new Nip44SeckeyCrypto(this.seckey);
  }

  getPublicKey(): string {
    return getPublicKey(this.seckey);
  }

  signEvent(
    template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
  ): Promise<NostrEvent> {
    return Promise.resolve(finalizeEvent(template, this.seckey));
  }

  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
  }

  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
 * recipient, using only the signer's public methods. The sender's secret key
 * never enters this process; the outer wrap's ephemeral key is generated
 * locally per wrap (it is random by design and protects nothing long-term).
 */
export async function wrapProtocolEventWithSigner(
  event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
  signer: CourtEventSigner,
  recipientPubkey: string,
): Promise<NostrEvent> {
  assertHex64(recipientPubkey, 'recipient pubkey');
  const senderPubkey = await signer.getPublicKey();
  assertHex64(senderPubkey, 'signer pubkey');

  // Rumor: unsigned, id commits to author + content.
  const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
  rumor.id = getEventHash(rumor as NostrEvent);

  // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
  // through the external signer.
  // Re-use the same seal content that was verified during unwrap to ensure
  // the wrap's seal matches exactly what the original signer produced.
  const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  const seal = await signer.signEvent({
    kind: SEAL_KIND,
    content: sealContent,
    created_at: randomNowSeconds(),
    tags: [],
  });
  // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
  // their verdict in a non-JSON-enumerable symbol that object spreads
  // preserve, so a malicious signer returning a once-valid seal it then
  // tampered with must never reach the verifier with the cached verdict
  // attached.
  // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
  // their verdict in a non-JSON-enumerable symbol that object spreads
  // preserve, so a malicious signer returning a once-valid seal it then
  // tampered with must never reach the verifier with the cached verdict
  // attached.
  const sealCandidate: NostrEvent = {
    id: seal.id,
    pubkey: seal.pubkey,
    sig: seal.sig,
    kind: seal.kind,
    created_at: seal.created_at,
    content: seal.content,
    tags: seal.tags,
  } as NostrEvent;
  if (
    sealCandidate.kind !== SEAL_KIND
    || sealCandidate.pubkey !== senderPubkey
    || !verifyEvent(sealCandidate)
  ) {
    throw new Error('external signer returned an invalid NIP-59 seal');
  }

  // Wrap: kind 1059 under a locally generated ephemeral key.
  return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
}

/**
 * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
 * full NIP-59 verification. Returns the inner rumor, or null if any layer is
 * malformed, misaddressed, forged, or tampered with.
 */
export async function unwrapProtocolEventWithSigner(
  wrapEvent: NostrEvent,
  signer: CourtEventSigner,
): Promise<NostrEvent | null> {
  try {
    // Verify a reconstructed outer event before trusting its id as durable
    // provenance. Reconstructing also avoids nostr-tools' cached verification
    // verdict on an event object that may have been mutated after validation
    // (the same pattern used for the seal below).
    const wrapCandidate: NostrEvent = {
      id: wrapEvent.id,
      pubkey: wrapEvent.pubkey,
      sig: wrapEvent.sig,
      kind: wrapEvent.kind,
      created_at: wrapEvent.created_at,
      content: wrapEvent.content,
      tags: wrapEvent.tags.map((tag) => [...tag]),
    } as NostrEvent;
    if (wrapCandidate.kind !== GIFT_WRAP_KIND || !verifyEvent(wrapCandidate)) return null;
    const recipientPubkey = await signer.getPublicKey();
    const addressed = wrapCandidate.tags.some(
      (t) => t[0] === 'p' && t[1] === recipientPubkey,
    );
    if (!addressed) return null;

    const sealJson = await signer.nip44Decrypt(wrapCandidate.pubkey, wrapCandidate.content);
    const seal: unknown = JSON.parse(sealJson);
    if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
    const sealEvent = seal as unknown as NostrEvent;
    if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;

    const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
    const rumor: unknown = JSON.parse(rumorJson);
    if (!isRecord(rumor)) return null;
    const rumorEvent = rumor as unknown as NostrEvent;

    // NIP-59: the seal must be signed by the rumor's author, and the rumor id
    // must commit to its exact contents.
    if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
    if (typeof rumorEvent.id !== 'string') return null;
    if (getEventHash(rumorEvent) !== rumorEvent.id) return null;

    return rumorEvent;
  } catch {
    return null;
  }
}

/**
 * Unwrap many gift wraps with a signer and filter to a specific inner kind
 * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
 * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
 */
export async function unwrapProtocolEventsWithSigner(
  wraps: readonly NostrEvent[],
  signer: CourtEventSigner,
  options?: UnwrapFilterOptions,
): Promise<NostrEvent[]> {
  assertUnwrapBatchSize(wraps.length);
  const rumors: (NostrEvent | null)[] = [];
  for (const wrap of wraps) {
    rumors.push(await unwrapProtocolEventWithSigner(wrap, signer));
  }
  return filterUnwrappedRumors(rumors, options);
}

/** Generate a fresh random secret key (hex) — for tests and demo rooms. */
export function generateCourtSeckeyHex(): string {
  return bytesToHex(generateSecretKey());
}
