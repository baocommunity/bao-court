// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Low-level cryptographic helpers for the BAO FROST threshold oracle.
 *
 * Browser-compatible: uses @noble/curves and @noble/hashes instead of Node crypto.
 */

import { CourtArgumentError, CourtCryptoError } from './errors';
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

/**
 * Generate a fresh 32-byte random value as 64-char lowercase hex, using the
 * platform CSPRNG (`crypto.getRandomValues`). For nonces, salts, and
 * challenge values; O(1).
 */
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
  throw new CourtCryptoError('CRYPTO_STATE', 'seededScalar: could not derive non-zero scalar');
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

/** Field name of a v2 attestation-message extension entry (canonical order in {@link ATTESTATION_V2_FIELD_TAGS}). */
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
      throw new CourtArgumentError('CRYPTO_ARGUMENT', 'attestation v2 disputeEventId must be 32-byte lowercase hex');
    }
    writer.u8(1);
    writer.text(params.disputeEventId);
  } else {
    writer.u8(0);
  }
  if (params.verdictHash !== undefined) {
    if (typeof params.verdictHash !== 'string' || !HEX_32.test(params.verdictHash)) {
      throw new CourtArgumentError('CRYPTO_ARGUMENT', 'attestation v2 verdictHash must be 32-byte lowercase hex');
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
      throw new CourtArgumentError('CRYPTO_ARGUMENT', 'attestation v2 tier must be an integer in [0, 255]');
    }
    extensions.push([ATTESTATION_V2_FIELD_TAGS.tier, () => writer.u8(params.tier!)]);
  }
  if (params.threshold !== undefined) {
    assertSafeUint(params.threshold, 'attestation v2 threshold');
    extensions.push([ATTESTATION_V2_FIELD_TAGS.threshold, () => writer.u32(params.threshold!)]);
  }
  if (params.signerSetRoot !== undefined) {
    if (typeof params.signerSetRoot !== 'string' || !HEX_32.test(params.signerSetRoot)) {
      throw new CourtArgumentError('CRYPTO_ARGUMENT', 'attestation v2 signerSetRoot must be 32-byte lowercase hex');
    }
    extensions.push([ATTESTATION_V2_FIELD_TAGS.signerSetRoot, () => writer.hex(params.signerSetRoot!)]);
  }
  if (params.attempt !== undefined) {
    assertSafeUint(params.attempt, 'attestation v2 attempt');
    extensions.push([ATTESTATION_V2_FIELD_TAGS.attempt, () => writer.u32(params.attempt!)]);
  }
  if (params.batchMerkleRoot !== undefined) {
    if (typeof params.batchMerkleRoot !== 'string' || !HEX_32.test(params.batchMerkleRoot)) {
      throw new CourtArgumentError('CRYPTO_ARGUMENT', 'attestation v2 batchMerkleRoot must be 32-byte lowercase hex');
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
    throw new CourtArgumentError('CRYPTO_ARGUMENT', `${label} must be a safe integer in [0, 4294967295]`);
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
/**
 * Build the v1 canonical attestation message that jurors sign:
 * `SHA-256(AttestationMessage/v1 ‖ marketId ‖ outcome ‖ round ‖ [disputeId]
 * ‖ [verdictHash])` over canonical length-prefixed fields. Pure; O(1) in
 * field sizes. The v1 shape is FROZEN — existing attestations must verify
 * forever.
 *
 * @example
 * ```ts
 * const message = buildAttestationMessage(marketId, 'YES', 1,
 *   disputeEventId, verdictHash);
 * // signers produce partials over `message`; observers re-derive it
 * // inside validateAttestationEvent.
 * ```
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

/**
 * Verify a FROST group signature over a message under a group public key.
 *
 * @returns `true` when the signature is valid; `false` on any verification
 *          failure (including malformed hex — fail-closed, never throws).
 *          O(1) cryptographic work.
 */
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

/**
 * Verify a BIP-340 Schnorr signature (x-only pubkey, 64-byte sig).
 *
 * @returns `true` when valid; `false` on any failure including malformed
 *          inputs (never throws). O(1) cryptographic work.
 */
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
 * Bounded memo for {@link isValidSecp256k1Point}.
 *
 * Safety argument (perf round 9): point validity is a PURE mathematical
 * function of the encoding string — `Point.fromHex` is deterministic and
 * side-effect-free — so a (string → boolean) memo returns bit-identical
 * answers forever. The cache is module-private (never enumerable on any
 * machine state, never serialized — the verified-verdict cache lesson), and
 * bounded: clearing at the cap keeps memory O(cap) even under an adversarial
 * flood of unique well-formed-but-invalid encodings, at worst re-paying one
 * 88 µs decode per flooded entry between clears.
 *
 * Why it matters: `Point.fromHex` costs ~88 µs on this class of host (x-only
 * y decompression = one modular exponentiation), and the signing machine's
 * reducer re-validates EVERY stored nonce commitment (2 points each) on
 * EVERY transition — O(threshold) decodes per reduce made transitions cost
 * milliseconds (see docs/benchmarks/BASELINE.md, post-optimization notes).
 */
const POINT_VALIDITY_CACHE = new Map<string, boolean>();
const POINT_VALIDITY_CACHE_MAX = 8192;

/**
 * Validate an x-only or compressed secp256k1 point encoding.
 *
 * A regex alone accepts any 64-char hex string; this additionally verifies
 * the bytes decode to a point on the curve, so malformed nonce commitments
 * cannot poison FROST binding-factor computation downstream.
 */
export function isValidSecp256k1Point(value: string): boolean {
  if (!SECP256K1_POINT.test(value)) return false;
  const cached = POINT_VALIDITY_CACHE.get(value);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    Point.fromHex(value.length === 64 ? `02${value}` : value);
    valid = true;
  } catch {
    valid = false;
  }
  if (POINT_VALIDITY_CACHE.size >= POINT_VALIDITY_CACHE_MAX) {
    POINT_VALIDITY_CACHE.clear();
  }
  POINT_VALIDITY_CACHE.set(value, valid);
  return valid;
}

/**
 * A Schnorr proof of knowledge of a DKG polynomial's constant coefficient
 * (Fiat–Shamir challenge under {@link dkgPokDomain}): nonce commitment and
 * scalar response, both hex.
 */
export interface DkgProofOfKnowledge {
  /** Public nonce R = r*G in hex (compressed). */
  readonly nonce: string;
  /** Response z = r + e*secret in hex (32-byte scalar). */
  readonly response: string;
}

/**
 * Challenge domain for the DKG proof-of-knowledge (canonical encoding).
 *
 * v2 replaces the v1 delimiter-joined challenge encoding. The v1 encoding
 * joined `[prefix, pubkey, nonce, domain].join('|')` — the first three fields
 * are fixed-length hex so the join was injective there, but the trailing
 * `domain` string (`market=…|dispute=…|juror=…`) is attacker-influenced and
 * itself contains the separators, so two distinct (market, dispute) pairs can
 * render the same domain string (e.g. market "x" + dispute "y|dispute=z"
 * vs market "x|dispute=y" + dispute "z") and alias a proof across DKG
 * ceremony bindings. v2 length-prefixes every field via CanonicalWriter under
 * an explicit domain tag, making the challenge injective in all fields.
 */
const DKG_POK_CHALLENGE_DOMAIN_V2 = 'bao-frost-court/dkg-pok-challenge-v2';
/** Legacy v1 challenge prefix — still VERIFIED (never created) for mixed-fleet compat. */
const DKG_POK_CHALLENGE_PREFIX_V1 = 'bao-frost-court/dkg-pok-v1';

/**
 * Canonical DKG proof-of-knowledge domain string: hex of the
 * CanonicalWriter-encoded `(marketId, disputeId, jurorIdx)` tuple.
 *
 * The legacy renderer (`market=…|dispute=…|juror=…`) was ambiguous whenever a
 * hostile market/dispute id embeds the delimiters — e.g. tuple
 * (market "x", dispute "y|dispute=z") and tuple (market "x|dispute=y",
 * dispute "z") render identically, aliasing a proof across DKG ceremony
 * bindings. Length-prefixing every field makes the tuple injective.
 */
export function dkgPokDomain(marketId: string, disputeId: string, jurorIdx: number): string {
  const writer = new CanonicalWriter();
  writer.text(marketId);
  writer.text(disputeId);
  writer.u32(jurorIdx);
  return bytesToHex(writer.finish());
}

function pokChallengeV2(pubkeyHex: string, nonceHex: string, domain: string): string {
  const writer = new CanonicalWriter();
  writer.text(DKG_POK_CHALLENGE_DOMAIN_V2);
  writer.text(pubkeyHex);
  writer.text(nonceHex);
  writer.text(domain);
  return bytesToHex(sha256(writer.finish()));
}

function pokChallengeV1(pubkeyHex: string, nonceHex: string, domain: string): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        [DKG_POK_CHALLENGE_PREFIX_V1, pubkeyHex, nonceHex, domain].join('|'),
      ),
    ),
  );
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
  const challenge = pokChallengeV2(
    pubkey.toHex(true),
    noncePoint.toHex(true),
    domain ?? '',
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
 *
 * Accepts the canonical v2 challenge encoding (what {@link createProofOfKnowledge}
 * now emits) and — for mixed-version fleets during rollout — the legacy v1
 * delimiter-joined encoding. v1 acceptance is a documented compatibility
 * window, not an ambiguity: the v1 encoding's aliasing only matters when a
 * hostile peer crafts colliding `domain` strings, and every DKG session also
 * binds commitments to the roster and dispute at the event boundary.
 */
export function verifyProofOfKnowledge(
  pubkeyHex: string,
  proof: DkgProofOfKnowledge,
  domain?: string,
): boolean {
  try {
    const pubkey = Point.fromHex(pubkeyHex);
    const noncePoint = Point.fromHex(proof.nonce);
    const compressed = pubkey.toHex(true);
    const nonce = noncePoint.toHex(true);
    const domainStr = domain ?? '';
    const z = bytesToNumberBE(hexToBytes(proof.response));
    for (const challengeHex of [
      pokChallengeV2(compressed, nonce, domainStr),
      pokChallengeV1(compressed, nonce, domainStr),
    ]) {
      const e = modN(bytesToNumberBE(hexToBytes(challengeHex)));
      const lhs = Point.BASE.multiply(z);
      const rhs = noncePoint.add(pubkey.multiply(e));
      if (lhs.equals(rhs)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export { frost };
export type { PublicNonce };
