// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Property-based invariant sweep (security round 3) — batchAttestation.
 *
 * Deterministic seeded generators (mulberry32 LCG — no new dependencies)
 * produce random verdict-leaf sets (n = 1..300, duplicates excluded) and
 * assert:
 *
 *   PB1  every index's authentication path recomputes the batch root — both
 *        via an INDEPENDENT in-test RFC-6962 fold and via the full
 *        verifyCaseInBatch pipeline over a really-signed kind-39018 event;
 *   PB2  NO single mutation of any proof byte (leaf hash, sibling hash,
 *        index) or of the case inputs verifies;
 *   PB3  root determinism: the same leaf set in any submission order yields
 *        the identical root and identical sorted leaves;
 *   PB4  proof-length sanity: path length matches an independent
 *        floor(log2)-shape computation (0 for n=1, ≥1 otherwise, ≤ ceil(log2 n));
 *   PB5  wrong case inputs that hash to the same leaf are rejected ONLY via
 *        real hash recomputation (rejected-by-recomputation): acceptance is
 *        leaf-equality, so a distinct (sessionHash, outcome, supporting ids)
 *        tuple is rejected because its recomputed leaf differs — the only way
 *        a forged tuple verifies is an actual SHA-256 collision/preimage;
 *   PB6  malformed caller input throws the TYPED BatchAttestationError, and
 *        validateBatchAttestationEvent NEVER throws on hostile events (it
 *        returns { valid: false, reason }).
 */

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import {
  BATCH_LEAF_DOMAIN,
  BATCH_NODE_DOMAIN,
  BatchAttestationError,
  buildBatchAttestationEvent,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
  hashBatchManifest,
  validateBatchAttestationEvent,
  verifyCaseInBatch,
  type BatchMerkleProof,
} from '../batchAttestation';
import { hashCourtVerdict, CourtVoteTransitionError } from '../courtVoteMachine';
import { CanonicalWriter } from '../courtSession';

// ─── seeded LCG (mulberry32) ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX_DIGITS = '0123456789abcdef';
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));
const hex32 = (r: () => number): string =>
  Array.from({ length: 64 }, () => HEX_DIGITS[Math.floor(r() * 16)]).join('');
const uniqueHex32 = (r: () => number, seen: Set<string>): string => {
  let value = hex32(r);
  while (seen.has(value)) value = hex32(r);
  seen.add(value);
  return value;
};

function secFrom(r: () => number): Uint8Array {
  const sec = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) sec[i] = Math.floor(r() * 256);
  return sec;
}

// ─── independent RFC-6962 reimplementation (in-test oracle) ─────────────────

function domainDigest(domain: string, encoded: Uint8Array): string {
  const prefix = new TextEncoder().encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

function oracleLeaf(verdictHash: string): string {
  const writer = new CanonicalWriter();
  writer.u8(0x00);
  writer.hex(verdictHash);
  return domainDigest(BATCH_LEAF_DOMAIN, writer.finish());
}

function oracleNode(left: string, right: string): string {
  const writer = new CanonicalWriter();
  writer.u8(0x01);
  writer.hex(left);
  writer.hex(right);
  return domainDigest(BATCH_NODE_DOMAIN, writer.finish());
}

/** k = 2^floor(log2(n-1)), derived independently of splitPoint's loop. */
function oracleSplit(n: number): number {
  if (n < 2) throw new Error('oracle split needs n >= 2');
  return 2 ** Math.floor(Math.log2(n - 1) + 1e-12);
}

function oracleSubtreeRoot(leaves: readonly string[], lo: number, hi: number): string {
  if (hi - lo === 1) return leaves[lo]!;
  const k = oracleSplit(hi - lo);
  return oracleNode(oracleSubtreeRoot(leaves, lo, lo + k), oracleSubtreeRoot(leaves, lo + k, hi));
}

function oraclePathLength(n: number, index: number): number {
  let length = 0;
  let size = n;
  let i = index;
  while (size > 1) {
    const k = oracleSplit(size);
    if (i < k) {
      size = k;
    } else {
      i -= k;
      size -= k;
    }
    length += 1;
  }
  return length;
}

/** Independent fold: descend (n, index) to record each level's side, then fold leaf-upward. */
function oracleFold(path: readonly string[], n: number, index: number, leaf: string): string {
  const levels: Array<{ left: boolean }> = [];
  let size = n;
  let i = index;
  while (size > 1) {
    const k = oracleSplit(size);
    if (i < k) {
      levels.push({ left: true });
      size = k;
    } else {
      levels.push({ left: false });
      i -= k;
      size -= k;
    }
  }
  let acc = leaf;
  for (let d = levels.length - 1; d >= 0; d -= 1) {
    const sibling = path[levels.length - 1 - d]!;
    acc = levels[d]!.left ? oracleNode(acc, sibling) : oracleNode(sibling, acc);
  }
  return acc;
}

// ─── batch + case generators ────────────────────────────────────────────────

interface BatchCase {
  readonly sessionHash: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
  readonly verdictHash: string;
}

function randomCase(r: () => number, seen: Set<string>): BatchCase {
  const supporting = Array.from({ length: int(r, 1, 5) }, () => uniqueHex32(r, seen));
  const sessionHash = uniqueHex32(r, seen);
  const outcome = `outcome-${int(r, 0, 4)}`;
  return {
    sessionHash,
    outcome,
    supportingEventIds: supporting,
    verdictHash: hashCourtVerdict({ sessionHash, outcome, supportingEventIds: supporting }),
  };
}

function randomBatch(r: () => number, maxN = 300): {
  cases: BatchCase[];
  tree: ReturnType<typeof buildBatchMerkleTree>;
  event: NostrEvent;
  groupPub: string;
  epoch: number;
} {
  const n = int(r, 1, maxN);
  const seen = new Set<string>();
  const cases = Array.from({ length: n }, () => randomCase(r, seen));
  const verdictHashes = cases.map((c) => c.verdictHash);
  const tree = buildBatchMerkleTree(verdictHashes);
  const groupSec = secFrom(r);
  const groupPub = bytesToHex(schnorr.getPublicKey(groupSec));
  const epoch = int(r, 0, 0xffff);
  const batchIndex = int(r, 0, 50);
  const finalizedAtSec = int(r, 1_700_000_000, 1_900_000_000);
  const manifestHash = hashBatchManifest({
    epoch,
    cohortPubkey: groupPub,
    batchIndex,
    count: n,
    root: tree.root,
    finalizedAtSec,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(manifestHash), groupSec));
  const event = buildBatchAttestationEvent({
    epoch,
    cohortPubkey: groupPub,
    batchIndex,
    count: n,
    root: tree.root,
    finalizedAtSec,
    signature,
    createdAt: finalizedAtSec,
  });
  return { cases, tree, event, groupPub, epoch };
}

function proofFor(tree: ReturnType<typeof buildBatchMerkleTree>, index: number): BatchMerkleProof {
  return buildBatchMerkleProof(tree.leaves, index);
}

function flipHexChar(value: string, r: () => number): string {
  const pos = Math.floor(r() * value.length);
  const replacements = HEX_DIGITS.split('').filter((c) => c !== value[pos]);
  return value.slice(0, pos) + replacements[Math.floor(r() * replacements.length)] + value.slice(pos + 1);
}

// ─── the sweep ──────────────────────────────────────────────────────────────

const BATCHES = 48;
const MUTATION_SAMPLES_PER_BATCH = 12;

describe('properties: batchAttestation', () => {
  const seeded = Array.from({ length: BATCHES }, (_, i) => mulberry32(1000 + i * 7919));
  const batches = seeded.map((r) => randomBatch(r));

  it(`PB1/PB4: across ${BATCHES} random batches (n=1..300) every index's proof recomputes the root (independent oracle) with sane path lengths; full verifyCaseInBatch on every index of small batches and a sample of large ones`, { timeout: 120_000 }, () => {
    let verified = 0;
    let fullPipeline = 0;
    for (const { cases, tree, event, groupPub, epoch } of batches) {
      const n = cases.length;
      const sortedVerdictHashes = [...cases.map((c) => c.verdictHash)].sort();
      const caseForIndex = new Map(sortedVerdictHashes.map((hash) => {
        const owner = cases.find((c) => c.verdictHash === hash)!;
        return [hash, owner] as const;
      }));
      // Independent oracle root over the sorted leaves.
      expect(tree.leaves).toEqual([...cases.map((c) => c.verdictHash)].sort().map(oracleLeaf));
      expect(tree.root).toBe(oracleSubtreeRoot(tree.leaves, 0, n));
      const maxPath = Math.ceil(Math.log2(Math.max(n, 2)));
      // Full signed-event verification: every index when cheap, a spread sample otherwise.
      const fullIndexes = new Set<number>();
      if (n <= 30) {
        for (let i = 0; i < n; i += 1) fullIndexes.add(i);
      } else {
        for (let i = 0; i < 25; i += 1) fullIndexes.add(Math.floor((i * n) / 25));
      }
      for (let index = 0; index < n; index += 1) {
        const proof = proofFor(tree, index);
        expect(proof.verdictHash).toBe(tree.leaves[index]);
        // PB4: path-length sanity.
        expect(proof.path.length).toBe(oraclePathLength(n, index));
        if (n === 1) expect(proof.path.length).toBe(0);
        else expect(proof.path.length).toBeGreaterThanOrEqual(1);
        expect(proof.path.length).toBeLessThanOrEqual(maxPath);
        // PB1a: independent fold recomputes the root.
        expect(oracleFold(proof.path, n, index, proof.verdictHash)).toBe(tree.root);
        // PB1b: full pipeline over a really-signed event, pairing the proof
        // with the case whose verdict hash occupies this sorted position.
        if (fullIndexes.has(index)) {
          const owner = caseForIndex.get(sortedVerdictHashes[index]!)!;
          const result = verifyCaseInBatch(
            event,
            {
              sessionHash: owner.sessionHash,
              outcome: owner.outcome,
              supportingEventIds: owner.supportingEventIds,
              proof,
            },
            { expectedGroupPubkey: groupPub, expectedEpoch: epoch, expectedFinalizedAtSec: event.created_at },
          );
          expect(result.valid, `index ${index} of n=${n}: ${result.reason ?? ''}`).toBe(true);
          fullPipeline += 1;
        }
        verified += 1;
      }
    }
    expect(verified).toBeGreaterThan(1000);
    expect(fullPipeline).toBeGreaterThan(100);
  });

  it('PB3: root determinism — shuffled submission order yields the identical root and leaves', () => {
    for (const { cases, tree } of batches) {
      const hashes = cases.map((c) => c.verdictHash);
      const shuffled = [...hashes];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1)); // shuffle order irrelevant to the assertion
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const rebuilt = buildBatchMerkleTree(shuffled);
      expect(rebuilt.root).toBe(tree.root);
      expect(rebuilt.leaves).toEqual(tree.leaves);
    }
  });

  it(`PB2: no mutation of any proof byte/sibling/index (and no swapped case inputs) verifies (${MUTATION_SAMPLES_PER_BATCH} sampled indices per batch)`, () => {
    for (const { cases, tree, event, groupPub } of batches) {
      const n = cases.length;
      const sortedVerdictHashes = [...cases.map((c) => c.verdictHash)].sort();
      const r = mulberry32(n * 31 + 7);
      const sampleSize = Math.min(n, MUTATION_SAMPLES_PER_BATCH);
      const indices = new Set<number>();
      while (indices.size < sampleSize) indices.add(Math.floor(r() * n));
      for (const index of indices) {
        const proof = proofFor(tree, index);
        const caseInput = {
          sessionHash: cases[index]!.sessionHash,
          outcome: cases[index]!.outcome,
          supportingEventIds: cases[index]!.supportingEventIds,
        };
        const verify = (p: BatchMerkleProof) =>
          verifyCaseInBatch(event, { ...caseInput, proof: p }, { expectedGroupPubkey: groupPub });

        // (a) mutate the proof leaf hash.
        const leafMutated: BatchMerkleProof = { ...proof, verdictHash: flipHexChar(proof.verdictHash, r) };
        expect(verify(leafMutated).valid).toBe(false);

        // (b) mutate one sibling hash (n=1 proofs carry no siblings).
        if (proof.path.length > 0) {
          const depth = Math.floor(r() * proof.path.length);
          const pathMutated: BatchMerkleProof = {
            ...proof,
            path: proof.path.map((s, d) => (d === depth ? flipHexChar(s, r) : s)),
          };
          expect(verify(pathMutated).valid).toBe(false);
        }

        // (c) shift the index to any other in-bounds position.
        if (n > 1) {
          let other = Math.floor(r() * (n - 1));
          if (other >= index) other += 1;
          expect(verify({ ...proof, index: other }).valid).toBe(false);
        }

        // (d) present different case inputs under the same proof. The proof
        // pins the VERDICT HASH (leaf-equality acceptance): a different tuple
        // is rejected by recomputation exactly when its verdict hash differs
        // from the one at the proof's sorted position — and verifies when it
        // is the same hash (only a real SHA-256 collision could smuggle a
        // distinct tuple through; see PB5).
        const otherCase = cases[(index + 1) % n]!;
        const result = verifyCaseInBatch(
          event,
          {
            sessionHash: otherCase.sessionHash,
            outcome: otherCase.outcome,
            supportingEventIds: otherCase.supportingEventIds,
            proof,
          },
          { expectedGroupPubkey: groupPub },
        );
        expect(result.valid).toBe(otherCase.verdictHash === sortedVerdictHashes[index]);
      }
    }
  });

  it('PB5: rejection is by RECOMPUTATION, not identity — any single-field change of the case inputs changes the verdict hash (only a real SHA-256 collision could pass)', () => {
    // Documented semantics: verifyCaseInBatch recomputes
    // leaf(verdictHash(caseInput)) and compares it to the proof leaf. There
    // is no identity check tying the case tuple to the batch builder's
    // original tuple — a DIFFERENT tuple whose hash collided would verify.
    // This property pins that every single-field input change really does
    // change the verdict hash, so rejection-by-recomputation is sound.
    const r = mulberry32(4242);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const c = randomCase(r, seen);
      const base = hashCourtVerdict(c);
      // outcome change
      const otherOutcome = c.outcome === 'outcome-0' ? 'outcome-1' : 'outcome-0';
      expect(
        hashCourtVerdict({ ...c, outcome: otherOutcome, supportingEventIds: c.supportingEventIds }),
      ).not.toBe(base);
      // session change
      expect(hashCourtVerdict({ ...c, sessionHash: flipHexChar(c.sessionHash, r) })).not.toBe(base);
      // supporting-id change (append / drop / substitute)
      expect(
        hashCourtVerdict({ ...c, supportingEventIds: [...c.supportingEventIds, uniqueHex32(r, seen)] }),
      ).not.toBe(base);
      if (c.supportingEventIds.length > 1) {
        expect(
          hashCourtVerdict({
            sessionHash: c.sessionHash,
            outcome: c.outcome,
            supportingEventIds: c.supportingEventIds.slice(1),
          }),
        ).not.toBe(base);
      }
      // order-sensitivity of the supporting list (canonical form sorts upstream)
      if (c.supportingEventIds.length > 1) {
        expect(
          hashCourtVerdict({
            sessionHash: c.sessionHash,
            outcome: c.outcome,
            supportingEventIds: [...c.supportingEventIds].reverse(),
          }),
        ).not.toBe(base);
      }
    }
  });

  it('PB6a: malformed caller input throws the TYPED BatchAttestationError (never a raw Error/TypeError/RangeError)', () => {
    const r = mulberry32(777);
    const { tree } = randomBatch(r, 8);
    const good = tree.leaves;
    const expectBatchError = (run: () => unknown, label: string): void => {
      let thrown: unknown;
      try {
        run();
      } catch (err) {
        thrown = err;
      }
      expect(thrown, label).toBeInstanceOf(BatchAttestationError);
      expect((thrown as Error).name, label).toBe('BatchAttestationError');
    };
    expectBatchError(() => buildBatchMerkleTree([]), 'empty');
    expectBatchError(() => buildBatchMerkleTree('nope' as unknown as readonly string[]), 'non-array');
    expectBatchError(() => buildBatchMerkleTree([good[0]!, good[0]!]), 'duplicate leaves');
    expectBatchError(() => buildBatchMerkleTree(['ZZ'.repeat(32)]), 'non-hex leaf');
    expectBatchError(() => buildBatchMerkleProof(good, -1), 'negative index');
    expectBatchError(() => buildBatchMerkleProof(good, good.length), 'out-of-range index');
    expectBatchError(() => buildBatchMerkleProof(good, 1.5), 'fractional index');
    expectBatchError(
      () =>
        verifyCaseInBatch({} as NostrEvent, {
          sessionHash: 'aa'.repeat(32),
          outcome: 'x',
          supportingEventIds: ['bb'.repeat(32)],
          proof: { index: 0, verdictHash: 'cc'.repeat(32), path: undefined as unknown as readonly string[] },
        }),
      'malformed proof path',
    );
  });

  it('PB6c (documented cross-module typing): malformed case inputs surface the vote machine\'s TYPED CourtVoteTransitionError — typed, foreign class, by design (docstring)', () => {
    const r = mulberry32(778);
    const { event } = randomBatch(r, 4);
    const badCase = {
      sessionHash: 'nothex',
      outcome: 'x',
      supportingEventIds: ['bb'.repeat(32)],
      proof: { index: 0, verdictHash: 'cc'.repeat(32), path: [] },
    };
    let thrown: unknown;
    try {
      verifyCaseInBatch(event, badCase);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CourtVoteTransitionError);
  });

  it('PB6d (FINDING r3, FIXED in 0.9.1): verifyCaseInBatch answers a TYPED { valid:false } for a tags-less event whose proof leaf matches — event shape validated BEFORE leaf work', () => {
    // validateBatchAttestationEvent guards !Array.isArray(event.tags), but
    // verifyCaseInBatch used to reach uniqueTag() without that guard once the
    // recomputed leaf matched the proof — a malformed/empty event object then
    // crashed with an uncaught TypeError. Since 0.9.1 the event shape is
    // validated up front and the answer is the module's typed
    // { valid: false, reason } result.
    const r = mulberry32(779);
    const caseInput = { sessionHash: 'aa'.repeat(32), outcome: 'x', supportingEventIds: ['bb'.repeat(32)] };
    const verdictHash = hashCourtVerdict(caseInput);
    const writer = new CanonicalWriter();
    writer.u8(0x00);
    writer.hex(verdictHash);
    const prefix = new TextEncoder().encode(BATCH_LEAF_DOMAIN);
    const body = writer.finish();
    const input = new Uint8Array(prefix.length + body.length);
    input.set(prefix, 0);
    input.set(body, prefix.length);
    const leaf = bytesToHex(sha256(input));
    let result: unknown;
    expect(() => {
      result = verifyCaseInBatch(
        { kind: 39018 } as unknown as NostrEvent,
        { ...caseInput, proof: { index: 0, verdictHash: leaf, path: [] } },
      );
    }).not.toThrow();
    expect(result).toMatchObject({ valid: false, reason: 'malformed event' });
  });

  it('PB6b: validateBatchAttestationEvent NEVER throws on hostile events — every answer is { valid: boolean }', () => {
    const r = mulberry32(31337);
    for (const { event } of batches) {
      const mutations: Array<() => NostrEvent> = [
        () => ({ ...event, kind: 1 }),
        () => ({ ...event, tags: [] }),
        () => ({ ...event, tags: [...event.tags, ['root', 'zz']] }),
        () => ({ ...event, tags: event.tags.filter((t) => t[0] !== 'sig') }),
        () => ({ ...event, tags: event.tags.map((t) => (t[0] === 'sig' ? ['sig', 'f'.repeat(128)] : t)) }),
        () => ({ ...event, tags: event.tags.map((t) => (t[0] === 'epoch' ? ['epoch', '-5'] : t)) }),
        () => ({ ...event, tags: event.tags.map((t) => (t[0] === 'count' ? ['count', '0'] : t)) }),
        () => ({ ...event, content: 'not json' }),
        () => ({ ...event, content: '{}' }),
        () => ({ ...event, id: '0'.repeat(64) }),
        () => ({ ...event, pubkey: 'aa'.repeat(32) }),
        () => ({ ...event, created_at: -1 }),
        () => ({ ...event, created_at: 1.5 }),
        () => ({ ...event, sig: 'ff'.repeat(128) }),
        () => ({ ...event, id: undefined as unknown as string }),
      ];
      for (const mutate of mutations) {
        let result: unknown;
        expect(() => {
          result = validateBatchAttestationEvent(mutate());
        }, 'validator threw on a hostile event').not.toThrow();
        expect(result).toHaveProperty('valid');
        expect(typeof (result as { valid: unknown }).valid).toBe('boolean');
      }
      // Garbage inputs never throw either.
      expect(validateBatchAttestationEvent(null as unknown as NostrEvent).valid).toBe(false);
      expect(validateBatchAttestationEvent('x' as unknown as NostrEvent).valid).toBe(false);
      // A mutated event can never keep a valid true answer with pinned context:
      expect(validateBatchAttestationEvent(mutations[0]!(), { expectedEpoch: 1_000_000 }).valid).toBe(false);
    }
  });
});
