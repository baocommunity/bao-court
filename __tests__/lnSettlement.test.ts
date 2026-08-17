// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  deriveLnPreimage,
  paymentHash,
  deriveHoldInvoicePair,
  constructHoldOffer,
  LnHoldLedger,
  planDecisionsForHolds,
  buildLnAuditEvent,
  type LnHoldConstruction,
} from '../lnSettlement';
import { computeRedistributionPlan } from '../escrow';

// ── Preimage / payment hash ─────────────────────────────────────────────────

describe('ln preimage derivation', () => {
  const witness = {
    disputeId: 'dispute1',
    role: 'juror' as const,
    pubkey: 'j1',
    outcome: 'YES',
    attestationDigest: 'aa'.repeat(32),
    round: 1,
  };

  it('derives a deterministic 64-hex preimage and hash', () => {
    const { preimage, paymentHash: ph } = deriveHoldInvoicePair(witness);
    expect(preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ph).toBe(paymentHash(preimage));
  });

  it('binds every witness field (no field may be silently dropped)', () => {
    const base = deriveLnPreimage(witness);
    expect(deriveLnPreimage({ ...witness, disputeId: 'other' })).not.toBe(base);
    expect(deriveLnPreimage({ ...witness, role: 'disputer' })).not.toBe(base);
    expect(deriveLnPreimage({ ...witness, pubkey: 'j2' })).not.toBe(base);
    expect(deriveLnPreimage({ ...witness, outcome: 'NO' })).not.toBe(base);
    expect(deriveLnPreimage({ ...witness, attestationDigest: 'bb'.repeat(32) })).not.toBe(base);
    expect(deriveLnPreimage({ ...witness, round: 2 })).not.toBe(base);
  });

  it('uses sha256(preimage) as the payment hash (BOLT/BIP-353 semantics)', () => {
    const { preimage, paymentHash: ph } = deriveHoldInvoicePair(witness);
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    expect(ph).toBe(expected);
  });
});

// ── Hold invoice ledger ─────────────────────────────────────────────────────

describe('LnHoldLedger', () => {
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

  it('records a hold as offer with deterministic id', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    expect(rec.status).toBe('offer');
    expect(rec.id).toBe('dispute1|juror|j1|1');
    expect(ledger.get(rec.id)).toBe(rec);
  });

  it('rejects duplicate ids', () => {
    const ledger = new LnHoldLedger();
    ledger.offer(construction());
    expect(() => ledger.offer(construction())).toThrow(/duplicate/i);
  });

  it('marks a hold as held within the expiry window', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    const held = ledger.hold(rec.id, 1_900_000_000);
    expect(held.status).toBe('held');
    expect(held.heldAt).toBe(1_900_000_000);
  });

  it('rejects holding after expiry', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    expect(() => ledger.hold(rec.id, 2_000_000_001)).toThrow(/expired/i);
  });

  it('settles a coherent hold (releases preimage path)', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    ledger.hold(rec.id, 1_900_000_000);
    const settled = ledger.decide(rec.id, 'settle', 1_950_000_000);
    expect(settled.status).toBe('settled');
    expect(settled.decision).toBe('settle');
    expect(settled.resolvedAt).toBe(1_950_000_000);
    // The preimage is present so the host can release it to the rail.
    expect(settled.preimage).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cancels an incoherent hold (no preimage released)', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    ledger.hold(rec.id, 1_900_000_000);
    const cancelled = ledger.decide(rec.id, 'cancel', 1_950_000_000);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.decision).toBe('cancel');
  });

  it('rejects decide before held, after expiry, or twice', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    expect(() => ledger.decide(rec.id, 'settle')).toThrow(/cannot decide/);
    ledger.hold(rec.id, 1_900_000_000);
    expect(() => ledger.decide(rec.id, 'cancel', 2_000_000_001)).toThrow(/expired/);
    ledger.decide(rec.id, 'settle', 1_950_000_000);
    expect(() => ledger.decide(rec.id, 'cancel', 1_960_000_000)).toThrow(/cannot decide/);
  });

  it('expires a held hold past its deadline (refund path)', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    ledger.hold(rec.id, 1_900_000_000);
    const expired = ledger.expire(rec.id, 2_000_000_001);
    expect(expired.status).toBe('expired');
    expect(expired.decision).toBeUndefined();
  });

  it('snapshot round-trips the full state', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer(construction());
    ledger.hold(rec.id, 1_900_000_000);
    ledger.decide(rec.id, 'settle', 1_950_000_000);
    const restored = LnHoldLedger.fromSnapshot(ledger.snapshot());
    expect(restored.get(rec.id)?.status).toBe('settled');
    expect(restored.all()).toHaveLength(1);
  });
});

// ── Decision mapping from the redistribution plan ───────────────────────────

describe('planDecisionsForHolds', () => {
  const holdFor = (pubkey: string) =>
    constructHoldOffer({
      disputeId: 'dispute1',
      role: 'juror',
      pubkey,
      outcome: 'YES',
      attestationDigest: 'aa'.repeat(32),
      round: 1,
      amountSats: 10_000,
      expiresAt: 2_000_000_000,
    });
  const bondHold = (pubkey: string) =>
    constructHoldOffer({
      disputeId: 'dispute1',
      role: 'disputer',
      pubkey,
      outcome: 'YES',
      attestationDigest: 'aa'.repeat(32),
      round: 1,
      amountSats: 50_000,
      expiresAt: 2_000_000_000,
    });

  const plan = (upheld: boolean) =>
    computeRedistributionPlan({
      marketId: 'm',
      disputeId: 'dispute1',
      round: 1,
      stakePerJuror: 10_000,
      coherentJurors: ['j1'],
      incoherentJurors: ['j3'],
      nonRevealJurors: ['j4'],
      disputeUpheld: upheld,
      bondAmount: 50_000,
      disputerPubkey: 'disputer',
    });

  it('settles coherent, cancels incoherent/non-reveal/double-vote', () => {
    const holds = [holdFor('j1'), holdFor('j3'), holdFor('j4'), holdFor('j5')];
    const { decisions } = planDecisionsForHolds(plan(true), holds);
    expect(decisions['dispute1|juror|j1|1']).toBe('settle');
    expect(decisions['dispute1|juror|j3|1']).toBe('cancel');
    expect(decisions['dispute1|juror|j4|1']).toBe('cancel');
    // j5 not in the plan → unsettled (reclaim path).
    expect(decisions['dispute1|juror|j5|1']).toBeUndefined();
  });

  it('settles the bond hold when the dispute is upheld, cancels when rejected', () => {
    const bonds = [bondHold('disputer')];
    const upheld = planDecisionsForHolds(plan(true), bonds);
    expect(upheld.decisions['dispute1|disputer|disputer|1']).toBe('settle');
    const rejected = planDecisionsForHolds(plan(false), bonds);
    expect(rejected.decisions['dispute1|disputer|disputer|1']).toBe('cancel');
  });

  it('lists unmentioned holds as unsettled (reclaim path data)', () => {
    const holds = [holdFor('j1'), holdFor('j9')];
    const { decisions, unsettled } = planDecisionsForHolds(plan(true), holds);
    expect(decisions['dispute1|juror|j1|1']).toBe('settle');
    expect(unsettled).toContain('dispute1|juror|j9|1');
    expect(unsettled).not.toContain('dispute1|juror|j1|1');
  });
});

// ── Audit event templates ───────────────────────────────────────────────────

describe('buildLnAuditEvent', () => {
  it('builds a JSON-safe template with binding tags', () => {
    const ledger = new LnHoldLedger();
    const rec = ledger.offer({
      disputeId: 'dispute1',
      role: 'juror',
      pubkey: 'j1',
      outcome: 'YES',
      attestationDigest: 'aa'.repeat(32),
      round: 1,
      amountSats: 10_000,
      expiresAt: 2_000_000_000,
      invoiceId: 'inv-123',
    });
    ledger.hold(rec.id, 1_900_000_000);
    ledger.decide(rec.id, 'settle', 1_950_000_000);
    const ev = buildLnAuditEvent(39110, ledger.get(rec.id)!);
    expect(ev.kind).toBe(39110);
    expect(ev.tags.some((t) => t[0] === 'payment_hash' && t[1] === rec.paymentHash)).toBe(true);
    expect(ev.tags.some((t) => t[0] === 'decision' && t[1] === 'settle')).toBe(true);
    const content = JSON.parse(ev.content) as Record<string, unknown>;
    expect(content.status).toBe('settled');
    expect(content.disputeId).toBe('dispute1');
    // Never leak the preimage in the audit event.
    expect(JSON.stringify(content)).not.toContain(rec.preimage);
  });
});
