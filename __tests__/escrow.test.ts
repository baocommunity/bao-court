// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';

import {
  ALPHA_INCOHERENT,
  ALPHA_NON_REVEAL,
  ALPHA_DOUBLE_VOTE,
  calculateBondAmount,
  calculateJurorStake,
  calculateTotalAtStake,
  computeRedistributionPlan,
  verifyRedistributionIntegrity,
  createBondOwnershipChallenge,
  signBondOwnershipProof,
  verifyBondOwnershipProof,
  EscrowLedger,
  type RedistributionParams,
} from '../escrow';

// ── calculateBondAmount ─────────────────────────────────────────────────────

describe('calculateBondAmount', () => {
  it('returns 5% of volume when above 10K sats minimum', () => {
    expect(calculateBondAmount(1_000_000, 1)).toBe(50_000);
  });

  it('returns 10K sats minimum when 5% is below 10K', () => {
    expect(calculateBondAmount(100_000, 1)).toBe(10_000);
    expect(calculateBondAmount(50_000, 1)).toBe(10_000);
  });

  it('floors the 5% calculation', () => {
    // 5% of 100001 = 5000.05 → floor = 5000 → max(5000, 10000) = 10000
    expect(calculateBondAmount(100_001, 1)).toBe(10_000);
  });

  it('returns 10K sats minimum for zero volume', () => {
    expect(calculateBondAmount(0, 1)).toBe(10_000);
  });

  it('doubles bond for round 2 (appeal)', () => {
    const r1 = calculateBondAmount(1_000_000, 1);
    const r2 = calculateBondAmount(1_000_000, 2);
    expect(r2).toBe(r1 * 2);
  });

  it('quadruples bond for round 3 (2nd appeal)', () => {
    const r1 = calculateBondAmount(1_000_000, 1);
    const r3 = calculateBondAmount(1_000_000, 3);
    expect(r3).toBe(r1 * 4);
  });

  it('treats round 0 same as round 1', () => {
    expect(calculateBondAmount(1_000_000, 0)).toBe(calculateBondAmount(1_000_000, 1));
  });

  it('handles large volumes', () => {
    expect(calculateBondAmount(100_000_000, 1)).toBe(5_000_000);
  });
});

// ── calculateJurorStake ─────────────────────────────────────────────────────

describe('calculateJurorStake', () => {
  it('returns 2% of volume when above 5K sats minimum', () => {
    expect(calculateJurorStake(1_000_000, 1)).toBe(20_000);
  });

  it('returns 5K sats minimum when 2% is below 5K', () => {
    expect(calculateJurorStake(100_000, 1)).toBe(5_000);
    expect(calculateJurorStake(50_000, 1)).toBe(5_000);
  });

  it('returns 5K sats minimum for zero volume', () => {
    expect(calculateJurorStake(0, 1)).toBe(5_000);
  });

  it('doubles stake for round 2', () => {
    expect(calculateJurorStake(1_000_000, 2)).toBe(40_000);
  });
});

// ── calculateTotalAtStake ───────────────────────────────────────────────────

describe('calculateTotalAtStake', () => {
  it('calculates total = juror stakes + bond', () => {
    expect(calculateTotalAtStake(10_000, 5, 50_000)).toBe(100_000);
  });

  it('handles zero jurors', () => {
    expect(calculateTotalAtStake(10_000, 0, 50_000)).toBe(50_000);
  });
});

// ── computeRedistributionPlan ───────────────────────────────────────────────

describe('computeRedistributionPlan', () => {
  const baseParams: RedistributionParams = {
    marketId: 'market1',
    disputeId: 'dispute1',
    round: 1,
    stakePerJuror: 10_000,
    coherentJurors: ['j1', 'j2'],
    incoherentJurors: ['j3'],
    nonRevealJurors: ['j4'],
    disputeUpheld: true,
    bondAmount: 50_000,
    disputerPubkey: 'disputer',
  };

  it('returns correct market/dispute/round metadata', () => {
    const plan = computeRedistributionPlan(baseParams);
    expect(plan.marketId).toBe('market1');
    expect(plan.disputeId).toBe('dispute1');
    expect(plan.round).toBe(1);
    expect(plan.bondOutcome).toBe('returned');
  });

  it('slashes 50% from incoherent jurors', () => {
    const plan = computeRedistributionPlan(baseParams);
    const incoherent = plan.redistributions.find(r => r.pubkey === 'j3');
    expect(incoherent).toBeDefined();
    expect(incoherent!.reason).toBe('incoherent');
    expect(incoherent!.stakeAmount).toBe(10_000);
    expect(incoherent!.slashedAmount).toBe(5_000); // 50% of 10K
    expect(incoherent!.returnAmount).toBe(5_000);
  });

  it('slashes 100% from non-reveal jurors', () => {
    const plan = computeRedistributionPlan(baseParams);
    const nonReveal = plan.redistributions.find(r => r.pubkey === 'j4');
    expect(nonReveal).toBeDefined();
    expect(nonReveal!.reason).toBe('non_reveal');
    expect(nonReveal!.stakeAmount).toBe(10_000);
    expect(nonReveal!.slashedAmount).toBe(10_000);
    expect(nonReveal!.returnAmount).toBe(0);
  });

  it('slashes 100% from double-voting jurors', () => {
    const plan = computeRedistributionPlan({
      ...baseParams,
      doubleVotingJurors: ['j5'],
    });
    const dv = plan.redistributions.find(r => r.pubkey === 'j5');
    expect(dv).toBeDefined();
    expect(dv!.reason).toBe('double_vote');
    expect(dv!.slashedAmount).toBe(10_000);
  });

  it('returns the bond to the disputer when the dispute is upheld', () => {
    const plan = computeRedistributionPlan(baseParams);
    const bond = plan.redistributions.find(r => r.pubkey === 'disputer');
    expect(bond).toBeDefined();
    expect(bond!.reason).toBe('bond_won');
    expect(bond!.returnAmount).toBe(50_000);
    expect(bond!.slashedAmount).toBe(0);
    expect(plan.bondOutcome).toBe('returned');
  });

  it('forfeits the bond to the pool when the dispute is rejected', () => {
    const plan = computeRedistributionPlan({ ...baseParams, disputeUpheld: false });
    const bond = plan.redistributions.find(r => r.pubkey === 'disputer');
    expect(bond).toBeDefined();
    expect(bond!.reason).toBe('bond_lost');
    expect(bond!.returnAmount).toBe(0);
    expect(bond!.slashedAmount).toBe(50_000);
    expect(plan.bondOutcome).toBe('forfeited');
  });

  it('rewards coherent jurors with an equal share of the slashed pool', () => {
    // Pool: j3 5,000 + j4 10,000 = 15,000. Two coherent jurors → 7,500 each.
    const plan = computeRedistributionPlan(baseParams);
    const j1 = plan.redistributions.find(r => r.pubkey === 'j1');
    expect(j1!.returnAmount).toBe(10_000 + 7_500);
    const j2 = plan.redistributions.find(r => r.pubkey === 'j2');
    expect(j2!.returnAmount).toBe(10_000 + 7_500);
  });

  it('sends the slashed pool to the treasury when there are no coherent jurors', () => {
    const plan = computeRedistributionPlan({
      ...baseParams,
      coherentJurors: [],
      incoherentJurors: ['j1'],
      nonRevealJurors: ['j2'],
      disputeUpheld: false, // bond also forfeited
    });
    const treasury = plan.redistributions.find(r => r.pubkey === 'bao-treasury');
    expect(treasury).toBeDefined();
    expect(treasury!.reason).toBe('treasury');
    // 5,000 (j1) + 10,000 (j2) + 50,000 (bond) = 65,000
    expect(treasury!.returnAmount).toBe(65_000);
    expect(plan.slashedPool).toBe(65_000);
  });

  it('passes integrity with coherent jurors (dust < coherent count)', () => {
    const plan = computeRedistributionPlan(baseParams);
    const integrity = verifyRedistributionIntegrity(plan);
    expect(integrity.valid).toBe(true);
    // Deposited = 4 × 10,000 (stakes) + 50,000 (bond) = 90,000.
    // Returned = 5,000 (j3 keeps half) + 0 (j4) + 50,000 (bond) +
    //            17,500 + 17,500 (j1/j2 = stake + 7,500 reward each) = 90,000.
    expect(integrity.totalDeposited).toBe(90_000);
    expect(integrity.totalReturned).toBe(90_000);
    expect(integrity.dust).toBe(0);
  });

  it('slashing rates match the documented ALPHA constants', () => {
    expect(ALPHA_INCOHERENT).toBe(0.5);
    expect(ALPHA_NON_REVEAL).toBe(1.0);
    expect(ALPHA_DOUBLE_VOTE).toBe(1.0);
  });
});

// ── Bond ownership proof ────────────────────────────────────────────────────

describe('bond ownership proof', () => {
  // Random 32-byte secrets for the UTXO "owner".
  const utxoSeckey = '7a3f9c0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2';
  const utxoPubkeyHex = Buffer.from(schnorr.getPublicKey(Buffer.from(utxoSeckey, 'hex'))).toString('hex');

  const baseChallenge = {
    bondTxid: 'aa'.repeat(32),
    bondVout: 0,
    disputeId: 'dispute1',
    jurorPubkey: 'juror1',
    challengeNonce: 'nonce-1',
  };

  it('derives a deterministic x-only pubkey matching the signer', () => {
    // Pinned to the known x-only pubkey for the fixed seckey above, so an
    // accidental derivation change fails loudly instead of silently matching
    // itself (re-calling the same pure function would always be "deterministic").
    expect(utxoPubkeyHex).toBe('98c0635d11c0f4f7d8803899cdb3a373c8bb27f4140a04771c01554f0b1d2e9b');
  });

  it('produces a deterministic challenge that binds all fields', () => {
    const c1 = createBondOwnershipChallenge(baseChallenge);
    const c2 = createBondOwnershipChallenge(baseChallenge);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    // Changing any binding field changes the challenge.
    expect(createBondOwnershipChallenge({ ...baseChallenge, bondVout: 1 })).not.toBe(c1);
    expect(createBondOwnershipChallenge({ ...baseChallenge, disputeId: 'other' })).not.toBe(c1);
    expect(createBondOwnershipChallenge({ ...baseChallenge, jurorPubkey: 'other' })).not.toBe(c1);
    expect(createBondOwnershipChallenge({ ...baseChallenge, challengeNonce: 'other' })).not.toBe(c1);
  });

  it('signs and verifies a valid ownership proof', () => {
    const challenge = createBondOwnershipChallenge(baseChallenge);
    const sig = signBondOwnershipProof(utxoSeckey, challenge);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyBondOwnershipProof(utxoPubkeyHex, challenge, sig)).toBe(true);
  });

  it('rejects a signature over a different challenge', () => {
    const challenge = createBondOwnershipChallenge(baseChallenge);
    const other = createBondOwnershipChallenge({ ...baseChallenge, bondVout: 1 });
    const sig = signBondOwnershipProof(utxoSeckey, challenge);
    expect(verifyBondOwnershipProof(utxoPubkeyHex, other, sig)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const otherSeckey = '0b'.repeat(32);
    const otherPubkey = Buffer.from(schnorr.getPublicKey(Buffer.from(otherSeckey, 'hex'))).toString('hex');
    const challenge = createBondOwnershipChallenge(baseChallenge);
    const sig = signBondOwnershipProof(otherSeckey, challenge);
    expect(verifyBondOwnershipProof(utxoPubkeyHex, challenge, sig)).toBe(false);
  });

  it('returns false for garbage inputs instead of throwing', () => {
    expect(verifyBondOwnershipProof('zz', 'zz', 'zz')).toBe(false);
    expect(verifyBondOwnershipProof('', '', '')).toBe(false);
  });
});

// ── Escrow ledger state machine ─────────────────────────────────────────────

describe('EscrowLedger', () => {
  const base = {
    marketId: 'market1',
    disputeId: 'dispute1',
    round: 1,
    depositorPubkey: 'j1',
    amountSats: 10_000,
    bondAddress: 'addr1',
    committedAt: 1_700_000_000,
  };
  const stakeId = 'dispute1|juror_stake|j1';
  const bondId = 'dispute1|dispute_bond|disputer';

  it('records a deposit as pending', () => {
    const ledger = new EscrowLedger();
    const d = ledger.record({ ...base, purpose: 'juror_stake' });
    expect(d.status).toBe('pending');
    expect(d.id).toBe(stakeId);
    expect(ledger.get(stakeId)).toBe(d);
  });

  it('rejects duplicate deposit ids', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    expect(() => ledger.record({ ...base, purpose: 'juror_stake' })).toThrow(/duplicate/i);
  });

  it('locks a pending deposit on proof acceptance', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    const d = ledger.lock(stakeId, true);
    expect(d.status).toBe('locked');
  });

  it('fails a pending deposit when proof is rejected', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    const d = ledger.lock(stakeId, false);
    expect(d.status).toBe('failed');
    expect(d.resolvedAt).toBeDefined();
  });

  it('refuses to lock a non-pending deposit', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    ledger.lock(stakeId, true);
    expect(() => ledger.lock(stakeId, true)).toThrow(/cannot lock/);
  });

  it('returns a locked deposit (coherent)', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    ledger.lock(stakeId, true);
    const d = ledger.returnDeposit(stakeId, 'coherent');
    expect(d.status).toBe('returned');
    expect(d.reason).toBe('coherent');
  });

  it('slashes incoherent 50% / non-reveal 100%', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    ledger.lock(stakeId, true);
    expect(ledger.slash(stakeId, 'incoherent').status).toBe('slashed_50');
    expect(ledger.redistribute(stakeId).status).toBe('redistributed');
  });

  it('refuses double slash / invalid transitions', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    ledger.lock(stakeId, true);
    ledger.slash(stakeId, 'incoherent');
    expect(() => ledger.slash(stakeId, 'non_reveal')).toThrow(/cannot slash/);
    expect(() => ledger.returnDeposit(stakeId)).toThrow(/cannot return/);
  });

  it('serializes and restores via snapshot', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' });
    ledger.record({ ...base, purpose: 'dispute_bond', depositorPubkey: 'disputer' });
    ledger.lock(stakeId, true);
    const restored = EscrowLedger.fromSnapshot(ledger.snapshot());
    expect(restored.get(stakeId)?.status).toBe('locked');
    expect(restored.all()).toHaveLength(2);
  });

  it('applies a plan to the ledger (coherent + incoherent + bond)', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'juror_stake' }); // j1 coherent
    ledger.record({ ...base, purpose: 'juror_stake', depositorPubkey: 'j3' }); // j3 incoherent
    ledger.record({ ...base, purpose: 'dispute_bond', depositorPubkey: 'disputer', amountSats: 50_000 }); // bond
    ledger.lock(stakeId, true);
    ledger.lock('dispute1|juror_stake|j3', true);
    ledger.lock(bondId, true);

    const plan = computeRedistributionPlan({
      marketId: 'market1',
      disputeId: 'dispute1',
      round: 1,
      stakePerJuror: 10_000,
      coherentJurors: ['j1'],
      incoherentJurors: ['j3'],
      nonRevealJurors: [],
      disputeUpheld: true,
      bondAmount: 50_000,
      disputerPubkey: 'disputer',
    });

    ledger.applyPlan(plan);
    expect(ledger.get(stakeId)?.status).toBe('returned');
    expect(ledger.get(stakeId)?.reason).toBe('coherent');
    expect(ledger.get('dispute1|juror_stake|j3')?.status).toBe('slashed_50');
    expect(ledger.get(bondId)?.status).toBe('returned');
    expect(ledger.get(bondId)?.reason).toBe('bond_won');
  });

  it('applies a rejected-dispute plan (bond forfeited)', () => {
    const ledger = new EscrowLedger();
    ledger.record({ ...base, purpose: 'dispute_bond', depositorPubkey: 'disputer', amountSats: 50_000 });
    ledger.lock(bondId, true);
    const plan = computeRedistributionPlan({
      marketId: 'market1',
      disputeId: 'dispute1',
      round: 1,
      stakePerJuror: 10_000,
      coherentJurors: ['j1'],
      incoherentJurors: [],
      nonRevealJurors: [],
      disputeUpheld: false,
      bondAmount: 50_000,
      disputerPubkey: 'disputer',
    });
    ledger.applyPlan(plan);
    expect(ledger.get(bondId)?.status).toBe('slashed_100');
    expect(ledger.get(bondId)?.reason).toBe('bond_lost');
  });
});

// ── verifyRedistributionIntegrity ───────────────────────────────────────────

describe('verifyRedistributionIntegrity', () => {
  it('passes a clean coherent plan', () => {
    const plan = computeRedistributionPlan({
      marketId: 'm',
      disputeId: 'd',
      round: 1,
      stakePerJuror: 10_000,
      coherentJurors: ['a', 'b'],
      incoherentJurors: ['c'],
      nonRevealJurors: ['d2'],
      disputeUpheld: true,
      bondAmount: 50_000,
      disputerPubkey: 'e',
    });
    expect(verifyRedistributionIntegrity(plan).valid).toBe(true);
  });

  it('passes when no coherent jurors exist (treasury absorbs dust)', () => {
    const plan = computeRedistributionPlan({
      marketId: 'm',
      disputeId: 'd',
      round: 1,
      stakePerJuror: 10_000,
      coherentJurors: [],
      incoherentJurors: ['a'],
      nonRevealJurors: ['b'],
      disputeUpheld: false,
      bondAmount: 50_000,
      disputerPubkey: 'c',
    });
    const result = verifyRedistributionIntegrity(plan);
    expect(result.valid).toBe(true);
    // Deposited = 10,000 + 10,000 + 50,000 (bond) = 70,000.
    // Returned = 5,000 (a keeps half) + 0 (b) + 0 (bond forfeited) +
    //            65,000 (treasury carries the pool) = 70,000.
    expect(result.totalDeposited).toBe(70_000);
    expect(result.totalReturned).toBe(70_000);
    expect(result.dust).toBe(0);
  });

  it('flags a plan that returns more than it deposits', () => {
    // No coherent jurors + upheld bond: depositor gets their full bond back,
    // stake returns floor(50%) to incoherent — always conservative, but for
    // a pure over-payment case we can fabricate a plan record.
    const plan = computeRedistributionPlan({
      marketId: 'm',
      disputeId: 'd',
      round: 1,
      stakePerJuror: 10_000,
      coherentJurors: ['a'],
      incoherentJurors: [],
      nonRevealJurors: [],
      disputeUpheld: true,
      bondAmount: 50_000,
      disputerPubkey: 'b',
    });
    // Overpay the coherent juror beyond the pool.
    const overpaid = {
      ...plan,
      redistributions: plan.redistributions.map((r) =>
        r.reason === 'coherent' ? { ...r, returnAmount: 10_000 + 999_999 } : r,
      ),
    };
    expect(verifyRedistributionIntegrity(overpaid).valid).toBe(false);
  });
});
