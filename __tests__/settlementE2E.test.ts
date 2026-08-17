// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { createFakeLiquidRail, chooseSpendBranch, type SpendBranch } from '../liquidRail';
import { buildReleaseSkeleton, buildMultisigScript, p2wshAddress, BAO_SIGNET } from '../liquidEscrow';
import { computeRedistributionPlan } from '../escrow';
import { planDecisionsForHolds, constructHoldOffer } from '../lnSettlement';

describe('chooseSpendBranch', () => {
  it('judge when upheld, refund when held with no coherent, release otherwise', () => {
    expect(chooseSpendBranch({ disputeUpheld: true, coherentCount: 3 })).toBe('judge');
    expect(chooseSpendBranch({ disputeUpheld: true, coherentCount: 0 })).toBe('judge');
    expect(chooseSpendBranch({ disputeUpheld: false, coherentCount: 0 })).toBe('refund');
    expect(chooseSpendBranch({ disputeUpheld: false, coherentCount: 2 })).toBe('multisig_release');
  });
});

describe('LiquidRail fake', () => {
  it('returns registered UTXOs and records broadcasts', async () => {
    const utxo = { txid: '11'.repeat(32), vout: 0, amountSats: 100_000, scriptHex: '76a91411' };
    const { rail, state } = createFakeLiquidRail([utxo]);
    expect(await rail.getUtxo('11'.repeat(32), 0)).toEqual(utxo);
    expect(await rail.getUtxo('22'.repeat(32), 0)).toBeNull();
    const txid = await rail.broadcast('deadbeef');
    expect(txid).toBe('fake-txid-1');
    expect(state.broadcasts).toHaveLength(1);
    expect(await rail.getConfirmations(txid)).toBe(6);
  });
});

describe('end-to-end: court plan → LN + Liquid decisions → skeleton → broadcast', () => {
  it('runs the full pipeline for an upheld dispute (settle holds, judge path)', async () => {
    // 1. Court slashing plan.
    const plan = computeRedistributionPlan({
      marketId: 'm1', disputeId: 'd1', round: 1,
      stakePerJuror: 10_000,
      coherentJurors: ['j1'], incoherentJurors: ['j3'], nonRevealJurors: ['j4'],
      disputeUpheld: true, bondAmount: 50_000, disputerPubkey: 'disputer',
    });

    // 2. LN hold decisions from the same plan.
    const holds = [
      constructHoldOffer({ disputeId: 'd1', role: 'juror', pubkey: 'j1', outcome: 'YES', attestationDigest: 'aa'.repeat(32), round: 1, amountSats: 10_000, expiresAt: 2_000_000_000 }),
      constructHoldOffer({ disputeId: 'd1', role: 'juror', pubkey: 'j3', outcome: 'YES', attestationDigest: 'aa'.repeat(32), round: 1, amountSats: 10_000, expiresAt: 2_000_000_000 }),
      constructHoldOffer({ disputeId: 'd1', role: 'juror', pubkey: 'j4', outcome: 'YES', attestationDigest: 'aa'.repeat(32), round: 1, amountSats: 10_000, expiresAt: 2_000_000_000 }),
    ];
    const { decisions } = planDecisionsForHolds(plan, holds);
    expect(decisions['d1|juror|j1|1']).toBe('settle');
    expect(decisions['d1|juror|j3|1']).toBe('cancel');
    expect(decisions['d1|juror|j4|1']).toBe('cancel');

    // 3. Liquid branch = judge (upheld).
    const branch = chooseSpendBranch({ disputeUpheld: plan.bondOutcome === 'returned', coherentCount: 1 });
    expect(branch).toBe('judge');

    // 4. Build a multisig escrow script + its P2WSH address, fund an input.
    const jury = ['02' + 'aa'.repeat(32), '03' + 'bb'.repeat(32), '02' + 'cc'.repeat(32)];
    const script = buildMultisigScript({ pubkeys: jury, threshold: 2 });
    const escrowAddr = p2wshAddress(script, BAO_SIGNET);
    expect(escrowAddr.startsWith('tex1')).toBe(true);

    // 5. Release skeleton funding a coherent payout + fee.
    const skel = buildReleaseSkeleton(
      [{ txid: '11'.repeat(32), vout: 0, amountSats: 100_000, scriptHex: '00' }],
      [{ scriptHex: p2wshProgramFor(script), amountSats: 99000 }],
      500,
    );
    expect(skel.feeSats).toBe(1_000);

    // 6. Broadcast via the fake rail.
    const { rail, state } = createFakeLiquidRail([{ txid: '11'.repeat(32), vout: 0, amountSats: 100_000, scriptHex: '00' }]);
    const txid = await rail.broadcast('mockraw');
    expect(state.broadcasts).toHaveLength(1);
    expect(txid).toBe('fake-txid-1');
  });

  it('deterministically maps the same plan the same way (no drift between runs)', () => {
    const planA = computeRedistributionPlan({
      marketId: 'm', disputeId: 'd', round: 1, stakePerJuror: 10_000,
      coherentJurors: ['x'], incoherentJurors: ['y'], nonRevealJurors: [],
      disputeUpheld: true, bondAmount: 50_000, disputerPubkey: 'z',
    });
    const planB = computeRedistributionPlan({
      marketId: 'm', disputeId: 'd', round: 1, stakePerJuror: 10_000,
      coherentJurors: ['x'], incoherentJurors: ['y'], nonRevealJurors: [],
      disputeUpheld: true, bondAmount: 50_000, disputerPubkey: 'z',
    });
    expect(planA).toEqual(planB);
  });
});

// tiny helper: p2wshProgram hex for a recipient locking script
import { p2wshProgram } from '../liquidEscrow';
function p2wshProgramFor(scriptHex: string): string {
  return Buffer.from(p2wshProgram(scriptHex)).toString('hex');
}

// unused import guard
export type { SpendBranch };
