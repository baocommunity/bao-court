// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Panel B — Liquid rail adapter contract (host-injected).
 *
 * The court package builds script trees, addresses, and transaction
 * skeletons, and decides WHICH branch to spend. It NEVER touches a Liquid
 * node. Hosts implement {@link LiquidRail} privately (Liquid node RPC +
 * Electrs on BAO signet) and inject it. This module defines the contract +
 * an in-memory fake used ONLY in tests.
 *
 * No credentials, no secrets, no node URLs live here.
 */

import type { ReleaseSkeleton, LiquidUtxo } from './liquidEscrow';

/**
 * Host-injected Liquid rail adapter: the ONLY way the court package touches
 * a Liquid chain. Hosts implement this over node RPC + Esplora; the package
 * itself performs no I/O.
 */
export interface LiquidRail {
  /** Fetch a UTXO's current state (spent/unspent, value, script). */
  readonly getUtxo: (txid: string, vout: number) => Promise<LiquidUtxo | null>;
  /** Broadcast a raw (hex) transaction; returns txid. */
  readonly broadcast: (rawTxHex: string) => Promise<string>;
  /** Poll for confirmations of a txid. */
  readonly getConfirmations: (txid: string) => Promise<number>;
}

/**
 * Decide the spend branch for a release skeleton given the court verdict.
 * 'judge' spends the Taproot judge leaf (winner + oracle sigs); 'refund'
 * spends the timelock refund leaf. The host supplies the actual signatures;
 * this is the protocol-level branch selector.
 */
export type SpendBranch = 'judge' | 'refund' | 'multisig_release' | 'multisig_slash';

/**
 * Decide the spend branch for a release given the court verdict:
 * `judge` when the dispute is upheld, `refund` when no juror was coherent,
 * otherwise `multisig_release`. Pure; O(1).
 */
export function chooseSpendBranch(verdict: {
  readonly disputeUpheld: boolean;
  readonly coherentCount: number;
}): SpendBranch {
  if (verdict.disputeUpheld) return 'judge';
  if (verdict.coherentCount === 0) return 'refund';
  return 'multisig_release';
}

// ── In-memory fake (tests only) ─────────────────────────────────────────────

/**
 * Mutable state of the in-memory fake rail: UTXO set and the broadcast log.
 * Exposed for test assertions only.
 */
export interface FakeLiquidRailState {
  readonly utxos: Map<string, LiquidUtxo>;
  readonly broadcasts: Array<{ rawTxHex: string; txid: string }>;
}

/**
 * Create an in-memory fake {@link LiquidRail} for tests: deterministic
 * txids, instant confirmations, and a recorded broadcast log.
 *
 * LIMIT: TESTS ONLY — never wire this into a production host; it settles
 * nothing on a real chain.
 */
export function createFakeLiquidRail(initialUtxos: readonly LiquidUtxo[] = []): {
  rail: LiquidRail;
  state: FakeLiquidRailState;
} {
  const state: FakeLiquidRailState = {
    utxos: new Map(initialUtxos.map((u) => [`${u.txid}:${u.vout}`, u])),
    broadcasts: [],
  };
  const rail: LiquidRail = {
    async getUtxo(txid, vout) {
      return state.utxos.get(`${txid}:${vout}`) ?? null;
    },
    async broadcast(rawTxHex) {
      const txid = `fake-txid-${state.broadcasts.length + 1}`;
      state.broadcasts.push({ rawTxHex, txid });
      return txid;
    },
    async getConfirmations() {
      return 6;
    },
  };
  return { rail, state };
}

// keep the skeleton type import honest
export type { LiquidUtxo, ReleaseSkeleton };
