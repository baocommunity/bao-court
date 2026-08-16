// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Regression tests for the 2026-08-15 hardening:
 *  - complaint attribution/possession binding (CRITICAL/HIGH finds),
 *  - complaint-phase liveness (getPhase no longer stuck on resolved complaints),
 *  - restoreFromBackup full recomputation battery (HIGH find).
 */
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { IndependentDkgSession } from '../independentDkg';
import { Nip44SeckeyCrypto } from '../nip44Crypto';
import { randomScalar, scalarToHex } from '../crypto';
import type { DkgComplaint, EncryptedShareBackup, SelectedJuror } from '../types';

const Point = secp256k1.Point;

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

const DISPUTE = 'd'.repeat(64);
const SHARE_EVENT = 'f'.repeat(64);

type SharePayload = { disputeId: string; fromIdx: number; fromPubkey: string; toIdx: number; toPubkey: string; encryptedShare: string; phaseNonce: string };

async function runCommitmentRound(
  sessions: IndependentDkgSession[],
): Promise<Record<number, SharePayload[]>> {
  // Deliver commitments AND encrypted shares so every session has possession.
  const all: Record<number, SharePayload[]> = {};
  for (const [i, session] of sessions.entries()) {
    const { commitmentEvent, shareEvents } = await session.generateCommitmentAndShares();
    const sender = (session as unknown as { myPubkey: string; myIdx: number }).myPubkey;
    all[i + 1] = shareEvents.map((ev) => JSON.parse(ev.content) as SharePayload);
    const parsed = JSON.parse(commitmentEvent.content) as { threshold: number; vssCommits: string[]; pok: { nonce: string; response: string }; phaseNonce: string };
    for (const other of sessions) {
      if (other === session) continue;
      other.addCommitment({
        idx: i + 1,
        pubkey: sender,
        threshold: parsed.threshold,
        vssCommits: parsed.vssCommits,
        pok: parsed.pok,
        phaseNonce: parsed.phaseNonce,
      });
    }
  }
  for (const senderNotes of Object.values(all)) {
    for (const payload of senderNotes) {
      const recipient = sessions.find((s) => (s as unknown as { myIdx: number }).myIdx === payload.toIdx);
      recipient?.addEncryptedShare(payload);
    }
  }
  return all;
}

function makeSessions(n: number, threshold: number): { sessions: IndependentDkgSession[]; jurors: ReturnType<typeof makeJurors> } {
  const jurors = makeJurors(n);
  const sessions = jurors.map((j) => new IndependentDkgSession({
    disputeId: DISPUTE,
    myIdx: j.juror.idx,
    myPubkey: j.pubkey,
    mySeckey: j.seckey,
    threshold,
    jurors: jurors.map((x) => x.juror),
  }));
  return { sessions, jurors };
}

describe('complaint attribution binding (2026-08-15)', () => {
  it('rejects forged/unattributable complaints before they can disqualify anyone', async () => {
    const { sessions, jurors } = makeSessions(5, 3);
    const s1 = sessions[0]; // juror 1
    const victimPubkey = jurors[1].pubkey;
    const accusedPubkey = jurors[0].pubkey;

    const base = {
      disputeId: DISPUTE,
      accusedIdx: 1,
      accusedPubkey,
      victimIdx: 2,
      victimPubkey,
      encryptedShareEventId: SHARE_EVENT,
      revealedShare: '00'.repeat(32),
      commitmentEventId: 'e'.repeat(64),
    };
    const cases: [string, Partial<DkgComplaint>][] = [
      ['wrong dispute', { disputeId: '0'.repeat(64) }],
      ['victim not in roster', { victimIdx: 9, victimPubkey: '9'.repeat(64) }],
      ['accused not in roster', { accusedIdx: 8, accusedPubkey: '8'.repeat(64) }],
      ['victim pubkey mismatch', { victimPubkey: '7'.repeat(64) }],
      ['accused pubkey mismatch', { accusedPubkey: '6'.repeat(64) }],
      ['victim == accused', { accusedIdx: 2, accusedPubkey: victimPubkey }],
      ['missing possession anchor', { encryptedShareEventId: '' }],
      ['malformed possession anchor', { encryptedShareEventId: 'not-hex' }],
    ];
    for (const [label, patch] of cases) {
      expect(s1.addComplaint({ ...base, ...patch } as DkgComplaint), label).toBe(false);
    }
    // A complaint for a victim other than the local juror whose event was
    // never author-verified is rejected by the boundary; here the session
    // accepts the roster-bound claim (the parser-bound author rule) only when
    // it is well-formed and non-duplicate.
    expect(s1.addComplaint({ ...base } as DkgComplaint)).toBe(true);
    // Duplicate (same victim/accused pair) is rejected — first wins.
    expect(s1.addComplaint({ ...base } as DkgComplaint)).toBe(false);
    // Local possession: juror 1 complains about a share IT never received.
    const selfClaim = { ...base, victimIdx: 1, victimPubkey: accusedPubkey === s1['myPubkey'] ? '' : jurors[0].pubkey };
    void selfClaim;
    const forgedSelf = {
      disputeId: DISPUTE,
      accusedIdx: 3,
      accusedPubkey: jurors[2].pubkey,
      victimIdx: 1,
      victimPubkey: jurors[0].pubkey, // this session's own identity
      encryptedShareEventId: SHARE_EVENT,
      revealedShare: '11'.repeat(32),
      commitmentEventId: 'e'.repeat(64),
    };
    // Even a victim=self complaint is rejected unless the accused delivered
    // an encrypted share to this session (possession).
    expect(s1.addComplaint(forgedSelf)).toBe(false);
  });

  it('a complaint with an invalid defense disqualifies the accused (bad faith)', async () => {
    const { sessions, jurors } = makeSessions(3, 2);
    const victim = sessions[1];
    const accusedShare = (await runCommitmentRound(sessions))[1]!.find((s) => s.toIdx === 2)!;
    const victimNip = new Nip44SeckeyCrypto(jurors[1].seckey);
    const realShare = victimNip.decrypt(accusedShare.encryptedShare, jurors[0].pubkey);
    const accepted = victim.addComplaint({
      disputeId: DISPUTE,
      accusedIdx: 1,
      accusedPubkey: jurors[0].pubkey,
      victimIdx: 2,
      victimPubkey: jurors[1].pubkey,
      encryptedShareEventId: SHARE_EVENT,
      revealedShare: '00'.repeat(32),
      commitmentEventId: 'e'.repeat(64),
      defense: { decryptionProof: 'x', validShare: '00'.repeat(32), defendedAt: 1 },
    });
    expect(accepted).toBe(true);
    victim.resolveComplaints();
    expect((victim as unknown as { disqualified: Set<number> }).disqualified.has(1)).toBe(true);
  });

  it('genuine invalid-share grievance still disqualifies the accused', async () => {
    const { sessions, jurors } = makeSessions(3, 2);
    const victim = sessions[1]; // juror 2, the local victim
    // Deliver the accused's commitment to the victim's session and decrypt the
    // accused's (corrupted) share so possession exists.
    const all = await runCommitmentRound(sessions);
    const accusedShare = all[1]!.find((s) => s.toIdx === 2)!;
    // Corrupt plaintext share before re-encrypting so verification fails.
    // The ciphertext is produced by the SENDER (juror 1 -> juror 2).
    const senderNip = new Nip44SeckeyCrypto(jurors[0].seckey);
    const victimNip = new Nip44SeckeyCrypto(jurors[1].seckey);
    const plaintext = victimNip.decrypt(accusedShare.encryptedShare, jurors[0].pubkey);
    const corrupted = scalarToHex((BigInt('0x' + plaintext) + 1n) % secp256k1.Point.Fn.ORDER);
    victim.addEncryptedShare({
      disputeId: DISPUTE,
      fromIdx: 1,
      fromPubkey: jurors[0].pubkey,
      toIdx: 2,
      toPubkey: jurors[1].pubkey,
      encryptedShare: senderNip.encrypt(corrupted, jurors[1].pubkey),
      phaseNonce: accusedShare.phaseNonce,
    });
    await victim.decryptShares();
    // Victim verifies against the accused's commitments — must record failure.
    const failures = victim.verifyShares({ 1: 'e'.repeat(64) });
    expect(failures.length).toBe(1);
    // The genuine grievance (victim == local session, possession proven) is accepted.
    const accepted = victim.addComplaint({
      disputeId: DISPUTE,
      accusedIdx: 1,
      accusedPubkey: jurors[0].pubkey,
      victimIdx: 2,
      victimPubkey: jurors[1].pubkey,
      encryptedShareEventId: SHARE_EVENT,
      revealedShare: corrupted,
      commitmentEventId: 'e'.repeat(64),
    });
    expect(accepted).toBe(true);
    victim.resolveComplaints();
    expect(victim.canComputeKey()).toBe(false); // accused disqualified → attempt fails closed
  });

  it('false complaint (revealed share verifies) exonerates the accused and never stalls the phase', async () => {
    const { sessions, jurors } = makeSessions(3, 2);
    const victim = sessions[1];
    const accusedShare = (await runCommitmentRound(sessions))[1]!.find((s) => s.toIdx === 2)!;
    const victimNip = new Nip44SeckeyCrypto(jurors[1].seckey);
    const realShare = victimNip.decrypt(accusedShare.encryptedShare, jurors[0].pubkey);
    // False complaint carrying the REAL share: the accused is exonerated.
    const accepted = victim.addComplaint({
      disputeId: DISPUTE,
      accusedIdx: 1,
      accusedPubkey: jurors[0].pubkey,
      victimIdx: 2,
      victimPubkey: jurors[1].pubkey,
      encryptedShareEventId: SHARE_EVENT,
      revealedShare: realShare,
      commitmentEventId: 'e'.repeat(64),
    });
    expect(accepted).toBe(true);
    victim.resolveComplaints();
    expect((victim as unknown as { disqualified: Set<number> }).disqualified.size).toBe(0);
    expect(victim.getFalseComplaints().length).toBe(1);
    // Phase must NOT be stuck on 'complaint' after a resolved false complaint.
    expect(victim.getPhase()).not.toBe('complaint');
  });
});

describe('restoreFromBackup recomputation battery (2026-08-15)', () => {
  it('rejects a fully self-consistent poisoned backup under a different group key', async () => {
    const { sessions, jurors } = makeSessions(3, 2);
    const honest = sessions[0];

    // Attacker builds a self-consistent record under a DIFFERENT group key.
    const forgedVss = Array.from({ length: 3 }, (_, i) => {
      const c0 = Point.BASE.multiply(randomScalar());
      const c1 = Point.BASE.multiply(randomScalar());
      return { idx: i + 1, pubkey: jurors[i].pubkey, commits: [c0.toHex(true), c1.toHex(true)] };
    });
    const forgedGroup = forgedVss
      .map((v) => Point.fromHex(v.commits[0]))
      .reduce((a, b) => a.add(b), Point.ZERO)
      .toHex(true);
    const forgedVshares = Array.from({ length: 3 }, (_, i) => {
      const idx = BigInt(i + 1);
      const pt = forgedVss
        .map((v) => v.commits.map((c) => Point.fromHex(c)))
        .map((cs) => cs[1].multiply(idx).add(cs[0]))
        .reduce((a, b) => a.add(b), Point.ZERO);
      return { idx: i + 1, pubkey: pt.toHex(true).slice(2) };
    });
    // Attacker-chosen share consistent with its own (forged) verification share.
    const forgedScalar = randomScalar();
    const shareHex = scalarToHex(forgedScalar);

    const poisoned: EncryptedShareBackup = {
      disputeId: DISPUTE,
      jurorIdx: 1,
      jurorPubkey: jurors[0].pubkey,
      encryptedShare: await new Nip44SeckeyCrypto(jurors[0].seckey).encrypt(shareHex, jurors[0].pubkey),
      groupPubkey: forgedGroup,
      verificationShares: forgedVshares,
      vssCommitments: forgedVss,
    };
    expect(await honest.restoreFromBackup(poisoned)).toBe(false);
  });

  it('rejects a negated share (x-only parity trap)', async () => {
    const { sessions, jurors } = makeSessions(3, 2);
    const honest = sessions[0];
    // Build a backup whose verification share for idx 1 is the point s*G
    // (so the NEGATED scalar n - s has the identical x-only verification
    // share), while the full point of (n - s)*G mismatches s*G.
    const N = secp256k1.Point.Fn.ORDER;
    const MOD = (x: bigint): bigint => ((x % N) + N) % N;
    const s = randomScalar();
    const negated = MOD(-s);
    const polyWithValueAt1 = (value: bigint): [bigint, bigint] => {
      const a0 = randomScalar();
      const a1 = MOD(value - a0);
      return [a0, a1];
    };
    const [a0, a1] = polyWithValueAt1(s);
    const [b0, b1] = polyWithValueAt1(0n);
    const [c0, c1] = polyWithValueAt1(0n);
    const vss = [
      { idx: 1, pubkey: jurors[0].pubkey, commits: [Point.BASE.multiply(a0).toHex(true), Point.BASE.multiply(a1).toHex(true)] },
      { idx: 2, pubkey: jurors[1].pubkey, commits: [Point.BASE.multiply(b0).toHex(true), Point.BASE.multiply(b1).toHex(true)] },
      { idx: 3, pubkey: jurors[2].pubkey, commits: [Point.BASE.multiply(c0).toHex(true), Point.BASE.multiply(c1).toHex(true)] },
    ];
    const groupPoint = vss.map((v) => Point.fromHex(v.commits[0])).reduce((a, b) => a.add(b), Point.ZERO);
    const vshares = Array.from({ length: 3 }, (_, i) => {
      const idx = BigInt(i + 1);
      const pt = vss
        .map((v) => v.commits.map((c) => Point.fromHex(c)))
        .map((cs) => cs[1].multiply(idx).add(cs[0]))
        .reduce((a, b) => a.add(b), Point.ZERO);
      return { idx: i + 1, pubkey: pt.toHex(true).slice(2) };
    });
    // x-only of the negated share equals the claimed vshare for idx 1,
    // but the FULL point differs — exactly the parity trap.
    expect(secp256k1.Point.BASE.multiply(negated).toHex(true).slice(2)).toBe(vshares[0]!.pubkey);
    expect(secp256k1.Point.BASE.multiply(negated).equals(secp256k1.Point.BASE.multiply(s))).toBe(false);
    const backup: EncryptedShareBackup = {
      disputeId: DISPUTE,
      jurorIdx: 1,
      jurorPubkey: jurors[0].pubkey,
      encryptedShare: await new Nip44SeckeyCrypto(jurors[0].seckey).encrypt(scalarToHex(negated), jurors[0].pubkey),
      groupPubkey: groupPoint.toHex(true),
      verificationShares: vshares,
      vssCommitments: vss,
    };
    expect(await honest.restoreFromBackup(backup)).toBe(false);
  });

  it('still restores a genuine backup', async () => {
    const { sessions, jurors } = makeSessions(3, 2);
    const [s1, s2, s3] = sessions;
    await runCommitmentRound(sessions);
    // Full round so every session computes its share.
    for (const session of sessions) {
      await session.decryptShares();
      session.verifyShares({ 1: 'e'.repeat(64), 2: 'e'.repeat(64), 3: 'e'.repeat(64) });
      session.computeKey();
    }
    const backup = await s1.buildBackupPayload(jurors[0].pubkey);
    const fresh = new IndependentDkgSession({
      disputeId: DISPUTE,
      myIdx: 1,
      myPubkey: jurors[0].pubkey,
      mySeckey: jurors[0].seckey,
      threshold: 2,
      jurors: jurors.map((x) => x.juror),
    });
    expect(await fresh.restoreFromBackup(backup.backup)).toBe(true);
    expect(fresh.getRecord().groupPubkey).toBe(s1.getRecord().groupPubkey);
    expect(fresh.getRecord().groupPubkey).toBe(s2.getRecord().groupPubkey);
    expect(fresh.getRecord().groupPubkey).toBe(s3.getRecord().groupPubkey);
  });
});
