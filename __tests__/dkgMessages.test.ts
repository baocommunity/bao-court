// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  buildEncryptedShareEvent,
  buildDkgComplaintEvent,
  buildShareBackupEvent,
  parseEncryptedShareEvent,
  parseDkgComplaintEvent,
  parseShareBackupEvent,
  BAO_COURT_ENCRYPTED_SHARE_KIND,
  BAO_COURT_DKG_COMPLAINT_KIND,
  BAO_COURT_SHARE_BACKUP_KIND,
} from '../dkgMessages';

describe('DKG message builders', () => {
  const disputeId = 'd'.repeat(64);

  it('builds and parses an encrypted VSS share event', () => {
    const payload = {
      disputeId,
      fromIdx: 1,
      fromPubkey: 'a'.repeat(64),
      toIdx: 2,
      toPubkey: 'b'.repeat(64),
      encryptedShare: 'encrypted-payload',
      phaseNonce: 'nonce-1',
    };

    const event = buildEncryptedShareEvent(payload);
    expect(event.kind).toBe(BAO_COURT_ENCRYPTED_SHARE_KIND);
    expect(event.tags).toContainEqual(['d', `${disputeId}:1:2`]);
    expect(event.tags).toContainEqual(['from', '1', 'a'.repeat(64)]);
    expect(event.tags).toContainEqual(['to', '2', 'b'.repeat(64)]);

    const parsed = parseEncryptedShareEvent(event);
    expect(parsed).toEqual(payload);
  });

  it('builds and parses a DKG complaint event', () => {
    const complaint = {
      disputeId,
      accusedIdx: 1,
      accusedPubkey: 'a'.repeat(64),
      victimIdx: 2,
      victimPubkey: 'b'.repeat(64),
      revealedShare: 'deadbeef',
      commitmentEventId: 'e'.repeat(64),
    };

    const event = buildDkgComplaintEvent(complaint);
    expect(event.kind).toBe(BAO_COURT_DKG_COMPLAINT_KIND);
    expect(event.tags).toContainEqual(['d', `${disputeId}:2:1`]);
    expect(event.tags).toContainEqual(['accused', '1', 'a'.repeat(64)]);
    expect(event.tags).toContainEqual(['victim', '2', 'b'.repeat(64)]);
    expect(event.tags).toContainEqual(['commitment', 'e'.repeat(64)]);

    const parsed = parseDkgComplaintEvent(event);
    expect(parsed).toMatchObject(complaint);
    expect(parsed?.defense).toBeUndefined();
  });

  it('builds and parses a DKG complaint with defense', () => {
    const defense = {
      decryptionProof: 'proof',
      validShare: 'cafe',
      defendedAt: 1_700_000_000,
    };
    const complaint = {
      disputeId,
      accusedIdx: 1,
      accusedPubkey: 'a'.repeat(64),
      victimIdx: 2,
      victimPubkey: 'b'.repeat(64),
      revealedShare: 'deadbeef',
      commitmentEventId: 'e'.repeat(64),
      defense,
    };

    const event = buildDkgComplaintEvent(complaint);
    const parsed = parseDkgComplaintEvent(event);
    expect(parsed?.defense).toEqual(defense);
  });

  it('builds and parses an encrypted share backup event', () => {
    const payload = {
      disputeId,
      jurorIdx: 1,
      jurorPubkey: 'a'.repeat(64),
      encryptedShare: 'encrypted-share',
      groupPubkey: 'g'.repeat(66),
      verificationShares: [{ idx: 1, pubkey: 'v'.repeat(64) }],
      vssCommitments: [{ idx: 1, pubkey: 'a'.repeat(64), commits: ['c'.repeat(66)] }],
    };

    const event = buildShareBackupEvent(payload);
    expect(event.kind).toBe(BAO_COURT_SHARE_BACKUP_KIND);
    expect(event.tags).toContainEqual(['d', `${disputeId}:1`]);

    const parsed = parseShareBackupEvent(event);
    expect(parsed).toEqual(payload);
  });
});
