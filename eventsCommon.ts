// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Shared vocabulary of the court Nostr event module: kind numbers, the
 * minimal event shape accepted by the builders/parsers, and the canonical
 * tag/time helpers. Extracted from `events.ts` — see that file (the
 * module barrel) for the public surface and module contract.
 *
 * Purity: pure functions and constants only; no I/O.
 */

import { isHex64 } from './courtEventParseCore';

export interface NostrEventLike {
  kind: number;
  tags: string[][];
  content: string;
  pubkey?: string;
  created_at?: number;
  id?: string;
  sig?: string;
}

/** Kind number for addressable dispute-open events (`NIP-33` parameterized replaceable). */
export const BAO_COURT_DISPUTE_KIND = 38025;
/** Kind number for juror candidacy (bond pledge) events. */
export const BAO_COURT_JUROR_CANDIDACY_KIND = 39001;
/** Kind number for published jury-selection events. */
export const BAO_COURT_SELECTION_KIND = 39002;
/** Kind number for per-juror DKG commitment (VSS + proof of knowledge) events. */
export const BAO_COURT_DKG_COMMITMENT_KIND = 38031;
/** Kind number for per-juror vote-commit (`H(outcome ‖ salt)`) events. */
export const BAO_COURT_VOTE_COMMIT_KIND = 39004;
/** Kind number for per-juror vote-reveal (outcome + salt) events. */
export const BAO_COURT_VOTE_REVEAL_KIND = 39014;
/** Kind number for per-juror FROST signing commitment (nonce package) events. */
export const BAO_COURT_FROST_COMMIT_KIND = 39005;
/** Kind number for per-juror FROST signing reveal (public nonce + partial signature) events. */
export const BAO_COURT_FROST_REVEAL_KIND = 39006;
/** Kind number for the cohort's published FROST attestation (the verdict event). */
export const BAO_COURT_ATTESTATION_KIND = 39007;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isNostrId(value: string): boolean {
  return isHex64(value);
}

export function dTag(disputeId: string, suffix?: string | number): [string, string] {
  return ['d', suffix !== undefined ? `${disputeId}:${suffix}` : disputeId];
}

/** Maximum number of evidence hashes per dispute event. */
export const MAX_EVIDENCE_HASHES = 64;

/** Maximum number of supporting event IDs per attestation. */
export const MAX_SUPPORTING_IDS = 10_000;
