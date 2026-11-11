// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Attributable FROST signing sessions (Theorem 6, docs/proofs/attribution.tex.md).
 *
 * A bare FROST aggregate is an ordinary BIP-340 Schnorr signature: it names no
 * signers, so a malicious signer who contributes to a valid-but-wrong
 * attestation faces no attribution risk. This module makes the session — not
 * the signature — the evidence: a {@link SigningJournal} publishes the round-1
 * nonce commitments, the round-2 partial signatures, the signer set, the
 * threshold, and the aggregate. Anyone can then (a) verify every partial
 * against its signer's verification share, (b) re-run the aggregate relation
 * `s = Σ s_i` (RFC 9591 §5 / `combine_partial_sigs`), and (c) check the
 * aggregate against the pinned group key. The partial that fails (a) is
 * attributable to its index, and a journal whose partials do not reconstruct
 * the published aggregate is itself the evidence of a forged record.
 *
 * Purity: pure computations over explicit inputs; no network, no I/O. The
 * append-only log that stores journals is the host's job (docs/ATTRIBUTABLE_SIGNING.md).
 *
 * Invariants: INV-ATTRIB-1..3 in docs/FORMAL_INVARIANTS.md §16.
 */

import * as frost from '@vbyte/frost';
import type { GroupSigningCtx } from '@vbyte/frost';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CourtError, type CourtErrorOptions } from './errors';
import { HEX_32 } from './courtCeremonyCore';
import { CanonicalWriter } from './courtSession';
import { isValidSecp256k1Point } from './crypto';
import type { SigningCommitment, SigningReveal } from './signing';

/** Domain string for the canonical signing-session (journal) hash. */
export const SIGNING_JOURNAL_DOMAIN = 'BAO-Court/SigningJournal/v1';

/** Failure thrown on malformed journal inputs. Code: `ATTRIBUTION`. */
export class AttributionError extends CourtError {
  constructor(message: string, options?: CourtErrorOptions) {
    super('ATTRIBUTION', message, options);
  }
}

/** One signer's round-1 commitment, as published in the journal. */
export interface JournalCommitment {
  readonly idx: number;
  /** Verification-share pubkey (x-only hex) the signer claims. */
  readonly pubkey: string;
  readonly binderPn: string;
  readonly hiddenPn: string;
}

/** One signer's round-2 partial signature, as published in the journal. */
export interface JournalPartial {
  readonly idx: number;
  readonly psig: string;
}

/** The published aggregate a journal is claimed to explain. */
export interface AggregateSignature {
  /** Group public nonce R (x-only hex, 64 chars). */
  readonly pubNonce: string;
  /** BIP-340 signature R‖s (128 hex chars). */
  readonly signature: string;
}

/** The signing-session record (one append-only journal entry). */
export interface SigningJournal {
  readonly version: 1;
  /** Signed message digest (32-byte hex) — binds the signature's context. */
  readonly message: string;
  /**
   * Group key used for aggregation. 33-byte compressed hex when available
   * (it fixes the Y-parity the partials were computed under); its x-only
   * projection MUST equal the pinned attestation key.
   */
  readonly groupPubkey: string;
  readonly threshold: number;
  /** Sorted, distinct contributing indices. */
  readonly signers: readonly JournalCommitment[];
  readonly partials: readonly JournalPartial[];
  readonly aggregate: AggregateSignature;
}

/** One attributed defect. `idx` is the signer the defect is attributable to. */
export interface AttributionFailure {
  readonly code:
    | 'STRUCTURE'
    | 'THRESHOLD'
    | 'SHARE_MISMATCH'
    | 'PARTIAL_INVALID'
    | 'R_MISMATCH'
    | 'RECONSTRUCTION_MISMATCH'
    | 'AGGREGATE_INVALID'
    | 'GROUP_KEY_MISMATCH';
  readonly idx: number | null;
  readonly detail: string;
}

/** Verification outcome. Fail-closed: tampered data yields `valid: false`. */
export interface AttributionResult {
  readonly valid: boolean;
  /** Indices whose partial verified against their verification share. */
  readonly attributed: readonly number[];
  readonly failures: readonly AttributionFailure[];
  /**
   * True when the caller pinned the certified DKG verification shares. Without
   * the pin, a journal can be self-consistent for a fabricated signer key
   * (Theorem 6, premise P1) — attribution is only as strong as the pin.
   */
  readonly identityPinned: boolean;
  /** Aggregate re-derived from the journal's partials, or null. */
  readonly reconstructedSignature: string | null;
}

export interface SigningJournalInput {
  readonly message: string;
  readonly groupPubkey: string;
  readonly threshold: number;
  readonly signerSet: readonly number[];
  readonly commitments: readonly SigningCommitment[];
  readonly partials: readonly SigningReveal[];
}

function isPoint(value: string): boolean {
  return (value.length === 64 || value.length === 66) && isValidSecp256k1Point(value);
}

function xOnly(pubkey: string): string {
  return pubkey.length === 66 ? pubkey.slice(2) : pubkey;
}

function signingContext(
  groupPubkey: string,
  signers: readonly JournalCommitment[],
  message: string,
): GroupSigningCtx {
  return frost.Lib.get_group_signing_ctx(
    groupPubkey,
    signers.map((s) => ({ idx: s.idx, binder_pn: s.binderPn, hidden_pn: s.hiddenPn })),
    message,
  );
}

function reconstruct(
  ctx: GroupSigningCtx,
  partials: readonly JournalPartial[],
  signers: readonly JournalCommitment[],
): string {
  const pubkeys = new Map(signers.map((s) => [s.idx, s.pubkey]));
  return frost.Lib.combine_partial_sigs(
    ctx,
    partials.map((p) => ({
      idx: p.idx,
      pubkey: pubkeys.get(p.idx) ?? '',
      psig: p.psig,
    })),
  );
}

/**
 * Build the canonical signing-session record from a completed round.
 *
 * `commitments` and `partials` MUST be exactly the signer subset that
 * aggregated (the same contract as `signing.ts › aggregateAttestation`): FROST
 * binding factors and Lagrange coefficients are indexed by the commitment
 * list, so extra commitments change the aggregate and fail reconstruction.
 *
 * The aggregate is recomputed from the partials, so a journal can only ever
 * describe a signature the published partials actually produce (INV-ATTRIB-2).
 */
export function buildSigningJournal(input: SigningJournalInput): SigningJournal {
  if (!HEX_32.test(input.message)) throw new AttributionError('message must be 32-byte lowercase hex');
  if (!isPoint(input.groupPubkey)) throw new AttributionError('groupPubkey must be a valid secp256k1 point');
  if (!Number.isSafeInteger(input.threshold) || input.threshold < 1) {
    throw new AttributionError('threshold must be a positive safe integer');
  }
  const indices = [...input.signerSet];
  if (indices.length === 0 || new Set(indices).size !== indices.length) {
    throw new AttributionError('signerSet must be non-empty and distinct');
  }
  if (input.threshold > indices.length) {
    throw new AttributionError(`threshold ${input.threshold} exceeds signer count ${indices.length}`);
  }
  indices.sort((a, b) => a - b);
  const signers: JournalCommitment[] = indices.map((idx) => {
    const commitment = input.commitments.filter((c) => c.idx === idx);
    const reveal = input.partials.filter((r) => r.idx === idx);
    if (commitment.length !== 1 || reveal.length !== 1) {
      throw new AttributionError(`index ${idx} must have exactly one commitment and one partial`);
    }
    const c = commitment[0]!;
    const r = reveal[0]!;
    if (xOnly(r.pubkey) !== xOnly(c.pubkey)) {
      throw new AttributionError(`index ${idx}: partial pubkey does not match its commitment`);
    }
    if (!isPoint(c.pubkey) || !isPoint(c.commit.binder_pn) || !isPoint(c.commit.hidden_pn)) {
      throw new AttributionError(`index ${idx}: malformed point in commitment`);
    }
    if (!HEX_32.test(r.psig)) throw new AttributionError(`index ${idx}: partial signature must be 32-byte hex`);
    return { idx, pubkey: r.pubkey, binderPn: c.commit.binder_pn, hiddenPn: c.commit.hidden_pn };
  });
  if (input.commitments.length !== signers.length || input.partials.length !== signers.length) {
    throw new AttributionError('commitment/partial sets must equal the signer set exactly');
  }
  const partials = signers.map((s) => ({
    idx: s.idx,
    psig: input.partials.find((r) => r.idx === s.idx)!.psig,
  }));
  const ctx = signingContext(input.groupPubkey, signers, input.message);
  const signature = reconstruct(ctx, partials, signers);
  return Object.freeze({
    version: 1 as const,
    message: input.message,
    groupPubkey: input.groupPubkey,
    threshold: input.threshold,
    signers: Object.freeze(signers.map((s) => Object.freeze(s))),
    partials: Object.freeze(partials.map((p) => Object.freeze(p))),
    aggregate: Object.freeze({ pubNonce: signature.slice(0, 64), signature }),
  });
}

/** Canonical journal hash — the RFC 9162 log leaf preimage body. */
export function hashSigningJournal(journal: SigningJournal): string {
  const writer = new CanonicalWriter();
  writer.u8(journal.version);
  writer.hex(journal.message);
  writer.hex(journal.groupPubkey);
  writer.u32(journal.threshold);
  writer.u32(journal.signers.length);
  for (const s of journal.signers) {
    writer.u32(s.idx);
    writer.hex(s.pubkey);
    writer.hex(s.binderPn);
    writer.hex(s.hiddenPn);
  }
  for (const p of journal.partials) {
    writer.u32(p.idx);
    writer.hex(p.psig);
  }
  writer.hex(journal.aggregate.pubNonce);
  writer.hex(journal.aggregate.signature);
  const prefix = new TextEncoder().encode(SIGNING_JOURNAL_DOMAIN);
  const body = writer.finish();
  const input = new Uint8Array(prefix.length + body.length);
  input.set(prefix, 0);
  input.set(body, prefix.length);
  return bytesToHex(sha256(input));
}

/**
 * Verify a journal against a published aggregate and the pinned x-only group
 * key, attributing every defect to a signer index.
 *
 * `verificationShares` is the certified DKG record's share list. Pass it
 * whenever attribution matters: it is the identity pin (premise P1) that stops
 * a fabricated journal from naming a substitute share key.
 */
export function verifyAggregateAttribution(
  journal: SigningJournal,
  aggregate: AggregateSignature,
  groupPubkey: string,
  verificationShares?: readonly { readonly idx: number; readonly pubkey: string }[],
): AttributionResult {
  const failures: AttributionFailure[] = [];
  const identityPinned = verificationShares !== undefined;
  const require = (ok: boolean, code: AttributionFailure['code'], idx: number | null, detail: string) => {
    if (!ok) failures.push({ code, idx, detail });
  };

  require(xOnly(journal.groupPubkey) === xOnly(groupPubkey) && isPoint(groupPubkey),
    'GROUP_KEY_MISMATCH', null, 'journal group key does not project to the pinned key');
  require(journal.signers.length >= journal.threshold, 'THRESHOLD', null,
    `${journal.signers.length} signers < threshold ${journal.threshold}`);
  require(journal.partials.length === journal.signers.length, 'STRUCTURE', null,
    'partial count does not equal signer count');
  const signerIds = journal.signers.map((s) => s.idx);
  const partialIds = journal.partials.map((p) => p.idx);
  require(new Set(signerIds).size === signerIds.length
    && signerIds.slice().sort((a, b) => a - b).join(',') === partialIds.slice().sort((a, b) => a - b).join(','),
  'STRUCTURE', null, 'partial index set does not equal the signer set');

  const certified = new Map((verificationShares ?? []).map((v) => [v.idx, v.pubkey]));
  const structurallySound = failures.length === 0;
  const attributed: number[] = [];
  let ctx: GroupSigningCtx | null = null;
  if (structurallySound) {
    try {
      ctx = signingContext(journal.groupPubkey, journal.signers, journal.message);
    } catch {
      require(false, 'STRUCTURE', null, 'malformed point in the journal commitment set');
    }
  }
  if (ctx) {
    for (const signer of journal.signers) {
      const partial = journal.partials.find((p) => p.idx === signer.idx);
      require(partial !== undefined, 'STRUCTURE', signer.idx, 'signer has no published partial');
      if (!partial) continue;
      const expected = certified.get(signer.idx);
      require(!identityPinned || (expected !== undefined && xOnly(expected) === xOnly(signer.pubkey)),
        'SHARE_MISMATCH', signer.idx, 'journal pubkey is not the certified verification share');
      let verified = false;
      try {
        verified = frost.Lib.verify_partial_sig(
          ctx,
          { idx: signer.idx, binder_pn: signer.binderPn, hidden_pn: signer.hiddenPn },
          signer.pubkey,
          partial.psig,
        );
      } catch {
        verified = false;
      }
      require(verified, 'PARTIAL_INVALID', signer.idx, 'partial fails its share-verification identity');
      if (verified) attributed.push(signer.idx);
    }
  }

  require(aggregate.pubNonce === aggregate.signature.slice(0, 64), 'R_MISMATCH', null,
    'pubNonce is not the signature R');
  let reconstructed: string | null = null;
  if (ctx && structurallySound) {
    try {
      reconstructed = reconstruct(ctx, journal.partials, journal.signers);
    } catch {
      require(false, 'RECONSTRUCTION_MISMATCH', null, 'malformed partial data prevents reconstruction');
    }
    require(reconstructed !== null && reconstructed === aggregate.signature,
      'RECONSTRUCTION_MISMATCH', null, 'published partials do not reconstruct the published aggregate');
    require(aggregate.pubNonce === xOnly(ctx.group_pn), 'R_MISMATCH', null,
      'aggregate R is not the group nonce of the published commitments');
    require(verifyAggregateSignature(ctx, journal.message, aggregate.signature),
      'AGGREGATE_INVALID', null, 'aggregate is not a valid Schnorr signature under the pinned key');
  }

  const valid = failures.length === 0 && attributed.length === journal.signers.length;
  return Object.freeze({
    valid,
    attributed: Object.freeze(attributed),
    failures: Object.freeze(failures.map((f) => Object.freeze(f))),
    identityPinned,
    reconstructedSignature: reconstructed,
  });
}

/** Hex decode that returns an empty array for malformed input (fail-closed). */
function hexToBytesSafe(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) {
    return new Uint8Array();
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** BIP-340 verification that fails closed on malformed hex. */
function verifyAggregateSignature(ctx: GroupSigningCtx, message: string, signature: string): boolean {
  try {
    return frost.Lib.verify_final_sig(ctx, hexToBytesSafe(message), hexToBytesSafe(signature));
  } catch {
    return false;
  }
}
