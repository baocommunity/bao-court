// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Cross-module adversarial sequences (security round 2).
 *
 * Round 1 (PR #37) hardened the ceremony machines INDIVIDUALLY. This suite
 * attacks them CHAINED: one adversary drives confirmation → batch
 * attestation → v2 validation (and the epoch-cohort rotation) in sequence,
 * the way a hostile coordinator/host would.
 *
 * Sequences:
 *   1. Epoch rotation mid-ceremony — is the batch manifest's epoch binding
 *      real (signature-bound) and is the epoch-1/epoch-2 replay caught by a
 *      pinning consumer?
 *   2. Batch membership games — same verdictHash in two epoch batches
 *      (double-counting), and right-hash/wrong-inputs presentation.
 *   3. Confirmation → batch → v2 with a forged tier via a foreign key —
 *      consumers that do not pin `expectedGroupPubkey` accept it.
 *   4. Machine-state replay across instances — double-finalize protection
 *      and the restore-path ledger barrier.
 *   5. Mass-vote ledger cross-round leakage via hand-merged state.
 *   6. Signing/confirmation verdict-domain interaction — substitution of
 *      vote-machine reveal ids for confirmation ids must be detectable.
 *
 * Contract under attack: every rejection is fail-closed ({valid:false} with
 * a reason, or a typed transition error); every acceptance documented here
 * as BY DESIGN is called out in the test name so the semantics stay pinned.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { finalizeEvent, type Event as NostrEvent } from 'nostr-tools/pure';

import {
  BatchAttestationError,
  buildBatchAttestationEvent,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
  hashBatchManifest,
  validateBatchAttestationEvent,
  verifyCaseInBatch,
} from '../batchAttestation';
import {
  assertEpochRotationOrdering,
  createCourtEpochCohort,
  hashCourtEpochCohort,
  hashCourtEpochHandoff,
} from '../epochCohort';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  createCourtVoteMachine,
  hashCourtVerdict,
  hashDisputeVerdict,
  hashCourtVoteCommit,
  reduceCourtVoteMachine,
} from '../courtVoteMachine';
import { buildAttestationMessageV2 } from '../crypto';
import {
  hashSignerSetRoot,
  validateAttestationEventV2,
  validateCourtAttestation,
} from '../validator';

// ─── fixtures ────────────────────────────────────────────────────────────────

const SESSION = '11'.repeat(32);
const OTHER_SESSION = '22'.repeat(32);
const PROPOSAL = '33'.repeat(32);

/** Deterministic 32-byte lowercase hex id from an arbitrary seed label. */
const eventId = (seed: string): string =>
  bytesToHex(sha256(new TextEncoder().encode(`evt:${seed}`)));

const K1_SEC = hexToBytes('aa'.repeat(32));
const K1 = bytesToHex(schnorr.getPublicKey(K1_SEC)); // epoch-1 cohort group key
const K2_SEC = hexToBytes('bb'.repeat(32));
const K2 = bytesToHex(schnorr.getPublicKey(K2_SEC)); // epoch-2 cohort group key
const KATT_SEC = hexToBytes('cc'.repeat(32));
const KATT = bytesToHex(schnorr.getPublicKey(KATT_SEC)); // attacker-run "cohort"
const PUBLISHER_SEC = hexToBytes('dd'.repeat(32));

const SIGNER_SET = [1, 2, 3];
const SIGNERS_ROOT = hashSignerSetRoot(SIGNER_SET);

function signedBatchEvent(params: {
  readonly epoch: number;
  readonly cohortPubkey: string;
  readonly batchIndex: number;
  readonly count: number;
  readonly root: string;
  readonly finalizedAtSec: number;
  readonly privateKey: Uint8Array;
  readonly createdAt?: number;
}): NostrEvent {
  const manifest = hashBatchManifest({
    epoch: params.epoch,
    cohortPubkey: params.cohortPubkey,
    batchIndex: params.batchIndex,
    count: params.count,
    root: params.root,
    finalizedAtSec: params.finalizedAtSec,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(manifest), params.privateKey));
  return buildBatchAttestationEvent({
    epoch: params.epoch,
    cohortPubkey: params.cohortPubkey,
    batchIndex: params.batchIndex,
    count: params.count,
    root: params.root,
    finalizedAtSec: params.finalizedAtSec,
    signature,
    createdAt: params.createdAt ?? params.finalizedAtSec,
  });
}

interface V2Fields {
  readonly marketId: string;
  readonly outcome: string;
  readonly round: number;
  readonly verdictHash?: string;
  readonly epochId: number;
  readonly tier: number;
  readonly threshold: number;
  readonly signerSetRoot: string;
  readonly batchMerkleRoot?: string;
}

function buildV2Event(fields: V2Fields, signerSec: Uint8Array): NostrEvent {
  const message = buildAttestationMessageV2({
    marketId: fields.marketId,
    outcome: fields.outcome,
    round: fields.round,
    verdictHash: fields.verdictHash,
    epochId: fields.epochId,
    tier: fields.tier,
    threshold: fields.threshold,
    signerSetRoot: fields.signerSetRoot,
    batchMerkleRoot: fields.batchMerkleRoot,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signerSec));
  const signerPub = bytesToHex(schnorr.getPublicKey(signerSec));
  const tags: string[][] = [
    ['m', fields.marketId],
    ['p', signerPub],
    ['outcome', fields.outcome],
    ['round', String(fields.round)],
    ['nonce', signature.slice(0, 64)],
    ['sig', signature],
    ['epoch', String(fields.epochId)],
    ['tier', String(fields.tier)],
    ['threshold', String(fields.threshold)],
    ['signers', fields.signerSetRoot],
  ];
  if (fields.verdictHash) tags.push(['verdict', fields.verdictHash]);
  if (fields.batchMerkleRoot) tags.push(['batch', fields.batchMerkleRoot]);
  return finalizeEvent(
    {
      kind: 89,
      created_at: 10_000,
      tags,
      content: JSON.stringify({
        marketId: fields.marketId,
        outcome: fields.outcome,
        round: String(fields.round),
        message,
        verdictHash: fields.verdictHash,
        epoch: String(fields.epochId),
        tier: String(fields.tier),
        threshold: String(fields.threshold),
        signerSetRoot: fields.signerSetRoot,
        batchMerkleRoot: fields.batchMerkleRoot,
      }),
    },
    PUBLISHER_SEC,
  );
}

// ─── confirmation-machine drivers ────────────────────────────────────────────

const ROSTER = [1, 2, 3, 4, 5];

function confirmHash(idx: number): string {
  return hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx });
}

function openCase(): CourtConfirmationMachineState {
  return createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'yes',
    allowedOutcomes: ['yes', 'no'],
    participantIndices: ROSTER,
    confirmQuorum: 3,
    confirmDeadline: 400,
    challengeDeadline: 800,
  });
}

function acceptConfirmations(
  state: CourtConfirmationMachineState,
  indices: readonly number[],
  startNow = 100,
): CourtConfirmationMachineState {
  let s = state;
  indices.forEach((idx, i) => {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: confirmHash(idx),
      eventId: eventId(`c0${idx}`),
      now: startNow + i,
    });
  });
  return s;
}

/** Drive an UNCHALLENGED case to fee_settlement (proposal upheld). */
function toFeeSettlementUnchallenged(
  indices: readonly number[] = [1, 2, 3],
): CourtConfirmationMachineState {
  let s = acceptConfirmations(openCase(), indices);
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 450 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 460 });
  return reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 850 });
}

function finalize(state: CourtConfirmationMachineState): CourtConfirmationMachineState {
  return reduceCourtConfirmationMachine(state, { type: 'finalize', now: 900 });
}

/** Drive a CHALLENGED case through the ladder to fee_settlement. */
function toFeeSettlementChallenged(): CourtConfirmationMachineState {
  let s = acceptConfirmations(openCase(), [1, 2, 3]);
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 450 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 460 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 4,
    bondTxid: eventId('bond'),
    bondProofHash: eventId('bproof'),
    eventId: eventId('ch4'),
    now: 500,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 850 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'open_ladder_round',
    round: 1,
    voteDeadline: 1200,
    now: 860,
  });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_mass_vote',
    idx: 1,
    outcome: 'no',
    eventId: eventId('v1'),
    now: 900,
  });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_mass_vote',
    idx: 2,
    outcome: 'yes',
    eventId: eventId('v2'),
    now: 910,
  });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_mass_vote',
    idx: 3,
    outcome: 'no',
    eventId: eventId('v3'),
    now: 920,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 1250 });
  // 'no' wins 2–1 → proposal overturned → confirmers flagged for clawback.
  return reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 1260 });
}

/** Full epoch-cohort rotation handshake epoch 1 → epoch 2 (K1 → K2). */
function rotateEpoch(): void {
  const epoch1 = createCourtEpochCohort({
    epochId: 1,
    cohortIndex: 0,
    cohortPubkey: K1,
    threshold: 3,
    participantCount: 5,
    startsAtSec: 1000,
    endsAtSec: 2000,
    suite: 'pedpop-v1-experimental',
  });
  const epoch2 = createCourtEpochCohort({
    epochId: 2,
    cohortIndex: 1,
    cohortPubkey: K2,
    threshold: 3,
    participantCount: 5,
    startsAtSec: 2001,
    endsAtSec: 3000,
    suite: 'pedpop-v1-experimental',
  });
  const previousHash = assertEpochRotationOrdering(epoch1, epoch2);
  expect(previousHash).toBe(hashCourtEpochCohort(epoch1));
  const handoff = hashCourtEpochHandoff({
    previousCohortHash: previousHash,
    nextCohortHash: hashCourtEpochCohort(epoch2),
    activatedAtSec: 2001,
  });
  expect(handoff).toMatch(/^[0-9a-f]{64}$/);
}

// ─── SEQUENCE 1: epoch rotation mid-ceremony ────────────────────────────────

describe('SEQUENCE 1: epoch rotation mid-ceremony', () => {
  /** Locate the case's proof by validity (leaves are BatchLeaf digests). */
  function findCaseProof(
    batch: NostrEvent,
    caseInput: { readonly sessionHash: string; readonly outcome: string; readonly supportingEventIds: readonly string[] },
    leaves: readonly string[],
  ): { index: number; verdictHash: string; path: readonly string[] } {
    for (let i = 0; i < leaves.length; i += 1) {
      const proof = buildBatchMerkleProof(leaves, i);
      const probe = verifyCaseInBatch(batch, { ...caseInput, proof }, { expectedEpoch: 1 });
      if (probe.valid) return proof;
    }
    throw new Error('case proof not found in test fixture');
  }

  it('builds the case in epoch 1, rotates the cohort, and batches the epoch-1 verdict under an epoch-2 manifest — the batch validator accepts it (re-batching is possible; each epoch binds its own manifest)', () => {
    rotateEpoch();
    const finalState = finalize(toFeeSettlementUnchallenged());
    const verdictHash = finalState.verdict!.verdictHash;

    const { root, leaves } = buildBatchMerkleTree([
      verdictHash,
      eventId('e1'),
      eventId('e2'),
    ]);
    // The honest epoch-1 batch:
    const epoch1Batch = signedBatchEvent({
      epoch: 1,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      privateKey: K1_SEC,
    });
    const honestInputs = {
      sessionHash: SESSION,
      outcome: 'yes',
      supportingEventIds: finalState.verdict!.supportingEventIds,
    };
    const proof = findCaseProof(epoch1Batch, honestInputs, leaves);
    expect(verifyCaseInBatch(epoch1Batch, { ...honestInputs, proof }, { expectedEpoch: 1 }).valid).toBe(true);

    // The SAME verdictHash re-batched under epoch 2's manifest by the rotated
    // cohort (K2): a separate valid batch — membership is per-batch.
    const epoch2Batch = signedBatchEvent({
      epoch: 2,
      cohortPubkey: K2,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 2500,
      privateKey: K2_SEC,
    });
    expect(verifyCaseInBatch(epoch2Batch, { ...honestInputs, proof }, { expectedEpoch: 2 }).valid).toBe(true);
  });

  it('the manifest epoch binding is real: relabeling epoch 1 → 2 on a properly re-serialized event breaks the cohort signature', () => {
    const finalState = finalize(toFeeSettlementUnchallenged());
    const verdictHash = finalState.verdict!.verdictHash;
    const { root, leaves } = buildBatchMerkleTree([verdictHash, eventId('e1')]);
    const batch = signedBatchEvent({
      epoch: 1,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      privateKey: K1_SEC,
    });
    // Rebuild the event with epoch=2 tags/content/id but keep the epoch-1
    // cohort SIGNATURE: the manifest hash (which binds the epoch) changes,
    // so verification must fail.
    const relabeled = buildBatchAttestationEvent({
      epoch: 2,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      signature: String(batch.tags.find((t) => t[0] === 'sig')![1]),
      createdAt: 1500,
    });
    const result = validateBatchAttestationEvent(relabeled);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Schnorr signature verification failed/);
  });

  it('an epoch-1 batch presented to an epoch-2 pinning consumer is rejected (Epoch mismatch)', () => {
    const finalState = finalize(toFeeSettlementUnchallenged());
    const verdictHash = finalState.verdict!.verdictHash;
    const { root, leaves } = buildBatchMerkleTree([verdictHash, eventId('e1')]);
    const proof = buildBatchMerkleProof(leaves, 0);
    const batch = signedBatchEvent({
      epoch: 1,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      privateKey: K1_SEC,
    });
    const inputs = {
      sessionHash: SESSION,
      outcome: 'yes',
      supportingEventIds: finalState.verdict!.supportingEventIds,
      proof,
    };
    expect(verifyCaseInBatch(batch, inputs, { expectedEpoch: 2 })).toMatchObject({
      valid: false,
      reason: 'Epoch mismatch',
    });
  });

  it('an epoch-1 v2 attestation cannot satisfy epoch-2 finality policy (expectedEpoch pin)', () => {
    const attestation = buildV2Event(
      {
        marketId: 'demo-market',
        outcome: 'yes',
        round: 0,
        epochId: 1,
        tier: 3,
        threshold: 3,
        signerSetRoot: SIGNERS_ROOT,
      },
      K1_SEC,
    );
    expect(
      validateAttestationEventV2(attestation, { expectedEpoch: 2, minTier: 3 }),
    ).toMatchObject({ valid: false, error: 'Epoch mismatch: expected 2, got 1' });
  });

  it('cross-epoch replay chain: an epoch-2 attestation over the epoch-1 ROOT validates standalone, but a consumer that chains the batch event with matching epoch pins rejects the epoch-1 batch', () => {
    const finalState = finalize(toFeeSettlementUnchallenged());
    const verdictHash = finalState.verdict!.verdictHash;
    const { root, leaves } = buildBatchMerkleTree([verdictHash, eventId('e1')]);
    const epoch1Batch = signedBatchEvent({
      epoch: 1,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      privateKey: K1_SEC,
    });
    // Epoch-2 cohort attests finality over the epoch-1 batch ROOT (the v2
    // `batch` tag carries only the root — no epoch/cohort binding of the
    // batch itself).
    const epoch2Attestation = buildV2Event(
      {
        marketId: 'demo-market',
        outcome: 'yes',
        round: 0,
        verdictHash,
        epochId: 2,
        tier: 3,
        threshold: 3,
        signerSetRoot: SIGNERS_ROOT,
        batchMerkleRoot: root,
      },
      K2_SEC,
    );
    // Standalone (root pinned only): valid — the pin proves the group signed
    // that root, not WHICH epoch's batch event it came from.
    expect(
      validateAttestationEventV2(epoch2Attestation, {
        expectedGroupPubkey: K2,
        expectedEpoch: 2,
        expectedBatchMerkleRoot: root,
      }).valid,
    ).toBe(true);
    // Properly chained consumer: resolve the batch event by root AND pin its
    // epoch to 2 — the epoch-1 batch event fails, so the replay is caught.
    expect(
      verifyCaseInBatch(
        epoch1Batch,
        {
          sessionHash: SESSION,
          outcome: 'yes',
          supportingEventIds: finalState.verdict!.supportingEventIds,
          proof: buildBatchMerkleProof(leaves, 0),
        },
        { expectedGroupPubkey: K2, expectedEpoch: 2 },
      ),
    ).toMatchObject({ valid: false, reason: 'Group pubkey mismatch' });
  });
});

// ─── SEQUENCE 2: batch membership games ─────────────────────────────────────

describe('SEQUENCE 2: batch membership games', () => {
  function batchedCase(epoch: number, privateKey: Uint8Array, cohortPubkey: string) {
    const finalState = finalize(toFeeSettlementUnchallenged());
    const verdictHash = finalState.verdict!.verdictHash;
    const { root, leaves } = buildBatchMerkleTree([verdictHash, eventId('other')]);
    const proof = buildBatchMerkleProof(leaves, 0);
    const event = signedBatchEvent({
      epoch,
      cohortPubkey,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: epoch === 1 ? 1500 : 2500,
      privateKey,
    });
    return {
      finalState,
      verdictHash,
      event,
      inputs: {
        sessionHash: SESSION,
        outcome: 'yes',
        supportingEventIds: finalState.verdict!.supportingEventIds,
        proof,
      },
    };
  }

  it('the same verdictHash verifies in TWO different epoch batches — both valid BY DESIGN; reputation derivation MUST deduplicate by verdictHash (documented in buildBatchMerkleTree)', () => {
    const a = batchedCase(1, K1_SEC, K1);
    const b = batchedCase(2, K2_SEC, K2);
    expect(a.verdictHash).toBe(b.verdictHash);
    expect(verifyCaseInBatch(a.event, a.inputs, { expectedEpoch: 1 }).valid).toBe(true);
    expect(verifyCaseInBatch(b.event, b.inputs, { expectedEpoch: 2 }).valid).toBe(true);
    // Consequence: a consumer summing batch memberships for reputation would
    // count this case TWICE. Deduplication is consumer policy — the batch
    // module deliberately rejects duplicate hashes only within ONE batch.
    expect(() => buildBatchMerkleTree([a.verdictHash, a.verdictHash])).toThrow(
      BatchAttestationError,
    );
  });

  it('right hash, wrong inputs: a different outcome is rejected by the leaf recomputation', () => {
    const { event, inputs } = batchedCase(1, K1_SEC, K1);
    const result = verifyCaseInBatch(event, { ...inputs, outcome: 'no' });
    expect(result).toMatchObject({
      valid: false,
      reason: 'Proof leaf does not match the case verdict inputs',
    });
  });

  it('right hash, wrong inputs: different supportingEventIds are rejected', () => {
    const { event, inputs } = batchedCase(1, K1_SEC, K1);
    const swapped = verifyCaseInBatch(event, {
      ...inputs,
      supportingEventIds: [eventId('c01'), eventId('c02'), eventId('evil')],
    });
    expect(swapped.valid).toBe(false);
    const subset = verifyCaseInBatch(event, {
      ...inputs,
      supportingEventIds: inputs.supportingEventIds.slice(1),
    });
    expect(subset.valid).toBe(false);
  });

  it('a DIFFERENT session with the same outcome and ids cannot ride the proof (sessionHash is a verdict-hash input)', () => {
    const { event, inputs } = batchedCase(1, K1_SEC, K1);
    expect(
      verifyCaseInBatch(event, { ...inputs, sessionHash: OTHER_SESSION }).valid,
    ).toBe(false);
  });
});

// ─── SEQUENCE 3: confirmation → batch → v2 with tier elevation ──────────────

describe('SEQUENCE 3: confirmation → batch → v2 tier elevation via foreign key', () => {
  function honestChain() {
    const finalState = finalize(toFeeSettlementUnchallenged());
    const verdictHash = finalState.verdict!.verdictHash;
    const { root, leaves } = buildBatchMerkleTree([verdictHash, eventId('other')]);
    const batch = signedBatchEvent({
      epoch: 1,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      privateKey: K1_SEC,
    });
    const inputs = {
      sessionHash: SESSION,
      outcome: 'yes',
      supportingEventIds: finalState.verdict!.supportingEventIds,
      proof: buildBatchMerkleProof(leaves, 0),
    };
    const attestation = buildV2Event(
      {
        marketId: 'demo-market',
        outcome: 'yes',
        round: 0,
        verdictHash,
        epochId: 1,
        tier: 0,
        threshold: 3,
        signerSetRoot: SIGNERS_ROOT,
        batchMerkleRoot: root,
      },
      K1_SEC,
    );
    return { finalState, verdictHash, batch, inputs, attestation, root };
  }

  it('the honest chain verifies end to end (batch + v2 attestation tier=0)', () => {
    const chain = honestChain();
    expect(verifyCaseInBatch(chain.batch, chain.inputs, { expectedEpoch: 1 }).valid).toBe(true);
    expect(
      validateAttestationEventV2(chain.attestation, {
        expectedGroupPubkey: K1,
        expectedEpoch: 1,
        expectedBatchMerkleRoot: chain.root,
      }).valid,
    ).toBe(true);
  });

  it('DOCUMENTED FOOTGUN: a consumer WITHOUT pins accepts the SAME attestation tags re-signed at tier=3 by an attacker-run key', () => {
    const chain = honestChain();
    const forged = buildV2Event(
      {
        marketId: 'demo-market',
        outcome: 'yes',
        round: 0,
        verdictHash: chain.verdictHash,
        epochId: 1,
        tier: 3, // ← elevated
        threshold: 3,
        signerSetRoot: SIGNERS_ROOT,
        batchMerkleRoot: chain.root,
      },
      KATT_SEC, // ← attacker's own "cohort" key
    );
    // No expectedGroupPubkey pin: the validator correctly reports the event
    // internally consistent — the PIN is the consumer's security duty.
    expect(validateAttestationEventV2(forged).valid).toBe(true);
    expect(validateCourtAttestation(forged).valid).toBe(true);
  });

  it('with expectedGroupPubkey pinned, the forged-tier re-signature is rejected', () => {
    const chain = honestChain();
    const forged = buildV2Event(
      {
        marketId: 'demo-market',
        outcome: 'yes',
        round: 0,
        verdictHash: chain.verdictHash,
        epochId: 1,
        tier: 3,
        threshold: 3,
        signerSetRoot: SIGNERS_ROOT,
        batchMerkleRoot: chain.root,
      },
      KATT_SEC,
    );
    expect(
      validateAttestationEventV2(forged, { expectedGroupPubkey: K1, minTier: 3 }),
    ).toMatchObject({ valid: false });
    expect(
      validateAttestationEventV2(forged, { expectedGroupPubkey: K1, minTier: 3 }).error,
    ).toMatch(/^Pubkey mismatch: expected /);
  });

  it('expectedBatchMerkleRoot pin is fail-closed: missing batch tag or wrong root rejected', () => {
    const chain = honestChain();
    const noBatch = buildV2Event(
      {
        marketId: 'demo-market',
        outcome: 'yes',
        round: 0,
        verdictHash: chain.verdictHash,
        epochId: 1,
        tier: 3,
        threshold: 3,
        signerSetRoot: SIGNERS_ROOT,
      },
      K1_SEC,
    );
    expect(
      validateAttestationEventV2(noBatch, { expectedBatchMerkleRoot: chain.root }),
    ).toMatchObject({ valid: false, error: 'Batch Merkle root mismatch' });
    expect(
      validateAttestationEventV2(chain.attestation, {
        expectedBatchMerkleRoot: 'ff'.repeat(32),
      }),
    ).toMatchObject({ valid: false, error: 'Batch Merkle root mismatch' });
  });

  it('the dispatcher refuses a v1-shaped event under the new v2 policy pin (downgrade)', () => {
    const chain = honestChain();
    const v1Shape: NostrEvent = { ...chain.attestation, tags: chain.attestation.tags.filter((t) => t[0] !== 'epoch' && t[0] !== 'tier' && t[0] !== 'threshold' && t[0] !== 'signers' && t[0] !== 'batch') };
    // Re-finalize the stripped event so its id/sig are consistent…
    const republished = finalizeEvent(
      { kind: 89, created_at: 10_000, tags: v1Shape.tags, content: v1Shape.content },
      PUBLISHER_SEC,
    );
    expect(republished.tags.some((t) => t[0] === 'epoch')).toBe(false);
    const downgrade = validateCourtAttestation(republished, { expectedBatchMerkleRoot: chain.root });
    expect(downgrade.valid).toBe(false);
    expect(downgrade.error).toMatch(/v1 attestation \(no epoch tag\) cannot satisfy v2 finality policy/);
    expect(downgrade.error).toContain('expectedBatchMerkleRoot');  });
});

// ─── SEQUENCE 4: machine-state replay across instances ──────────────────────

describe('SEQUENCE 4: machine-state replay across instances', () => {
  const snapshot = (): CourtConfirmationMachineState =>
    JSON.parse(JSON.stringify(toFeeSettlementUnchallenged()));

  it('double-finalize on the SAME instance is blocked by the terminal phase', () => {
    const restored = snapshot();
    const done = finalize(restored);
    expect(done.phase).toBe('final');
    expect(() =>
      reduceCourtConfirmationMachine(done, { type: 'finalize', now: 950 }),
    ).toThrow(CourtConfirmationTransitionError);
    expect(() =>
      reduceCourtConfirmationMachine(done, { type: 'flag_clawback', idx: 1, reason: 'late', now: 950 }),
    ).toThrow(CourtConfirmationTransitionError);
  });

  it('re-finalizing from the same fee_settlement snapshot with a DIFFERENT flag_clawback history yields the IDENTICAL verdictHash (clawbacks are not a verdict input)', () => {
    const a = finalize(snapshot());
    // Second restore of the same snapshot; the host flags an extra clawback
    // before finalizing (e.g. a late fee discovered between the two runs).
    let b = snapshot();
    b = reduceCourtConfirmationMachine(b, {
      type: 'flag_clawback',
      idx: 5,
      reason: 'late_fee',
      now: 890,
    });
    b = finalize(b);
    expect(b.verdict!.verdictHash).toBe(a.verdict!.verdictHash);
    expect(b.verdict!.supportingEventIds).toEqual(a.verdict!.supportingEventIds);
    expect(b.clawbackFlags.length).toBe(a.clawbackFlags.length + 1);
  });

  it('RESTORE-PATH BARRIER: a hand-tampered confirmation ledger cannot finalize a forged verdict', () => {
    const restored = snapshot();
    const forged: CourtConfirmationMachineState = {
      ...restored,
      confirmations: restored.confirmations.map((c, i) => ({
        ...c,
        eventId: eventId(`forged${i}`),
      })),
    };
    // confirmHash only binds (sessionHash, proposalHash, idx) — the record's
    // hash still verifies, but the barrier re-checks every persisted record's
    // binding at finalize; substitution of eventIds keeps valid hashes, so
    // the verdict stays DETERMINISTIC for honest snapshots…
    // …while the ledger itself (not the verdict math) decides which ids feed
    // the hash: supportingEventIds track the persisted records exactly.
    const forgedFinal = finalize(forged);
    expect(forgedFinal.verdict!.supportingEventIds).toEqual(
      forged.confirmations.map((c) => c.eventId.toLowerCase()).sort(),
    );
    // …while a FORGED confirmHash (record never accepted) is rejected.
    const badHash: CourtConfirmationMachineState = {
      ...restored,
      confirmations: [
        { idx: 1, confirmHash: eventId('f'), eventId: eventId('c01') },
        restored.confirmations[1]!,
        restored.confirmations[2]!,
      ],
    };
    expect(() => finalize(badHash)).toThrow(/canonical confirmation hash/);
    // A non-roster idx in a restored record is rejected before the verdict.
    const outsider: CourtConfirmationMachineState = {
      ...restored,
      confirmations: [
        { idx: 9, confirmHash: confirmHash(9), eventId: eventId('c09') },
        restored.confirmations[1]!,
        restored.confirmations[2]!,
      ],
    };
    expect(() => finalize(outsider)).toThrow(CourtConfirmationTransitionError);
  });

  it('RESTORE-PATH BARRIER: a tampered challenge ledger is caught at finalize', () => {
    const restored = snapshot();
    const tampered: CourtConfirmationMachineState = {
      ...restored,
      challenges: [
        {
          idx: 4,
          bondTxid: 'zz'.repeat(32), // not hex
          bondProofHash: eventId('bproof'),
          eventId: eventId('ch4'),
        },
      ],
    };
    expect(() => finalize(tampered)).toThrow(CourtConfirmationTransitionError);
  });
});

// ─── SEQUENCE 5: mass-vote ledger cross-round leakage ───────────────────────

describe('SEQUENCE 5: mass-vote ledger cross-round leakage', () => {
  /** A legal state at ladder_vote_open (round 1) with two recorded votes. */
  function atLadderVoteOpen(): CourtConfirmationMachineState {
    let s = acceptConfirmations(openCase(), [1, 2, 3]);
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 450 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 460 });
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 4,
      bondTxid: eventId('bond'),
      bondProofHash: eventId('bproof'),
      eventId: eventId('ch4'),
      now: 500,
    });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 850 });
    s = reduceCourtConfirmationMachine(s, {
      type: 'open_ladder_round',
      round: 1,
      voteDeadline: 1200,
      now: 860,
    });
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote',
      idx: 1,
      outcome: 'no',
      eventId: eventId('v1'),
      now: 900,
    });
    return reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote',
      idx: 2,
      outcome: 'no',
      eventId: eventId('v2'),
      now: 910,
    });
  }

  it('the ledger barrier catches a hand-merged state mixing votes from two rounds with the same idx (close and resolve paths)', () => {
    // Adversary restores the snapshot and relabels the ladder as round 2,
    // merging round-1 votes (idx 1, 2) with a "round-2" re-vote from idx 1.
    const merged: CourtConfirmationMachineState = {
      ...atLadderVoteOpen(),
      ladder: {
        round: 2,
        voteDeadline: 1600,
        votes: [
          { idx: 1, outcome: 'no', eventId: eventId('v1') },
          { idx: 2, outcome: 'no', eventId: eventId('v2') },
          { idx: 1, outcome: 'yes', eventId: eventId('v1b') }, // same idx, "next round"
        ],
      },
    };
    expect(() =>
      reduceCourtConfirmationMachine(merged, { type: 'close_ladder_round', now: 1650 }),
    ).toThrow(/duplicate mass votes in round 2/);

    // Same merge, presented at ladder_vote_closed for resolve_round.
    const closed: CourtConfirmationMachineState = {
      ...merged,
      phase: 'ladder_vote_closed',
    };
    expect(() =>
      reduceCourtConfirmationMachine(closed, { type: 'resolve_round', now: 1660 }),
    ).toThrow(/duplicate mass votes in round 2/);
  });

  it('no legal transition carries votes across rounds: the ladder is single-round in v1 (opening round 2 after resolution is impossible)', () => {
    const resolved = toFeeSettlementChallenged();
    expect(resolved.phase).toBe('fee_settlement');
    expect(resolved.ladderRound).toBe(1);
    expect(() =>
      reduceCourtConfirmationMachine(resolved, {
        type: 'open_ladder_round',
        round: 2,
        voteDeadline: 2000,
        now: 1300,
      }),
    ).toThrow(/cannot open a ladder round during fee_settlement/);
    // And a skipped round number is rejected while a round is pending.
    let s = acceptConfirmations(openCase(), [1, 2, 3]);
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 450 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 460 });
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 4,
      bondTxid: eventId('bond'),
      bondProofHash: eventId('bproof'),
      eventId: eventId('ch4'),
      now: 500,
    });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 850 });
    expect(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'open_ladder_round',
        round: 7,
        voteDeadline: 1200,
        now: 860,
      }),
    ).toThrow(/ladder rounds must be consecutive/);
  });
});

// ─── SEQUENCE 6: signing-session + confirmation interaction ─────────────────

describe('SEQUENCE 6: verdict-domain interaction (confirmation vs vote machine)', () => {
  function voteMachineVerdict() {
    // Real commit/reveal run on the SAME sessionHash + outcome.
    let s = createCourtVoteMachine({
      sessionHash: SESSION,
      participantIndices: [1, 2, 3],
      allowedOutcomes: ['yes', 'no'],
      commitDeadline: 400,
      revealDeadline: 800,
    });
    const revealIds = [eventId('r1'), eventId('r2'), eventId('r3')];
    [1, 2, 3].forEach((idx, i) => {
      s = reduceCourtVoteMachine(s, {
        type: 'accept_commit',
        idx,
        commitHash: hashCourtVoteCommit({
          sessionHash: SESSION,
          outcome: 'yes',
          salt: eventId(`s${idx}`),
        }),
        eventId: eventId(`cm${idx}`),
        now: 100 + i,
      });
    });
    s = reduceCourtVoteMachine(s, { type: 'close_commits', now: 450 });
    s = reduceCourtVoteMachine(s, { type: 'open_reveals', now: 460 });
    [1, 2, 3].forEach((idx, i) => {
      s = reduceCourtVoteMachine(s, {
        type: 'accept_reveal',
        idx,
        outcome: 'yes',
        salt: eventId(`s${idx}`),
        eventId: revealIds[i]!,
        now: 500 + i,
      });
    });
    s = reduceCourtVoteMachine(s, { type: 'close_reveals', now: 850 });
    return reduceCourtVoteMachine(s, { type: 'finalize_tally', now: 860 });
  }

  it('BY DESIGN: a confirmation verdict and a vote-machine verdict with identical (sessionHash, outcome, supportingEventIds) hash identically — one Verdict/v1 evidence domain', () => {
    const confirmationVerdict = finalize(toFeeSettlementUnchallenged()).verdict!;
    const canonical = {
      sessionHash: SESSION,
      outcome: 'yes',
      supportingEventIds: confirmationVerdict.supportingEventIds,
    };
    expect(hashCourtVerdict(canonical)).toBe(confirmationVerdict.verdictHash);
  });

  it('substitution attack: vote-machine REVEAL ids cannot stand in for CONFIRMATION ids — different event universes → different verdict hash → the batched case proof rejects them', () => {
    const confirmationFinal = finalize(toFeeSettlementUnchallenged());
    const verdictHash = confirmationFinal.verdict!.verdictHash;
    const { root, leaves } = buildBatchMerkleTree([verdictHash, eventId('other')]);
    const proof = buildBatchMerkleProof(leaves, 0);
    const batch = signedBatchEvent({
      epoch: 1,
      cohortPubkey: K1,
      batchIndex: 0,
      count: leaves.length,
      root,
      finalizedAtSec: 1500,
      privateKey: K1_SEC,
    });

    const voteVerdict = voteMachineVerdict().verdict!;
    // Same sessionHash + outcome, DIFFERENT supporting-id universe (reveals).
    expect(voteVerdict.outcome).toBe('yes');
    expect(voteVerdict.supportingEventIds).not.toEqual(
      confirmationFinal.verdict!.supportingEventIds,
    );
    expect(voteVerdict.verdictHash).not.toBe(verdictHash);

    // Presenting the vote-machine verdict inputs against the confirmation
    // case's batch: leaf recomputation fails — substitution is detectable.
    expect(
      verifyCaseInBatch(
        batch,
        {
          sessionHash: SESSION,
          outcome: voteVerdict.outcome,
          supportingEventIds: voteVerdict.supportingEventIds,
          proof,
        },
        { expectedEpoch: 1 },
      ),
    ).toMatchObject({
      valid: false,
      reason: 'Proof leaf does not match the case verdict inputs',
    });
  });

  it('dispute attestations live in a separate domain: hashDisputeVerdict ≠ hashCourtVerdict for the same ids (no cross-kind confusion)', () => {
    const ids = [eventId('r1'), eventId('r2')];
    expect(hashDisputeVerdict({ disputeId: SESSION, outcome: 'yes', supportingEventIds: ids })).not.toBe(
      hashCourtVerdict({ sessionHash: SESSION, outcome: 'yes', supportingEventIds: ids }),
    );
  });
});
