// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 3 — Merkle batch / proof sweep at scale.
 *
 * Builds random production batches (n = 1..2048 distinct verdict hashes) and
 * checks, per batch:
 *
 *   M1  the production root equals the INDEPENDENT reference root
 *       (`__tests__/reference/refMerkle.ts`: array-slice RFC-6962 recursion +
 *       `node:crypto` node hashes) — i.e. both the tree SHAPE and the domain
 *       separation re-derive, not a call-through;
 *   M2  leaves are the byte-sorted, duplicate-free input set;
 *   M3  root determinism: rebuilding from a shuffled permutation of the same
 *       hashes reproduces the root exactly (the tree is a function of the SET);
 *   M4  every proof verifies under the independent record-and-replay verifier
 *       — ALL proofs for n ≤ 500, ≥ 10% (evenly strided) for n > 500 — and the
 *       production bulk proof equals the production single-proof builder on a
 *       sample;
 *   M5  the tamper matrix (flip a path sibling, wrong index, wrong leaf,
 *       truncated path, extended path) rejects on 10% of the verified proofs.
 *
 * Batch sizes are drawn log-uniform over 1..2048 (every power-of-two and the
 * unbalanced-split neighbours get fair weight) and the boundary sizes
 * {1,2,3,4,5,7,8,9,1023,1024,1025,2047,2048} are forced first in every run.
 */

import {
  buildBatchMerkleProof,
  buildBatchMerkleProofs,
  buildBatchMerkleTree,
} from '../../batchAttestation';
import { refBuildBatchTree, refVerifyBatchProof } from '../reference/refMerkle';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, type CampaignResult } from './corpus';

const MAX_N = 2048;
const BOUNDARY_SIZES = [1, 2, 3, 4, 5, 7, 8, 9, 1023, 1024, 1025, 2047, 2048] as const;
const HEX_DIGITS = '0123456789abcdef';

/** Distinct 64-char hex labels, generated as `prefix + counter` (no rng draws per char). */
function uniqueHashes(r: () => number, count: number): string[] {
  const prefix = Array.from({ length: 8 }, () => HEX_DIGITS[Math.floor(r() * 16)]).join('');
  // A 56-hex counter guarantees uniqueness without a collision-retry loop.
  return Array.from({ length: count }, (_, i) => `${prefix}${i.toString(16).padStart(56, '0')}`);
}

/** Flip one hex digit (any mutation that provably changes the digest). */
function flipHex(r: () => number, value: string): string {
  const position = int(r, 0, value.length - 1);
  const current = value[position]!;
  const replacement = HEX_DIGITS[(HEX_DIGITS.indexOf(current) + 1 + int(r, 0, 14)) % 16]!;
  return `${value.slice(0, position)}${replacement}${value.slice(position + 1)}`;
}

/** Deterministic Fisher-Yates permutation from the campaign stream. */
function shuffled<T>(r: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = int(r, 0, i);
    const temporary = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temporary;
  }
  return copy;
}

/** Draw a batch size: log-uniform 1..2048, with forced boundaries first. */
function drawSize(r: () => number, index: number): number {
  if (index < BOUNDARY_SIZES.length) return BOUNDARY_SIZES[index]!;
  return Math.min(MAX_N, Math.max(1, Math.round(2 ** (r() * 11))));
}

/** Strided index sample of `count` from `n` (deterministic, covers every subtree). */
function stridedIndices(n: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.min(n - 1, Math.floor((i * n) / count)));
}

/**
 * Run the Merkle campaign.
 *
 * @param opts.size number of batches
 * @param opts.seed campaign seed
 */
export function runMerkleCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('merkle', 'batches', opts.size, seed);
  const r = childRng(seed, 'merkle-campaign');

  const metrics = {
    leavesTotal: 0,
    maxBatch: 0,
    proofsVerified: 0,
    proofsFullyVerifiedBatches: 0,
    tamperedProofs: 0,
    tamperRejections: 0,
    determinismRebuilds: 0,
    singleProofParitySamples: 0,
  };

  for (let index = 0; index < opts.size; index += 1) {
    const n = Math.min(MAX_N, drawSize(r, index));
    const label = `batch#${index}(n=${n})`;
    const hashes = uniqueHashes(r, n);

    let tree: { root: string; leaves: readonly string[] };
    try {
      tree = buildBatchMerkleTree(hashes);
    } catch (err) {
      reporter.fail(label, `buildBatchMerkleTree threw on legal input: ${describe(err)}`);
      continue;
    }

    reporter.equals(label, tree.leaves.length, n, 'M2: leaf count');

    // M1/M2 — independent reference tree (array-slice recursion + node:crypto):
    // same root AND the same leaf SEQUENCE (leaves are BatchLeaf digests in the
    // byte-sorted verdict-hash order, so the leaf array itself is not sorted —
    // the ORDER is what the reference re-derives).
    let referenceTree: { root: string; leaves: readonly string[] };
    try {
      referenceTree = refBuildBatchTree(hashes);
    } catch (err) {
      reporter.fail(label, `reference tree threw: ${describe(err)}`);
      continue;
    }
    reporter.equals(label, tree.root, referenceTree.root, 'M1: production root must equal the independent reference root');
    reporter.equalStrings(label, [...tree.leaves], [...referenceTree.leaves], 'M1: production leaf sequence must equal the reference leaf sequence');
    let uniqueLeaves = true;
    for (let i = 1; i < tree.leaves.length; i += 1) {
      if (tree.leaves[i - 1] === tree.leaves[i]) uniqueLeaves = false;
    }
    reporter.ok(label, uniqueLeaves, 'M2: leaves must be duplicate-free');

    // M3 — root determinism from a shuffled permutation of the same set.
    const permuted = shuffled(r, hashes);
    const rebuilt = buildBatchMerkleTree(permuted).root;
    reporter.equals(label, rebuilt, tree.root, 'M3: root must be a function of the verdict SET (shuffled rebuild)');
    metrics.determinismRebuilds += 1;

    // M4 — proofs.
    let proofs: ReturnType<typeof buildBatchMerkleProofs>;
    try {
      proofs = buildBatchMerkleProofs(tree.leaves);
    } catch (err) {
      reporter.fail(label, `buildBatchMerkleProofs threw: ${describe(err)}`);
      continue;
    }
    reporter.equals(label, proofs.length, n, 'proof count');

    const sampledIndices = n <= 500 ? Array.from({ length: n }, (_, i) => i) : stridedIndices(n, Math.max(1, Math.ceil(n * 0.1)));
    if (n <= 500) metrics.proofsFullyVerifiedBatches += 1;
    let verified = 0;
    for (const proofIndex of sampledIndices) {
      const proof = proofs[proofIndex]!;
      const verifiedProof = refVerifyBatchProof({
        n,
        index: proof.index,
        leaf: proof.verdictHash,
        path: proof.path,
        root: tree.root,
      });
      reporter.ok(
        label,
        verifiedProof,
        `M4: proof #${proofIndex} must verify under the independent verifier (path length ${proof.path.length})`,
      );
      if (!verifiedProof) continue;
      verified += 1;
      metrics.proofsVerified += 1;

      // Production single-proof builder must agree with the bulk builder.
      if (proofIndex % Math.max(1, Math.floor(n / 8)) === 0) {
        const single = buildBatchMerkleProof(tree.leaves, proofIndex);
        reporter.equalStrings(label, [...single.path], [...proof.path], `M4: bulk vs single proof path at index ${proofIndex}`);
        reporter.equals(label, single.verdictHash, proof.verdictHash, `M4: bulk vs single proof leaf at index ${proofIndex}`);
        metrics.singleProofParitySamples += 1;
      }

      // M5 — tamper matrix on 10% of the verified proofs.
      if (proofIndex % 10 !== 0) continue;
      const mutations: Array<{ name: string; check: { n: number; index: number; leaf: string; path: readonly string[]; root: string } }> = [];
      if (proof.path.length > 0) {
        const flippedPath = [...proof.path];
        const mutateAt = int(r, 0, flippedPath.length - 1);
        flippedPath[mutateAt] = flipHex(r, flippedPath[mutateAt]!);
        mutations.push({ name: 'path-flip', check: { n, index: proof.index, leaf: proof.verdictHash, path: flippedPath, root: tree.root } });
        mutations.push({ name: 'path-truncate', check: { n, index: proof.index, leaf: proof.verdictHash, path: proof.path.slice(0, -1), root: tree.root } });
        mutations.push({ name: 'path-extend', check: { n, index: proof.index, leaf: proof.verdictHash, path: [...proof.path, 'ff'.repeat(32)], root: tree.root } });
      }
      if (n > 1) {
        mutations.push({ name: 'wrong-index', check: { n, index: (proof.index + 1) % n, leaf: proof.verdictHash, path: proof.path, root: tree.root } });
      }
      mutations.push({ name: 'wrong-leaf', check: { n, index: proof.index, leaf: flipHex(r, proof.verdictHash), path: proof.path, root: tree.root } });

      for (const mutation of mutations) {
        metrics.tamperedProofs += 1;
        if (refVerifyBatchProof(mutation.check)) {
          reporter.fail(label, `M5: tampered proof (${mutation.name}) at index ${proofIndex} was ACCEPTED`);
        } else {
          metrics.tamperRejections += 1;
          reporter.check();
        }
      }
    }
    reporter.ok(label, verified === sampledIndices.length, `M4: expected ${sampledIndices.length} verified proofs, got ${verified}`);

    metrics.leavesTotal += n;
    metrics.maxBatch = Math.max(metrics.maxBatch, n);
  }

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      ...metrics,
      meanBatch: Math.round((metrics.leavesTotal / Math.max(1, opts.size)) * 100) / 100,
      batchesPerSecond: Math.round((opts.size / Math.max(1, wallMs)) * 1000),
    },
    [
      'sizes: log-uniform 1..2048 with forced boundaries 1,2,3,4,5,7,8,9,1023,1024,1025,2047,2048',
      'proof policy: ALL proofs for n <= 500, >= 10% evenly strided for n > 500',
      'tamper matrix applied to every 10th verified proof (path flip/truncate/extend, wrong index, wrong leaf)',
    ],
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
