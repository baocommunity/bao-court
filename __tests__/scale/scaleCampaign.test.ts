// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * scale campaign — the CI-bounded FAST subset of the large-corpus campaigns.
 *
 * Each campaign module in this directory drives one production surface through
 * tens of thousands of seeded cases in the FULL run
 * (`scripts/campaign/run-campaign.mjs --full`, artifact in
 * `docs/benchmarks/`). CI cannot afford the full corpus, so this file runs the
 * declared FAST profile of EVERY campaign and asserts:
 *
 *   1. ZERO failed checks — the campaign's own invariant battery (see the
 *      module JSDoc: C1..C6, tally oracle parity, M1..M5, the accept/reject
 *      matrix, S1..S6, E1..E5);
 *   2. the campaign actually EXERCISED its paths (coverage counters, not just
 *      "nothing failed"): every terminal phase, forced ties, tamper rows,
 *      determinism/recompute samples, unicode and boundary payloads;
 *   3. the declared corpus table has not silently drifted (the artifact in
 *      `docs/benchmarks/SCALE_CAMPAIGN.md` is generated from these numbers).
 *
 * Determinism: every campaign derives all randomness from one seed literal, so
 * a failure here is reproducible from `(profile, seed)` alone — no sleeps, no
 * `Date.now()` in any assertion.
 */

import { describe, expect, it } from 'vitest';

import { SIZES, percentile, timingMetrics, type CampaignResult, type MetricValue } from './corpus';
import { CAMPAIGNS, CORPUS_NAMES, declaredSizes, runCampaign } from './index';
import { TRANSPORT_ROWS } from './escalationTransportCorpus';
import { GRID_CELLS } from './ledgerBarrierCorpus';

/** Assert a campaign is green and its failure detail is attached to the message. */
function expectGreen(result: CampaignResult): void {
  const detail = result.failures
    .map((failure) => `  [${failure.corpus}] ${failure.case}\n    ${failure.message}`)
    .join('\n');
  expect(
    result.failedChecks,
    `${result.name} campaign: ${result.failedChecks}/${result.checks} failed check(s)\n${detail}`,
  ).toBe(0);
  expect(result.checks, `${result.name} campaign executed no checks`).toBeGreaterThan(0);
  expect(result.corpus, `${result.name} campaign ran an empty corpus`).toBeGreaterThan(0);
}

/** Numeric metric accessor (metrics are `number | number[]`). */
function num(result: CampaignResult, key: string): number {
  const value: MetricValue | undefined = result.metrics[key];
  if (typeof value !== 'number') throw new Error(`metric '${key}' of ${result.name} is not a number: ${String(value)}`);
  return value;
}

const PROFILE = 'fast' as const;
const SEED = 20_261_111;

describe('scale campaign: declared corpus table', () => {
  it('pins the FAST/FULL sizes the artifact documents', () => {
    expect(SIZES.confirmationSequences).toEqual({ fast: 250, full: 10_000 });
    expect(SIZES.tallies).toEqual({ fast: 15_000, full: 1_000_000 });
    expect(SIZES.merkleBatches).toEqual({ fast: 40, full: 1_000 });
    expect(SIZES.attestationEvents).toEqual({ fast: 250, full: 50_000 });
    expect(SIZES.selectionDraws).toEqual({ fast: 200, full: 10_000 });
    expect(SIZES.encodings).toEqual({ fast: 2_000, full: 100_000 });
    expect(SIZES.witnessEvents).toEqual({ fast: 250, full: 10_000 });
    expect(SIZES.epochBatches).toEqual({ fast: 40, full: 1_000 });
    expect(SIZES.finalityChains).toEqual({ fast: 100, full: 5_000 });
    expect(SIZES.escalationRequests).toEqual({ fast: 400, full: 200_000 });
    expect(SIZES.barrierStates).toEqual({ fast: 300, full: 100_000 });
    expect(SIZES.bondSequences).toEqual({ fast: 200, full: 100_000 });
    expect(declaredSizes('fast')).toEqual({
      confirmation: 250,
      tally: 15_000,
      merkle: 40,
      validator: 250,
      selection: 200,
      encoding: 2_000,
      witness: 250,
      epochRotation: 40,
      finality: 100,
      escalationTransport: 400,
      ledgerBarrier: 300,
      bondAlgebra: 200,
    });
    expect(Object.keys(CAMPAIGNS).sort()).toEqual([...CORPUS_NAMES].sort());
  });
});

describe('scale campaign: scaffolding', () => {
  it('summarises a 250,000-sample timing array without blowing the argument limit', () => {
    // Regression lock: `timingMetrics` used `Math.max(...samples)`, which throws
    // `RangeError: Maximum call stack size exceeded` once a campaign records more
    // per-unit samples than the engine's argument limit (~125k here). The
    // transport campaign records one per unit, so a 200,000-unit FULL run died in
    // the summary rather than in the corpus.
    const samples = Array.from({ length: 250_000 }, (_, index) => index);
    const summary = timingMetrics(samples);
    expect(summary.maxMs).toBe(249_999);
    expect(summary.medianMs).toBe(124_999);
    expect(summary.meanMs).toBe(124_999.5);
    expect(summary.p95Ms).toBe(237_499);
    // The empty sample set stays well-defined (no -Infinity from a bare reduce).
    expect(timingMetrics([])).toMatchObject({ maxMs: 0, medianMs: 0, p95Ms: 0, meanMs: 0 });
    expect(percentile([], 50)).toBe(0);
  });
});

describe('scale campaign: confirmation machine sequences', () => {
  it('drives legal sequences with the invariant battery after every transition', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['confirmation'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    // Coverage: every terminal phase and every ladder honour path is reached.
    expect(num(campaign, 'terminalFinal')).toBeGreaterThan(0);
    expect(num(campaign, 'terminalExpired')).toBeGreaterThan(0);
    expect(num(campaign, 'terminalAborted')).toBeGreaterThan(0);
    expect(num(campaign, 'ladderReached')).toBeGreaterThan(0);
    expect(num(campaign, 'multiRound')).toBeGreaterThan(0);
    expect(num(campaign, 'escalated')).toBeGreaterThan(0);
    expect(num(campaign, 'conceded')).toBeGreaterThan(0);
    expect(num(campaign, 'overturned')).toBeGreaterThan(0);
    expect(num(campaign, 'expandedPanel')).toBeGreaterThan(0);
    expect(num(campaign, 'typedRejections')).toBeGreaterThan(0);
    expect(num(campaign, 'deepFreezeAudits')).toBeGreaterThan(0);
  });
});

describe('scale campaign: plurality tallies', () => {
  it('matches the independent reduce oracle on every tally (winner + supporting ids)', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['tally'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'tiesObserved')).toBeGreaterThan(0);
    expect(num(campaign, 'tiesForced')).toBeGreaterThan(0);
    expect(num(campaign, 'divergentOutcomeSets')).toBeGreaterThan(0);
    expect(num(campaign, 'controlTallies')).toBeGreaterThan(0);
    expect(num(campaign, 'verdictHashSamples')).toBeGreaterThan(0);
    expect(num(campaign, 'maxLedger')).toBe(50);
    expect(num(campaign, 'minLedger')).toBe(2);
  });
});

describe('scale campaign: Merkle batches', () => {
  it('re-derives every root, verifies proofs, and rejects the tamper matrix', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['merkle'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'determinismRebuilds')).toBe(SIZES.merkleBatches.fast);
    expect(num(campaign, 'proofsVerified')).toBeGreaterThan(0);
    expect(num(campaign, 'tamperRejections')).toBeGreaterThan(0);
    expect(num(campaign, 'tamperedProofs')).toBe(num(campaign, 'tamperRejections'));
    expect(num(campaign, 'maxBatch')).toBe(2048);
    expect(num(campaign, 'proofsFullyVerifiedBatches')).toBeGreaterThan(0);
  });
});

describe('scale campaign: signed v2 attestations', () => {
  it('honours the accept/reject matrix row by row (real signatures, real pins)', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['validator'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'accepted')).toBeGreaterThan(0);
    expect(num(campaign, 'rejected')).toBeGreaterThan(0);
    expect(num(campaign, 'distinctRows')).toBeGreaterThanOrEqual(20);
    expect(num(campaign, 'groupSignatures')).toBeGreaterThan(0);
  });
});

describe('scale campaign: jury selection', () => {
  it('is deterministic, duplicate-free, oracle-agreeing and weight-proportional', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['selection'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'quadraticDraws')).toBeGreaterThan(0);
    expect(num(campaign, 'weightDraws')).toBeGreaterThan(0);
    expect(num(campaign, 'determinismChecks')).toBeGreaterThan(0);
    expect(num(campaign, 'verifyChecks')).toBeGreaterThan(0);
    expect(num(campaign, 'referenceRankingChecks')).toBeGreaterThan(0);
    expect(num(campaign, 'maxRoster')).toBe(500);
    expect(num(campaign, 'chiSquare')).toBeLessThan(num(campaign, 'chiSquareCritical'));
  });
});

describe('scale campaign: canonical encodings', () => {
  it('is byte-identical to the reference writer and round-trips through the independent parser', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['encoding'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'roundTrips')).toBe(SIZES.encodings.fast);
    expect(num(campaign, 'prefixComparisons')).toBeGreaterThan(0);
    expect(num(campaign, 'injectivityMutations')).toBeGreaterThan(0);
    expect(num(campaign, 'unicodeEncodings')).toBeGreaterThan(0);
    expect(num(campaign, 'emptyPayloadEncodings')).toBeGreaterThan(0);
    expect(num(campaign, 'boundaryRejections')).toBeGreaterThan(0);
  });
});

describe('scale campaign: escalation witnesses (v0.12.0 escalate witness)', () => {
  it('refuses every illegal witness and accepts only the witnessed escalation', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['witness'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    // Coverage: both outcomes are exercised, the whole matrix runs, and the
    // adversarial rows (replay across cases, duplicate rounds, oversized
    // values, hand-restored cap) each fire.
    expect(num(campaign, 'accepted')).toBeGreaterThan(0);
    expect(num(campaign, 'rejected')).toBeGreaterThan(num(campaign, 'accepted'));
    expect(num(campaign, 'typedRejections')).toBeGreaterThan(0);
    expect(num(campaign, 'rawErrors')).toBe(0);
    expect(num(campaign, 'logRecordsAppended')).toBeGreaterThan(0);
    expect(num(campaign, 'maxLogDepth')).toBeGreaterThanOrEqual(1);
    expect(num(campaign, 'crossCaseReplays')).toBeGreaterThan(0);
    expect(num(campaign, 'duplicateRoundAttempts')).toBeGreaterThan(0);
    expect(num(campaign, 'capReachedProbes')).toBeGreaterThan(0);
    expect(num(campaign, 'oversizedValues')).toBeGreaterThan(0);
    // FAST (250 units) covers every accept row and most reject rows; the FULL
    // corpus covers all 27 rows × both outcomes.
    expect(num(campaign, 'distinctRows')).toBeGreaterThanOrEqual(10);
  });
});

describe('scale campaign: batch attestations across epoch rotations', () => {
  it('binds epoch + cohort, refuses neighbour pins, and re-batches across epochs', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['epochRotation'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'validBatches')).toBe(SIZES.epochBatches.fast);
    expect(num(campaign, 'epochPinRejections')).toBeGreaterThan(0);
    expect(num(campaign, 'crossEpochReplays')).toBeGreaterThan(0);
    expect(num(campaign, 'caseProofs')).toBeGreaterThan(0);
    expect(num(campaign, 'foreignEpochProofRejections')).toBeGreaterThan(0);
    // 40 batches at 25 per epoch = 2 epochs, so at least one rotation exists.
    expect(num(campaign, 'epochs')).toBeGreaterThanOrEqual(2);
    expect(num(campaign, 'rotations')).toBe(num(campaign, 'epochs') - 1);
  });
});

describe('scale campaign: verdict finality chains', () => {
  it('drives windows + escalations to a verdict and applies every finality shape', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['finality'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'chains')).toBe(SIZES.finalityChains.fast);
    expect(num(campaign, 'finalChains')).toBeGreaterThan(0);
    expect(num(campaign, 'abortedChains')).toBeGreaterThan(0);
    expect(num(campaign, 'expiredChains')).toBeGreaterThan(0);
    expect(num(campaign, 'challengeWindows')).toBeGreaterThan(0);
    expect(num(campaign, 'escalations')).toBeGreaterThan(0);
    expect(num(campaign, 'hostEscalations')).toBeGreaterThan(0);
    expect(num(campaign, 'verdictRecomputations')).toBe(num(campaign, 'finalChains'));
    expect(num(campaign, 'provenanceChecks')).toBe(num(campaign, 'finalChains'));
    expect(num(campaign, 'batchVerifications')).toBe(num(campaign, 'finalChains'));
    expect(num(campaign, 'caseProofs')).toBe(num(campaign, 'finalChains'));
    expect(num(campaign, 'epochPinRejections')).toBe(num(campaign, 'finalChains'));
    expect(num(campaign, 'tamperRejections')).toBe(num(campaign, 'finalChains') * 2);
    // Every terminal chain (final + aborted + expired) refuses a perfect witness.
    expect(num(campaign, 'terminalWitnessRejections')).toBe(num(campaign, 'chains'));
    expect(num(campaign, 'overturns')).toBeGreaterThan(0);
    expect(num(campaign, 'flipFlops')).toBeGreaterThan(0);
  });
});

describe('scale campaign: escalation-request transport (v0.14.0 wire)', () => {
  it('fails closed on every boundary id, duplicate key, pollution attempt and binding disagreement', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['escalationTransport'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    // T1: no raw throw escapes any stage.
    expect(num(campaign, 'rawErrors')).toBe(0);
    // T2: every row of the wire matrix fires (the FAST corpus rotates all of them).
    expect(num(campaign, 'rowsFired')).toBe(TRANSPORT_ROWS.length);
    expect(num(campaign, 'typedRefusals')).toBeGreaterThan(0);
    // T4: no two distinct preimages ever share a request hash.
    expect(num(campaign, 'digestCollisions')).toBe(0);
    expect(num(campaign, 'distinctDigests')).toBeGreaterThan(0);
    // T5: no accepted request carries a claim the host binding contradicts.
    expect(num(campaign, 'bindingViolations')).toBe(0);
    // The full pipeline runs: wire → binding → reducer.
    expect(num(campaign, 'acceptedWire')).toBeGreaterThan(0);
    expect(num(campaign, 'rejectedWire')).toBeGreaterThan(0);
    expect(num(campaign, 'mappedEvents')).toBeGreaterThan(0);
    expect(num(campaign, 'bindingRefusals')).toBeGreaterThan(0);
    expect(num(campaign, 'reducerAccepted')).toBeGreaterThan(0);
    expect(num(campaign, 'reducerRefused')).toBeGreaterThan(0);
    expect(num(campaign, 'roundTrips')).toBeGreaterThan(0);
    // T7: the TextEncoder surrogate hazard is demonstrated, not assumed.
    expect(num(campaign, 'surrogateHazards')).toBeGreaterThan(0);
  });
});

describe('scale campaign: restored-snapshot ledger barriers', () => {
  it('accepts every reducer-reachable state and matches the independent oracle on every forged one', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['ledgerBarrier'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    // B1: no false refusal — a restorable snapshot must never be bricked.
    expect(num(campaign, 'reachableRefused')).toBe(0);
    expect(num(campaign, 'reachableAccepted')).toBe(num(campaign, 'reachableBarrierRuns'));
    // B2: the barriers agree with the independent oracle on every run.
    expect(num(campaign, 'barrierDisagreements')).toBe(0);
    expect(num(campaign, 'barrierAgreements')).toBe(num(campaign, 'forgedBarrierRuns'));
    // Both outcomes are actually exercised, and the whole grid gets visited.
    expect(num(campaign, 'forgedAccepted')).toBeGreaterThan(0);
    expect(num(campaign, 'forgedRefused')).toBeGreaterThan(0);
    expect(num(campaign, 'oracleIllegalRuns')).toBeGreaterThan(0);
    expect(num(campaign, 'untypedRefusals')).toBe(0);
    expect(num(campaign, 'cellsVisited')).toBe(SIZES.barrierStates.fast);
    expect(num(campaign, 'gridCells')).toBe(GRID_CELLS.length);
    // Every phase of the machine is in the stock, terminal ones included.
    expect(num(campaign, 'stockPhases')).toBe(11);
    // The mass-vote barrier is exercised too (it is ladder-only).
    expect(num(campaign, 'barrier_massVoteLedger')).toBeGreaterThan(0);
  });
});

describe('scale campaign: per-round bond consumption', () => {
  it('binds one hash to one index, never re-consumes a witness, and matches the 3^R schedule', { timeout: 300_000 }, () => {
    const result = runCampaign({ profile: PROFILE, seed: SEED, only: ['bondAlgebra'] });
    const campaign = result.results[0]!;
    expectGreen(campaign);
    expect(num(campaign, 'rawErrors')).toBe(0);
    // A1/A2/A3: every illegal press is a typed refusal, and both halves run.
    expect(num(campaign, 'illegalProbes')).toBeGreaterThan(0);
    expect(num(campaign, 'typedRefusals')).toBe(num(campaign, 'illegalProbes'));
    expect(num(campaign, 'legalEscalations')).toBeGreaterThan(0);
    expect(num(campaign, 'collisionProbes')).toBe(SIZES.bondSequences.fast);
    expect(num(campaign, 'reuseProbes')).toBeGreaterThan(0);
    expect(num(campaign, 'membershipBondProbes')).toBeGreaterThan(0);
    expect(num(campaign, 'roundRewindProbes')).toBeGreaterThan(0);
    expect(num(campaign, 'hostPolicyProbes')).toBeGreaterThan(0);
    // A4/A5: the schedule is checked against the geometric series.
    expect(num(campaign, 'scheduleChecks')).toBeGreaterThan(0);
    expect(num(campaign, 'consumptionChecks')).toBeGreaterThan(0);
    // Every target round 1..5 is exercised, so the deepest rung is really run.
    expect(num(campaign, 'distinctRounds')).toBe(5);
    expect(num(campaign, 'maxRoundsReached')).toBe(5);
  });
});
