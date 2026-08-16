// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Low-level cryptographic helpers for the BAO FROST threshold oracle.
 *
 * Browser-compatible: uses @noble/curves and @noble/hashes instead of Node crypto.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const Point = secp256k1.Point;
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as frost from '@vbyte/frost';
import type { PublicNonce } from '@vbyte/frost';

const SCALAR_ORDER = secp256k1.Point.Fn.ORDER;

function modN(x: bigint): bigint {
  const r = x % SCALAR_ORDER;
  return r < 0n ? r + SCALAR_ORDER : r;
}

export function randomHex32(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Derive a non-zero scalar deterministically from a seed and domain info.
 *
 * Uses HKDF-SHA256 with a counter to avoid modulo bias. This is intentionally
 * deterministic: anyone with the same seed + info gets the same scalar. Only
 * use it for demos, tests, or situations where the seed itself is secret.
 */
export function seededScalar(seed: Uint8Array, info: Uint8Array): bigint {
  let counter = 0;
  while (counter < 65536) {
    // Counter serialized big-endian as a full uint16 so it cannot collide
    // with a lower counter after truncation (a single-byte counter would
    // wrap at 256 and starve the rejection loop).
    const counterBytes = new Uint8Array(2);
    new DataView(counterBytes.buffer).setUint16(0, counter, false);
    const okm = hkdf(
      sha256,
      seed,
      new Uint8Array(0),
      new Uint8Array([...info, ...counterBytes]),
      64,
    );
    const s = modN(bytesToNumberBE(okm));
    if (s !== 0n) return s;
    counter++;
  }
  throw new Error('seededScalar: could not derive non-zero scalar');
}

/**
 * Return a uniformly random non-zero scalar in the secp256k1 field.
 *
 * Uses `@noble/curves`'s vetted `randomSecretKey()` implementation, which
 * samples from `[1, n-1]` without modulo bias.
 */
export function randomScalar(): bigint {
  return bytesToNumberBE(secp256k1.utils.randomSecretKey());
}

/** Encode a scalar as a 32-byte zero-padded hex string. */
export function scalarToHex(s: bigint): string {
  return bytesToHex(numberToBytesBE(modN(s), 32));
}

/**
 * Derive the x-only public key from a 32-byte secret key hex string.
 */
export function deriveXOnlyPubkey(seckeyHex: string): string {
  const pk = schnorr.getPublicKey(hexToBytes(seckeyHex));
  return bytesToHex(pk);
}

/**
 * Build the canonical attestation message that all jurors sign.
 */
export function buildAttestationMessage(
  marketId: string,
  outcome: string,
  round: number | string,
  disputeEventId?: string,
): string {
  const parts = [marketId, outcome, String(round)];
  if (disputeEventId) parts.push(disputeEventId);
  return bytesToHex(sha256(new TextEncoder().encode(parts.join('|'))));
}

/**
 * Compute the aggregate group public nonce for a signing round.
 *
 * The binding factors depend on the group pubkey and the message (see
 * `get_group_commit_context` in @vbyte/frost), so both are required for the
 * result to match the nonce that actually ends up in the final signature.
 *
 * Returns the 33-byte compressed group nonce; the x-only `R` value embedded
 * in a final FROST signature is `result.slice(2)`.
 */
export function aggregatePublicNonce(
  pnonces: readonly PublicNonce[],
  groupPubkey: string,
  messageHex: string,
): string {
  // Copy the caller's array: the lib sorts the nonce list in place.
  const sorted = [...pnonces];
  const keyCtx = frost.Lib.get_group_key_context(groupPubkey);
  const prefix = frost.Lib.get_group_prefix(sorted, keyCtx.group_pk, messageHex);
  const binders = frost.Lib.get_group_binders(sorted, prefix);
  return frost.Lib.get_group_pubnonce(sorted, binders);
}

export function verifyFinalSignature(
  groupPubkey: string,
  messageHex: string,
  signatureHex: string,
): boolean {
  const keyCtx = frost.Lib.get_group_key_context(groupPubkey);
  return frost.Lib.verify_final_sig(
    keyCtx,
    hexToBytes(messageHex),
    hexToBytes(signatureHex),
  );
}

export function verifySchnorr(
  pubkeyHex: string,
  messageHex: string,
  signatureHex: string,
): boolean {
  try {
    return schnorr.verify(
      hexToBytes(signatureHex),
      hexToBytes(messageHex),
      hexToBytes(pubkeyHex),
    );
  } catch {
    return false;
  }
}

export interface DkgProofOfKnowledge {
  /** Public nonce R = r*G in hex (compressed). */
  readonly nonce: string;
  /** Response z = r + e*secret in hex (32-byte scalar). */
  readonly response: string;
}

/**
 * Create a Schnorr proof of knowledge of the discrete log of `pubkeyPoint`.
 * The challenge binds `pubkey`, the nonce, and an optional domain string.
 */
export function createProofOfKnowledge(
  secretHex: string,
  pubkeyHex: string,
  domain?: string,
): DkgProofOfKnowledge {
  const secret = bytesToNumberBE(hexToBytes(secretHex));
  const pubkey = Point.fromHex(pubkeyHex);
  const r = randomScalar();
  const noncePoint = Point.BASE.multiply(r);
  const challenge = bytesToHex(
    sha256(
      new TextEncoder().encode(
        [
          'bao-frost-court/dkg-pok-v1',
          pubkey.toHex(true),
          noncePoint.toHex(true),
          domain ?? '',
        ].join('|'),
      ),
    ),
  );
  const e = modN(bytesToNumberBE(hexToBytes(challenge)));
  const z = modN(r + e * secret);
  return {
    nonce: noncePoint.toHex(true),
    response: scalarToHex(z),
  };
}

/**
 * Verify a Schnorr proof of knowledge of the discrete log of `pubkeyHex`.
 */
export function verifyProofOfKnowledge(
  pubkeyHex: string,
  proof: DkgProofOfKnowledge,
  domain?: string,
): boolean {
  try {
    const pubkey = Point.fromHex(pubkeyHex);
    const noncePoint = Point.fromHex(proof.nonce);
    const challenge = bytesToHex(
      sha256(
        new TextEncoder().encode(
          [
            'bao-frost-court/dkg-pok-v1',
            pubkey.toHex(true),
            noncePoint.toHex(true),
            domain ?? '',
          ].join('|'),
        ),
      ),
    );
    const e = modN(bytesToNumberBE(hexToBytes(challenge)));
    const z = bytesToNumberBE(hexToBytes(proof.response));
    const lhs = Point.BASE.multiply(z);
    const rhs = noncePoint.add(pubkey.multiply(e));
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

export { frost };
export type { PublicNonce };
