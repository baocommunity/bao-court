// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Cryptographic literature-audit regression tests (round 7, 2026-11).
 *
 * Locks in the shipped fixes and the empirically verified library behaviours
 * documented in docs/CRYPTO_AUDIT.md:
 *
 *   AUDIT-1 — DKG proof-of-knowledge challenge uses canonical length-prefixed
 *             encoding (no delimiter-join aliasing), with v1 compat in verify.
 *   AUDIT-2 — deriveDisputeGroupPubkey enforces a fixed-length pubkey so the
 *             raw concatenation is injective (no (pk, disputeId) aliasing).
 *   AUDIT-3 — @vbyte/frost 1.1.5 aggregates ONLY when the reveal set equals
 *             the commitment set (Lagrange coefficients are indexed by the
 *             commitment list); IndependentSigningSession.canAggregate
 *             enforces it, and the full-coverage flow still aggregates a
 *             valid attestation.
 */

import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { createProofOfKnowledge, dkgPokDomain, verifyProofOfKnowledge, verifyFinalSignature, buildAttestationMessage, seededScalar } from '../crypto';
import { runNormalSigningRound } from '../signing';
import * as frost from '@vbyte/frost';
import { deriveDisputeGroupPubkey } from '../dispute';
import { IndependentDkgSession } from '../independentDkg';
import { IndependentSigningSession } from '../independentSigning';
import { parseDkgCommitmentEvent } from '../events';
import { parseEncryptedShareEvent } from '../dkgMessages';
import type { SelectedJuror } from '../types';

const Point = secp256k1.Point;

function hex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

import { jurorWithKeys as makeJurors } from './helpers/fixtures';


/** Run a full 2-of-3 independent DKG; returns records keyed by juror idx. */
async function runDkg(
  jurors: ReturnType<typeof makeJurors>,
  disputeId: string,
  marketId: string,
): Promise<Map<number, { record: import('../types').DkgRecord; share: import('@vbyte/frost').SecretShare; pubkey: string }>> {
  const sessions = jurors.map(
    (j) =>
      new IndependentDkgSession({
        disputeId,
        marketId,
        myIdx: j.juror.idx,
        myPubkey: j.pubkey,
        mySeckey: j.seckey,
        threshold: 2,
        jurors: jurors.map((x) => x.juror),
      }),
  );

  const commitmentEventIds: Record<number, string> = {};
  for (const [i, session] of sessions.entries()) {
    const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
    const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
    commitmentEventIds[jurors[i].juror.idx] = 'commit-' + jurors[i].juror.idx;
    for (const other of sessions) {
      if (other === session) continue;
      other.addCommitment({
        idx: jurors[i].juror.idx,
        pubkey: jurors[i].pubkey,
        threshold: parsed.threshold,
        vssCommits: parsed.vssCommits,
        pok: parsed.pok,
        phaseNonce: parsed.phaseNonce,
        eventId: commitmentEventIds[jurors[i].juror.idx],
      });
    }
    for (const shareEvent of shareEvents) {
      const payload = parseEncryptedShareEvent({ ...shareEvent, pubkey: jurors[i].pubkey })!;
      sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
    }
  }

  for (const session of sessions) {
    await session.decryptShares();
    expect(session.verifyShares(commitmentEventIds)).toHaveLength(0);
    session.computeKey();
  }

  const out = new Map<number, { record: import('../types').DkgRecord; share: import('@vbyte/frost').SecretShare; pubkey: string }>();
  for (const [i, session] of sessions.entries()) {
    out.set(session.myIdx, {
      record: session.getRecord(),
      share: session.getShare(),
      pubkey: jurors[i].pubkey,
    });
  }
  return out;
}

/** Create signing sessions for every juror from a completed DKG. */
function makeSigningSessions(
  entries: ReturnType<typeof runDkg> extends Promise<infer M> ? M : never,
  disputeId: string,
  outcome: string,
): IndependentSigningSession[] {
  const first = [...entries.values()][0]!.record;
  return [...entries.values()].map(
    (e) =>
      new IndependentSigningSession({
        disputeId,
        myIdx: e.share.idx,
        myPubkey: e.pubkey,
        dkg: first,
        outcome,
        round: 1,
        nonceGuard: { consume: () => true }, // test-isolated guard
      }),
  );
}

describe('AUDIT-1: DKG proof-of-knowledge challenge encoding', () => {
  it('round-trips create → verify under the canonical v2 encoding', () => {
    const secret = hex(32);
    const pubkeyHex = Point.BASE.multiply(BigInt('0x' + secret)).toHex(true);
    const pok = createProofOfKnowledge(secret, pubkeyHex, 'market=m|dispute=d|juror=1');
    expect(verifyProofOfKnowledge(pubkeyHex, pok, 'market=m|dispute=d|juror=1')).toBe(true);
  });

  it('rejects a proof under a different domain (no cross-domain aliasing)', () => {
    const secret = hex(32);
    const pubkeyHex = Point.BASE.multiply(BigInt('0x' + secret)).toHex(true);
    const pok = createProofOfKnowledge(secret, pubkeyHex, 'market=m|dispute=d1|juror=1');
    expect(verifyProofOfKnowledge(pubkeyHex, pok, 'market=m|dispute=d2|juror=1')).toBe(false);
    expect(verifyProofOfKnowledge(pubkeyHex, pok, 'market=m|dispute=d1|juror=2')).toBe(false);
  });

  it('encodes colliding v1 domain tuples as DISTINCT canonical domains', () => {
    // The legacy renderer maps (market="x", dispute="y|dispute=z") and
    // (market="x|dispute=y", dispute="z") — juror equal — to the SAME
    // delimiter-joined string. dkgPokDomain length-prefixes every field, so
    // the two tuples stay distinct.
    const a = dkgPokDomain('x', 'y|dispute=z', 1);
    const b = dkgPokDomain('x|dispute=y', 'z', 1);
    expect(a).not.toBe(b);
    // Determinism + juror binding.
    expect(a).toBe(dkgPokDomain('x', 'y|dispute=z', 1));
    expect(a).not.toBe(dkgPokDomain('x', 'y|dispute=z', 2));
    // The legacy renderer really does alias the two tuples:
    const legacyRender = (market: string, dispute: string): string =>
      `market=${market}|dispute=${dispute}|juror=1`;
    expect(legacyRender('x', 'y|dispute=z')).toBe(legacyRender('x|dispute=y', 'z'));
  });

  it('still verifies legacy v1-encoded proofs (mixed-fleet compat window)', () => {
    const secret = BigInt('0x' + hex(32));
    const pubkeyPoint = Point.BASE.multiply(secret);
    const r = BigInt('0x' + hex(32)) % Point.Fn.ORDER;
    const noncePoint = Point.BASE.multiply(r);
    const domain = 'market=m|dispute=d|juror=2';
    const e =
      BigInt(
        '0x' +
          bytesToHex(
            sha256(
              new TextEncoder().encode(
                ['bao-frost-court/dkg-pok-v1', pubkeyPoint.toHex(true), noncePoint.toHex(true), domain].join('|'),
              ),
            ),
          ),
      ) % Point.Fn.ORDER;
    const z = (r + e * secret) % Point.Fn.ORDER;
    expect(
      verifyProofOfKnowledge(
        pubkeyPoint.toHex(true),
        { nonce: noncePoint.toHex(true), response: z.toString(16).padStart(64, '0') },
        domain,
      ),
    ).toBe(true);
    expect(
      verifyProofOfKnowledge(
        pubkeyPoint.toHex(true),
        { nonce: noncePoint.toHex(true), response: z.toString(16).padStart(64, '0') },
        'market=m|dispute=other|juror=2',
      ),
    ).toBe(false);
  });
});

describe('AUDIT-2: deriveDisputeGroupPubkey input injectivity', () => {
  const group = 'ab'.repeat(32);

  it('derives deterministically for valid inputs', () => {
    expect(deriveDisputeGroupPubkey(group, 'dispute-1')).toBe(
      deriveDisputeGroupPubkey(group, 'dispute-1'),
    );
    expect(deriveDisputeGroupPubkey(group, 'dispute-1')).not.toBe(
      deriveDisputeGroupPubkey(group, 'dispute-2'),
    );
  });

  it('rejects a non-fixed-width group pubkey (concat boundary contract)', () => {
    expect(() => deriveDisputeGroupPubkey('ab', 'x')).toThrow(/exactly 64 chars/);
    expect(() => deriveDisputeGroupPubkey('', 'x')).toThrow(/exactly 64 chars/);
    expect(() => deriveDisputeGroupPubkey('g'.repeat(63), 'x')).toThrow(/exactly 64 chars/);
    expect(() => deriveDisputeGroupPubkey('g'.repeat(65), 'x')).toThrow(/exactly 64 chars/);
  });

  it('rejects empty or oversized dispute ids', () => {
    expect(() => deriveDisputeGroupPubkey(group, '')).toThrow(/non-empty/);
    expect(() => deriveDisputeGroupPubkey(group, 'd'.repeat(513))).toThrow(/at most 512/);
    expect(() => deriveDisputeGroupPubkey(group, 'd'.repeat(512))).not.toThrow();
  });
});

describe('AUDIT-3: reveal set must equal commitment set (@vbyte/frost 1.1.5)', () => {
  it('full-coverage flow (3 commit, 3 reveal) aggregates a valid attestation', { timeout: 120_000 }, async () => {
    const jurors = makeJurors(3);
    const disputeId = 'a'.repeat(64);
    const entries = await runDkg(jurors, disputeId, 'market-audit-3');
    const signing = makeSigningSessions(entries, disputeId, 'yes');

    // 1. Everyone commits.
    for (const session of signing) {
      const { event } = session.createMyCommitment(entries.get(session.myIdx)!.share);
      for (const other of signing) {
        if (other === session) continue;
        expect(
          other.addCommitment({
            idx: session.myIdx,
            pubkey: session.myPubkey,
            commitmentPackage: {
              idx: session.myIdx,
              binder_pn: event.tags.find((t) => t[0] === 'binder_pn')![1],
              hidden_pn: event.tags.find((t) => t[0] === 'hidden_pn')![1],
            },
          }),
        ).toBe(true);
      }
    }
    // 2. Everyone reveals against the full commitment set.
    for (const session of signing) {
      const { event } = session.createMyReveal(entries.get(session.myIdx)!.share);
      for (const other of signing) {
        if (other === session) continue;
        expect(
          other.addReveal({
            idx: session.myIdx,
            pubkey: event.tags.find((t) => t[0] === 'pk')![1],
            publicNonce: {
              idx: session.myIdx,
              binder_pn: event.tags.find((t) => t[0] === 'nonce_binder')![1],
              hidden_pn: event.tags.find((t) => t[0] === 'nonce_hidden')![1],
            },
            partialSig: event.tags.find((t) => t[0] === 'psig')![1],
          }),
        ).toBe(true);
      }
    }
    // 3. Everyone aggregates — the final signature must verify.
    for (const session of signing) {
      expect(session.canAggregate()).toBe(true);
      const attestation = session.aggregate();
      expect(verifyFinalSignature(attestation.groupPubkey, attestation.message, attestation.signature)).toBe(true);
    }
  });

  it('canAggregate is false while a committed peer has not revealed (fail-early)', { timeout: 120_000 }, async () => {
    const jurors = makeJurors(3);
    const disputeId = 'b'.repeat(64);
    const entries = await runDkg(jurors, disputeId, 'market-audit-3b');
    const signing = makeSigningSessions(entries, disputeId, 'yes');

    for (const session of signing) {
      const { event } = session.createMyCommitment(entries.get(session.myIdx)!.share);
      for (const other of signing) {
        if (other === session) continue;
        other.addCommitment({
          idx: session.myIdx,
          pubkey: session.myPubkey,
          commitmentPackage: {
            idx: session.myIdx,
            binder_pn: event.tags.find((t) => t[0] === 'binder_pn')![1],
            hidden_pn: event.tags.find((t) => t[0] === 'hidden_pn')![1],
          },
        });
      }
    }
    // Only two of the three committed jurors reveal.
    for (const session of signing.slice(0, 2)) {
      const { event } = session.createMyReveal(entries.get(session.myIdx)!.share);
      for (const other of signing) {
        if (other === session) continue;
        other.addReveal({
          idx: session.myIdx,
          pubkey: event.tags.find((t) => t[0] === 'pk')![1],
          publicNonce: {
            idx: session.myIdx,
            binder_pn: event.tags.find((t) => t[0] === 'nonce_binder')![1],
            hidden_pn: event.tags.find((t) => t[0] === 'nonce_hidden')![1],
          },
          partialSig: event.tags.find((t) => t[0] === 'psig')![1],
        });
      }
    }
    for (const session of signing) {
      expect(session.canAggregate()).toBe(false);
      expect(() => session.aggregate()).toThrow(/reveal set must equal the commitment set/);
    }
  });
});

describe('AUDIT-4: binding factors and challenge are message-bound (anti-Drijvers pin)', () => {
  it('the signing context over the SAME commitment set differs for different messages', { timeout: 120_000 }, async () => {
    const jurors = makeJurors(3);
    const disputeId = 'a'.repeat(64);
    const entries = await runDkg(jurors, disputeId, 'market-audit-4');
    const first = [...entries.values()][0]!.record;
    const shares = [...entries.values()].map((e) => e.share);
    const pnonces = shares.map((share) => {
      const pkg = frost.Lib.create_commit_pkg(share);
      return { idx: pkg.idx, binder_pn: pkg.binder_pn, hidden_pn: pkg.hidden_pn };
    });
    const groupPk = hexToBytes(first.groupPubkey);
    const msgA = buildAttestationMessage('market-audit-4', 'yes', 1, disputeId);
    const msgB = buildAttestationMessage('market-audit-4', 'no', 1, disputeId);
    expect(msgA).not.toBe(msgB);

    const ctxA = frost.Lib.get_group_signing_ctx(groupPk, pnonces, msgA);
    const ctxB = frost.Lib.get_group_signing_ctx(groupPk, pnonces, msgB);
    // Same commitment set, different message ⇒ different binding prefix,
    // different binding factors, different challenge. The Drijvers/Wagner
    // k-tree attack requires exactly the opposite (message-independent
    // nonces); this pin makes that regression visible across a library
    // upgrade.
    expect(ctxA.bind_prefix).not.toBe(ctxB.bind_prefix);
    expect(ctxA.challenge).not.toBe(ctxB.challenge);
    expect(ctxA.bind_factors.map((f) => f.factor)).not.toEqual(ctxB.bind_factors.map((f) => f.factor));
    // Determinism: the SAME message over the SAME set derives the SAME context.
    const ctxA2 = frost.Lib.get_group_signing_ctx(groupPk, pnonces, msgA);
    expect(ctxA2.challenge).toBe(ctxA.challenge);
    expect(ctxA2.bind_factors.map((f) => f.factor)).toEqual(ctxA.bind_factors.map((f) => f.factor));
  });

  it('a group signature over message A does not verify over message B (no cross-message replay)', { timeout: 120_000 }, async () => {
    const jurors = makeJurors(3);
    const disputeId = 'b'.repeat(64);
    const entries = await runDkg(jurors, disputeId, 'market-audit-4b');
    const record = [...entries.values()][0]!.record;
    const shares = [...entries.values()].map((e) => e.share);
    const attestation = runNormalSigningRound({
      marketId: 'market-audit-4b',
      outcome: 'yes',
      round: 1,
      disputeEventId: disputeId,
      dkg: record,
      shares,
      nonceGuard: { consume: () => true }, // test-isolated guard
    });
    const msgA = attestation.message;
    const msgB = buildAttestationMessage('market-audit-4b', 'no', 1, disputeId);
    expect(msgA).not.toBe(msgB);
    expect(verifyFinalSignature(record.groupPubkeyXOnly, msgA, attestation.signature)).toBe(true);
    expect(verifyFinalSignature(record.groupPubkeyXOnly, msgB, attestation.signature)).toBe(false);
  });
});

describe('AUDIT-5: seededScalar counter/bias contract (CRYPTO_AUDIT §5.1)', () => {
  it('is deterministic and sensitive to both seed and info', () => {
    const seed = hexToBytes(hex(32));
    const infoA = new TextEncoder().encode('domain-a');
    const infoB = new TextEncoder().encode('domain-b');
    expect(seededScalar(seed, infoA)).toBe(seededScalar(seed, infoA));
    expect(seededScalar(seed, infoA)).not.toBe(seededScalar(seed, infoB));
    expect(seededScalar(seed, infoA)).not.toBe(seededScalar(hexToBytes(hex(32)), infoA));
  });

  it('stays in [1, N-1] and derives independent pseudorandom functions per (seed, info) pair', () => {
    const N = secp256k1.Point.Fn.ORDER;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const s = seededScalar(hexToBytes(hex(32)), new TextEncoder().encode(`info-${i}`));
      expect(s).toBeGreaterThan(0n);
      expect(s).toBeLessThan(N);
      seen.add(s.toString(16));
    }
    // No collision across 200 distinct (seed, info) pairs (birthday space is
    // ~2^128 — a collision would indicate the counter/domain are not in the
    // HKDF info field as documented).
    expect(seen.size).toBe(200);
  });
});
