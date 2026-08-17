/**
 * Unit tests for FrostAppealWatcher.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { FrostAppealWatcher } from '../appealWatcher';
import { generateFrostKeys, runDisputeOverrideSigning, buildDisputeAttestationEvent } from '../index';
import type { SelectedJuror, StakeCommitment } from '../types';

function makeStakeCommitment(override?: Partial<StakeCommitment>): StakeCommitment {
  return {
    amountSats: 100_000,
    bondAddress: 'bcrt1q' + randomBytes(20).toString('hex'),
    status: 'confirmed',
    committedAt: Math.floor(Date.now() / 1000),
    ...override,
  };
}

function makeSelectedJuror(idx: number): SelectedJuror {
  return {
    nostrPubkey: randomBytes(32).toString('hex'),
    stakeCapacitySats: 500_000,
    stakeCommitment: makeStakeCommitment(),
    wotScore: 85,
    categories: ['bitcoin'],
    registeredAt: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
    idx,
    priority: Math.random(),
  };
}

describe('FrostAppealWatcher', () => {
  it('validates a Kind 39007 attestation and emits a resolution', async () => {
    const marketId = randomBytes(32).toString('hex');
    const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
    const { record, shares } = generateFrostKeys({
      marketId,
      threshold: 3,
      jurors,
    });

    const dispute = {
      disputeId: randomBytes(32).toString('hex'),
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const attestation = runDisputeOverrideSigning({ dispute, dkg: record, shares: shares.slice(0, 3) });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    const watcher = new FrostAppealWatcher({ relays: [] });
    watcher.watchMarket(marketId, record.groupPubkeyXOnly);

    const onResolution = vi.fn();
    watcher.setCallbacks({ onResolution });

    const resolution = await watcher.handleEvent(event);
    expect(resolution).not.toBeNull();
    expect(resolution!.marketId).toBe(marketId);
    expect(resolution!.outcome).toBe('NO');

    // Dedup: second processing of same event returns null.
    expect(await watcher.handleEvent(event)).toBeNull();
  });

  it('rejects an attestation signed by the wrong group', async () => {
    const marketId = randomBytes(32).toString('hex');
    const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
    const { record, shares } = generateFrostKeys({
      marketId,
      threshold: 3,
      jurors,
    });

    const dispute = {
      disputeId: randomBytes(32).toString('hex'),
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'YES',
    };

    const attestation = runDisputeOverrideSigning({ dispute, dkg: record, shares: shares.slice(0, 3) });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    const watcher = new FrostAppealWatcher({ relays: [] });
    watcher.watchMarket(marketId, randomBytes(32).toString('hex')); // wrong pubkey

    const onError = vi.fn();
    watcher.setCallbacks({ onError });

    expect(await watcher.handleEvent(event)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('resolves the group pubkey from a configured resolver instead of watchMarket', async () => {
    const marketId = randomBytes(32).toString('hex');
    const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
    const { record, shares } = generateFrostKeys({
      marketId,
      threshold: 3,
      jurors,
    });

    const dispute = {
      disputeId: randomBytes(32).toString('hex'),
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const attestation = runDisputeOverrideSigning({ dispute, dkg: record, shares: shares.slice(0, 3) });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    // No watchMarket call — resolver supplies the pubkey, simulating an IndexedDB lookup.
    const watcher = new FrostAppealWatcher({
      relays: [],
      getGroupPubkey: async () => record.groupPubkeyXOnly,
    });

    const resolution = await watcher.handleEvent(event);
    expect(resolution).not.toBeNull();
    expect(resolution!.marketId).toBe(marketId);
    expect(resolution!.outcome).toBe('NO');
  });

  it('ingests a batch of events and returns valid resolutions', async () => {
    const marketId = randomBytes(32).toString('hex');
    const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
    const { record, shares } = generateFrostKeys({
      marketId,
      threshold: 3,
      jurors,
    });

    const dispute = {
      disputeId: randomBytes(32).toString('hex'),
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const attestation = runDisputeOverrideSigning({ dispute, dkg: record, shares: shares.slice(0, 3) });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    const watcher = new FrostAppealWatcher({ relays: [] });
    watcher.watchMarket(marketId, record.groupPubkeyXOnly);

    const resolutions = await watcher.handleEvents([event, event]);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].outcome).toBe('NO');
  });

  it('supports watchAll mode for resolver-backed ingestion', async () => {
    const marketId = randomBytes(32).toString('hex');
    const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
    const { record, shares } = generateFrostKeys({
      marketId,
      threshold: 3,
      jurors,
    });

    const dispute = {
      disputeId: randomBytes(32).toString('hex'),
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'YES',
    };

    const attestation = runDisputeOverrideSigning({ dispute, dkg: record, shares: shares.slice(0, 3) });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    const watcher = new FrostAppealWatcher({
      relays: [],
      getGroupPubkey: () => record.groupPubkeyXOnly,
      watchAll: true,
    });

    const resolution = await watcher.handleEvent(event);
    expect(resolution).not.toBeNull();
    expect(resolution!.outcome).toBe('YES');
  });
});
