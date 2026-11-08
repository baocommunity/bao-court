// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  BAO_COURT_BATCH_ATTESTATION_KIND,
  BATCH_NODE_DOMAIN,
  BatchAttestationError,
  buildBatchAttestationEvent,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
  hashBatchManifest,
  validateBatchAttestationEvent,
  verifyCaseInBatch,
} from '../batchAttestation';
import { hashCourtVerdict } from '../courtVoteMachine';
import { CanonicalWriter } from '../courtSession';

/**
 * Independent BatchNode/v1 re-implementation so proof-folding tests do not
 * reuse the module's private tree code.
 */
function nodeHash(left: string, right: string): string {
  const writer = new CanonicalWriter();
  writer.u8(0x01);
  writer.hex(left);
  writer.hex(right);
  const encoded = writer.finish();
  const prefix = new TextEncoder().encode(BATCH_NODE_DOMAIN);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/** RFC-6962 split point, mirroring the published tree shape. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 <= n - 1) k *= 2;
  return k;
}

/** Fold a proof independently: the module stores paths deepest-sibling-first,
 * so fold recursively from the leaf up, taking each level's sibling from the
 * path tail while (size, index) descend the RFC-6962 split from the root. */
function foldProof(
  proof: { readonly index: number; readonly verdictHash: string; readonly path: readonly string[] },
  count: number,
): string {
  function rec(path: readonly string[], size: number, index: number, acc: string): string {
    if (size === 1) return acc;
    const k = splitPoint(size);
    const sibling = path[path.length - 1]!;
    const rest = path.slice(0, -1);
    if (index < k) return nodeHash(rec(rest, k, index, acc), sibling);
    return nodeHash(sibling, rec(rest, size - k, index - k, acc));
  }
  return rec(proof.path, count, proof.index, proof.verdictHash);
}

function caseHashFor(session: string, outcome: string, index: number): string {
  return hashCourtVerdict({
    sessionHash: session,
    outcome,
    supportingEventIds: [
      ('aa'.repeat(8) + index.toString(16).padStart(4, '0')).padEnd(64, '0'),
    ],
  });
}

function hexLeaves(count: number, session = '11'.repeat(32)): string[] {
  return Array.from({ length: count }, (_, i) => caseHashFor(session, 'yes', i));
}

function signedBatchEvent(params: {
  readonly epoch: number;
  readonly cohortPubkey: string;
  readonly batchIndex: number;
  readonly count: number;
  readonly root: string;
  readonly finalizedAtSec: number;
  readonly privateKey: Uint8Array;
  readonly createdAt?: number;
  readonly environment?: string;
}) {
  const manifest = hashBatchManifest({
    epoch: params.epoch,
    cohortPubkey: params.cohortPubkey,
    batchIndex: params.batchIndex,
    count: params.count,
    root: params.root,
    finalizedAtSec: params.finalizedAtSec,
  });
  const signature = bytesToHex(
    schnorr.sign(hexToBytes(manifest), params.privateKey, hexToBytes('07'.repeat(32))),
  );
  return buildBatchAttestationEvent({
    epoch: params.epoch,
    cohortPubkey: params.cohortPubkey,
    batchIndex: params.batchIndex,
    count: params.count,
    root: params.root,
    finalizedAtSec: params.finalizedAtSec,
    signature,
    createdAt: params.createdAt ?? params.finalizedAtSec,
    environment: params.environment,
  });
}

const PRIVATE_KEY = hexToBytes('aa'.repeat(32));
const COHORT = bytesToHex(schnorr.getPublicKey(PRIVATE_KEY));
const OTHER_COHORT = bytesToHex(schnorr.getPublicKey(hexToBytes('bb'.repeat(32))));

describe('Batch Merkle tree', () => {
  it('is deterministic — same input yields the same root twice', () => {
    const hashes = hexLeaves(7);
    const first = buildBatchMerkleTree(hashes);
    const second = buildBatchMerkleTree(hashes);
    expect(first.root).toBe(second.root);
    expect(first.leaves).toEqual(second.leaves);
  });

  it('is independent of input order (canonical bytewise sort)', () => {
    const hashes = hexLeaves(6);
    expect(buildBatchMerkleTree([...hashes].reverse()).root).toBe(
      buildBatchMerkleTree(hashes).root,
    );
  });

  it('covers n=1..8 and every index proof verifies against the root', () => {
    for (let n = 1; n <= 8; n += 1) {
      const hashes = hexLeaves(n);
      const { root, leaves } = buildBatchMerkleTree(hashes);
      expect(leaves.length).toBe(n);
      if (n === 1) expect(root).toBe(leaves[0]);
      for (let i = 0; i < n; i += 1) {
        const proof = buildBatchMerkleProof(leaves, i);
        expect(proof.index).toBe(i);
        expect(proof.verdictHash).toBe(leaves[i]);
        expect(foldProof(proof, n)).toBe(root);
      }
    }
  });

  it('covers n=63/64/65 roots with every index proof verifying', () => {
    for (const n of [63, 64, 65]) {
      const hashes = hexLeaves(n);
      const { root, leaves } = buildBatchMerkleTree(hashes);
      expect(buildBatchMerkleTree(hashes).root).toBe(root);
      for (let i = 0; i < n; i += 1) {
        expect(foldProof(buildBatchMerkleProof(leaves, i), n)).toBe(root);
      }
    }
  });

  it('keeps unbalanced shapes deterministic and paths correctly shaped', () => {
    const five = hexLeaves(5);
    expect(buildBatchMerkleTree(five).root).toBe(buildBatchMerkleTree(five).root);
    // Index 4 of an n=5 tree sits in a lone right subtree: path length 1.
    const fiveTree = buildBatchMerkleTree(five);
    expect(buildBatchMerkleProof(fiveTree.leaves, 4).path.length).toBe(1);
    expect(foldProof(buildBatchMerkleProof(fiveTree.leaves, 4), 5)).toBe(fiveTree.root);

    const sixtyFive = hexLeaves(65);
    const tree = buildBatchMerkleTree(sixtyFive);
    expect(tree.root).toBe(buildBatchMerkleTree(sixtyFive).root);
    expect(buildBatchMerkleProof(tree.leaves, 64).path.length).toBe(1);
    expect(buildBatchMerkleProof(tree.leaves, 0).path.length).toBe(7);
  });

  it('rejects duplicate verdict hashes', () => {
    const hashes = hexLeaves(4);
    expect(() => buildBatchMerkleTree([hashes[0]!, hashes[1]!, hashes[0]!])).toThrow(
      BatchAttestationError,
    );
    expect(() => buildBatchMerkleTree([hashes[0]!, hashes[1]!, hashes[0]!])).toThrow(
      /duplicate/,
    );
  });

  it('rejects malformed hex and empty input', () => {
    expect(() => buildBatchMerkleTree([])).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleTree(['ZZ'.repeat(32)])).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleTree(['AA'.repeat(32)])).toThrow(/lowercase hex/);
    expect(() => buildBatchMerkleTree(['ab'.repeat(31)])).toThrow(/32-byte lowercase hex/);
  });

  it('bounds-checks proof indices and rejects malformed leaf arrays', () => {
    const { leaves } = buildBatchMerkleTree(hexLeaves(4));
    expect(() => buildBatchMerkleProof(leaves, 4)).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleProof(leaves, -1)).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleProof(leaves, 1.5)).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleProof([], 0)).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleProof(['nothex'], 0)).toThrow(BatchAttestationError);
  });
});

describe('Batch manifest hash', () => {
  const base = {
    epoch: 3,
    cohortPubkey: COHORT,
    batchIndex: 1,
    count: 64,
    root: 'ab'.repeat(32),
    finalizedAtSec: 1_700_000_000,
  };

  it('is deterministic and field-sensitive', () => {
    expect(hashBatchManifest(base)).toBe(hashBatchManifest({ ...base }));
    expect(hashBatchManifest(base)).not.toBe(hashBatchManifest({ ...base, epoch: 4 }));
    expect(hashBatchManifest(base)).not.toBe(
      hashBatchManifest({ ...base, finalizedAtSec: base.finalizedAtSec + 1 }),
    );
    expect(hashBatchManifest(base)).not.toBe(hashBatchManifest({ ...base, count: 63 }));
    expect(hashBatchManifest(base)).not.toBe(
      hashBatchManifest({ ...base, batchIndex: 2 }),
    );
  });

  it('throws on malformed fields', () => {
    expect(() => hashBatchManifest({ ...base, epoch: -1 })).toThrow(BatchAttestationError);
    expect(() => hashBatchManifest({ ...base, epoch: 1.5 })).toThrow(BatchAttestationError);
    expect(() => hashBatchManifest({ ...base, batchIndex: -3 })).toThrow(BatchAttestationError);
    expect(() => hashBatchManifest({ ...base, count: 2.5 })).toThrow(BatchAttestationError);
    expect(() => hashBatchManifest({ ...base, cohortPubkey: 'cd'.repeat(31) })).toThrow(
      BatchAttestationError,
    );
    expect(() => hashBatchManifest({ ...base, root: 'ef'.repeat(33) })).toThrow(
      BatchAttestationError,
    );
    expect(() => hashBatchManifest({ ...base, finalizedAtSec: 0.1 })).toThrow(
      BatchAttestationError,
    );
    expect(() =>
      hashBatchManifest({ ...base, finalizedAtSec: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(BatchAttestationError);
  });
});

describe('Batch attestation event', () => {
  const tree = buildBatchMerkleTree(hexLeaves(4));

  it('produces the exact tag shape and a deterministic id', () => {
    const event = signedBatchEvent({
      epoch: 2,
      cohortPubkey: COHORT,
      batchIndex: 0,
      count: 4,
      root: tree.root,
      finalizedAtSec: 1_700_000_100,
      privateKey: PRIVATE_KEY,
    });
    expect(event.kind).toBe(BAO_COURT_BATCH_ATTESTATION_KIND);
    expect(event.pubkey).toBe(COHORT);
    const sig = event.tags.find((t) => t[0] === 'sig')![1];
    expect(event.tags).toEqual([
      ['p', COHORT],
      ['sig', sig],
      ['nonce', sig.slice(0, 64)],
      ['epoch', '2'],
      ['cohort', COHORT],
      ['batch', '0'],
      ['count', '4'],
      ['root', tree.root],
    ]);
    expect(JSON.parse(event.content)).toEqual({
      root: tree.root,
      count: 4,
      epoch: 2,
      batch: 0,
    });
    const again = signedBatchEvent({
      epoch: 2,
      cohortPubkey: COHORT,
      batchIndex: 0,
      count: 4,
      root: tree.root,
      finalizedAtSec: 1_700_000_100,
      privateKey: PRIVATE_KEY,
    });
    expect(again.id).toBe(event.id);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('appends an env tag only when an environment is provided', () => {
    const event = signedBatchEvent({
      epoch: 1,
      cohortPubkey: COHORT,
      batchIndex: 0,
      count: 1,
      root: tree.root,
      finalizedAtSec: 1_700_000_100,
      privateKey: PRIVATE_KEY,
      environment: 'signet',
    });
    expect(event.tags.find((t) => t[0] === 'env')?.[1]).toBe('signet');
    const plain = signedBatchEvent({
      epoch: 1,
      cohortPubkey: COHORT,
      batchIndex: 0,
      count: 1,
      root: tree.root,
      finalizedAtSec: 1_700_000_100,
      privateKey: PRIVATE_KEY,
    });
    expect(plain.tags.find((t) => t[0] === 'env')).toBeUndefined();
  });
});

describe('Batch attestation validation', () => {
  const tree = buildBatchMerkleTree(hexLeaves(4, '33'.repeat(32)));
  const manifestParams = {
    epoch: 5,
    cohortPubkey: COHORT,
    batchIndex: 2,
    count: 4,
    root: tree.root,
    finalizedAtSec: 1_700_000_200,
  };

  function validEvent() {
    return signedBatchEvent({ ...manifestParams, privateKey: PRIVATE_KEY });
  }

  it('accepts a correctly signed batch attestation', () => {
    const result = validateBatchAttestationEvent(validEvent());
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects a wrong group pubkey pin', () => {
    const result = validateBatchAttestationEvent(validEvent(), {
      expectedGroupPubkey: OTHER_COHORT,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Group pubkey mismatch/);
  });

  it('rejects a wrong epoch pin', () => {
    const result = validateBatchAttestationEvent(validEvent(), { expectedEpoch: 6 });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Epoch mismatch/);
  });

  it('rejects a wrong cohort pin', () => {
    const result = validateBatchAttestationEvent(validEvent(), {
      expectedCohort: OTHER_COHORT,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Cohort mismatch/);
  });

  it('rejects a tampered signature', () => {
    const event = validEvent();
    const sigTag = event.tags.find((t) => t[0] === 'sig')!;
    sigTag[1] = (sigTag[1]!.startsWith('aa') ? 'bb' : 'aa') + sigTag[1]!.slice(2);
    const result = validateBatchAttestationEvent(event);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Schnorr|Nonce/i);
  });

  it('rejects a nonce tag that does not match the signature', () => {
    const event = validEvent();
    const nonceTag = event.tags.find((t) => t[0] === 'nonce')!;
    nonceTag[1] = 'ff'.repeat(32);
    const result = validateBatchAttestationEvent(event);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Nonce tag does not match signature/);
  });

  it('rejects a wrong kind', () => {
    const event = validEvent();
    const result = validateBatchAttestationEvent({ ...event, kind: 39007 });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Kind 39018/);
  });

  it('rejects tampered tags and content (consistency + id recompute)', () => {
    const badCount = validEvent();
    const countTag = badCount.tags.find((t) => t[0] === 'count')!;
    countTag[1] = '5';
    expect(validateBatchAttestationEvent(badCount).valid).toBe(false);

    const badRoot = validEvent();
    const rootTag = badRoot.tags.find((t) => t[0] === 'root')!;
    rootTag[1] = 'cd'.repeat(32);
    expect(validateBatchAttestationEvent(badRoot).valid).toBe(false);

    const badId = validEvent();
    expect(
      validateBatchAttestationEvent({ ...badId, id: 'ee'.repeat(32) }).valid,
    ).toBe(false);
  });
});

describe('verifyCaseInBatch end-to-end', () => {
  const SESSION = '44'.repeat(32);
  const OTHER_SESSION = '55'.repeat(32);
  const hashes = hexLeaves(5, SESSION);
  const tree = buildBatchMerkleTree(hashes);
  const finalizedAtSec = 1_700_000_300;

  /** Sorted-batch position of case number `caseIdx` (0-based case order). */
  function positionOf(caseIdx: number): number {
    const sorted = hashes
      .map((hash, caseIndex) => ({ hash, caseIndex }))
      .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return sorted.findIndex((entry) => entry.caseIndex === caseIdx);
  }

  function batchEventForRoot(root: string, cohort = COHORT, privateKey = PRIVATE_KEY) {
    return signedBatchEvent({
      epoch: 7,
      cohortPubkey: cohort,
      batchIndex: 0,
      count: 5,
      root,
      finalizedAtSec,
      privateKey,
    });
  }

  function caseInputFor(caseIdx: number) {
    // Proof indices are positions in the canonically sorted batch, so map the
    // case's position in the sorted order (the realistic prover flow).
    return {
      sessionHash: SESSION,
      outcome: 'yes',
      supportingEventIds: [
        ('aa'.repeat(8) + caseIdx.toString(16).padStart(4, '0')).padEnd(64, '0'),
      ],
      proof: buildBatchMerkleProof(tree.leaves, positionOf(caseIdx)),
    };
  }

  it('verifies a genuine case inside a signed batch', () => {
    const result = verifyCaseInBatch(batchEventForRoot(tree.root), caseInputFor(2));
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails a case from another batch (wrong leaf)', () => {
    const otherTree = buildBatchMerkleTree(hexLeaves(5, OTHER_SESSION));
    const result = verifyCaseInBatch(batchEventForRoot(tree.root), {
      sessionHash: OTHER_SESSION,
      outcome: 'yes',
      supportingEventIds: [
        ('aa'.repeat(8) + '2').padStart(64, '0'),
      ],
      proof: buildBatchMerkleProof(otherTree.leaves, 2),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/leaf does not match/);
  });

  it('fails a tampered outcome', () => {
    const result = verifyCaseInBatch(batchEventForRoot(tree.root), {
      ...caseInputFor(2),
      outcome: 'no',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it('fails a tampered sessionHash', () => {
    const result = verifyCaseInBatch(batchEventForRoot(tree.root), {
      ...caseInputFor(2),
      sessionHash: '66'.repeat(32),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it('fails a tampered supporting event id', () => {
    const result = verifyCaseInBatch(batchEventForRoot(tree.root), {
      ...caseInputFor(2),
      supportingEventIds: ['bb'.repeat(32)],
    });
    expect(result.valid).toBe(false);
  });

  it('fails a tampered sibling byte', () => {
    const event = batchEventForRoot(tree.root);
    const input = caseInputFor(2);
    const proof = { ...input.proof, path: [...input.proof.path] };
    proof.path[0] = (proof.path[0]![0] === 'a' ? 'b' : 'a') + proof.path[0]!.slice(1);
    const result = verifyCaseInBatch(event, { ...input, proof });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/root/);
  });

  it('fails a wrong index', () => {
    const event = batchEventForRoot(tree.root);
    const input = caseInputFor(2);
    const result = verifyCaseInBatch(event, {
      ...input,
      proof: { ...input.proof, index: 3 },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/path length|root/);
  });

  it('fails a wrong path length', () => {
    const event = batchEventForRoot(tree.root);
    const input = caseInputFor(2);
    const result = verifyCaseInBatch(event, {
      ...input,
      proof: { ...input.proof, path: input.proof.path.slice(1) },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/path length/);
  });

  it('accepts another cohort self-consistent batch but rejects it under a pin', () => {
    const otherPrivate = hexToBytes('cc'.repeat(32));
    const otherCohort = bytesToHex(schnorr.getPublicKey(otherPrivate));
    const event = batchEventForRoot(tree.root, otherCohort, otherPrivate);
    expect(verifyCaseInBatch(event, caseInputFor(2)).valid).toBe(true);

    const mismatched = verifyCaseInBatch(event, caseInputFor(2), {
      expectedCohort: COHORT,
    });
    expect(mismatched.valid).toBe(false);
    expect(mismatched.reason).toMatch(/Cohort mismatch/);
  });

  it('throws for malformed call arguments but never for tampered data', () => {
    const event = batchEventForRoot(tree.root);
    expect(() => verifyCaseInBatch(event, null as never)).toThrow(BatchAttestationError);
    expect(() =>
      verifyCaseInBatch(event, { ...caseInputFor(2), proof: { index: 0 } as never }),
    ).toThrow(BatchAttestationError);
    // A missing tag on an otherwise-shaped event is a verification failure.
    const tagless = { ...event, tags: event.tags.filter((t) => t[0] !== 'root') };
    expect(verifyCaseInBatch(tagless, caseInputFor(2)).valid).toBe(false);
  });
});
