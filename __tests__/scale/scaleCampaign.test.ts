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

import { SIZES, type CampaignResult, type MetricValue } from './corpus';
import { CAMPAIGNS, CORPUS_NAMES, declaredSizes, runCampaign } from './index';

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
    expect(declaredSizes('fast')).toEqual({
      confirmation: 250, tally: 15_000, merkle: 40, validator: 250, selection: 200, encoding: 2_000,
    });
    expect(Object.keys(CAMPAIGNS).sort()).toEqual([...CORPUS_NAMES].sort());
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
