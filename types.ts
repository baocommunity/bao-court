// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import type * as frost from '@vbyte/frost';

/**
 * Shared types for the BAO Court / FROST threshold-oracle appeal module.
 *
 * These types are consumed by both the bao.markets reference implementation
 * and the 2140wtf Nostr client. Optional fields allow each app to use only
 * the data it needs.
 */

export interface StakeCommitment {
  /** Amount the juror has actually locked for this dispute, in sats. */
  readonly amountSats: number;
  /** On-chain address / identifier where the bond is locked. */
  readonly bondAddress: string;
  /** Optional funding transaction id for the bond UTXO. */
  readonly bondTxid?: string;
  /** Optional output index for the bond UTXO. */
  readonly bondVout?: number;
  /** Optional expected scriptPubKey for the bond UTXO. */
  readonly scriptPubKey?: string;
  /** Unix seconds after which the bond may be reclaimed if not selected/used. */
  readonly deadlineSeconds?: number;
  /** Current lifecycle status of the commitment. */
  status: 'pending' | 'confirmed' | 'released' | 'slashed';
  /** When the commitment was first announced (unix seconds). */
  readonly committedAt?: number;
  /** When the commitment was released/slashed (unix seconds). */
  releasedAt?: number;
}

export interface JurorProfile {
  /** Public Nostr identity of the juror. */
  readonly nostrPubkey: string;
  /** Stake capacity in sats (used for selection weighting). */
  readonly stakeCapacitySats: number;
  /** Verifiable stake commitment for this specific dispute. */
  readonly stakeCommitment: StakeCommitment;
  /** Web-of-Trust score (0-100). */
  readonly wotScore: number;
  /** Categories this juror accepts. */
  readonly categories: readonly string[];
  /** Account registration timestamp (unix seconds). */
  readonly registeredAt: number;
}

export interface SelectedJuror extends JurorProfile {
  /** Index assigned for FROST polynomials (1-based). */
  readonly idx: number;
  /** VRF priority score; lower is better. */
  readonly priority: number;
}

export interface FrostAttestation {
  /** Market identifier. */
  readonly marketId: string;
  /** Winning outcome string. */
  readonly outcome: string;
  /** Canonical signing round bound into the signed message. */
  readonly round: number | string;
  /** BIP-340 Schnorr signature (R || z) in hex. */
  readonly signature: string;
  /** Public nonce R in hex. */
  readonly pubNonce: string;
  /** Aggregate public key P in hex (x-only). */
  readonly groupPubkey: string;
  /** Signed message digest in hex. */
  readonly message: string;
  /** Kind 89 (normal) or 39007 (dispute override). */
  readonly kind: 89 | 39007;
  /** Dispute event id if this is an override attestation. */
  readonly disputeEventId?: string;
  /**
   * Dispute verdict commitment ({@link hashDisputeVerdict}) bound into the
   * signed message of kind-39007 attestations. Certifies the TALLY that
   * produced the outcome, not just the outcome.
   */
  readonly verdictHash?: string;
  /** Supporting reveal event ids of the attested verdict (kind 39007). */
  readonly supportingEventIds?: readonly string[];
}

export interface DkgRecord {
  readonly marketId: string;
  /** Optional dispute id (2140wtf DKG is scoped to a dispute). */
  readonly disputeId?: string;
  readonly threshold: number;
  readonly participants: number;
  /** 33-byte compressed secp256k1 group public key (used by FROST internals). */
  readonly groupPubkey: string;
  /** 32-byte x-only group public key (used for BIP-340 attestations / Taproot). */
  readonly groupPubkeyXOnly: string;
  readonly verificationShares: readonly { idx: number; pubkey: string }[];
  readonly jurorPubkeys: readonly string[];
  /**
   * Feldman VSS commitments from each qualified participant.
   * Required for share verification, complaint adjudication, and audit.
   */
  readonly vssCommitments: readonly { idx: number; pubkey: string; commits: readonly string[] }[];
}

export interface DisputeCase {
  readonly disputeId: string;
  readonly marketId: string;
  /** Original market-resolution event id (2140wtf). */
  readonly marketEventId?: string;
  readonly challengerPubkey: string;
  readonly respondentPubkey: string;
  readonly evidenceHashes: readonly string[];
  readonly proposedOutcome: string;
  /** Original market outcome being challenged (2140wtf). */
  readonly originalOutcome?: string;
}

export interface AppealTimings {
  /** Seconds after market resolution during which a dispute may be filed. */
  readonly disputeWindowSeconds: number;
  /** Seconds for stake-backed jurors to opt in with a candidacy event. */
  readonly optInWindowSeconds: number;
  /**
   * Seconds allowed for the selection event to be published.
   *
   * NOTE: This is a protocol deadline, not a coordinator privilege. Any juror
   * or independent aggregator may publish the selection event; no single
   * coordinator should be required.
   */
  readonly selectionDeadlineSeconds: number;
  /** Seconds for selected jurors to complete the DKG ceremony. */
  readonly dkgWindowSeconds: number;
  /** Seconds for jurors to publish vote commits. */
  readonly voteCommitWindowSeconds: number;
  /** Seconds for jurors to publish vote reveals after commits. */
  readonly voteRevealWindowSeconds: number;
  /** Seconds for the FROST signing round (commit + reveal + aggregate). */
  readonly signingWindowSeconds: number;
  /** Seconds after attestation publication during which the winner may claim. */
  readonly claimWindowSeconds: number;
  /** Seconds after the opt-in window closes during which a failed selected jury may be reselected from backups. */
  readonly reselectionWindowSeconds: number;
  /** Minimum confirmations required on the Bitcoin block hash used as a seed. */
  readonly seedBlockConfirmations: number;
}

export type AppealPhase =
  | 'dispute'
  | 'opt-in'
  | 'selection'
  | 'dkg'
  | 'vote-commit'
  | 'vote-reveal'
  | 'signing'
  | 'claim'
  | 'refund'
  | 'attestation_published';

export interface JurorVote {
  readonly idx: number;
  readonly pubkey: string;
  readonly commit: string;
  readonly reveal?: {
    readonly outcome: string;
    readonly salt: string;
  };
}

/** Encrypted VSS share sent from one juror to another (kind 39003, wrapped in NIP-59). */
export interface EncryptedVssShare {
  readonly disputeId: string;
  readonly fromIdx: number;
  readonly fromPubkey: string;
  readonly toIdx: number;
  readonly toPubkey: string;
  /** Hex-encoded encrypted scalar share. */
  readonly encryptedShare: string;
  /** Nonce/public ephemeral key used for encryption, if required by the scheme. */
  readonly ephemeralPubkey?: string;
  /** Monotonic phase nonce to prevent replay across DKG rounds. */
  readonly phaseNonce: string;
}

/**
 * Public DKG complaint with a revealed share and proof (kind 38032).
 *
 * Possession binding (mandatory since the 2026-08-15 hardening): a complaint
 * is only valid when the COMPLAINER IS THE VICTIM — the party who actually
 * received (and failed to verify) the disputed share. Enforced structurally:
 * `parseDkgComplaintEvent` rejects any event whose signed author is not the
 * victim pubkey, and `IndependentDkgSession.addComplaint` re-checks the
 * author/roster binding plus (for local-victim complaints) that the accused
 * really delivered a share to this session. Without this binding, an attacker
 * could file complaints on behalf of any victim, force t public defenses that
 * each reveal one evaluation point of an honest juror's polynomial, and
 * reconstruct the group secret; forged complaints could also permanently
 * disqualify honest jurors. See `docs/COMPLAINT-PROTOCOL.md`.
 */
export interface DkgComplaint {
  readonly disputeId: string;
  readonly accusedIdx: number;
  readonly accusedPubkey: string;
  readonly victimIdx: number;
  /** Must equal the kind 38032 event author (the complainer). */
  readonly victimPubkey: string;
  /**
   * Event id of the kind 39003 encrypted-share event the victim received
   * from the accused — the possession anchor that makes the complaint
   * attributable. Required; a complaint without it is structurally invalid.
   */
  readonly encryptedShareEventId: string;
  /** The decrypted share that the victim received, which fails verification. */
  readonly revealedShare: string;
  /** Event id of the accused juror's kind 38031 commitment. */
  readonly commitmentEventId: string;
  /** Optional defense response from the accused. */
  readonly defense?: DkgComplaintDefense;
}

/** Accused juror's defense against a false complaint. */
export interface DkgComplaintDefense {
  /** Decryption key/nonce proving the original ciphertext decrypts to a valid share. */
  readonly decryptionProof: string;
  /** The valid plaintext share. */
  readonly validShare: string;
  readonly defendedAt: number;
}

/** Private local DKG verification failure. Never publish the decrypted share. */
export interface DkgVerificationFailure {
  readonly disputeId: string;
  readonly accusedIdx: number;
  readonly accusedPubkey: string;
  readonly victimIdx: number;
  readonly victimPubkey: string;
  readonly commitmentEventId: string;
  readonly reason: 'invalid_share';
}

/** Encrypted self-backup of a juror's final FROST share (kind 39100, wrapped in NIP-59). */
export interface EncryptedShareBackup {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly jurorPubkey: string;
  readonly encryptedShare: string;
  readonly groupPubkey: string;
  readonly verificationShares: readonly { idx: number; pubkey: string }[];
  readonly vssCommitments: readonly { idx: number; pubkey: string; commits: readonly string[] }[];
}

/** Public refresh commitment for a proactive share refresh round (kind 38033). */
export interface RefreshCommitment {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly jurorPubkey: string;
  readonly threshold: number;
  readonly vssCommits: readonly string[];
  readonly phaseNonce: string;
}

/** Encrypted refresh share sent from one juror to another (kind 39013, wrapped in NIP-59). */
export interface EncryptedRefreshShare {
  readonly disputeId: string;
  readonly fromIdx: number;
  readonly fromPubkey: string;
  readonly toIdx: number;
  readonly toPubkey: string;
  readonly encryptedShare: string;
  readonly phaseNonce: string;
}

/** State of a single juror's independent DKG session. */
export interface IndependentDkgState {
  readonly disputeId: string;
  readonly myIdx: number;
  readonly myPubkey: string;
  readonly threshold: number;
  readonly jurors: readonly SelectedJuror[];
  readonly commitments: Record<number, { pubkey: string; commits: string[]; eventId?: string; receivedAt: number }>;
  readonly encryptedShares: Record<number, EncryptedVssShare>;
  readonly decryptedShares: Record<number, string>;
  readonly complaints: DkgComplaint[];
  readonly disqualified: Set<number>;
  readonly groupPubkey: string | null;
  readonly groupPubkeyXOnly: string | null;
  readonly myShare: string | null;
  readonly phase: 'awaiting_commitments' | 'awaiting_shares' | 'complaint' | 'complete' | 'failed';
}

/** State of a single juror's independent signing session. */
export interface IndependentSigningState {
  readonly disputeId: string;
  readonly myIdx: number;
  readonly myPubkey: string;
  readonly threshold: number;
  readonly dkg: DkgRecord;
  readonly outcome: string;
  readonly message: string;
  readonly commitPhase: 'awaiting_commits' | 'complete' | 'failed';
  readonly revealPhase: 'awaiting_reveals' | 'complete' | 'failed';
  readonly commitments: Record<number, frost.CommitmentPackage>;
  readonly reveals: Record<number, { idx: number; pubkey: string; pnonce: frost.PublicNonce; psig: string }>;
  readonly attestation: FrostAttestation | null;
}

export interface JurorSessionState {
  readonly dispute: DisputeCase;
  /** Whether the current user is a selected juror in this dispute. */
  readonly isSelected: boolean;
  /** The current user's assigned juror index, if selected. */
  readonly myJurorIdx: number | null;
  readonly phase: AppealPhase;
  readonly selectedJurors: SelectedJuror[];
  readonly groupPubkey: string | null;
  readonly groupPubkeyXOnly: string | null;
  readonly myVoteCommit: string | null;
  readonly myVoteReveal: { outcome: string; salt: string } | null;
  readonly tally: { outcome: string; supportingVotes: JurorVote[] } | null;
  readonly attestation: FrostAttestation | null;
}
