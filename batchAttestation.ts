// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * RFC-6962-style Merkle batching of BAO Court verdicts.
 *
 * A kind-39018 batch attestation lets one FROST cohort signature certify an
 * entire epoch's verdict cohort: verdict hashes are committed into a
 * domain-separated Merkle tree, the signed manifest binds
 * (epoch, cohort, batchIndex, count, root, finalizedAt), and any observer can
 * verify a single case's inclusion with an O(log n) authentication path —
 * without trusting the batch publisher.
 *
 * Encoding rules mirror the rest of the Court: every hash input goes through
 * CanonicalWriter (length-prefixed, delimiter-free) under an explicit domain
 * string, so attacker-controlled hex can never be re- interpreted across
 * domains. The tree follows the RFC-6962 unbalanced split
 * (k = 2^floor(log2(n-1))) so roots are identical across implementations.
 *
 * This module performs no network I/O; verification functions are pure and
 * fail-closed (they return { valid: false, reason } instead of throwing for
 * tampered or malformed protocol data — only malformed call arguments throw).
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getEventHash } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { HEX_32 } from './courtCeremonyCore';
import { CanonicalWriter } from './courtSession';
import { hashCourtVerdict } from './courtVoteMachine';

export const BAO_COURT_BATCH_ATTESTATION_KIND = 39018;

export const BATCH_LEAF_DOMAIN = 'BAO-Court/BatchLeaf/v1';
export const BATCH_NODE_DOMAIN = 'BAO-Court/BatchNode/v1';
export const BATCH_MANIFEST_DOMAIN = 'BAO-Court/BatchManifest/v1';

/** Maximum verdicts per batch — bounds tree/proof recursion resource use. */
const MAX_BATCH_VERDICTS = 10_000;

/** A Merkle authentication path for one verdict inside a batch. */
export interface BatchMerkleProof {
  /** Leaf index into the canonically sorted batch. */
  readonly index: number;
  /** The member's BatchLeaf digest (BatchLeaf/v1 of its verdict hash). */
  readonly verdictHash: string;
  /** Sibling hashes, nearest the leaf first. */
  readonly path: readonly string[];
}

export interface BatchAttestationValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface BatchAttestationValidationContext {
  /**
   * Pin the signing cohort's group key. MUST be set by every consumer that
   * derives reputation or settlement from a batch: without it, ANY key can
   * sign a self-selected batch manifest and the event validates cleanly
   * (see `__tests__/adversarialCrossModule.test.ts`, SEQUENCE-3).
   */
  readonly expectedGroupPubkey?: string;
  readonly expectedEpoch?: number;
  readonly expectedCohort?: string;
  /**
   * Pin the manifest's finalized timestamp. The event itself carries no
   * finalizedAt field, so verification falls back to the event's created_at
   * when this is omitted.
   */
  readonly expectedFinalizedAtSec?: number;
  /** Accepted for caller symmetry; no skew equivalent exists in validator.ts. */
  readonly now?: number;
}

export class BatchAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchAttestationError';
  }
}

const textEncoder = new TextEncoder();

function digestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = textEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

function assertHex32(value: string, field: string): void {
  if (typeof value !== 'string' || value.length !== 64 || !HEX_32.test(value)) {
    throw new BatchAttestationError(`${field} must be 32-byte lowercase hex`);
  }
}

function assertSafeNonNegative(value: number, field: string, max?: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BatchAttestationError(`${field} must be a safe non-negative integer`);
  }
  if (max !== undefined && value > max) {
    throw new BatchAttestationError(`${field} exceeds maximum of ${max}`);
  }
}

/** BatchLeaf/v1 — the domain-separated Merkle leaf over one verdict hash. */
function batchLeaf(verdictHash: string): string {
  const writer = new CanonicalWriter();
  writer.u8(0x00);
  writer.hex(verdictHash);
  return digestDomain(BATCH_LEAF_DOMAIN, writer.finish());
}

/** BatchNode/v1 — the domain-separated interior node over two child hashes. */
function batchNode(left: string, right: string): string {
  const writer = new CanonicalWriter();
  writer.u8(0x01);
  writer.hex(left);
  writer.hex(right);
  return digestDomain(BATCH_NODE_DOMAIN, writer.finish());
}

/**
 * RFC-6962 unbalanced split point: k = 2^floor(log2(n-1)). Computed with
 * integer arithmetic — Math.log2 is not exact for large n.
 */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 <= n - 1) k *= 2;
  return k;
}

/** Bytewise ascending comparison over hex leaf strings. */
function compareHexBytewise(left: string, right: string): number {
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = left.charCodeAt(i) - right.charCodeAt(i);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function assertLeafArray(leaves: readonly string[], field: string): void {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new BatchAttestationError(`${field} must be a non-empty array of leaf hashes`);
  }
  if (leaves.length > MAX_BATCH_VERDICTS) {
    throw new BatchAttestationError(`${field} exceeds maximum of ${MAX_BATCH_VERDICTS} leaves`);
  }
  for (const leaf of leaves) assertHex32(leaf, `${field} entries`);
}

/** Recursively compute the subtree root over leaves[lo, hi). */
function subtreeRoot(leaves: readonly string[], lo: number, hi: number): string {
  if (hi - lo === 1) return leaves[lo]!;
  const k = splitPoint(hi - lo);
  return batchNode(subtreeRoot(leaves, lo, lo + k), subtreeRoot(leaves, lo + k, hi));
}

/** Recursively build the sibling path for `target` within leaves[lo, hi). */
function buildPath(
  leaves: readonly string[],
  lo: number,
  hi: number,
  target: number,
): string[] {
  if (hi - lo === 1) return [];
  const k = splitPoint(hi - lo);
  if (target - lo < k) {
    return [...buildPath(leaves, lo, lo + k, target), subtreeRoot(leaves, lo + k, hi)];
  }
  return [...buildPath(leaves, lo + k, hi, target), subtreeRoot(leaves, lo, lo + k)];
}

/** Expected sibling-path length for `index` in an n-leaf RFC-6962 tree. */
function expectedPathLength(n: number, index: number): number {
  let length = 0;
  while (n > 1) {
    const k = splitPoint(n);
    if (index < k) {
      n = k;
    } else {
      index -= k;
      n -= k;
    }
    length += 1;
  }
  return length;
}

/**
 * Fold an authentication path back up to the root. `pathPos` walks from the
 * leaf level (path[0] is the leaf's immediate sibling) while (n, index)
 * descend from the full tree — so the deepest split consumes path[0].
 */
function foldRoot(
  path: readonly string[],
  n: number,
  index: number,
  acc: string,
): string {
  if (n === 1) return acc;
  const k = splitPoint(n);
  const sibling = path[path.length - 1]!;
  if (index < k) {
    return batchNode(foldRoot(path.slice(0, -1), k, index, acc), sibling);
  }
  return batchNode(sibling, foldRoot(path.slice(0, -1), n - k, index - k, acc));
}

/**
 * Build the canonical batch Merkle tree for a set of verdict hashes.
 *
 * Verdict hashes are sorted ascending bytewise before hashing so the root is
 * independent of submission order; duplicates are rejected because two
 * identical verdicts make proof indices ambiguous. n=0 throws; n=1 yields
 * root = leaf hash (an empty authentication path).
 *
 * Membership scope (cross-module round 2): a batch commits to verdict
 * HASHES only — the leaf does not bind an epoch, cohort, or session inputs.
 * The same verdictHash can therefore appear in batches of DIFFERENT epochs
 * (deliberate re-batching by a successor cohort, or an adversarial
 * duplicate) and both batch attestations validate. Consumers deriving
 * reputation or participation stats from batches MUST deduplicate by
 * verdictHash so a case is never double-counted (see
 * `__tests__/adversarialCrossModule.test.ts`, SEQUENCE-2).
 */
export function buildBatchMerkleTree(verdictHashes: readonly string[]): {
  readonly root: string;
  readonly leaves: readonly string[];
} {
  if (!Array.isArray(verdictHashes) || verdictHashes.length === 0) {
    throw new BatchAttestationError('verdictHashes must be a non-empty array');
  }
  if (verdictHashes.length > MAX_BATCH_VERDICTS) {
    throw new BatchAttestationError(
      `verdictHashes length ${verdictHashes.length} exceeds maximum of ${MAX_BATCH_VERDICTS}`,
    );
  }
  const seen = new Set<string>();
  for (const hash of verdictHashes) {
    assertHex32(hash, 'verdictHash');
    if (seen.has(hash)) {
      throw new BatchAttestationError(
        'duplicate verdictHash makes batch proofs ambiguous',
      );
    }
    seen.add(hash);
  }
  const sorted = [...verdictHashes].sort(compareHexBytewise);
  const leaves = sorted.map((hash) => batchLeaf(hash));
  return { root: subtreeRoot(leaves, 0, leaves.length), leaves };
}

/**
 * Build the authentication path for one leaf of an already-hashed (sorted)
 * leaf array, as returned by buildBatchMerkleTree. Bounds and shape are
 * validated with typed errors.
 */
export function buildBatchMerkleProof(
  leaves: readonly string[],
  index: number,
): BatchMerkleProof {
  assertLeafArray(leaves, 'leaves');
  if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length) {
    throw new BatchAttestationError(
      `index must be a safe integer in [0, ${leaves.length})`,
    );
  }
  return {
    index,
    verdictHash: leaves[index]!,
    path: buildPath(leaves, 0, leaves.length, index),
  };
}

/**
 * Canonical manifest hash binding the batch to an epoch, cohort, batch index,
 * verdict count, Merkle root, and finalization time:
 *
 *   H(BatchManifest/v1, u8(1), u32(epoch), cohortPubkey, u32(batchIndex),
 *     u32(count), root, u64(finalizedAtSec))
 *
 * All fields are validated before encoding so a malformed caller input can
 * never produce a signable (but ambiguous) digest.
 */
export function hashBatchManifest(params: {
  readonly epoch: number;
  readonly cohortPubkey: string;
  readonly batchIndex: number;
  readonly count: number;
  readonly root: string;
  readonly finalizedAtSec: number;
}): string {
  assertSafeNonNegative(params.epoch, 'epoch', 0xffff_ffff);
  assertHex32(params.cohortPubkey, 'cohortPubkey');
  assertSafeNonNegative(params.batchIndex, 'batchIndex', 0xffff_ffff);
  assertSafeNonNegative(params.count, 'count', 0xffff_ffff);
  assertHex32(params.root, 'root');
  assertSafeNonNegative(params.finalizedAtSec, 'finalizedAtSec');
  const writer = new CanonicalWriter();
  writer.u8(1);
  writer.u32(params.epoch);
  writer.hex(params.cohortPubkey);
  writer.u32(params.batchIndex);
  writer.u32(params.count);
  writer.hex(params.root);
  writer.u64(params.finalizedAtSec);
  return digestDomain(BATCH_MANIFEST_DOMAIN, writer.finish());
}

/** Read exactly one tag value by name, or null when absent/ambiguous. */
function uniqueTag(event: Pick<NostrEvent, 'tags'>, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1 || matches[0].length !== 2 || !matches[0][1]) return null;
  return matches[0][1];
}

function parseTagNumber(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Build a kind-39018 batch attestation event (unsigned, with precomputed id).
 *
 * The event id is the NIP-01 canonical serialization hash — the same
 * convention events.ts callers finalize with (getEventHash) — so the id
 * additionally commits to every tag, including the cohort signature.
 */
export function buildBatchAttestationEvent(params: {
  readonly epoch: number;
  readonly cohortPubkey: string;
  readonly batchIndex: number;
  readonly count: number;
  readonly root: string;
  readonly finalizedAtSec: number;
  readonly signature: string;
  readonly nonce?: string;
  readonly createdAt: number;
  readonly environment?: string;
}): NostrEvent {
  assertSafeNonNegative(params.epoch, 'epoch', 0xffff_ffff);
  assertHex32(params.cohortPubkey, 'cohortPubkey');
  assertSafeNonNegative(params.batchIndex, 'batchIndex', 0xffff_ffff);
  assertSafeNonNegative(params.count, 'count', 0xffff_ffff);
  assertHex32(params.root, 'root');
  assertSafeNonNegative(params.finalizedAtSec, 'finalizedAtSec');
  if (typeof params.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(params.signature)) {
    throw new BatchAttestationError('signature must be 128 hex chars');
  }
  if (params.nonce !== undefined && !HEX_32.test(params.nonce)) {
    throw new BatchAttestationError('nonce must be 32-byte lowercase hex');
  }
  assertSafeNonNegative(params.createdAt, 'createdAt');

  const nonce = params.nonce ?? params.signature.slice(0, 64);
  const tags: string[][] = [
    ['p', params.cohortPubkey],
    ['sig', params.signature],
    ['nonce', nonce],
    ['epoch', String(params.epoch)],
    ['cohort', params.cohortPubkey],
    ['batch', String(params.batchIndex)],
    ['count', String(params.count)],
    ['root', params.root],
  ];
  if (params.environment !== undefined) {
    tags.push(['env', params.environment]);
  }
  const event: NostrEvent = {
    kind: BAO_COURT_BATCH_ATTESTATION_KIND,
    created_at: params.createdAt,
    tags,
    content: JSON.stringify({
      root: params.root,
      count: params.count,
      epoch: params.epoch,
      batch: params.batchIndex,
    }),
    pubkey: params.cohortPubkey,
    id: '',
    sig: '',
  };
  event.id = getEventHash(event);
  return event;
}

/**
 * Validate a kind-39018 batch attestation event: kind, tag presence and
 * formats, tag/content consistency, event-id recomputation, context pins, and
 * finally the cohort Schnorr signature over the manifest hash. Every failure
 * returns { valid: false, reason } — this function never throws.
 */
export function validateBatchAttestationEvent(
  event: NostrEvent,
  ctx?: BatchAttestationValidationContext,
): BatchAttestationValidationResult {
  try {
    if (typeof event !== 'object' || event === null || !Array.isArray(event.tags)) {
      return { valid: false, reason: 'malformed event' };
    }
    if (event.kind !== BAO_COURT_BATCH_ATTESTATION_KIND) {
      return {
        valid: false,
        reason: `Not a Kind ${BAO_COURT_BATCH_ATTESTATION_KIND} batch attestation`,
      };
    }

    const pTag = uniqueTag(event, 'p');
    const signature = uniqueTag(event, 'sig');
    const nonce = uniqueTag(event, 'nonce');
    const epochTag = uniqueTag(event, 'epoch');
    const cohortTag = uniqueTag(event, 'cohort');
    const batchTag = uniqueTag(event, 'batch');
    const countTag = uniqueTag(event, 'count');
    const rootTag = uniqueTag(event, 'root');
    if (!pTag || !signature || !nonce || !epochTag || !cohortTag || !batchTag || !countTag || !rootTag) {
      return { valid: false, reason: 'Missing required tags' };
    }

    if (!HEX_32.test(pTag) || !HEX_32.test(cohortTag)) {
      return { valid: false, reason: 'Cohort pubkey must be 32-byte lowercase hex' };
    }
    if (cohortTag !== pTag) {
      return { valid: false, reason: 'Cohort tag does not match p tag' };
    }
    if (event.pubkey !== cohortTag) {
      return { valid: false, reason: 'Event pubkey does not match cohort' };
    }
    if (!/^[0-9a-fA-F]{128}$/.test(signature)) {
      return { valid: false, reason: 'Invalid signature' };
    }
    if (!HEX_32.test(nonce) || nonce !== signature.slice(0, 64)) {
      return { valid: false, reason: 'Nonce tag does not match signature' };
    }
    if (!HEX_32.test(rootTag)) {
      return { valid: false, reason: 'Root must be 32-byte lowercase hex' };
    }
    const epoch = parseTagNumber(epochTag);
    const batchIndex = parseTagNumber(batchTag);
    const count = parseTagNumber(countTag);
    if (epoch === null || batchIndex === null || count === null) {
      return { valid: false, reason: 'Epoch, batch, and count tags must be safe non-negative integers' };
    }
    if (count < 1 || count > MAX_BATCH_VERDICTS) {
      return { valid: false, reason: `Count must be 1..${MAX_BATCH_VERDICTS}` };
    }

    // Tag/content consistency: the content is what observers parse first, so
    // a divergence from the (signature-bound) tags is rejectable evidence.
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    } catch {
      return { valid: false, reason: 'Invalid JSON content' };
    }
    if (content.root !== rootTag) {
      return { valid: false, reason: 'Root tag does not match content' };
    }
    if (content.count !== count || content.epoch !== epoch || content.batch !== batchIndex) {
      return { valid: false, reason: 'Count, epoch, or batch tag does not match content' };
    }

    // Event id recomputation (NIP-01 canonical serialization).
    if (typeof event.id !== 'string' || event.id.length !== 64) {
      return { valid: false, reason: 'Missing or malformed event id' };
    }
    const recomputedId = getEventHash({
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
      pubkey: event.pubkey,
    });
    if (recomputedId !== event.id) {
      return { valid: false, reason: 'Event id does not match canonical serialization' };
    }

    // Context pins — fail closed on any mismatch.
    if (ctx?.expectedGroupPubkey && pTag !== ctx.expectedGroupPubkey) {
      return { valid: false, reason: 'Group pubkey mismatch' };
    }
    if (ctx?.expectedEpoch !== undefined && epoch !== ctx.expectedEpoch) {
      return { valid: false, reason: 'Epoch mismatch' };
    }
    if (ctx?.expectedCohort && cohortTag !== ctx.expectedCohort) {
      return { valid: false, reason: 'Cohort mismatch' };
    }

    // The FROST cohort signature certifies the full manifest. The event
    // carries no finalizedAt field, so verification binds created_at unless
    // the caller pins an exact finalizedAtSec.
    const finalizedAtSec = ctx?.expectedFinalizedAtSec ?? event.created_at;
    if (!Number.isSafeInteger(finalizedAtSec) || finalizedAtSec < 0) {
      return { valid: false, reason: 'created_at must be a safe non-negative integer' };
    }
    let manifestHash: string;
    try {
      manifestHash = hashBatchManifest({
        epoch,
        cohortPubkey: cohortTag,
        batchIndex,
        count,
        root: rootTag,
        finalizedAtSec,
      });
    } catch {
      return { valid: false, reason: 'Manifest inputs are malformed' };
    }
    const ok = schnorr.verify(
      hexToBytes(signature),
      hexToBytes(manifestHash),
      hexToBytes(cohortTag),
    );
    return ok
      ? { valid: true }
      : { valid: false, reason: 'Schnorr signature verification failed' };
  } catch (err) {
    return {
      valid: false,
      reason: `Validation exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify one case's inclusion in a batch attestation.
 *
 * Recomputes the case's verdict hash with the vote machine's canonical
 * hashCourtVerdict, derives its BatchLeaf, walks the authentication path
 * (bounds-checked against the event's declared count), recomputes the root
 * and the manifest hash, then runs the full event validation. Any mismatch is
 * reported fail-closed as { valid: false, reason } — only malformed call
 * arguments (non-object event, wrong types) throw a BatchAttestationError.
 *
 * What the proof does and does not pin (cross-module round 2): the
 * authentication path pins the VERDICT HASH only. The
 * (sessionHash, outcome, supportingEventIds) inputs are caller-supplied and
 * re-hashed here, so presenting inputs DIFFERENT from those the cohort
 * batched yields a different leaf and is rejected — but correctness of the
 * inputs themselves (that the supporting event ids are real
 * confirmations/reveals of that session) is the CALLER's authentication
 * duty: fetch and verify the referenced events. Likewise, batch membership
 * is per-batch: the same verdictHash may appear in multiple epoch batches
 * and each verification is independent — deduplicate by verdictHash before
 * deriving reputation (SEQUENCE-2).
 */
export function verifyCaseInBatch(
  event: NostrEvent,
  caseInput: {
    readonly sessionHash: string;
    readonly outcome: string;
    readonly supportingEventIds: readonly string[];
    readonly proof: BatchMerkleProof;
  },
  ctx?: BatchAttestationValidationContext,
): BatchAttestationValidationResult {
  if (typeof event !== 'object' || event === null) {
    throw new BatchAttestationError('event must be an object');
  }
  if (typeof caseInput !== 'object' || caseInput === null) {
    throw new BatchAttestationError('caseInput must be an object');
  }
  if (
    typeof caseInput.proof !== 'object'
    || caseInput.proof === null
    || !Array.isArray(caseInput.proof.path)
    || caseInput.proof.path.some((sibling) => typeof sibling !== 'string')
  ) {
    throw new BatchAttestationError('proof must carry an array sibling path');
  }
  if (
    !Number.isSafeInteger(caseInput.proof.index)
    || caseInput.proof.index < 0
    || typeof caseInput.proof.verdictHash !== 'string'
  ) {
    throw new BatchAttestationError('proof index and verdictHash are malformed');
  }

  // Recompute the verdict hash with the exact vote-machine logic — do not
  // fork it. hashCourtVerdict validates and throws for malformed case inputs.
  const verdictHash = hashCourtVerdict(caseInput);
  const leaf = batchLeaf(verdictHash);
  if (caseInput.proof.verdictHash !== leaf) {
    return { valid: false, reason: 'Proof leaf does not match the case verdict inputs' };
  }

  const pTag = uniqueTag(event, 'p');
  const cohortTag = uniqueTag(event, 'cohort');
  const countTag = uniqueTag(event, 'count');
  const rootTag = uniqueTag(event, 'root');
  if (!cohortTag || !countTag || !rootTag) {
    return { valid: false, reason: 'Missing required tags' };
  }
  const count = parseTagNumber(countTag);
  if (count === null || count < 1) {
    return { valid: false, reason: 'Count tag must be a positive safe integer' };
  }
  const { index, path } = caseInput.proof;
  if (index >= count) {
    return { valid: false, reason: 'Proof index is outside the declared batch count' };
  }
  if (path.length !== expectedPathLength(count, index)) {
    return { valid: false, reason: 'Proof path length does not match the batch shape' };
  }
  let recomputedRoot: string;
  try {
    recomputedRoot = foldRoot(path, count, index, leaf);
  } catch {
    return { valid: false, reason: 'Proof path is malformed' };
  }
  if (recomputedRoot !== rootTag) {
    return { valid: false, reason: 'Proof does not recompute the batch root' };
  }

  // Full event validation (signature, id, pins) closes the verification.
  return validateBatchAttestationEvent(event, ctx);
}
