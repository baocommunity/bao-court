// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 8 — batch attestations ACROSS cohort rotations (epoch N vs N+1).
 *
 * A kind-39018 batch attestation certifies one epoch's verdict cohort, and its
 * canonical manifest binds `(epoch, cohortPubkey, batchIndex, count, root,
 * finalizedAtSec)`. That binding is the finality seam between two consecutive
 * FROST cohorts: the successor cohort signs `epoch = N+1` over ITS OWN key, and
 * a consumer that pins the epoch/cohort it asked for must reject anything else.
 *
 * Every corpus unit is one BATCH inside a rotation timeline: batches are laid
 * out across epochs (a new cohort every `BATCHES_PER_EPOCH` batches, each
 * rotation validated by `assertEpochRotationOrdering`), signed with a real
 * Schnorr cohort key derived from the campaign seed, and then verified through
 * the production verifiers. Invariants:
 *
 *   R1  rotation ordering: epoch ids increment by exactly one, the group key
 *       CHANGES (same-key rotation is a no-op, never an epoch), and the
 *       validity window moves forward — every violation is a typed
 *       `CourtEpochCohortError`, never a silently accepted cohort;
 *   R2  a valid batch verifies under its OWN pins (`expectedEpoch`,
 *       `expectedCohort`, `expectedGroupPubkey`) and fails under the previous
 *       epoch's pins and the next epoch's pins ("epoch N's verdict presented to
 *       an epoch N+1 consumer is refused");
 *   R3  an epoch-N+1 cohort cannot certify epoch N: re-signing an old batch
 *       under the NEW cohort key with the OLD epoch tag (and vice versa) fails
 *       the signature check — the manifest binds epoch + cohort + root
 *       together, so neither half can be swapped independently;
 *   R4  cross-epoch re-batching of the SAME verdict hash by a successor cohort
 *       is legal and independently verifiable (`verifyCaseInBatch` accepts the
 *       proof in BOTH epochs) — which is exactly why reputation must dedupe by
 *       verdict hash, not by batch membership (SEQUENCE-2);
 *   R5  case-membership proofs stay sound across rotations: each case of the
 *       batch verifies with `verifyCaseInBatch`, and a proof carried into a
 *       DIFFERENT epoch's batch (same path, other root) is rejected.
 *
 * Unit of the corpus: one batch. The artifact records how many rotations,
 * epoch/cohort pin mismatches, re-signings and case proofs the run actually
 * exercised.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';

import {
  assertEpochRotationOrdering,
  createCourtEpochCohort,
  hashCourtEpochCohort,
  type CourtEpochCohort,
} from '../../epochCohort';
import {
  buildBatchAttestationEvent,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
  hashBatchManifest,
  validateBatchAttestationEvent,
  verifyCaseInBatch,
} from '../../batchAttestation';
import { hashCourtVerdict } from '../../courtVoteMachine';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, timingMetrics, type CampaignResult } from './corpus';

/** Batches per epoch — small, so 1,000 batches span ~40 rotations. */
const BATCHES_PER_EPOCH = 25;
const MAX_BATCH = 8;

/** Deterministic cohort keypair for (seed, epoch): `sha256('BAO-Court/epoch/<seed>/<epoch>')`. */
function cohortKey(seed: number, epoch: number): { sec: Uint8Array; pub: string } {
  const sec = sha256(new TextEncoder().encode(`BAO-Court/epoch/${seed}/${epoch}`));
  return { sec, pub: getPublicKey(sec) };
}

/** A verdict hash + the (sessionHash, outcome, supportingEventIds) inputs it commits to. */
interface VerdictCase {
  readonly sessionHash: string;
  readonly outcome: string;
  readonly supportingEventIds: readonly string[];
  readonly verdictHash: string;
}

/** Deterministic 32-byte hex id for (seed, label). */
function hexId(seed: number, label: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`BAO-Court/epoch/${seed}/${label}`)));
}

function makeVerdict(seed: number, epoch: number, caseIndex: number): VerdictCase {
  const sessionHash = hexId(seed, `session-${epoch}-${caseIndex}`);
  const outcome = caseIndex % 2 === 0 ? 'YES' : 'NO';
  const supportingEventIds = [hexId(seed, `witness-${epoch}-${caseIndex}-0`)];
  return {
    sessionHash,
    outcome,
    supportingEventIds,
    verdictHash: hashCourtVerdict({ sessionHash, outcome, supportingEventIds }),
  };
}

/**
 * The cohort timeline: one cohort per epoch, chained through
 * `assertEpochRotationOrdering`. A violation is recorded, never thrown out of
 * the campaign (the reporter owns the exit code).
 */
function buildTimeline(reporter: CampaignReporter, seed: number, epochs: number): CourtEpochCohort[] {
  const cohorts: CourtEpochCohort[] = [];
  const t0 = 1_700_000_000;
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    const { pub } = cohortKey(seed, epoch);
    const cohort = createCourtEpochCohort({
      epochId: epoch,
      cohortIndex: epoch - 1,
      cohortPubkey: pub,
      threshold: 2,
      participantCount: 3,
      startsAtSec: t0 + (epoch - 1) * 86_400,
      endsAtSec: t0 + epoch * 86_400,
      suite: 'pedpop-v1-experimental',
    });
    const previous = cohorts[cohorts.length - 1];
    if (previous !== undefined) {
      try {
        const previousHash = assertEpochRotationOrdering(previous, cohort);
        // R1 — the handoff anchor is the PREVIOUS cohort's canonical hash.
        reporter.equals(
          `rotation#${epoch}`,
          previousHash,
          hashCourtEpochCohort(previous),
          'R1: assertEpochRotationOrdering must return the previous cohort hash',
        );
      } catch (err) {
        reporter.fail(`rotation#${epoch}`, `R1: a legal rotation was refused: ${describe(err)}`);
      }
      // R1 (negative rows): same-key rotation, skipped epoch, backwards window.
      const negativeRows: Array<[string, () => CourtEpochCohort]> = [
        ['same-key-rotation', () => createCourtEpochCohort({ ...cohort, epochId: previous.epochId + 1, cohortPubkey: previous.cohortPubkey, startsAtSec: previous.startsAtSec + 1, endsAtSec: previous.endsAtSec + 1 })],
        ['skipped-epoch', () => createCourtEpochCohort({ ...cohort, epochId: previous.epochId + 2 })],
        ['backwards-window', () => createCourtEpochCohort({ ...cohort, epochId: previous.epochId + 1, startsAtSec: previous.startsAtSec, endsAtSec: previous.endsAtSec })],
      ];
      for (const [name, make] of negativeRows) {
        let thrown: unknown;
        try {
          assertEpochRotationOrdering(previous, make());
        } catch (err) {
          thrown = err;
        }
        reporter.ok(
          `rotation#${epoch}/${name}`,
          thrown !== undefined && (thrown as Error).name === 'CourtEpochCohortError',
          `R1: ${name} must be a typed CourtEpochCohortError`,
        );
      }
    }
    cohorts.push(cohort);
  }
  return cohorts;
}

interface RotationStats {
  batches: number;
  rotations: number;
  casesBatched: number;
  validBatches: number;
  epochPinRejections: number;
  cohortPinRejections: number;
  resigningRejections: number;
  crossEpochReplays: number;
  caseProofs: number;
  foreignEpochProofRejections: number;
  perBatchMs: number[];
}

/** Run one batch unit at `batchIndex` (1-based) over the cohort timeline. */
function runBatchUnit(
  reporter: CampaignReporter,
  seed: number,
  batchIndex: number,
  cohorts: readonly CourtEpochCohort[],
  stats: RotationStats,
): void {
  const r = childRng(seed + batchIndex, 'epoch-batch');
  const epoch = 1 + Math.floor((batchIndex - 1) / BATCHES_PER_EPOCH);
  const cohort = cohorts[Math.min(cohorts.length - 1, epoch - 1)]!;
  const previousCohort = cohorts[Math.max(0, cohort.epochId - 2)];
  const nextCohort = cohorts[Math.min(cohorts.length - 1, cohort.epochId)];
  const label = `batch#${batchIndex} (epoch ${cohort.epochId})`;
  const started = nowMs();

  const caseCount = int(r, 1, MAX_BATCH);
  // The batch tree sorts verdict hashes ascending bytewise, and a proof index
  // refers to THAT sorted order — so the case list is sorted identically here,
  // keeping `cases[i]` aligned with `tree.leaves[i]`.
  const cases = Array.from({ length: caseCount }, (_, i) => makeVerdict(seed, cohort.epochId, i))
    .sort((left, right) => compareHexBytewise(left.verdictHash, right.verdictHash));
  const hashes = cases.map((entry) => entry.verdictHash);
  const tree = buildBatchMerkleTree(hashes);
  const finalizedAtSec = 1_700_000_000 + batchIndex;
  const batchIdx = batchIndex % BATCHES_PER_EPOCH;

  const sign = (params: {
    epoch: number;
    cohortPubkey: string;
    count: number;
    root: string;
    signatureKey: Uint8Array;
    createdAt: number;
  }): NostrEvent => {
    const manifest = hashBatchManifest({
      epoch: params.epoch,
      cohortPubkey: params.cohortPubkey,
      batchIndex: batchIdx,
      count: params.count,
      root: params.root,
      finalizedAtSec,
    });
    const signature = bytesToHex(schnorr.sign(hexToBytes(manifest), params.signatureKey));
    return buildBatchAttestationEvent({
      epoch: params.epoch,
      cohortPubkey: params.cohortPubkey,
      batchIndex: batchIdx,
      count: params.count,
      root: params.root,
      finalizedAtSec,
      signature,
      createdAt: params.createdAt,
    });
  };

  const epochKey = cohortKey(seed, cohort.epochId);
  const event = sign({
    epoch: cohort.epochId,
    cohortPubkey: cohort.cohortPubkey,
    count: caseCount,
    root: tree.root,
    signatureKey: epochKey.sec,
    createdAt: finalizedAtSec,
  });
  stats.batches += 1;
  stats.casesBatched += caseCount;

  // ── R2: the batch verifies under its own pins. ──
  const own = validateBatchAttestationEvent(event, {
    expectedGroupPubkey: cohort.cohortPubkey,
    expectedEpoch: cohort.epochId,
    expectedCohort: cohort.cohortPubkey,
  });
  if (own.valid) {
    stats.validBatches += 1;
  } else {
    reporter.fail(label, `R2: a valid epoch-${cohort.epochId} batch was refused: ${own.reason ?? 'no reason'}`);
    return;
  }

  // ── R2 (negative): the NEIGHBOURING epochs' pins must refuse it. ──
  const pinnedEpochs = [cohort.epochId - 1, cohort.epochId + 1].filter((value) => value >= 0);
  for (const pinned of pinnedEpochs) {
    const result = validateBatchAttestationEvent(event, {
      expectedGroupPubkey: cohort.cohortPubkey,
      expectedEpoch: pinned,
    });
    reporter.ok(label, !result.valid, `R2: epoch ${cohort.epochId} batch must be refused under expectedEpoch=${pinned}`);
    if (!result.valid && (result.reason ?? '').includes('Epoch mismatch')) stats.epochPinRejections += 1;
  }
  for (const other of [previousCohort, nextCohort]) {
    if (other === undefined || other.cohortPubkey === cohort.cohortPubkey) continue;
    // Only the cohort pin is set: with a group-key pin present the group check
    // would answer first and the cohort binding would go untested.
    const result = validateBatchAttestationEvent(event, { expectedCohort: other.cohortPubkey });
    reporter.ok(label, !result.valid, `R2: epoch ${cohort.epochId} batch must be refused under another cohort's pins`);
    if (!result.valid && (result.reason ?? '').includes('Cohort mismatch')) stats.cohortPinRejections += 1;
    const groupResult = validateBatchAttestationEvent(event, { expectedGroupPubkey: other.cohortPubkey });
    reporter.ok(label, !groupResult.valid, 'R2: the batch must be refused under another epoch\'s group key');
  }

  // ── R3: re-signing an epoch-N batch under the epoch-N+1 cohort key. ──
  if (nextCohort !== undefined && nextCohort.cohortPubkey !== cohort.cohortPubkey) {
    const nextKey = cohortKey(seed, nextCohort.epochId);
    // (a) old epoch tag, NEW cohort key: the manifest the successor signed
    // names the NEW cohort, so an event claiming the new pubkey but the old
    // epoch cannot verify.
    const swapped = sign({
      epoch: cohort.epochId,
      cohortPubkey: nextCohort.cohortPubkey,
      count: caseCount,
      root: tree.root,
      signatureKey: nextKey.sec,
      createdAt: finalizedAtSec,
    });
    const swappedResult = validateBatchAttestationEvent(swapped, {
      expectedGroupPubkey: cohort.cohortPubkey,
      expectedEpoch: cohort.epochId,
    });
    reporter.ok(label, !swappedResult.valid, 'R3: an epoch-N batch signed by the N+1 cohort must be refused');
    if (!swappedResult.valid) stats.resigningRejections += 1;

    // (b) NEW epoch tag signed with the OLD cohort's key: the signature does
    // not verify under the claimed cohort pubkey.
    const forged = sign({
      epoch: nextCohort.epochId,
      cohortPubkey: nextCohort.cohortPubkey,
      count: caseCount,
      root: tree.root,
      signatureKey: epochKey.sec,
      createdAt: finalizedAtSec,
    });
    const forgedResult = validateBatchAttestationEvent(forged, {
      expectedGroupPubkey: nextCohort.cohortPubkey,
      expectedEpoch: nextCohort.epochId,
    });
    reporter.ok(label, !forgedResult.valid, 'R3: an epoch-N+1 event signed with the OLD cohort key must be refused');
    if (!forgedResult.valid) stats.resigningRejections += 1;
  }

  // ── R4: the SAME verdict hash re-batched by the successor cohort. ──
  if (nextCohort !== undefined && nextCohort.cohortPubkey !== cohort.cohortPubkey) {
    const successorKey = cohortKey(seed, nextCohort.epochId);
    const rebatched = buildBatchMerkleTree([cases[0]!.verdictHash]);
    const successorEpochKey = successorKey;
    const manifest = hashBatchManifest({
      epoch: nextCohort.epochId,
      cohortPubkey: nextCohort.cohortPubkey,
      batchIndex: 0,
      count: 1,
      root: rebatched.root,
      finalizedAtSec,
    });
    const reEvent = buildBatchAttestationEvent({
      epoch: nextCohort.epochId,
      cohortPubkey: nextCohort.cohortPubkey,
      batchIndex: 0,
      count: 1,
      root: rebatched.root,
      finalizedAtSec,
      signature: bytesToHex(schnorr.sign(hexToBytes(manifest), successorEpochKey.sec)),
      createdAt: finalizedAtSec,
    });
    const reResult = validateBatchAttestationEvent(reEvent, {
      expectedGroupPubkey: nextCohort.cohortPubkey,
      expectedEpoch: nextCohort.epochId,
    });
    reporter.ok(label, reResult.valid, 'R4: cross-epoch re-batching by the successor cohort must verify');
    if (reResult.valid) {
      stats.crossEpochReplays += 1;
      // …and the SAME case inputs verify in BOTH epochs (per-batch membership
      // is independent — reputation must dedupe by verdictHash).
      const originalProof = buildBatchMerkleProof(tree.leaves, 0);
      const successorProof = buildBatchMerkleProof(rebatched.leaves, 0);
      const inOriginal = verifyCaseInBatch(event, { ...cases[0]!, proof: originalProof }, {
        expectedGroupPubkey: cohort.cohortPubkey,
        expectedEpoch: cohort.epochId,
      });
      const inSuccessor = verifyCaseInBatch(reEvent, { ...cases[0]!, proof: successorProof }, {
        expectedGroupPubkey: nextCohort.cohortPubkey,
        expectedEpoch: nextCohort.epochId,
      });
      reporter.ok(label, inOriginal.valid && inSuccessor.valid, 'R4: the same case must verify in both epochs');
      stats.caseProofs += 2;
    }
  }

  // ── R5: case membership proofs, and a proof carried to the wrong batch. ──
  const proofIndexes = caseCount <= 3 ? [...hashes.keys()] : [0, Math.floor(caseCount / 2), caseCount - 1];
  for (const index of proofIndexes) {
    const proof = buildBatchMerkleProof(tree.leaves, index);
    const verified = verifyCaseInBatch(event, { ...cases[index]!, proof }, {
      expectedGroupPubkey: cohort.cohortPubkey,
      expectedEpoch: cohort.epochId,
    });
    reporter.ok(label, verified.valid, `R5: case ${index} must verify in its own epoch batch: ${verified.reason ?? ''}`);
    if (verified.valid) stats.caseProofs += 1;
    // The same proof against a proof for a DIFFERENT index must not verify the
    // presented case inputs.
    if (caseCount > 1 && index !== (index + 1) % caseCount) {
      const borrowed = buildBatchMerkleProof(tree.leaves, (index + 1) % caseCount);
      const wrong = verifyCaseInBatch(event, { ...cases[index]!, proof: borrowed }, {
        expectedGroupPubkey: cohort.cohortPubkey,
        expectedEpoch: cohort.epochId,
      });
      reporter.ok(label, !wrong.valid, 'R5: a borrowed proof must not authenticate different case inputs');
      if (!wrong.valid) stats.foreignEpochProofRejections += 1;
    }
  }

  stats.perBatchMs.push(Math.round((nowMs() - started) * 1000) / 1000);
}

/** Bytewise (charCode) comparator — the batch tree's leaf ordering. */
function compareHexBytewise(left: string, right: string): number {
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = left.charCodeAt(i) - right.charCodeAt(i);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Run the campaign: `size` batches laid out across `ceil(size / 25)` epochs,
 * one cohort rotation every 25 batches.
 */
export function runEpochRotationCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('epochRotation', 'batches', opts.size, seed);
  const epochCount = Math.max(1, Math.ceil(opts.size / BATCHES_PER_EPOCH));
  const cohorts = buildTimeline(reporter, seed, epochCount);
  const stats: RotationStats = {
    batches: 0,
    rotations: cohorts.length - 1,
    casesBatched: 0,
    validBatches: 0,
    epochPinRejections: 0,
    cohortPinRejections: 0,
    resigningRejections: 0,
    crossEpochReplays: 0,
    caseProofs: 0,
    foreignEpochProofRejections: 0,
    perBatchMs: [],
  };

  for (let batchIndex = 1; batchIndex <= opts.size; batchIndex += 1) {
    runBatchUnit(reporter, seed, batchIndex, cohorts, stats);
  }

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      epochs: cohorts.length,
      rotations: stats.rotations,
      batches: stats.batches,
      casesBatched: stats.casesBatched,
      validBatches: stats.validBatches,
      epochPinRejections: stats.epochPinRejections,
      cohortPinRejections: stats.cohortPinRejections,
      resigningRejections: stats.resigningRejections,
      crossEpochReplays: stats.crossEpochReplays,
      caseProofs: stats.caseProofs,
      foreignEpochProofRejections: stats.foreignEpochProofRejections,
      ...timingMetrics(stats.perBatchMs),
    },
    [
      `${BATCHES_PER_EPOCH} batches per epoch → ${cohorts.length} cohorts, ${stats.rotations} rotations`,
      'real Schnorr cohort keys (sha256-derived per (seed, epoch)); every batch signature is a real FROST-manifest signature verified by the production verifier',
      'rotations are chained through assertEpochRotationOrdering; same-key / skipped-epoch / backwards-window rotations are asserted typed refusals',
      'cross-epoch re-batching is asserted LEGAL and independently verifiable (dedupe reputation by verdictHash, not by batch membership)',
    ],
  );
}
