// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { BAO_COURT_ATTESTATION_KIND } from '../events';
import { buildAttestationMessageV2 } from '../crypto';
import { hashDisputeVerdict } from '../courtVoteMachine';
import {
  COURT_SIGNER_SET_DOMAIN,
  hashSignerSetRoot,
  validateAttestationEventV2,
  validateCourtAttestation,
} from '../validator';
import { CanonicalWriter } from '../courtSession';
import { sha256 } from '@noble/hashes/sha2.js';

const hex = (c: string): string => c.repeat(64);

const kp = (): { sec: Uint8Array; pub: string } => {
  const sec = randomBytes(32);
  return { sec, pub: bytesToHex(schnorr.getPublicKey(sec)) };
};

interface V2Fields {
  marketId: string;
  outcome: string;
  round: string;
  disputeEventId?: string;
  verdictHash?: string;
  epochId: number;
  tier: number;
  threshold: number;
  signerSetRoot: string;
  attempt?: number;
  batchMerkleRoot?: string;
}

function buildV2Event(fields: V2Fields, signer: { sec: Uint8Array; pub: string }, publisherSecret: Uint8Array = generateSecretKey()): NostrEvent {
  const message = buildAttestationMessageV2({
    marketId: fields.marketId,
    outcome: fields.outcome,
    round: Number(fields.round),
    disputeEventId: fields.disputeEventId,
    verdictHash: fields.verdictHash,
    epochId: fields.epochId,
    tier: fields.tier,
    threshold: fields.threshold,
    signerSetRoot: fields.signerSetRoot,
    attempt: fields.attempt,
    batchMerkleRoot: fields.batchMerkleRoot,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signer.sec));
  const tags: string[][] = [
    ['m', fields.marketId],
    ['p', signer.pub],
    ['outcome', fields.outcome],
    ['round', fields.round],
    ['nonce', signature.slice(0, 64)],
    ['sig', signature],
    ['epoch', String(fields.epochId)],
    ['tier', String(fields.tier)],
    ['threshold', String(fields.threshold)],
    ['signers', fields.signerSetRoot],
  ];
  if (fields.disputeEventId) tags.push(['dispute', fields.disputeEventId]);
  if (fields.verdictHash) tags.push(['verdict', fields.verdictHash]);
  if (fields.attempt !== undefined) tags.push(['attempt', String(fields.attempt)]);
  if (fields.batchMerkleRoot) tags.push(['batch', fields.batchMerkleRoot]);
  return finalizeEvent({
    kind: 89,
    created_at: 1,
    tags,
    content: JSON.stringify({
      marketId: fields.marketId,
      outcome: fields.outcome,
      round: fields.round,
      message,
      disputeEventId: fields.disputeEventId,
      verdictHash: fields.verdictHash,
      epoch: String(fields.epochId),
      tier: String(fields.tier),
      threshold: String(fields.threshold),
      signerSetRoot: fields.signerSetRoot,
      attempt: fields.attempt !== undefined ? String(fields.attempt) : undefined,
      batchMerkleRoot: fields.batchMerkleRoot,
    }),
  }, publisherSecret);
}

const SIGNERS = [1, 2, 3];
const SIGNERS_ROOT = hashSignerSetRoot(SIGNERS);

const BASE: V2Fields = {
  marketId: 'demo-market',
  outcome: 'YES',
  round: '0',
  epochId: 14,
  tier: 0,
  threshold: 3,
  signerSetRoot: SIGNERS_ROOT,
};

describe('hashSignerSetRoot', () => {
  it('is order-independent and duplicate-rejecting', () => {
    expect(hashSignerSetRoot([3, 1, 2])).toBe(hashSignerSetRoot([1, 2, 3]));
    expect(() => hashSignerSetRoot([1, 1, 2])).toThrow(/duplicate/);
    expect(() => hashSignerSetRoot([])).toThrow(/1..10000/);
    expect(() => hashSignerSetRoot([0])).toThrow(/positive/);
  });

  it('matches an independent canonical recomputation', () => {
    const writer = new CanonicalWriter();
    writer.u8(1);
    writer.u32(3);
    writer.u32(1);
    writer.u32(2);
    writer.u32(3);
    const prefix = new TextEncoder().encode(COURT_SIGNER_SET_DOMAIN);
    const encoded = writer.finish();
    const input = new Uint8Array(prefix.length + encoded.length);
    input.set(prefix, 0);
    input.set(encoded, prefix.length);
    expect(hashSignerSetRoot([2, 3, 1])).toBe(bytesToHex(sha256(input)));
  });
});

describe('validateAttestationEventV2', () => {
  it('accepts a fully-bound v2 attestation', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    const result = validateAttestationEventV2(event, {
      expectedGroupPubkey: signer.pub,
      expectedEpoch: 14,
      minTier: 0,
      minThreshold: 3,
      expectedSignerSetRoot: SIGNERS_ROOT,
      signerSet: [1, 2, 3],
    });
    expect(result.valid).toBe(true);
  });

  it('enforces finality policy pins', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    expect(validateAttestationEventV2(event, { expectedEpoch: 15 }).valid).toBe(false);
    expect(validateAttestationEventV2(event, { minTier: 1 }).valid).toBe(false);
    expect(validateAttestationEventV2(event, { minThreshold: 4 }).valid).toBe(false);
    expect(validateAttestationEventV2(event, { expectedSignerSetRoot: hashSignerSetRoot([1, 2, 4]) }).valid).toBe(false);
    expect(validateAttestationEventV2(event, { expectedGroupPubkey: hex('d') }).valid).toBe(false);
  });

  it('rejects a signer set that does not match the signers tag or the threshold', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    expect(validateAttestationEventV2(event, { signerSet: [1, 2] }).valid).toBe(false); // wrong root
    expect(validateAttestationEventV2(event, { signerSet: [1, 2, 4] }).valid).toBe(false); // wrong root
    expect(validateAttestationEventV2(event, { signerSet: SIGNERS }).valid).toBe(true);
  });

  it('rejects missing v2 tags, malformed ints, and nonce mismatch', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    const strip = (name: string): NostrEvent =>
      finalizeEvent({
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags.filter((t) => t[0] !== name),
        content: event.content,
      }, signer.sec);
    for (const name of ['epoch', 'tier', 'threshold', 'signers']) {
      expect(validateAttestationEventV2(strip(name), {}).valid).toBe(false);
    }
    const badTag = (name: string, value: string): NostrEvent =>
      finalizeEvent({
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags.map((t) => (t[0] === name ? [name, value] : t)),
        content: event.content,
      }, signer.sec);
    expect(validateAttestationEventV2(badTag('epoch', 'x'), {}).valid).toBe(false);
    expect(validateAttestationEventV2(badTag('tier', '256'), {}).valid).toBe(false);
    expect(validateAttestationEventV2(badTag('threshold', '0'), {}).valid).toBe(false);
    expect(validateAttestationEventV2(badTag('signers', 'zz'), {}).valid).toBe(false);
    expect(validateAttestationEventV2(badTag('sig', 'f'.repeat(128)), {}).valid).toBe(false);
  });

  it('rejects content/tag divergence on any v2 field', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    const content = JSON.parse(event.content) as Record<string, unknown>;
    const tampered = finalizeEvent(
      { kind: event.kind, created_at: event.created_at, tags: event.tags, content: JSON.stringify({ ...content, epoch: '15' }) },
      signer.sec,
    );
    expect(validateAttestationEventV2(tampered, {}).valid).toBe(false);
  });

  it('binds the dispute verdict on kind-39007 v2 attestations', () => {
    const signer = kp();
    const supportIds = [hex('e'), hex('f')];
    const verdictHash = hashDisputeVerdict({
      disputeId: hex('d'),
      outcome: 'YES',
      supportingEventIds: supportIds,
    });
    const fields: V2Fields = {
      ...BASE,
      disputeEventId: hex('d'),
      verdictHash,
    };
    const good = buildV2Event(fields, signer);
    // Kind must be 39007 for dispute semantics — patch the builder output.
    const asDispute: NostrEvent = { ...good, kind: BAO_COURT_ATTESTATION_KIND };
    // kind change invalidates the id/signature → rebuild via finalize:
    const message = String((JSON.parse(good.content) as Record<string, unknown>).message);
    const disputeEvent = finalizeEvent({
      kind: BAO_COURT_ATTESTATION_KIND,
      created_at: good.created_at,
      tags: [...good.tags.filter((t) => t[0] !== 'e'), ...supportIds.map((id) => ['e', id, '', 'mention'])],
      content: good.content,
    }, signer.sec);
    // The group signature is by the signer key in the p tag — publisher
    // identity is irrelevant unless trustedPublisherPubkeys pins it.
    expect(validateAttestationEventV2(disputeEvent, {}).valid).toBe(true);

    // Wrong verdict hash (does not recompute from dispute inputs) must fail.
    const wrong = buildV2Event({ ...fields, verdictHash: hex('9') }, signer);
    const wrongDispute = finalizeEvent({
      kind: BAO_COURT_ATTESTATION_KIND,
      created_at: wrong.created_at,
      tags: [...wrong.tags.filter((t) => t[0] !== 'e'), ...supportIds.map((id) => ['e', id, '', 'mention'])],
      content: wrong.content,
    }, signer.sec);
    expect(validateAttestationEventV2(wrongDispute, {}).valid).toBe(false);
  });

  it('detects signature tampering via the signed message', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    const tamperedFields = { ...BASE, outcome: 'NO' };
    // Rebuild with a different outcome but keep the ORIGINAL signature tags:
    const message = buildAttestationMessageV2({
      marketId: tamperedFields.marketId,
      outcome: tamperedFields.outcome,
      round: Number(tamperedFields.round),
      epochId: tamperedFields.epochId,
      tier: tamperedFields.tier,
      threshold: tamperedFields.threshold,
      signerSetRoot: tamperedFields.signerSetRoot,
    });
    const forged = finalizeEvent({
      kind: 89,
      created_at: event.created_at,
      tags: event.tags.map((t) => (t[0] === 'outcome' ? ['outcome', 'NO'] : t)),
      content: JSON.stringify({ ...(JSON.parse(event.content) as Record<string, unknown>), outcome: 'NO', message }),
    }, signer.sec);
    // The publisher re-signed the ENVELOPE but the group signature is over
    // the YES message — content/message/outcome all consistent as NO, yet
    // the group sig was made over YES's message... rebuilt message differs
    // → the sig no longer verifies.
    expect(validateAttestationEventV2(forged, {}).valid).toBe(false);
  });
});

describe('validateCourtAttestation dispatcher', () => {
  it('routes v2 events (epoch tag) to the v2 validator', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    expect(validateCourtAttestation(event, { expectedEpoch: 14 }).valid).toBe(true);
    expect(validateCourtAttestation(event, { expectedEpoch: 15 }).valid).toBe(false);
  });

  it('routes legacy events (no epoch tag) through the frozen v1 path', () => {
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    const legacy = finalizeEvent(
      { kind: 89, created_at: v2.created_at, tags: v2.tags.filter((t) => t[0] !== 'epoch'), content: v2.content },
      signer.sec,
    );
    // Legacy path: content carries epoch but tags do not → v1 semantics.
    // The v1 validator recomputes the v1 message, which differs from the
    // stored v2 message → invalid (expected: this hybrid is neither shape).
    expect(validateCourtAttestation(legacy).valid).toBe(false);
  });
});
