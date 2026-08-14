// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { IndependentDkgSession } from '../independentDkg';
import { Nip44SeckeyCrypto, type Nip44Crypto } from '../nip44Crypto';
import { parseDkgCommitmentEvent } from '../events';
import {
  parseEncryptedRefreshShareEvent,
  parseEncryptedShareEvent,
  parseRefreshCommitmentEvent,
  parseShareBackupEvent,
} from '../dkgMessages';
import * as frost from '@vbyte/frost';
import { randomScalar, verifyFinalSignature } from '../crypto';
import type { EncryptedVssShare, SelectedJuror } from '../types';

const Point = secp256k1.Point;

/** Mock extension/bunker signer that returns Promises. */
class AsyncNip44Crypto implements Nip44Crypto {
  private readonly crypto: Nip44SeckeyCrypto;

  constructor(seckey: Uint8Array) {
    this.crypto = new Nip44SeckeyCrypto(seckey);
  }

  async encrypt(plaintext: string, peerPubkey: string): Promise<string> {
    return this.crypto.encrypt(plaintext, peerPubkey);
  }

  async decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
    return this.crypto.decrypt(ciphertext, peerPubkey);
  }
}

function makeJurors(count: number): { juror: SelectedJuror; seckey: Uint8Array; pubkey: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const seckey = generateSecretKey();
    const pubkey = getPublicKey(seckey);
    return {
      juror: {
        idx: i + 1,
        nostrPubkey: pubkey,
        stakeCapacitySats: 10_000,
        stakeCommitment: {
          amountSats: 10_000,
          bondAddress: 'bc1q',
          status: 'confirmed',
          committedAt: 1,
        },
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

describe('IndependentDkgSession', () => {
  it('runs a 3-of-5 independent DKG and produces matching group keys', async () => {
    const jurors = makeJurors(5);
    const threshold = 3;
    const disputeId = 'd'.repeat(64);

    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    // Step 1: every juror generates commitments and encrypted shares.
    const allCommitmentEventIds: Record<number, string> = {};
    const allSharePayloads: Record<number, ReturnType<typeof parseEncryptedShareEvent>[]> = {};

    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey });
      expect(parsed).not.toBeNull();
      allCommitmentEventIds[jurors[i].juror.idx] = 'event-id-' + jurors[i].juror.idx;

      // Distribute the commitment to all peers.
      for (const other of sessions) {
        if (other === session) continue;
        other.addCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed!.threshold,
          vssCommits: parsed!.vssCommits,
          pok: parsed!.pok,
          phaseNonce: parsed!.phaseNonce,
          eventId: allCommitmentEventIds[jurors[i].juror.idx],
        });
      }

      // Distribute encrypted shares to recipients.
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent);
        expect(payload).not.toBeNull();
        const recipient = sessions.find((s) => s.myIdx === payload!.toIdx)!;
        recipient.addEncryptedShare(payload!);
      }
    }

    // Step 2: every juror decrypts and verifies shares.
    for (const session of sessions) {
      await session.decryptShares();
      const complaints = session.verifyShares(allCommitmentEventIds);
      expect(complaints).toHaveLength(0);
      const record = session.computeKey();
      expect(record.groupPubkey).toMatch(/^[0-9a-f]{66}$/);
    }

    // Step 3: all group keys match.
    const groupKeys = sessions.map((s) => s.getRecord().groupPubkey);
    expect(new Set(groupKeys).size).toBe(1);

    // Step 4: shares can sign and verify a message.
    const message = 'abcd'.repeat(16);
    const record = sessions[0].getRecord();
    const shares = sessions.map((s) => s.getShare());
    const commitments = shares.map((s) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const frost = require('@vbyte/frost');
      return frost.Lib.create_commit_pkg(s);
    });
    const ctx = require('@vbyte/frost').Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);
    const sigs = shares.map((share) => {
      const commit = require('@vbyte/frost').Lib.get_commit_pkg(commitments, share);
      const sig = require('@vbyte/frost').Lib.sign_msg(ctx, share, commit);
      return { idx: share.idx, pubkey: sig.pubkey, psig: sig.psig };
    });
    const signatureHex = require('@vbyte/frost').Lib.combine_partial_sigs(ctx, sigs);
    expect(verifyFinalSignature(record.groupPubkey, message, signatureHex)).toBe(true);
  });

  it('produces a self-backup that can be decrypted', async () => {
    const jurors = makeJurors(3);
    const disputeId = 'd'.repeat(64);
    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold: 2,
      jurors: jurors.map((x) => x.juror),
    }));

    const allCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      allCommitmentEventIds[jurors[i].juror.idx] = 'event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          pok: parsed.pok,
          phaseNonce: parsed.phaseNonce,
          eventId: allCommitmentEventIds[jurors[i].juror.idx],
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptShares();
      session.verifyShares(allCommitmentEventIds);
      session.computeKey();
    }

    const juror = jurors[0];
    const session = sessions[0];
    const { backupEvent } = await session.buildBackupPayload(juror.pubkey);
    expect(backupEvent.kind).toBe(39100);
  });

  it('restores a share from a Kind 39100 self-backup', async () => {
    const jurors = makeJurors(3);
    const disputeId = 'd'.repeat(64);
    const marketId = 'restore-market';
    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      marketId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold: 2,
      jurors: jurors.map((x) => x.juror),
    }));

    const allCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      allCommitmentEventIds[jurors[i].juror.idx] = 'event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          pok: parsed.pok,
          phaseNonce: parsed.phaseNonce,
          eventId: allCommitmentEventIds[jurors[i].juror.idx],
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptShares();
      session.verifyShares(allCommitmentEventIds);
      session.computeKey();
    }

    const original = sessions[0];
    const juror = jurors[0];
    const { backupEvent } = await original.buildBackupPayload(juror.pubkey);
    const backup = parseShareBackupEvent(backupEvent)!;

    const restored = new IndependentDkgSession({
      disputeId,
      marketId,
      myIdx: juror.juror.idx,
      myPubkey: juror.pubkey,
      mySeckey: juror.seckey,
      threshold: 2,
      jurors: jurors.map((x) => x.juror),
    });

    expect(await restored.restoreFromBackup(backup)).toBe(true);
    expect(restored.getShare().seckey).toBe(original.getShare().seckey);
    expect(restored.getRecord().groupPubkey).toBe(original.getRecord().groupPubkey);
  });

  it('requires exactly one of mySeckey or nip44', () => {
    const jurors = makeJurors(2);
    const base = {
      disputeId: 'v'.repeat(64),
      myIdx: jurors[0].juror.idx,
      myPubkey: jurors[0].pubkey,
      threshold: 2,
      jurors: jurors.map((x) => x.juror),
    };

    expect(() => new IndependentDkgSession(base)).toThrow(
      /Provide exactly one of mySeckey or nip44/,
    );
    expect(() =>
      new IndependentDkgSession({
        ...base,
        mySeckey: jurors[0].seckey,
        nip44: new AsyncNip44Crypto(jurors[0].seckey),
      }),
    ).toThrow(/Provide exactly one of mySeckey or nip44/);
  });

  it('supports an async NIP-44 signer without exposing the secret key', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'e'.repeat(64);

    const sessions = jurors.map((j, i) =>
      new IndependentDkgSession({
        disputeId,
        myIdx: j.juror.idx,
        myPubkey: j.pubkey,
        ...(i === 0
          ? { nip44: new AsyncNip44Crypto(j.seckey) }
          : { mySeckey: j.seckey }),
        threshold,
        jurors: jurors.map((x) => x.juror),
      }),
    );

    const allCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      allCommitmentEventIds[jurors[i].juror.idx] = 'event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          pok: parsed.pok,
          phaseNonce: parsed.phaseNonce,
          eventId: allCommitmentEventIds[jurors[i].juror.idx],
        });
      }

      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptShares();
      const complaints = session.verifyShares(allCommitmentEventIds);
      expect(complaints).toHaveLength(0);
      session.computeKey();
    }

    const groupKeys = sessions.map((s) => s.getRecord().groupPubkey);
    expect(new Set(groupKeys).size).toBe(1);

    const record = sessions[0].getRecord();
    const shares = sessions.map((s) => s.getShare());
    const commitments = shares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, disputeId);
    const sigs = shares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      return frost.Lib.sign_msg(ctx, share, commit);
    });
    const signatureHex = frost.Lib.combine_partial_sigs(ctx, sigs);
    expect(verifyFinalSignature(record.groupPubkey, disputeId, signatureHex)).toBe(true);
  });

  it('rejects a rogue-key commitment with an invalid proof-of-knowledge', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'r'.repeat(64);
    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const rogue = sessions[0];
    const victim = sessions[1];
    const { commitmentEvent } = await rogue.generateCommitmentAndShares();
    const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[0].pubkey })!;

    // Replace the constant-coefficient commitment with a random point while
    // keeping the original PoK. The victim must not accept this commitment.
    const rogueCommit = Point.BASE.multiply(randomScalar()).toHex(true);
    const rogueCommits = [rogueCommit, ...parsed.vssCommits.slice(1)];

    const accepted = victim.addCommitment({
      idx: parsed.jurorIdx,
      pubkey: parsed.jurorPubkey,
      threshold: parsed.threshold,
      vssCommits: rogueCommits,
      pok: parsed.pok,
      phaseNonce: parsed.phaseNonce,
      eventId: 'rogue-event-id',
    });

    expect(accepted).toBe(false);
  });

  it('rejects an encrypted share whose phase nonce does not match the commitment', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'p'.repeat(64);
    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const sender = sessions[0];
    const victim = sessions[1];

    const { commitmentEvent, shareEvents } = await sender.generateCommitmentAndShares();
    const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[0].pubkey })!;

    victim.addCommitment({
      idx: parsed.jurorIdx,
      pubkey: parsed.jurorPubkey,
      threshold: parsed.threshold,
      vssCommits: parsed.vssCommits,
      pok: parsed.pok,
      phaseNonce: parsed.phaseNonce,
      eventId: 'commit-1',
    });

    // Tamper with the phase nonce of the share addressed to the victim.
    const payload = parseEncryptedShareEvent(
      shareEvents.find((e) => parseEncryptedShareEvent(e)!.toIdx === victim.myIdx)!,
    )!;
    const tampered: EncryptedVssShare = { ...payload, phaseNonce: 'wrong-nonce' };

    expect(victim.addEncryptedShare(tampered)).toBe(false);
    expect(victim.addEncryptedShare(payload)).toBe(true);
  });

  it('never finalizes over a threshold-sized subset of the roster', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 's'.repeat(64);
    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    // Jurors 1 and 2 exchange everything; juror 3 goes silent.
    const active = sessions.slice(0, 2);
    for (const [i, session] of active.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      for (const other of active) {
        if (other === session) continue;
        other.addCommitment({
          idx: parsed.jurorIdx,
          pubkey: parsed.jurorPubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          pok: parsed.pok,
          phaseNonce: parsed.phaseNonce,
          eventId: 'event-' + parsed.jurorIdx,
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent)!;
        const recipient = active.find((s) => s.myIdx === payload.toIdx);
        recipient?.addEncryptedShare(payload);
      }
    }

    for (const session of active) {
      await session.decryptShares();
      session.verifyShares({ 1: 'event-1', 2: 'event-2' });
      // Two qualified jurors meet the threshold, but the roster is incomplete.
      expect(session.canComputeKey()).toBe(false);
      expect(() => session.computeKey()).toThrow(/every roster commitment/);
      expect(session.getPhase()).not.toBe('complete');
    }
  });

  it('aborts with private blame when a peer share fails verification', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'b'.repeat(64);
    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    // The dishonest sender (juror 1) publishes a commitment for one polynomial
    // but encrypts shares from a different one.
    const sender = sessions[0];
    const first = await sender.generateCommitmentAndShares();
    const second = await sender.generateCommitmentAndShares();
    const parsedCommit = parseDkgCommitmentEvent({ ...first.commitmentEvent, pubkey: jurors[0].pubkey })!;

    const victims = sessions.slice(1);
    for (const victim of victims) {
      victim.addCommitment({
        idx: parsedCommit.jurorIdx,
        pubkey: parsedCommit.jurorPubkey,
        threshold: parsedCommit.threshold,
        vssCommits: parsedCommit.vssCommits,
        pok: parsedCommit.pok,
        phaseNonce: parsedCommit.phaseNonce,
        eventId: 'commit-1',
      });
      const mismatched = parseEncryptedShareEvent(
        second.shareEvents.find((e) => parseEncryptedShareEvent(e)!.toIdx === victim.myIdx)!,
      )!;
      victim.addEncryptedShare({ ...mismatched, phaseNonce: parsedCommit.phaseNonce });
    }

    for (const victim of victims) {
      await victim.decryptShares();
      const failures = victim.verifyShares({ 1: 'commit-1' });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        accusedIdx: 1,
        victimIdx: victim.myIdx,
        commitmentEventId: 'commit-1',
        reason: 'invalid_share',
      });
      // Blame evidence must never carry secret share material.
      expect(failures[0]).not.toHaveProperty('revealedShare');
      expect(Object.keys(failures[0]).sort()).toEqual([
        'accusedIdx',
        'accusedPubkey',
        'commitmentEventId',
        'disputeId',
        'reason',
        'victimIdx',
        'victimPubkey',
      ]);
      expect(victim.getVerificationFailures()).toHaveLength(1);

      // The whole attempt fails closed; the roster never shrinks.
      expect(victim.getPhase()).toBe('failed');
      expect(victim.canComputeKey()).toBe(false);
      expect(() => victim.computeKey()).toThrow(/disqualified/);
    }
  });
});


describe('IndependentDkgSession refresh', () => {
  it('runs a networked refresh that preserves the group public key', async () => {
    const jurors = makeJurors(5);
    const threshold = 3;
    const disputeId = 'd'.repeat(64);

    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    // Initial DKG.
    const allCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      allCommitmentEventIds[jurors[i].juror.idx] = 'event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          pok: parsed.pok,
          phaseNonce: parsed.phaseNonce,
          eventId: allCommitmentEventIds[jurors[i].juror.idx],
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptShares();
      expect(session.verifyShares(allCommitmentEventIds)).toHaveLength(0);
      session.computeKey();
    }

    const originalGroupKey = sessions[0].getRecord().groupPubkey;
    const originalShares = sessions.map((s) => s.getShare());

    // Refresh round.
    const allRefreshCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateRefreshCommitmentAndShares();
      const parsed = parseRefreshCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      expect(parsed.threshold).toBe(threshold);
      expect(parsed.vssCommits).toHaveLength(threshold - 1);
      allRefreshCommitmentEventIds[jurors[i].juror.idx] = 'refresh-event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addRefreshCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          phaseNonce: parsed.phaseNonce,
          eventId: allRefreshCommitmentEventIds[jurors[i].juror.idx],
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedRefreshShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedRefreshShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptRefreshShares();
      expect(session.verifyRefreshShares(allRefreshCommitmentEventIds)).toHaveLength(0);
      const refreshedRecord = session.computeRefreshedKey();
      expect(refreshedRecord.groupPubkey).toBe(originalGroupKey);
    }

    const refreshedKeys = sessions.map((s) => s.getRecord().groupPubkey);
    expect(new Set(refreshedKeys).size).toBe(1);

    const refreshedShares = sessions.map((s) => s.getShare());
    expect(refreshedShares.some((s, i) => s.seckey !== originalShares[i].seckey)).toBe(true);

    const message = bytesToHex(sha256(new TextEncoder().encode('refresh-test-message')));
    const record = sessions[0].getRecord();
    const commitments = refreshedShares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);
    const sigs = refreshedShares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      return frost.Lib.sign_msg(ctx, share, commit);
    });
    const signatureHex = frost.Lib.combine_partial_sigs(ctx, sigs);
    expect(verifyFinalSignature(record.groupPubkey, message, signatureHex)).toBe(true);
  });

  it('fails when original and refreshed shares are mixed', async () => {
    const jurors = makeJurors(3);
    const threshold = 2;
    const disputeId = 'm'.repeat(64);

    const sessions = jurors.map((j) => new IndependentDkgSession({
      disputeId,
      myIdx: j.juror.idx,
      myPubkey: j.pubkey,
      mySeckey: j.seckey,
      threshold,
      jurors: jurors.map((x) => x.juror),
    }));

    const allCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
      const parsed = parseDkgCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      allCommitmentEventIds[jurors[i].juror.idx] = 'event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          pok: parsed.pok,
          phaseNonce: parsed.phaseNonce,
          eventId: allCommitmentEventIds[jurors[i].juror.idx],
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptShares();
      session.verifyShares(allCommitmentEventIds);
      session.computeKey();
    }

    const originalShares = sessions.map((s) => s.getShare());

    const allRefreshCommitmentEventIds: Record<number, string> = {};
    for (const [i, session] of sessions.entries()) {
      const { commitmentEvent, shareEvents } = await session.generateRefreshCommitmentAndShares();
      const parsed = parseRefreshCommitmentEvent({ ...commitmentEvent, pubkey: jurors[i].pubkey })!;
      allRefreshCommitmentEventIds[jurors[i].juror.idx] = 'refresh-event-id-' + jurors[i].juror.idx;

      for (const other of sessions) {
        if (other === session) continue;
        other.addRefreshCommitment({
          idx: jurors[i].juror.idx,
          pubkey: jurors[i].pubkey,
          threshold: parsed.threshold,
          vssCommits: parsed.vssCommits,
          phaseNonce: parsed.phaseNonce,
          eventId: allRefreshCommitmentEventIds[jurors[i].juror.idx],
        });
      }
      for (const shareEvent of shareEvents) {
        const payload = parseEncryptedRefreshShareEvent(shareEvent)!;
        sessions.find((s) => s.myIdx === payload.toIdx)!.addEncryptedRefreshShare(payload);
      }
    }

    for (const session of sessions) {
      await session.decryptRefreshShares();
      session.verifyRefreshShares(allRefreshCommitmentEventIds);
      session.computeRefreshedKey();
    }

    const refreshedShares = sessions.map((s) => s.getShare());
    const mixedShares = [originalShares[0], refreshedShares[1], refreshedShares[2]];

    const record = sessions[0].getRecord();
    const message = bytesToHex(sha256(new TextEncoder().encode('mixed-shares-test')));
    const commitments = mixedShares.map((s) => frost.Lib.create_commit_pkg(s));
    const ctx = frost.Lib.get_group_signing_ctx(record.groupPubkey, commitments, message);
    const sigs = mixedShares.map((share) => {
      const commit = frost.Lib.get_commit_pkg(commitments, share);
      return frost.Lib.sign_msg(ctx, share, commit);
    });
    const signatureHex = frost.Lib.combine_partial_sigs(ctx, sigs);
    expect(verifyFinalSignature(record.groupPubkey, message, signatureHex)).toBe(false);
  });
});
