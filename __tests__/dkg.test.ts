// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import * as frost from '@vbyte/frost';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { PedersenDkgAdapter, generateFrostKeys } from '../dkg';
import { buildAttestationMessage, deriveXOnlyPubkey, verifyFinalSignature } from '../crypto';
import { runDisputeOverrideSigning } from '../dispute';
import type { SelectedJuror } from '../types';

function makeJuror(idx: number): SelectedJuror {
  return {
    idx,
    nostrPubkey: '0'.repeat(63) + String(idx),
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

describe('PedersenDkgAdapter', () => {
  const jurors = [makeJuror(1), makeJuror(2), makeJuror(3)];

  it('produces a valid DkgRecord and secret shares', () => {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    expect(record.marketId).toBe('demo-market');
    expect(record.threshold).toBe(2);
    expect(record.participants).toBe(3);
    expect(record.groupPubkey).toMatch(/^[0-9a-f]{66}$/);
    expect(record.groupPubkeyXOnly).toMatch(/^[0-9a-f]{64}$/);
    expect(record.verificationShares).toHaveLength(3);
    expect(record.vssCommitments).toHaveLength(3);
    expect(shares).toHaveLength(3);

    for (const share of shares) {
      const expected = deriveXOnlyPubkey(share.seckey);
      const actual = record.verificationShares.find((v) => v.idx === share.idx)?.pubkey;
      expect(actual).toBe(expected);
    }
  });

  it('produces shares that can sign and verify an attestation', () => {
    const { record, shares } = generateFrostKeys({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    const message = buildAttestationMessage('demo-market', 'YES', 1, 'a'.repeat(64));
    const commitments = shares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);

    const shareSigs = shares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      const sig = frost.Lib.sign_msg(ctx, share, commit);
      expect(frost.Lib.verify_partial_sig(ctx, commit, sig.pubkey, sig.psig)).toBe(true);
      return { idx: share.idx, pubkey: sig.pubkey, psig: sig.psig };
    });

    const signatureHex = frost.Lib.combine_partial_sigs(ctx, shareSigs);
    expect(frost.Lib.verify_final_sig(ctx, hexToBytes(message), hexToBytes(signatureHex))).toBe(
      true,
    );
  });

  it('disqualifies a participant whose proof-of-knowledge does not verify', () => {
    // corruptPok makes juror 1 commit to its constant point but respond with a
    // different scalar — the adapter must notice the broken POK and disqualify
    // it exactly like an invalid share, leaving a 2-of-2 group.
    const { record, shares } = new PedersenDkgAdapter({
      unsafeTestMode: true,
      corruptPok: { accused: 1 },
    }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    expect(record.participants).toBe(2);
    expect(record.jurorPubkeys).not.toContain(jurors[0].nostrPubkey);
    expect(shares).toHaveLength(2);

    // The remaining shares must still sign and verify.
    const message = buildAttestationMessage('demo-market', 'YES', 1, 'a'.repeat(64));
    const commitments = shares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);
    const shareSigs = shares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      const sig = frost.Lib.sign_msg(ctx, share, commit);
      return { idx: share.idx, pubkey: sig.pubkey, psig: sig.psig };
    });
    const signatureHex = frost.Lib.combine_partial_sigs(ctx, shareSigs);
    expect(frost.Lib.verify_final_sig(ctx, hexToBytes(message), hexToBytes(signatureHex))).toBe(
      true,
    );
  });

  it('rejects POK-disqualified participants with a real POK failure', () => {
    // Sanity: the corruptPok hook must actually break verification (if the
    // hook were a no-op, the disqualifier would be untested). Run the same
    // params WITHOUT the hook and assert nobody is disqualified.
    const { record } = new PedersenDkgAdapter().run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });
    expect(record.participants).toBe(3);
  });

  it('disqualifies a participant that sends an invalid share', () => {
    const { record, shares } = new PedersenDkgAdapter({
      unsafeTestMode: true,
      corruptShare: { accused: 1, victim: 2 },
    }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    // Juror 1 should be disqualified, leaving 2 and 3 as a 2-of-2 group.
    expect(record.participants).toBe(2);
    expect(record.jurorPubkeys).not.toContain(jurors[0].nostrPubkey);
    expect(shares).toHaveLength(2);

    // The remaining shares must still sign and verify.
    const message = buildAttestationMessage('demo-market', 'NO', 1, 'a'.repeat(64));
    const commitments = shares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);
    const shareSigs = shares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      const sig = frost.Lib.sign_msg(ctx, share, commit);
      return { idx: share.idx, pubkey: sig.pubkey, psig: sig.psig };
    });
    const signatureHex = frost.Lib.combine_partial_sigs(ctx, shareSigs);
    expect(frost.Lib.verify_final_sig(ctx, hexToBytes(message), hexToBytes(signatureHex))).toBe(
      true,
    );
  });

  it('rejects duplicate juror indices', () => {
    expect(() =>
      generateFrostKeys({
        marketId: 'demo-market',
        disputeId: 'a'.repeat(64),
        threshold: 2,
        jurors: [makeJuror(1), makeJuror(1)],
      }),
    ).toThrow('Duplicate juror indices');
  });

  it('rejects fewer participants than threshold', () => {
    expect(() =>
      generateFrostKeys({
        marketId: 'demo-market',
        disputeId: 'a'.repeat(64),
        threshold: 3,
        jurors: [makeJuror(1), makeJuror(2)],
      }),
    ).toThrow('Participants cannot be less than threshold');
  });

  it('produces the same group key and shares when a seed is provided', () => {
    const seed = bytesToHex(sha256(new TextEncoder().encode('shared-demo-seed')));

    const first = new PedersenDkgAdapter({ unsafeTestMode: true }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
      seed,
    });

    const second = new PedersenDkgAdapter({ unsafeTestMode: true }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
      seed,
    });

    expect(first.record.groupPubkey).toBe(second.record.groupPubkey);
    expect(first.record.groupPubkeyXOnly).toBe(second.record.groupPubkeyXOnly);
    expect(first.shares.map((s) => ({ idx: s.idx, seckey: s.seckey }))).toEqual(
      second.shares.map((s) => ({ idx: s.idx, seckey: s.seckey })),
    );
  });

  it('produces different keys for different seeds', () => {
    const a = new PedersenDkgAdapter({ unsafeTestMode: true }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
      seed: 'seed-a',
    });
    const b = new PedersenDkgAdapter({ unsafeTestMode: true }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
      seed: 'seed-b',
    });
    expect(a.record.groupPubkey).not.toBe(b.record.groupPubkey);
  });

  it('produces shares that can sign a dispute attestation deterministically', () => {
    const seed = bytesToHex(sha256(new TextEncoder().encode('shared-demo-seed')));
    const { record, shares } = new PedersenDkgAdapter({ unsafeTestMode: true }).run({
      marketId: 'demo-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
      seed,
    });

    const attestation = runDisputeOverrideSigning({
      dispute: {
        disputeId: 'a'.repeat(64),
        marketId: 'demo-market',
        challengerPubkey: jurors[0].nostrPubkey,
        respondentPubkey: '',
        evidenceHashes: [],
        proposedOutcome: 'YES',
      },
      dkg: record,
      shares,
      outcome: 'YES',
    });

    expect(attestation.outcome).toBe('YES');
    expect(attestation.groupPubkey).toBe(record.groupPubkeyXOnly);
    expect(verifyFinalSignature(record.groupPubkey, attestation.message, attestation.signature)).toBe(true);
  });
});


describe('PedersenDkgAdapter.refreshShares', () => {
  const jurors = [makeJuror(1), makeJuror(2), makeJuror(3)];

  it('refreshes shares while preserving the group public key', () => {
    const adapter = new PedersenDkgAdapter();
    const first = adapter.run({
      marketId: 'refresh-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    const refreshed = adapter.refreshShares({
      record: first.record,
      shares: first.shares,
    });

    expect(refreshed.record.groupPubkey).toBe(first.record.groupPubkey);
    expect(refreshed.record.groupPubkeyXOnly).toBe(first.record.groupPubkeyXOnly);
    expect(refreshed.shares).toHaveLength(first.shares.length);
    expect(refreshed.shares.map((s) => s.idx)).toEqual(first.shares.map((s) => s.idx));
    expect(refreshed.shares.some((s, i) => s.seckey !== first.shares[i].seckey)).toBe(true);

    for (const share of refreshed.shares) {
      const expected = deriveXOnlyPubkey(share.seckey);
      const actual = refreshed.record.verificationShares.find((v) => v.idx === share.idx)?.pubkey;
      expect(actual).toBe(expected);
    }
  });

  it('refreshed shares can sign and verify a message', () => {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'refresh-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    const { record: refreshedRecord, shares: refreshedShares } = new PedersenDkgAdapter().refreshShares(
      { record, shares },
    );

    const message = buildAttestationMessage('refresh-market', 'YES', 1, 'a'.repeat(64));
    const commitments = refreshedShares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(refreshedRecord.groupPubkey, commitments, message);

    const shareSigs = refreshedShares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      const sig = frost.Lib.sign_msg(ctx, share, commit);
      expect(frost.Lib.verify_partial_sig(ctx, commit, sig.pubkey, sig.psig)).toBe(true);
      return { idx: share.idx, pubkey: sig.pubkey, psig: sig.psig };
    });

    const signatureHex = frost.Lib.combine_partial_sigs(ctx, shareSigs);
    expect(frost.Lib.verify_final_sig(ctx, hexToBytes(message), hexToBytes(signatureHex))).toBe(
      true,
    );
  });

  it('fails when old and refreshed shares are mixed in one signing round', () => {
    const { record, shares } = new PedersenDkgAdapter().run({
      marketId: 'refresh-market',
      disputeId: 'a'.repeat(64),
      threshold: 2,
      jurors,
    });

    const { shares: refreshedShares } = new PedersenDkgAdapter().refreshShares({ record, shares });

    const message = buildAttestationMessage('refresh-market', 'NO', 1, 'a'.repeat(64));
    const mixedShares = [shares[0], refreshedShares[1], refreshedShares[2]];
    const commitments = mixedShares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);

    const shareSigs = mixedShares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      return frost.Lib.sign_msg(ctx, share, commit);
    });

    const signatureHex = frost.Lib.combine_partial_sigs(ctx, shareSigs);
    expect(frost.Lib.verify_final_sig(ctx, hexToBytes(message), hexToBytes(signatureHex))).toBe(
      false,
    );
  });
});
