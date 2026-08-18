// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * FROST attestation validator for the BAO Court / FROST appeal layer.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { verifyEvent } from 'nostr-tools/pure';
import { BAO_COURT_ATTESTATION_KIND } from './events';
import { buildAttestationMessage } from './crypto';

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
    if (!verdictHash || !isHex64(verdictHash)) {
      return { valid: false, pubkey, error: 'Missing or invalid verdict hash on dispute attestation' };
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
