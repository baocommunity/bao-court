// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * SCALE CAMPAIGN — shared scaffolding for the large-corpus campaigns
 * (`docs/benchmarks/SCALE_CAMPAIGN.md`).
 *
 * Every campaign module in this directory:
 *
 *   1. is DETERMINISTIC in `(seed, size)` — all randomness comes from the
 *      house mulberry32 streams (`__tests__/helpers/rng.ts`), no clock, no
 *      CSPRNG, no I/O;
 *   2. RECORDS failures instead of throwing — a `CampaignResult` is data, so
 *      the same module can run under vitest (fast subset, CI) and under the
 *      standalone runner (`scripts/campaign/run-campaign.mjs --full`);
 *   3. reports its ACTUAL corpus size (the unit varies per campaign:
 *      sequences, tallies, batches, events, draws, encodings) so the committed
 *      artifact can never claim a size it did not run.
 *
 * The split is deliberate: CI (`npm test`) runs the FAST subset of every
 * campaign through `__tests__/scale/scale.*.test.ts`; the FULL corpus is the
 * standalone runner, whose JSON artifact is committed under
 * `docs/benchmarks/campaign-<date>.json`.
 */

/** Campaign profile: `fast` (CI-bounded) or `full` (the round's artifact). */
export type ProfileName = 'fast' | 'full';

/** Corpus size per profile, per campaign. */
export interface SizeSplit {
  readonly fast: number;
  readonly full: number;
}

/**
 * THE corpus table. Every campaign's unit is documented in its module JSDoc;
 * the numbers here are the round's declared sizes and the artifact records
 * what actually ran.
 */
export const SIZES = {
  /** campaign 1 — legal confirmation-machine event sequences. */
  confirmationSequences: { fast: 250, full: 10_000 },
  /** campaign 2 — plurality tallies finalized through the vote machine. */
  tallies: { fast: 15_000, full: 1_000_000 },
  /** campaign 3 — Merkle batches (n = 1..2048 leaves). */
  merkleBatches: { fast: 40, full: 1_000 },
  /** campaign 4 — signed v2 attestation events (valid + tampered). */
  attestationEvents: { fast: 250, full: 50_000 },
  /** campaign 5 — jury selection draws (rosters 3..500, both weight modes). */
  selectionDraws: { fast: 200, full: 10_000 },
  /** campaign 6 — canonical encodings. */
  encodings: { fast: 2_000, full: 100_000 },
  /** campaign 5 — single-juror clock draws feeding the chi-square check. */
  chiSquareDraws: { fast: 20_000, full: 100_000 },
} as const satisfies Record<string, SizeSplit>;

/** Resolve a campaign's corpus size for a profile. */
export function sizeFor(split: SizeSplit, profile: ProfileName): number {
  return profile === 'fast' ? split.fast : split.full;
}

/** Maximum number of recorded failures per campaign (the count is always exact). */
export const MAX_RECORDED_FAILURES = 25;

/** One recorded campaign failure (a violated invariant, never an exception). */
export interface CampaignFailure {
  /** Campaign name (e.g. `confirmation`). */
  readonly corpus: string;
  /** The smallest reproducing case label (sequence seed, tally index, batch id…). */
  readonly case: string;
  /** What was expected and what happened. */
  readonly message: string;
}

/** Metric values are numbers or numeric arrays (e.g. per-sequence wall times). */
export type MetricValue = number | readonly number[];

/** The result of one campaign run — the unit of both the test assertions and the artifact. */
export interface CampaignResult {
  readonly name: string;
  /** Unit of `corpus` (e.g. `sequences`, `tallies`). */
  readonly units: string;
  /** ACTUAL corpus size executed. */
  readonly corpus: number;
  /** Number of individual assertions executed. */
  readonly checks: number;
  /** Total failed assertions (>= failures.length — details are capped). */
  readonly failedChecks: number;
  /** First {@link MAX_RECORDED_FAILURES} failures, in execution order. */
  readonly failures: readonly CampaignFailure[];
  readonly seed: number;
  readonly wallMs: number;
  readonly metrics: Readonly<Record<string, MetricValue>>;
  readonly notes: readonly string[];
}

/**
 * Failure recorder shared by every campaign: counts every failed check, keeps
 * the first {@link MAX_RECORDED_FAILURES} with their reproducing case label,
 * and never throws — the runner decides the exit code, the tests decide the
 * assertion message.
 */
export class CampaignReporter {
  private readonly failureList: CampaignFailure[] = [];
  private checksRun = 0;
  private failed = 0;

  constructor(
    readonly name: string,
    readonly units: string,
    readonly corpus: number,
    readonly seed: number,
  ) {}

  /** Count one executed assertion. */
  check(): void {
    this.checksRun += 1;
  }

  /** Record one failed assertion with its reproducing case label. */
  fail(caseLabel: string, message: string): void {
    this.checksRun += 1;
    this.failed += 1;
    if (this.failureList.length < MAX_RECORDED_FAILURES) {
      this.failureList.push({ corpus: this.name, case: caseLabel, message });
    }
  }

  /** Assert `actual === expected` (returns the comparison result). */
  equals(caseLabel: string, actual: unknown, expected: unknown, what: string): boolean {
    this.checksRun += 1;
    if (Object.is(actual, expected)) return true;
    this.failed += 1;
    if (this.failureList.length < MAX_RECORDED_FAILURES) {
      this.failureList.push({
        corpus: this.name,
        case: caseLabel,
        message: `${what}: expected ${format(expected)}, got ${format(actual)}`,
      });
    }
    return false;
  }

  /** Assert a boolean condition. */
  ok(caseLabel: string, condition: boolean, message: string): boolean {
    this.checksRun += 1;
    if (condition) return true;
    this.failed += 1;
    if (this.failureList.length < MAX_RECORDED_FAILURES) {
      this.failureList.push({ corpus: this.name, case: caseLabel, message });
    }
    return false;
  }

  /** Assert two string arrays are equal element-wise. */
  equalStrings(caseLabel: string, actual: readonly string[], expected: readonly string[], what: string): boolean {
    this.checksRun += 1;
    let same = actual.length === expected.length;
    if (same) {
      for (let i = 0; i < actual.length; i += 1) {
        if (actual[i] !== expected[i]) {
          same = false;
          break;
        }
      }
    }
    if (same) return true;
    this.failed += 1;
    if (this.failureList.length < MAX_RECORDED_FAILURES) {
      this.failureList.push({
        corpus: this.name,
        case: caseLabel,
        message: `${what}: expected [${expected.slice(0, 6).join(', ')}${expected.length > 6 ? '…' : ''}] (${expected.length}), got [${actual.slice(0, 6).join(', ')}${actual.length > 6 ? '…' : ''}] (${actual.length})`,
      });
    }
    return false;
  }

  get failedChecks(): number {
    return this.failed;
  }

  get checks(): number {
    return this.checksRun;
  }

  /** Freeze the run into a {@link CampaignResult}. */
  finish(wallMs: number, metrics: Record<string, MetricValue> = {}, notes: readonly string[] = []): CampaignResult {
    return {
      name: this.name,
      units: this.units,
      corpus: this.corpus,
      checks: this.checksRun,
      failedChecks: this.failed,
      failures: this.failureList,
      seed: this.seed,
      wallMs,
      metrics,
      notes,
    };
  }
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}…` : value);
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Nearest-rank percentile of an unsorted numeric sample (`p` in 0..100). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

/** Timing summary for a per-unit sample (median/p95/max/total, 3 decimals). */
export function timingMetrics(samples: readonly number[]): Record<string, number> {
  const total = samples.reduce((sum, value) => sum + value, 0);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    totalMs: round(total),
    medianMs: round(percentile(samples, 50)),
    p95Ms: round(percentile(samples, 95)),
    maxMs: round(samples.length === 0 ? 0 : Math.max(...samples)),
    meanMs: round(samples.length === 0 ? 0 : total / samples.length),
  };
}

/**
 * Depth-first freeze audit: returns the path of the first non-frozen object,
 * or `null` when the whole reachable graph is frozen. Local to the campaign so
 * the corpus modules never depend on vitest (`helpers/asserts.ts` uses
 * `expect`).
 */
export function firstUnfrozen(value: unknown, path = 'state', depth = 0): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (!Object.isFrozen(value)) return path;
  if (depth > 6) return null;
  for (const [key, child] of Object.entries(value as object)) {
    const found = firstUnfrozen(child, `${path}.${key}`, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Monotonic wall clock for the campaign runner (perf hooks, never `Date.now`). */
export function nowMs(): number {
  return performance.now();
}
