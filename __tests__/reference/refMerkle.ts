// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * INDEPENDENT reference implementation of the RFC-6962-style batch Merkle tree
 * (differential-parity round 8 — see __tests__/differentialParity.test.ts).
 *
 * Deliberately DIFFERENT implementation strategy from the production
 * `batchAttestation.ts`:
 *
 *   production : index-math recursion over (lo, hi) ranges with a
 *                multiplicative splitPoint loop; CanonicalWriter + @noble
 *                sha256 for the node hashes; proof folding recurses from the
 *                ROOT consuming the path from the BACK (foldRoot).
 *   reference  : recursive ARRAY-SLICE style (subtrees are plain subarrays);
 *                split point via bit tricks (1 << (31 - clz(n-1))); node
 *                hashes via node:crypto createHash; proof verification
 *                RECORDS the root→leaf descent chain, then REPLAYS the
 *                leaf-first path from the FRONT bottom-up.
 *
 * Domain strings are restated from the protocol spec (BatchLeaf/v1 /
 * BatchNode/v1 with 0x00 / 0x01 type bytes). If the reference reproduces the
 * production root for every n, both the domain separation AND the tree shape
 * agree — an independent re-derivation, not a call-through.
 */

import { createHash } from 'node:crypto';

import { RefCanonicalWriter } from './refCanonical';

export const REF_BATCH_LEAF_DOMAIN = 'BAO-Court/BatchLeaf/v1';
export const REF_BATCH_NODE_DOMAIN = 'BAO-Court/BatchNode/v1';

const HEX_32_REF = /^[0-9a-f]{64}$/;

function sha256Hex(...parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(Buffer.from(part));
  return hash.digest('hex');
}

function utf8(value: string): Uint8Array {
  return Buffer.from(value, 'utf8');
}

/** BatchLeaf/v1 — H(BatchLeaf/v1, u8 0x00, u32 32, verdictHash bytes) — length-prefixed like production. */
export function refBatchLeaf(verdictHash: string): string {
  const writer = new RefCanonicalWriter();
  writer.u8(0x00);
  writer.hex(verdictHash);
  return sha256Hex(utf8(REF_BATCH_LEAF_DOMAIN), writer.finish());
}

/** BatchNode/v1 — H(BatchNode/v1, u8 0x01, u32 32, left, u32 32, right). */
export function refBatchNode(left: string, right: string): string {
  const writer = new RefCanonicalWriter();
  writer.u8(0x01);
  writer.hex(left);
  writer.hex(right);
  return sha256Hex(utf8(REF_BATCH_NODE_DOMAIN), writer.finish());
}

/**
 * RFC-6962 unbalanced split point k = 2^floor(log2(n-1)), computed with bit
 * tricks (highest set bit of n-1) — different arithmetic from the
 * production's multiplicative loop, identical value.
 */
export function refSplit(n: number): number {
  return 1 << (31 - Math.clz32(n - 1));
}

/** Recursive ARRAY-SLICE subtree root (production uses (lo, hi) index math). */
export function refSubtreeRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) throw new RangeError('refSubtreeRoot: empty slice');
  if (leaves.length === 1) return leaves[0]!;
  const k = refSplit(leaves.length);
  return refBatchNode(
    refSubtreeRoot(leaves.slice(0, k)),
    refSubtreeRoot(leaves.slice(k)),
  );
}

/** Bytewise comparison via decoded-UTF-8 Buffer order (production: charCodeAt loop). */
export function refBytewiseUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export interface RefBatchTree {
  readonly root: string;
  readonly leaves: readonly string[];
}

/** Mirror of buildBatchMerkleTree's CONTRACT: sort bytewise, dedupe, leaf-map, root. */
export function refBuildBatchTree(verdictHashes: readonly string[]): RefBatchTree {
  if (!Array.isArray(verdictHashes) || verdictHashes.length === 0) {
    throw new RangeError('ref: verdictHashes must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const hash of verdictHashes) {
    if (typeof hash !== 'string' || !HEX_32_REF.test(hash)) {
      throw new RangeError('ref: verdictHash must be 32-byte lowercase hex');
    }
    if (seen.has(hash)) throw new RangeError('ref: duplicate verdictHash');
    seen.add(hash);
  }
  const sorted = [...verdictHashes].sort(refBytewiseUtf8Compare);
  const leaves = sorted.map(refBatchLeaf);
  return { root: refSubtreeRoot(leaves), leaves };
}

export interface RefProofCheck {
  /** Leaf count of the batch (tree size). */
  readonly n: number;
  /** Leaf index the proof authenticates. */
  readonly index: number;
  /** The member's leaf digest (BatchLeaf/v1 of its verdict hash). */
  readonly leaf: string;
  /** Sibling hashes, nearest the leaf first (production path order). */
  readonly path: readonly string[];
  /** Expected root. */
  readonly root: string;
}

/**
 * Independent proof verifier, record-and-replay formulation:
 *
 *  1. DESCEND root→leaf over (n, index), recording each split's direction.
 *  2. REPLAY the leaf-first path from the FRONT, folding bottom-up.
 *
 * The production foldRoot instead recurses root→leaf while slicing the path
 * from the back in the same pass. Ordering semantics are re-derived here, so
 * a sibling-order or direction bug in either implementation diverges.
 * Fail-closed: malformed indices/paths return false (never throw).
 */
export function refVerifyBatchProof(check: RefProofCheck): boolean {
  const { n, index, leaf, path, root } = check;
  if (!Number.isSafeInteger(n) || n < 1) return false;
  if (!Number.isSafeInteger(index) || index < 0 || index >= n) return false;
  if (typeof leaf !== 'string' || !HEX_32_REF.test(leaf)) return false;
  if (typeof root !== 'string' || !HEX_32_REF.test(root)) return false;
  if (!Array.isArray(path) || path.some((s) => typeof s !== 'string' || !HEX_32_REF.test(s))) {
    return false;
  }

  // 1. Record the descent chain (root → leaf).
  const ourSideLeft: boolean[] = [];
  let size = n;
  let position = index;
  while (size > 1) {
    const k = refSplit(size);
    if (position < k) {
      ourSideLeft.push(true);
      size = k;
    } else {
      ourSideLeft.push(false);
      position -= k;
      size -= k;
    }
  }

  // 2. Replay leaf → root; path[0] is the deepest (leaf-level) sibling.
  if (path.length !== ourSideLeft.length) return false;
  let accumulator: string = leaf;
  let pathPosition = 0;
  for (let depth = ourSideLeft.length - 1; depth >= 0; depth -= 1) {
    const sibling = path[pathPosition]!;
    pathPosition += 1;
    accumulator = ourSideLeft[depth]!
      ? refBatchNode(accumulator, sibling)
      : refBatchNode(sibling, accumulator);
  }
  return accumulator === root;
}
