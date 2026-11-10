// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * FROST threshold signing for the BAO Court / FROST appeal layer.
 *
 * Pipeline role: the cryptographic engine behind the signing machine's
 * `partial_sign` → `aggregate` stages (paper §2, §5) — turns DKG shares +
 * nonce commitments into a BIP-340 group signature over the attestation
 * message. The ceremony state machine (`courtSigningMachine.ts`) wraps
 * these functions; this module is the raw signing layer.
 *
 * Purity: signing functions are pure computations over explicit inputs
 * (shares, nonces, message); the only side effect is the {@link NonceGuard}
 * consumption marker (in-memory or localStorage), which exists to prevent
 * catastrophic nonce reuse. No network I/O.
 *
 * Invariants: INV-SIGN family in docs/FORMAL_INVARIANTS.md §6; error class
 * {@link FrostSigningError} (docs/FORMAL_INVARIANTS.md §15).
 */

import { FrostSigningError } from './errors';
import * as frost from '@vbyte/frost';
import { hexToBytes } from '@noble/hashes/utils.js';
import { buildAttestationMessage, deriveXOnlyPubkey } from './crypto';
import type { DkgRecord, FrostAttestation } from './types';

export interface SigningCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly commit: frost.CommitmentPackage;
}

export interface SigningReveal {
  readonly idx: number;
  readonly pubkey: string;
  readonly pnonce: frost.PublicNonce;
  readonly psig: string;
}

/** One signer's round-1 FROST commitment package with its identity. */
export interface SigningCommitment {
  readonly idx: number;
  readonly pubkey: string;
  readonly commit: frost.CommitmentPackage;
}

/** One signer's round-2 reveal: public nonce + hex partial signature. */
export interface SigningReveal {
  readonly idx: number;
  readonly pubkey: string;
  readonly pnonce: frost.PublicNonce;
  readonly psig: string;
}

/**
 * Parameters of one FROST signing round: the attestation coordinates
 * (market, outcome, round, optional dispute id + verdict hash), the DKG
 * record, the local shares, and the nonce guard.
 */
export interface SigningRoundParams {
  readonly marketId: string;
  readonly outcome: string;
  readonly round: number | string;
  readonly disputeEventId?: string;
  /**
   * Dispute verdict commitment bound into the signed message (kind-39007
   * attestations). REQUIRED for dispute attestations: without it the FROST
   * signature certifies an outcome without certifying that it won the vote.
   */
  readonly verdictHash?: string;
  readonly dkg: DkgRecord;
  readonly shares: readonly frost.SecretShare[];
  /**
   * Guard that tracks consumed FROST nonce commitments. A commitment MUST NOT
   * be used to sign more than one message; reuse leaks the signer's secret
   * share. Defaults to a shared process-wide guard (localStorage-backed in
   * browsers, in-memory elsewhere); callers that need isolation or custom
   * persistence should supply their own NonceGuard.
   */
  readonly nonceGuard?: NonceGuard;
}

/**
 * Tracks FROST nonce commitments that have already been used to produce a
 * partial signature. Implementations may persist this state to survive app
 * restarts.
 */
export interface NonceGuard {
  /**
   * Check whether a nonce commitment has already been consumed. If not, mark
   * it as used and return true. If it has been used, return false.
   */
  readonly consume: (idx: number, binder: string, hidden: string) => boolean;
}

/**
 * In-memory nonce-use guard. Nonce consumption is scoped to this instance.
 */
export class InMemoryNonceGuard implements NonceGuard {
  private readonly used = new Set<string>();

  consume(idx: number, binder: string, hidden: string): boolean {
    const key = `${idx}|${binder}|${hidden}`;
    if (this.used.has(key)) return false;
    this.used.add(key);
    return true;
  }
}

/**
 * Browser-backed persistent nonce-use guard. Falls back to in-memory if
 * localStorage is unavailable (e.g., SSR or Node).
 */
export class LocalStorageNonceGuard implements NonceGuard {
  private readonly key: string;
  /**
   * In-process mirror of every consumed entry. Guarantees protection for the
   * lifetime of this instance even when a localStorage write fails (e.g.
   * storage quota exceeded).
   */
  private readonly memory = new Set<string>();

  constructor(key = 'bao-frost-used-nonces') {
    this.key = key;
  }

  consume(idx: number, binder: string, hidden: string): boolean {
    if (typeof localStorage === 'undefined') {
      throw new FrostSigningError('FROST_SIGNING', 'localStorage is not available; provide an in-memory NonceGuard');
    }
    const entry = `${idx}|${binder}|${hidden}`;
    if (this.memory.has(entry)) return false;
    const used = this.read();
    if (used.has(entry)) {
      this.memory.add(entry);
      return false;
    }
    used.add(entry);
    this.memory.add(entry);
    this.write(used);
    return true;
  }

  private read(): Set<string> {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return new Set<string>();
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((item): item is string => typeof item === 'string'));
      }
    } catch {
      // Ignore malformed storage.
    }
    return new Set<string>();
  }

  private write(used: Set<string>): void {
    try {
      localStorage.setItem(this.key, JSON.stringify([...used]));
    } catch {
      // Ignore storage quota errors; the in-process mirror still protects
      // this session (see `this.memory`).
    }
  }
}

/**
 * Create the default {@link NonceGuard} for the environment: localStorage-
 * backed in browsers (persistent across reloads), in-memory elsewhere.
 *
 * @param storageKey - Optional localStorage key override for the browser
 *                     guard.
 */
export function createDefaultNonceGuard(storageKey?: string): NonceGuard {
  if (typeof localStorage !== 'undefined') {
    return new LocalStorageNonceGuard(storageKey);
  }
  return new InMemoryNonceGuard();
}

/**
 * Shared default guard used when a caller does not supply `nonceGuard`.
 * Lazily created so that nonce-reuse protection actually applies across
 * signing rounds within this process (a fresh guard per call would silently
 * disable the check).
 */
let sharedDefaultGuard: NonceGuard | undefined;

function getGuard(params: SigningRoundParams): NonceGuard {
  if (params.nonceGuard) return params.nonceGuard;
  sharedDefaultGuard ??= createDefaultNonceGuard();
  return sharedDefaultGuard;
}

/**
 * Create round-1 commitments for every share in the set. O(n) over shares.
 * Each commitment MUST be consumed at most once (see {@link NonceGuard}).
 */
export function createCommitments(
  shares: readonly frost.SecretShare[],
): SigningCommitment[] {
  return shares.map((share) => ({
    idx: share.idx,
    pubkey: deriveXOnlyPubkey(share.seckey),
    commit: frost.Lib.create_commit_pkg(share),
  }));
}

/**
 * Create a single FROST signing commitment for one juror.
 */
export function createCommitment(share: frost.SecretShare): SigningCommitment {
  return {
    idx: share.idx,
    pubkey: deriveXOnlyPubkey(share.seckey),
    commit: frost.Lib.create_commit_pkg(share),
  };
}

/**
 * Create round-2 reveals (public nonce + partial signature) for every share
 * against the FULL commitment set. Consumes each share's nonce via the
 * guard — a second signature from the same commitment throws (nonce-reuse
 * protection). O(n) over shares.
 *
 * @throws {@link FrostSigningError} when a nonce commitment was already
 *         consumed or a share is malformed.
 */
export function createRevealsAndPartialSigs(
  params: SigningRoundParams,
  commitments: readonly SigningCommitment[],
): SigningReveal[] {
  return params.shares.map((share) =>
    createRevealAndPartialSig(params, commitments, share),
  );
}

/**
 * Create a single partial signature reveal for one juror.
 */
export function createRevealAndPartialSig(
  params: SigningRoundParams,
  commitments: readonly SigningCommitment[],
  share: frost.SecretShare,
): SigningReveal {
  const message = buildAttestationMessage(
    params.marketId,
    params.outcome,
    params.round,
    params.disputeEventId,
    params.verdictHash,
  );

  const ctx = frost.Lib.get_group_signing_ctx(
    params.dkg.groupPubkey,
    commitments.map((c) => c.commit),
    message,
  );

  const commit = frost.Lib.get_commit_pkg(
    commitments.map((c) => c.commit),
    share,
  );

  const guard = getGuard(params);
  if (!guard.consume(share.idx, commit.binder_pn, commit.hidden_pn)) {
    throw new FrostSigningError('FROST_SIGNING', 
      `FROST nonce reuse detected for juror ${share.idx}: this commitment has already been used to sign`,
    );
  }

  const sig = frost.Lib.sign_msg(ctx, share, commit);

  const valid = frost.Lib.verify_partial_sig(
    ctx,
    commit,
    sig.pubkey,
    sig.psig,
  );
  if (!valid) {
    throw new FrostSigningError('FROST_SIGNING', `Partial signature from juror ${share.idx} failed verification`);
  }

  return {
    idx: share.idx,
    pubkey: sig.pubkey,
    // Only the PUBLIC nonce fields leave this function. The full commitment
    // package also contains the secret nonces (binder_sn/hidden_sn); combined
    // with the published partial signature they reveal the signer's secret
    // share, so they must never be serialized into a reveal.
    pnonce: {
      idx: commit.idx,
      binder_pn: commit.binder_pn,
      hidden_pn: commit.hidden_pn,
    },
    psig: sig.psig,
  };
}

/**
 * Aggregate round-2 reveals into the final {@link FrostAttestation} and
 * verify the group signature before returning it (fail-closed).
 *
 * CONTRACT (crypto literature audit 2026-11): `commitments` must be EXACTLY
 * the set of jurors that produced `reveals` — binding factors and Lagrange
 * coefficients are indexed by the commitment list, so an over-large
 * commitment set yields a signature that fails verification. Callers that
 * collected extra commitments MUST filter them first.
 *
 * @throws {@link FrostSigningError} when the aggregated signature fails
 *         verification or the signer set is inconsistent.
 */
export function aggregateAttestation(
  params: SigningRoundParams,
  commitments: readonly SigningCommitment[],
  reveals: readonly SigningReveal[],
): FrostAttestation {
  // CONTRACT (crypto literature audit 2026-11): `commitments` must be EXACTLY
  // the set of jurors that produced `reveals`. FROST binding factors and the
  // Lagrange coefficients are indexed by the commitment list, so a reveal
  // subset over a larger commitment set yields a final signature that fails
  // `verify_final_sig` below (fail-closed). Callers that collected extra
  // commitments MUST filter them out before calling this function.
  const message = buildAttestationMessage(
    params.marketId,
    params.outcome,
    params.round,
    params.disputeEventId,
    params.verdictHash,
  );

  const ctx = frost.Lib.get_group_signing_ctx(
    params.dkg.groupPubkey,
    commitments.map((c) => c.commit),
    message,
  );

  if (reveals.length < params.dkg.threshold) {
    throw new FrostSigningError('FROST_SIGNING', 
      `Insufficient reveals: ${reveals.length} < threshold ${params.dkg.threshold}`,
    );
  }

  const seenIndices = new Set<number>();
  for (const reveal of reveals) {
    if (seenIndices.has(reveal.idx)) {
      throw new FrostSigningError('FROST_SIGNING', `Duplicate reveal from juror ${reveal.idx}`);
    }
    seenIndices.add(reveal.idx);

    const commit = frost.Lib.get_commit_pkg(
      commitments.map((c) => c.commit),
      { idx: reveal.idx, seckey: '' }, // seckey not needed for get_commit_pkg lookup
    );
    const valid = frost.Lib.verify_partial_sig(
      ctx,
      commit,
      reveal.pubkey,
      reveal.psig,
    );
    if (!valid) {
      throw new FrostSigningError('FROST_SIGNING', `Partial signature from juror ${reveal.idx} is invalid`);
    }
  }

  const signatureHex = frost.Lib.combine_partial_sigs(
    ctx,
    reveals.map((r) => ({ idx: r.idx, pubkey: r.pubkey, psig: r.psig })),
  );

  const pubNonce = signatureHex.slice(0, 64);

  const isValid = frost.Lib.verify_final_sig(
    ctx,
    hexToBytes(message),
    hexToBytes(signatureHex),
  );
  if (!isValid) {
    throw new FrostSigningError('FROST_SIGNING', 'Final aggregated signature failed verification');
  }

  return {
    marketId: params.marketId,
    outcome: params.outcome,
    round: params.round,
    signature: signatureHex,
    pubNonce,
    groupPubkey: params.dkg.groupPubkeyXOnly,
    message,
    kind: params.disputeEventId ? 39007 : 89,
    disputeEventId: params.disputeEventId,
    verdictHash: params.verdictHash,
  };
}

/**
 * Run a complete single-process FROST signing round (commit → reveal →
 * aggregate): the convenience path used by tests, simulations, and the
 * in-process court signer. Production deployments split the three steps
 * across jurors over Nostr instead.
 *
 * @returns A verified {@link FrostAttestation} (the aggregate is checked
 *          before returning; see {@link aggregateAttestation}).
 * @throws {@link FrostSigningError} on nonce reuse, malformed shares, or a
 *         failed aggregate verification.
 *
 * @example
 * ```ts
 * const attestation = runNormalSigningRound({
 *   marketId, outcome: 'YES', round: 1,
 *   verdictHash: hashDisputeVerdict({ ... }),
 *   dkg: record, shares: myShares,
 * });
 * ```
 */
export function runNormalSigningRound(
  params: SigningRoundParams,
): FrostAttestation {
  const commitments = createCommitments(params.shares);
  const reveals = createRevealsAndPartialSigs(params, commitments);
  return aggregateAttestation(params, commitments, reveals);
}
