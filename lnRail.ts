// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Panel A — Lightning rail adapter contract (host-injected).
 *
 * The court package computes the protocol (preimages, decisions, hold
 * lifecycle) but NEVER touches a Lightning node. Hosts implement {@link LnRail}
 * privately (LNbits/CLN/LND on BAO signet) and inject it. This module defines
 * the contract + an in-memory fake used ONLY in tests to prove the contract is
 * implementable and to exercise call ordering.
 *
 * No credentials, no secrets, no node URLs live here.
 */

import { LnRailError } from './errors';
import type { LnDecision, LnHoldRecord } from './lnSettlement';

/** Parameters for creating a hold invoice on the rail. */
export interface LnRailCreateInvoiceParams {
  /** Payment hash (sha256 of deterministic preimage) the hold will pay. */
  readonly paymentHash: string;
  readonly amountSats: number;
  readonly memo: string;
  /** Invoice expiry hint (unix seconds). */
  readonly expiresAt: number;
}

/** Result of creating a hold invoice: host invoice id + optional bolt11 string. */
export interface LnRailCreateInvoiceResult {
  readonly invoiceId: string;
  /** Optional: the bolt11 string (host-specific). */
  readonly bolt11?: string;
}

/** Current rail-side status of a hold invoice (all boolean flags independent). */
export interface LnRailStatus {
  readonly invoiceId?: string;
  readonly paid: boolean;
  readonly settled: boolean;
  readonly cancelled: boolean;
  readonly expired: boolean;
}

/**
 * Host-injected Lightning rail adapter: the ONLY way the court package
 * touches a Lightning node. Hosts implement this over LNbits/CLN/LND; the
 * package itself performs no I/O and holds no credentials.
 */
export interface LnRail {
  /** Create a hold invoice for the given payment hash. */
  readonly createHoldInvoice: (params: LnRailCreateInvoiceParams) => Promise<LnRailCreateInvoiceResult>;
  /** Release the preimage to settle a held invoice (coherent / bond won). */
  readonly settleHold: (invoiceId: string, preimageHex: string) => Promise<void>;
  /** Cancel a held invoice (incoherent / bond lost). */
  readonly cancelHold: (invoiceId: string) => Promise<void>;
  /** Poll current status. */
  readonly getStatus: (invoiceId: string) => Promise<LnRailStatus>;
  /** Block until the hold is paid (host timeout dependent). */
  readonly waitForPayment: (invoiceId: string, timeoutMs: number) => Promise<void>;
}

/** Apply a decision to the rail: settle releases the preimage, cancel drops it. */
export async function applyLnDecision(
  rail: LnRail,
  hold: LnHoldRecord,
  decision: LnDecision,
): Promise<void> {
  if (!hold.invoiceId) throw new LnRailError('LN_RAIL', `applyLnDecision: hold ${hold.id} has no invoiceId`);
  if (decision === 'settle') {
    await rail.settleHold(hold.invoiceId, hold.preimage);
  } else {
    await rail.cancelHold(hold.invoiceId);
  }
}

// ── In-memory fake (tests only) ─────────────────────────────────────────────

/**
 * Mutable state of the in-memory fake rail: invoice table and the ordered
 * call log. Exposed for test assertions only.
 */
export interface FakeLnRailState {
  readonly invoices: Map<string, {
    paymentHash: string;
    amountSats: number;
    paid: boolean;
    settled: boolean;
    cancelled: boolean;
    /** last released preimage, if settled */
    releasedPreimage?: string;
    expiry: number;
  }>;
  /** ordered record of calls for assertion */
  readonly calls: string[];
}

/** Test knobs for the fake rail: auto-pay behavior and settle/cancel failure injection. */
export interface FakeLnRailOptions {
  /** Auto-mark paid on create after N holds (default 1: immediately paid). */
  readonly payOnCreate?: boolean;
  /** If set, settle/cancel throw (simulate backend failure). */
  readonly failSettle?: boolean;
  readonly failCancel?: boolean;
}

/**
 * Create an in-memory fake {@link LnRail} for tests: instant holds,
 * deterministic status transitions, failure injection, and an ordered call
 * log for asserting call ordering.
 *
 * LIMIT: TESTS ONLY — never wire this into a production host; it settles
 * nothing on a real Lightning node.
 */
export function createFakeLnRail(options: FakeLnRailOptions = {}): { rail: LnRail; state: FakeLnRailState } {
  const state: FakeLnRailState = { invoices: new Map(), calls: [] };
  const payOnCreate = options.payOnCreate ?? true;

  const rail: LnRail = {
    async createHoldInvoice(params) {
      const invoiceId = `fake-${state.invoices.size + 1}`;
      state.calls.push(`create:${params.paymentHash.slice(0, 8)}:${params.amountSats}`);
      state.invoices.set(invoiceId, {
        paymentHash: params.paymentHash,
        amountSats: params.amountSats,
        paid: payOnCreate,
        settled: false,
        cancelled: false,
        expiry: params.expiresAt,
      });
      return { invoiceId, bolt11: `lnbc${invoiceId}` };
    },
    async settleHold(invoiceId, preimageHex) {
      state.calls.push(`settle:${invoiceId}:${preimageHex.slice(0, 8)}`);
      const inv = state.invoices.get(invoiceId);
      if (!inv) throw new LnRailError('LN_RAIL', `fake rail: unknown invoice ${invoiceId}`);
      if (options.failSettle) throw new LnRailError('LN_RAIL', 'fake rail: settle failure');
      inv.settled = true;
      inv.releasedPreimage = preimageHex;
    },
    async cancelHold(invoiceId) {
      state.calls.push(`cancel:${invoiceId}`);
      const inv = state.invoices.get(invoiceId);
      if (!inv) throw new LnRailError('LN_RAIL', `fake rail: unknown invoice ${invoiceId}`);
      if (options.failCancel) throw new LnRailError('LN_RAIL', 'fake rail: cancel failure');
      inv.cancelled = true;
    },
    async getStatus(invoiceId) {
      const inv = state.invoices.get(invoiceId);
      if (!inv) return { paid: false, settled: false, cancelled: false, expired: false };
      // `expiry` is unix seconds (matching LnHoldRecord.expiresAt); compare
      // with the clock in the same unit, not Date.now() milliseconds.
      const nowSec = Math.floor(Date.now() / 1000);
      return { invoiceId, paid: inv.paid, settled: inv.settled, cancelled: inv.cancelled, expired: !inv.paid && nowSec > inv.expiry };
    },
    async waitForPayment(invoiceId) {
      state.calls.push(`wait:${invoiceId}`);
      const inv = state.invoices.get(invoiceId);
      if (!inv) throw new LnRailError('LN_RAIL', `fake rail: unknown invoice ${invoiceId}`);
      if (!payOnCreate && !inv.paid) {
        // one-shot: mark paid (simulates the payer paying a hold)
        inv.paid = true;
      }
    },
  };

  return { rail, state };
}
