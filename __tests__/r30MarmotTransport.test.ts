// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round-30 transport campaign — MARMOT / MLS SURFACE.
 *
 * SCOPE, stated up front because it is easy to overclaim:
 *
 * `@internet-privacy/marmot-ts` is a dependency of the CONSUMER (bao.markets
 * `packages/api/src/services/court/MarmotTransport.ts`), not of this
 * protocol package. So these tests do NOT exercise marmot-ts's MLS state
 * machine. They exercise the two things that decide whether an MLS transport
 * is safe for a Court ceremony:
 *
 *   A. THE TRANSPORT CONTRACT the ceremony depends on — modelled locally
 *      (`MarmotShapedGroup`) against the same message surface the production
 *      adapter uses (`court.sign_request` / `court.reveal`, epoch-tagged
 *      group state, kind-30443-shaped key packages, welcome messages):
 *        - key packages claim the epoch they belong to;
 *        - messages are epoch-scoped;
 *        - member adds are authorized by the current group members;
 *        - welcomes are single-use.
 *
 *   B. WHAT THE FROST LAYER GUARANTEES EVEN WHEN THE TRANSPORT LIES — with
 *      the REAL `IndependentSigningSession` / `signing.ts` code:
 *        - a non-roster or mis-attributed commitment/reveal is refused;
 *        - a reveal is bound to its own nonce commitment;
 *        - a partial signature for one message cannot certify another;
 *        - nonce reuse across messages is refused locally.
 *
 * B is the part that survives "the MLS layer is compromised" — which is the
 * right security posture, because the MLS layer runs on the same relay.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Event as NostrEvent } from 'nostr-tools/pure';

import { IndependentDkgSession } from '../independentDkg';
import { IndependentSigningSession } from '../independentSigning';
import {
  createCommitment,
  createRevealAndPartialSig,
  aggregateAttestation,
  InMemoryNonceGuard,
} from '../signing';
import { verifyFinalSignature, buildAttestationMessage } from '../crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { parseDkgCommitmentEvent } from '../eventsParse';
import { parseEncryptedShareEvent } from '../dkgMessages';
import type { DkgRecord, SelectedJuror } from '../types';
import type * as frost from '@vbyte/frost';

// ---------------------------------------------------------------------------
// A. Transport-shaped harness: an MLS group with epochs and members
// ---------------------------------------------------------------------------

interface KeyPackage {
  readonly kind: 30443;
  readonly pubkey: string;
  /** The epoch this key package was minted for. */
  readonly epoch: number;
  readonly singleUse: true;
}

interface GroupState {
  readonly groupId: string;
  epoch: number;
  readonly members: string[];
  readonly usedKeyPackages: Set<string>;
}

type CourtMessage =
  | { readonly type: 'court.sign_request'; readonly v: 2; readonly marketId: string; readonly outcome: string; readonly round: number }
  | { readonly type: 'court.reveal'; readonly v: 2; readonly reveal: unknown };

/**
 * The minimal honest MLS-shaped group the production adapter relies on.
 * Every rule here is a rule the ceremony NEEDS from its transport, and each
 * test below shows the ceremony still fails closed if the rule is bypassed.
 */
class MarmotShapedGroup {
  readonly state: GroupState;
  /** Every message the group ever accepted, with the epoch it arrived in. */
  readonly accepted: { epoch: number; from: string; message: CourtMessage }[] = [];

  constructor(groupId: string, owner: string) {
    this.state = { groupId, epoch: 0, members: [owner], usedKeyPackages: new Set() };
  }

  mintKeyPackage(pubkey: string): KeyPackage {
    return { kind: 30443, pubkey, epoch: this.state.epoch + 1, singleUse: true };
  }

  /**
   * Add a member via a welcome. Contract rules:
   *  - the key package must belong to the CURRENT epoch boundary (not a
   *    stale/future one) — a package claiming an epoch it isn't in is poison;
   *  - only an existing member may authorize the add;
   *  - a key package is single-use (no welcome replay).
   */
  welcome(authorizer: string, keyPackage: KeyPackage): { ok: boolean; reason?: string } {
    if (!this.state.members.includes(authorizer)) return { ok: false, reason: 'not_a_member' };
    // Single-use first: a package already consumed by this group is dead at
    // ANY epoch, so a replay reports as a replay rather than an epoch error.
    const packageId = `${keyPackage.pubkey}:${keyPackage.epoch}`;
    if (this.state.usedKeyPackages.has(packageId)) {
      return { ok: false, reason: 'key_package_replayed' };
    }
    if (keyPackage.epoch !== this.state.epoch + 1) {
      return { ok: false, reason: 'key_package_epoch_mismatch' };
    }
    if (this.state.members.includes(keyPackage.pubkey)) {
      return { ok: false, reason: 'already_a_member' };
    }
    this.state.usedKeyPackages.add(packageId);
    this.state.members.push(keyPackage.pubkey);
    this.state.epoch += 1;
    return { ok: true };
  }

  /** Accept an application message, epoch-scoped. */
  receive(epoch: number, from: string, message: CourtMessage): { ok: boolean; reason?: string } {
    if (epoch !== this.state.epoch) return { ok: false, reason: 'epoch_confusion' };
    if (!this.state.members.includes(from)) return { ok: false, reason: 'not_a_member' };
    this.accepted.push({ epoch, from, message });
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Shared real DKG (3 jurors, threshold 2)
// ---------------------------------------------------------------------------

let records: DkgRecord[] = [];
let shares: frost.SecretShare[] = [];
let keys: { seckey: Uint8Array; pubkey: string }[] = [];

beforeAll(async () => {
  const jurorCount = 3;
  keys = Array.from({ length: jurorCount }, () => {
    const seckey = generateSecretKey();
    return { seckey, pubkey: getPublicKey(seckey) };
  });
  const jurors: SelectedJuror[] = keys.map((k, i) => ({
    idx: i + 1,
    nostrPubkey: k.pubkey,
    stakeCapacitySats: 10_000,
    stakeCommitment: { amountSats: 10_000, bondAddress: 'r30', status: 'confirmed', committedAt: 1 },
    wotScore: 80,
    categories: ['world'],
    registeredAt: 1,
    priority: i + 1,
  })) as SelectedJuror[];

  const sessions = keys.map((k, i) => new IndependentDkgSession({
    disputeId: 'r30:marmot:1',
    myIdx: i + 1,
    myPubkey: k.pubkey,
    mySeckey: k.seckey,
    threshold: 2,
    jurors,
  }));

  for (let i = 0; i < jurorCount; i += 1) {
    const { commitmentEvent, shareEvents } = await sessions[i]!.generateCommitmentAndShares();
    const signedCommit = finalizeEvent(commitmentEvent as never, keys[i]!.seckey);
    const parsed = parseDkgCommitmentEvent(signedCommit)!;
    for (let j = 0; j < jurorCount; j += 1) {
      if (j === i) continue;
      expect(sessions[j]!.addCommitment({
        idx: parsed.jurorIdx,
        pubkey: parsed.jurorPubkey,
        threshold: parsed.threshold,
        vssCommits: parsed.vssCommits,
        pok: parsed.pok,
        phaseNonce: parsed.phaseNonce,
        eventId: signedCommit.id,
      })).toBe(true);
    }
    for (const shareEvent of shareEvents) {
      const signedShare = finalizeEvent(shareEvent as never, keys[i]!.seckey);
      const payload = parseEncryptedShareEvent(signedShare)!;
      sessions[payload.toIdx - 1]!.addEncryptedShare(payload, signedShare.pubkey);
    }
  }
  for (const session of sessions) {
    await session.decryptShares();
    expect(session.verifyShares({})).toHaveLength(0);
  }
  records = sessions.map((s) => s.computeKey());
  shares = sessions.map((s) => s.getShare());
  // Every juror independently derived the same group key.
  expect(new Set(records.map((r) => r.groupPubkeyXOnly)).size).toBe(1);
});

// ---------------------------------------------------------------------------
// A. Transport contract: key packages, epochs, member adds, welcomes
// ---------------------------------------------------------------------------

describe('MLS contract: key-package poisoning', () => {
  it('a key package claiming an epoch it is not in is refused', () => {
    const group = new MarmotShapedGroup('BAO-Court', keys[0]!.pubkey);
    const poisoned: KeyPackage = {
      kind: 30443,
      pubkey: keys[1]!.pubkey,
      epoch: 5, // the group is at epoch 0 → the honest boundary is 1
      singleUse: true,
    };
    expect(group.welcome(keys[0]!.pubkey, poisoned)).toEqual({
      ok: false,
      reason: 'key_package_epoch_mismatch',
    });
    expect(group.state.members).toEqual([keys[0]!.pubkey]);
  });

  it('even if a poisoned package is admitted, its bearer cannot get a nonce in', () => {
    // Bypass the transport rule entirely (worst case: the MLS layer is
    // compromised) and check the FROST layer's own roster binding.
    const session = new IndependentSigningSession({
      disputeId: 'r30:marmot:1',
      myIdx: 1,
      myPubkey: keys[0]!.pubkey,
      dkg: records[0]!,
      outcome: 'YES',
      round: 1,
    });
    const attacker = generateSecretKey();
    const attackerPk = getPublicKey(attacker);
    // A commitment claiming juror 2's index from an attacker key.
    const forgedCommitment = createCommitment(shares[1]!);
    expect(session.addCommitment({
      idx: 2,
      pubkey: attackerPk,
      commitmentPackage: {
        idx: 2,
        binder_pn: forgedCommitment.commit.binder_pn,
        hidden_pn: forgedCommitment.commit.hidden_pn,
      },
    })).toBe(false);
    // No commitment recorded → no aggregation possible.
    expect(session.canAggregate()).toBe(false);
  });
});

describe('MLS contract: group-epoch confusion', () => {
  it('a message for epoch N delivered in N+1 is refused by the transport', () => {
    const group = new MarmotShapedGroup('BAO-Court', keys[0]!.pubkey);
    group.welcome(keys[0]!.pubkey, group.mintKeyPackage(keys[1]!.pubkey)); // → epoch 1
    const message: CourtMessage = { type: 'court.sign_request', v: 2, marketId: 'm', outcome: 'YES', round: 1 };
    expect(group.receive(0, keys[0]!.pubkey, message)).toEqual({ ok: false, reason: 'epoch_confusion' });
    expect(group.receive(1, keys[0]!.pubkey, message)).toEqual({ ok: true });
  });

  it('a reveal from an earlier round cannot certify a later round (real FROST code)', () => {
    // Round A signs outcome YES; round B signs outcome NO. Both see the SAME
    // peer nonce commitments (the attacker reuses them across rounds — the
    // exact shape of an epoch-confusion attack).
    const roundA = new IndependentSigningSession({
      disputeId: 'r30:marmot:1', myIdx: 1, myPubkey: keys[0]!.pubkey,
      dkg: records[0]!, outcome: 'YES', round: 1,
    });
    const roundB = new IndependentSigningSession({
      disputeId: 'r30:marmot:1', myIdx: 1, myPubkey: keys[0]!.pubkey,
      dkg: records[0]!, outcome: 'NO', round: 1,
    });
    expect(roundA.message).not.toBe(roundB.message);

    const myCommitment = roundA.createMyCommitment(shares[0]!).commitment;
    const peerCommitments = [createCommitment(shares[1]!), createCommitment(shares[2]!)];
    const peerPayload = (idx: number, c: (typeof peerCommitments)[number]) => ({
      idx,
      pubkey: records[0]!.vssCommitments.find((v) => v.idx === idx)!.pubkey,
      commitmentPackage: { idx, binder_pn: c.commit.binder_pn, hidden_pn: c.commit.hidden_pn },
    });
    expect(roundA.addCommitment(peerPayload(2, peerCommitments[0]!))).toBe(true);
    expect(roundA.addCommitment(peerPayload(3, peerCommitments[1]!))).toBe(true);
    expect(roundB.addCommitment(peerPayload(2, peerCommitments[0]!))).toBe(true);
    expect(roundB.addCommitment(peerPayload(3, peerCommitments[1]!))).toBe(true);

    // Peers reveal honestly for round A (YES).
    const commitmentList = [myCommitment, ...peerCommitments];
    const peerReveals = [2, 3].map((idx) => {
      const reveal = createRevealAndPartialSig(
        {
          marketId: records[0]!.marketId, outcome: 'YES', round: 1,
          dkg: records[0]!, shares: [shares[idx - 1]!], nonceGuard: new InMemoryNonceGuard(),
        } as never,
        commitmentList,
        shares[idx - 1]!,
      );
      expect(roundA.addReveal({
        idx,
        pubkey: reveal.pubkey,
        publicNonce: {
          idx,
          binder_pn: reveal.pnonce.binder_pn,
          hidden_pn: reveal.pnonce.hidden_pn,
        },
        partialSig: reveal.psig,
      })).toBe(true);
      return reveal;
    });
    expect(peerReveals).toHaveLength(2);
    // Juror 1 reveals too — the reveal set must equal the commitment set.
    roundA.createMyReveal(shares[0]!);

    const attA = roundA.aggregate();
    expect(verifyFinalSignature(records[0]!.groupPubkeyXOnly, attA.message, attA.signature)).toBe(true);

    // Round B never received reveals, so it cannot aggregate at all…
    expect(roundB.canAggregate()).toBe(false);
    // …and round A's aggregate is not a valid attestation for round B's
    // message: the message is inside the signature.
    expect(verifyFinalSignature(records[0]!.groupPubkeyXOnly, roundB.message, attA.signature)).toBe(false);
  });
});

describe('MLS contract: member-add spoofing', () => {
  it('only a current member can add, and a stranger cannot join by welcome alone', () => {
    const group = new MarmotShapedGroup('BAO-Court', keys[0]!.pubkey);
    const attackerPk = getPublicKey(generateSecretKey());
    expect(group.welcome(attackerPk, group.mintKeyPackage(attackerPk))).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
    expect(group.state.members).not.toContain(attackerPk);
  });

  it('a spoofed member still cannot contribute a usable signature share (real FROST code)', () => {
    const session = new IndependentSigningSession({
      disputeId: 'r30:marmot:1', myIdx: 1, myPubkey: keys[0]!.pubkey,
      dkg: records[0]!, outcome: 'YES', round: 1,
    });
    const attackerPk = getPublicKey(generateSecretKey());
    expect(session.addCommitment({
      idx: 4, // not a DKG participant at all
      pubkey: attackerPk,
      commitmentPackage: { idx: 4, binder_pn: '02' + '11'.repeat(32), hidden_pn: '02' + '22'.repeat(32) },
    })).toBe(false);
    expect(session.addReveal({
      idx: 4,
      pubkey: attackerPk,
      publicNonce: { idx: 4, binder_pn: '02' + '11'.repeat(32), hidden_pn: '02' + '22'.repeat(32) },
      partialSig: 'aa'.repeat(32),
    })).toBe(false);
    expect(session.canAggregate()).toBe(false);
  });
});

describe('MLS contract: welcome-message replay', () => {
  it('a replayed welcome with the same key package is refused', () => {
    const group = new MarmotShapedGroup('BAO-Court', keys[0]!.pubkey);
    const keyPackage = group.mintKeyPackage(keys[1]!.pubkey);
    expect(group.welcome(keys[0]!.pubkey, keyPackage)).toEqual({ ok: true });
    expect(group.state.epoch).toBe(1);
    expect(group.welcome(keys[0]!.pubkey, keyPackage)).toEqual({
      ok: false,
      reason: 'key_package_replayed',
    });
    // …and the replayed package cannot re-advance the epoch.
    expect(group.state.epoch).toBe(1);
    expect(new Set(group.state.members).size).toBe(2);
  });

  it('even after a replayed welcome, no second nonce enters the round (real FROST code)', () => {
    const session = new IndependentSigningSession({
      disputeId: 'r30:marmot:1', myIdx: 1, myPubkey: keys[0]!.pubkey,
      dkg: records[0]!, outcome: 'YES', round: 1,
    });
    const mine = session.createMyCommitment(shares[0]!).commitment;
    const peerCommitments = [createCommitment(shares[1]!), createCommitment(shares[2]!)];
    for (const [offset, idx] of [2, 3].entries()) {
      const c = peerCommitments[offset]!;
      expect(session.addCommitment({
        idx,
        pubkey: records[0]!.vssCommitments.find((v) => v.idx === idx)!.pubkey,
        commitmentPackage: { idx, binder_pn: c.commit.binder_pn, hidden_pn: c.commit.hidden_pn },
      })).toBe(true);
    }
    expect(session.hasEnoughCommitments()).toBe(true);
    const myReveal = session.createMyReveal(shares[0]!);
    expect(myReveal.reveal.psig).toMatch(/^[0-9a-f]{64}$/);

    // Juror 2's reveal, produced over the SAME commitment set.
    const commitmentList = [mine, ...peerCommitments];
    const firstReveal = createRevealAndPartialSig(
      {
        marketId: records[0]!.marketId, outcome: 'YES', round: 1,
        dkg: records[0]!, shares: [shares[1]!], nonceGuard: new InMemoryNonceGuard(),
      } as never,
      commitmentList,
      shares[1]!,
    );
    expect(session.addReveal({
      idx: 2,
      pubkey: firstReveal.pubkey,
      publicNonce: {
        idx: 2,
        binder_pn: firstReveal.pnonce.binder_pn,
        hidden_pn: firstReveal.pnonce.hidden_pn,
      },
      partialSig: firstReveal.psig,
    })).toBe(true);
    // Replay the identical reveal: idempotent.
    expect(session.addReveal({
      idx: 2,
      pubkey: firstReveal.pubkey,
      publicNonce: {
        idx: 2,
        binder_pn: firstReveal.pnonce.binder_pn,
        hidden_pn: firstReveal.pnonce.hidden_pn,
      },
      partialSig: firstReveal.psig,
    })).toBe(true);
    // A different partial sig for the same commitment is refused.
    expect(session.addReveal({
      idx: 2,
      pubkey: firstReveal.pubkey,
      publicNonce: {
        idx: 2,
        binder_pn: firstReveal.pnonce.binder_pn,
        hidden_pn: firstReveal.pnonce.hidden_pn,
      },
      partialSig: 'bb'.repeat(32),
    })).toBe(false);
    void myReveal;
  });
});

// ---------------------------------------------------------------------------
// B. Real-code guarantees that outlive a lying transport
// ---------------------------------------------------------------------------

describe('FROST layer under a lying transport', () => {
  it('nonce reuse across two different messages is refused locally', () => {
    const guard = new InMemoryNonceGuard();
    const commitment = createCommitment(shares[0]!);
    const paramsYes = {
      marketId: records[0]!.marketId, outcome: 'YES', round: 1,
      dkg: records[0]!, shares: [shares[0]!], nonceGuard: guard,
    };
    const paramsNo = { ...paramsYes, outcome: 'NO' };

    const first = createRevealAndPartialSig(paramsYes as never, [commitment], shares[0]!);
    expect(first.psig).toMatch(/^[0-9a-f]{64}$/);
    // The same nonce commitment cannot be consumed twice — the guard fires
    // before any second partial signature exists.
    expect(() => createRevealAndPartialSig(paramsNo as never, [commitment], shares[0]!))
      .toThrowError(/nonce reuse/i);
  });

  it('an aggregate whose reveals certify a different message fails verification', () => {
    // Build two full rounds from the same nonce commitments but different
    // messages, then mix one round's reveal into the other's aggregate.
    const commitments = [createCommitment(shares[0]!), createCommitment(shares[1]!)];
    const paramsYes = { marketId: records[0]!.marketId, outcome: 'YES', round: 1, dkg: records[0]!, shares: [] as never[] };
    const paramsNo = { marketId: records[0]!.marketId, outcome: 'NO', round: 1, dkg: records[0]!, shares: [] as never[] };

    const revealYes0 = createRevealAndPartialSig(
      { ...paramsYes, nonceGuard: new InMemoryNonceGuard() } as never, commitments, shares[0]!,
    );
    const revealNo1 = createRevealAndPartialSig(
      { ...paramsNo, nonceGuard: new InMemoryNonceGuard() } as never, commitments, shares[1]!,
    );

    // Mixed set: juror 1 signed YES, juror 2 signed NO. Aggregation must fail.
    expect(() => aggregateAttestation(paramsYes as never, commitments, [revealYes0, revealNo1]))
      .toThrowError(/invalid/i);

    // The consistent YES pair still aggregates and verifies (control).
    const revealYes1 = createRevealAndPartialSig(
      { ...paramsYes, nonceGuard: new InMemoryNonceGuard() } as never, commitments, shares[1]!,
    );
    const attestation = aggregateAttestation(paramsYes as never, commitments, [revealYes0, revealYes1]);
    expect(attestation.message).toBe(buildAttestationMessage(records[0]!.marketId, 'YES', 1));
    expect(verifyFinalSignature(records[0]!.groupPubkeyXOnly, attestation.message, attestation.signature)).toBe(true);
  });

  it('the signed attestation message never depends on transport metadata', () => {
    const commitments = [createCommitment(shares[0]!), createCommitment(shares[1]!)];
    const base = { marketId: records[0]!.marketId, outcome: 'YES', round: 1, dkg: records[0]!, shares: [] as never[] };
    const reveal0 = createRevealAndPartialSig({ ...base, nonceGuard: new InMemoryNonceGuard() } as never, commitments, shares[0]!);
    const reveal1 = createRevealAndPartialSig({ ...base, nonceGuard: new InMemoryNonceGuard() } as never, commitments, shares[1]!);
    const attestation = aggregateAttestation(base as never, commitments, [reveal0, reveal1]);
    // An epoch number, group id, or welcome payload smuggled into the transport
    // cannot appear in the signed message: it is built from ceremony fields only.
    expect(attestation.message).toBe(buildAttestationMessage(records[0]!.marketId, 'YES', 1));
    expect(attestation.message).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation.groupPubkey).toBe(records[0]!.groupPubkeyXOnly);
    // A fabricated attestation carrying a real signature but a boosted outcome
    // fails verification — the message is inside the signature.
    const forged = buildAttestationMessage(records[0]!.marketId, 'NO', 1);
    expect(verifyFinalSignature(records[0]!.groupPubkeyXOnly, forged, attestation.signature)).toBe(false);
  });

  it('a reveal is accepted only against the commitment it was produced from', () => {
    const session = new IndependentSigningSession({
      disputeId: 'r30:marmot:1', myIdx: 1, myPubkey: keys[0]!.pubkey,
      dkg: records[0]!, outcome: 'YES', round: 1,
    });
    const other = createCommitment(shares[1]!);
    const swapped = createCommitment(shares[1]!);
    // Commit one nonce, then present a reveal for a different one.
    expect(session.addCommitment({
      idx: 2,
      pubkey: records[0]!.vssCommitments.find((v) => v.idx === 2)!.pubkey,
      commitmentPackage: { idx: 2, binder_pn: other.commit.binder_pn, hidden_pn: other.commit.hidden_pn },
    })).toBe(true);
    expect(session.addReveal({
      idx: 2,
      pubkey: other.pubkey,
      publicNonce: { idx: 2, binder_pn: swapped.commit.binder_pn, hidden_pn: swapped.commit.hidden_pn },
      partialSig: 'cc'.repeat(32),
    })).toBe(false);
  });
});

// Keep the unused imported type honest.
export type _NostrEvent = NostrEvent;
