// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Keypair fixtures for the Court test suite.
 *
 * TWO flavors, and the choice matters:
 *
 * 1. DETERMINISTIC (default): `seckey(byte)` builds a 32-byte secret from a
 *    single byte (`seckey(3)` = `0000…03`), so a fixture's key is readable
 *    from its call site and a failure is reproducible with zero recorded
 *    state. This is the JSDOM-SAFE variant: it touches no CSPRNG at all —
 *    no `crypto.getRandomValues`, no `node:crypto` — so it behaves
 *    identically in plain Node vitest, browser/jsdom environments, and
 *    older WebViews where the platform CSPRNG is unavailable or polyfilled.
 *    Prefer it everywhere a key doesn't need to be unique.
 *
 * 2. CSPRNG-backed: `schnorrKeypair()` / `schnorrKeypairHex()` draw 32 random
 *    bytes (`node:crypto.randomBytes`) for tests whose assertions need keys
 *    to be unique/unpredictable (attestation batches, signer sets). These
 *    require a Node-flavored environment — under jsdom they depend on the
 *    `crypto` global being present. Keep them out of generator-driven
 *    property tests (see `rng.ts`).
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';

/** Deterministic 32-byte seckey with `byte` in the last position (jsdom-safe, no CSPRNG). */
export function seckey(byte: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = byte;
  return value;
}

/** Deterministic x-only Nostr pubkey (64-char hex) for `seckey(byte)`. */
export function nostrPubkey(byte: number): string {
  return bytesToHex(schnorr.getPublicKey(seckey(byte)));
}

/** Deterministic compressed (33-byte) host pubkey for `seckey(byte)`. */
export function hostPubkey(byte: number): string {
  return bytesToHex(secp256k1.getPublicKey(seckey(byte), true));
}

/** A fresh CSPRNG schnorr keypair: `{ sec: Uint8Array, pub: x-only hex }`. */
export function schnorrKeypair(): { sec: Uint8Array; pub: string } {
  const sec = randomBytes(32);
  return { sec, pub: bytesToHex(schnorr.getPublicKey(sec)) };
}

/** A fresh CSPRNG schnorr keypair with the seckey as hex (for hex-keyed APIs). */
export function schnorrKeypairHex(): { sec: string; pub: string } {
  const sec = bytesToHex(randomBytes(32));
  return { sec, pub: bytesToHex(schnorr.getPublicKey(hexToBytes(sec))) };
}
