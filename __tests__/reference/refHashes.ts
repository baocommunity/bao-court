// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * INDEPENDENT reference implementations of the Court hash domains
 * (differential-parity round 8).
 *
 * The point is the HASH LIBRARY: production uses @noble/hashes `sha256`
 * everywhere; the reference uses Node `crypto.createHash('sha256')` — a
 * completely independent SHA-256 implementation. Encoding is rebuilt from
 * the documented spec with the reference writer (refCanonical.ts), never by
 * calling production encoding code.
 *
 * Domains mirrored (spec source: the production docstrings + CHANGELOG):
 *   hashCourtVerdict        H(Verdict/v1,        sessionHash, outcome, u32 n, ids…)
 *   hashDisputeVerdict      H(DisputeVerdict/v1, disputeId, outcome, u32 n, SORTED ids…)
 *   hashBatchManifest       H(BatchManifest/v1,  u8 1, epoch, cohort, batchIndex, count, root, finalizedAtSec)
 *   buildAttestationMessageV2
 *                           sha256(u8 0x02, AttestationMessage/v2, marketId, outcome,
 *                                  String(round), [disputeEventId?], [verdictHash?],
 *                                  u8 extCount, tagged exts in fixed order)
 */

import { createHash } from 'node:crypto';

import { RefCanonicalWriter, refHexToBytes } from './refCanonical';

const VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
const DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
const BATCH_MANIFEST_DOMAIN = 'BAO-Court/BatchManifest/v1';
const ATTESTATION_MESSAGE_DOMAIN_V2 = 'BAO-Court/AttestationMessage/v2';
const MAX_OUTCOME_BYTES = 256;

/** Node-crypto SHA-256 — deliberately NOT @noble/hashes. */
export function refSha256Hex(...parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(Buffer.from(part));
  return hash.digest('hex');
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function domainDigest(domain: string, encoded: Uint8Array): string {
  return refSha256Hex(Buffer.from(domain, 'utf8'), encoded);
}

function refHex32(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError(`ref: ${field} must be 32-byte lowercase hex`);
  }
}

function refCanonicalOutcome(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`ref: ${field} must be a non-empty string`);
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_OUTCOME_BYTES) {
    throw new RangeError(`ref: ${field} exceeds ${MAX_OUTCOME_BYTES} UTF-8 bytes`);
  }
  if (Buffer.from(bytes).toString('utf8') !== value) {
    throw new RangeError(`ref: ${field} must round-trip its own UTF-8 encoding`);
  }
}

/** Production contract: supporting ids are hashed IN THE GIVEN ORDER (no sort). */
export function refHashCourtVerdict(params: {
  readonly sessionHash: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
}): string {
  refHex32(params.sessionHash, 'sessionHash');
  refCanonicalOutcome(params.outcome, 'outcome');
  if (!Array.isArray(params.supportingEventIds) || params.supportingEventIds.length === 0) {
    throw new RangeError('ref: supportingEventIds must be a non-empty array');
  }
  for (const id of params.supportingEventIds) refHex32(id, 'supporting event id');
  const writer = new RefCanonicalWriter();
  writer.hex(params.sessionHash);
  writer.text(params.outcome);
  writer.u32(params.supportingEventIds.length);
  for (const id of params.supportingEventIds) writer.hex(id);
  return domainDigest(VERDICT_DOMAIN, writer.finish());
}

/** Production contract: event ids are SORTED before hashing (order-independent). */
export function refHashDisputeVerdict(params: {
  readonly disputeId: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
}): string {
  refHex32(params.disputeId, 'disputeId');
  refCanonicalOutcome(params.outcome, 'outcome');
  if (!Array.isArray(params.supportingEventIds) || params.supportingEventIds.length === 0) {
    throw new RangeError('ref: supportingEventIds must be a non-empty array');
  }
  for (const id of params.supportingEventIds) refHex32(id, 'supporting event id');
  // Independent bytewise sort: for lowercase hex, UTF-8 byte order and the
  // production's default string sort (UTF-16 code units) agree — the
  // differential test proves it rather than assumes it.
  const sorted = [...params.supportingEventIds].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
  const writer = new RefCanonicalWriter();
  writer.hex(params.disputeId);
  writer.text(params.outcome);
  writer.u32(sorted.length);
  for (const id of sorted) writer.hex(id);
  return domainDigest(DISPUTE_VERDICT_DOMAIN, writer.finish());
}

/** H(BatchManifest/v1, u8 1, u32 epoch, cohort, u32 batchIndex, u32 count, root, u64 finalizedAtSec). */
export function refHashBatchManifest(params: {
  readonly epoch: number;
  readonly cohortPubkey: string;
  readonly batchIndex: number;
  readonly count: number;
  readonly root: string;
  readonly finalizedAtSec: number;
}): string {
  refHex32(params.cohortPubkey, 'cohortPubkey');
  refHex32(params.root, 'root');
  for (const [field, value] of [
    ['epoch', params.epoch],
    ['batchIndex', params.batchIndex],
    ['count', params.count],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`ref: ${field} must be a safe integer in [0, 4294967295]`);
    }
  }
  if (!Number.isSafeInteger(params.finalizedAtSec) || params.finalizedAtSec < 0) {
    throw new RangeError('ref: finalizedAtSec must be a safe non-negative integer');
  }
  const writer = new RefCanonicalWriter();
  writer.u8(1);
  writer.u32(params.epoch);
  writer.hex(params.cohortPubkey);
  writer.u32(params.batchIndex);
  writer.u32(params.count);
  writer.hex(params.root);
  writer.u64(params.finalizedAtSec);
  return domainDigest(BATCH_MANIFEST_DOMAIN, writer.finish());
}

/** Extension-tag ids for the v2 attestation message, in canonical order. */
export const REF_ATTESTATION_V2_FIELD_TAGS = {
  epochId: 1,
  tier: 2,
  threshold: 3,
  signerSetRoot: 4,
  attempt: 5,
  batchMerkleRoot: 6,
} as const;

/** Independent buildAttestationMessageV2 (crypto.ts spec, node-crypto sha256). */
export function refBuildAttestationMessageV2(params: {
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
  for (const [field, value] of [
    ['disputeEventId', params.disputeEventId],
    ['verdictHash', params.verdictHash],
    ['signerSetRoot', params.signerSetRoot],
    ['batchMerkleRoot', params.batchMerkleRoot],
  ] as const) {
    if (value !== undefined) refHex32(value, field);
  }
  for (const [field, value] of [
    ['epochId', params.epochId],
    ['threshold', params.threshold],
    ['attempt', params.attempt],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff)) {
      throw new RangeError(`ref: ${field} must be a safe integer in [0, 4294967295]`);
    }
  }
  if (params.tier !== undefined && (!Number.isSafeInteger(params.tier) || params.tier < 0 || params.tier > 0xff)) {
    throw new RangeError('ref: tier must be an integer in [0, 255]');
  }

  const writer = new RefCanonicalWriter();
  writer.u8(0x02);
  writer.text(ATTESTATION_MESSAGE_DOMAIN_V2);
  writer.text(params.marketId);
  writer.text(params.outcome);
  writer.text(String(params.round));
  if (params.disputeEventId !== undefined) {
    writer.u8(1);
    writer.text(params.disputeEventId);
  } else {
    writer.u8(0);
  }
  if (params.verdictHash !== undefined) {
    writer.u8(1);
    writer.hex(params.verdictHash);
  } else {
    writer.u8(0);
  }
  // Extensions in FIXED tag order, each tagged (u8 tag, then value).
  const present: Array<readonly [number, () => void]> = [];
  if (params.epochId !== undefined) {
    present.push([REF_ATTESTATION_V2_FIELD_TAGS.epochId, () => writer.u32(params.epochId!)]);
  }
  if (params.tier !== undefined) {
    present.push([REF_ATTESTATION_V2_FIELD_TAGS.tier, () => writer.u8(params.tier!)]);
  }
  if (params.threshold !== undefined) {
    present.push([REF_ATTESTATION_V2_FIELD_TAGS.threshold, () => writer.u32(params.threshold!)]);
  }
  if (params.signerSetRoot !== undefined) {
    present.push([REF_ATTESTATION_V2_FIELD_TAGS.signerSetRoot, () => writer.hex(params.signerSetRoot!)]);
  }
  if (params.attempt !== undefined) {
    present.push([REF_ATTESTATION_V2_FIELD_TAGS.attempt, () => writer.u32(params.attempt!)]);
  }
  if (params.batchMerkleRoot !== undefined) {
    present.push([REF_ATTESTATION_V2_FIELD_TAGS.batchMerkleRoot, () => writer.hex(params.batchMerkleRoot!)]);
  }
  writer.u8(present.length);
  for (const [tag, write] of present) {
    writer.u8(tag);
    write();
  }
  // NOTE: no domain prefix — v2 carries its domain INSIDE the writer as a
  // text field (u8 0x02 version byte first), unlike the v1/vote domains.
  return refSha256Hex(writer.finish());
}

/** Independent preimage of `hexToBytes` for round-trip assertions. */
export { refHexToBytes };

/** Concat exposed for tests that need production-shape domain-prefix inputs. */
export { concat as refConcat };
