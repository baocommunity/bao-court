// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * NIP-59 gift-wrap helpers for BAO Court encrypted peer-to-peer messages.
 *
 * NIP-59 wraps an inner "rumor" event inside a seal (kind 13) and then inside
 * a gift wrap (kind 1059). Only the recipient can unwrap both layers. The inner
 * rumor retains its original `pubkey`, `kind`, `tags`, and `content`.
 */

import { nip59, getPublicKey } from 'nostr-tools';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';

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
  return nip59.wrapEvent(event, seckeyBytes(senderSeckey), xOnlyPubkeyHex(recipientPubkeyHex)) as NostrEvent;
}

/**
 * Unwrap a kind 1059 gift wrap using the recipient's private key.
 *
 * @param wrapEvent The received kind 1059 event.
 * @param recipientSeckeyHex 32-byte recipient private key in hex.
 * @returns The inner rumor event, or null if decryption fails.
 */
export function unwrapProtocolEvent(
  wrapEvent: NostrEvent,
  recipientSeckey: Uint8Array | string,
): NostrEvent | null {
  try {
    return nip59.unwrapEvent(wrapEvent, seckeyBytes(recipientSeckey)) as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * Unwrap many gift wraps and filter to a specific inner kind and dispute.
 * Duplicate rumor ids are deduplicated.
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
    if (options?.disputeId) {
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
