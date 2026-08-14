// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Pedersen-style distributed key generation adapter for the BAO Court / FROST oracle.
 *
 * This adapter simulates the full multi-party DKG inside a single local
 * process, but the cryptographic design is identical to a network version.
 *
 * NOTE: A coordinator-dependent DKG is NOT the desired design. The target is a
 * fully independent jury where every juror runs this logic on their own device
 * and exchanges only public commitments and encrypted shares over Nostr or other
 * peer-to-peer channels:
 *
 *   - Every juror generates its own private degree-(t-1) polynomial.
 *   - Every juror publishes Feldman coefficient commitments.
 *   - Every juror provides a Schnorr proof-of-knowledge of the constant coefficient.
 *   - Every received share is verified against the commitments.
 *   - Failed verifications raise complaints; if the revealed share is still
 *     invalid, the accused participant is disqualified.
 *   - The group secret never exists in one place — it is the sum of all
 *     remaining participants' constant coefficients.
 *
 * No single party materializes the group secret.
 *
 * NOTE: `generateFrostKeys()` defaults to `PedersenDkgAdapter`. The legacy
 * trusted-dealer adapter remains available as an explicit opt-in for tests and
 * demos. A production deployment MUST run the DKG across real user app instances
 * (browser/mobile/desktop) with encrypted peer-to-peer channels.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as frost from '@vbyte/frost';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createProofOfKnowledge, deriveXOnlyPubkey, randomScalar, scalarToHex, seededScalar, verifyProofOfKnowledge } from './crypto';
import type { DkgRecord, SelectedJuror } from './types';

const Point = secp256k1.Point;
// secp256k1 curve order (scalar field).
const N = secp256k1.Point.Fn.ORDER;
type CurvePoint = InstanceType<typeof Point>;

export function modN(x: bigint): bigint {
  const r = x % N;
  return r < 0n ? r + N : r;
}

/**
 * Evaluate a polynomial over the secp256k1 scalar field using Horner's rule.
 */
export function evaluatePoly(coeffs: readonly bigint[], x: bigint): bigint {
  let result = 0n;
  for (let k = coeffs.length - 1; k >= 0; k--) {
    result = modN(modN(result * x) + coeffs[k]);
  }
  return result;
}

/**
 * Evaluate a polynomial whose coefficients are curve points at x.
 * This computes `sum_k A_k * x^k`.
 */
export function evaluateCommitments(
  commitments: readonly CurvePoint[],
  x: bigint,
): CurvePoint {
  let result = Point.ZERO;
  for (let k = commitments.length - 1; k >= 0; k--) {
    result = result.multiply(x).add(commitments[k]);
  }
  return result;
}

/**
 * Evaluate a refresh polynomial at x.
 * Refresh polynomials have a zero constant term, so this computes
 * `sum_{k=1}^{degree} A_k * x^k`.
 */
export function evaluateRefreshCommitments(
  commitments: readonly CurvePoint[],
  x: bigint,
): CurvePoint {
  let result = Point.ZERO;
  for (let k = commitments.length - 1; k >= 0; k--) {
    result = result.multiply(x).add(commitments[k]);
  }
  return result.multiply(x);
}

/**
 * Merge original DKG commitments with refresh commitments.
 * The refresh polynomial has degree threshold-1 but a zero constant term, so
 * its commitments are added to the original commitments starting at degree 1.
 */
export function mergeRefreshCommitments(
  originalCommits: readonly string[],
  refreshCommits: readonly string[],
): string[] {
  if (refreshCommits.length !== originalCommits.length - 1) {
    throw new Error('Refresh commitment count must be one less than the threshold');
  }
  const orig = originalCommits.map((c) => Point.fromHex(c));
  const refr = refreshCommits.map((c) => Point.fromHex(c));
  const merged: CurvePoint[] = [orig[0]];
  for (let k = 1; k < orig.length; k++) {
    merged.push(orig[k].add(refr[k - 1]));
  }
  return merged.map((p) => p.toHex(true));
}

export function pointToXOnlyHex(point: CurvePoint): string {
  // Drop the 02/03 prefix from the compressed encoding to obtain a BIP340 x-only pubkey.
  return point.toHex(true).slice(2);
}

/**
 * Generate a zero-constant refresh polynomial package for an arbitrary set of
 * recipient indices.
 *
 * This replaces `frost.Lib.gen_refresh_shares`, which can only address
 * recipients `1..count` and therefore breaks for any non-contiguous juror
 * index set (e.g. after a DKG disqualification). The refresh polynomial is
 * `f(x) = c_1*x + ... + c_{t-1}*x^{t-1}` (zero constant term), so the group
 * public key is preserved. The returned commitments match the format expected
 * by {@link mergeRefreshCommitments} and {@link verifyRefreshShare}: one
 * commitment per non-constant coefficient, starting at degree 1.
 */
export function generateRefreshShares(
  senderIdx: number,
  threshold: number,
  recipientIdxs: readonly number[],
): { vss_commits: string[]; idx: number; shares: frost.SecretShare[] } {
  if (threshold < 2) {
    throw new Error('Threshold must be at least 2');
  }
  if (recipientIdxs.length === 0 || recipientIdxs.some((i) => !Number.isInteger(i) || i < 1)) {
    throw new Error('Recipient indices must be positive integers');
  }
  const subCoeffs = Array.from({ length: threshold - 1 }, () => randomScalar());
  const coeffs = [0n, ...subCoeffs];
  const shares = recipientIdxs.map((idx) => ({
    idx,
    seckey: scalarToHex(evaluatePoly(coeffs, BigInt(idx))),
  }));
  const vss_commits = subCoeffs.map((c) => Point.BASE.multiply(c).toHex(true));
  return { vss_commits, idx: senderIdx, shares };
}

export interface PedersenDkgOptions {
  /**
   * When true, enables test/demo-only features: deterministic `seed` keygen
   * and the `corruptShare` fault injection hook. Never enable in production.
   */
  readonly unsafeTestMode?: boolean;
  /**
   * Test-only hook: simulate a dishonest participant that sends an invalid share.
   * The accused juror's share to the victim juror is corrupted, triggering a
   * complaint and disqualification. Requires `unsafeTestMode: true`.
   */
  readonly corruptShare?: { readonly accused: number; readonly victim: number };
  /**
   * Test-only hook: simulate a participant that fails its Schnorr
   * proof-of-knowledge of the constant term (e.g. committed to a point whose
   * discrete log it does not know). Requires `unsafeTestMode: true`.
   */
  readonly corruptPok?: { readonly accused: number };
}

export interface ParticipantState {
  readonly juror: SelectedJuror;
  readonly coeffs: readonly bigint[];
  readonly commitments: readonly CurvePoint[];
  readonly pok: ReturnType<typeof createProofOfKnowledge>;
}

export interface KeygenParams {
  readonly marketId: string;
  /** Optional dispute id (2140wtf scopes DKG to a dispute). */
  readonly disputeId?: string;
  readonly threshold: number;
  readonly jurors: readonly SelectedJuror[];
  /**
   * Optional deterministic seed. Only allowed when the adapter is constructed
   * with `unsafeTestMode: true`. Passing a shared/public seed in production
   * collapses the DKG because multiple jurors generate identical polynomials.
   */
  readonly seed?: string | Uint8Array;
}

export interface KeygenResult {
  readonly record: DkgRecord;
  readonly shares: frost.SecretShare[];
}

export interface RefreshParams {
  readonly record: DkgRecord;
  readonly shares: readonly frost.SecretShare[];
}

export interface RefreshResult {
  readonly record: DkgRecord;
  readonly shares: frost.SecretShare[];
}

/**
 * Interface that a production DKG implementation must satisfy.
 */
export interface DkgAdapter {
  readonly run: (params: KeygenParams) => KeygenResult;
  readonly refreshShares: (params: RefreshParams) => RefreshResult;
}
export class PedersenDkgAdapter implements DkgAdapter {
  private readonly unsafeTestMode: boolean;
  private readonly corruptShare?: {
    readonly accused: number;
    readonly victim: number;
  };
  private readonly corruptPok?: { readonly accused: number };
  private paramsForProofDomain?: { readonly marketId: string; readonly disputeId?: string };

  constructor(options?: PedersenDkgOptions) {
    this.unsafeTestMode = options?.unsafeTestMode ?? false;
    if ((options?.corruptShare || options?.corruptPok) && !this.unsafeTestMode) {
      throw new Error('corruptShare/corruptPok require unsafeTestMode: true');
    }
    this.corruptShare = options?.corruptShare;
    this.corruptPok = options?.corruptPok;
  }

  private proofDomain(idx: number): string {
    const marketId = this.paramsForProofDomain?.marketId ?? '';
    const disputeId = this.paramsForProofDomain?.disputeId ?? '';
    return `market=${marketId}|dispute=${disputeId}|juror=${idx}`;
  }

  run(params: KeygenParams): KeygenResult {
    this.validateParams(params);

    if (params.seed && !this.unsafeTestMode) {
      throw new Error(
        'Deterministic DKG seed is only allowed in unsafeTestMode. ' +
          'A shared seed in production lets any juror reconstruct the group secret.',
      );
    }

    const { threshold, jurors } = params;
    this.paramsForProofDomain = { marketId: params.marketId, disputeId: params.disputeId };
    const participants = this.createParticipants(jurors, threshold, params);
    const disqualified = this.resolveComplaints(participants);

    const qualifiedParticipants = participants.filter(
      (p) => !disqualified.has(p.juror.idx),
    );

    if (qualifiedParticipants.length < threshold) {
      throw new Error(
        `Pedersen DKG failed: ${qualifiedParticipants.length} qualified participants remain, ` +
          `but threshold is ${threshold}`,
      );
    }

    const qualifiedJurors = jurors.filter((j) => !disqualified.has(j.idx));

    // Group public key = sum of all qualified constant-coefficient commitments.
    const groupPoint = qualifiedParticipants.reduce(
      (sum, p) => sum.add(p.commitments[0]),
      Point.ZERO,
    );

    // Each juror's final secret share is the sum of all qualified shares sent to them.
    const shares: frost.SecretShare[] = qualifiedJurors.map((juror) => {
      const idx = BigInt(juror.idx);
      const secret = qualifiedParticipants.reduce(
        (sum, p) => modN(sum + evaluatePoly(p.coeffs, idx)),
        0n,
      );
      return { idx: juror.idx, seckey: scalarToHex(secret) };
    });

    // Verification shares are the public points matching the secret shares.
    const verificationShares = qualifiedJurors.map((juror) => {
      const idx = BigInt(juror.idx);
      const pubkeyPoint = qualifiedParticipants.reduce(
        (sum, p) => sum.add(evaluateCommitments(p.commitments, idx)),
        Point.ZERO,
      );
      return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
    });

    // Sanity check: every secret share must produce the advertised verification share.
    for (const share of shares) {
      const expected = deriveXOnlyPubkey(share.seckey);
      const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
      if (actual !== expected) {
        throw new Error(
          `Pedersen DKG internal error: verification share mismatch for juror ${share.idx}`,
        );
      }
    }

    const groupPubkey = groupPoint.toHex(true);
    const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);

    const vssCommitments = qualifiedParticipants.map((p) => ({
      idx: p.juror.idx,
      pubkey: p.juror.nostrPubkey,
      commits: p.commitments.map((c) => c.toHex(true)),
    }));

    const record: DkgRecord = {
      marketId: params.marketId,
      disputeId: params.disputeId,
      threshold,
      participants: qualifiedJurors.length,
      groupPubkey,
      groupPubkeyXOnly,
      verificationShares,
      jurorPubkeys: qualifiedJurors.map((j) => j.nostrPubkey),
      vssCommitments,
    };

    return { record, shares };
  }

  /**
   * Refresh all shares without changing the group public key.
   *
   * Each juror generates a random degree-(t-1) polynomial with a zero constant
   * term and distributes shares to every other juror. The refreshed share is
   * the old share plus the sum of all received refresh shares. The group public
   * key is unchanged because the refresh polynomials sum to zero.
   */
  refreshShares(params: RefreshParams): RefreshResult {
    this.validateRefreshParams(params);

    const { record, shares } = params;
    const threshold = record.threshold;
    const jurors = record.verificationShares.map((v) => {
      const vss = record.vssCommitments.find((c) => c.idx === v.idx);
      return {
        idx: v.idx,
        nostrPubkey: vss?.pubkey ?? '',
      };
    });

    // Each juror generates a refresh package for all participants. Indices
    // may be non-contiguous (e.g. after a disqualification), so the refresh
    // polynomials are generated locally rather than via
    // `frost.Lib.gen_refresh_shares`, which only supports recipients 1..n.
    const jurorIdxs = jurors.map((j) => j.idx);
    const refreshPackages = jurors.map((juror) =>
      generateRefreshShares(juror.idx, threshold, jurorIdxs),
    );

    // Combine every juror's current share with the refresh shares addressed to them.
    const refreshedShares = jurors.map((juror) => {
      const current = shares.find((s) => s.idx === juror.idx);
      if (!current) {
        throw new Error(`Missing current share for juror ${juror.idx}`);
      }
      const refreshShares = refreshPackages.map((pkg) =>
        frost.Lib.get_share(pkg.shares, juror.idx),
      );
      return frost.Lib.refresh_share(refreshShares, current);
    });

    // Merge original and refresh commitments so verification shares can be updated.
    const mergedVssCommitments = jurors.map((juror, i) => {
      const original = record.vssCommitments.find((c) => c.idx === juror.idx);
      if (!original) {
        throw new Error(`Missing original commitments for juror ${juror.idx}`);
      }
      return {
        idx: juror.idx,
        pubkey: juror.nostrPubkey,
        commits: mergeRefreshCommitments(original.commits, refreshPackages[i].vss_commits),
      };
    });

    const verificationShares = jurors.map((juror) => {
      const idx = BigInt(juror.idx);
      const pubkeyPoint = mergedVssCommitments.reduce(
        (sum, c) => sum.add(evaluateCommitments(c.commits.map((h) => Point.fromHex(h)), idx)),
        Point.ZERO,
      );
      return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
    });

    // Sanity check: every refreshed share must match its verification share.
    for (const share of refreshedShares) {
      const expected = deriveXOnlyPubkey(share.seckey);
      const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
      if (actual !== expected) {
        throw new Error(
          `Refresh internal error: verification share mismatch for juror ${share.idx}`,
        );
      }
    }

    const groupPoint = mergedVssCommitments.reduce(
      (sum, c) => sum.add(Point.fromHex(c.commits[0])),
      Point.ZERO,
    );
    const groupPubkey = groupPoint.toHex(true);
    const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);

    if (groupPubkey !== record.groupPubkey) {
      throw new Error('Refresh changed the group public key');
    }

    const newRecord: DkgRecord = {
      ...record,
      groupPubkey,
      groupPubkeyXOnly,
      verificationShares,
      vssCommitments: mergedVssCommitments,
    };

    return { record: newRecord, shares: refreshedShares };
  }

  private validateRefreshParams(params: RefreshParams): void {
    if (params.shares.length !== params.record.participants) {
      throw new Error('Share count does not match record participants');
    }
    if (params.record.threshold < 2) {
      throw new Error('Threshold must be at least 2');
    }
    const indices = new Set(params.shares.map((s) => s.idx));
    if (indices.size !== params.shares.length) {
      throw new Error('Duplicate share indices');
    }
    for (const share of params.shares) {
      const vss = params.record.vssCommitments.find((c) => c.idx === share.idx);
      if (!vss) {
        throw new Error(`No commitment found for share index ${share.idx}`);
      }
    }
  }

  private validateParams(params: KeygenParams): void {
    if (params.threshold < 2) {
      throw new Error('Threshold must be at least 2');
    }
    if (params.jurors.length < params.threshold) {
      throw new Error('Participants cannot be less than threshold');
    }
    const indices = new Set(params.jurors.map((j) => j.idx));
    if (indices.size !== params.jurors.length) {
      throw new Error('Duplicate juror indices');
    }
    if (params.jurors.some((j) => j.idx < 1)) {
      throw new Error('Juror indices must be positive');
    }
  }

  private createParticipants(
    jurors: readonly SelectedJuror[],
    threshold: number,
    params: KeygenParams,
  ): ParticipantState[] {
    const seedBytes = params.seed
      ? (typeof params.seed === 'string'
        ? (params.seed.length === 64 && /^[0-9a-fA-F]{64}$/.test(params.seed)
          ? hexToBytes(params.seed)
          : sha256(new TextEncoder().encode(params.seed)))
        : params.seed)
      : undefined;

    return jurors.map((juror) => {
      const coeffs = Array.from({ length: threshold }, (_, k) => {
        if (!seedBytes) return randomScalar();
        const info = new TextEncoder().encode(
          `bao-frost-court/dkg-coeff|market=${params.marketId}|dispute=${params.disputeId ?? ''}|threshold=${threshold}|juror=${juror.idx}|k=${k}`,
        );
        return seededScalar(seedBytes, info);
      });
      const commitments = coeffs.map((a) => Point.BASE.multiply(a));
      const domain = this.proofDomain(juror.idx);
      const pok = createProofOfKnowledge(
        scalarToHex(coeffs[0]),
        commitments[0].toHex(true),
        domain,
      );
      if (this.corruptPok?.accused === juror.idx) {
        // Tamper: respond with a different valid scalar so verification fails.
        const z = BigInt(`0x${pok.response}`);
        return { juror, coeffs, commitments, pok: { ...pok, response: scalarToHex(modN(z + 1n)) } };
      }
      return { juror, coeffs, commitments, pok };
    });
  }

  /**
   * Simulate the share-verification and complaint phase.
   * For every pair (sender -> recipient), the recipient checks the share against
   * the sender's public commitments. A failed check is treated as a complaint;
   * the sender reveals the disputed share, and if it is still invalid the sender
   * is disqualified.
   */
  private resolveComplaints(
    participants: readonly ParticipantState[],
  ): Set<number> {
    const disqualified = new Set<number>();

    for (const recipient of participants) {
      const j = BigInt(recipient.juror.idx);
      for (const sender of participants) {
        const i = sender.juror.idx;
        // First verify the sender's Schnorr proof-of-knowledge of its constant
        // term. The docstring promises this check, but nothing ever ran it — a
        // participant could commit to a point it does not know and the POK was
        // dead weight. Fail the attempt for the accused like any other
        // attributable invalid data.
        if (
          !verifyProofOfKnowledge(
            sender.commitments[0].toHex(true),
            sender.pok,
            this.proofDomain(i),
          )
        ) {
          disqualified.add(i);
          continue;
        }
        let share = evaluatePoly(sender.coeffs, j);

        // Inject a faulty share for test scenarios.
        if (
          this.corruptShare &&
          this.corruptShare.accused === i &&
          this.corruptShare.victim === recipient.juror.idx
        ) {
          share = modN(share + 1n);
        }

        const expected = evaluateCommitments(sender.commitments, j);
        const actual = Point.BASE.multiply(share);

        if (!actual.equals(expected)) {
          // The accused reveals the share. In this local simulation the revealed
          // value is the same share we just checked; if it does not match the
          // commitment, the accused is disqualified.
          disqualified.add(i);
        }
      }
    }

    return disqualified;
  }
}

/**
 * Verify a single VSS share from a known commitment set.
 */
export function verifyVssShare(
  recipientIdx: number,
  shareHex: string,
  commitments: readonly string[],
): boolean {
  try {
    const share = BigInt('0x' + shareHex);
    const commits = commitments.map((c) => Point.fromHex(c));
    const expected = evaluateCommitments(commits, BigInt(recipientIdx));
    const actual = Point.BASE.multiply(share);
    return actual.equals(expected);
  } catch {
    return false;
  }
}

/**
 * Verify a refresh share from a known refresh commitment set.
 * Refresh polynomials have a zero constant term.
 */
export function verifyRefreshShare(
  recipientIdx: number,
  shareHex: string,
  refreshCommitments: readonly string[],
): boolean {
  try {
    const share = BigInt('0x' + shareHex);
    const commits = refreshCommitments.map((c) => Point.fromHex(c));
    const expected = evaluateRefreshCommitments(commits, BigInt(recipientIdx));
    const actual = Point.BASE.multiply(share);
    return actual.equals(expected);
  } catch {
    return false;
  }
}

/**
 * Compute a juror's final secret share from a set of valid decrypted shares.
 * All shares must belong to the same recipient index.
 */
export function combineShares(shares: readonly { idx: number; shareHex: string }[]): frost.SecretShare {
  if (shares.length === 0) {
    throw new Error('combineShares requires at least one share');
  }
  const idx = shares[0].idx;
  if (!Number.isInteger(idx) || idx < 1) {
    throw new Error(`Invalid recipient index: ${idx}`);
  }
  if (shares.some((s) => s.idx !== idx)) {
    throw new Error('All shares must belong to the same recipient index');
  }
  let secret = 0n;
  for (const s of shares) {
    if (!/^[0-9a-fA-F]{1,64}$/.test(s.shareHex)) {
      throw new Error(`Invalid share hex from sender index ${s.idx}`);
    }
    secret = modN(secret + BigInt('0x' + s.shareHex));
  }
  return { idx, seckey: scalarToHex(secret) };
}

/**
 * Default keygen — Pedersen DKG.
 */
export function generateFrostKeys(params: KeygenParams): KeygenResult {
  return new PedersenDkgAdapter().run(params);
}
