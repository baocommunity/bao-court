// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 5 — jury-selection sweep at scale.
 *
 * Draws juror sets with the production exponential-clock lottery
 * (`selectJury` / `selectJuryWithBackups`) over rosters of 3..500 jurors, in
 * BOTH weight modes:
 *
 *   - quadratic (stake) mode — `quadraticPriority(random, stakeSats)`, the
 *     default path where P(win) ∝ √stake;
 *   - `weightFn` (reputation) mode — `weightedPriority(random, weight)`, where
 *     P(win) ∝ weight / Σweight.
 *
 * Per draw the campaign asserts:
 *
 *   S1  the roster is exactly `jurySize` jurors with 1..k indices, no
 *       duplicate pubkeys, and every member drawn from the eligible pool;
 *   S2  priorities are ascending in the returned order (the draw contract);
 *   S3  DETERMINISM: the same (seed, roster, params) reproduces the identical
 *       roster — byte-for-byte on pubkeys, indices, and priorities;
 *   S4  `verifyJurySelection` (the production recompute used by consumers)
 *       returns true for the produced roster;
 *   S5  the INDEPENDENT ranking (`__tests__/reference/refLottery.ts`:
 *       node:crypto digest + DataView read + own comparator) selects the same
 *       top-k, so the ordering is re-derived rather than trusted;
 *   S6  weight proportionality: a chi-square over 10⁵ single-draw winners on a
 *       fixed 8-juror pool must be consistent with the w/Σw law (df = 7,
 *       critical value 24.322 at p = 0.001), with the empirical proportions
 *       also reported in the artifact.
 *
 * S3/S4/S5 run on a deterministic sample (every 50th draw) of the full-hash
 * work; S1/S2 run on every draw. All randomness is the house seeded stream.
 */

import {
  jurorRandomValue,
  selectJury,
  selectJuryWithBackups,
  verifyJurySelection,
  weightedPriority,
  deriveSelectionSeed,
} from '../../selection';
import type { JurorProfile, SelectedJuror } from '../../types';
import { refSelectJuryRanking } from '../reference/refLottery';
import { childRng, hex32, int } from '../helpers/rng';
import { CampaignReporter, nowMs, type CampaignResult } from './corpus';

const CATEGORY = 'world';
const REFERENCE_TIME_SEC = 1_800_000_000;
const REGISTERED_AT = 1_700_000_000;
const POOL_CAPACITY = 500;

/** One deterministic juror pool of {@link POOL_CAPACITY} members. */
interface Pool {
  readonly jurors: readonly SelectedJuror[];
  readonly pubkeys: readonly string[];
  readonly stakes: readonly number[];
  readonly weights: readonly number[];
}

/** Build the campaign's juror pools (two stake regimes → different clock shapes). */
function buildPools(seed: number): Pool[] {
  const r = childRng(seed, 'selection-pool');
  const regimes = ['uniform', 'skewed'] as const;
  return regimes.map((regime) => {
    const jurors: SelectedJuror[] = [];
    const pubkeys: string[] = [];
    const stakes: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < POOL_CAPACITY; i += 1) {
      // Reputation weight: small coprime-ish integers (never 0 — a 0 weight
      // would be an opt-out, and this campaign is about positive weights).
      const wotScore = 60 + (i % 40);
      const weight = 1 + (wotScore % 11);
      // Stake: uniform 1k..50k sat, or heavy-tailed 1k..5M sat.
      const stake = regime === 'uniform'
        ? 1_000 + Math.floor(r() * 49_000)
        : 1_000 + Math.floor(r() ** 3 * 5_000_000);
      jurors.push({
        idx: i + 1,
        nostrPubkey: hex32(r),
        stakeCapacitySats: stake,
        stakeCommitment: { amountSats: stake, bondAddress: 'bc1qscale', status: 'confirmed', committedAt: REGISTERED_AT },
        wotScore,
        categories: [CATEGORY],
        registeredAt: REGISTERED_AT,
        priority: 0,
      });
      pubkeys.push(jurors[i]!.nostrPubkey);
      stakes.push(stake);
      weights.push(weight);
    }
    return { jurors, pubkeys, stakes, weights };
  });
}

/** Public parameters of one draw (kept so the same call can be replayed). */
interface DrawParams {
  readonly disputeEventId: string;
  readonly blockHash: string;
  readonly jurySize: number;
  readonly backupCount: number;
  readonly mode: 'quadratic' | 'weight';
}

/** Build the `SelectionParams` for a draw (the weightFn is a pure function of the juror). */
function paramsFor(draw: DrawParams) {
  return {
    disputeEventId: draw.disputeEventId,
    blockHash: draw.blockHash,
    marketCategory: CATEGORY,
    marketVolumeSats: 10_000,
    jurySize: draw.jurySize,
    backupCount: draw.backupCount,
    minWotScore: 0,
    minAccountAgeDays: 30,
    minStakeSats: 0,
    zeroStakeAllowed: true,
    referenceTimeSec: REFERENCE_TIME_SEC,
    ...(draw.mode === 'weight'
      ? { weightFn: (juror: JurorProfile): number => 1 + (juror.wotScore % 11) }
      : {}),
  };
}

/**
 * The weight the REFERENCE ranking must use to reproduce each production mode:
 * quadratic mode clocks at `-ln(r)/sqrt(stake)` (so the reference weight is
 * `sqrt(stake)`), reputation mode clocks at `-ln(r)/weight`.
 */
function referenceWeights(pool: Pool, count: number, mode: 'quadratic' | 'weight'): number[] {
  return Array.from({ length: count }, (_, i) => (
    mode === 'quadratic' ? Math.sqrt(Math.max(1, pool.stakes[i]!)) : pool.weights[i]!
  ));
}

/**
 * Run the selection campaign.
 *
 * @param opts.size        number of draws
 * @param opts.seed        campaign seed
 * @param opts.chiSquareDraws single-winner trials for the proportionality check
 */
export function runSelectionCampaign(opts: {
  readonly size: number;
  readonly seed?: number;
  readonly chiSquareDraws?: number;
}): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const chiSquareDraws = opts.chiSquareDraws ?? 100_000;
  const started = nowMs();
  const reporter = new CampaignReporter('selection', 'draws', opts.size, seed);
  const r = childRng(seed, 'selection-draws');
  const pools = buildPools(seed);

  const metrics = {
    quadraticDraws: 0,
    weightDraws: 0,
    doubleDraws: 0,
    determinismChecks: 0,
    verifyChecks: 0,
    referenceRankingChecks: 0,
    maxRoster: 0,
    jurorsScored: 0,
    chiSquareDraws: 0,
    chiSquare: 0,
    chiSquareDf: 7,
    chiSquareCritical: 24.322,
    maxWeightDeviation: 0,
  };

  // Boundary roster sizes open every run so the extremes are never left to
  // the log-uniform draw's tail.
  const boundaries = [3, 4, 499, 500] as const;

  for (let index = 0; index < opts.size; index += 1) {
    const mode: 'quadratic' | 'weight' = index % 2 === 0 ? 'quadratic' : 'weight';
    const pool = pools[index % pools.length]!;
    const rosterSize = index < boundaries.length ? boundaries[index]! : Math.min(POOL_CAPACITY, Math.max(3, Math.round(3 * (POOL_CAPACITY / 3) ** r())));
    const jurors = pool.jurors.slice(0, rosterSize);
    const jurySize = int(r, 1, Math.min(rosterSize, 12));
    const backupCount = int(r, 0, 3);
    const draw: DrawParams = {
      disputeEventId: hex32(r),
      blockHash: hex32(r),
      jurySize,
      backupCount,
      mode,
    };
    const label = `draw#${index}(${mode},n=${rosterSize},k=${jurySize})`;

    let selected: SelectedJuror[];
    try {
      selected = index % 5 === 0
        ? selectJuryWithBackups(jurors, paramsFor(draw)).selected
        : selectJury(jurors, paramsFor(draw));
    } catch (err) {
      reporter.fail(label, `selection threw on a fully eligible pool: ${describe(err)}`);
      continue;
    }
    if (index % 5 === 0) metrics.doubleDraws += 1;
    if (mode === 'quadratic') metrics.quadraticDraws += 1;
    else metrics.weightDraws += 1;
    metrics.jurorsScored += rosterSize;
    metrics.maxRoster = Math.max(metrics.maxRoster, rosterSize);

    // S1 — roster shape and uniqueness.
    reporter.equals(label, selected.length, jurySize, 'S1: selected roster size');
    const seenPubkeys = new Set<string>();
    for (let position = 0; position < selected.length; position += 1) {
      const juror = selected[position]!;
      reporter.equals(label, juror.idx, position + 1, 'S1: selection indices must be 1..k in order');
      reporter.ok(label, !seenPubkeys.has(juror.nostrPubkey), `S1: duplicate pubkey ${juror.nostrPubkey.slice(0, 8)}… in one roster`);
      seenPubkeys.add(juror.nostrPubkey);
      reporter.ok(
        label,
        jurors.some((candidate) => candidate.nostrPubkey === juror.nostrPubkey),
        'S1: selected juror must come from the eligible pool',
      );
    }

    // S2 — priority order.
    for (let position = 1; position < selected.length; position += 1) {
      reporter.ok(
        label,
        selected[position - 1]!.priority <= selected[position]!.priority,
        'S2: priorities must be ascending in the returned order',
      );
    }

    // Sampled deep checks: determinism, production recompute, independent ranking.
    if (index % 50 !== 0) continue;
    const params = paramsFor(draw);

    // S3 — determinism: the same call reproduces the identical roster.
    const replay = selectJury(jurors, params);
    let identical = replay.length === selected.length;
    for (let position = 0; identical && position < replay.length; position += 1) {
      identical = replay[position]!.nostrPubkey === selected[position]!.nostrPubkey
        && replay[position]!.idx === selected[position]!.idx
        && Object.is(replay[position]!.priority, selected[position]!.priority);
    }
    reporter.ok(label, identical, 'S3: same seed/roster/params must reproduce the identical selection');
    metrics.determinismChecks += 1;

    // S4 — the consumer-side verification path.
    reporter.ok(label, verifyJurySelection(jurors, selected, params), 'S4: verifyJurySelection must accept the produced roster');
    metrics.verifyChecks += 1;

    // S5 — independent ranking (node:crypto digest + own comparator).
    const eligible = jurors;
    const ranking = refSelectJuryRanking(
      eligible.map((juror) => juror.nostrPubkey),
      referenceWeights(pool, rosterSize, mode),
      draw.disputeEventId,
      draw.blockHash,
    );
    reporter.equalStrings(
      label,
      selected.map((juror) => juror.nostrPubkey),
      ranking.slice(0, jurySize).map((entry) => entry.nostrPubkey),
      'S5: production top-k must equal the independent reference ranking',
    );
    metrics.referenceRankingChecks += 1;
  }

  // S6 — weight proportionality (chi-square) on single-draw winners.
  const chiWeights = [1, 2, 3, 5, 8, 13, 21, 34];
  const weightSum = chiWeights.reduce((sum, weight) => sum + weight, 0);
  const expected = chiWeights.map((weight) => weight / weightSum);
  const observed = new Array<number>(chiWeights.length).fill(0);
  const chiJurors = Array.from({ length: chiWeights.length }, (_, i) => 'c'.repeat(62) + `${i}`.padStart(2, '0'));
  for (let trial = 0; trial < chiSquareDraws; trial += 1) {
    // Cheap, unique (dispute, block) pair per trial — 64 hex chars each.
    const disputeEventId = trial.toString(16).padStart(64, '0');
    const blockHash = (trial + 0x10_0000).toString(16).padStart(64, '0');
    const seedBytes = deriveSelectionSeed(disputeEventId, blockHash);
    let bestIndex = 0;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (let juror = 0; juror < chiJurors.length; juror += 1) {
      const priority = weightedPriority(jurorRandomValue(seedBytes, chiJurors[juror]!), chiWeights[juror]!);
      if (priority < bestPriority) {
        bestPriority = priority;
        bestIndex = juror;
      }
    }
    observed[bestIndex] += 1;
  }
  metrics.chiSquareDraws = chiSquareDraws;
  let chiSquare = 0;
  let maxDeviation = 0;
  for (let juror = 0; juror < chiWeights.length; juror += 1) {
    const expectedCount = expected[juror]! * chiSquareDraws;
    chiSquare += (observed[juror]! - expectedCount) ** 2 / expectedCount;
    maxDeviation = Math.max(maxDeviation, Math.abs(observed[juror]! / chiSquareDraws - expected[juror]!) / expected[juror]!);
  }
  metrics.chiSquare = Math.round(chiSquare * 1000) / 1000;
  metrics.maxWeightDeviation = Math.round(maxDeviation * 10000) / 10000;
  reporter.ok(
    'chi-square',
    chiSquare < metrics.chiSquareCritical,
    `S6: winner frequencies must be proportional to the weights (chi²=${chiSquare.toFixed(2)} must be < ${metrics.chiSquareCritical} for df=7 at p=0.001)`,
  );

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      ...metrics,
      meanRoster: Math.round((metrics.jurorsScored / Math.max(1, opts.size)) * 100) / 100,
      drawsPerSecond: Math.round((opts.size / Math.max(1, wallMs)) * 1000),
    },
    [
      'roster sizes: log-uniform 3..500, with 3/4/499/500 forced first in every run',
      'deep checks (determinism, verifyJurySelection, independent ranking) on every 50th draw',
      `chi-square: ${chiSquareDraws} single-winner trials over an 8-juror weighted pool (df=7, p=0.001)`,
    ],
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
