// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';

/**
 * Abstract NIP-44 encryption provider.
 *
 * Implementations may be backed by a raw secret key (e.g. nsec stored locally)
 * or by an external signer such as a browser extension or NIP-46 bunker that
 * never exposes the private key.
 */
export interface Nip44Crypto {
  encrypt(plaintext: string, peerPubkey: string): Promise<string> | string;
  decrypt(ciphertext: string, peerPubkey: string): Promise<string> | string;
}

function normalizeSeckey(seckey: string | Uint8Array): Uint8Array {
  // Copy at the boundary so caller-held buffers never alias our secret.
  const bytes = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
  if (bytes.length !== 32) {
    throw new Error('seckey must be 32 bytes');
  }
  return bytes;
}

/**
 * NIP-44 crypto implementation backed by a raw 32-byte secret key.
 */
export class Nip44SeckeyCrypto implements Nip44Crypto {
  private readonly seckey: Uint8Array;

  constructor(seckey: string | Uint8Array) {
    this.seckey = normalizeSeckey(seckey);
  }

  encrypt(plaintext: string, peerPubkey: string): string {
    const conversationKey = nip44.getConversationKey(this.seckey, peerPubkey);
    return nip44.encrypt(plaintext, conversationKey);
  }

  decrypt(ciphertext: string, peerPubkey: string): string {
    const conversationKey = nip44.getConversationKey(this.seckey, peerPubkey);
    return nip44.decrypt(ciphertext, conversationKey);
  }
}
