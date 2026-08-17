// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { createFakeLnRail, applyLnDecision, type FakeLnRailState } from '../lnRail';
import { constructHoldOffer, type LnHoldConstruction } from '../lnSettlement';

const construction = (overrides: Partial<LnHoldConstruction> = {}): LnHoldConstruction => ({
  disputeId: 'dispute1',
  role: 'juror',
  pubkey: 'j1',
  outcome: 'YES',
  attestationDigest: 'aa'.repeat(32),
  round: 1,
  amountSats: 10_000,
  expiresAt: 2_000_000_000,
  ...overrides,
});

describe('LnRail adapter contract', () => {
  it('creates a hold invoice and records the payment hash', async () => {
    const { rail, state } = createFakeLnRail();
    const rec = constructHoldOffer(construction());
    const res = await rail.createHoldInvoice({
      paymentHash: rec.paymentHash,
      amountSats: rec.amountSats,
      memo: `BAO Court hold ${rec.id}`,
      expiresAt: rec.expiresAt,
    });
    expect(res.invoiceId).toBe('fake-1');
    const inv = state.invoices.get(res.invoiceId)!;
    expect(inv.paymentHash).toBe(rec.paymentHash);
    expect(inv.amountSats).toBe(10_000);
    expect(inv.paid).toBe(true);
    expect(state.calls[0]).toContain('create:');
  });

  it('settles by releasing the correct preimage (call ordering asserted)', async () => {
    const { rail, state } = createFakeLnRail();
    const rec = constructHoldOffer(construction());
    const { invoiceId } = await rail.createHoldInvoice({
      paymentHash: rec.paymentHash,
      amountSats: rec.amountSats,
      memo: 'memo',
      expiresAt: rec.expiresAt,
    });
    await applyLnDecision(rail, { ...rec, status: 'held', invoiceId } as typeof rec, 'settle');
    expect(state.calls.some((c) => c.startsWith(`settle:${invoiceId}:`))).toBe(true);
    const inv = state.invoices.get(invoiceId)!;
    expect(inv.settled).toBe(true);
    expect(inv.releasedPreimage).toBe(rec.preimage);
  });

  it('cancels without releasing the preimage', async () => {
    const { rail, state } = createFakeLnRail();
    const rec = constructHoldOffer(construction());
    const { invoiceId } = await rail.createHoldInvoice({
      paymentHash: rec.paymentHash,
      amountSats: rec.amountSats,
      memo: 'memo',
      expiresAt: rec.expiresAt,
    });
    await applyLnDecision(rail, { ...rec, status: 'held', invoiceId } as typeof rec, 'cancel');
    expect(state.calls).toContain(`cancel:${invoiceId}`);
    const inv = state.invoices.get(invoiceId)!;
    expect(inv.cancelled).toBe(true);
    expect(inv.releasedPreimage).toBeUndefined();
  });

  it('propagates host failures (fail-closed at the rail boundary)', async () => {
    const { rail } = createFakeLnRail({ failSettle: true });
    const rec = constructHoldOffer(construction());
    const { invoiceId } = await rail.createHoldInvoice({
      paymentHash: rec.paymentHash,
      amountSats: rec.amountSats,
      memo: 'memo',
      expiresAt: rec.expiresAt,
    });
    await expect(applyLnDecision(rail, { ...rec, status: 'held', invoiceId } as typeof rec, 'settle'))
      .rejects.toThrow(/settle failure/);
  });

  it('rejects a decision on a hold without an invoice id', async () => {
    const { rail } = createFakeLnRail();
    const rec = constructHoldOffer(construction());
    await expect(applyLnDecision(rail, { ...rec, status: 'held' } as typeof rec, 'settle'))
      .rejects.toThrow(/no invoiceId/);
  });

  it('waitForPayment flips an unpaid hold to paid (payer sim)', async () => {
    const { rail, state } = createFakeLnRail({ payOnCreate: false });
    const rec = constructHoldOffer(construction({ invoiceId: 'fake-1' }));
    // create (unpaid), then the payer sim pays the hold
    await rail.createHoldInvoice({
      paymentHash: rec.paymentHash,
      amountSats: rec.amountSats,
      memo: 'memo',
      expiresAt: rec.expiresAt,
    });
    expect(state.invoices.get('fake-1')!.paid).toBe(false);
    await rail.waitForPayment('fake-1', 1000);
    expect(state.invoices.get('fake-1')!.paid).toBe(true);
  });
});

// keep type import honest
export type { FakeLnRailState };
