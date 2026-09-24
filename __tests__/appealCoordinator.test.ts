/**
 * Unit tests for FrostAppealCoordinator.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  BAO_COURT_DISPUTE_KIND,
  createFrostAppealCoordinator,
  TEST_APPEAL_TIMINGS,
  buildDisputeEvent,
  buildVoteCommitEvent,
  buildVoteRevealEvent,
  generateFrostKeys,
  hashCommit,
  runNormalSigningRound,
  hashDisputeVerdict,
  deriveSimulatedRevealEventId,
  type FrostAppealState,
  type FrostRelayPool,
  type JurorProfile,
  type StakeCommitment,
  type DkgAdapter,
  type FrostAppealCoordinatorEvent,
} from '../index';

function makeStakeCommitment(override?: Partial<StakeCommitment>): StakeCommitment {
  return {
    amountSats: 100_000,
    bondAddress: 'bcrt1q' + randomBytes(20).toString('hex'),
    status: 'confirmed',
    committedAt: Math.floor(Date.now() / 1000),
    ...override,
  };
}

function makeJuror(override?: Partial<JurorProfile>): JurorProfile {
  return {
    nostrPubkey: randomBytes(32).toString('hex'),
    stakeCapacitySats: 500_000,
    stakeCommitment: makeStakeCommitment(),
    wotScore: 85,
    categories: ['bitcoin'],
    registeredAt: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
    ...override,
  };
}

describe('FrostAppealCoordinator', () => {
  it('progresses a manually added appeal through all phases', async () => {
    const signerPrivkey = randomBytes(32);
    const coordinator = createFrostAppealCoordinator({
      relayUrls: [],
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      jurySize: 5,
      backupCount: 2,
      signer: async (event) => finalizeEvent(event, signerPrivkey) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');
    const pubkey = randomBytes(32).toString('hex');

    const disputeCase = {
      disputeId,
      marketId,
      challengerPubkey: pubkey,
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      disputeCase,
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'pending',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };

    // Seed enough candidacies so selection can run.
    for (let i = 0; i < 10; i++) {
      const juror = makeJuror({ categories: ['bitcoin'], stakeCapacitySats: 100_000 + i * 10_000 });
      appeal.candidacies.set(juror.nostrPubkey, juror);
    }

    coordinator.addAppeal(appeal);

    const events: string[] = [];
    const off = coordinator.onEvent((ev) => events.push(ev.type));

    // Tick through all phases. In test timings we ignore wall-clock windows
    // because the coordinator transitions on internal readiness.
    for (let i = 0; i < 12; i++) {
      await coordinator.tick();
    }

    const active = coordinator.getActiveAppeals();
    expect(active).toHaveLength(1);
    expect(active[0].phase).toBe('settled');
    expect(active[0].attestation).toBeDefined();
    expect(active[0].attestation!.kind).toBe(39007);
    expect(active[0].attestation!.outcome).toBe('NO');
    expect(active[0].dkgRecord).toBeDefined();
    expect(active[0].selectedJurors).toHaveLength(5);
    expect(active[0].backupJurors).toHaveLength(2);

    expect(events).toContain('opt_in_window_opened');
    expect(events).toContain('jury_selected');
    expect(events).toContain('dkg_complete');
    expect(events).toContain('attestation_published');
    expect(events).toContain('appeal_settled');

    coordinator.stop();
    off();
  });

  it('tallies only signed commit/reveal events from the selected roster (never the challenger claim)', async () => {
    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');

    // Real juror keypairs so the selected roster can sign Kind 39004/39014.
    const jurorKeys = Array.from({ length: 4 }, (_, i) => {
      const seckey = generateSecretKey();
      const pubkey = getPublicKey(seckey);
      return { seckey, pubkey, juror: makeJuror({ nostrPubkey: pubkey, stakeCapacitySats: 500_000 + i * 10_000 }) };
    });
    const keyByPubkey = new Map(jurorKeys.map((k) => [k.pubkey, k]));

    // Built once selection has assigned FROST indices; the fake relay serves
    // whatever is present, so the vote phases see real signed events.
    let signedCommits: Array<{ jurorIdx: number; salt: string; event: ReturnType<typeof finalizeEvent> }> = [];
    let signedReveals: Array<ReturnType<typeof finalizeEvent>> = [];
    const buildSignedVotes = (selected: readonly { idx: number; nostrPubkey: string }[]): void => {
      signedCommits = selected.map((j) => {
        const salt = randomBytes(16).toString('hex');
        const template = buildVoteCommitEvent({
          disputeId,
          jurorIdx: j.idx,
          commitHash: hashCommit('NO', salt),
        });
        return { jurorIdx: j.idx, salt, event: finalizeEvent(template, keyByPubkey.get(j.nostrPubkey)!.seckey) };
      });
      signedReveals = signedCommits.map((c) => {
        const key = keyByPubkey.get(selected.find((j) => j.idx === c.jurorIdx)!.nostrPubkey)!;
        const template = buildVoteRevealEvent({
          disputeId,
          jurorIdx: c.jurorIdx,
          outcome: 'NO',
          salt: c.salt,
        });
        return finalizeEvent(template, key.seckey);
      });
    };

    const fakeRelayPool: FrostRelayPool = {
      publish: () => [Promise.resolve()],
      querySync: async (_relayUrls, filter) => {
        const kinds = filter.kinds ?? [];
        if (kinds.includes(39004)) return signedCommits.map((c) => c.event);
        if (kinds.includes(39014)) return signedReveals;
        return [];
      },
    };

    const coordinator = createFrostAppealCoordinator({
      relayUrls: ['wss://fake.example'],
      relayPool: fakeRelayPool,
      environment: 'test',
      // Explicitly disable the test-only fabrication: this coordinator must
      // collect signed events only.
      simulateVotes: false,
      timings: TEST_APPEAL_TIMINGS,
      jurySize: 3,
      backupCount: 1,
      signer: async (event) => finalizeEvent(event, randomBytes(32)) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      // The challenger CLAIMS 'YES'; the signed jury reveals say 'NO'.
      disputeCase: {
        disputeId,
        marketId,
        challengerPubkey: randomBytes(32).toString('hex'),
        respondentPubkey: randomBytes(32).toString('hex'),
        evidenceHashes: [],
        proposedOutcome: 'YES',
      },
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'pending',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };
    for (const k of jurorKeys) appeal.candidacies.set(k.pubkey, k.juror);
    coordinator.addAppeal(appeal);

    // pending -> opt_in -> selection -> dkg -> vote_commit
    for (let i = 0; i < 4; i++) {
      await coordinator.tick();
    }
    const selected = coordinator.getActiveAppeals()[0]!.selectedJurors!;
    expect(coordinator.getActiveAppeals()[0]!.phase).toBe('vote_commit');
    expect(selected).toHaveLength(3);
    buildSignedVotes(selected);

    for (let i = 0; i < 8; i++) {
      await coordinator.tick();
    }

    const active = coordinator.getActiveAppeals()[0]!;
    expect(active.phase).toBe('settled');
    expect(active.verdictOutcome).toBe('NO');
    expect(active.attestation?.outcome).toBe('NO');

    // The verdict commitment is built from the real Kind 39014 event ids,
    // not the synthetic simulation ids.
    const realRevealIds = new Set(signedReveals.map((e) => e.id));
    expect(active.verdictSupportingEventIds).toHaveLength(3);
    for (const id of active.verdictSupportingEventIds!) {
      expect(realRevealIds.has(id)).toBe(true);
    }

    coordinator.stop();
  });

  it('detects a published FROST dispute event and starts tracking it', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const marketId = 'm-coord-2';
    const disputeId = 'd-coord-2';
    const challengerPrivkey = randomBytes(32);

    const disputeTemplate = buildDisputeEvent({
      marketId,
      disputeId,
      originalOutcome: 'YES',
      proposedOutcome: 'NO',
      challengerPubkey: '',
      evidenceHashes: [randomBytes(32).toString('hex')],
      disputeDeadline: nowSec + 3600,
      publisherPubkey: '',
    });

    const disputeEvent = finalizeEvent(disputeTemplate, challengerPrivkey);

    // Host-injected relay transport serving exactly one dispute event, so
    // tick() drives the genuine fetch → detect → emit pipeline (the same
    // seam a nostr-tools SimplePool satisfies in production).
    const fakeRelayPool: FrostRelayPool = {
      publish: () => [Promise.resolve()],
      querySync: async (_relayUrls, filter) =>
        // Mirror production's full dispute-fetch filter (kind AND appeal_type
        // tag): a regression dropping either clause must fail here.
        filter.kinds?.includes(BAO_COURT_DISPUTE_KIND) &&
        filter['#appeal_type']?.includes('frost')
          ? [disputeEvent]
          : [],
    };

    const coordinator = createFrostAppealCoordinator({
      relayUrls: ['wss://fake.example'],
      relayPool: fakeRelayPool,
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      signer: async (event) => finalizeEvent(event, randomBytes(32)) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const detectedEvents: FrostAppealCoordinatorEvent[] = [];
    coordinator.onEvent((ev) => {
      if (ev.type === 'appeal_detected') detectedEvents.push(ev);
    });

    await coordinator.tick();

    expect(detectedEvents).toHaveLength(1);
    expect(detectedEvents[0]?.disputeId).toBe(disputeEvent.id);
    expect(detectedEvents[0]?.marketId).toBe(marketId);

    const active = coordinator.getActiveAppeals();
    expect(active).toHaveLength(1);
    expect(active[0]?.disputeId).toBe(disputeEvent.id);
    expect(active[0]?.marketId).toBe(marketId);

    // Dedup: a second cycle seeing the same event must not re-detect it.
    await coordinator.tick();
    expect(detectedEvents).toHaveLength(1);
    expect(coordinator.getActiveAppeals()).toHaveLength(1);

    coordinator.stop();
  });

  it('reselects from backups when the initial DKG fails', async () => {
    const signerPrivkey = randomBytes(32);
    let dkgCalls = 0;
    const flakyDkg: DkgAdapter = {
      run(params) {
        dkgCalls += 1;
        if (dkgCalls === 1) {
          throw new Error('simulated DKG failure');
        }
        return generateFrostKeys(params);
      },
      refreshShares: () => {
        throw new Error('refresh not used in this test');
      },
    };

    const coordinator = createFrostAppealCoordinator({
      relayUrls: [],
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      jurySize: 5,
      backupCount: 2,
      dkgAdapter: flakyDkg,
      signer: async (event) => finalizeEvent(event, signerPrivkey) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');
    const pubkey = randomBytes(32).toString('hex');

    const disputeCase = {
      disputeId,
      marketId,
      challengerPubkey: pubkey,
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      disputeCase,
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'pending',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };

    for (let i = 0; i < 10; i++) {
      const juror = makeJuror({ categories: ['bitcoin'], stakeCapacitySats: 100_000 + i * 10_000 });
      appeal.candidacies.set(juror.nostrPubkey, juror);
    }

    coordinator.addAppeal(appeal);

    const events: string[] = [];
    const off = coordinator.onEvent((ev) => events.push(ev.type));

    for (let i = 0; i < 15; i++) {
      await coordinator.tick();
    }

    const active = coordinator.getActiveAppeals();
    expect(active).toHaveLength(1);
    expect(active[0].phase).toBe('settled');
    expect(active[0].selectionAttempts).toBeGreaterThanOrEqual(1);
    expect(events).toContain('reselection_started');
    expect(events).toContain('jury_selected');
    expect(events).toContain('appeal_settled');

    coordinator.stop();
    off();
  });

  it('can be settled by an external attestation without a single facilitator', async () => {
    const signerPrivkey = randomBytes(32);
    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');

    // Real threshold attestation for this exact dispute/market/outcome, so
    // settleAppeal's own validation (message binding + Schnorr verification)
    // accepts it - a forged object must now be rejected.
    const { record, shares } = generateFrostKeys({
      marketId,
      disputeId,
      threshold: 2,
      jurors: [
        { ...makeJuror(), idx: 1, priority: 1 },
        { ...makeJuror(), idx: 2, priority: 2 },
      ],
    });

    const coordinator = createFrostAppealCoordinator({
      relayUrls: [],
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      jurySize: 5,
      backupCount: 2,
      // This appeal carries no local DKG record, so the external group key
      // must be explicitly empaneled or settlement fails closed.
      empaneledGroupKeys: [record.groupPubkeyXOnly],
      signer: async (event) => finalizeEvent(event, signerPrivkey) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const disputeCase = {
      disputeId,
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      disputeCase,
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'signing',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };

    coordinator.addAppeal(appeal);

    const events: FrostAppealCoordinatorEvent[] = [];
    const off = coordinator.onEvent((ev) => events.push(ev));

    // Real threshold attestation for this exact dispute/market/outcome, so
    // settleAppeal's own validation (message binding + Schnorr verification)
    // accepts it — a forged object must now be rejected.
    // The attestation must certify the TALLY that produced the outcome —
    // settleAppeal rejects dispute attestations without a verdict commitment.
    const supportingEventIds = [1, 2].map((idx) =>
      deriveSimulatedRevealEventId(idx, 'NO', 'salt-' + idx),
    );
    const verdictHash = hashDisputeVerdict({ disputeId, outcome: 'NO', supportingEventIds });
    const attestation = runNormalSigningRound({
      marketId,
      outcome: 'NO',
      round: 1,
      disputeEventId: disputeId,
      verdictHash,
      dkg: record,
      shares,
    });

    expect(coordinator.settleAppeal(disputeId, attestation)).toBe(true);

    const active = coordinator.getActiveAppeals();
    expect(active).toHaveLength(1);
    expect(active[0].phase).toBe('settled');
    expect(active[0].attestation?.disputeEventId).toBe(disputeId);
    expect(active[0].attestation?.marketId).toBe(marketId);
    expect(events.map((e) => e.type)).toContain('appeal_settled_from_attestation');

    // Idempotent: a second settlement attempt is rejected.
    expect(coordinator.settleAppeal(disputeId, attestation)).toBe(false);

    // A forged attestation for the same dispute is rejected outright.
    const forged = {
      ...attestation,
      outcome: 'YES',
      signature: randomBytes(64).toString('hex'),
    };
    const forgedCoordinator = coordinator;
    // (the appeal is already settled — use a fresh appeal to test rejection)
    const freshAppeal: FrostAppealState = {
      disputeId: disputeId + '0',
      marketId,
      disputeCase: { ...disputeCase, disputeId: disputeId + '0' },
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'signing',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };
    forgedCoordinator.addAppeal(freshAppeal);
    expect(forgedCoordinator.settleAppeal(disputeId + '0', forged)).toBe(false);

    coordinator.stop();
    off();
  });

  it('rejects settlement under a group key that is neither local nor empaneled', () => {
    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');
    const { record, shares } = generateFrostKeys({
      marketId,
      disputeId,
      threshold: 2,
      jurors: [
        { ...makeJuror(), idx: 1, priority: 1 },
        { ...makeJuror(), idx: 2, priority: 2 },
      ],
    });

    // No dkgRecord on the appeal and no allow-list on the coordinator: the
    // external attestation is cryptographically valid but unpinned.
    const coordinator = createFrostAppealCoordinator({
      relayUrls: [],
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      jurySize: 5,
      backupCount: 2,
      signer: async (event) => finalizeEvent(event, randomBytes(32)) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      disputeCase: {
        disputeId,
        marketId,
        challengerPubkey: randomBytes(32).toString('hex'),
        respondentPubkey: randomBytes(32).toString('hex'),
        evidenceHashes: [],
        proposedOutcome: 'NO',
      },
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'signing',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };
    coordinator.addAppeal(appeal);

    const supportingEventIds = [1, 2].map((idx) =>
      deriveSimulatedRevealEventId(idx, 'NO', 'salt-' + idx),
    );
    const verdictHash = hashDisputeVerdict({ disputeId, outcome: 'NO', supportingEventIds });
    const attestation = runNormalSigningRound({
      marketId,
      outcome: 'NO',
      round: 1,
      disputeEventId: disputeId,
      verdictHash,
      dkg: record,
      shares,
    });

    const rejected: string[] = [];
    coordinator.onEvent((ev) => {
      if (ev.type === 'settlement_rejected') rejected.push(String(ev.data.reason));
    });

    expect(coordinator.settleAppeal(disputeId, attestation)).toBe(false);
    expect(rejected).toContain('unpinned_group_key');
    expect(coordinator.getActiveAppeals()[0]?.phase).toBe('signing');

    coordinator.stop();
  });

  it('moves to refund and releases backup stakes when reselection is exhausted', async () => {
    const signerPrivkey = randomBytes(32);
    const alwaysFailingDkg: DkgAdapter = {
      run() {
        throw new Error('DKG permanently broken');
      },
      refreshShares: () => {
        throw new Error('refresh not used in this test');
      },
    };

    const coordinator = createFrostAppealCoordinator({
      relayUrls: [],
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      jurySize: 5,
      backupCount: 2,
      dkgAdapter: alwaysFailingDkg,
      signer: async (event) => finalizeEvent(event, signerPrivkey) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');
    const pubkey = randomBytes(32).toString('hex');

    const disputeCase = {
      disputeId,
      marketId,
      challengerPubkey: pubkey,
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: 'NO',
    };

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      disputeCase,
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'pending',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
    };

    // Exactly jurySize + backupCount = 7 jurors, so only one selection is possible.
    for (let i = 0; i < 7; i++) {
      const juror = makeJuror({ categories: ['bitcoin'], stakeCapacitySats: 100_000 + i * 10_000 });
      appeal.candidacies.set(juror.nostrPubkey, juror);
    }

    coordinator.addAppeal(appeal);

    const events: FrostAppealCoordinatorEvent[] = [];
    const off = coordinator.onEvent((ev) => events.push(ev));

    for (let i = 0; i < 8; i++) {
      await coordinator.tick();
    }

    const active = coordinator.getActiveAppeals();
    expect(active).toHaveLength(1);
    expect(active[0].phase).toBe('refund');
    expect(events.map((e) => e.type)).toContain('reselection_started');
    expect(events.map((e) => e.type)).toContain('reselection_exhausted');
    expect(events.map((e) => e.type)).toContain('backup_stakes_released');

    const releaseEvent = events.find((e) => e.type === 'backup_stakes_released');
    expect(releaseEvent).toBeDefined();
    expect(Array.isArray(releaseEvent!.data.backupPubkeys)).toBe(true);
    expect(releaseEvent!.data.backupPubkeys).toHaveLength(2);

    coordinator.stop();
    off();
  });

  // Regression (2026-08-18 flow review): the signing round must attest the
  // TALLY WINNER, never the challenger's proposed outcome. The demo's uniform
  // vote simulation masks this, so the test injects an appeal already in the
  // signing phase whose verdictOutcome differs from proposedOutcome.
  it('signs the tally verdict, not the challenger proposed outcome', async () => {
    const signerPrivkey = randomBytes(32);
    const coordinator = createFrostAppealCoordinator({
      relayUrls: [],
      environment: 'test',
      timings: TEST_APPEAL_TIMINGS,
      signer: async (event) => finalizeEvent(event, signerPrivkey) as unknown as ReturnType<typeof finalizeEvent>,
    });

    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');
    const selected = [0, 1, 2].map((i) => ({ ...makeJuror(), idx: i + 1, priority: i + 1 }));
    const keygen = generateFrostKeys({ marketId, threshold: 2, jurors: selected });

    const appeal: FrostAppealState = {
      disputeId,
      marketId,
      disputeCase: {
        disputeId,
        marketId,
        challengerPubkey: randomBytes(32).toString('hex'),
        respondentPubkey: randomBytes(32).toString('hex'),
        evidenceHashes: [],
        proposedOutcome: 'YES', // the challenger's claim
      },
      resolutionTimestamp: Math.floor(Date.now() / 1000) - 10_000,
      phase: 'signing',
      candidacies: new Map(),
      voteCommits: new Map(),
      voteReveals: new Map(),
      selectionAttempts: 0,
      excludedSelectedPubkeys: [],
      reselectionDeadline: Math.floor(Date.now() / 1000) + 10_000,
      dkgRecord: keygen.record,
      shares: keygen.shares.map((s: { idx: number; seckey: string }) => ({ idx: s.idx, seckey: s.seckey })),
      verdictOutcome: 'NO', // the tally winner — differs from proposedOutcome
    };

    coordinator.addAppeal(appeal);

    const events: string[] = [];
    const off = coordinator.onEvent((ev) => events.push(ev.type));
    await coordinator.tick(); // signing -> attestation_published
    await coordinator.tick(); // attestation_published -> settled

    const active = coordinator.getActiveAppeals();
    expect(active).toHaveLength(1);
    expect(active[0].attestation?.outcome).toBe('NO');
    expect(active[0].phase).toBe('settled');
    expect(events).toContain('attestation_published');

    coordinator.stop();
    off();
  });
});
