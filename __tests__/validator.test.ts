// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import { validateAttestationEvent, verifyRawSignature } from '../validator';
import { BAO_COURT_ATTESTATION_KIND } from '../events';
import { generateFrostKeys } from '../dkg';
import { runNormalSigningRound } from '../signing';
import type { SelectedJuror } from '../types';

function makeJuror(idx: number): SelectedJuror {
  return {
    idx,
    nostrPubkey: '0'.repeat(63) + String(idx),
    stakeCapacitySats: 10_000,
    stakeCommitment: {
      amountSats: 10_000,
      bondAddress: 'bc1q...',
      status: 'confirmed',
      committedAt: 1_700_000_000,
    },
    wotScore: 80,
    categories: ['world'],
    registeredAt: 1_700_000_000,
    priority: idx,
  };
}

describe('validateAttestationEvent', () => {
  const publisherSecret = generateSecretKey();
  const jurors = [makeJuror(1), makeJuror(2), makeJuror(3)];
  const { record, shares } = generateFrostKeys({
    marketId: 'demo-market',
    disputeId: 'a'.repeat(64),
    threshold: 2,
    jurors,
  });

  // Dispute attestations must certify the TALLY that produced the outcome.
  const VERDICT_HASH = '11'.repeat(32);

  function buildValidEvent() {
    const attestation = runNormalSigningRound({
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      disputeEventId: 'd'.repeat(64),
      verdictHash: VERDICT_HASH,
      dkg: record,
      shares,
    });
    expect(attestation.verdictHash).toBe(VERDICT_HASH);

    return finalizeEvent({
      kind: BAO_COURT_ATTESTATION_KIND,
      created_at: 1,
      tags: [
        ['e', 'm'.repeat(64), '', 'root'],
        ['m', 'demo-market'],
        ['p', attestation.groupPubkey],
        ['outcome', attestation.outcome],
        ['round', '1'],
        ['nonce', attestation.pubNonce],
        ['sig', attestation.signature],
        ['ver', 'FROST-BIP340-v1'],
        ['dispute', 'd'.repeat(64)],
        ['verdict', attestation.verdictHash!],
      ],
      content: JSON.stringify({
        marketId: 'demo-market',
        outcome: 'YES',
        round: '1',
        message: attestation.message,
        disputeEventId: 'd'.repeat(64),
        verdictHash: attestation.verdictHash,
      }),
    }, publisherSecret);
  }

  it('accepts a valid FROST attestation event', () => {
    const event = buildValidEvent();
    const result = validateAttestationEvent(event);
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe('YES');
  });

  it('accepts a kind-89 normal-market attestation with no dispute material', () => {
    const attestation = runNormalSigningRound({
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      dkg: record,
      shares,
    });
    expect(attestation.kind).toBe(89);
    expect(attestation.disputeEventId).toBeUndefined();

    const event = finalizeEvent({
      kind: attestation.kind,
      created_at: 1,
      tags: [
        ['e', 'm'.repeat(64), '', 'root'],
        ['m', 'demo-market'],
        ['p', attestation.groupPubkey],
        ['outcome', attestation.outcome],
        ['round', String(attestation.round)],
        ['nonce', attestation.pubNonce],
        ['sig', attestation.signature],
        ['ver', 'FROST-BIP340-v1'],
      ],
      content: JSON.stringify({
        marketId: 'demo-market',
        outcome: 'YES',
        round: String(attestation.round),
        message: attestation.message,
      }),
    }, publisherSecret);

    const result = validateAttestationEvent(event);
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe('YES');
    expect(result.disputeEventId).toBeUndefined();
  });

  it('rejects events with the wrong kind', () => {
    const event = { ...buildValidEvent(), kind: 1 };
    expect(validateAttestationEvent(event).valid).toBe(false);
  });

  it('rejects events with an invalid group pubkey', () => {
    const event = buildValidEvent();
    event.tags = event.tags.map((t) => (t[0] === 'p' ? ['p', 'bad'] : t));
    expect(validateAttestationEvent(event).valid).toBe(false);
  });

  it('rejects a signature that does not verify', () => {
    const event = buildValidEvent();
    const sigTag = event.tags.find((t) => t[0] === 'sig');
    if (sigTag) sigTag[1] = '0'.repeat(128);
    expect(validateAttestationEvent(event).valid).toBe(false);
  });

  it('rejects a verdict whose outcome was changed without a new FROST signature', () => {
    const original = buildValidEvent();
    const tags = original.tags.map((tag) => tag[0] === 'outcome' ? ['outcome', 'NO'] : [...tag]);
    const content = JSON.stringify({ ...JSON.parse(original.content), outcome: 'NO' });
    const tampered = finalizeEvent({ kind: original.kind, created_at: original.created_at, tags, content }, publisherSecret);
    expect(validateAttestationEvent(tampered).valid).toBe(false);
  });

  it('rejects duplicate authority tags and context mismatches', () => {
    const original = buildValidEvent();
    const duplicate = finalizeEvent({
      kind: original.kind,
      created_at: original.created_at,
      tags: [...original.tags, ['outcome', 'YES']],
      content: original.content,
    }, publisherSecret);
    expect(validateAttestationEvent(duplicate).valid).toBe(false);
    expect(validateAttestationEvent(original, { expectedDisputeEventId: '0'.repeat(64) }).valid).toBe(false);
    expect(validateAttestationEvent(original, { expectedMarketId: 'other' }).valid).toBe(false);
    expect(validateAttestationEvent(original, { allowedOutcomes: ['NO'] }).valid).toBe(false);
    expect(validateAttestationEvent(original, { trustedPublisherPubkeys: ['0'.repeat(64)] }).valid).toBe(false);
  });

  it('validates against an expected group pubkey', () => {
    const event = buildValidEvent();
    const attestation = runNormalSigningRound({
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      disputeEventId: 'd'.repeat(64),
      dkg: record,
      shares,
    });

    expect(validateAttestationEvent(event, attestation.groupPubkey).valid).toBe(true);
    expect(validateAttestationEvent(event, '0'.repeat(64)).valid).toBe(false);
  });

  it('rejects a dispute attestation that does not bind the verdict', () => {
    // A kind-39007 attestation WITHOUT a verdict commitment certifies an
    // outcome but not the tally that produced it — structurally invalid.
    const attestation = runNormalSigningRound({
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      disputeEventId: 'd'.repeat(64),
      dkg: record,
      shares,
    });
    const event = finalizeEvent({
      kind: BAO_COURT_ATTESTATION_KIND,
      created_at: 1,
      tags: [
        ['e', 'm'.repeat(64), '', 'root'],
        ['m', 'demo-market'],
        ['p', attestation.groupPubkey],
        ['outcome', attestation.outcome],
        ['round', '1'],
        ['nonce', attestation.pubNonce],
        ['sig', attestation.signature],
        ['ver', 'FROST-BIP340-v1'],
        ['dispute', 'd'.repeat(64)],
      ],
      content: JSON.stringify({
        marketId: 'demo-market',
        outcome: 'YES',
        round: '1',
        message: attestation.message,
        disputeEventId: 'd'.repeat(64),
      }),
    }, publisherSecret);

    const result = validateAttestationEvent(event);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/verdict hash/i);
  });

  it('rejects a verdict hash substituted after signing without a new FROST signature', () => {
    // The court signs one verdict commitment; relabeling the event to a
    // different commitment must fail the message-binding check.
    const original = buildValidEvent();
    const otherVerdict = '22'.repeat(32);
    const tags = original.tags.map((tag) =>
      tag[0] === 'verdict' ? ['verdict', otherVerdict] : [...tag],
    );
    const content = JSON.stringify({
      ...JSON.parse(original.content),
      verdictHash: otherVerdict,
    });
    const tampered = finalizeEvent(
      { kind: original.kind, created_at: original.created_at, tags, content },
      publisherSecret,
    );

    const result = validateAttestationEvent(tampered);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/verdict/i);
  });

  it('verifyRawSignature verifies a plain schnorr signature', () => {
    const message = sha256(new TextEncoder().encode('hello'));
    const messageHex = bytesToHex(message);
    const seckey = hexToBytes('0'.repeat(63) + '1');
    const pubkey = bytesToHex(schnorr.getPublicKey(seckey));
    const signature = bytesToHex(schnorr.sign(message, seckey));

    expect(verifyRawSignature(pubkey, messageHex, signature)).toBe(true);
    expect(verifyRawSignature(pubkey, messageHex, '0'.repeat(128))).toBe(false);
  });
});
