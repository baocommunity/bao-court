// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Independent-juror FROST signing session.
 *
 * Each juror runs this class locally. It collects public nonce commitments,
 * produces the juror's own partial signature, and (optionally) aggregates
 * threshold partial signatures into the final attestation.
 */

import * as frost from '@vbyte/frost';
import { buildAttestationMessage } from './crypto';
import {
  buildFrostCommitEvent,
  buildFrostRevealEvent,
  buildAttestationEvent,
} from './events';
import type { DkgRecord, FrostAttestation } from './types';
import {
  createCommitment,
  createRevealAndPartialSig,
  aggregateAttestation,
  createDefaultNonceGuard,
  type NonceGuard,
  type SigningCommitment,
  type SigningReveal,
} from './signing';

export interface IndependentSigningOptions {
  readonly disputeId: string;
  readonly myIdx: number;
  readonly myPubkey: string;
  readonly dkg: DkgRecord;
  readonly outcome: string;
  readonly round?: number | string;
  readonly disputeEventId?: string;
  /**
   * Dispute verdict commitment bound into the signed message (kind-39007
   * attestations) — see {@link buildAttestationMessage}.
   */
  readonly verdictHash?: string;
  /**
   * Optional persistent nonce-use guard. If omitted, an in-memory guard is
   * used, which prevents nonce reuse for the lifetime of this session.
   */
  readonly nonceGuard?: NonceGuard;
  /**
   * Optional snapshot of a previously collected signing-round state. The
   * snapshot is validated: its message must match the message derived from
   * this session's parameters, and reveals are only restored when a matching
   * commitment is present.
   */
  readonly snapshot?: IndependentSigningSnapshot;
}

/** Plain JSON-serializable snapshot of collected signing-round state. */
export interface IndependentSigningSnapshot {
  readonly version: number;
  readonly message: string;
  readonly commitments: readonly SigningSnapshotCommitment[];
  readonly reveals: readonly SigningSnapshotReveal[];
}

export interface SigningSnapshotCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly binder_pn: string;
  readonly hidden_pn: string;
}

export interface SigningSnapshotReveal {
  readonly idx: number;
  readonly pubkey: string;
  readonly binder_pn: string;
  readonly hidden_pn: string;
  readonly psig: string;
}

interface StoredCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly binder_pn: string;
  readonly hidden_pn: string;
  readonly commit: frost.CommitmentPackage;
}

interface ParsedReveal {
  readonly idx: number;
  readonly pubkey: string;
  readonly binder_pn: string;
  readonly hidden_pn: string;
  readonly psig: string;
}

export class IndependentSigningSession {
  readonly disputeId: string;
  readonly myIdx: number;
  readonly myPubkey: string;
  readonly dkg: DkgRecord;
  readonly outcome: string;
  readonly round: number | string;
  readonly disputeEventId?: string;
  readonly message: string;

  private readonly commitments = new Map<number, StoredCommitment>();
  private readonly reveals = new Map<number, ParsedReveal>();
  private readonly nonceGuard: NonceGuard;

  constructor(options: IndependentSigningOptions) {
    this.disputeId = options.disputeId;
    this.myIdx = options.myIdx;
    this.myPubkey = options.myPubkey;
    this.dkg = options.dkg;
    this.outcome = options.outcome;
    this.round = options.round ?? 1;
    this.disputeEventId = options.disputeEventId;
    this.message = buildAttestationMessage(
      this.dkg.marketId,
      this.outcome,
      this.round,
      this.disputeEventId,
      options.verdictHash,
    );
    this.nonceGuard = options.nonceGuard ?? createDefaultNonceGuard(`bao-frost-used-nonces|${this.disputeId}`);

    if (options.snapshot) {
      this.applySnapshot(options.snapshot);
    }
  }

  private applySnapshot(snapshot: IndependentSigningSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error(
        `Unsupported signing snapshot version: ${snapshot.version}`,
      );
    }
    if (snapshot.message !== this.message) {
      throw new Error(
        'Signing snapshot message does not match this session; possible stale or wrong-round data',
      );
    }

    // Restore commitments, deduplicating by juror index.
    for (const c of snapshot.commitments) {
      this.commitments.set(c.idx, {
        idx: c.idx,
        pubkey: c.pubkey,
        binder_pn: c.binder_pn,
        hidden_pn: c.hidden_pn,
        commit: {
          idx: c.idx,
          binder_pn: c.binder_pn,
          hidden_pn: c.hidden_pn,
        } as frost.CommitmentPackage,
      });
    }

    // Only restore reveals when the matching commitment is present.
    for (const r of snapshot.reveals) {
      if (!this.commitments.has(r.idx)) continue;
      this.reveals.set(r.idx, {
        idx: r.idx,
        pubkey: r.pubkey,
        binder_pn: r.binder_pn,
        hidden_pn: r.hidden_pn,
        psig: r.psig,
      });
    }
  }

  /**
   * Export the session's collected commitments and reveals to a plain
   * JSON-serializable snapshot. This allows a new session for the same signing
   * round to resume aggregation without re-collecting events.
   */
  toSnapshot(): IndependentSigningSnapshot {
    return {
      version: 1,
      message: this.message,
      commitments: Array.from(this.commitments.values()).map((c) => ({
        idx: c.idx,
        pubkey: c.pubkey,
        binder_pn: c.binder_pn,
        hidden_pn: c.hidden_pn,
      })),
      reveals: Array.from(this.reveals.values()).map((r) => ({
        idx: r.idx,
        pubkey: r.pubkey,
        binder_pn: r.binder_pn,
        hidden_pn: r.hidden_pn,
        psig: r.psig,
      })),
    };
  }

  /**
   * Add a peer's FROST nonce commitment.
   */
  addCommitment(payload: {
    readonly idx: number;
    readonly pubkey: string;
    readonly commitmentPackage: {
      idx: number;
      binder_pn: string;
      hidden_pn: string;
    };
  }): boolean {
    if (payload.idx === this.myIdx) return false;
    // Only accept commitments from DKG participants, bound to the
    // participant's registered nostr pubkey so an attacker cannot front-run
    // an honest juror's commitment under their idx.
    if (!this.dkg.verificationShares.some((v) => v.idx === payload.idx)) return false;
    const vss = this.dkg.vssCommitments.find((c) => c.idx === payload.idx);
    if (vss && payload.pubkey !== vss.pubkey) return false;
    if (!payload.commitmentPackage.binder_pn || !payload.commitmentPackage.hidden_pn) return false;
    try {
      const existing = this.commitments.get(payload.idx);
      if (existing) {
        // Nonce equivocation: a juror may publish exactly ONE commitment per
        // signing attempt (courtSigningMachine aborts on the same conflict).
        // Silently overwriting would let a peer switch nonces mid-round and
        // invalidate the other jurors' binding factors. Identical duplicates
        // (relay redelivery) are idempotent.
        if (
          existing.binder_pn !== payload.commitmentPackage.binder_pn ||
          existing.hidden_pn !== payload.commitmentPackage.hidden_pn ||
          existing.pubkey !== payload.pubkey
        ) {
          return false;
        }
        return true;
      }
      // Peer commitment events only carry the public nonce fields.
      // @vbyte/frost's CommitmentPackage type also includes secret nonce fields,
      // but aggregation only reads the public fields.
      const commit = {
        idx: payload.idx,
        binder_pn: payload.commitmentPackage.binder_pn,
        hidden_pn: payload.commitmentPackage.hidden_pn,
      } as frost.CommitmentPackage;
      this.commitments.set(payload.idx, {
        idx: payload.idx,
        pubkey: payload.pubkey,
        binder_pn: payload.commitmentPackage.binder_pn,
        hidden_pn: payload.commitmentPackage.hidden_pn,
        commit,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create this juror's FROST nonce commitment and the corresponding event.
   */
  createMyCommitment(share: frost.SecretShare): {
    commitment: SigningCommitment;
    event: ReturnType<typeof buildFrostCommitEvent>;
  } {
    const signingCommitment = createCommitment(share);
    const pkg = signingCommitment.commit;
    const event = buildFrostCommitEvent({
      disputeId: this.disputeId,
      jurorIdx: this.myIdx,
      commitmentPackage: {
        idx: pkg.idx,
        binder_pn: pkg.binder_pn,
        hidden_pn: pkg.hidden_pn,
      },
    });
    // Store the full commitment package (with secret nonces) for ourselves.
    this.commitments.set(this.myIdx, {
      idx: this.myIdx,
      pubkey: this.myPubkey,
      binder_pn: pkg.binder_pn,
      hidden_pn: pkg.hidden_pn,
      commit: pkg,
    });
    return { commitment: signingCommitment, event };
  }

  /**
   * True once enough commitments have been collected to reveal.
   */
  hasEnoughCommitments(): boolean {
    const qualified = this.dkg.verificationShares.map((v) => v.idx);
    return qualified.every((idx) => this.commitments.has(idx));
  }

  /**
   * Create this juror's partial signature reveal and the corresponding event.
   */
  createMyReveal(share: frost.SecretShare): {
    reveal: SigningReveal;
    event: ReturnType<typeof buildFrostRevealEvent>;
  } {
    if (!this.hasEnoughCommitments()) {
      throw new Error('Cannot reveal: missing peer commitments');
    }

    const signingCommitments = Array.from(this.commitments.values()).map((c) =>
      this.toSigningCommitment(c),
    );

    const reveal = createRevealAndPartialSig(
      {
        marketId: this.dkg.marketId,
        outcome: this.outcome,
        round: this.round,
        disputeEventId: this.disputeEventId,
        dkg: this.dkg,
        shares: [share],
        nonceGuard: this.nonceGuard,
      },
      signingCommitments,
      share,
    );

    const event = buildFrostRevealEvent({
      disputeId: this.disputeId,
      jurorIdx: this.myIdx,
      publicNonce: {
        idx: (reveal.pnonce as frost.PublicNonce).idx,
        binder_pn: (reveal.pnonce as frost.PublicNonce).binder_pn,
        hidden_pn: (reveal.pnonce as frost.PublicNonce).hidden_pn,
      },
      partialSig: reveal.psig,
      frostPubkey: reveal.pubkey,
    });

    this.reveals.set(this.myIdx, {
      idx: this.myIdx,
      pubkey: reveal.pubkey,
      binder_pn: reveal.pnonce.binder_pn,
      hidden_pn: reveal.pnonce.hidden_pn,
      psig: reveal.psig,
    });

    return { reveal, event };
  }

  /**
   * Add a peer's partial signature reveal.
   */
  addReveal(payload: {
    readonly idx: number;
    readonly pubkey: string;
    readonly publicNonce: {
      idx: number;
      binder_pn: string;
      hidden_pn: string;
    };
    readonly partialSig: string;
  }): boolean {
    if (payload.idx === this.myIdx) return false;
    // Only accept reveals from DKG participants.
    if (!this.dkg.verificationShares.some((v) => v.idx === payload.idx)) return false;
    if (!payload.partialSig || !payload.pubkey) return false;
    const stored = this.commitments.get(payload.idx);
    if (!stored) return false;
    // The reveal MUST match the juror's committed nonce — a reveal for a
    // different (or swapped) nonce would otherwise be stored under the
    // commitment and poison the binding factors at aggregation.
    if (
      payload.publicNonce.binder_pn !== stored.binder_pn ||
      payload.publicNonce.hidden_pn !== stored.hidden_pn
    ) {
      return false;
    }
    const existingReveal = this.reveals.get(payload.idx);
    if (existingReveal) {
      // First reveal wins; reject conflicting duplicates.
      return existingReveal.psig === payload.partialSig && existingReveal.pubkey === payload.pubkey;
    }
    // The reveal MUST carry the compressed FROST verification pubkey used to
    // produce the partial signature. X-only pubkeys from the DKG record cannot
    // be used because they lose the y-parity information required by the
    // FROST verification equation.
    this.reveals.set(payload.idx, {
      idx: payload.idx,
      pubkey: payload.pubkey,
      binder_pn: payload.publicNonce.binder_pn,
      hidden_pn: payload.publicNonce.hidden_pn,
      psig: payload.partialSig,
    });
    return true;
  }

  private toSigningCommitment(c: StoredCommitment): SigningCommitment {
    return {
      idx: c.idx,
      pubkey: c.pubkey,
      commit: c.commit,
    };
  }

  /**
   * True once threshold reveals have been collected.
   */
  canAggregate(): boolean {
    return this.reveals.size >= this.dkg.threshold;
  }

  /**
   * Aggregate collected partial signatures into the final attestation.
   *
   * @param marketEventId Unused (kept for API compatibility). The attestation
   *   references the market via `dkg.marketId`; pass the market event id to
   *   {@link buildAttestationEvent} instead when publishing.
   */
  aggregate(marketEventId?: string): FrostAttestation {
    void marketEventId;
    if (!this.canAggregate()) {
      throw new Error(
        `Cannot aggregate: ${this.reveals.size} reveals, threshold ${this.dkg.threshold}`,
      );
    }

    const signingCommitments = Array.from(this.commitments.values()).map((c) =>
      this.toSigningCommitment(c),
    );

    const reveals = Array.from(this.reveals.values()).map((r) => ({
      idx: r.idx,
      pubkey: r.pubkey,
      pnonce: {
        idx: r.idx,
        binder_pn: r.binder_pn,
        hidden_pn: r.hidden_pn,
      } as frost.PublicNonce,
      psig: r.psig,
    }));

    return aggregateAttestation(
      {
        marketId: this.dkg.marketId,
        outcome: this.outcome,
        round: this.round,
        disputeEventId: this.disputeEventId,
        dkg: this.dkg,
        shares: [], // not needed for aggregation
      },
      signingCommitments,
      reveals,
    );
  }

  /**
   * Build the public kind 39007 attestation event from an aggregated attestation.
   */
  buildAttestationEvent(
    attestation: FrostAttestation,
    marketEventId: string,
  ): ReturnType<typeof buildAttestationEvent> {
    return buildAttestationEvent({ attestation, marketEventId });
  }
}
