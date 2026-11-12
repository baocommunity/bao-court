// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE watchdog kit — the suite's only wall-clock knob.
 *
 * ─── What a watchdog is, and what it is NOT ───────────────────────────────
 *
 * A watchdog catches a *hang*. It is not an assertion about behaviour and it
 * is never evidence that the code is fast: nothing in this suite may assert
 * that work completed within a duration. Behaviour is asserted on state
 * transitions, counts and sequences (see `docs/TEST_DETERMINISM.md`).
 *
 * ─── Why a constant is not allowed ────────────────────────────────────────
 *
 * Four rounds of evidence say an absolute ceiling measures the box, not the
 * code: the old 5 s `simulateCourt` gate produced two FALSE mutation
 * "captures" and was reproduced by an external reviewer (docs-only tree → 12
 * red); round-10's run under heavy parallel load had 15 timing flakes, green
 * on a clean re-run; the soak rounds found load-dependent behaviour twice.
 * Each time the answer was to raise the number — which hides the class.
 *
 * The construction here is a RATIO, measured in the process that is about to
 * run the tests:
 *
 *   1. `bestMsPerUnit()` — the fastest of several short CPU bursts. A short
 *      burst is the closest thing to an uncontended cycle cost available: it
 *      usually completes inside one scheduler quantum, so the MINIMUM is a
 *      good estimate of "how fast is one unit of this workload on this CPU".
 *   2. `loadFactor()` — wall time of a LONG fixed burst (long enough to be
 *      preempted repeatedly) divided by `units × bestMsPerUnit`. When the box
 *      is oversubscribed the process loses cycles to other runnable work and
 *      this ratio rises; when it is idle it is ≈1.
 *   3. `watchdogMs(base)` — `clamp(base × loadFactor, base, base × 4)`.
 *
 * So the watchdog keeps the SAME relative margin on a busy box and on an idle
 * one: load no longer changes any test's verdict, and a real algorithmic
 * regression still exceeds the bound because it inflates the numerator of the
 * very same ratio (code cost), not the denominator (box speed).
 *
 * ─── Overrides ────────────────────────────────────────────────────────────
 *
 * Every watchdog reads ONE environment variable, `BAO_TEST_WATCHDOG_MS`, which
 * REPLACES the derived value (it is a ceiling, so an operator who knows their
 * box sets it directly). Absent/invalid ⇒ the derived value is used.
 *
 * ─── The gate is proven live ──────────────────────────────────────────────
 *
 * `__tests__/determinism.test.ts` asserts that `watchdogMs` scales with the
 * measured factor, honours the override, clamps — and that a deliberately
 * starved run actually trips `WatchdogExceededError`. A watchdog nobody has
 * seen fire is indistinguishable from a deleted one.
 */

/** Units of pure-JS work per calibration burst (~1.5 ms on the reference box). */
const UNITS_PER_BURST = 1_000_000;

/** Bursts used for the uncontended-rate estimate (the minimum wins). */
const SHORT_SAMPLES = 9;

/** Long samples used for the loaded-rate estimate (the maximum wins). */
const LONG_SAMPLES = 6;

/**
 * Target wall-clock for one long burst. The burst is sized in UNITS from the
 * measured per-unit cost, so the calibration costs a bounded ~40 ms per sample
 * on ANY box (a fixed unit count cost 15 s of worker startup on the loaded
 * reference box — measured, not guessed).
 */
const LONG_TARGET_MS = 25;

/**
 * Upper bound on the load factor.
 *
 * Measured on the 16-core reference box with 20 hog processes plus a mutation
 * sweep (load average 45–68): a 1.2 s test ran 18× slower, the 54 s model-check
 * instance 8× slower. The clamp has to clear that whole range or the flake
 * comes straight back, so 8 — not 4.
 */
export const MAX_LOAD_FACTOR = 8;

/**
 * Absolute ceiling on any derived watchdog (30 min). A hang still terminates;
 * CI's `timeout-minutes: 15` is the outer gate and trips first.
 */
export const MAX_WATCHDOG_MS = 30 * 60_000;

/**
 * Default suite watchdog when a test declares nothing.
 *
 * Vitest's own default is 5 s, which was never a measurement, and neither is a
 * "generous" 30 s: the number must come from the worst case this suite has
 * actually been seen to produce. Measured on the reference box: the slowest
 * test that relies on the default (`simulateCourt` pool 20 / jury 7, and the
 * appeal-watcher full-path runs) takes ≈2.4 s clean and up to **20×** that
 * under a 40+ load average — i.e. ≈48 s. 60 s clears that with margin, and the
 * load factor multiplies it further on a busy box.
 *
 * This is a HANG gate, not a performance gate: at 60 s it has no detection
 * value for a slow test, and that is the point — performance is measured by
 * `scripts/bench-vs-baseline.mjs`. A test that needs a tighter ceiling owns an
 * explicit `wd(measuredCost × margin)`.
 */
export const DEFAULT_WATCHDOG_MS = 60_000;

/** The override that replaces every derived ceiling. */
export const WATCHDOG_ENV = 'BAO_TEST_WATCHDOG_MS';

/**
 * One calibration burst: a fixed amount of pure integer/float work with no
 * allocation, no I/O and no crypto, so it measures CPU availability only.
 * Returns its accumulator so a dead-code eliminator cannot delete the loop.
 */
function burst(units: number): number {
  let acc = 0x811c9dc5;
  for (let i = 0; i < units; i += 1) {
    acc = (Math.imul(acc ^ i, 0x01000193) ^ (acc >>> 13)) >>> 0;
  }
  return acc;
}

/** Wall-clock milliseconds for `fn`. Local to this module on purpose. */
function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

let cachedBest: number | null = null;
let cachedFactor: number | null = null;

/** Fastest observed ms for ONE calibration unit (the uncontended estimate). */
export function bestMsPerUnit(): number {
  if (cachedBest !== null) return cachedBest;
  // Warm the JIT first: an unwarmed burst is 5–20× slower and would make the
  // estimate meaningless.
  burst(UNITS_PER_BURST);
  burst(UNITS_PER_BURST);
  burst(UNITS_PER_BURST);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SHORT_SAMPLES; i += 1) {
    const ms = timeMs(() => void burst(UNITS_PER_BURST));
    if (ms < best) best = ms;
  }
  cachedBest = best / UNITS_PER_BURST;
  return cachedBest;
}

/**
 * How much slower this process currently runs than its own uncontended rate.
 * `1` on an idle box; `> 1` when other runnable work steals cycles.
 */
export function loadFactor(): number {
  if (cachedFactor !== null) return cachedFactor;
  const unit = bestMsPerUnit();
  // Six ~25 ms samples; the WORST one wins — preemption is bursty (measured
  // ratios on a 20-hog box: 1.2, 1.5, 2.4, 3.0, 4.8, 7.0 across samples), and a
  // median would keep reporting "idle" for the duration of a scheduling gap.
  // Overestimating the factor only widens a hang gate; underestimating it
  // brings the flake back, so the asymmetry is deliberate.
  const units = Math.max(1, Math.round(LONG_TARGET_MS / unit));
  let worst = 1;
  for (let i = 0; i < LONG_SAMPLES; i += 1) {
    const ms = timeMs(() => void burst(units));
    const ratio = ms / (units * unit);
    if (ratio > worst) worst = ratio;
  }
  cachedFactor = Math.min(Math.max(worst, 1), MAX_LOAD_FACTOR);
  return cachedFactor;
}

/** Parse a positive finite integer from an env value, else `null`. */
function envMs(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * The ceiling for a watchdog that would otherwise be `baseMs`: load-scaled,
 * clamped, and replaceable by `BAO_TEST_WATCHDOG_MS`.
 *
 * `baseMs` is still required — it is the *relative* margin the author chose
 * (e.g. "20× the measured cost of this sweep"), and it is what the ratio
 * multiplies. Pick it from a measured cost, never from a feeling.
 */
export function watchdogMs(baseMs: number = DEFAULT_WATCHDOG_MS): number {
  const override = envMs(WATCHDOG_ENV);
  if (override !== null) return override;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_WATCHDOG_MS;
  return Math.min(Math.floor(base * loadFactor()), Math.max(MAX_WATCHDOG_MS, base));
}

/** Shorthand for a vitest per-test / per-hook timeout. */
export const wd = watchdogMs;

/**
 * The vitest-level default, used by `determinism.setup.ts`. Always strictly
 * greater than the in-test ceiling so a *declared* watchdog fires first (a
 * timeout error says nothing about which assertion was slow).
 */
export function suiteTestTimeoutMs(baseMs: number = DEFAULT_WATCHDOG_MS): number {
  // One millisecond above the declared ceiling, never a floor of its own: an
  // operator who sets `BAO_TEST_WATCHDOG_MS=150` to watch the gate fire must get
  // 151 ms, not `max(151, base + 1)`.
  return watchdogMs(baseMs) + 1;
}

/** Thrown when a `runUnderWatchdog` body overruns its budget. */
export class WatchdogExceededError extends Error {
  constructor(readonly budgetMs: number, readonly elapsedMs: number) {
    super(`watchdog fired: ${Math.round(elapsedMs)}ms >= ${budgetMs}ms budget`);
    this.name = 'WatchdogExceededError';
  }
}

/**
 * Run `fn` under an explicit watchdog, throwing {@link WatchdogExceededError}
 * when it overruns. Exposed so the kit's own tests can PROVE the gate fires on
 * a starved run; ordinary tests should rely on the vitest timeout.
 */
export function runUnderWatchdog<T>(budgetMs: number, fn: () => T): T {
  const t0 = performance.now();
  const result = fn();
  const elapsed = performance.now() - t0;
  if (elapsed >= budgetMs) throw new WatchdogExceededError(budgetMs, elapsed);
  return result;
}
