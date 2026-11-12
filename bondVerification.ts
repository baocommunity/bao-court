// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Bond verification helpers for BAO Court juror candidacies.
 *
 * These functions verify that a claimed bond UTXO exists on-chain, pays the
 * expected escrow address/script, and has the expected amount. The actual
 * network queries are performed by pluggable fetchers so the package stays
 * isomorphic (browser + Node).
 */

import type { StakeCommitment } from './types';
import { CourtArgumentError } from './errors';

export interface UtxoInfo {
  readonly txid: string;
  readonly vout: number;
  readonly amountSats: number;
  readonly scriptPubKey: string;
  readonly confirmations: number;
  readonly status: 'confirmed' | 'unconfirmed';
}

export interface BondVerificationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly utxo?: UtxoInfo;
}

export interface BondVerifier {
  readonly getUtxo: (txid: string, vout: number) => Promise<UtxoInfo | null>;
}

/**
 * A RAIL-AGNOSTIC reference to a juror's bond.
 *
 * `StakeCommitment` above describes an on-chain UTXO (one rail). Bonds are
 * moving to Liquid testnet first and will later exist on other rails, so a
 * ceremony roster entry needs to say WHICH rail, WHICH network, and WHERE the
 * proof lives — without the ceremony having to understand every rail.
 *
 * The reference is deliberately opaque (`proofRef`): for `liquid` it will be a
 * Liquid testnet txid/asset commitment, for `lightning` a payment preimage
 * hash, for `cashu` a token commitment, for `onchain` a Bitcoin txid:vout.
 * Verification is a SEPARATE step (`verifyBond`, per-rail verifiers); this
 * round only plumbs and records the reference, and never treats an unverified
 * reference as a satisfied bond.
 *
 * Terminology (operator decision): the network historically called "demo" is
 * `private-signet` in every human-readable string and field value. Evidence
 * hierarchy is public testnet4 / signet-public ABOVE private signet, which is
 * why new bond plans name `testnet` first.
 */
export const BOND_RAILS = ['liquid', 'lightning', 'onchain', 'cashu', 'none'] as const;
export type BondRail = (typeof BOND_RAILS)[number];

export const BOND_NETWORKS = ['testnet', 'signet-public', 'private-signet'] as const;
export type BondNetwork = (typeof BOND_NETWORKS)[number];

export interface CourtBondRef {
  /** Settlement rail the bond lives on (`none` = no bond claimed yet). */
  readonly rail: BondRail;
  /** Network the bond lives on. Public testnet4 is `testnet`. */
  readonly network: BondNetwork;
  /** Rail-specific proof reference (txid, preimage hash, token id…), or null. */
  readonly proofRef: string | null;
}

/** A roster entry that claims no bond yet — the honest default for this round. */
export const UNBONDED: CourtBondRef = { rail: 'none', network: 'testnet', proofRef: null };

/**
 * Validate and normalise a bond reference supplied as JSON (roster file, wire
 * payload). Unknown rails/networks are rejected rather than coerced: a typo
 * must not silently become "no bond".
 */
export function parseCourtBondRef(value: unknown): CourtBondRef {
  if (typeof value !== 'object' || value === null) {
    throw new CourtArgumentError('BOND_ARGUMENT', 'bond reference must be an object');
  }
  const raw = value as Record<string, unknown>;
  const rail = String(raw.rail ?? '');
  const network = String(raw.network ?? '');
  const proofRef = raw.proofRef ?? null;
  if (!(BOND_RAILS as readonly string[]).includes(rail)) {
    throw new CourtArgumentError('BOND_ARGUMENT', `bond.rail must be one of ${BOND_RAILS.join('|')}, got "${rail}"`);
  }
  if (!(BOND_NETWORKS as readonly string[]).includes(network)) {
    throw new CourtArgumentError('BOND_ARGUMENT', `bond.network must be one of ${BOND_NETWORKS.join('|')}, got "${network}"`);
  }
  if (proofRef !== null && typeof proofRef !== 'string') {
    throw new CourtArgumentError('BOND_ARGUMENT', 'bond.proofRef must be a string or null');
  }
  if (proofRef !== null && proofRef.length > 512) {
    throw new CourtArgumentError('BOND_ARGUMENT', 'bond.proofRef must be at most 512 characters');
  }
  return { rail: rail as BondRail, network: network as BondNetwork, proofRef: proofRef as string | null };
}

/** The same reference, serialised for a log/artifact (never contains a secret). */
export function formatCourtBondRef(bond: CourtBondRef): string {
  return `${bond.rail}/${bond.network}${bond.proofRef ? `:${bond.proofRef}` : ''}`;
}

export interface VerifyBondOptions {
  readonly commitment: StakeCommitment;
  readonly expectedAddress?: string;
  readonly expectedScriptPubKey?: string;
  readonly minAmountSats?: number;
  readonly minConfirmations?: number;
  readonly verifier: BondVerifier;
}

/**
 * Verify a claimed bond UTXO.
 */
export async function verifyBond(
  options: VerifyBondOptions,
): Promise<BondVerificationResult> {
  const { commitment, expectedAddress, expectedScriptPubKey, minAmountSats, minConfirmations = 1, verifier } = options;

  if (!commitment.bondTxid || commitment.bondVout === undefined) {
    return { valid: false, error: 'Missing bond txid or vout' };
  }

  const utxo = await verifier.getUtxo(commitment.bondTxid, commitment.bondVout);
  if (!utxo) {
    return { valid: false, error: 'Bond UTXO not found' };
  }

  if (minConfirmations > 0 && utxo.confirmations < minConfirmations) {
    return { valid: false, error: `Insufficient confirmations: ${utxo.confirmations} < ${minConfirmations}` };
  }

  if (minAmountSats !== undefined && utxo.amountSats < minAmountSats) {
    return { valid: false, error: `Insufficient bond amount: ${utxo.amountSats} < ${minAmountSats}` };
  }

  if (expectedScriptPubKey && utxo.scriptPubKey !== expectedScriptPubKey) {
    return { valid: false, error: 'Bond UTXO does not pay the expected script' };
  }

  // Address-based verification is verifier-specific; by default we only check
  // scriptPubKey when provided. Callers must derive the expected script from
  // the escrow address and pass it in — an ignored address expectation is
  // worse than none, so passing only an address fails closed.
  if (expectedAddress && !expectedScriptPubKey) {
    return {
      valid: false,
      error: 'expectedAddress requires expectedScriptPubKey (derive the script from the escrow address first)',
    };
  }

  return { valid: true, utxo };
}

/**
 * Compute the required bond for a market.
 */
export function computeRequiredBond(
  marketVolumeSats: number,
  bondRate = 0.01,
  minBondSats = 1_000_000,
): number {
  return Math.max(minBondSats, Math.floor(marketVolumeSats * bondRate));
}

/**
 * BAO Markets Mempool UTXO verifier.
 *
 * Supports both the singular `/tx/:txid/outspend/:vout` path and the
 * array `/tx/:txid/outspends` path used by the public BAO Markets custom signet
 * mempool backend (`https://mempool.bao.markets/api`).
 */
export function createBaoMempoolVerifier(baseUrl: string): BondVerifier {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  return {
    async getUtxo(txid, vout) {
      let spent = false;

      try {
        const spendRes = await fetch(`${root}/tx/${txid}/outspend/${vout}`);
        if (spendRes.ok) {
          const data = (await spendRes.json()) as { spent: boolean };
          spent = data.spent;
        } else if (spendRes.status === 404) {
          // BAO Markets Mempool backend returns an array of outspends for all outputs.
          const mempoolRes = await fetch(`${root}/tx/${txid}/outspends`);
          if (!mempoolRes.ok) return null;
          const arr = (await mempoolRes.json()) as Array<{ spent: boolean }>;
          const entry = arr?.[vout];
          if (!entry) return null;
          spent = entry.spent;
        } else {
          return null;
        }
      } catch {
        return null;
      }

      if (spent) return null;

      try {
        const txRes = await fetch(`${root}/tx/${txid}`);
        if (!txRes.ok) return null;
        const tx = (await txRes.json()) as {
          status?: { confirmed?: boolean; block_height?: number };
          vout?: Array<{ value: number; scriptpubkey: string }>;
        };
        const output = tx.vout?.[vout];
        if (!output) return null;

        // Esplora-compatible backends return `value` in satoshis.
        const amountSats = Math.round(output.value);

        // Compute the real confirmation count from the chain tip when the tx
        // status carries a block height. Fall back to 1/0 when the tip is
        // unavailable so a confirmed tx is never reported as having more
        // confirmations than it provably has.
        let confirmations = tx.status?.confirmed ? 1 : 0;
        if (tx.status?.confirmed && typeof tx.status.block_height === 'number') {
          try {
            const tipRes = await fetch(`${root}/blocks/tip/height`);
            if (tipRes.ok) {
              const tip = Number(await tipRes.json());
              if (Number.isFinite(tip)) {
                confirmations = Math.max(1, tip - tx.status.block_height + 1);
              }
            }
          } catch {
            // Keep the conservative fallback.
          }
        }

        return {
          txid,
          vout,
          amountSats,
          scriptPubKey: output.scriptpubkey,
          confirmations,
          status: tx.status?.confirmed ? 'confirmed' : 'unconfirmed',
        };
      } catch {
        return null;
      }
    },
  };
}

/** @deprecated Use {@link createBaoMempoolVerifier}. */
export const createEsploraVerifier = createBaoMempoolVerifier;
