// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Bond escrow lifecycle, ownership proofs, and slashing for BAO Court.
 *
 * The Court is rail-agnostic: it VERIFIES bond evidence and COMPUTES the
 * deterministic escrow ledger and slashing plan; hosts move actual sats on
 * their chosen rail (Spark, Lightning, Liquid — see ADR-001 hybrid dual-panel
 * escrow). This module contains no networking and no event emission; every
 * function is pure and deterministic so any observer derives the same result.
 * Event kinds for pledges/slash evidence are owned by the host protocol layer
 * (bao.markets uses Kind 38034 for pledging; see
 * FROST_THRESHOLD_ORACLE_PLAN.md for the kind space).
 *
 * @see docs/ESCROW-SLASHING.md
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';

// ── Escrow lifecycle ─────────────────────────────────────────────────────────

/**
 * Lifecycle status of a single juror stake / challenger bond deposit.
 * Mirrors the bao.markets StakeStatus vocabulary so both sides stay aligned.
 */
export type EscrowStatus =
  | 'pending'       // Deposit announced, not yet confirmed
  | 'locked'        // Confirmed in escrow (ownership + rail proof verified)
  | 'returned'      // Returned to depositor (coherent juror / upheld bond)
  | 'slashed_50'    // 50% forfeited (incoherent juror)
  | 'slashed_100'   // 100% forfeited (non-reveal / double-vote)
  | 'redistributed' // Slashed funds sent to coherent pool
  | 'failed';       // Deposit proof rejected

export type EscrowPurpose = 'dispute_bond' | 'juror_stake';

export type EscrowReason =
  | 'coherent'
  | 'incoherent'
  | 'non_reveal'
  | 'double_vote'
  | 'bond_won'
  | 'bond_lost'
  | 'treasury';

export interface EscrowDeposit {
  /** Book-keeping identifier (disputeId|purpose|pubkey). */
  readonly id: string;
  readonly purpose: EscrowPurpose;
  readonly marketId: string;
  readonly disputeId: string;
  readonly round: number;
  readonly depositorPubkey: string;
  /** Claimed amount in sats (must match verified UTXO / rail receipt). */
  readonly amountSats: number;
  /** On-chain address / rail identifier where the funds are locked. */
  readonly bondAddress: string;
  /** Funding transaction id of the bond UTXO (when rail is on-chain). */
  readonly bondTxid?: string;
  /** Output index of the bond UTXO. */
  readonly bondVout?: number;
  /** Expected scriptPubKey of the bond UTXO. */
  readonly scriptPubKey?: string;
  readonly status: EscrowStatus;
  readonly committedAt: number;
  /** Unix seconds when the deposit reached a terminal status. */
  readonly resolvedAt?: number;
  /** Reason for a terminal status (coherent/incoherent/...). */
  readonly reason?: EscrowReason;
}

// ── Slashing constants ───────────────────────────────────────────────────────

/** Rate for incoherent jurors (voted against the winning outcome). */
export const ALPHA_INCOHERENT = 0.5;
/** Rate for non-reveal jurors (committed but never revealed). */
export const ALPHA_NON_REVEAL = 1.0;
/** Rate for double-voting jurors (multiple reveals / commit mismatch). */
export const ALPHA_DOUBLE_VOTE = 1.0;

// ── Amount calculations ──────────────────────────────────────────────────────

/**
 * Dispute bond amount from market volume and appeal round.
 * Bond = max(5% of volume, 10,000 sats); rounds double it (1x, 2x, 4x).
 */
export function calculateBondAmount(marketVolumeSats: number, round: number): number {
  const baseBond = Math.max(Math.floor(marketVolumeSats * 0.05), 10_000);
  const multiplier = Math.pow(2, Math.max(0, round - 1));
  return baseBond * multiplier;
}

/**
 * Per-juror stake requirement for a dispute round.
 * Stake = max(2% of volume, 5,000 sats); rounds double it.
 */
export function calculateJurorStake(marketVolumeSats: number, round: number): number {
  const baseStake = Math.max(Math.floor(marketVolumeSats * 0.02), 5_000);
  const multiplier = Math.pow(2, Math.max(0, round - 1));
  return baseStake * multiplier;
}

/** Total sats at stake: all juror stakes plus the challenger bond. */
export function calculateTotalAtStake(
  stakePerJuror: number,
  jurorCount: number,
  bondAmount: number,
): number {
  return stakePerJuror * jurorCount + bondAmount;
}

// ── Deterministic slashing plan ──────────────────────────────────────────────

export interface StakeRedistribution {
  readonly pubkey: string;
  readonly stakeAmount: number;
  readonly returnAmount: number;
  readonly slashedAmount: number;
  readonly reason: EscrowReason;
  /** Rail receipt of the return payment (host fills in when executed). */
  readonly returnProof?: string;
}

export interface RedistributionPlan {
  readonly marketId: string;
  readonly disputeId: string;
  readonly round: number;
  /** Total sats collected from slashed stakes + forfeited bond. */
  readonly slashedPool: number;
  /** Per-participant redistribution records. */
  readonly redistributions: readonly StakeRedistribution[];
  readonly bondOutcome: 'returned' | 'forfeited';
  /** Pubkey of the disputer (bond) participant, for ledger matching. */
  readonly disputerPubkey: string;
}

export interface RedistributionParams {
  readonly marketId: string;
  readonly disputeId: string;
  readonly round: number;
  readonly stakePerJuror: number;
  readonly coherentJurors: readonly string[];
  readonly incoherentJurors: readonly string[];
  readonly nonRevealJurors: readonly string[];
  readonly doubleVotingJurors?: readonly string[];
  readonly disputeUpheld: boolean;
  readonly bondAmount: number;
  readonly disputerPubkey: string;
}

/**
 * Build the deterministic slashing/redistribution plan for a dispute.
 *
 * Rules (Kleros-style, matches bao.markets DisputeEscrowService):
 * - Coherent jurors (voted with majority): stake returned + share of pool.
 * - Incoherent jurors: lose ALPHA_INCOHERENT (50%) of stake.
 * - Non-reveal jurors: lose 100%.
 * - Double-voting jurors: lose 100%.
 * - Dispute bond: returned if dispute upheld, forfeited if rejected.
 * - No coherent jurors -> slashed pool goes to the treasury (dust guard).
 */
export function computeRedistributionPlan(
  params: RedistributionParams,
): RedistributionPlan {
  const redistributions: StakeRedistribution[] = [];
  let slashedPool = 0;

  const add = (r: StakeRedistribution) => {
    redistributions.push(r);
    slashedPool += r.slashedAmount;
  };

  // Incoherent: keep floor(alpha * stake), slash the rest.
  for (const pubkey of params.incoherentJurors) {
    const returned = Math.floor(params.stakePerJuror * ALPHA_INCOHERENT);
    const slashed = params.stakePerJuror - returned;
    add({ pubkey, stakeAmount: params.stakePerJuror, returnAmount: returned, slashedAmount: slashed, reason: 'incoherent' });
  }

  // Non-reveal: lose 100%.
  for (const pubkey of params.nonRevealJurors) {
    const slashed = Math.floor(params.stakePerJuror * ALPHA_NON_REVEAL);
    add({ pubkey, stakeAmount: params.stakePerJuror, returnAmount: 0, slashedAmount: slashed, reason: 'non_reveal' });
  }

  // Double-vote: lose 100%.
  for (const pubkey of (params.doubleVotingJurors ?? [])) {
    const slashed = Math.floor(params.stakePerJuror * ALPHA_DOUBLE_VOTE);
    add({ pubkey, stakeAmount: params.stakePerJuror, returnAmount: 0, slashedAmount: slashed, reason: 'double_vote' });
  }

  // Bond outcome.
  const bondOutcome = params.disputeUpheld ? 'returned' : 'forfeited' as const;
  if (!params.disputeUpheld) {
    // The disputer forfeits the bond into the pool.
    add({ pubkey: params.disputerPubkey, stakeAmount: params.bondAmount, returnAmount: 0, slashedAmount: params.bondAmount, reason: 'bond_lost' });
  } else {
    add({ pubkey: params.disputerPubkey, stakeAmount: params.bondAmount, returnAmount: params.bondAmount, slashedAmount: 0, reason: 'bond_won' });
  }

  // Coherent: stake back + equal share of the slashed pool.
  const coherentCount = params.coherentJurors.length;
  const rewardPerJuror = coherentCount > 0 ? Math.floor(slashedPool / coherentCount) : 0;

  for (const pubkey of params.coherentJurors) {
    add({ pubkey, stakeAmount: params.stakePerJuror, returnAmount: params.stakePerJuror + rewardPerJuror, slashedAmount: 0, reason: 'coherent' });
  }

  // DISPUTE-CRIT-002: no coherent jurors -> unassignable dust goes to treasury
  // so verifyRedistributionIntegrity never fails on an unspendable remainder.
  if (coherentCount === 0 && slashedPool > 0) {
    const dust = slashedPool;
    // Add zero-stake treasury record carrying the dust as return (no double count).
    redistributions.push({
      pubkey: 'bao-treasury',
      stakeAmount: 0,
      returnAmount: dust,
      slashedAmount: 0,
      reason: 'treasury',
    });
    slashedPool += 0; // treasury record does not add to the pool
  }

  return {
    marketId: params.marketId,
    disputeId: params.disputeId,
    round: params.round,
    slashedPool,
    redistributions,
    bondOutcome,
    disputerPubkey: params.disputerPubkey,
  };
}

/**
 * Verify that a redistribution plan accounts for every sat it deposits.
 * Total returned + dust must equal total deposited.
 *
 * Dust bound: with coherent jurors, dust is the integer remainder of
 * slashedPool/coherentCount (< coherentCount). Without coherent jurors the
 * whole pool is treasury dust and the bound is slashedPool + 1 sat rounding.
 */
export function verifyRedistributionIntegrity(plan: RedistributionPlan): {
  valid: boolean;
  totalDeposited: number;
  totalReturned: number;
  dust: number;
} {
  const totalDeposited = plan.redistributions.reduce((sum, r) => sum + r.stakeAmount, 0);
  const totalReturned = plan.redistributions.reduce((sum, r) => sum + r.returnAmount, 0);
  const dust = totalDeposited - totalReturned;

  const coherentCount = plan.redistributions.filter((r) => r.reason === 'coherent').length;
  const maxAllowedDust = coherentCount === 0
    ? plan.slashedPool + 1
    : coherentCount;

  return {
    valid: dust >= 0 && dust <= maxAllowedDust,
    totalDeposited,
    totalReturned,
    dust,
  };
}

// ── Bond ownership proof (closes the coordinator's ownership TODO) ──────────

export const BOND_OWNERSHIP_DOMAIN = 'BAO-Court/BondOwnership/v1';

export interface BondOwnershipChallengeInput {
  readonly bondTxid: string;
  readonly bondVout: number;
  readonly disputeId: string;
  readonly jurorPubkey: string;
  /** Anti-replay salt; host supplies (e.g. deterministic nonce or timestamp). */
  readonly challengeNonce: string;
}

/**
 * Deterministic challenge message the depositor must sign with the private
 * key of the bond UTXO. Binding txid, vout, dispute, and juror prevents
 * replay of a proof across disputes or candidates.
 */
export function createBondOwnershipChallenge(input: BondOwnershipChallengeInput): string {
  const payload = [
    BOND_OWNERSHIP_DOMAIN,
    input.bondTxid.toLowerCase(),
    String(input.bondVout),
    input.disputeId,
    input.jurorPubkey,
    input.challengeNonce,
  ].join('|');
  return bytesToHex(sha256(new TextEncoder().encode(payload)));
}

/**
 * Sign a bond ownership challenge with the UTXO private key (BIP-340).
 * `utxoSeckeyHex` is the 32-byte secret key controlling the bond output.
 */
export function signBondOwnershipProof(
  utxoSeckeyHex: string,
  challengeHex: string,
): string {
  return bytesToHex(schnorr.sign(hexToBytes(challengeHex), hexToBytes(utxoSeckeyHex)));
}

/**
 * Verify a bond ownership proof against the UTXO's x-only public key.
 * `utxoXOnlyPubkeyHex` is the 32-byte x-only pubkey of the bond output
 * (derivable from scriptPubKey by the host's rail adapter).
 */
export function verifyBondOwnershipProof(
  utxoXOnlyPubkeyHex: string,
  challengeHex: string,
  signatureHex: string,
): boolean {
  try {
    return schnorr.verify(
      hexToBytes(signatureHex),
      hexToBytes(challengeHex),
      hexToBytes(utxoXOnlyPubkeyHex),
    );
  } catch {
    return false;
  }
}

// ── Escrow ledger state machine (deterministic, serializable) ────────────────

export interface EscrowLedgerSnapshot {
  readonly deposits: readonly EscrowDeposit[];
}

/**
 * Deterministic escrow ledger. Transitions are pure; the host persists the
 * snapshot and applies it to the rail. No sats move inside this class.
 */
export class EscrowLedger {
  private readonly depositsByKey = new Map<string, EscrowDeposit>();

  constructor(initial: readonly EscrowDeposit[] = []) {
    for (const d of initial) this.depositsByKey.set(d.id, d);
  }

  get(id: string): EscrowDeposit | undefined {
    return this.depositsByKey.get(id);
  }

  all(): EscrowDeposit[] {
    return [...this.depositsByKey.values()];
  }

  snapshot(): EscrowLedgerSnapshot {
    return { deposits: this.all() };
  }

  static fromSnapshot(snapshot: EscrowLedgerSnapshot): EscrowLedger {
    return new EscrowLedger(snapshot.deposits);
  }

  /**
   * Record a new deposit in `pending` state. Rejects duplicate ids.
   */
  record(deposit: Omit<EscrowDeposit, 'id' | 'status'> & { readonly id?: string }): EscrowDeposit {
    const id = deposit.id ?? `${deposit.disputeId}|${deposit.purpose}|${deposit.depositorPubkey}`;
    if (this.depositsByKey.has(id)) {
      throw new Error(`EscrowLedger: duplicate deposit id ${id}`);
    }
    const entry: EscrowDeposit = {
      ...deposit,
      id,
      status: 'pending',
    };
    this.depositsByKey.set(id, entry);
    return entry;
  }

  /**
   * Lock a pending deposit once ownership + rail proof are accepted.
   * `proofOk` is the host's verdict (verifyBond + verifyBondOwnershipProof +
   * rail receipt); the ledger only records terminal truth.
   */
  lock(id: string, proofOk: boolean, resolvedAt = Date.now()): EscrowDeposit {
    const d = this.require(id);
    if (d.status !== 'pending') throw new Error(`EscrowLedger: cannot lock ${d.status} deposit ${id}`);
    const next: EscrowDeposit = proofOk
      ? { ...d, status: 'locked' }
      : { ...d, status: 'failed', resolvedAt };
    this.depositsByKey.set(id, next);
    return next;
  }

  /** Return a locked deposit in full (coherent juror / upheld bond). */
  returnDeposit(id: string, reason: EscrowReason = 'coherent'): EscrowDeposit {
    const d = this.require(id);
    if (d.status !== 'locked') throw new Error(`EscrowLedger: cannot return ${d.status} deposit ${id}`);
    const next: EscrowDeposit = { ...d, status: 'returned', reason, resolvedAt: Date.now() };
    this.depositsByKey.set(id, next);
    return next;
  }

  /** Slash a locked deposit (incoherent 50%, non-reveal/double-vote 100%). */
  slash(id: string, reason: 'incoherent' | 'non_reveal' | 'double_vote'): EscrowDeposit {
    const d = this.require(id);
    if (d.status !== 'locked') throw new Error(`EscrowLedger: cannot slash ${d.status} deposit ${id}`);
    const status: EscrowStatus = reason === 'incoherent' ? 'slashed_50' : 'slashed_100';
    const next: EscrowDeposit = { ...d, status, reason, resolvedAt: Date.now() };
    this.depositsByKey.set(id, next);
    return next;
  }

  /**
   * Forfeit a locked dispute bond in full (dispute rejected; the bond goes
   * to the slashed pool). Semantic status is `slashed_100` with reason
   * `bond_lost`, distinct from a juror's non-reveal slash.
   */
  forfeitBond(id: string): EscrowDeposit {
    const d = this.require(id);
    if (d.status !== 'locked') throw new Error(`EscrowLedger: cannot forfeit ${d.status} bond ${id}`);
    const next: EscrowDeposit = { ...d, status: 'slashed_100', reason: 'bond_lost', resolvedAt: Date.now() };
    this.depositsByKey.set(id, next);
    return next;
  }

  /** Mark a slashed deposit as redistributed (funds moved to coherent pool). */
  redistribute(id: string): EscrowDeposit {
    const d = this.require(id);
    if (d.status !== 'slashed_50' && d.status !== 'slashed_100') {
      throw new Error(`EscrowLedger: cannot redistribute ${d.status} deposit ${id}`);
    }
    const next: EscrowDeposit = { ...d, status: 'redistributed', resolvedAt: Date.now() };
    this.depositsByKey.set(id, next);
    return next;
  }

  /**
   * Apply a computed redistribution plan to the ledger.
   * Maps each plan record back to its deposit (stake entries by pubkey,
   * bond entries by disputer pubkey) and advances the matching deposit.
   * Unmatched pubkeys (e.g. no local deposit) are ignored so a host can
   * apply a plan to a partial ledger.
   */
  applyPlan(plan: RedistributionPlan): void {
    const stakeIds = (pubkey: string) => `${plan.disputeId}|juror_stake|${pubkey}`;
    const bondId = `${plan.disputeId}|dispute_bond|${plan.disputerPubkey}`;

    for (const r of plan.redistributions) {
      if (r.reason === 'coherent') {
        const d = this.get(stakeIds(r.pubkey));
        if (d?.status === 'locked') this.returnDeposit(stakeIds(r.pubkey), 'coherent');
      } else if (r.reason === 'incoherent' || r.reason === 'non_reveal' || r.reason === 'double_vote') {
        const d = this.get(stakeIds(r.pubkey));
        if (d?.status === 'locked') this.slash(stakeIds(r.pubkey), r.reason);
      } else if (r.reason === 'bond_lost') {
        const d = this.get(bondId);
        if (d?.status === 'locked') this.forfeitBond(bondId); // 100% forfeit
      } else if (r.reason === 'bond_won') {
        const d = this.get(bondId);
        if (d?.status === 'locked') this.returnDeposit(bondId, 'bond_won');
      }
      // treasury + unmatched records are informational only at the ledger level
    }
  }

  private require(id: string): EscrowDeposit {
    const d = this.depositsByKey.get(id);
    if (!d) throw new Error(`EscrowLedger: unknown deposit ${id}`);
    return d;
  }
}
