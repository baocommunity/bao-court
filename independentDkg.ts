// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Independent-juror Pedersen DKG session.
 *
 * Each juror runs this class locally. It produces the juror's own polynomial
 * commitments and encrypted shares, collects peer commitments/shares, verifies
 * them, handles complaints, and computes the final group public key and the
 * juror's FROST secret share.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as frost from '@vbyte/frost';
import { randomScalar, scalarToHex, createProofOfKnowledge, verifyProofOfKnowledge } from './crypto';
import { buildDkgCommitmentEvent } from './events';
import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
import {
  buildEncryptedRefreshShareEvent,
  buildEncryptedShareEvent,
  buildRefreshCommitmentEvent,
  buildShareBackupEvent,
} from './dkgMessages';
import type {
  DkgComplaint,
  DkgRecord,
  DkgVerificationFailure,
  EncryptedRefreshShare,
  EncryptedShareBackup,
  EncryptedVssShare,
  RefreshCommitment,
  SelectedJuror,
} from './types';
import {
  evaluateCommitments,
  evaluatePoly,
  generateRefreshShares,
  mergeRefreshCommitments,
  modN,
  pointToXOnlyHex,
  verifyRefreshShare,
  verifyVssShare,
} from './dkg';

const Point = secp256k1.Point;
type CurvePoint = InstanceType<typeof Point>;

interface LocalPolynomial {
  readonly coeffs: bigint[];
  readonly commitments: CurvePoint[];
  readonly commitmentHexes: string[];
  readonly pok: ReturnType<typeof createProofOfKnowledge>;
}

interface PeerCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly threshold: number;
  readonly commits: CurvePoint[];
  readonly commitHexes: readonly string[];
  readonly pok: { nonce: string; response: string };
  readonly phaseNonce: string;
  readonly eventId?: string;
  readonly receivedAt: number;
}

interface PeerRefreshCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly threshold: number;
  readonly commits: CurvePoint[];
  readonly commitHexes: readonly string[];
  readonly phaseNonce: string;
  readonly eventId?: string;
  readonly receivedAt: number;
}

interface LocalRefreshPackage {
  readonly shares: frost.SecretShare[];
  readonly commits: CurvePoint[];
  readonly commitHexes: readonly string[];
}

export interface IndependentDkgOptions {
  readonly disputeId: string;
  readonly marketId?: string;
  readonly myIdx: number;
  readonly myPubkey: string;
  /** Nostr private key as 32-byte hex string or Uint8Array. */
  readonly mySeckey?: string | Uint8Array;
  /** External NIP-44 crypto provider (e.g. browser extension or NIP-46 bunker). */
  readonly nip44?: Nip44Crypto;
  readonly threshold: number;
  readonly jurors: readonly SelectedJuror[];
}

export class IndependentDkgSession {
  readonly disputeId: string;
  readonly marketId: string;
  readonly myIdx: number;
  readonly myPubkey: string;
  readonly threshold: number;
  readonly jurors: readonly SelectedJuror[];

  private readonly nip44: Nip44Crypto;
  private localPoly: LocalPolynomial | null = null;
  private readonly commitments = new Map<number, PeerCommitment>();
  private readonly encryptedShares = new Map<number, EncryptedVssShare>();
  private readonly decryptedShares = new Map<number, string>();
  /** Expected phase nonce for each peer, learned from their commitment event. */
  private readonly phaseNonces = new Map<number, string>();
  private readonly complaints: DkgComplaint[] = [];
  /** Resolution status per admitted complaint key `${victimIdx}:${accusedIdx}`. */
  private readonly complaintResolution = new Map<string, 'pending' | 'false' | 'upheld' | 'void'>();
  /** Complaints whose own evidence exonerated the accused — slashing evidence (2026-08-15). */
  private readonly falseComplaints: DkgComplaint[] = [];
  private readonly disqualified = new Set<number>();
  /** Private blame evidence; the decrypted share is never stored or published. */
  private readonly verificationFailures: DkgVerificationFailure[] = [];
  private computedGroupKey: { compressed: string; xOnly: string } | null = null;
  private computedShare: frost.SecretShare | null = null;
  private computedRecord: DkgRecord | null = null;

  private refreshLocalPkg: LocalRefreshPackage | null = null;
  private readonly refreshCommitments = new Map<number, PeerRefreshCommitment>();
  private readonly refreshPhaseNonces = new Map<number, string>();
  private readonly encryptedRefreshShares = new Map<number, EncryptedRefreshShare>();
  private readonly decryptedRefreshShares = new Map<number, string>();

  constructor(options: IndependentDkgOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 2) {
      throw new Error('Threshold must be an integer of at least 2');
    }
    if (options.jurors.length < options.threshold) {
      throw new Error('Participants cannot be less than threshold');
    }
    const indices = new Set(options.jurors.map((j) => j.idx));
    if (indices.size !== options.jurors.length) {
      throw new Error('Duplicate juror indices');
    }
    if (options.jurors.some((j) => !Number.isInteger(j.idx) || j.idx < 1)) {
      throw new Error('Juror indices must be positive integers');
    }
    if (!indices.has(options.myIdx)) {
      throw new Error('myIdx must be one of the juror indices');
    }

    this.disputeId = options.disputeId;
    this.marketId = options.marketId ?? '';
    this.myIdx = options.myIdx;
    this.myPubkey = options.myPubkey;
    this.threshold = options.threshold;
    this.jurors = options.jurors;

    const hasSeckey = options.mySeckey !== undefined;
    const hasNip44 = options.nip44 !== undefined;
    if (hasSeckey === hasNip44) {
      throw new Error('Provide exactly one of mySeckey or nip44');
    }
    this.nip44 = options.nip44 ?? new Nip44SeckeyCrypto(options.mySeckey!);
  }

  private get domain(): string {
    return `market=${this.marketId}|dispute=${this.disputeId}|juror=${this.myIdx}`;
  }

  private proofDomain(idx: number): string {
    return `market=${this.marketId}|dispute=${this.disputeId}|juror=${idx}`;
  }

  private getJuror(idx: number): SelectedJuror | undefined {
    return this.jurors.find((j) => j.idx === idx);
  }

  /**
   * Generate this juror's local polynomial and produce:
   *  - the public DKG commitment event (kind 38031)
   *  - encrypted share events (kind 39003) for every peer juror
   */
  async generateCommitmentAndShares(): Promise<{
    commitmentEvent: ReturnType<typeof buildDkgCommitmentEvent>;
    shareEvents: ReturnType<typeof buildEncryptedShareEvent>[];
  }> {
    const coeffs = Array.from({ length: this.threshold }, () => randomScalar());
    const commitments = coeffs.map((a) => Point.BASE.multiply(a));
    const commitmentHexes = commitments.map((c) => c.toHex(true));
    const pok = createProofOfKnowledge(
      scalarToHex(coeffs[0]),
      commitments[0].toHex(true),
      this.domain,
    );
    this.localPoly = { coeffs, commitments, commitmentHexes, pok };

    const phaseNonce = crypto.randomUUID ? crypto.randomUUID() : scalarToHex(randomScalar());
    const commitmentEvent = buildDkgCommitmentEvent({
      disputeId: this.disputeId,
      jurorIdx: this.myIdx,
      jurorPubkey: this.myPubkey,
      threshold: this.threshold,
      vssCommits: commitmentHexes,
      pok,
      phaseNonce,
    });

    const shareEvents: ReturnType<typeof buildEncryptedShareEvent>[] = [];
    for (const j of this.jurors) {
      if (j.idx === this.myIdx) continue;
      const share = evaluatePoly(coeffs, BigInt(j.idx));
      const shareHex = scalarToHex(share);
      const encryptedShare = await this.nip44.encrypt(shareHex, j.nostrPubkey);
      const payload: EncryptedVssShare = {
        disputeId: this.disputeId,
        fromIdx: this.myIdx,
        fromPubkey: this.myPubkey,
        toIdx: j.idx,
        toPubkey: j.nostrPubkey,
        encryptedShare,
        phaseNonce,
      };
      shareEvents.push(buildEncryptedShareEvent(payload));
    }

    return { commitmentEvent, shareEvents };
  }

  /**
   * Add a peer's public DKG commitment event.
   */
  addCommitment(event: {
    readonly idx: number;
    readonly pubkey: string;
    readonly threshold: number;
    readonly vssCommits: readonly string[];
    readonly pok: { nonce: string; response: string };
    readonly phaseNonce: string;
    readonly eventId?: string;
  }): boolean {
    if (this.disqualified.has(event.idx)) return false;
    if (event.threshold !== this.threshold) return false;
    if (event.vssCommits.length !== this.threshold) return false;
    // Bind the commitment to the certified roster: the index must be a
    // selected juror and the event must come from that juror's registered
    // pubkey. Without this, anyone can publish a valid commitment under an
    // honest juror's index and poison the attempt via a phase-nonce
    // mismatch.
    const juror = this.getJuror(event.idx);
    if (!juror) return false;
    if (event.pubkey !== juror.nostrPubkey) return false;
    try {
      const commits = event.vssCommits.map((c) => Point.fromHex(c));
      if (commits.length === 0) return false;
      if (!verifyProofOfKnowledge(commits[0].toHex(true), event.pok, this.proofDomain(event.idx))) {
        return false;
      }
      const existing = this.commitments.get(event.idx);
      if (existing) {
        const same =
          existing.pubkey === event.pubkey &&
          existing.phaseNonce === event.phaseNonce &&
          existing.commitHexes.join(',') === event.vssCommits.join(',');
        if (same) return true; // Idempotent re-delivery of the same event.
        // Conflicting commitment for the same index: equivocation. This
        // aborts the attempt (fail-closed), it never silently overwrites.
        this.disqualified.add(event.idx);
        this.commitments.delete(event.idx);
        this.phaseNonces.delete(event.idx);
        return false;
      }
      this.commitments.set(event.idx, {
        idx: event.idx,
        pubkey: event.pubkey,
        threshold: event.threshold,
        commits,
        commitHexes: event.vssCommits,
        pok: event.pok,
        phaseNonce: event.phaseNonce,
        eventId: event.eventId,
        receivedAt: Math.floor(Date.now() / 1000),
      });
      this.phaseNonces.set(event.idx, event.phaseNonce);
      // If a share already arrived with a mismatched phase nonce, the sender is
      // replaying or inconsistent; disqualify them.
      const existingShare = this.encryptedShares.get(event.idx);
      if (existingShare && existingShare.phaseNonce !== event.phaseNonce) {
        this.disqualified.add(event.idx);
        this.encryptedShares.delete(event.idx);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add an encrypted share addressed to this juror.
   */
  addEncryptedShare(payload: EncryptedVssShare): boolean {
    if (payload.toIdx !== this.myIdx) return false;
    if (payload.disputeId !== this.disputeId) return false;
    // Bind the claimed sender to the certified roster; a forged share with a
    // bogus phase nonce can otherwise disqualify an honest juror.
    const fromJuror = this.getJuror(payload.fromIdx);
    if (!fromJuror) return false;
    if (payload.fromPubkey && payload.fromPubkey !== fromJuror.nostrPubkey) return false;
    const expected = this.phaseNonces.get(payload.fromIdx);
    if (expected !== undefined && payload.phaseNonce !== expected) {
      // Replay or wrong DKG round.
      this.disqualified.add(payload.fromIdx);
      return false;
    }
    this.encryptedShares.set(payload.fromIdx, payload);
    return true;
  }

  /**
   * Decrypt all received shares using the configured NIP-44 crypto provider.
   */
  async decryptShares(): Promise<void> {
    for (const [fromIdx, payload] of this.encryptedShares) {
      if (this.decryptedShares.has(fromIdx)) continue;
      const fromJuror = this.getJuror(fromIdx);
      if (!fromJuror) continue;
      try {
        const shareHex = await this.nip44.decrypt(payload.encryptedShare, fromJuror.nostrPubkey);
        this.decryptedShares.set(fromIdx, shareHex);
      } catch {
        // Decryption failed; leave absent so it can become a complaint.
      }
    }
  }

  /**
   * Verify all decrypted shares against peer commitments.
   *
   * A failed verification is attributable invalid data: the accused peer is
   * disqualified, which aborts this DKG attempt (the roster never shrinks;
   * Court starts a new attempt instead). Returns private failure records for
   * the local juror and the bond backend — the decrypted share is NEVER
   * included and must never be published as blame proof.
   */
  verifyShares(commitmentEventIds: Record<number, string>): DkgVerificationFailure[] {
    const newFailures: DkgVerificationFailure[] = [];

    for (const [fromIdx, shareHex] of this.decryptedShares) {
      if (this.disqualified.has(fromIdx)) continue;
      const peer = this.commitments.get(fromIdx);
      if (!peer) continue;
      const valid = verifyVssShare(this.myIdx, shareHex, peer.commitHexes);
      if (!valid) {
        this.disqualified.add(fromIdx);
        newFailures.push({
          disputeId: this.disputeId,
          accusedIdx: fromIdx,
          accusedPubkey: peer.pubkey,
          victimIdx: this.myIdx,
          victimPubkey: this.myPubkey,
          commitmentEventId: commitmentEventIds[fromIdx] ?? '',
          reason: 'invalid_share',
        });
      }
    }

    this.verificationFailures.push(...newFailures);
    return newFailures;
  }

  /**
   * Register a public complaint with full attribution gating (2026-08-15
   * hardening — see docs/COMPLAINT-PROTOCOL.md).
   *
   * Returns false (complaint not admitted) unless ALL of:
   *   - the dispute id matches;
   *   - victim and accused are distinct certified roster members and the
   *     carried pubkeys match the roster entries;
   *   - the possession anchor (kind 39003 share event id, 64-hex) is present;
   *   - the complaint is not a duplicate of an already-admitted complaint for
   *     the same (victim, accused) pair (first wins);
   *   - the complainer (victim) is not already disqualified (a disqualified
   *     complainer's complaint is void), and the per-roster complaint budget
   *     is not exhausted (spam bound);
   *   - when this session IS the victim, the accused actually delivered an
   *     encrypted share to this session (local possession proof).
   *
   * Complaints from anyone other than the victim cannot enter arbitration at
   * all: the kind 38032 event boundary (`parseDkgComplaintEvent`) requires the
   * signed author to be the victim pubkey, and this gate re-checks the roster
   * claim. Callers MUST dispatch only signature-verified events into this
   * method (same boundary contract as every other Court reducer); a complaint
   * object for a victim other than this session that has not been verified at
   * the event boundary is indistinguishable from a forge and is rejected by
   * hosts that follow the documented pipeline.
   */
  addComplaint(complaint: DkgComplaint): boolean {
    if (!complaint) return false;
    if (complaint.disputeId !== this.disputeId) return false;
    // A disqualified COMPLAINER's complaint is void; the accused being already
    // disqualified does not block the complaint record (in the genuine flow the
    // local victim disqualifies the accused in verifyShares BEFORE filing the
    // public complaint that lets every other session converge).
    if (this.disqualified.has(complaint.victimIdx)) {
      return false;
    }
    if (!Number.isInteger(complaint.victimIdx) || !Number.isInteger(complaint.accusedIdx)) {
      return false;
    }
    if (complaint.victimIdx === complaint.accusedIdx) return false;
    if (!/^[0-9a-f]{64}$/.test(complaint.encryptedShareEventId)) return false;
    if (typeof complaint.revealedShare !== 'string' || !complaint.revealedShare) return false;
    const victim = this.getJuror(complaint.victimIdx);
    if (!victim) return false;
    const accused = this.getJuror(complaint.accusedIdx);
    if (!accused) return false;
    if (victim.nostrPubkey !== complaint.victimPubkey) return false;
    if (accused.nostrPubkey !== complaint.accusedPubkey) return false;

    // Local possession proof: when this session is the victim, the accused
    // must have actually delivered an encrypted share to this session.
    if (complaint.victimIdx === this.myIdx && !this.encryptedShares.has(complaint.accusedIdx)) {
      return false;
    }

    const key = `${complaint.victimIdx}:${complaint.accusedIdx}`;
    if (this.complaintResolution.has(key)) return false; // first complaint wins
    // Spam bound: at most one directed complaint per roster pair.
    const budget = Math.max(this.jurors.length * (this.jurors.length - 1), 8);
    if (this.complaints.length >= budget) return false;

    this.complaints.push(complaint);
    this.complaintResolution.set(key, 'pending');
    return true;
  }

  /**
   * Resolve admitted complaints. Each (victim, accused) pair settles exactly
   * once:
   *
   *   - defense verifies against the accused's commitments: the complaint is
   *     FALSE — the accused is NOT disqualified and the complaint is exposed
   *     via {@link getFalseComplaints} as slashing evidence against the
   *     complainer;
   *   - defense present but does not verify: the accused published a bogus
   *     defense — disqualified;
   *   - no defense and the revealed share does not match the commitments:
   *     accused disqualified;
   *   - no defense and the revealed share verifies: the accuser's own
   *     evidence exonerates the accused — complaint FALSE, accused NOT
   *     disqualified;
   *   - complaints by an already-disqualified party are void.
   *
   * Complaints stay pending while the accused's commitments are unknown.
   */
  resolveComplaints(): void {
    for (const complaint of [...this.complaints]) {
      const key = `${complaint.victimIdx}:${complaint.accusedIdx}`;
      const status = this.complaintResolution.get(key);
      if (status !== 'pending') continue;
      if (this.disqualified.has(complaint.victimIdx)) {
        // A disqualified complainer's complaint is void.
        this.complaintResolution.set(key, 'void');
        continue;
      }
      if (this.disqualified.has(complaint.accusedIdx)) {
        // Already disqualified (e.g. the local victim in verifyShares); the
        // public complaint adds nothing.
        this.complaintResolution.set(key, 'void');
        continue;
      }
      const peer = this.commitments.get(complaint.accusedIdx);
      if (!peer) continue; // cannot adjudicate before the accused's commitments arrive

      if (complaint.defense) {
        if (verifyVssShare(complaint.victimIdx, complaint.defense.validShare, peer.commitHexes)) {
          // Valid defense: the complaint is false; the accused is NOT
          // disqualified. The complainer may be slashed by the backend.
          this.complaintResolution.set(key, 'false');
          this.falseComplaints.push(complaint);
          continue;
        }
        // A defense that does not verify is an admission of guilt.
        this.disqualified.add(complaint.accusedIdx);
        this.complaintResolution.set(key, 'upheld');
        continue;
      }

      const valid = verifyVssShare(
        complaint.victimIdx,
        complaint.revealedShare,
        peer.commitHexes,
      );
      if (!valid) {
        this.disqualified.add(complaint.accusedIdx);
        this.complaintResolution.set(key, 'upheld');
        continue;
      }
      // The accuser's own revealed share verifies: the complaint is false and
      // the accused is exonerated.
      this.complaintResolution.set(key, 'false');
      this.falseComplaints.push(complaint);
    }
  }

  /** Admitted (attribution-bound) complaints that enter arbitration. */
  getComplaints(): readonly DkgComplaint[] {
    return this.complaints.map((c) => ({
      ...c,
      defense: c.defense ? { ...c.defense } : undefined,
    }));
  }

  /**
   * Complaints whose own evidence exonerated the accused — slashing evidence
   * for the bond backend. Never includes plaintext shares of innocent
   * parties beyond what the accuser itself published.
   */
  getFalseComplaints(): readonly DkgComplaint[] {
    return this.falseComplaints.map((c) => ({
      ...c,
      defense: c.defense ? { ...c.defense } : undefined,
    }));
  }

  private hasPendingComplaints(): boolean {
    for (const status of this.complaintResolution.values()) {
      if (status === 'pending') return true;
    }
    return false;
  }

  /**
   * Check whether the full certified roster has delivered everything needed
   * to compute the key. A threshold-sized qualified subset is NOT enough:
   * finalizing over a subset lets different jurors derive different group
   * keys, so any disqualification or missing participant fails the attempt.
   */
  canComputeKey(): boolean {
    if (this.disqualified.size > 0) return false;
    return this.jurors.every(
      (j) =>
        j.idx === this.myIdx ||
        (this.commitments.has(j.idx) && this.decryptedShares.has(j.idx)),
    );
  }

  /**
   * Compute the group public key and this juror's secret share.
   *
   * Fails closed: the attempt aborts if any participant was disqualified, any
   * roster commitment/share is missing, or any received share does not verify
   * against its sender's public commitments. The group key is computed over
   * the exact certified roster, never over a threshold subset.
   */
  computeKey(): DkgRecord {
    if (this.computedRecord) return this.computedRecord;
    // A consensus-level abort takes precedence over local setup errors: a
    // disqualified roster member poisons the attempt no matter how far local
    // key generation progressed.
    if (this.disqualified.size > 0) {
      throw new Error(
        'DKG attempt failed: a roster participant was disqualified; ' +
          'Court must start a new attempt with a fresh roster instead of shrinking this one',
      );
    }
    if (!this.localPoly) {
      throw new Error('Local polynomial not generated');
    }

    const qualifiedJurors = [...this.jurors];
    if (qualifiedJurors.length < this.threshold) {
      throw new Error(
        `DKG failed: roster has ${qualifiedJurors.length} jurors, threshold is ${this.threshold}`,
      );
    }

    const qualifiedCommits = qualifiedJurors
      .map((j) => (j.idx === this.myIdx
        ? { idx: j.idx, pubkey: j.nostrPubkey, commits: this.localPoly!.commitments }
        : this.commitments.get(j.idx)))
      .filter((c): c is { idx: number; pubkey: string; commits: CurvePoint[] } => !!c);

    if (qualifiedCommits.length !== qualifiedJurors.length) {
      throw new Error('Cannot compute the key before every roster commitment has arrived');
    }

    // Fail closed on any invalid peer share instead of mixing it into the key.
    for (const j of qualifiedJurors) {
      if (j.idx === this.myIdx) continue;
      const shareHex = this.decryptedShares.get(j.idx);
      if (!shareHex) throw new Error(`Missing decrypted share from juror ${j.idx}`);
      const peer = this.commitments.get(j.idx)!;
      if (!verifyVssShare(this.myIdx, shareHex, peer.commitHexes)) {
        this.disqualified.add(j.idx);
        this.verificationFailures.push({
          disputeId: this.disputeId,
          accusedIdx: j.idx,
          accusedPubkey: peer.pubkey,
          victimIdx: this.myIdx,
          victimPubkey: this.myPubkey,
          commitmentEventId: peer.eventId ?? '',
          reason: 'invalid_share',
        });
        throw new Error(
          `Share from juror ${j.idx} does not verify against its commitments; the DKG attempt must abort`,
        );
      }
    }

    const groupPoint = qualifiedCommits.reduce(
      (sum, c) => sum.add(c.commits[0]),
      Point.ZERO,
    );

    // My share = sum of all roster polynomials evaluated at my index.
    const myShareScalar = qualifiedJurors.reduce((sum, j) => {
      if (j.idx === this.myIdx) {
        return modN(sum + evaluatePoly(this.localPoly!.coeffs, BigInt(this.myIdx)));
      }
      const shareHex = this.decryptedShares.get(j.idx)!;
      return modN(sum + BigInt('0x' + shareHex));
    }, 0n);

    const verificationShares = qualifiedJurors.map((j) => {
      const idx = BigInt(j.idx);
      const pubkeyPoint = qualifiedCommits.reduce(
        (sum, c) => sum.add(evaluateCommitments(c.commits, idx)),
        Point.ZERO,
      );
      return { idx: j.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
    });

    const vssCommitments = qualifiedCommits.map((c) => ({
      idx: c.idx,
      pubkey: c.pubkey,
      commits: c.commits.map((p) => p.toHex(true)),
    }));

    const groupPubkey = groupPoint.toHex(true);
    const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);

    const myVerification = verificationShares.find((v) => v.idx === this.myIdx);
    if (myVerification) {
      const derived = Point.BASE.multiply(myShareScalar).toHex(true).slice(2);
      if (derived !== myVerification.pubkey) {
        throw new Error('Computed share does not match verification share');
      }
    }

    this.computedGroupKey = { compressed: groupPubkey, xOnly: groupPubkeyXOnly };
    this.computedShare = { idx: this.myIdx, seckey: scalarToHex(myShareScalar) };
    this.computedRecord = {
      marketId: this.marketId,
      disputeId: this.disputeId,
      threshold: this.threshold,
      participants: qualifiedJurors.length,
      groupPubkey,
      groupPubkeyXOnly,
      verificationShares,
      jurorPubkeys: qualifiedJurors.map((j) => j.nostrPubkey),
      vssCommitments,
    };

    return this.computedRecord;
  }

  getShare(): frost.SecretShare {
    if (!this.computedShare) {
      throw new Error('Key not computed yet');
    }
    return this.computedShare;
  }

  getRecord(): DkgRecord {
    if (!this.computedRecord) {
      throw new Error('Key not computed yet');
    }
    return this.computedRecord;
  }

  /**
   * Restore this juror's share from a Kind 39100 self-backup.
   *
   * FULL RECOMPUTATION BATTERY (2026-08-15 hardening — see
   * docs/COMPLAINT-PROTOCOL.md intro and courtRecovery.ts): nothing in the
   * backup is trusted. Self-decryption is necessary but never sufficient:
   * any party that once invoked `nip44_encrypt` on this signer can mint
   * validly self-decrypting ciphertexts, so this method re-derives the group
   * key, every verification share, and the local share from the supplied VSS
   * commitments with the same curve functions the live DKG uses — and
   * rejects a self-consistent backup under a DIFFERENT group key or a
   * negated share (x-only comparisons would certify n - s).
   */
  async restoreFromBackup(backup: EncryptedShareBackup): Promise<boolean> {
    if (backup.disputeId !== this.disputeId) return false;
    if (backup.jurorIdx !== this.myIdx) return false;
    if (backup.jurorPubkey !== this.myPubkey) return false;
    if (this.computedRecord) return false;

    try {
      const shareHex = await this.nip44.decrypt(backup.encryptedShare, this.myPubkey);

      // Structural gates: consistent array lengths, ordered 1..n indices,
      // per-participant commitment counts equal to the session threshold,
      // well-formed pubkeys.
      const vs = backup.verificationShares;
      const vss = backup.vssCommitments;
      const n = vs.length;
      const threshold = this.threshold;
      if (n < threshold) return false;
      if (vss.length !== n) return false;
      if (vss.some((v) => v.commits.length !== threshold)) return false;
      const ordered = (list: readonly { idx: number }[]): boolean =>
        list.length === n && list.every((entry, i) => entry.idx === i + 1);
      if (!ordered(vs) || !ordered(vss)) return false;
      if (vss.some((v) => !/^[0-9a-f]{64}$/.test(v.pubkey))) return false;

      const commitments: CurvePoint[][] = vss.map((entry) =>
        entry.commits.map((hex) => Point.fromHex(hex)),
      );

      // Group key recomputed from the constant commitments: must match the
      // backup's claim exactly (compressed full-point comparison).
      const groupPoint = commitments.reduce(
        (sum, commits) => sum.add(commits[0]),
        Point.ZERO,
      );
      if (groupPoint.equals(Point.ZERO)) return false;
      if (groupPoint.toHex(true) !== backup.groupPubkey) return false;

      // Every verification share recomputed from the commitments; each must
      // match the claimed x-only share.
      for (let i = 0; i < n; i++) {
        const index = BigInt(i + 1);
        const point = commitments.reduce(
          (sum, commits) => sum.add(evaluateCommitments(commits, index)),
          Point.ZERO,
        );
        if (point.equals(Point.ZERO)) return false;
        if (pointToXOnlyHex(point) !== vs[i]!.pubkey) return false;
      }

      // The encrypted share is the exact scalar whose full point (parity
      // exact) is the recomputed verification point for this juror.
      const scalar = BigInt('0x' + shareHex);
      if (scalar <= 0n || scalar >= secp256k1.Point.Fn.ORDER) return false;
      const myPoint = commitments.reduce(
        (sum, commits) => sum.add(evaluateCommitments(commits, BigInt(this.myIdx))),
        Point.ZERO,
      );
      if (!Point.BASE.multiply(scalar).equals(myPoint)) return false;

      const groupPubkey = groupPoint.toHex(true);
      const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
      const verificationShares = vs.map((entry, i) => ({
        idx: i + 1,
        pubkey: pointToXOnlyHex(
          commitments.reduce(
            (sum, commits) => sum.add(evaluateCommitments(commits, BigInt(i + 1))),
            Point.ZERO,
          ),
        ),
      }));

      this.computedShare = { idx: this.myIdx, seckey: shareHex };
      this.computedRecord = {
        marketId: this.marketId,
        disputeId: this.disputeId,
        threshold,
        participants: n,
        groupPubkey,
        groupPubkeyXOnly,
        verificationShares,
        jurorPubkeys: vss.map((v) => v.pubkey),
        vssCommitments: vss.map((v) => ({
          idx: v.idx,
          pubkey: v.pubkey,
          commits: [...v.commits],
        })),
      };
      this.computedGroupKey = { compressed: groupPubkey, xOnly: groupPubkeyXOnly };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the encrypted self-backup payload for this juror's share.
   *
   * The backup is only restorable (via {@link restoreFromBackup}) when it is
   * encrypted to this juror's own pubkey, because restore derives the NIP-44
   * conversation key against `myPubkey`.
   */
  async buildBackupPayload(encryptToPubkey: string): Promise<{
    backup: EncryptedShareBackup;
    backupEvent: ReturnType<typeof buildShareBackupEvent>;
  }> {
    if (!this.computedShare || !this.computedRecord) {
      throw new Error('Key not computed yet');
    }
    if (encryptToPubkey !== this.myPubkey) {
      throw new Error(
        'Backups must be encrypted to this juror\'s own pubkey; ' +
          'a backup encrypted to another key cannot be restored by restoreFromBackup',
      );
    }

    const encryptedShare = await this.nip44.encrypt(this.computedShare.seckey, encryptToPubkey);

    const backup: EncryptedShareBackup = {
      disputeId: this.disputeId,
      jurorIdx: this.myIdx,
      jurorPubkey: this.myPubkey,
      encryptedShare,
      groupPubkey: this.computedRecord.groupPubkey,
      verificationShares: this.computedRecord.verificationShares,
      vssCommitments: this.computedRecord.vssCommitments,
    };

    return { backup, backupEvent: buildShareBackupEvent(backup) };
  }

  /**
   * Generate this juror's refresh polynomial and produce:
   *  - the public refresh commitment event (kind 38033)
   *  - encrypted refresh share events (kind 39013) for every peer juror
   *
   * Refresh polynomials have a zero constant term, so the group public key is
   * preserved. This method must be called after `computeKey()`.
   */
  async generateRefreshCommitmentAndShares(): Promise<{
    commitmentEvent: ReturnType<typeof buildRefreshCommitmentEvent>;
    shareEvents: ReturnType<typeof buildEncryptedRefreshShareEvent>[];
  }> {
    if (!this.computedRecord || !this.computedShare) {
      throw new Error('DKG key must be computed before refresh');
    }

    // Generate shares for the ACTUAL juror index set. Indices may be
    // non-contiguous, so `frost.Lib.gen_refresh_shares` (recipients 1..n)
    // cannot be used here.
    const pkg = generateRefreshShares(
      this.myIdx,
      this.threshold,
      this.jurors.map((j) => j.idx),
    );
    this.refreshLocalPkg = {
      shares: pkg.shares,
      commits: pkg.vss_commits.map((c) => Point.fromHex(c)),
      commitHexes: pkg.vss_commits,
    };

    const phaseNonce = crypto.randomUUID ? crypto.randomUUID() : scalarToHex(randomScalar());
    const commitmentEvent = buildRefreshCommitmentEvent({
      disputeId: this.disputeId,
      jurorIdx: this.myIdx,
      jurorPubkey: this.myPubkey,
      threshold: this.threshold,
      vssCommits: pkg.vss_commits,
      phaseNonce,
    });

    const shareEvents: ReturnType<typeof buildEncryptedRefreshShareEvent>[] = [];
    for (const j of this.jurors) {
      if (j.idx === this.myIdx) continue;
      const share = frost.Lib.get_share(pkg.shares, j.idx);
      const encryptedShare = await this.nip44.encrypt(share.seckey, j.nostrPubkey);
      const payload: EncryptedRefreshShare = {
        disputeId: this.disputeId,
        fromIdx: this.myIdx,
        fromPubkey: this.myPubkey,
        toIdx: j.idx,
        toPubkey: j.nostrPubkey,
        encryptedShare,
        phaseNonce,
      };
      shareEvents.push(buildEncryptedRefreshShareEvent(payload));
    }

    return { commitmentEvent, shareEvents };
  }

  /**
   * Add a peer's public refresh commitment event.
   */
  addRefreshCommitment(event: {
    readonly idx: number;
    readonly pubkey: string;
    readonly threshold: number;
    readonly vssCommits: readonly string[];
    readonly phaseNonce: string;
    readonly eventId?: string;
  }): boolean {
    if (this.disqualified.has(event.idx)) return false;
    if (event.threshold !== this.threshold) return false;
    if (event.vssCommits.length !== this.threshold - 1) return false;
    // Same roster-binding rules as addCommitment (see there).
    const juror = this.getJuror(event.idx);
    if (!juror) return false;
    if (event.pubkey !== juror.nostrPubkey) return false;
    try {
      const commits = event.vssCommits.map((c) => Point.fromHex(c));
      if (commits.length === 0) return false;
      const existing = this.refreshCommitments.get(event.idx);
      if (existing) {
        const same =
          existing.pubkey === event.pubkey &&
          existing.phaseNonce === event.phaseNonce &&
          existing.commitHexes.join(',') === event.vssCommits.join(',');
        if (same) return true; // Idempotent re-delivery of the same event.
        // Conflicting refresh commitment for the same index: equivocation.
        this.disqualified.add(event.idx);
        this.refreshCommitments.delete(event.idx);
        this.refreshPhaseNonces.delete(event.idx);
        return false;
      }
      this.refreshCommitments.set(event.idx, {
        idx: event.idx,
        pubkey: event.pubkey,
        threshold: event.threshold,
        commits,
        commitHexes: event.vssCommits,
        phaseNonce: event.phaseNonce,
        eventId: event.eventId,
        receivedAt: Math.floor(Date.now() / 1000),
      });
      this.refreshPhaseNonces.set(event.idx, event.phaseNonce);
      const existingShare = this.encryptedRefreshShares.get(event.idx);
      if (existingShare && existingShare.phaseNonce !== event.phaseNonce) {
        this.disqualified.add(event.idx);
        this.encryptedRefreshShares.delete(event.idx);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add an encrypted refresh share addressed to this juror.
   */
  addEncryptedRefreshShare(payload: EncryptedRefreshShare): boolean {
    if (payload.toIdx !== this.myIdx) return false;
    if (payload.disputeId !== this.disputeId) return false;
    // Same sender-binding rules as addEncryptedShare (see there).
    const fromJuror = this.getJuror(payload.fromIdx);
    if (!fromJuror) return false;
    if (payload.fromPubkey && payload.fromPubkey !== fromJuror.nostrPubkey) return false;
    const expected = this.refreshPhaseNonces.get(payload.fromIdx);
    if (expected !== undefined && payload.phaseNonce !== expected) {
      this.disqualified.add(payload.fromIdx);
      return false;
    }
    this.encryptedRefreshShares.set(payload.fromIdx, payload);
    return true;
  }

  /**
   * Decrypt all received refresh shares using the configured NIP-44 crypto provider.
   */
  async decryptRefreshShares(): Promise<void> {
    for (const [fromIdx, payload] of this.encryptedRefreshShares) {
      if (this.decryptedRefreshShares.has(fromIdx)) continue;
      const fromJuror = this.getJuror(fromIdx);
      if (!fromJuror) continue;
      try {
        const shareHex = await this.nip44.decrypt(payload.encryptedShare, fromJuror.nostrPubkey);
        this.decryptedRefreshShares.set(fromIdx, shareHex);
      } catch {
        // Decryption failed; leave absent so it can become a complaint.
      }
    }
  }

  /**
   * Verify all decrypted refresh shares against peer refresh commitments.
   * Failures disqualify the accused peer and are returned as private records;
   * plaintext refresh shares are never published as blame proof.
   */
  verifyRefreshShares(commitmentEventIds: Record<number, string>): DkgVerificationFailure[] {
    const newFailures: DkgVerificationFailure[] = [];

    for (const [fromIdx, shareHex] of this.decryptedRefreshShares) {
      if (this.disqualified.has(fromIdx)) continue;
      const peer = this.refreshCommitments.get(fromIdx);
      if (!peer) continue;
      const valid = verifyRefreshShare(this.myIdx, shareHex, peer.commitHexes);
      if (!valid) {
        this.disqualified.add(fromIdx);
        newFailures.push({
          disputeId: this.disputeId,
          accusedIdx: fromIdx,
          accusedPubkey: peer.pubkey,
          victimIdx: this.myIdx,
          victimPubkey: this.myPubkey,
          commitmentEventId: commitmentEventIds[fromIdx] ?? '',
          reason: 'invalid_share',
        });
      }
    }

    this.verificationFailures.push(...newFailures);
    return newFailures;
  }

  /** Private local blame evidence collected during this attempt. Never publish shares. */
  getVerificationFailures(): readonly DkgVerificationFailure[] {
    return this.verificationFailures;
  }

  /**
   * Combine the existing key with all verified refresh shares.
   * Returns an updated DkgRecord whose verification shares reflect the refresh.
   */
  computeRefreshedKey(): DkgRecord {
    if (!this.computedRecord || !this.computedShare) {
      throw new Error('DKG key not computed');
    }
    // Disqualification aborts the refresh regardless of local progress.
    if (this.disqualified.size > 0) {
      throw new Error(
        'Refresh failed: a roster participant was disqualified; the ceremony must abort rather than shrink the roster',
      );
    }
    if (!this.refreshLocalPkg) {
      throw new Error('Refresh commitment not generated');
    }

    // Refresh requires the exact certified roster, never a threshold subset.
    const qualifiedJurors = [...this.jurors];
    if (qualifiedJurors.length < this.threshold) {
      throw new Error(
        `Refresh failed: roster has ${qualifiedJurors.length} jurors, threshold is ${this.threshold}`,
      );
    }

    const qualifiedRefreshCommits = qualifiedJurors
      .map((j) =>
        j.idx === this.myIdx
          ? {
              idx: j.idx,
              pubkey: j.nostrPubkey,
              commits: this.refreshLocalPkg!.commits,
              commitHexes: this.refreshLocalPkg!.commitHexes,
            }
          : this.refreshCommitments.get(j.idx),
      )
      .filter(
        (
          c,
        ): c is {
          idx: number;
          pubkey: string;
          commits: CurvePoint[];
          commitHexes: readonly string[];
        } => !!c,
      );

    if (qualifiedRefreshCommits.length < qualifiedJurors.length) {
      throw new Error('Missing refresh commitments from qualified jurors');
    }

    // Build refresh shares addressed to this juror, including our own.
    const myRefreshShares = qualifiedJurors.map((j) => {
      if (j.idx === this.myIdx) {
        return frost.Lib.get_share(this.refreshLocalPkg!.shares, this.myIdx);
      }
      const shareHex = this.decryptedRefreshShares.get(j.idx);
      if (!shareHex) {
        throw new Error(`Missing decrypted refresh share from juror ${j.idx}`);
      }
      return { idx: this.myIdx, seckey: shareHex };
    });

    const refreshedShare = frost.Lib.refresh_share(myRefreshShares, this.computedShare);

    // Merge original and refresh commitments and recompute verification shares.
    const mergedVssCommitments = qualifiedJurors.map((j) => {
      const original = this.computedRecord!.vssCommitments.find((c) => c.idx === j.idx);
      if (!original) {
        throw new Error(`Missing original commitments for juror ${j.idx}`);
      }
      const refresh = qualifiedRefreshCommits.find((c) => c.idx === j.idx)!;
      return {
        idx: j.idx,
        pubkey: j.nostrPubkey,
        commits: mergeRefreshCommitments(
          original.commits,
          refresh.commitHexes,
        ),
      };
    });

    const verificationShares = qualifiedJurors.map((j) => {
      const idx = BigInt(j.idx);
      const pubkeyPoint = mergedVssCommitments.reduce(
        (sum, c) => sum.add(evaluateCommitments(c.commits.map((h) => Point.fromHex(h)), idx)),
        Point.ZERO,
      );
      return { idx: j.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
    });

    const groupPoint = mergedVssCommitments.reduce(
      (sum, c) => sum.add(Point.fromHex(c.commits[0])),
      Point.ZERO,
    );
    const groupPubkey = groupPoint.toHex(true);

    if (groupPubkey !== this.computedRecord.groupPubkey) {
      throw new Error('Refresh changed the group public key');
    }

    const myVerification = verificationShares.find((v) => v.idx === this.myIdx);
    if (myVerification) {
      const derived = Point.BASE.multiply(BigInt('0x' + refreshedShare.seckey))
        .toHex(true)
        .slice(2);
      if (derived !== myVerification.pubkey) {
        throw new Error('Refreshed share does not match verification share');
      }
    }

    const refreshedRecord: DkgRecord = {
      ...this.computedRecord,
      groupPubkey,
      groupPubkeyXOnly: pointToXOnlyHex(groupPoint),
      verificationShares,
      vssCommitments: mergedVssCommitments,
    };

    this.computedRecord = refreshedRecord;
    this.computedShare = refreshedShare;
    return refreshedRecord;
  }

  /**
   * Current phase of the DKG from this juror's perspective.
   *
   * Any disqualification fails the whole attempt: finalizing over a reduced
   * roster would let jurors derive divergent group keys.
   */
  getPhase(): 'awaiting_commitments' | 'awaiting_shares' | 'complaint' | 'complete' | 'failed' {
    if (this.disqualified.size > 0) return 'failed';
    if (this.computedRecord) return 'complete';
    // Only UNRESOLVED (pending) complaints hold the ceremony in the complaint
    // phase; a resolved false complaint no longer stalls progress reporting.
    if (this.hasPendingComplaints()) return 'complaint';
    const haveAllPeerCommits = this.jurors
      .filter((j) => j.idx !== this.myIdx)
      .every((j) => this.commitments.has(j.idx));
    if (!haveAllPeerCommits) return 'awaiting_commitments';
    return 'awaiting_shares';
  }
}
