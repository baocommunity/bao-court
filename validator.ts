// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * FROST attestation validator for the BAO Court / FROST appeal layer.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { verifyEvent } from 'nostr-tools/pure';
import { BAO_COURT_ATTESTATION_KIND } from './events';
import { buildAttestationMessage, buildAttestationMessageV2 } from './crypto';
import { hashDisputeVerdict } from './courtVoteMachine';

export interface ValidationResult {
  readonly valid: boolean;
  readonly pubkey: string;
  readonly outcome?: string;
  readonly message?: string;
  readonly disputeEventId?: string;
  readonly error?: string;
}

export interface AttestationValidationContext {
  readonly expectedGroupPubkey?: string;
  readonly expectedDisputeEventId?: string;
  readonly expectedMarketId?: string;
  readonly allowedOutcomes?: readonly string[];
  readonly trustedPublisherPubkeys?: readonly string[];
}

function uniqueTag(event: Pick<NostrEvent, 'tags'>, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1 || matches[0].length !== 2 || !matches[0][1]) return null;
  return matches[0][1];
}

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

export function validateAttestationEvent(
  event: NostrEvent,
  expected?: string | AttestationValidationContext,
): ValidationResult {
  const context = typeof expected === 'string'
    ? { expectedGroupPubkey: expected }
    : (expected ?? {});
  if (event.kind !== 89 && event.kind !== BAO_COURT_ATTESTATION_KIND) {
    return { valid: false, pubkey: '', error: `Not a Kind 89 or ${BAO_COURT_ATTESTATION_KIND} attestation` };
  }

  if (!verifyEvent(event)) {
    return { valid: false, pubkey: '', error: 'Invalid Nostr event signature or id' };
  }
  if (
    context.trustedPublisherPubkeys &&
    !context.trustedPublisherPubkeys.includes(event.pubkey)
  ) {
    return { valid: false, pubkey: '', error: 'Untrusted attestation publisher' };
  }

  const pubkey = uniqueTag(event, 'p');
  const signature = uniqueTag(event, 'sig');
  const nonce = uniqueTag(event, 'nonce');
  const outcome = uniqueTag(event, 'outcome');
  const disputeEventId = uniqueTag(event, 'dispute');
  const marketId = uniqueTag(event, 'm');
  const round = uniqueTag(event, 'round');
  const verdictHash = uniqueTag(event, 'verdict');

  if (!pubkey || !signature || !nonce || !outcome || !marketId || !round) {
    return { valid: false, pubkey: '', error: 'Missing required tags' };
  }

  if (!pubkey || !isHex64(pubkey)) {
    return { valid: false, pubkey: pubkey ?? '', error: 'Invalid group pubkey' };
  }
  if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) {
    return { valid: false, pubkey, error: 'Invalid signature' };
  }
  if (!nonce || !isHex64(nonce)) {
    return { valid: false, pubkey, error: 'Invalid public nonce' };
  }
  // The nonce tag must match the R value embedded in the signature (R || s).
  if (nonce !== signature.slice(0, 64)) {
    return { valid: false, pubkey, error: 'Nonce tag does not match signature' };
  }
  // Kind 39007 attestations are dispute-scoped and must carry a dispute tag.
  if (event.kind === BAO_COURT_ATTESTATION_KIND && !disputeEventId) {
    return { valid: false, pubkey, error: 'Missing dispute tag on dispute attestation' };
  }
  // Kind 39007 attestations must bind the dispute verdict (the tally): the
  // FROST signature certifies the outcome WON the vote, not just the outcome.
  if (event.kind === BAO_COURT_ATTESTATION_KIND) {
    if (!disputeEventId) {
      return { valid: false, pubkey, error: 'Missing dispute tag on dispute attestation' };
    }
    if (!verdictHash || !isHex64(verdictHash)) {
      return { valid: false, pubkey, error: 'Missing or invalid verdict hash on dispute attestation' };
    }
    // Validate that the supporting event IDs are well-formed and bounded.
    const supportingIds = event.tags
      .filter((t) => t[0] === 'e' && t[3] === 'mention')
      .map((t) => t[1]);
    if (supportingIds.length === 0 || supportingIds.length > 10_000) {
      return { valid: false, pubkey, error: 'Dispute attestation must carry 1..10000 supporting event IDs' };
    }
    if (supportingIds.some((id) => !isHex64(id))) {
      return { valid: false, pubkey, error: 'Supporting event IDs must be 32-byte hex' };
    }
    if (new Set(supportingIds).size !== supportingIds.length) {
      return { valid: false, pubkey, error: 'Duplicate supporting event IDs' };
    }
    // The verdict commitment must recompute from the event's own dispute,
    // outcome, and supporting reveal ids — the FROST signature certifies the
    // tally, not just an outcome. Canonical ids are lowercase, so normalize
    // before recomputing (the vote machine lowercases at finalization). A
    // malformed field throws from the canonical helper; treat any failure as
    // an invalid commitment rather than propagating an exception.
    let expectedVerdictHash: string;
    try {
      expectedVerdictHash = hashDisputeVerdict({
        disputeId: disputeEventId.toLowerCase(),
        outcome,
        supportingEventIds: supportingIds.map((id) => id.toLowerCase()),
      });
    } catch {
      return { valid: false, pubkey, error: 'Verdict hash does not match the dispute verdict inputs' };
    }
    if (verdictHash.toLowerCase() !== expectedVerdictHash) {
      return { valid: false, pubkey, error: 'Verdict hash does not match the dispute verdict inputs' };
    }
  }

  if (context.expectedGroupPubkey && pubkey !== context.expectedGroupPubkey) {
    return {
      valid: false,
      pubkey,
      error: `Pubkey mismatch: expected ${context.expectedGroupPubkey}, got ${pubkey}`,
    };
  }
  if (context.expectedDisputeEventId && disputeEventId !== context.expectedDisputeEventId) {
    return { valid: false, pubkey, error: 'Dispute id mismatch' };
  }
  if (context.expectedMarketId && marketId !== context.expectedMarketId) {
    return { valid: false, pubkey, error: 'Market id mismatch' };
  }
  if (context.allowedOutcomes && !context.allowedOutcomes.includes(outcome)) {
    return { valid: false, pubkey, error: 'Outcome is not allowed' };
  }

  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const message = String(content.message || '');
    const contentOutcome = String(content.outcome ?? '');
    const contentDisputeId = typeof content.disputeEventId === 'string' ? content.disputeEventId : undefined;
    const contentVerdictHash = typeof content.verdictHash === 'string' ? content.verdictHash : undefined;
    const contentMarketId = String(content.marketId ?? '');
    const contentRound = String(content.round ?? '');

    if (!message) {
      return { valid: false, pubkey, error: 'Attestation message missing' };
    }
    if (outcome !== contentOutcome) {
      return {
        valid: false,
        pubkey,
        error: 'Outcome tag does not match content outcome',
      };
    }
    // A missing dispute tag (null) and a missing content disputeEventId
    // (undefined) are the same assertion: no dispute on this attestation.
    // Comparing the raw values would reject every kind-89 (normal-market)
    // attestation, which never carries dispute material.
    if ((disputeEventId ?? undefined) !== contentDisputeId) {
      return {
        valid: false,
        pubkey,
        error: 'Dispute tag does not match content dispute id',
      };
    }
    if (marketId !== contentMarketId || round !== contentRound) {
      return { valid: false, pubkey, error: 'Market or round tag does not match content' };
    }
    if ((verdictHash ?? undefined) !== contentVerdictHash) {
      return { valid: false, pubkey, error: 'Verdict tag does not match content verdict hash' };
    }
    const expectedMessage = buildAttestationMessage(
      marketId,
      outcome,
      round,
      disputeEventId ?? undefined,
      verdictHash ?? undefined,
    );
    if (message !== expectedMessage) {
      return { valid: false, pubkey, error: 'Attestation message does not bind verdict fields' };
    }

    const ok = schnorr.verify(
      hexToBytes(signature),
      hexToBytes(message),
      hexToBytes(pubkey),
    );
    return ok
      ? { valid: true, pubkey, outcome, message, disputeEventId: disputeEventId ?? undefined }
      : { valid: false, pubkey, error: 'Schnorr signature verification failed' };
  } catch (err) {
    return {
      valid: false,
      pubkey,
      error: `Validation exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function verifyRawSignature(
  pubkeyHex: string,
  messageHex: string,
  signatureHex: string,
): boolean {
  try {
    return schnorr.verify(
      hexToBytes(signatureHex),
      hexToBytes(messageHex),
      hexToBytes(pubkeyHex),
    );
  } catch {
    return false;
  }
}

// ─── v2: in-band finality binding ───────────────────────────────────────────
//
// The v1 validator above is FROZEN: existing attestations must verify
// forever, byte-identically. V2 attestations add the finality binding inside
// the SIGNED message (epochId / tier / threshold / signerSetRoot / attempt /
// batchMerkleRoot) so a low-tier or stale attestation can never be presented
// as a final verdict under the same standing cohort key. Use
// `validateCourtAttestation` to accept both shapes; v2 is detected by the
// presence of an `epoch` tag.

import { CanonicalWriter } from './courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const COURT_SIGNER_SET_DOMAIN = 'BAO-Court/SignerSet/v1';

/**
 * Canonical Merkle-style commitment to the signer set: the sorted,
 * deduplicated roster indices that produced a signature, length-prefixed
 * under a dedicated domain. Signing sessions publish this as the `signers`
 * tag; validators recompute it from a full signer set (or pin it directly)
 * to prove WHICH set signed — required for tier-based finality policy.
 */
export function hashSignerSetRoot(indices: readonly number[]): string {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > 10_000) {
    throw new Error('signer set must contain 1..10000 indices');
  }
  const seen = new Set<number>();
  for (const idx of indices) {
    if (!Number.isSafeInteger(idx) || idx < 1) {
      throw new Error('signer indices must be positive safe integers');
    }
    if (seen.has(idx)) {
      throw new Error('signer set must not contain duplicate indices');
    }
    seen.add(idx);
  }
  const sorted = [...indices].sort((a, b) => a - b);
  const writer = new CanonicalWriter();
  writer.u8(1);
  writer.u32(sorted.length);
  for (const idx of sorted) writer.u32(idx);
  const prefix = new TextEncoder().encode(COURT_SIGNER_SET_DOMAIN);
  const encoded = writer.finish();
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

export interface AttestationV2ValidationContext {
  readonly expectedGroupPubkey?: string;
  readonly expectedDisputeEventId?: string;
  readonly expectedMarketId?: string;
  readonly allowedOutcomes?: readonly string[];
  readonly trustedPublisherPubkeys?: readonly string[];
  /** Pin the exact epoch — rejects attestations from any other epoch. */
  readonly expectedEpoch?: number;
  /** Finality policy: reject attestations below this tier. */
  readonly minTier?: number;
  /** Finality policy: reject signer sets smaller than this threshold. */
  readonly minThreshold?: number;
  /** Pin the expected signer-set root (the `signers` tag must match). */
  readonly expectedSignerSetRoot?: string;
  /**
   * Pin the batch Merkle root — the `batch` tag must be PRESENT and match
   * (fail-closed: a v2 attestation without a `batch` tag does not satisfy
   * this pin). The signed message binds the root, so a pinned root proves
   * the group signed finality over that batch; the epoch binding of the
   * batch itself comes from separately validating the referenced kind-39018
   * batch event with the SAME `expectedEpoch` (see
   * `__tests__/adversarialCrossModule.test.ts`, SEQUENCE-1).
   */
  readonly expectedBatchMerkleRoot?: string;
  /** Full signer set — recomputes the root AND enforces `length === threshold`. */
  readonly signerSet?: readonly number[];
}

function parseV2Int(value: string, max: number, label: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) return null;
  void label;
  return parsed;
}

// v2 field bounds (hardening, security round 1): the signed message is a
// fixed-size digest, but its INPUTS are attacker-influencable via the tags.
// Without bounds a hostile relay/client can force validators to hash
// megabyte-scale marketIds/outcomes (FINDING-2, round-1 audit). The outcome
// bound mirrors the vote machine's MAX_OUTCOME_BYTES (256); the marketId and
// round bounds are generous (1024/64 bytes) so no legitimate id is affected.
// The frozen v1 validator is deliberately left unbounded (byte-compatible).
const MAX_V2_MARKET_ID_BYTES = 1024;
const MAX_V2_OUTCOME_BYTES = 256;
const MAX_V2_ROUND_BYTES = 64;
const v2FieldEncoder = new TextEncoder();

function v2FieldByteLength(value: string): number {
  return v2FieldEncoder.encode(value).length;
}

/**
 * Validate a v2 attestation: kind-89/39007 event whose signed message is the
 * v2 attestation message with the finality binding. Every v2 field must be
 * present as a tag, mirrored in content, and bound into the signed message;
 * the group signature must verify over that message.
 *
 * SECURITY (cross-module round 2): this function verifies the event against
 * ITSELF plus the caller's context pins. A valid signature proves only that
 * SOME key signed the message — it does NOT prove the key is the empaneled
 * cohort. Any consumer that derives finality, tier policy, reputation, or
 * settlement from an attestation MUST pin `expectedGroupPubkey`: without
 * that pin, an attacker-controlled key can re-sign the very same tags with
 * an ELEVATED `tier`/`threshold` and the result validates cleanly (see
 * `__tests__/adversarialCrossModule.test.ts`, SEQUENCE-3). Consumers
 * chaining a batch attestation must ALSO validate the referenced kind-39018
 * batch event with the same `expectedEpoch` and match Merkle roots
 * (SEQUENCE-1) — the `batch` tag carries only the root, not the batch's
 * epoch or cohort binding.
 */
export function validateAttestationEventV2(
  event: NostrEvent,
  context: AttestationV2ValidationContext = {},
): ValidationResult {
  if (event.kind !== 89 && event.kind !== BAO_COURT_ATTESTATION_KIND) {
    return { valid: false, pubkey: '', error: `Not a Kind 89 or ${BAO_COURT_ATTESTATION_KIND} attestation` };
  }
  if (!verifyEvent(event)) {
    return { valid: false, pubkey: '', error: 'Invalid Nostr event signature or id' };
  }
  if (
    context.trustedPublisherPubkeys &&
    !context.trustedPublisherPubkeys.includes(event.pubkey)
  ) {
    return { valid: false, pubkey: '', error: 'Untrusted attestation publisher' };
  }

  const pubkey = uniqueTag(event, 'p');
  const signature = uniqueTag(event, 'sig');
  const nonce = uniqueTag(event, 'nonce');
  const outcome = uniqueTag(event, 'outcome');
  const disputeEventId = uniqueTag(event, 'dispute');
  const marketId = uniqueTag(event, 'm');
  const round = uniqueTag(event, 'round');
  const verdictHash = uniqueTag(event, 'verdict');
  const epochTag = uniqueTag(event, 'epoch');
  const tierTag = uniqueTag(event, 'tier');
  const thresholdTag = uniqueTag(event, 'threshold');
  const signersTag = uniqueTag(event, 'signers');
  const attemptTag = uniqueTag(event, 'attempt');
  const batchTag = uniqueTag(event, 'batch');

  if (!pubkey || !signature || !nonce || !outcome || !marketId || !round) {
    return { valid: false, pubkey: '', error: 'Missing required tags' };
  }
  if (
    v2FieldByteLength(marketId) > MAX_V2_MARKET_ID_BYTES
    || v2FieldByteLength(outcome) > MAX_V2_OUTCOME_BYTES
    || v2FieldByteLength(round) > MAX_V2_ROUND_BYTES
  ) {
    return { valid: false, pubkey: '', error: 'marketId/outcome/round too long (v2 field bounds exceeded)' };
  }
  // v2 REQUIRED finality tags: a v2-shaped event missing any of these is invalid.
  if (!epochTag || !tierTag || !thresholdTag || !signersTag) {
    return { valid: false, pubkey: pubkey ?? '', error: 'Missing v2 finality tags (epoch/tier/threshold/signers)' };
  }
  if (!isHex64(pubkey) || !/^[0-9a-fA-F]{128}$/.test(signature) || !isHex64(nonce)) {
    return { valid: false, pubkey: pubkey ?? '', error: 'Invalid group pubkey, signature, or nonce' };
  }
  if (nonce !== signature.slice(0, 64)) {
    return { valid: false, pubkey, error: 'Nonce tag does not match signature' };
  }
  if (event.kind === BAO_COURT_ATTESTATION_KIND) {
    if (!disputeEventId) {
      return { valid: false, pubkey, error: 'Missing dispute tag on dispute attestation' };
    }
    if (!verdictHash || !isHex64(verdictHash)) {
      return { valid: false, pubkey, error: 'Missing or invalid verdict hash on dispute attestation' };
    }
    const supportingIds = event.tags
      .filter((t) => t[0] === 'e' && t[3] === 'mention')
      .map((t) => t[1]);
    if (supportingIds.length === 0 || supportingIds.length > 10_000) {
      return { valid: false, pubkey, error: 'Dispute attestation must carry 1..10000 supporting event IDs' };
    }
    if (supportingIds.some((id) => !isHex64(id))) {
      return { valid: false, pubkey, error: 'Supporting event IDs must be 32-byte hex' };
    }
    if (new Set(supportingIds).size !== supportingIds.length) {
      return { valid: false, pubkey, error: 'Duplicate supporting event IDs' };
    }
    // The verdict commitment must recompute from the event's own dispute,
    // outcome, and supporting ids — same rule as the frozen v1 path.
    let expectedVerdictHash: string;
    try {
      expectedVerdictHash = hashDisputeVerdict({
        disputeId: disputeEventId.toLowerCase(),
        outcome,
        supportingEventIds: supportingIds.map((id) => id.toLowerCase()),
      });
    } catch {
      return { valid: false, pubkey, error: 'Verdict hash does not match the dispute verdict inputs' };
    }
    if (verdictHash.toLowerCase() !== expectedVerdictHash) {
      return { valid: false, pubkey, error: 'Verdict hash does not match the dispute verdict inputs' };
    }
  }

  const epochId = parseV2Int(epochTag, 0xffff_ffff, 'epoch');
  const tier = parseV2Int(tierTag, 0xff, 'tier');
  const threshold = parseV2Int(thresholdTag, 0xffff_ffff, 'threshold');
  if (epochId === null || tier === null || threshold === null || threshold < 1) {
    return { valid: false, pubkey, error: 'Malformed v2 finality tags' };
  }
  if (!isHex64(signersTag)) {
    return { valid: false, pubkey, error: 'signers tag must be a 32-byte hex signer-set root' };
  }
  let attempt: number | undefined;
  if (attemptTag) {
    const parsed = parseV2Int(attemptTag, 0xffff_ffff, 'attempt');
    if (parsed === null || parsed === undefined) {
      return { valid: false, pubkey, error: 'Malformed attempt tag' };
    }
    attempt = parsed;
  }
  const batchMerkleRoot = batchTag ?? undefined;
  if (batchTag && !isHex64(batchTag)) {
    return { valid: false, pubkey, error: 'batch tag must be a 32-byte hex Merkle root' };
  }

  if (context.expectedGroupPubkey && pubkey !== context.expectedGroupPubkey) {
    return { valid: false, pubkey, error: `Pubkey mismatch: expected ${context.expectedGroupPubkey}, got ${pubkey}` };
  }
  // FINDING-3 (security round 1): these three context pins are declared on
  // AttestationV2ValidationContext but were never enforced on the v2 path —
  // an attestation for a different market, dispute, or a non-allowed
  // outcome validated. Enforce the same scope checks as the frozen v1 path.
  if (context.expectedDisputeEventId && disputeEventId !== context.expectedDisputeEventId) {
    return { valid: false, pubkey, error: 'Dispute id mismatch' };
  }
  if (context.expectedMarketId && marketId !== context.expectedMarketId) {
    return { valid: false, pubkey, error: 'Market id mismatch' };
  }
  if (context.allowedOutcomes && !context.allowedOutcomes.includes(outcome)) {
    return { valid: false, pubkey, error: 'Outcome is not allowed' };
  }
  if (context.expectedEpoch !== undefined && epochId !== context.expectedEpoch) {
    return { valid: false, pubkey, error: `Epoch mismatch: expected ${context.expectedEpoch}, got ${epochId}` };
  }
  if (context.minTier !== undefined && tier < context.minTier) {
    return { valid: false, pubkey, error: `Tier ${tier} below finality policy minimum ${context.minTier}` };
  }
  if (context.minThreshold !== undefined && threshold < context.minThreshold) {
    return { valid: false, pubkey, error: `Threshold ${threshold} below finality policy minimum ${context.minThreshold}` };
  }
  if (context.expectedSignerSetRoot && signersTag !== context.expectedSignerSetRoot) {
    return { valid: false, pubkey, error: 'Signer-set root mismatch' };
  }
  if (context.expectedBatchMerkleRoot !== undefined && (batchTag ?? undefined) !== context.expectedBatchMerkleRoot) {
    return { valid: false, pubkey, error: 'Batch Merkle root mismatch' };
  }
  if (context.signerSet) {
    let recomputed: string;
    try {
      recomputed = hashSignerSetRoot(context.signerSet);
    } catch (err) {
      return { valid: false, pubkey, error: `Invalid signer set: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (recomputed !== signersTag) {
      return { valid: false, pubkey, error: 'Provided signer set does not hash to the signers tag' };
    }
    if (context.signerSet.length !== threshold) {
      return { valid: false, pubkey, error: `Signer set size ${context.signerSet.length} does not match threshold ${threshold}` };
    }
  }

  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const message = String(content.message || '');
    if (!message) {
      return { valid: false, pubkey, error: 'Attestation message missing' };
    }
    const contentStr = (key: string): string | undefined =>
      typeof content[key] === 'string' ? String(content[key]) : undefined;
    const consistency: Array<readonly [string, string | undefined, string | undefined]> = [
      ['outcome', outcome, String(content.outcome ?? '')],
      ['marketId', marketId, String(content.marketId ?? '')],
      ['round', round, String(content.round ?? '')],
      ['disputeEventId', disputeEventId ?? undefined, contentStr('disputeEventId')],
      ['verdictHash', verdictHash ?? undefined, contentStr('verdictHash')],
      ['epoch', epochTag, contentStr('epoch')],
      ['tier', tierTag, contentStr('tier')],
      ['threshold', thresholdTag, contentStr('threshold')],
      ['signerSetRoot', signersTag, contentStr('signerSetRoot')],
      ['attempt', attemptTag ?? undefined, contentStr('attempt')],
      ['batchMerkleRoot', batchTag ?? undefined, contentStr('batchMerkleRoot')],
    ];
    for (const [label, tagValue, contentValue] of consistency) {
      if ((tagValue ?? undefined) !== (contentValue ?? undefined)) {
        return { valid: false, pubkey, error: `${label} tag does not match content` };
      }
    }
    const expectedMessage = buildAttestationMessageV2({
      marketId,
      outcome,
      round,
      disputeEventId: disputeEventId ?? undefined,
      verdictHash: verdictHash ?? undefined,
      epochId,
      tier,
      threshold,
      signerSetRoot: signersTag,
      attempt,
      batchMerkleRoot,
    });
    if (message !== expectedMessage) {
      return { valid: false, pubkey, error: 'Attestation message does not bind v2 finality fields' };
    }
    const ok = schnorr.verify(
      hexToBytes(signature),
      hexToBytes(message),
      hexToBytes(pubkey),
    );
    return ok
      ? { valid: true, pubkey, outcome, message, disputeEventId: disputeEventId ?? undefined }
      : { valid: false, pubkey, error: 'Schnorr signature verification failed' };
  } catch (err) {
    return {
      valid: false,
      pubkey,
      error: `Validation exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * v2-only finality policy fields: the frozen v1 validator cannot enforce
 * these, so the dispatcher refuses a v1-shaped event when any is requested.
 */
const V2_ONLY_POLICY_FIELDS = [
  'expectedEpoch',
  'minTier',
  'minThreshold',
  'expectedSignerSetRoot',
  'expectedBatchMerkleRoot',
  'signerSet',
] as const;

/**
 * Shape dispatcher: v2 events (carrying an `epoch` tag) go through the v2
 * finality validation; everything else takes the frozen v1 path.
 *
 * SECURITY (cross-module round 2): whichever path runs, the validator only
 * proves the event is INTERNALLY consistent plus whatever the caller pinned.
 * A valid result does NOT identify the signer as the empaneled cohort —
 * consumers MUST pass `expectedGroupPubkey` (and, for v2 finality policy,
 * `expectedEpoch` / `minTier` / `minThreshold` / `expectedSignerSetRoot` /
 * `expectedBatchMerkleRoot`) or any fresh key can re-sign elevated-tier
 * tags past this check. See the v2 docstring and
 * `__tests__/adversarialCrossModule.test.ts`, SEQUENCE-3.
 *
 * FINDING-1 (security round 1): the frozen v1 validator knows nothing about
 * the v2-only finality policy fields. Silently passing a v1-shaped event to
 * it while the caller pinned `expectedEpoch` / `minTier` /
 * `minThreshold` / `expectedSignerSetRoot` / `signerSet` would let a stale
 * or low-tier legacy attestation validate under v2 policy it never satisfied.
 * The dispatcher therefore fails closed: v2 policy on a v1-shaped event is a
 * downgrade and is rejected, not ignored.
 */
export function validateCourtAttestation(
  event: NostrEvent,
  expected?: string | AttestationValidationContext | AttestationV2ValidationContext,
): ValidationResult {
  const context = typeof expected === 'string' ? { expectedGroupPubkey: expected } : (expected ?? {});
  if (event.tags.some((tag) => tag[0] === 'epoch')) {
    return validateAttestationEventV2(event, context as AttestationV2ValidationContext);
  }
  const requested = context as Record<string, unknown>;
  if (V2_ONLY_POLICY_FIELDS.some((key) => requested[key] !== undefined)) {
    return {
      valid: false,
      pubkey: '',
      error:
        'v1 attestation (no epoch tag) cannot satisfy v2 finality policy (expectedEpoch/minTier/minThreshold/expectedSignerSetRoot/expectedBatchMerkleRoot/signerSet) — downgrade refused',
    };
  }
  return validateAttestationEvent(event, context as AttestationValidationContext);
}
