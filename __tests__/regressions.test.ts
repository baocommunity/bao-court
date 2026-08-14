// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Regression tests for bugs found in the post-extraction review of the
 * standalone @bao/court package (2026-08-14), re-applied to the full Court
 * implementation. Each test names the bug it pins down.
 */

import { describe, expect, it } from 'vitest';
import * as frost from '@vbyte/frost';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

import { PedersenDkgAdapter, combineShares } from '../dkg';
import {
  aggregatePublicNonce,
  buildAttestationMessage,
  createProofOfKnowledge,
  randomScalar,
  scalarToHex,
} from '../crypto';
import {
  InMemoryNonceGuard,
  createCommitments,
  createRevealAndPartialSig,
  runNormalSigningRound,
} from '../signing';
import { validateAttestationEvent, verifyRawSignature } from '../validator';
import {
  buildAttestationEvent,
  buildFrostCommitEvent,
  buildFrostRevealEvent,
  parseFrostCommitEvent,
  parseFrostRevealEvent,
} from '../events';
import { parseEncryptedShareEvent } from '../dkgMessages';
import { selectJury, verifyJurySelection } from '../selection';
import { IndependentDkgSession } from '../independentDkg';
import type { FrostAttestation, JurorProfile, SelectedJuror } from '../types';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const Point = secp256k1.Point;

function makeJuror(idx: number, pubkey?: string): SelectedJuror {
  return {
    idx,
    nostrPubkey: pubkey ?? '0'.repeat(63) + String(idx),
    stakeCapacitySats: 10_000,
    stakeCommitment: {
      amountSats: 10_000,
      bondAddress: 'bc1q...',
      status: 'confirmed',
      committedAt: 1_700_000_000,
    },
    wotScore: 80,
    categories: ['world'],
    registeredAt: 1_700_000_000,
    priority: idx,
  };
}

describe('regression: DKG refresh with non-contiguous juror indices', () => {
  it('refreshShares works after a disqualification leaves gaps in the index set', () => {
    // Juror 2 is corrupted during the DKG and disqualified, leaving the
    // non-contiguous qualified set [1, 3, 4].
    const adapter = new PedersenDkgAdapter({
      unsafeTestMode: true,
      corruptShare: { accused: 2, victim: 1 },
    });
    const { record, shares } = adapter.run({
      marketId: 'refresh-gap-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors: [makeJuror(1), makeJuror(2), makeJuror(3), makeJuror(4)],
    });
    expect(record.verificationShares.map((v) => v.idx)).toEqual([1, 3, 4]);

    // Previously threw "record not found for index: 4" because
    // frost.Lib.gen_refresh_shares only addresses recipients 1..n.
    const refreshed = adapter.refreshShares({ record, shares });

    expect(refreshed.record.groupPubkey).toBe(record.groupPubkey);
    expect(refreshed.shares.map((s) => s.idx)).toEqual([1, 3, 4]);

    // Refreshed shares must still produce a valid threshold signature.
    const attestation = runNormalSigningRound({
      marketId: 'refresh-gap-market',
      outcome: 'YES',
      round: 1,
      dkg: refreshed.record,
      shares: refreshed.shares,
      nonceGuard: new InMemoryNonceGuard(),
    });
    expect(attestation.groupPubkey).toBe(record.groupPubkeyXOnly);
  });

  it('combineShares validates its input', () => {
    expect(() => combineShares([])).toThrow('at least one share');
    expect(() =>
      combineShares([
        { idx: 1, shareHex: 'aa' },
        { idx: 2, shareHex: 'bb' },
      ]),
    ).toThrow('same recipient index');
    expect(() => combineShares([{ idx: 1, shareHex: 'zz' }])).toThrow('Invalid share hex');
  });
});

describe('regression: aggregatePublicNonce matches the real signature nonce', () => {
  it('computes the group nonce that ends up in the final signature', () => {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'nonce-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors: [makeJuror(1), makeJuror(2), makeJuror(3)],
    });

    const message = buildAttestationMessage('nonce-market', 'YES', 1, 'a'.repeat(64));
    const commitments = createCommitments(shares);
    const pnonces = commitments.map((c) => ({
      idx: c.commit.idx,
      binder_pn: c.commit.binder_pn,
      hidden_pn: c.commit.hidden_pn,
    }));

    const predicted = aggregatePublicNonce(pnonces, record.groupPubkey, message);

    const ctx = frost.Lib.get_group_signing_ctx(
      record.groupPubkey,
      commitments.map((c) => c.commit),
      message,
    );
    const sigs = shares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(
        commitments.map((c) => c.commit),
        share,
      );
      return frost.Lib.sign_msg(ctx, share, commit);
    });
    const signatureHex = frost.Lib.combine_partial_sigs(ctx, sigs);

    // predicted is the compressed group nonce; the signature embeds R x-only.
    expect(predicted.slice(2)).toBe(signatureHex.slice(0, 64));
  });
});

describe('regression: default NonceGuard actually protects', () => {
  it('rejects reusing one commitment for two messages without an explicit guard', () => {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'guard-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors: [makeJuror(1), makeJuror(2), makeJuror(3)],
    });
    const commitments = createCommitments(shares);
    const share = shares[0];

    const first = createRevealAndPartialSig(
      {
        marketId: 'guard-market',
        outcome: 'YES',
        round: 1,
        dkg: record,
        shares: [share],
      },
      commitments,
      share,
    );
    expect(first.psig).toBeTruthy();

    // Same commitment, different message, still no explicit guard: the shared
    // process-wide default guard must catch the reuse (previously a fresh
    // empty guard was created per call and the reuse sailed through).
    expect(() =>
      createRevealAndPartialSig(
        {
          marketId: 'guard-market',
          outcome: 'NO',
          round: 1,
          dkg: record,
          shares: [share],
        },
        commitments,
        share,
      ),
    ).toThrow('nonce reuse');
  });
});

describe('regression: SigningReveal must not carry secret nonces', () => {
  it('pnonce contains only the public nonce fields', () => {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'leak-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors: [makeJuror(1), makeJuror(2)],
    });
    const commitments = createCommitments(shares);
    const reveal = createRevealAndPartialSig(
      {
        marketId: 'leak-market',
        outcome: 'YES',
        round: 1,
        dkg: record,
        shares: [shares[0]],
        nonceGuard: new InMemoryNonceGuard(),
      },
      commitments,
      shares[0],
    );

    // Secret nonces + the published partial sig reveal the juror's secret
    // share; they must never appear in a serializable reveal.
    expect(reveal.pnonce).not.toHaveProperty('binder_sn');
    expect(reveal.pnonce).not.toHaveProperty('hidden_sn');
    expect(Object.keys(reveal.pnonce).sort()).toEqual(['binder_pn', 'hidden_pn', 'idx']);
  });
});

describe('regression: jury selection verifiability', () => {
  const pool: JurorProfile[] = Array.from({ length: 6 }, (_, i) => ({
    nostrPubkey: String(i + 1).padStart(64, '0'),
    stakeCapacitySats: 100_000,
    stakeCommitment: { amountSats: 10_000, bondAddress: 'bc1q', status: 'confirmed' },
    wotScore: 90,
    categories: ['world'],
    registeredAt: 1_600_000_000,
  }));

  const params = {
    disputeEventId: 'd'.repeat(64),
    blockHash: 'b'.repeat(64),
    marketCategory: 'world',
    marketVolumeSats: 1_000_000,
    jurySize: 3,
  };

  it('selection is reproducible with a fixed referenceTimeSec', () => {
    const anchored = { ...params, referenceTimeSec: 1_800_000_000 };
    const selected = selectJury(pool, anchored);
    // Verification at any later wall-clock time must still succeed.
    expect(verifyJurySelection(pool, selected, anchored)).toBe(true);
  });

  it('a juror aging into eligibility does not flip verification when anchored', () => {
    const t0 = 1_700_000_000;
    const young: JurorProfile = {
      nostrPubkey: 'f'.repeat(64),
      stakeCapacitySats: 100_000,
      stakeCommitment: { amountSats: 10_000, bondAddress: 'bc1q', status: 'confirmed' },
      wotScore: 90,
      categories: ['world'],
      // 1 day old at t0: not eligible with minAccountAgeDays 7.
      registeredAt: t0 - 86_400,
    };
    const anchored = { ...params, referenceTimeSec: t0 };
    const selected = selectJury([...pool, young], anchored);
    expect(selected.some((j) => j.nostrPubkey === young.nostrPubkey)).toBe(false);
    expect(verifyJurySelection([...pool, young], selected, anchored)).toBe(true);
  });
});

describe('regression: attestation validator consistency', () => {
  const publisherSeckey = generateSecretKey();

  function signedAttestation() {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'val-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors: [makeJuror(1), makeJuror(2)],
    });
    const attestation: FrostAttestation = runNormalSigningRound({
      marketId: 'val-market',
      outcome: 'YES',
      round: 1,
      disputeEventId: 'a'.repeat(64),
      dkg: record,
      shares,
      nonceGuard: new InMemoryNonceGuard(),
    });
    const template = buildAttestationEvent({ attestation, marketEventId: 'e'.repeat(64) });
    return { event: finalizeEvent(template, publisherSeckey), attestation };
  }

  it('accepts a well-formed dispute attestation', () => {
    const { event, attestation } = signedAttestation();
    const result = validateAttestationEvent(event);
    expect(result.valid).toBe(true);
    expect(result.disputeEventId).toBe(attestation.disputeEventId);
  });

  it('rejects a nonce tag that does not match the signature', () => {
    const { event } = signedAttestation();
    const tampered = finalizeEvent(
      {
        kind: event.kind,
        created_at: event.created_at,
        content: event.content,
        tags: event.tags.map((t) => (t[0] === 'nonce' ? ['nonce', '0'.repeat(64)] : t)),
      },
      publisherSeckey,
    );
    const result = validateAttestationEvent(tampered);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Nonce tag');
  });

  it('rejects a kind 39007 attestation without a dispute tag', () => {
    const { event } = signedAttestation();
    const stripped = finalizeEvent(
      {
        kind: event.kind,
        created_at: event.created_at,
        content: event.content,
        tags: event.tags.filter((t) => t[0] !== 'dispute'),
      },
      publisherSeckey,
    );
    const result = validateAttestationEvent(stripped);
    expect(result.valid).toBe(false);
    expect(result.error?.toLowerCase()).toContain('dispute');
  });

  it('verifyRawSignature returns false on malformed hex instead of throwing', () => {
    expect(verifyRawSignature('zz', 'aa', 'bb')).toBe(false);
  });

  it('buildAttestationEvent throws a descriptive error on a bad call', () => {
    expect(() =>
      buildAttestationEvent({} as unknown as Parameters<typeof buildAttestationEvent>[0]),
    ).toThrow('buildAttestationEvent');
  });
});

describe('regression: FROST commit/reveal event round-trips', () => {
  it('parseFrostCommitEvent round-trips buildFrostCommitEvent', () => {
    const template = buildFrostCommitEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 3,
      commitmentPackage: { idx: 3, binder_pn: 'b'.repeat(66), hidden_pn: 'c'.repeat(66) },
    });
    const parsed = parseFrostCommitEvent({ ...template, pubkey: 'a'.repeat(64) });
    expect(parsed).not.toBeNull();
    expect(parsed?.jurorIdx).toBe(3);
    expect(parsed?.commitmentPackage.binder_pn).toBe('b'.repeat(66));
    expect(parsed?.commitmentPackage.hidden_pn).toBe('c'.repeat(66));
  });

  it('parseFrostRevealEvent round-trips buildFrostRevealEvent including frostPubkey', () => {
    const template = buildFrostRevealEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 2,
      publicNonce: { idx: 2, binder_pn: 'b'.repeat(66), hidden_pn: 'c'.repeat(66) },
      partialSig: 's'.repeat(64),
      frostPubkey: '02' + 'f'.repeat(64),
    });
    const parsed = parseFrostRevealEvent({ ...template, pubkey: 'a'.repeat(64) });
    expect(parsed).not.toBeNull();
    expect(parsed?.jurorIdx).toBe(2);
    expect(parsed?.frostPubkey).toBe('02' + 'f'.repeat(64));
    expect(parsed?.partialSig).toBe('s'.repeat(64));
    expect(parsed?.publicNonce.binder_pn).toBe('b'.repeat(66));
  });

  it('rejects malformed juror indices', () => {
    const template = buildFrostCommitEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 3,
      commitmentPackage: { idx: 3, binder_pn: 'b'.repeat(66), hidden_pn: 'c'.repeat(66) },
    });
    const tampered = {
      ...template,
      tags: template.tags.map((t) => (t[0] === 'juror' ? ['juror', 'notanumber'] : t)),
      content: '{}',
    };
    expect(parseFrostCommitEvent({ ...tampered, pubkey: 'a'.repeat(64) })).toBeNull();
  });
});

describe('regression: dkgMessages parsers reject NaN indices', () => {
  it('parseEncryptedShareEvent returns null for a non-numeric from tag', () => {
    const event = {
      kind: 39003,
      created_at: 1,
      tags: [
        ['d', 'x:1:2'],
        ['dispute', 'x'],
        ['from', 'notanumber', 'a'.repeat(64)],
        ['to', '2', 'b'.repeat(64)],
      ],
      content: JSON.stringify({ encryptedShare: 'abc', phaseNonce: 'nonce' }),
    };
    expect(parseEncryptedShareEvent(event)).toBeNull();
  });
});

describe('regression: IndependentDkgSession roster binding', () => {
  function makeRealJurors(count: number) {
    return Array.from({ length: count }, (_, i) => {
      const seckey = generateSecretKey();
      const pubkey = getPublicKey(seckey);
      return { seckey, pubkey, juror: makeJuror(i + 1, pubkey) };
    });
  }

  it('rejects a commitment published under an honest juror index by an attacker', () => {
    const jurors = makeRealJurors(3);
    const disputeId = 'd'.repeat(64);
    const victim = new IndependentDkgSession({
      disputeId,
      myIdx: jurors[1].juror.idx,
      myPubkey: jurors[1].pubkey,
      mySeckey: jurors[1].seckey,
      threshold: 2,
      jurors: jurors.map((j) => j.juror),
    });

    // Attacker crafts a cryptographically valid commitment (real PoK of their
    // own secret) but publishes it under honest juror 1's index with the
    // attacker's pubkey. Previously this was accepted and poisoned the
    // attempt via a phase-nonce mismatch.
    const attackerSecret = randomScalar();
    const attackerCommit = Point.BASE.multiply(attackerSecret);
    const pok = createProofOfKnowledge(
      scalarToHex(attackerSecret),
      attackerCommit.toHex(true),
      `market=|dispute=${disputeId}|juror=1`,
    );
    const accepted = victim.addCommitment({
      idx: 1,
      pubkey: 'f'.repeat(64), // attacker's pubkey, not juror 1's
      threshold: 2,
      vssCommits: [attackerCommit.toHex(true), attackerCommit.toHex(true)],
      pok,
      phaseNonce: 'attacker-phase',
    });
    expect(accepted).toBe(false);

    // A commitment from an index that is not a selected juror is rejected too.
    const rejected = victim.addCommitment({
      idx: 99,
      pubkey: 'f'.repeat(64),
      threshold: 2,
      vssCommits: [attackerCommit.toHex(true), attackerCommit.toHex(true)],
      pok,
      phaseNonce: 'attacker-phase',
    });
    expect(rejected).toBe(false);
  });

  it('rejects encrypted shares with a forged sender pubkey', () => {
    const jurors = makeRealJurors(3);
    const disputeId = 'd'.repeat(64);
    const victim = new IndependentDkgSession({
      disputeId,
      myIdx: jurors[1].juror.idx,
      myPubkey: jurors[1].pubkey,
      mySeckey: jurors[1].seckey,
      threshold: 2,
      jurors: jurors.map((j) => j.juror),
    });

    const forged = victim.addEncryptedShare({
      disputeId,
      fromIdx: jurors[0].juror.idx,
      fromPubkey: 'f'.repeat(64),
      toIdx: jurors[1].juror.idx,
      toPubkey: jurors[1].pubkey,
      encryptedShare: 'bogus-ciphertext',
      phaseNonce: 'bogus-phase',
    });
    expect(forged).toBe(false);

    const outsider = victim.addEncryptedShare({
      disputeId,
      fromIdx: 99,
      fromPubkey: 'f'.repeat(64),
      toIdx: jurors[1].juror.idx,
      toPubkey: jurors[1].pubkey,
      encryptedShare: 'bogus-ciphertext',
      phaseNonce: 'bogus-phase',
    });
    expect(outsider).toBe(false);
  });

  it('rejects a conflicting second commitment as equivocation', async () => {
    const jurors = makeRealJurors(3);
    const disputeId = 'd'.repeat(64);
    const session = new IndependentDkgSession({
      disputeId,
      myIdx: jurors[0].juror.idx,
      myPubkey: jurors[0].pubkey,
      mySeckey: jurors[0].seckey,
      threshold: 2,
      jurors: jurors.map((j) => j.juror),
    });

    const peer = new IndependentDkgSession({
      disputeId,
      myIdx: jurors[1].juror.idx,
      myPubkey: jurors[1].pubkey,
      mySeckey: jurors[1].seckey,
      threshold: 2,
      jurors: jurors.map((j) => j.juror),
    });
    const { commitmentEvent } = await peer.generateCommitmentAndShares();
    const { parseDkgCommitmentEvent } = await import('../events');
    const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[1].pubkey })!;

    const accepted = session.addCommitment({
      idx: jurors[1].juror.idx,
      pubkey: jurors[1].pubkey,
      threshold: parsed.threshold,
      vssCommits: parsed.vssCommits,
      pok: parsed.pok,
      phaseNonce: parsed.phaseNonce,
    });
    expect(accepted).toBe(true);

    // Idempotent re-delivery of the same event is fine.
    expect(
      session.addCommitment({
        idx: jurors[1].juror.idx,
        pubkey: jurors[1].pubkey,
        threshold: parsed.threshold,
        vssCommits: parsed.vssCommits,
        pok: parsed.pok,
        phaseNonce: parsed.phaseNonce,
      }),
    ).toBe(true);

    // A conflicting commitment under the same index is rejected (and the
    // original is not silently overwritten).
    const attackerSecret = randomScalar();
    const attackerCommit = Point.BASE.multiply(attackerSecret);
    const pok = createProofOfKnowledge(
      scalarToHex(attackerSecret),
      attackerCommit.toHex(true),
      `market=|dispute=${disputeId}|juror=${jurors[1].juror.idx}`,
    );
    expect(
      session.addCommitment({
        idx: jurors[1].juror.idx,
        pubkey: jurors[1].pubkey,
        threshold: 2,
        vssCommits: [attackerCommit.toHex(true), attackerCommit.toHex(true)],
        pok,
        phaseNonce: 'different-phase',
      }),
    ).toBe(false);
  });

  it('validates constructor parameters', () => {
    const jurors = makeRealJurors(3).map((j) => j.juror);
    expect(
      () =>
        new IndependentDkgSession({
          disputeId: 'd'.repeat(64),
          myIdx: 1,
          myPubkey: 'a'.repeat(64),
          mySeckey: generateSecretKey(),
          threshold: 1,
          jurors,
        }),
    ).toThrow('Threshold');
    expect(
      () =>
        new IndependentDkgSession({
          disputeId: 'd'.repeat(64),
          myIdx: 99,
          myPubkey: 'a'.repeat(64),
          mySeckey: generateSecretKey(),
          threshold: 2,
          jurors,
        }),
    ).toThrow('myIdx');
  });
});
