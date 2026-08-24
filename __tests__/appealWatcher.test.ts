/**
 * Unit tests for FrostAppealWatcher.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools';
import { FrostAppealWatcher, type FrostWatcherRelayPool } from '../appealWatcher';
import {
  generateFrostKeys,
  runDisputeOverrideSigning,
  buildDisputeAttestationEvent,
  hashDisputeVerdict,
  deriveSimulatedRevealEventId,
} from '../index';
import type { SelectedJuror, StakeCommitment } from '../types';

/**
 * Derive the verdict commitment exactly like the coordinator does at tally
 * time (synthetic reveal event ids for the in-process ceremony), so these
 * tests exercise the real evidence-based flow end to end.
 */
function makeVerdictCommitment(disputeId: string, outcome: string): {
  verdictHash: string;
  supportingEventIds: string[];
} {
  const supportingEventIds = [1, 2, 3].map((idx) =>
    deriveSimulatedRevealEventId(idx, outcome, `salt-${idx}`),
  );
  return {
    verdictHash: hashDisputeVerdict({ disputeId, outcome, supportingEventIds }),
    supportingEventIds,
  };
}

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

    const { verdictHash, supportingEventIds } = makeVerdictCommitment(dispute.disputeId, dispute.proposedOutcome);
    const attestation = runDisputeOverrideSigning({
      dispute,
      dkg: record,
      shares: shares.slice(0, 3),
      verdictHash,
      supportingEventIds,
    });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    // Host-injected pool capturing the live-subscription handler — the only
    // path where onResolution fires — so the emit wiring is genuinely driven.
    let onevent: ((event: NostrEvent) => void) | undefined;
    const closeSubscription = vi.fn();
    const fakePool: FrostWatcherRelayPool = {
      subscribeMany(_relays, _filter, handlers) {
        onevent = handlers.onevent;
        return { close: closeSubscription };
      },
    };

    const watcher = new FrostAppealWatcher({ relays: ['wss://fake.example'], pool: fakePool });
    watcher.watchMarket(marketId, record.groupPubkeyXOnly);

    const onResolution = vi.fn();
    watcher.setCallbacks({ onResolution });

    watcher.start();
    expect(onevent).toBeDefined();

    // Deliver through the subscription path.
    onevent!(event);
    await vi.waitFor(() => expect(onResolution).toHaveBeenCalledTimes(1));
    expect(onResolution.mock.calls[0]?.[0]).toMatchObject({
      marketId,
      outcome: 'NO',
      disputeEventId: dispute.disputeId,
      eventId: event.id,
    });

    // Dedup: redelivery neither re-validates into a second emit nor
    // resolves again via direct handling.
    onevent!(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onResolution).toHaveBeenCalledTimes(1);
    expect(await watcher.handleEvent(event)).toBeNull();

    watcher.stop();
    // stop() must tear down the live subscription exactly once.
    expect(closeSubscription).toHaveBeenCalledTimes(1);
  });

  it('dedups concurrent duplicate deliveries racing through the async pubkey resolver', async () => {
    const marketId = randomBytes(32).toString('hex');
    const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
    const { record, shares } = generateFrostKeys({ marketId, threshold: 3, jurors });

    const dispute = {
      disputeId: randomBytes(32).toString('hex'),
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };
    const { verdictHash, supportingEventIds } = makeVerdictCommitment(dispute.disputeId, dispute.proposedOutcome);
    const attestation = runDisputeOverrideSigning({
      dispute,
      dkg: record,
      shares: shares.slice(0, 3),
      verdictHash,
      supportingEventIds,
    });
    const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
    const event = finalizeEvent(template, randomBytes(32));

    // Gated resolver keeps handleEvent suspended after the dedup check so BOTH
    // deliveries are in flight simultaneously — the exact window where
    // post-validation dedup recording lets duplicates double-emit. Regression:
    // without synchronous id reservation, both calls resolve non-null.
    let releasePubkey: (v: string) => void = () => {};
    const gate = new Promise<string>((resolve) => { releasePubkey = resolve; });
    const watcher = new FrostAppealWatcher({
      relays: ['wss://fake.example'],
      getGroupPubkey: () => gate,
    });

    const p1 = watcher.handleEvent(event);
    const p2 = watcher.handleEvent(event);
    releasePubkey(record.groupPubkeyXOnly);
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).not.toBeNull();
    expect(a?.marketId).toBe(marketId);
    expect(a?.outcome).toBe('NO');
    expect(b).toBeNull();

    // The reservation is transient: a later redelivery is still deduped via
    // processedEventIds (not permanently blocked by the in-flight set).
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

    const { verdictHash, supportingEventIds } = makeVerdictCommitment(dispute.disputeId, dispute.proposedOutcome);
    const attestation = runDisputeOverrideSigning({
      dispute,
      dkg: record,
      shares: shares.slice(0, 3),
      verdictHash,
      supportingEventIds,
    });
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

    const { verdictHash, supportingEventIds } = makeVerdictCommitment(dispute.disputeId, dispute.proposedOutcome);
    const attestation = runDisputeOverrideSigning({
      dispute,
      dkg: record,
      shares: shares.slice(0, 3),
      verdictHash,
      supportingEventIds,
    });
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

    const { verdictHash, supportingEventIds } = makeVerdictCommitment(dispute.disputeId, dispute.proposedOutcome);
    const attestation = runDisputeOverrideSigning({
      dispute,
      dkg: record,
      shares: shares.slice(0, 3),
      verdictHash,
      supportingEventIds,
    });
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

    const { verdictHash, supportingEventIds } = makeVerdictCommitment(dispute.disputeId, dispute.proposedOutcome);
    const attestation = runDisputeOverrideSigning({
      dispute,
      dkg: record,
      shares: shares.slice(0, 3),
      verdictHash,
      supportingEventIds,
    });
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
