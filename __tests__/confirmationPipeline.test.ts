// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * End-to-end pipeline test for the v0.8.0 universal-confirmation core:
 * epoch cohort → confirmation machine (both branches) → verdict hashes →
 * Merkle batch → real-Schnorr batch attestation → per-case verification →
 * v2 finality binding → epoch rotation handoff. Proves the modules
 * interlock with real cryptography, not just in isolation.
 */

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  assertEpochRotationOrdering,
  createCourtEpochCohort,
  hashCourtEpochCohort,
  hashCourtEpochHandoff,
} from '../epochCohort';
import {
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  buildAttestationMessageV2,
} from '../crypto';
import {
  buildBatchAttestationEvent,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
  hashBatchManifest,
  validateBatchAttestationEvent,
  verifyCaseInBatch,
} from '../batchAttestation';
import { hashCourtVerdict } from '../courtVoteMachine';
import { hexId as hex } from './helpers/ids';
import { schnorrKeypairHex as keypair } from './helpers/keys';

const SESSION = hex('1');

function runConfirmation(votes: ReadonlyArray<readonly [number, 'YES' | 'NO']>): {
  state: CourtConfirmationMachineState;
  verdictHash: string;
} {
  const PROPOSAL = hex('2');
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [1, 2, 3],
    confirmQuorum: 3,
    confirmDeadline: 2000,
    challengeDeadline: 3000,
  });
  for (const idx of [1, 2, 3]) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: hex(String.fromCharCode(0x61 + idx - 1)), // a, b, c
      now: 1000 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
  if (votes.length > 0) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 2,
      bondTxid: hex('3'),
      bondProofHash: hex('4'),
      eventId: hex('5'),
      now: 2500,
    });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 4000, now: 3100 });
    for (const [idx, outcome] of votes) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_mass_vote',
        idx,
        outcome,
        eventId: hex(String.fromCharCode(0x64 + idx - 1)), // d, e, f (hex-safe)
        now: 3200 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 4000 });
    s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 4100 });
    // Round 1 of a maxLadderRounds=2 case parks in round_resolved; the host
    // concedes to settle with the round outcome (multi-round ladder, 0.9).
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 4150 });
  } else {
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'record_fee', feeEventId: hex('6'), now: 4200 });
  s = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 4300 });
  expect(s.phase).toBe('final');
  return { state: s, verdictHash: s.verdict!.verdictHash };
}

describe('universal-confirmation end-to-end pipeline', () => {
  const cohort1 = createCourtEpochCohort({
    epochId: 1,
    cohortIndex: 0,
    cohortPubkey: hex('a'),
    threshold: 2,
    participantCount: 3,
    startsAtSec: 1_000,
    endsAtSec: 1_000 + 14 * 86_400,
    suite: 'pedpop-v1-experimental',
  });

  it('uncontested case: cohort → confirmations → verdict → batch → real-signature verification', () => {
    const { state, verdictHash } = runConfirmation([]);
    expect(state.verdict?.upheld).toBe(true);

    // Batch two verdicts (this case + a companion case) under the cohort.
    const companion = hashCourtVerdict({
      sessionHash: SESSION,
      outcome: 'NO',
      supportingEventIds: [hex('d'), hex('e')].sort(),
    });
    const verdicts = [verdictHash, companion];
    const tree = buildBatchMerkleTree(verdicts);
    // `leaves` are the hashed BatchLeaf digests in sorted-input order — find
    // this case's index in the sorted input, not in the hashed leaf array.
    const sortedInput = [...verdicts].sort();
    const proof = buildBatchMerkleProof(tree.leaves, sortedInput.indexOf(verdictHash));

    // Real Schnorr signature over the batch manifest by the cohort key.
    const kp = keypair();
    const cohort = createCourtEpochCohort({ ...cohort1, cohortPubkey: kp.pub });
    const manifest = {
      epoch: cohort.epochId,
      cohortPubkey: cohort.cohortPubkey,
      batchIndex: 0,
      count: verdicts.length,
      root: tree.root,
      finalizedAtSec: 1_700,
    };
    const signature = bytesToHex(
      schnorr.sign(hexToBytes(hashBatchManifest(manifest)), hexToBytes(kp.sec)),
    );
    const event = buildBatchAttestationEvent({ ...manifest, signature, createdAt: 1_700 });

    const validation = validateBatchAttestationEvent(event, {
      expectedGroupPubkey: kp.pub,
      expectedEpoch: 1,
      expectedCohort: kp.pub,
      expectedFinalizedAtSec: 1_700,
    });
    expect(validation.valid).toBe(true);

    // The case verifies inside the batch; a foreign case does not.
    const caseInput = {
      sessionHash: SESSION,
      outcome: 'YES',
      supportingEventIds: [hex('a'), hex('b'), hex('c')].sort(),
      proof,
    };
    expect(verifyCaseInBatch(event, caseInput).valid).toBe(true);
    expect(
      verifyCaseInBatch(event, { ...caseInput, outcome: 'NO' }).valid,
    ).toBe(false);
  });

  it('challenged case: overturn → clawback flags → verdict still batch-verifiable', () => {
    const { state, verdictHash } = runConfirmation([
      [1, 'NO'],
      [2, 'NO'],
      [3, 'YES'],
    ]);
    expect(state.verdict?.outcome).toBe('NO');
    expect(state.verdict?.upheld).toBe(false);
    expect(state.clawbackFlags).toHaveLength(3);

    const tree = buildBatchMerkleTree([verdictHash]);
    const kp = keypair();
    const manifest = {
      epoch: 1,
      cohortPubkey: kp.pub,
      batchIndex: 1,
      count: 1,
      root: tree.root,
      finalizedAtSec: 1_800,
    };
    const signature = bytesToHex(
      schnorr.sign(hexToBytes(hashBatchManifest(manifest)), hexToBytes(kp.sec)),
    );
    const event = buildBatchAttestationEvent({ ...manifest, signature, createdAt: 1_800 });
    expect(validateBatchAttestationEvent(event).valid).toBe(true);
    expect(
      verifyCaseInBatch(event, {
        sessionHash: SESSION,
        outcome: 'NO',
        supportingEventIds: [hex('d'), hex('e')].sort(),
        proof: buildBatchMerkleProof(tree.leaves, 0),
      }).valid,
    ).toBe(true);
  });

  it('v2 attestation binding signs the full finality tuple with a real key', () => {
    const { verdictHash } = runConfirmation([]);
    const kp = keypair();
    const signerSetRoot = hex('b');
    const message = buildAttestationMessageV2({
      marketId: 'm1',
      outcome: 'YES',
      round: 0,
      disputeEventId: hex('5'),
      verdictHash,
      epochId: cohort1.epochId,
      tier: 0,
      threshold: cohort1.threshold,
      signerSetRoot,
      attempt: 1,
    });
    const signature = bytesToHex(schnorr.sign(hexToBytes(message), hexToBytes(kp.sec)));
    // A verifier with only the pinned key + public fields validates the tuple.
    expect(schnorr.verify(hexToBytes(signature), hexToBytes(message), hexToBytes(kp.pub))).toBe(true);
    // Any binding-field change invalidates the signature (replay defense).
    const tampered = buildAttestationMessageV2({
      marketId: 'm1',
      outcome: 'YES',
      round: 0,
      disputeEventId: hex('5'),
      verdictHash,
      epochId: cohort1.epochId + 1,
      tier: 0,
      threshold: cohort1.threshold,
      signerSetRoot,
      attempt: 1,
    });
    expect(schnorr.verify(hexToBytes(signature), hexToBytes(tampered), hexToBytes(kp.pub))).toBe(false);
  });

  it('epoch rotation: ordering rules + handoff chain resolve historical keys', () => {
    const kp1 = keypair();
    const kp2 = keypair();
    const epoch1 = createCourtEpochCohort({
      ...cohort1,
      cohortPubkey: kp1.pub,
      threshold: 2,
      participantCount: 3,
    });
    const epoch2 = createCourtEpochCohort({
      ...cohort1,
      epochId: 2,
      cohortPubkey: kp2.pub,
      threshold: 2,
      participantCount: 3,
      startsAtSec: epoch1.endsAtSec,
      endsAtSec: epoch1.endsAtSec + 14 * 86_400,
    });
    const previousHash = assertEpochRotationOrdering(epoch1, epoch2);
    expect(previousHash).toBe(hashCourtEpochCohort(epoch1));
    const handoff = hashCourtEpochHandoff({
      previousCohortHash: previousHash,
      nextCohortHash: hashCourtEpochCohort(epoch2),
      activatedAtSec: epoch2.startsAtSec,
    });
    expect(handoff).toMatch(/^[0-9a-f]{64}$/);
  });
});
