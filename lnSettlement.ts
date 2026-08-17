// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Panel A — Lightning hold-invoice settlement protocol for BAO Court.
 *
 * ADR-001 Panel A: juror stakes are held as Lightning hold invoices. BAO
 * generates a deterministic preimage, creates the invoice, SETTLES for
 * coherent jurors (releases the preimage) and CANCELS for incoherent /
 * non-reveal / double-vote jurors (denial of reward + reputation — "social
 * slashing"). The challenger bond is settled on win, cancelled on loss.
 *
 * This module is PUBLIC protocol math: it contains no keys, no node access,
 * no credentials. Hosts implement {@link LnRail} privately (LNbits/CLN/LND
 * on BAO signet) and inject it. The module stays deterministic and
 * serializable so any observer can verify every step.
 *
 * Protocol kinds are HOST-OWNED (see ESCROW-SLASHING.md / the standing-oracle
 * kind reservation) — this module emits no network events itself, only JSON-
 * safe protocol records and audit-event templates via {@link buildLnAuditEvent}.
 *
 * @see docs/SETTLEMENT-RAILS-PLAN.md (status internal)
 * @see ADR-001 (docs/architecture/adr/001-juror-escrow-design.md in bao.markets)
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// ── Preimage / payment-hash derivation ───────────────────────────────────────

/** Domain tag keeps preimages distinct across use sites (stake, bond, refunds). */
export const LN_PREIMAGE_DOMAIN = 'BAO-Court/LnPreimage/v1';

export type LnRole = 'juror' | 'disputer';

/** Canonical witness that defines a single hold-invoice preimage. */
export interface LnPreimageWitness {
  readonly disputeId: string;
  readonly role: LnRole;
  /** Juror pubkey (or the disputer pubkey for a bond hold). */
  readonly pubkey: string;
  /** Outcome the holder voted for / the disputed outcome (for bonds). */
  readonly outcome: string;
  /** Attestation digest the court will sign (binds preimage to admission). */
  readonly attestationDigest: string;
  /** Round number (bonds double per appeal round). */
  readonly round: number;
}

/**
 * Deterministic 32-byte preimage for a hold invoice.
 *
 * The preimage is a pure function of the witness. The holder can only ever
 * claim it if the court actually signs the corresponding attestation digest;
 * `attestationDigest` is the FROST-signed digest (kind 39007 message), so a
 * preimage released without a valid attestation cannot unlock anything
 * downstream (host verifies the attestation before releasing).
 */
export function deriveLnPreimage(w: LnPreimageWitness): string {
  const payload = [
    LN_PREIMAGE_DOMAIN,
    w.disputeId,
    w.role,
    w.pubkey,
    w.outcome,
    w.attestationDigest,
    String(w.round),
  ].join('|');
  return bytesToHex(sha256(utf8ToBytes(payload)));
}

/** Payment hash = SHA-256 of the RAW preimage bytes (BOLT-11 semantics). */
export function paymentHash(preimageHex: string): string {
  return bytesToHex(sha256(hexToBytes(preimageHex)));
}

/** Convenience: derive the full (preimage, paymentHash) pair for a witness. */
export function deriveHoldInvoicePair(w: LnPreimageWitness): {
  readonly preimage: string;
  readonly paymentHash: string;
} {
  const preimage = deriveLnPreimage(w);
  return { preimage, paymentHash: paymentHash(preimage) };
}

// ── Hold-invoice lifecycle ───────────────────────────────────────────────────

export type LnHoldStatus =
  | 'offer'      // invoice created (or offer recorded), not yet held
  | 'held'       // payment pending (hold), awaiting settle/cancel/expire
  | 'settled'    // preimage released, payment claimed by the holder
  | 'cancelled'  // hold cancelled (incoherent/bond lost) — no preimage
  | 'expired'    // hold timed out — refund path, no preimage
  | 'failed';    // malformed construction / invalid transition target

export type LnDecision = 'settle' | 'cancel';

export interface LnHoldRecord {
  /** Stable id: witness-derived (disputeId|role|pubkey|round). */
  readonly id: string;
  readonly witness: LnPreimageWitness;
  readonly preimage: string;
  readonly paymentHash: string;
  readonly amountSats: number;
  readonly status: LnHoldStatus;
  /** Unix seconds when the hold expires (deadline for settle/cancel). */
  readonly expiresAt: number;
  /** Set when the invoice is actually held (payment pending). */
  readonly heldAt?: number;
  /** Set at the terminal transition. */
  readonly resolvedAt?: number;
  /** 'settle' / 'cancel' once decided. */
  readonly decision?: LnDecision;
  /** Optional rail-invoice id (host fills in after createHoldInvoice). */
  readonly invoiceId?: string;
}

export interface LnHoldConstruction {
  readonly disputeId: string;
  readonly role: LnRole;
  readonly pubkey: string;
  readonly outcome: string;
  readonly attestationDigest: string;
  readonly round: number;
  readonly amountSats: number;
  /** Hold deadline (unix seconds). */
  readonly expiresAt: number;
  /** Optional host-side invoice id. */
  readonly invoiceId?: string;
}

function witnessOf(c: LnHoldConstruction): LnPreimageWitness {
  return {
    disputeId: c.disputeId,
    role: c.role,
    pubkey: c.pubkey,
    outcome: c.outcome,
    attestationDigest: c.attestationDigest,
    round: c.round,
  };
}

/** Construct an offer record with its deterministic preimage/paymentHash. */
export function constructHoldOffer(c: LnHoldConstruction): LnHoldRecord {
  const witness = witnessOf(c);
  const { preimage, paymentHash: ph } = deriveHoldInvoicePair(witness);
  return {
    id: `${c.disputeId}|${c.role}|${c.pubkey}|${c.round}`,
    witness,
    preimage,
    paymentHash: ph,
    amountSats: c.amountSats,
    status: 'offer',
    expiresAt: c.expiresAt,
    invoiceId: c.invoiceId,
  };
}

// ── Deterministic ledger (serializable) ──────────────────────────────────────

export interface LnLedgerSnapshot {
  readonly holds: readonly LnHoldRecord[];
}

export class LnHoldLedger {
  private readonly byId = new Map<string, LnHoldRecord>();

  constructor(initial: readonly LnHoldRecord[] = []) {
    for (const h of initial) this.byId.set(h.id, h);
  }

  static fromSnapshot(s: LnLedgerSnapshot): LnHoldLedger {
    return new LnHoldLedger(s.holds);
  }

  snapshot(): LnLedgerSnapshot {
    return { holds: [...this.byId.values()] };
  }

  get(id: string): LnHoldRecord | undefined {
    return this.byId.get(id);
  }

  all(): LnHoldRecord[] {
    return [...this.byId.values()];
  }

  /** Record a new hold offer. Rejects duplicate ids. */
  offer(c: LnHoldConstruction): LnHoldRecord {
    const rec = constructHoldOffer(c);
    if (this.byId.has(rec.id)) {
      throw new Error(`LnHoldLedger: duplicate hold id ${rec.id}`);
    }
    this.byId.set(rec.id, rec);
    return rec;
  }

  /**
   * Mark the hold as held (host confirms payment pending).
   * Guards: only from `offer`; `now` must be before `expiresAt`.
   */
  hold(id: string, now = Date.now()): LnHoldRecord {
    const r = this.require(id);
    if (r.status !== 'offer') throw new Error(`LnHoldLedger: cannot hold ${r.status} ${id}`);
    if (now > r.expiresAt) throw new Error(`LnHoldLedger: hold ${id} already expired at ${r.expiresAt}`);
    const next: LnHoldRecord = { ...r, status: 'held', heldAt: now };
    this.byId.set(id, next);
    return next;
  }

  /** Decision path: settle (release preimage) or cancel. */
  decide(id: string, decision: LnDecision, now = Date.now()): LnHoldRecord {
    const r = this.require(id);
    if (r.status !== 'held') throw new Error(`LnHoldLedger: cannot decide ${r.status} ${id}`);
    if (now > r.expiresAt) throw new Error(`LnHoldLedger: hold ${id} expired; refund path, not ${decision}`);
    const status: LnHoldStatus = decision === 'settle' ? 'settled' : 'cancelled';
    const next: LnHoldRecord = { ...r, status, decision, resolvedAt: now };
    this.byId.set(id, next);
    return next;
  }

  /** Expire a held hold past its deadline (refund path). */
  expire(id: string, now = Date.now()): LnHoldRecord {
    const r = this.require(id);
    if (r.status !== 'held' && r.status !== 'offer') {
      throw new Error(`LnHoldLedger: cannot expire ${r.status} ${id}`);
    }
    const next: LnHoldRecord = { ...r, status: 'expired', resolvedAt: now };
    this.byId.set(id, next);
    return next;
  }

  private require(id: string): LnHoldRecord {
    const r = this.byId.get(id);
    if (!r) throw new Error(`LnHoldLedger: unknown hold ${id}`);
    return r;
  }
}

// ── Settle/cancel decision mapping from the redistribution plan ─────────────

import type { StakeRedistribution, RedistributionPlan } from './escrow';

export interface LnDecisionPlan {
  /** id → decision, for every record found in the redistribution plan. */
  readonly decisions: Record<string, LnDecision>;
  /** Holds not mentioned in the plan (e.g. unselected pledger refunds). */
  readonly unsettled: readonly string[];
}

/**
 * Map a court RedistributionPlan to hold-invoice decisions:
 * - coherent / bond_won          → settle (release preimage)
 * - incoherent / non_reveal /
 *   double_vote / bond_lost      → cancel
 * - treasury                     → no hold (informational)
 * - default                      → leave unsettled (host refunds unselected)
 *
 * Returns `unsettled` ids when a hold exists but the plan does not mention
 * it — the host uses this to run the reclaim path for unselected pledgers.
 */
export function planDecisionsForHolds(
  plan: RedistributionPlan,
  holds: readonly LnHoldRecord[],
): LnDecisionPlan {
  const decisions: Record<string, LnDecision> = {};
  const unsettled: string[] = [];

  // Index plan records by participant pubkey + role.
  const byPubkey = new Map<string, StakeRedistribution>();
  for (const r of plan.redistributions) byPubkey.set(r.pubkey, r);

  for (const h of holds) {
    const rec = byPubkey.get(h.witness.pubkey);
    if (!rec) {
      // Bond holds: disputer pubkey appears under bond_won/bond_lost.
      if (h.witness.role === 'disputer') {
        decisions[h.id] = plan.bondOutcome === 'returned' ? 'settle' : 'cancel';
        continue;
      }
      unsettled.push(h.id);
      continue;
    }
    switch (rec.reason) {
      case 'coherent':
      case 'bond_won':
        decisions[h.id] = 'settle';
        break;
      case 'incoherent':
      case 'non_reveal':
      case 'double_vote':
      case 'bond_lost':
        decisions[h.id] = 'cancel';
        break;
      default:
        unsettled.push(h.id);
    }
  }

  // Holds for juror stakes whose pubkey appears in the plan but with a
  // reason we might have missed are already covered above; recompute the
  // unsettled for any hold not yet keyed.
  for (const h of holds) {
    if (decisions[h.id] === undefined && !unsettled.includes(h.id)) {
      unsettled.push(h.id);
    }
  }

  return { decisions, unsettled };
}

// ── Audit event templates (host-owned kinds) ────────────────────────────────

export interface LnAuditEventTemplate {
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
}

export const LN_AUDIT_DOMAIN = 'BAO-Court/LnAudit/v1';

/**
 * Build a JSON-safe audit event template for a hold transition. The host
 * finalizes with its own kind/channel; `kind` is a parameter since the
 * package is host-agnostic (the standing-oracle plan reserves 38035–38038,
 * so hosts pick e.g. 39110+ for LN audit).
 */
export function buildLnAuditEvent(
  kind: number,
  hold: LnHoldRecord,
  extra?: Record<string, unknown>,
): LnAuditEventTemplate {
  return {
    kind,
    tags: [
      ['d', LN_AUDIT_DOMAIN],
      ['e', hold.witness.disputeId, '', 'root'],
      ['p', hold.witness.pubkey],
      ['status', hold.status],
      ['payment_hash', hold.paymentHash],
      ...(hold.decision ? [['decision', hold.decision]] : []),
      ...(hold.invoiceId ? [['invoice', hold.invoiceId]] : []),
    ],
    content: JSON.stringify({
      domain: LN_AUDIT_DOMAIN,
      disputeId: hold.witness.disputeId,
      role: hold.witness.role,
      pubkey: hold.witness.pubkey,
      status: hold.status,
      paymentHash: hold.paymentHash,
      decision: hold.decision ?? null,
      expiresAt: hold.expiresAt,
      resolvedAt: hold.resolvedAt ?? null,
      amountSats: hold.amountSats,
      ...extra,
    }),
  };
}
