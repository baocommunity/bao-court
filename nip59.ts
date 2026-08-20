// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * NIP-59 gift-wrap helpers for BAO Court encrypted peer-to-peer messages.
 *
 * NIP-59 wraps an inner "rumor" event inside a seal (kind 13) and then inside
 * a gift wrap (kind 1059). Only the recipient can unwrap both layers. The inner
 * rumor retains its original `pubkey`, `kind`, `tags`, and `content`.
 *
 * HARDENED 2026-08-15: the unwrap helpers are now STRICT. The stock nostr-tools
 * `nip59.unwrapEvent` performed two NIP-44 decrypts and nothing else — an
 * attacker could mint gift wraps whose (unverified) seal and rumor content, id,
 * and pubkey were entirely arbitrary, and the helper returned them as if they
 * were legitimate mail. These helpers now mirror `courtSigner.ts`
 * (`unwrapProtocolEventWithSigner`) gate for gate: the recipient `p` tag, the
 * seal's Schnorr signature, the seal-author === rumor-author binding, and the
 * rumor-id commitment are all verified before a rumor is returned. Anything
 * that fails any check returns null — never partially trusted mail.
 */

import { nip44, nip59, getPublicKey } from 'nostr-tools';
import { verifyEvent, getEventHash } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';

const SEAL_KIND = 13;
const GIFT_WRAP_KIND = 1059;

function seckeyBytes(seckey: Uint8Array | string): Uint8Array {
  return typeof seckey === 'string' ? hexToBytes(seckey) : seckey;
}

/** Normalize a recipient pubkey to 32-byte x-only hex (strips 02/03 prefix). */
function xOnlyPubkeyHex(pubkeyHex: string): string {
  if (/^[0-9a-fA-F]{66}$/.test(pubkeyHex) && /^0[23]/.test(pubkeyHex)) {
    return pubkeyHex.slice(2);
  }
  return pubkeyHex;
}

function nip59Decrypt(ciphertext: string, seckey: Uint8Array, peerPubkey: string): unknown {
  const conversationKey = nip44.getConversationKey(seckey, peerPubkey);
  return JSON.parse(nip44.decrypt(ciphertext, conversationKey));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Rebuild a plain object from a Nostr event's fields so verification never
 * runs over a spread/signer-returned object that may carry nostr-tools'
 * cached `verifiedSymbol` verdict.
 */
function reconstructPlain(event: NostrEvent): NostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: (event.tags ?? []).map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  } as NostrEvent;
}

/**
 * Wrap a protocol event template as a NIP-59 gift wrap addressed to a recipient.
 *
 * @param event The inner event template (kind, tags, content). `pubkey` and
 *   `created_at` are filled in automatically.
 * @param senderSeckey 32-byte sender private key in hex.
 * @param recipientPubkeyHex Recipient public key in hex (32-byte x-only;
 *   33-byte compressed keys are normalized to x-only).
 * @returns A kind 1059 gift-wrap event that is ALREADY SIGNED with an
 *   ephemeral key. Broadcast it as-is — do NOT re-sign it (re-signing breaks
 *   NIP-44 unwrapping and de-anonymizes the sender).
 */
export function wrapProtocolEvent(
  event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
  senderSeckey: Uint8Array | string,
  recipientPubkeyHex: string,
): NostrEvent {
  // Ordinary NIP-59 wrapping proceeds through the stock library; the unwrap
  // side performs the full verification battery above.
  return nip59.wrapEvent(
    event,
    seckeyBytes(senderSeckey),
    xOnlyPubkeyHex(recipientPubkeyHex),
  ) as NostrEvent;
}

/**
 * Unwrap a kind 1059 gift wrap using the recipient's private key — STRICT.
 *
 * Returns the inner rumor only when every layer verifies:
 *   1. the wrap is a kind 1059 addressed (p-tag) to the recipient;
 *   2. the seal layer decrypts, is a kind 13 event, and carries a valid
 *      Schnorr signature by its author;
 *   3. the rumor layer decrypts, its author equals the seal author, and its
 *      id commits to its exact contents (recomputed, never trusted).
 *
 * Returns null for anything malformed, misaddressed, forged, or tampered
 * with — never a partially trusted event.
 */
export function unwrapProtocolEvent(
  wrapEvent: NostrEvent,
  recipientSeckey: Uint8Array | string,
): NostrEvent | null {
  try {
    if (!isRecord(wrapEvent) || wrapEvent.kind !== GIFT_WRAP_KIND) return null;
    const seckey = seckeyBytes(recipientSeckey);
    const recipientPubkey = getPublicKey(seckey);
    const addressed = (wrapEvent.tags ?? []).some(
      (tag) => tag[0] === 'p' && tag[1] === recipientPubkey,
    );
    if (!addressed) return null;

    // Layer 1: seal (kind 13).
    const sealValue: unknown = nip59Decrypt(wrapEvent.content, seckey, wrapEvent.pubkey);
    if (!isRecord(sealValue)) return null;
    const seal = sealValue as unknown as NostrEvent;
    if (seal.kind !== SEAL_KIND) return null;
    if (!verifyEvent(reconstructPlain(seal))) return null;

    // Layer 2: rumor.
    const rumorValue: unknown = nip59Decrypt(seal.content, seckey, seal.pubkey);
    if (!isRecord(rumorValue)) return null;
    const rumor = rumorValue as unknown as NostrEvent;

    // NIP-59 binding: the seal must be signed by the rumor's author, and the
    // rumor id must commit to its exact contents. (Rumors are intentionally
    // UNSIGNED in NIP-59 — seal signature covers authorship, id covers content.)
    if (typeof rumor.pubkey !== 'string' || rumor.pubkey !== seal.pubkey) return null;
    if (typeof rumor.id !== 'string') return null;
    if (getEventHash(reconstructPlain(rumor)) !== rumor.id) return null;

    return rumor;
  } catch {
    return null;
  }
}

/**
 * Unwrap many gift wraps and filter to a specific inner kind and dispute.
 * Duplicate rumor ids are deduplicated. Every wrap goes through the strict
 * {@link unwrapProtocolEvent} verification battery.
 */
export function unwrapProtocolEvents(
  wraps: readonly NostrEvent[],
  recipientSeckey: Uint8Array | string,
  options?: {
    readonly kinds?: readonly number[];
    readonly disputeId?: string;
  },
): NostrEvent[] {
  const seen = new Set<string>();
  const result: NostrEvent[] = [];

  for (const wrap of wraps) {
    const rumor = unwrapProtocolEvent(wrap, recipientSeckey);
    if (!rumor || !rumor.id) continue;
    if (seen.has(rumor.id)) continue;
    seen.add(rumor.id);

    if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
    // An explicitly supplied filter is always active — an empty-string
    // disputeId must match nothing instead of broadening the result set.
    if (options?.disputeId !== undefined) {
      const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
      if (disputeTag?.[1] !== options.disputeId) continue;
    }

    result.push(rumor);
  }

  return result;
}

/**
 * Derive the sender's public key from their private key.
 */
export function getPubkeyFromSeckey(seckey: Uint8Array | string): string {
  return getPublicKey(seckeyBytes(seckey));
}
