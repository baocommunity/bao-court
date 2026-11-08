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
import { CanonicalWriter } from './courtSession';
import { HEX_32 } from './courtCeremonyCore';

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
 * Domain tag for the attestation message. Keeps the signed digest distinct
 * from every other Court hash domain (preimage, bond challenge, session…).
 */
export const ATTESTATION_MESSAGE_DOMAIN = 'BAO-Court/AttestationMessage/v1';

/**
 * V2 attestation-message domain. Extends the v1 signed message with the
 * finality-binding fields the universal-confirmation redesign requires
 * (`epochId`, `tier`, `threshold`, `signerSetRoot`, `attempt`,
 * `batchMerkleRoot`) so a low-tier or stale attestation can never be
 * replayed or misrepresented as a final verdict under the same standing
 * cohort key. Optional fields are encoded as tagged entries in a fixed
 * order, so any subset can be present and every consumer derives the same
 * digest from the same fields.
 */
export const ATTESTATION_MESSAGE_DOMAIN_V2 = 'BAO-Court/AttestationMessage/v2';

/** Extension-tag ids for the v2 attestation message, in canonical order. */
export const ATTESTATION_V2_FIELD_TAGS = {
  epochId: 1,
  tier: 2,
  threshold: 3,
  signerSetRoot: 4,
  attempt: 5,
  batchMerkleRoot: 6,
} as const;

export type AttestationV2Field = keyof typeof ATTESTATION_V2_FIELD_TAGS;

/**
 * Build the v2 canonical attestation message that jurors sign.
 *
 * Same body as v1 (`buildAttestationMessage`) with a version byte prefix and
 * an ordered, tagged extension block. Absent optional fields are simply
 * omitted — the encoding is self-describing, so two implementations that
 * agree on the field set derive the identical digest.
 */
export function buildAttestationMessageV2(params: {
  readonly marketId: string;
  readonly outcome: string;
  readonly round: number | string;
  readonly disputeEventId?: string;
  readonly verdictHash?: string;
  readonly epochId?: number;
  readonly tier?: number;
  readonly threshold?: number;
  readonly signerSetRoot?: string;
  readonly attempt?: number;
  readonly batchMerkleRoot?: string;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(0x02);
  writer.text(ATTESTATION_MESSAGE_DOMAIN_V2);
  writer.text(params.marketId);
  writer.text(params.outcome);
  writer.text(String(params.round));
  if (params.disputeEventId !== undefined) {
    if (typeof params.disputeEventId !== 'string' || !HEX_32.test(params.disputeEventId)) {
      throw new Error('attestation v2 disputeEventId must be 32-byte lowercase hex');
    }
    writer.u8(1);
    writer.text(params.disputeEventId);
  } else {
    writer.u8(0);
  }
  if (params.verdictHash !== undefined) {
    if (typeof params.verdictHash !== 'string' || !HEX_32.test(params.verdictHash)) {
      throw new Error('attestation v2 verdictHash must be 32-byte lowercase hex');
    }
    writer.u8(1);
    writer.hex(params.verdictHash);
  } else {
    writer.u8(0);
  }
  const extensions: Array<readonly [number, () => void]> = [];
  if (params.epochId !== undefined) {
    assertSafeUint(params.epochId, 'attestation v2 epochId');
    extensions.push([ATTESTATION_V2_FIELD_TAGS.epochId, () => writer.u32(params.epochId!)]);
  }
  if (params.tier !== undefined) {
    if (!Number.isSafeInteger(params.tier) || params.tier < 0 || params.tier > 0xff) {
      throw new Error('attestation v2 tier must be an integer in [0, 255]');
    }
    extensions.push([ATTESTATION_V2_FIELD_TAGS.tier, () => writer.u8(params.tier!)]);
  }
  if (params.threshold !== undefined) {
    assertSafeUint(params.threshold, 'attestation v2 threshold');
    extensions.push([ATTESTATION_V2_FIELD_TAGS.threshold, () => writer.u32(params.threshold!)]);
  }
  if (params.signerSetRoot !== undefined) {
    if (typeof params.signerSetRoot !== 'string' || !HEX_32.test(params.signerSetRoot)) {
      throw new Error('attestation v2 signerSetRoot must be 32-byte lowercase hex');
    }
    extensions.push([ATTESTATION_V2_FIELD_TAGS.signerSetRoot, () => writer.hex(params.signerSetRoot!)]);
  }
  if (params.attempt !== undefined) {
    assertSafeUint(params.attempt, 'attestation v2 attempt');
    extensions.push([ATTESTATION_V2_FIELD_TAGS.attempt, () => writer.u32(params.attempt!)]);
  }
  if (params.batchMerkleRoot !== undefined) {
    if (typeof params.batchMerkleRoot !== 'string' || !HEX_32.test(params.batchMerkleRoot)) {
      throw new Error('attestation v2 batchMerkleRoot must be 32-byte lowercase hex');
    }
    extensions.push([ATTESTATION_V2_FIELD_TAGS.batchMerkleRoot, () => writer.hex(params.batchMerkleRoot!)]);
  }
  writer.u8(extensions.length);
  for (const [tag, write] of extensions) {
    writer.u8(tag);
    write();
  }
  return bytesToHex(sha256(writer.finish()));
}

function assertSafeUint(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be a safe integer in [0, 4294967295]`);
  }
}

/**
 * Build the canonical attestation message that all jurors sign.
 *
 * Uses the Court's canonical length-prefixed encoding (see
 * {@link CanonicalWriter}) with a domain tag. Delimiter-joined concatenation
 * would be ambiguous: an attacker-controlled `marketId` or `outcome` could
 * embed the delimiter and alias another field (or the dispute id), so two
 * distinct verdicts would hash to the same signed message. Length-prefixing
 * makes every tuple of fields unambiguous.
 *
 * `verdictHash` (kind-39007 only) is the dispute verdict commitment
 * ({@link hashDisputeVerdict}): the FROST signature then certifies the
 * TALLY that produced the outcome — an attestation for an outcome that lost
 * the vote is structurally invalid, not merely suspicious.
 */
export function buildAttestationMessage(
  marketId: string,
  outcome: string,
  round: number | string,
  disputeEventId?: string,
  verdictHash?: string,
): string {
  const writer = new CanonicalWriter();
  writer.text(ATTESTATION_MESSAGE_DOMAIN);
  writer.text(marketId);
  writer.text(outcome);
  writer.text(String(round));
  if (disputeEventId) writer.text(disputeEventId);
  if (verdictHash) writer.hex(verdictHash);
  return bytesToHex(sha256(writer.finish()));
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

const SECP256K1_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;

/**
 * Validate an x-only or compressed secp256k1 point encoding.
 *
 * A regex alone accepts any 64-char hex string; this additionally verifies
 * the bytes decode to a point on the curve, so malformed nonce commitments
 * cannot poison FROST binding-factor computation downstream.
 */
export function isValidSecp256k1Point(value: string): boolean {
  if (!SECP256K1_POINT.test(value)) return false;
  try {
    Point.fromHex(value.length === 64 ? `02${value}` : value);
    return true;
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
