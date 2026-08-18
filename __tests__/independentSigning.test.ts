// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { IndependentDkgSession } from '../independentDkg';
import { IndependentSigningSession } from '../independentSigning';
import { parseDkgCommitmentEvent } from '../events';
import { parseEncryptedShareEvent } from '../dkgMessages';
import { buildAttestationMessage, verifyFinalSignature } from '../crypto';
import { createCommitment } from '../signing';
import type { SelectedJuror } from '../types';

function makeJurors(count: number): { juror: SelectedJuror; seckey: Uint8Array; pubkey: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const seckey = generateSecretKey();
    const pubkey = getPublicKey(seckey);
    return {
      juror: {
        idx: i + 1,
        nostrPubkey: pubkey,
        stakeCapacitySats: 10_000,
        stakeCommitment: { amountSats: 10_000, bondAddress: 'bc1q', status: 'confirmed', committedAt: 1 },
        wotScore: 80,
        categories: ['world'],
        registeredAt: 1,
        priority: i + 1,
      } as SelectedJuror,
      seckey,
      pubkey,
    };
  });
}

// Full 2-of-3 DKG setup shared by signing-session tests.
async function runSigningSetup(
  jurors: ReturnType<typeof makeJurors>,
  disputeId: string,
  marketId: string,
): Promise<{ dkgRecord: import('../types').DkgRecord; shares: import('@vbyte/frost').SecretShare[] }> {
  const dkgSessions = jurors.map((j) => new IndependentDkgSession({
    disputeId,
    marketId,
    myIdx: j.juror.idx,
    myPubkey: j.pubkey,
    mySeckey: j.seckey,
    threshold: 2,
    jurors: jurors.map((x) => x.juror),
  }));

  const commitmentEventIds: Record<number, string> = {};
  for (const [i, session] of dkgSessions.entries()) {
    const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
    const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
    commitmentEventIds[jurors[i].juror.idx] = 'commit-' + jurors[i].juror.idx;
    for (const other of dkgSessions) {
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
      const payload = parseEncryptedShareEvent(shareEvent)!;
      dkgSessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
    }
  }

  for (const session of dkgSessions) {
    await session.decryptShares();
    session.verifyShares(commitmentEventIds);
    session.computeKey();
  }

  return {
    dkgRecord: dkgSessions[0].getRecord(),
    shares: dkgSessions.map((s) => s.getShare()),
  };
}

describe('IndependentSigningSession', () => {
  it('aggregates partial signatures into a valid dispute attestation', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'd'.repeat(64);
    const marketId = 'demo-market';

    const dkgSessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      marketId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const commitmentEventIds: Record<number, string> = {};
    for (const [i, session] of dkgSessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      commitmentEventIds[jurors[i].juror.idx] = 'commit-' + jurors[i].juror.idx;

      for (const other of dkgSessions) {
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
        const payload = parseEncryptedShareEvent(shareEvent)!;
        dkgSessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of dkgSessions) {
      await session.decryptShares();
      session.verifyShares(commitmentEventIds);
      session.computeKey();
    }

    const dkgRecord = dkgSessions[0].getRecord();
    const shares = dkgSessions.map((s) => s.getShare());

    const signingSessions = dkgSessions.map((s) => new IndependentSigningSession({
      disputeId,
      myIdx: s.myIdx,
      myPubkey: s.myPubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
    }));

    // Commit phase.
    for (const [i, session] of signingSessions.entries()) {
      const { event } = session.createMyCommitment(shares[i]);
      for (const other of signingSessions) {
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

    // Reveal phase.
    for (const [i, session] of signingSessions.entries()) {
      const { event } = session.createMyReveal(shares[i]);
      for (const other of signingSessions) {
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

    const aggregator = signingSessions[0];
    const attestation = aggregator.aggregate('e'.repeat(64));
    expect(attestation.kind).toBe(39007);
    expect(attestation.outcome).toBe('YES');
    expect(verifyFinalSignature(dkgRecord.groupPubkey, attestation.message, attestation.signature)).toBe(true);
  });

  it('binds the dispute verdict commitment into the signed message', async () => {
    const jurors = makeJurors(3);
    const disputeId = 'v'.repeat(64);
    const marketId = 'verdict-market';
    const verdictHash = 'f'.repeat(64);

    const { dkgRecord, shares } = await runSigningSetup(jurors, disputeId, marketId);
    const expectedMessage = buildAttestationMessage(marketId, 'YES', 1, disputeId, verdictHash);

    const signingSessions = jurors.map((j) => new IndependentSigningSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
      verdictHash,
    }));
    for (const session of signingSessions) {
      expect(session.message).toBe(expectedMessage);
    }

    for (const [i, session] of signingSessions.entries()) {
      const { event } = session.createMyCommitment(shares[i]);
      for (const other of signingSessions) {
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
    for (const [i, session] of signingSessions.entries()) {
      const { event } = session.createMyReveal(shares[i]);
      for (const other of signingSessions) {
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

    const attestation = signingSessions[0].aggregate('e'.repeat(64));
    // The aggregate must carry the verdict commitment AND sign the verdict-
    // bound message (not the verdict-less variant) — otherwise the kind-39007
    // attestation fails the validator's verdict-binding requirement.
    expect(attestation.verdictHash).toBe(verdictHash);
    expect(attestation.message).toBe(expectedMessage);
    expect(verifyFinalSignature(dkgRecord.groupPubkey, expectedMessage, attestation.signature)).toBe(true);
  });

  it('prevents double reveal with the same nonce commitment', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'n'.repeat(64);
    const marketId = 'nonce-guard-market';

    const dkgSessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      marketId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const commitmentEventIds: Record<number, string> = {};
    for (const [i, session] of dkgSessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      commitmentEventIds[jurors[i].juror.idx] = 'commit-' + jurors[i].juror.idx;
      for (const other of dkgSessions) {
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
        const payload = parseEncryptedShareEvent(shareEvent)!;
        dkgSessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of dkgSessions) {
      await session.decryptShares();
      session.verifyShares(commitmentEventIds);
      session.computeKey();
    }

    const dkgRecord = dkgSessions[0].getRecord();
    const shares = dkgSessions.map((s) => s.getShare());

    const signingSession = new IndependentSigningSession({
      disputeId,
      myIdx: jurors[0].juror.idx,
      myPubkey: jurors[0].pubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
    });

    // Collect peer commitments.
    for (let i = 1; i < shares.length; i++) {
      const peerCommit = createCommitment(shares[i]);
      signingSession.addCommitment({
        idx: peerCommit.idx,
        pubkey: jurors[i].pubkey,
        commitmentPackage: {
          idx: peerCommit.idx,
          binder_pn: peerCommit.commit.binder_pn,
          hidden_pn: peerCommit.commit.hidden_pn,
        },
      });
    }

    signingSession.createMyCommitment(shares[0]);
    signingSession.createMyReveal(shares[0]);
    expect(() => signingSession.createMyReveal(shares[0])).toThrow(/FROST nonce reuse detected/);
  });

  it('restores a snapshot and aggregates without re-collecting events', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 's'.repeat(64);
    const marketId = 'snapshot-market';

    const dkgSessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      marketId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const commitmentEventIds: Record<number, string> = {};
    for (const [i, session] of dkgSessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      commitmentEventIds[jurors[i].juror.idx] = 'commit-' + jurors[i].juror.idx;
      for (const other of dkgSessions) {
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
        const payload = parseEncryptedShareEvent(shareEvent)!;
        dkgSessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of dkgSessions) {
      await session.decryptShares();
      session.verifyShares(commitmentEventIds);
      session.computeKey();
    }

    const dkgRecord = dkgSessions[0].getRecord();
    const shares = dkgSessions.map((s) => s.getShare());

    const signingSessions = dkgSessions.map((s) => new IndependentSigningSession({
      disputeId,
      myIdx: s.myIdx,
      myPubkey: s.myPubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
    }));

    // Commit phase.
    for (const [i, session] of signingSessions.entries()) {
      const { event } = session.createMyCommitment(shares[i]);
      for (const other of signingSessions) {
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

    // Reveal phase.
    for (const [i, session] of signingSessions.entries()) {
      const { event } = session.createMyReveal(shares[i]);
      for (const other of signingSessions) {
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

    const originalAggregator = signingSessions[0];
    const snapshot = originalAggregator.toSnapshot();

    // Recreate the aggregator session and restore collected state.
    const restoredAggregator = new IndependentSigningSession({
      disputeId,
      myIdx: originalAggregator.myIdx,
      myPubkey: originalAggregator.myPubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
      snapshot,
    });

    const attestation = restoredAggregator.aggregate('e'.repeat(64));
    expect(attestation.kind).toBe(39007);
    expect(attestation.outcome).toBe('YES');
    expect(verifyFinalSignature(dkgRecord.groupPubkey, attestation.message, attestation.signature)).toBe(true);
  });

  it('validates snapshot message and ignores orphan reveals', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'v'.repeat(64);
    const marketId = 'validate-snapshot-market';

    const dkgSessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      marketId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const commitmentEventIds: Record<number, string> = {};
    for (const [i, session] of dkgSessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      commitmentEventIds[jurors[i].juror.idx] = 'commit-' + jurors[i].juror.idx;
      for (const other of dkgSessions) {
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
        const payload = parseEncryptedShareEvent(shareEvent)!;
        dkgSessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of dkgSessions) {
      await session.decryptShares();
      session.verifyShares(commitmentEventIds);
      session.computeKey();
    }

    const dkgRecord = dkgSessions[0].getRecord();
    const shares = dkgSessions.map((s) => s.getShare());

    const signingSession = new IndependentSigningSession({
      disputeId,
      myIdx: jurors[0].juror.idx,
      myPubkey: jurors[0].pubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
    });

    // Collect only peer 2's commitment, not peer 3's.
    const peer2Commit = createCommitment(shares[1]);
    signingSession.addCommitment({
      idx: peer2Commit.idx,
      pubkey: jurors[1].pubkey,
      commitmentPackage: {
        idx: peer2Commit.idx,
        binder_pn: peer2Commit.commit.binder_pn,
        hidden_pn: peer2Commit.commit.hidden_pn,
      },
    });

    // Snapshot with a stale/wrong message should be rejected.
    expect(() => new IndependentSigningSession({
      disputeId,
      myIdx: signingSession.myIdx,
      myPubkey: signingSession.myPubkey,
      dkg: dkgRecord,
      outcome: 'NO',
      round: 1,
      disputeEventId: disputeId,
      snapshot: signingSession.toSnapshot(),
    })).toThrow(/Signing snapshot message does not match this session/);

    const peer3Reveal = createCommitment(shares[2]);
    const orphanSnapshot = {
      version: 1,
      message: signingSession.toSnapshot().message,
      commitments: signingSession.toSnapshot().commitments,
      reveals: [
        {
          idx: peer3Reveal.idx,
          pubkey: jurors[2].pubkey,
          binder_pn: peer3Reveal.commit.binder_pn,
          hidden_pn: peer3Reveal.commit.hidden_pn,
          psig: '00'.repeat(64),
        },
      ],
    };

    const restored = new IndependentSigningSession({
      disputeId,
      myIdx: signingSession.myIdx,
      myPubkey: signingSession.myPubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
      snapshot: orphanSnapshot,
    });

    // The orphan reveal for peer 3 must be ignored because peer 3's commitment
    // is not present.
    expect(restored.canAggregate()).toBe(false);
    expect(Array.from(restored.toSnapshot().reveals)).toHaveLength(0);
  });

  it('rejects nonce equivocation: a conflicting second commitment is refused', async () => {
    const jurors = makeJurors(3);
    const disputeId = 'e'.repeat(64);
    const { dkgRecord, shares } = await runSigningSetup(jurors, disputeId, 'equiv-market');

    const signingSession = new IndependentSigningSession({
      disputeId,
      myIdx: jurors[0].juror.idx,
      myPubkey: jurors[0].pubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
    });

    // Peer 1 commits twice: identical duplicate is idempotent, conflicting
    // commitment (fresh random nonce) is refused.
    const first = createCommitment(shares[1]);
    const firstPayload = {
      idx: first.idx,
      pubkey: jurors[1].pubkey,
      commitmentPackage: {
        idx: first.idx,
        binder_pn: first.commit.binder_pn,
        hidden_pn: first.commit.hidden_pn,
      },
    };
    expect(signingSession.addCommitment(firstPayload)).toBe(true);
    expect(signingSession.addCommitment(firstPayload)).toBe(true);

    const second = createCommitment(shares[1]);
    expect(signingSession.addCommitment({
      idx: second.idx,
      pubkey: jurors[1].pubkey,
      commitmentPackage: {
        idx: second.idx,
        binder_pn: second.commit.binder_pn,
        hidden_pn: second.commit.hidden_pn,
      },
    })).toBe(false);
  });

  it('rejects a reveal whose public nonce does not match the committed nonce', async () => {
    const jurors = makeJurors(3);
    const disputeId = 'f'.repeat(64);
    const { dkgRecord, shares } = await runSigningSetup(jurors, disputeId, 'reveal-market');

    const signingSession = new IndependentSigningSession({
      disputeId,
      myIdx: jurors[0].juror.idx,
      myPubkey: jurors[0].pubkey,
      dkg: dkgRecord,
      outcome: 'YES',
      round: 1,
      disputeEventId: disputeId,
    });

    // Peer 1 commits with one nonce; a reveal naming a DIFFERENT nonce must be
    // refused even though the juror index is committed.
    const peerCommit = createCommitment(shares[1]);
    expect(signingSession.addCommitment({
      idx: peerCommit.idx,
      pubkey: jurors[1].pubkey,
      commitmentPackage: {
        idx: peerCommit.idx,
        binder_pn: peerCommit.commit.binder_pn,
        hidden_pn: peerCommit.commit.hidden_pn,
      },
    })).toBe(true);

    const decoy = createCommitment(shares[1]);
    expect(signingSession.addReveal({
      idx: peerCommit.idx,
      pubkey: jurors[1].pubkey,
      publicNonce: {
        idx: decoy.idx,
        binder_pn: decoy.commit.binder_pn,
        hidden_pn: decoy.commit.hidden_pn,
      },
      partialSig: '00'.repeat(64),
    })).toBe(false);
    expect(signingSession.toSnapshot().reveals).toHaveLength(0);
  });
});
