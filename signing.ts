// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * FROST threshold signing for the BAO Court / FROST appeal layer.
 */

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

export interface SigningRoundParams {
  readonly marketId: string;
  readonly outcome: string;
  readonly round: number | string;
  readonly disputeEventId?: string;
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
      throw new Error('localStorage is not available; provide an in-memory NonceGuard');
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
    throw new Error(
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
    throw new Error(`Partial signature from juror ${share.idx} failed verification`);
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

export function aggregateAttestation(
  params: SigningRoundParams,
  commitments: readonly SigningCommitment[],
  reveals: readonly SigningReveal[],
): FrostAttestation {
  const message = buildAttestationMessage(
    params.marketId,
    params.outcome,
    params.round,
    params.disputeEventId,
  );

  const ctx = frost.Lib.get_group_signing_ctx(
    params.dkg.groupPubkey,
    commitments.map((c) => c.commit),
    message,
  );

  if (reveals.length < params.dkg.threshold) {
    throw new Error(
      `Insufficient reveals: ${reveals.length} < threshold ${params.dkg.threshold}`,
    );
  }

  const seenIndices = new Set<number>();
  for (const reveal of reveals) {
    if (seenIndices.has(reveal.idx)) {
      throw new Error(`Duplicate reveal from juror ${reveal.idx}`);
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
      throw new Error(`Partial signature from juror ${reveal.idx} is invalid`);
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
    throw new Error('Final aggregated signature failed verification');
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
  };
}

export function runNormalSigningRound(
  params: SigningRoundParams,
): FrostAttestation {
  const commitments = createCommitments(params.shares);
  const reveals = createRevealsAndPartialSigs(params, commitments);
  return aggregateAttestation(params, commitments, reveals);
}
