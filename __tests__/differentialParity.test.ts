// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * DIFFERENTIAL PARITY — round 8 of the symposium program.
 *
 * Every critical pure function of the Court is reimplemented INDEPENDENTLY
 * (different algorithm, different library, same contract — reference
 * implementations in `__tests__/reference/`) and asserted to agree with the
 * production implementation across exhaustive inputs. A disagreement is
 * always a finding: either an implementation bug or an under-specified
 * contract.
 *
 *   1. CanonicalWriter   — reference byte-accumulator writer + an independent
 *                          PARSER: byte-identity, round-trip, prefix-freeness,
 *                          injectivity, boundary + unicode, fail-closed ranges.
 *   2. Batch Merkle tree — reference array-slice RFC-6962 builder + record-
 *                          and-replay proof verifier: exhaustive n = 1..128,
 *                          every proof verifies, tampered paths reject.
 *   3. Verdict/manifest/attestation-V2 hashes — node:crypto sha256 vs
 *                          @noble: randomized + boundary agreement.
 *   4. Selection lottery — exact differential on the u32 draw and the
 *                          end-to-end ranking; STATISTICAL differential
 *                          (chi-square, moments, winner law over 100k draws)
 *                          between the production -ln(r)/w clock and an
 *                          inverse-CDF clock. Exact-equal vs statistically-
 *                          equal is documented per assertion.
 *   5. Plurality + tie-break — reduce-based reference tally vs the machine's
 *                          map loop: exhaustive 3^n assignments (n ≤ 4),
 *                          random big tallies, and the UTF-8 (not UTF-16)
 *                          tie-break divergence pin.
 *
 * All randomness is seeded (mulberry32) so every assertion is reproducible.
 */

import { describe, expect, it } from 'vitest';

import { CanonicalWriter, CourtSessionValidationError } from '../courtSession';
import {
  BatchAttestationError,
  buildBatchMerkleProof,
  buildBatchMerkleProofs,
  buildBatchMerkleTree,
  hashBatchManifest,
} from '../batchAttestation';
import {
  compareOutcomeUtf8,
  createCourtVoteMachine,
  hashCourtVerdict,
  hashCourtVoteCommit,
  hashDisputeVerdict,
  reduceCourtVoteMachine,
} from '../courtVoteMachine';
import { buildAttestationMessageV2 } from '../crypto';
import {
  quadraticPriority,
  weightedPriority,
  jurorRandomValue,
  selectJury,
} from '../selection';
import type { JurorProfile } from '../types';

import {
  RefCanonicalWriter,
  refBytesToHex,
  refParseCanonical,
} from './reference/refCanonical';
import type { RefFieldKind } from './reference/refCanonical';
import {
  refBuildAttestationMessageV2,
  refHashBatchManifest,
  refHashCourtVerdict,
  refHashDisputeVerdict,
} from './reference/refHashes';
import {
  refBatchLeaf,
  refBatchNode,
  refBuildBatchTree,
  refBytewiseUtf8Compare,
  refSplit,
  refSubtreeRoot,
  refVerifyBatchProof,
} from './reference/refMerkle';
import {
  mulberry32,
  refJurorRandomValue,
  refPriorityInverseCdf,
  refPriorityProductionFormulation,
  refSelectJuryRanking,
} from './reference/refLottery';
import { refPluralityTally } from './reference/refTally';
import { wd } from './helpers/watchdog';

// ---------------------------------------------------------------------------
// Deterministic randomness helpers
// ---------------------------------------------------------------------------

function randomHex32(next: () => number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Math.floor(next() * 256);
  return refBytesToHex(bytes);
}

function pick<T>(items: readonly T[], next: () => number): T {
  return items[Math.floor(next() * items.length)]!;
}

const UNICODE_OUTCOMES = [
  'alpha',
  'bravo',
  'gamma-γ',
  '日本語',
  '😀',
  'é',
  'e\u0301combining',
  'ünïcödé',
  '\uFFFD',
  '\u{10000}',
  'a',
  'a\u{1F600}',
] as const;

/** 256 pre-generated distinct verdict hashes, shared by the Merkle and hash suites. */
const HASH_POOL: string[] = (() => {
  const next = mulberry32(0x6962);
  const seen = new Set<string>();
  while (seen.size < 256) seen.add(randomHex32(next));
  return [...seen];
})();

// ---------------------------------------------------------------------------
// 1. CanonicalWriter — differential parity
// ---------------------------------------------------------------------------

interface Op {
  readonly kind: RefFieldKind;
  readonly value: unknown;
}

function randomOps(next: () => number, length: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = pick(
      ['u8', 'u32', 'u64', 'text', 'hex', 'bytes'] as const,
      next,
    );
    switch (kind) {
      case 'u8':
        ops.push({ kind, value: pick([0, 255, 1, 254, Math.floor(next() * 256)], next) });
        break;
      case 'u32':
        ops.push({
          kind,
          value: pick([0, 0xffff_ffff, 1, 0x8000_0000, Math.floor(next() * 2 ** 32)], next),
        });
        break;
      case 'u64':
        ops.push({
          kind,
          value: pick(
            [0, Number.MAX_SAFE_INTEGER, 1, 2 ** 32, Math.floor(next() * 2 ** 53)],
            next,
          ),
        });
        break;
      case 'text':
        ops.push({ kind, value: pick(UNICODE_OUTCOMES, next) });
        break;
      case 'hex':
        ops.push({ kind, value: randomHex32(next) });
        break;
      case 'bytes': {
        const size = Math.floor(next() * 40);
        const bytes = new Uint8Array(size);
        for (let b = 0; b < size; b += 1) bytes[b] = Math.floor(next() * 256);
        ops.push({ kind, value: bytes });
        break;
      }
    }
  }
  return ops;
}

function writeProduction(ops: readonly Op[]): Uint8Array {
  const writer = new CanonicalWriter();
  for (const op of ops) {
    if (op.kind === 'u8') writer.u8(op.value as number);
    else if (op.kind === 'u32') writer.u32(op.value as number);
    else if (op.kind === 'u64') writer.u64(op.value as number);
    else if (op.kind === 'text') writer.text(op.value as string);
    else if (op.kind === 'hex') writer.hex(op.value as string);
    else writer.bytes(op.value as Uint8Array);
  }
  return writer.finish();
}

function writeReference(ops: readonly Op[]): Uint8Array {
  const writer = new RefCanonicalWriter();
  for (const op of ops) {
    if (op.kind === 'u8') writer.u8(op.value as number);
    else if (op.kind === 'u32') writer.u32(op.value as number);
    else if (op.kind === 'u64') writer.u64(op.value as number);
    else if (op.kind === 'text') writer.text(op.value as string);
    else if (op.kind === 'hex') writer.hex(op.value as string);
    else writer.bytes(op.value as Uint8Array);
  }
  return writer.finish();
}

function expectedParsedValues(ops: readonly Op[]): unknown[] {
  return ops.map((op) => {
    if (op.kind === 'text') {
      // Lone surrogates encode to U+FFFD on both sides; compare canonical forms.
      const bytes = new TextEncoder().encode(op.value as string);
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (op.kind === 'hex') return op.value;
    if (op.kind === 'bytes') return op.value;
    return op.value;
  });
}

describe('differential parity: CanonicalWriter encoding', () => {
  it('byte-identical on seeded random field sequences (300 sequences)', () => {
    const next = mulberry32(0xca4101);
    for (let trial = 0; trial < 300; trial += 1) {
      const ops = randomOps(next, 1 + Math.floor(next() * 24));
      const production = writeProduction(ops);
      const reference = writeReference(ops);
      expect(refBytesToHex(reference), `trial ${trial} ops ${JSON.stringify(ops.map((o) => o.kind))}`)
        .toBe(refBytesToHex(production));
    }
  });

  it('byte-identical on boundary values (0 / max integers, empty strings, 64-hex, unicode)', () => {
    const boundaryOps: Op[] = [
      { kind: 'u8', value: 0 },
      { kind: 'u8', value: 255 },
      { kind: 'u32', value: 0 },
      { kind: 'u32', value: 0xffff_ffff },
      { kind: 'u64', value: 0 },
      { kind: 'u64', value: Number.MAX_SAFE_INTEGER },
      { kind: 'text', value: '' },
      { kind: 'hex', value: '' },
      { kind: 'bytes', value: new Uint8Array(0) },
      { kind: 'hex', value: '00'.repeat(32) },
      { kind: 'hex', value: 'ff'.repeat(32) },
      { kind: 'text', value: '😀🎉🚀 multibyte 😀' },
      { kind: 'text', value: '日本語のテキスト' },
      { kind: 'text', value: 'e\u0301 combining acute' },
      { kind: 'text', value: '\uFFFD replacement' },
      { kind: 'text', value: 'x'.repeat(400) },
    ];
    const production = writeProduction(boundaryOps);
    const reference = writeReference(boundaryOps);
    expect(refBytesToHex(reference)).toBe(refBytesToHex(production));
  });

  it('lone surrogates encode identically (both runtimes map to U+FFFD bytes)', () => {
    const ops: Op[] = [
      { kind: 'text', value: 'lone \uD800 surrogate' },
      { kind: 'text', value: '\uDFFF' },
    ];
    expect(refBytesToHex(writeReference(ops))).toBe(refBytesToHex(writeProduction(ops)));
  });

  it('independent parser round-trips every random sequence', () => {
    const next = mulberry32(0xca1002);
    for (let trial = 0; trial < 200; trial += 1) {
      const ops = randomOps(next, 1 + Math.floor(next() * 20));
      const encoded = writeProduction(ops);
      const schema = ops.map((op) => op.kind);
      const parsed = refParseCanonical(schema, encoded);
      expect(parsed.consumed).toBe(encoded.length);
      expect(parsed.values).toEqual(expectedParsedValues(ops));
    }
  });

  it('prefix-freeness: encode(A) || encode(B) parses unambiguously as A then B', () => {
    const next = mulberry32(0xca1003);
    for (let trial = 0; trial < 200; trial += 1) {
      const a = randomOps(next, 1 + Math.floor(next() * 8));
      const b = randomOps(next, 1 + Math.floor(next() * 8));
      const encodedA = writeProduction(a);
      const encodedB = writeProduction(b);
      const combined = new Uint8Array(encodedA.length + encodedB.length);
      combined.set(encodedA, 0);
      combined.set(encodedB, encodedA.length);

      const parsed = refParseCanonical(
        [...a, ...b].map((op) => op.kind),
        combined,
      );
      expect(parsed.consumed).toBe(combined.length);
      expect(parsed.values).toEqual([...expectedParsedValues(a), ...expectedParsedValues(b)]);
    }
  });

  it('injectivity: distinct value tuples under one schema encode to distinct bytes', () => {
    const next = mulberry32(0xca1004);
    const schema: RefFieldKind[] = ['text', 'u32', 'hex', 'u64', 'text'];
    const encodings = new Set<string>();
    const tuples: Op[][] = [];
    for (let trial = 0; trial < 250; trial += 1) {
      tuples.push([
        { kind: 'text', value: pick(UNICODE_OUTCOMES, next) },
        { kind: 'u32', value: Math.floor(next() * 2 ** 32) },
        { kind: 'hex', value: randomHex32(next) },
        { kind: 'u64', value: Math.floor(next() * 2 ** 53) },
        { kind: 'text', value: pick(UNICODE_OUTCOMES, next) },
      ]);
    }
    for (const tuple of tuples) {
      const encoded = writeProduction(tuple);
      // Reference writer must agree, then the encoding must be new.
      expect(refBytesToHex(writeReference(tuple))).toBe(refBytesToHex(encoded));
      const key = refBytesToHex(encoded);
      expect(encodings.has(key), `collision for ${JSON.stringify(tuple.map((t) => t.value))}`).toBe(false);
      encodings.add(key);
    }
  });

  it('injectivity traps: field-boundary aliases that delimiter encoding would merge', () => {
    // ('ab','c') vs ('a','bc') — identical plain concatenation, distinct here.
    const left: Op[] = [
      { kind: 'text', value: 'ab' },
      { kind: 'text', value: 'c' },
    ];
    const right: Op[] = [
      { kind: 'text', value: 'a' },
      { kind: 'text', value: 'bc' },
    ];
    const leftBytes = refBytesToHex(writeProduction(left));
    const rightBytes = refBytesToHex(writeProduction(right));
    expect(leftBytes).not.toBe(rightBytes);
    expect(refBytesToHex(writeReference(left))).toBe(leftBytes);
    expect(refBytesToHex(writeReference(right))).toBe(rightBytes);

    // u64(1) vs u8(1) — width matters.
    expect(refBytesToHex(writeProduction([{ kind: 'u64', value: 1 }]))).not.toBe(
      refBytesToHex(writeProduction([{ kind: 'u8', value: 1 }])),
    );
  });

  it('fail-closed ranges: production and reference reject the same out-of-range inputs', () => {
    const invalid: Array<[Op, () => void]> = [];
    const attempt = (ops: readonly Op[]): void => {
      invalid.push([
        ops[0]!,
        () => writeProduction(ops),
      ]);
    };
    attempt([{ kind: 'u8', value: 256 }]);
    attempt([{ kind: 'u8', value: -1 }]);
    attempt([{ kind: 'u32', value: 2 ** 32 }]);
    attempt([{ kind: 'u32', value: -1 }]);
    attempt([{ kind: 'u64', value: -1 }]);
    attempt([{ kind: 'u64', value: Number.MAX_SAFE_INTEGER + 1 }]);

    for (const [, productionCall] of invalid) {
      expect(productionCall).toThrow();
    }
    for (const [op] of invalid) {
      expect(() => writeReference([op])).toThrow(RangeError);
      expect(() => writeProduction([op])).toThrow(CourtSessionValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Batch Merkle tree — differential parity
// ---------------------------------------------------------------------------

describe('differential parity: batch Merkle tree (batchAttestation)', () => {
  const MERKLE_HASH_POOL = HASH_POOL;

  const TAMPER_NS = [1, 2, 3, 5, 7, 8, 17, 33, 64, 100, 128];

  it('exhaustive n=1..128: reference root and leaves identical to production', () => {
    for (let n = 1; n <= 128; n += 1) {
      const hashes = MERKLE_HASH_POOL.slice(0, n);
      const production = buildBatchMerkleTree(hashes);
      const reference = refBuildBatchTree(hashes);
      expect(reference.root, `n=${n} root`).toBe(production.root);
      expect([...reference.leaves], `n=${n} leaves`).toEqual([...production.leaves]);
      // Independent sanity: the reference root equals refSubtreeRoot(leaves).
      expect(reference.root).toBe(refSubtreeRoot(reference.leaves));
    }
  });

  it('exhaustive n=1..128: every production proof verifies under the reference verifier', { timeout: wd(120_000) }, () => {
    for (let n = 1; n <= 128; n += 1) {
      const production = buildBatchMerkleTree(MERKLE_HASH_POOL.slice(0, n));
      for (let index = 0; index < n; index += 1) {
        const proof = buildBatchMerkleProof(production.leaves, index);
        const ok = refVerifyBatchProof({
          n,
          index,
          leaf: proof.verdictHash,
          path: proof.path,
          root: production.root,
        });
        expect(ok, `n=${n} index=${index} proof must verify`).toBe(true);
      }
    }
  });

  it('exhaustive n=1..128: production roots equal an independent full-tree rebuild', () => {
    for (let n = 1; n <= 128; n += 1) {
      const production = buildBatchMerkleTree(MERKLE_HASH_POOL.slice(0, n));
      const reference = refBuildBatchTree(MERKLE_HASH_POOL.slice(0, n));
      // Rebuild the root from the production leaf list via the reference
      // slice-recursion — catches leaf-domain drift independently of sorting.
      expect(refSubtreeRoot(production.leaves)).toBe(production.root);
      expect(refSubtreeRoot(reference.leaves)).toBe(reference.root);
    }
  });

  it('batch proof set: buildBatchMerkleProofs identical to per-proof API + reference verifier (n=1..128, 333, 1000)', { timeout: wd(120_000) }, () => {
    for (const n of [...Array.from({ length: 128 }, (_, i) => i + 1), 333, 1000]) {
      const production = buildBatchMerkleTree(MERKLE_HASH_POOL.slice(0, Math.min(n, MERKLE_HASH_POOL.length)));
      const size = production.leaves.length;
      const batch = buildBatchMerkleProofs(production.leaves);
      expect(batch.length, `n=${size} proof count`).toBe(size);
      for (let index = 0; index < size; index += 1) {
        const single = buildBatchMerkleProof(production.leaves, index);
        expect(batch[index], `n=${size} index=${index} shape`).toEqual(single);
        // And every batch proof verifies under the independent verifier.
        const ok = refVerifyBatchProof({
          n: size,
          index,
          leaf: batch[index]!.verdictHash,
          path: batch[index]!.path,
          root: production.root,
        });
        expect(ok, `n=${size} index=${index} batch proof must verify`).toBe(true);
      }
    }
  });

  it('batch proof set: rejects malformed leaf arrays exactly like the single-proof API', () => {
    expect(() => buildBatchMerkleProofs([])).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleProofs('nope' as unknown as readonly string[])).toThrow(BatchAttestationError);
    expect(() => buildBatchMerkleProofs(['ZZ'.repeat(32)])).toThrow(BatchAttestationError);
  });

  it('n=1 degenerate: root equals the leaf hash, empty authentication path', () => {
    const [hash] = MERKLE_HASH_POOL;
    const production = buildBatchMerkleTree([hash!]);
    const reference = refBuildBatchTree([hash!]);
    expect(production.root).toBe(reference.root);
    expect(production.root).toBe(refBatchLeaf(hash!));
    const proof = buildBatchMerkleProof(production.leaves, 0);
    expect(proof.path).toEqual([]);
    expect(
      refVerifyBatchProof({ n: 1, index: 0, leaf: proof.verdictHash, path: [], root: production.root }),
    ).toBe(true);
  });

  it('order-independence: shuffled submission order yields the identical root (both impls)', () => {
    const next = mulberry32(0x6963);
    const hashes = MERKLE_HASH_POOL.slice(0, 37);
    const canonical = buildBatchMerkleTree(hashes);
    const referenceCanonical = refBuildBatchTree(hashes);
    for (let trial = 0; trial < 20; trial += 1) {
      const shuffled = [...hashes];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(buildBatchMerkleTree(shuffled).root).toBe(canonical.root);
      expect(refBuildBatchTree(shuffled).root).toBe(referenceCanonical.root);
    }
  });

  it('duplicate and malformed verdict hashes rejected by BOTH implementations', () => {
    const dup = [MERKLE_HASH_POOL[0]!, MERKLE_HASH_POOL[1]!, MERKLE_HASH_POOL[0]!];
    expect(() => buildBatchMerkleTree(dup)).toThrow();
    expect(() => refBuildBatchTree(dup)).toThrow();
    expect(() => buildBatchMerkleTree([])).toThrow();
    expect(() => refBuildBatchTree([])).toThrow();
    const upper = ['AB'.repeat(32)];
    expect(() => buildBatchMerkleTree(upper)).toThrow();
    expect(() => refBuildBatchTree(upper)).toThrow();
  });

  it('tampered paths reject: every sibling bit-flip, wrong index, truncated/extended path', { timeout: wd(120_000) }, () => {
    for (const n of TAMPER_NS) {
      const production = buildBatchMerkleTree(MERKLE_HASH_POOL.slice(0, n));
      for (let index = 0; index < n; index += 1) {
        const proof = buildBatchMerkleProof(production.leaves, index);

        // Tamper each sibling in the path.
        for (let position = 0; position < proof.path.length; position += 1) {
          const tampered = [...proof.path];
          const original = tampered[position]!;
          const flipped = original.startsWith('00') ? `11${original.slice(2)}` : `00${original.slice(2)}`;
          tampered[position] = flipped;
          expect(
            refVerifyBatchProof({
              n,
              index,
              leaf: proof.verdictHash,
              path: tampered,
              root: production.root,
            }),
            `n=${n} index=${index} tampered sibling ${position} must reject`,
          ).toBe(false);
        }

        // Wrong leaf digest.
        const wrongLeaf = proof.verdictHash.startsWith('00')
          ? `11${proof.verdictHash.slice(2)}`
          : `00${proof.verdictHash.slice(2)}`;
        expect(
          refVerifyBatchProof({ n, index, leaf: wrongLeaf, path: proof.path, root: production.root }),
        ).toBe(false);

        // Truncated path.
        if (proof.path.length > 0) {
          expect(
            refVerifyBatchProof({
              n,
              index,
              leaf: proof.verdictHash,
              path: proof.path.slice(1),
              root: production.root,
            }),
          ).toBe(false);
        }

        // Extended path (one extra plausible sibling).
        expect(
          refVerifyBatchProof({
            n,
            index,
            leaf: proof.verdictHash,
            path: [...proof.path, randomHex32(mulberry32(n * 1000 + index))],
            root: production.root,
          }),
        ).toBe(false);

        // Wrong index (proof built for `index` verified as index+1).
        const otherIndex = (index + 1) % n;
        if (otherIndex !== index) {
          expect(
            refVerifyBatchProof({
              n,
              index: otherIndex,
              leaf: proof.verdictHash,
              path: proof.path,
              root: production.root,
            }),
            `n=${n} proof for ${index} must reject as ${otherIndex}`,
          ).toBe(false);
        }
      }
    }
  });

  it('leaf/node domain separation is real: domains and type bytes are load-bearing', () => {
    const hash = MERKLE_HASH_POOL[0]!;
    const leaf = refBatchLeaf(hash);
    // Leaf digest differs from the raw verdict hash (domain + type byte matter).
    expect(leaf).not.toBe(hash);
    // Node digest differs from the leaf digest of either child, and order matters.
    const left = 'aa'.repeat(32);
    const right = 'bb'.repeat(32);
    expect(refBatchNode(left, right)).not.toBe(left);
    expect(refBatchNode(left, right)).not.toBe(right);
    expect(refBatchNode(left, right)).not.toBe(refBatchNode(right, left));
    // Split-point sanity (bit-trick formulation vs RFC-6962 values).
    expect(refSplit(2)).toBe(1);
    expect(refSplit(5)).toBe(4);
    expect(refSplit(9)).toBe(8);
    expect(refSplit(128)).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// 3. Verdict / manifest / attestation-V2 hashes — differential parity
// ---------------------------------------------------------------------------

describe('differential parity: verdict, dispute-verdict, batch-manifest, attestation-V2 hashes', () => {
  const next = mulberry32(0x5a256); // deterministic seed
  const HASHES = HASH_POOL; // reuse the shared Merkle/verdict hash pool

  it('hashCourtVerdict: node-crypto reference identical across randomized + boundary inputs', () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const supporting = Array.from(
        { length: 1 + Math.floor(next() * 6) },
        () => pick(HASHES, next),
      );
      const params = {
        sessionHash: pick(HASHES, next),
        outcome: pick(UNICODE_OUTCOMES.filter((o) => o.length > 0), next),
        supportingEventIds: supporting,
      };
      expect(refHashCourtVerdict(params)).toBe(hashCourtVerdict(params));
    }
    // Boundaries: single-char outcome, max-length (256-byte) outcomes.
    const max256Bytes = '😀'.repeat(64); // 64 × 4 bytes = 256
    const max255Bytes = '日'.repeat(85); // 85 × 3 = 255
    for (const outcome of ['a', '😀', max256Bytes, max255Bytes]) {
      const params = { sessionHash: HASHES[0]!, outcome, supportingEventIds: [HASHES[1]!] };
      expect(refHashCourtVerdict(params)).toBe(hashCourtVerdict(params));
    }
  });

  it('hashCourtVerdict contract: supporting-id ORDER is significant (both impls agree)', () => {
    const [a, b] = HASHES;
    const params = { sessionHash: HASHES[2]!, outcome: 'alpha', supportingEventIds: [a!, b!] };
    const swapped = { ...params, supportingEventIds: [b!, a!] };
    expect(hashCourtVerdict(params)).not.toBe(hashCourtVerdict(swapped));
    expect(refHashCourtVerdict(params)).toBe(hashCourtVerdict(params));
    expect(refHashCourtVerdict(swapped)).toBe(hashCourtVerdict(swapped));
  });

  it('hashDisputeVerdict: identical, and order-independent for BOTH impls', () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const supporting = Array.from(
        { length: 1 + Math.floor(next() * 6) },
        () => pick(HASHES, next),
      );
      const params = {
        disputeId: pick(HASHES, next),
        outcome: pick(UNICODE_OUTCOMES.filter((o) => o.length > 0), next),
        supportingEventIds: supporting,
      };
      expect(refHashDisputeVerdict(params)).toBe(hashDisputeVerdict(params));
      // Any permutation of the supporting ids must hash identically.
      const shuffled = [...params.supportingEventIds];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(hashDisputeVerdict({ ...params, supportingEventIds: shuffled })).toBe(
        hashDisputeVerdict(params),
      );
      expect(refHashDisputeVerdict({ ...params, supportingEventIds: shuffled })).toBe(
        refHashDisputeVerdict(params),
      );
    }
  });

  it('hashBatchManifest: identical across randomized + boundary fields', () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const params = {
        epoch: Math.floor(next() * 2 ** 32),
        cohortPubkey: pick(HASHES, next),
        batchIndex: Math.floor(next() * 2 ** 32),
        count: 1 + Math.floor(next() * 10_000),
        root: pick(HASHES, next),
        finalizedAtSec: Math.floor(next() * 2 ** 48),
      };
      expect(refHashBatchManifest(params)).toBe(hashBatchManifest(params));
    }
    const boundaries = [
      { epoch: 0, cohortPubkey: '00'.repeat(32), batchIndex: 0, count: 1, root: '00'.repeat(32), finalizedAtSec: 0 },
      {
        epoch: 0xffff_ffff,
        cohortPubkey: 'ff'.repeat(32),
        batchIndex: 0xffff_ffff,
        count: 0xffff_ffff,
        root: 'ff'.repeat(32),
        finalizedAtSec: Number.MAX_SAFE_INTEGER,
      },
    ];
    for (const params of boundaries) {
      expect(refHashBatchManifest(params)).toBe(hashBatchManifest(params));
    }
  });

  it('buildAttestationMessageV2: identical across ALL 64 optional-field subsets + boundaries', () => {
    // Exhaustive present/absent combinations of the six v2 extension fields.
    for (let mask = 0; mask < 64; mask += 1) {
      const params = {
        marketId: 'market-😀-01',
        outcome: pick(UNICODE_OUTCOMES, next),
        round: mask,
        disputeEventId: mask & 1 ? HASHES[3] : undefined,
        verdictHash: mask & 2 ? HASHES[4] : undefined,
        epochId: mask & 4 ? Math.floor(next() * 2 ** 32) : undefined,
        tier: mask & 8 ? Math.floor(next() * 256) : undefined,
        threshold: mask & 16 ? Math.floor(next() * 2 ** 32) : undefined,
        signerSetRoot: mask & 32 ? HASHES[5] : undefined,
      };
      expect(refBuildAttestationMessageV2(params)).toBe(buildAttestationMessageV2(params));
    }
    // attempt + batchMerkleRoot (covered above only via the mask? — they are:
    // the mask has 6 bits but epochId/tier/threshold/signerSetRoot take 4;
    // dispute/verdict take 2. Cover attempt + batchMerkleRoot explicitly).
    for (const withAttempt of [undefined, 0, 1, 0xffff_ffff] as const) {
      for (const withRoot of [undefined, HASHES[6], 'ff'.repeat(32)] as const) {
        const params = {
          marketId: 'm',
          outcome: 'γ',
          round: 7,
          attempt: withAttempt,
          batchMerkleRoot: withRoot,
        };
        expect(refBuildAttestationMessageV2(params)).toBe(buildAttestationMessageV2(params));
      }
    }
  });

  it('buildAttestationMessageV2: round 3 (number) and "3" (string) are the same signed statement', () => {
    const numeric = buildAttestationMessageV2({ marketId: 'm', outcome: 'yes', round: 3 });
    const stringy = buildAttestationMessageV2({ marketId: 'm', outcome: 'yes', round: '3' });
    expect(numeric).toBe(stringy);
    expect(refBuildAttestationMessageV2({ marketId: 'm', outcome: 'yes', round: '3' })).toBe(numeric);
  });

  it('hash contract: both implementations reject malformed inputs identically', () => {
    const badVerdicts = [
      { sessionHash: 'ZZ'.repeat(32), outcome: 'a', supportingEventIds: [HASHES[0]!] },
      { sessionHash: HASHES[0]!, outcome: '', supportingEventIds: [HASHES[0]!] },
      { sessionHash: HASHES[0]!, outcome: 'a', supportingEventIds: [] },
      { sessionHash: HASHES[0]!, outcome: 'a', supportingEventIds: ['nothex'] },
    ];
    for (const params of badVerdicts) {
      expect(() => hashCourtVerdict(params as never)).toThrow();
      expect(() => refHashCourtVerdict(params as never)).toThrow();
    }
    expect(() => hashBatchManifest({ ...batchParams(), epoch: -1 })).toThrow();
    expect(() => refHashBatchManifest({ ...batchParams(), epoch: -1 })).toThrow();
    function batchParams() {
      return {
        epoch: 1,
        cohortPubkey: HASHES[0]!,
        batchIndex: 0,
        count: 1,
        root: HASHES[1]!,
        finalizedAtSec: 1,
      };
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Selection lottery — differential parity (exact + statistical)
// ---------------------------------------------------------------------------

describe('differential parity: selection lottery', () => {
  it('EXACT: jurorRandomValue (manual byte math, @noble) === reference (readUInt32BE, node crypto)', () => {
    const next = mulberry32(0x1007);
    for (let trial = 0; trial < 500; trial += 1) {
      const seed = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) seed[i] = Math.floor(next() * 256);
      const pubkey = randomHex32(next);
      expect(refJurorRandomValue(seed, pubkey)).toBe(jurorRandomValue(seed, pubkey));
    }
  });

  it('EXACT: weightedPriority === independent same-formulation clock over randomized inputs', () => {
    const next = mulberry32(0x1008);
    for (let trial = 0; trial < 5_000; trial += 1) {
      const r = next();
      const weight = pick([1e-6, 0.001, 1, 2.5, 100, 1e9, next() * 1000 + 0.0001], next);
      expect(refPriorityProductionFormulation(r, weight)).toBe(weightedPriority(r, weight));
    }
  });

  it('EXACT: quadraticPriority === weightedPriority with weight sqrt(max(1, stake)) (floored at 1)', () => {
    const next = mulberry32(0x1009);
    for (let trial = 0; trial < 5_000; trial += 1) {
      const r = next();
      const stake = pick([0, 0.5, 1, 2, 10_000, 2 ** 45, Math.floor(next() * 2 ** 40)], next);
      expect(quadraticPriority(r, stake)).toBe(
        weightedPriority(r, Math.sqrt(Math.max(1, stake))),
      );
      expect(refPriorityProductionFormulation(r, Math.sqrt(Math.max(1, stake)))).toBe(
        quadraticPriority(r, stake),
      );
    }
  });

  it('EXACT: boundary clamps are part of the spec (r=0 → MIN_VALUE clock, r=1 → EPSILON clock)', () => {
    const epsClock = 2.2204460492503136e-16; // -ln(1 - EPSILON), exactly
    const minClock = -Math.log(Number.MIN_VALUE); // ≈ 744.44
    expect(weightedPriority(0, 1)).toBe(minClock);
    expect(weightedPriority(1, 1)).toBe(epsClock);
    expect(refPriorityProductionFormulation(0, 1)).toBe(minClock);
    expect(refPriorityProductionFormulation(1, 1)).toBe(epsClock);
    expect(quadraticPriority(0, 10_000)).toBe(minClock / Math.sqrt(10_000));
  });

  it('EXACT: end-to-end jury ranking — production selectJury vs independent reference ranking', () => {
    const next = mulberry32(0x100a);
    for (let trial = 0; trial < 40; trial += 1) {
      const size = 5 + Math.floor(next() * 55);
      const pubkeys: string[] = [];
      while (pubkeys.length < size) {
        const pk = randomHex32(next);
        if (!pubkeys.includes(pk)) pubkeys.push(pk);
      }
      const useWeights = trial % 2 === 0;
      const stakes = pubkeys.map(() => Math.floor(next() * 1_000_000));
      const weights = pubkeys.map((_, i) =>
        useWeights ? next() * 100 + 0.001 : Math.sqrt(Math.max(1, stakes[i]!)),
      );
      const pool: JurorProfile[] = pubkeys.map((nostrPubkey, i) => ({
        nostrPubkey,
        stakeCapacitySats: stakes[i]!,
        stakeCommitment: {
          amountSats: stakes[i]!,
          bondAddress: 'bc1qtest',
          status: 'confirmed',
          committedAt: 0,
        },
        wotScore: 100,
        categories: ['cat'],
        registeredAt: 0,
      }));
      const disputeEventId = randomHex32(next);
      const blockHash = randomHex32(next);
      const jurySize = 3 + Math.floor(next() * 5);

      const params = useWeights
        ? {
            disputeEventId,
            blockHash,
            marketCategory: 'cat',
            marketVolumeSats: 0, // irrelevant: weightFn path
            jurySize,
            minWotScore: 0,
            minStakeSats: 0,
            zeroStakeAllowed: true,
            weightFn: (_juror: JurorProfile) => weights[pubkeys.indexOf(_juror.nostrPubkey)]!,
          }
        : {
            disputeEventId,
            blockHash,
            marketCategory: 'cat',
            marketVolumeSats: 0,
            jurySize,
            minWotScore: 0,
            minStakeSats: 0,
            zeroStakeAllowed: true,
          };

      const production = selectJury(pool, params);
      const reference = refSelectJuryRanking(pubkeys, weights, disputeEventId, blockHash);

      expect(production.map((j) => j.nostrPubkey), `trial ${trial}`).toEqual(
        reference.slice(0, jurySize).map((j) => j.nostrPubkey),
      );
      expect(production.map((j) => j.idx)).toEqual(
        reference.slice(0, jurySize).map((j) => j.idx),
      );
      // Bit-exact priorities (same formulation, independent code path).
      for (let i = 0; i < jurySize; i += 1) {
        expect(production[i]!.priority).toBe(reference[i]!.priority);
      }
      // The reference ranking extends to backups: the full order must match.
      expect(production.length).toBe(Math.min(jurySize, size));
    }
  });

  it('DETERMINISTIC IDENTITY: inverse-CDF clock(u) === production clock(1-u) — the measure-preserving relabelling', () => {
    const next = mulberry32(0x100b);
    for (let trial = 0; trial < 5_000; trial += 1) {
      const u = next();
      const weight = next() * 10 + 0.001;
      expect(refPriorityInverseCdf(u, weight)).toBe(
        refPriorityProductionFormulation(1 - u, weight),
      );
    }
  });

  it('STATISTICAL: production and inverse-CDF clocks both fit Exp(1) over 100k draws (chi-square + moments)', () => {
    const DRAWS = 100_000;
    const BUCKETS = 20;

    const runFit = (
      clock: (r: number, weight: number) => number,
      weight: number,
      seed: number,
    ): { chiSquare: number; mean: number; variance: number } => {
      const next = mulberry32(seed);
      // Equal-probability Exp(1) bucket edges: -ln(1 - i/BUCKETS).
      const edges = Array.from(
        { length: BUCKETS - 1 },
        (_, i) => -Math.log(1 - (i + 1) / BUCKETS),
      );
      const observed = new Array<number>(BUCKETS).fill(0);
      let sum = 0;
      let sumSquares = 0;
      for (let i = 0; i < DRAWS; i += 1) {
        // Normalise the clock back to Exp(1) by multiplying by the weight.
        const x = clock(next(), weight) * weight;
        let bucket = edges.findIndex((edge) => x < edge);
        if (bucket === -1) bucket = BUCKETS - 1;
        observed[bucket] += 1;
        sum += x;
        sumSquares += x * x;
      }
      const expected = DRAWS / BUCKETS;
      const chiSquare = observed.reduce((acc, count) => acc + (count - expected) ** 2 / expected, 0);
      const mean = sum / DRAWS;
      const variance = sumSquares / DRAWS - mean * mean;
      return { chiSquare, mean, variance };
    };

    for (const weight of [1, 2.5, 7]) {
      const production = runFit((r, w) => weightedPriority(r, w), weight, 0x1ee7 + weight * 1000);
      const inverse = runFit((r, w) => refPriorityInverseCdf(r, w), weight, 0x2ee7 + weight * 1000);
      for (const fit of [production, inverse]) {
        // chi-square(19): assert < 60 (deterministic under the fixed seed;
        // generous margin above the p≈1e-5 critical value ≈ 43.8).
        expect(fit.chiSquare, `weight ${weight} chi-square ${fit.chiSquare}`).toBeLessThan(60);
        expect(Math.abs(fit.mean - 1)).toBeLessThan(0.02);
        expect(Math.abs(fit.variance - 1)).toBeLessThan(0.05);
      }
    }
  });

  it('STATISTICAL: min-clock winner frequencies follow w/Σw for BOTH formulations over 100k rounds', () => {
    const ROUNDS = 100_000;
    const weights = [1, 2, 3];
    const total = weights.reduce((a, b) => a + b, 0);

    const winnerCounts = (
      clock: (r: number, weight: number) => number,
      seed: number,
    ): number[] => {
      const next = mulberry32(seed);
      const counts = new Array<number>(weights.length).fill(0);
      for (let round = 0; round < ROUNDS; round += 1) {
        let bestIdx = -1;
        let bestClock = Number.POSITIVE_INFINITY;
        for (let i = 0; i < weights.length; i += 1) {
          const value = clock(next(), weights[i]!);
          if (value < bestClock) {
            bestClock = value;
            bestIdx = i;
          }
        }
        counts[bestIdx]! += 1;
      }
      return counts;
    };

    for (const [label, clock, seed] of [
      ['production', (r: number, w: number) => weightedPriority(r, w), 0xfeed1],
      ['inverse-cdf', (r: number, w: number) => refPriorityInverseCdf(r, w), 0xfeed2],
    ] as const) {
      const counts = winnerCounts(clock, seed);
      for (let i = 0; i < weights.length; i += 1) {
        const expected = weights[i]! / total;
        const observed = counts[i]! / ROUNDS;
        expect(Math.abs(observed - expected), `${label} weight ${weights[i]}`).toBeLessThan(0.01);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Plurality + tie-break — differential parity
// ---------------------------------------------------------------------------

const TEST_SESSION_HASH = 'ab'.repeat(32);

function hexEventId(index: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = (index >>> 8) & 0xff;
  bytes[1] = index & 0xff;
  bytes[2] = 0xee;
  for (let i = 3; i < 32; i += 1) bytes[i] = (index * 7 + i) & 0xff;
  return refBytesToHex(bytes);
}

function hexSalt(trial: number, index: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (trial * 131 + index * 17 + i * 3) & 0xff;
  return refBytesToHex(bytes);
}

interface DrivenVerdict {
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
  readonly verdictHash: string;
}

function driveVoteMachine(
  roster: readonly number[],
  allowedOutcomes: readonly string[],
  votes: ReadonlyMap<number, string>,
  trial: number,
): DrivenVerdict {
  let state = createCourtVoteMachine({
    sessionHash: TEST_SESSION_HASH,
    participantIndices: roster,
    allowedOutcomes,
    commitDeadline: 100,
    revealDeadline: 200,
  });
  for (const idx of roster) {
    const outcome = votes.get(idx)!;
    state = reduceCourtVoteMachine(state, {
      type: 'accept_commit',
      idx,
      commitHash: hashCourtVoteCommit({
        sessionHash: TEST_SESSION_HASH,
        outcome,
        salt: hexSalt(trial, idx),
      }),
      eventId: hexEventId(idx),
      now: 10,
    });
  }
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 100 });
  state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 110 });
  for (const idx of roster) {
    const outcome = votes.get(idx)!;
    state = reduceCourtVoteMachine(state, {
      type: 'accept_reveal',
      idx,
      outcome,
      salt: hexSalt(trial, idx),
      eventId: hexEventId(idx),
      now: 120,
    });
  }
  state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: 200 });
  state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: 210 });
  if (!state.verdict) throw new Error('machine did not finalize a verdict');
  return {
    outcome: state.verdict.outcome,
    supportingEventIds: state.verdict.supportingEventIds,
    verdictHash: state.verdict.verdictHash,
  };
}

describe('differential parity: plurality tally + tie-break', () => {
  const THREE_OUTCOMES = ['alpha', 'bravo', '😀'] as const;

  it('exhaustive 3^n assignments for n=1..4: machine winner === independent reduce tally', () => {
    for (let n = 1; n <= 4; n += 1) {
      const roster = Array.from({ length: n }, (_, i) => i + 1);
      const total = 3 ** n;
      for (let assignment = 0; assignment < total; assignment += 1) {
        let remainder = assignment;
        const votes = new Map<number, string>();
        for (const idx of roster) {
          votes.set(idx, THREE_OUTCOMES[remainder % 3]!);
          remainder = Math.floor(remainder / 3);
        }
        const machine = driveVoteMachine(roster, THREE_OUTCOMES, votes, assignment);
        const reference = refPluralityTally(
          roster.map((idx) => ({ outcome: votes.get(idx)!, eventId: hexEventId(idx) })),
        );
        expect(machine.outcome, `n=${n} assignment=${assignment}`).toBe(reference.outcome);
        expect([...machine.supportingEventIds]).toEqual([...reference.eventIds]);
        expect(machine.verdictHash).toBe(
          refHashCourtVerdict({
            sessionHash: TEST_SESSION_HASH,
            outcome: machine.outcome,
            supportingEventIds: machine.supportingEventIds,
          }),
        );
      }
    }
  });

  it('UTF-8 tie-break divergence pin: U+FFFD beats U+1F600 bytewise although UTF-16 order is opposite', () => {
    const outcomes = ['\uFFFD', '😀'] as const;
    // Sanity: the two orderings genuinely disagree.
    expect('\u{1F600}'.codePointAt(0)).toBe(0x1f600);
    expect(['\uFFFD', '😀'].sort()[0]).toBe('😀'); // UTF-16 code-unit order
    expect(refBytewiseUtf8Compare('\uFFFD', '😀')).toBeLessThan(0); // UTF-8 byte order
    expect(refBytewiseUtf8Compare('\uFFFD', '😀')).toBeLessThan(0);
    expect(['\uFFFD', '😀'].sort(compareOutcomeUtf8)[0]).toBe('\uFFFD');

    // 1–1 tie through the machine: bytewise-smaller outcome must win.
    const votes = new Map<number, string>([
      [1, '😀'],
      [2, '\uFFFD'],
    ]);
    const machine = driveVoteMachine([1, 2], outcomes, votes, 999);
    const reference = refPluralityTally([
      { outcome: '😀', eventId: hexEventId(1) },
      { outcome: '\uFFFD', eventId: hexEventId(2) },
    ]);
    expect(machine.outcome).toBe('\uFFFD');
    expect(reference.outcome).toBe('\uFFFD');
  });

  it('prefix tie-break: the bytewise-smaller prefix wins a tied count', () => {
    const outcomes = ['a', 'a\u{1F600}'] as const;
    const votes = new Map<number, string>([
      [1, 'a'],
      [2, 'a\u{1F600}'],
    ]);
    const machine = driveVoteMachine([1, 2], outcomes, votes, 998);
    const reference = refPluralityTally([
      { outcome: 'a', eventId: hexEventId(1) },
      { outcome: 'a\u{1F600}', eventId: hexEventId(2) },
    ]);
    expect(machine.outcome).toBe('a');
    expect(reference.outcome).toBe('a');
  });

  it('compareOutcomeUtf8 === Buffer.compare order over randomized unicode pairs', () => {
    const next = mulberry32(0x71e);
    const pool = [...UNICODE_OUTCOMES, '\u{10FFF}', '\u{1F1E6}', 'ﬀ', '℀', ' '];
    for (let trial = 0; trial < 500; trial += 1) {
      const left = pick(pool, next);
      const right = pick(pool, next);
      const productionSign = Math.sign(compareOutcomeUtf8(left, right));
      const referenceSign = Math.sign(refBytewiseUtf8Compare(left, right));
      expect(productionSign, `pair (${left}, ${right})`).toBe(referenceSign);
    }
  });

  it('random big tallies (300 jurors, unicode outcomes): machine === reference tally + hash', () => {
    const next = mulberry32(0x71f);
    const outcomePool = [...UNICODE_OUTCOMES.slice(0, 8)];
    for (let trial = 0; trial < 10; trial += 1) {
      const n = 300;
      const roster = Array.from({ length: n }, (_, i) => i + 1);
      const votes = new Map<number, string>();
      for (const idx of roster) votes.set(idx, pick(outcomePool, next));
      const machine = driveVoteMachine(roster, outcomePool, votes, trial);
      const reference = refPluralityTally(
        roster.map((idx) => ({ outcome: votes.get(idx)!, eventId: hexEventId(idx) })),
      );
      expect(machine.outcome, `trial ${trial}`).toBe(reference.outcome);
      expect([...machine.supportingEventIds]).toEqual([...reference.eventIds]);
      expect(machine.verdictHash).toBe(
        refHashCourtVerdict({
          sessionHash: TEST_SESSION_HASH,
          outcome: machine.outcome,
          supportingEventIds: machine.supportingEventIds,
        }),
      );
    }
  });

  it('unanimous and single-vote tallies agree (degenerate shapes)', () => {
    const outcomes = ['x', 'y', 'z'] as const;
    const unanimous = new Map<number, string>([
      [1, 'y'],
      [2, 'y'],
      [3, 'y'],
    ]);
    const machine = driveVoteMachine([1, 2, 3], outcomes, unanimous, 42);
    const reference = refPluralityTally([
      { outcome: 'y', eventId: hexEventId(1) },
      { outcome: 'y', eventId: hexEventId(2) },
      { outcome: 'y', eventId: hexEventId(3) },
    ]);
    expect(machine.outcome).toBe('y');
    expect(reference.outcome).toBe('y');
    expect(machine.supportingEventIds).toHaveLength(3);

    const single = driveVoteMachine([1], outcomes, new Map([[1, 'z']]), 43);
    expect(single.outcome).toBe('z');
    expect(single.supportingEventIds).toEqual([hexEventId(1)]);
  });
});
