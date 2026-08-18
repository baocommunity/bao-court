// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Dispute override signing for the BAO Court / FROST appeal layer.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import * as frost from '@vbyte/frost';
import { CanonicalWriter } from './courtSession';
import { runNormalSigningRound } from './signing';
import type { DkgRecord, DisputeCase, FrostAttestation, JurorVote } from './types';

/** Same domain tag as the machine-path vote commit (courtVoteMachine). */
const VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';

/**
 * Commit hash for the imperative vote path: H(domain, outcome, salt) with
 * canonical length-prefixed encoding. The old `${outcome}|${salt}` join was
 * ambiguous — an outcome containing `|` could alias the salt and let two
 * distinct ballots commit to the same digest.
 */
export function hashCommit(outcome: string, salt: string): string {
  const writer = new CanonicalWriter();
  writer.text(outcome);
  writer.text(salt);
  const encoded = writer.finish();
  const domain = new TextEncoder().encode(VOTE_COMMIT_DOMAIN);
  const input = new Uint8Array(domain.length + encoded.length);
  input.set(domain, 0);
  input.set(encoded, domain.length);
  return bytesToHex(sha256(input));
}

export interface TallyResult {
  readonly outcome: string;
  readonly supportingVotes: JurorVote[];
  /**
   * Revealed votes whose commit-reveal hash did not match. They are excluded
   * from the tally (matching CourtVoteMachine, which refuses a mismatched
   * reveal at accept time) and surfaced here as slashing evidence. A single
   * malformed or malicious reveal must not abort the whole count.
   */
  readonly invalidReveals: JurorVote[];
}

export function tallyVotes(
  votes: readonly JurorVote[],
): TallyResult {
  const counts = new Map<string, JurorVote[]>();
  const invalidReveals: JurorVote[] = [];
  for (const v of votes) {
    if (!v.reveal) continue;
    if (hashCommit(v.reveal.outcome, v.reveal.salt) !== v.commit) {
      invalidReveals.push(v);
      continue;
    }
    const list = counts.get(v.reveal.outcome) ?? [];
    list.push(v);
    counts.set(v.reveal.outcome, list);
  }

  let winner = '';
  let max = -1;
  // Deterministic, order-independent tie-break: on equal counts the
  // lexicographically smallest outcome wins. This MUST match
  // courtVoteMachine.finalize_tally so every observer derives the same
  // verdict regardless of reveal arrival order.
  for (const [outcome, list] of counts.entries()) {
    if (list.length > max || (list.length === max && outcome < winner)) {
      max = list.length;
      winner = outcome;
    }
  }

  return {
    outcome: winner,
    supportingVotes: counts.get(winner) ?? [],
    invalidReveals,
  };
}

/**
 * Derive a deterministic x-only pubkey from the normal group key + dispute id.
 *
 * WARNING: the derivation maps public inputs to a scalar, so the private key
 * of the returned pubkey is PUBLICLY COMPUTABLE (known discrete log). This
 * key is NOT threshold-protected and must NEVER be used to accept FROST
 * attestation signatures — anyone could sign for it. It exists for demo
 * contracts that need a deterministic dispute key; keep it out of any path
 * that authenticates real value.
 */
export function deriveDisputeGroupPubkey(
  normalGroupPubkey: string,
  disputeId: string,
): string {
  const order = secp256k1.Point.Fn.ORDER;
  let digest = sha256(new TextEncoder().encode(normalGroupPubkey + disputeId));
  let scalar = bytesToNumberBE(digest) % order;
  // Re-hash on the astronomically unlikely zero scalar to guarantee a valid key.
  while (scalar === 0n) {
    digest = sha256(digest);
    scalar = bytesToNumberBE(digest) % order;
  }
  const scalarBytes = numberToBytesBE(scalar, 32);
  const pk = schnorr.getPublicKey(scalarBytes);
  return bytesToHex(pk);
}

export interface DisputeSigningParams {
  readonly dispute: DisputeCase;
  readonly dkg: DkgRecord;
  readonly shares: readonly frost.SecretShare[];
  /** Outcome to attest. Defaults to the dispute's proposed outcome. */
  readonly outcome?: string;
  /**
   * Dispute verdict commitment bound into the signed message. REQUIRED for
   * real dispute attestations — see {@link buildAttestationMessage}.
   */
  readonly verdictHash?: string;
  /** Supporting reveal event ids of the attested verdict. */
  readonly supportingEventIds?: readonly string[];
}

export function runDisputeOverrideSigning(
  params: DisputeSigningParams,
): FrostAttestation {
  const attestation = runNormalSigningRound({
    marketId: params.dispute.marketId,
    outcome: params.outcome ?? params.dispute.proposedOutcome,
    round: 1,
    disputeEventId: params.dispute.disputeId,
    verdictHash: params.verdictHash,
    dkg: params.dkg,
    shares: params.shares,
  });

  return {
    ...attestation,
    kind: 39007,
    disputeEventId: params.dispute.disputeId,
    verdictHash: params.verdictHash,
    supportingEventIds: params.supportingEventIds,
  };
}

/**
 * Canonical synthetic reveal event id for SIMULATED ceremonies (the demo
 * coordinator and the end-to-end simulator run the vote in-process, so no
 * Nostr reveal events exist to reference). Production ceremonies MUST use the
 * real kind-39014 reveal event ids — the commitment is over the same field,
 * so swapping in real ids changes nothing structurally.
 */
export function deriveSimulatedRevealEventId(idx: number, outcome: string, salt: string): string {
  const writer = new CanonicalWriter();
  writer.u32(idx);
  writer.text(outcome);
  writer.text(salt);
  const encoded = writer.finish();
  const domain = new TextEncoder().encode('BAO-Court/SimRevealEvent/v1');
  const input = new Uint8Array(domain.length + encoded.length);
  input.set(domain, 0);
  input.set(encoded, domain.length);
  return bytesToHex(sha256(input));
}
