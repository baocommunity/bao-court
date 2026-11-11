// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Load-insensitive wall-clock budgets for the few tests that genuinely need a
 * time ceiling.
 *
 * History (docs/MUTATION_TESTING.md §3.1 and §7): an absolute 5 s gate on the
 * end-to-end simulation failed under suite/sweep load with no code change —
 * two red CI runs in #85 and two false mutation "captures" (M40/M47). A tight
 * absolute budget measures the box, not the code. The rule that replaced it:
 *
 *   1. assert the DETERMINISTIC work first (step count/order, outcome) — that
 *      is the behaviour under test and it cannot flake;
 *   2. keep only a GENEROUS ceiling, default 30 s (≈25× the measured
 *      baseline), so a real 100× regression still fails;
 *   3. let the environment raise the ceiling without editing a test:
 *      `SIM_BUDGET_MS=120000 npm test`.
 *
 * Never lower a default to make a suite feel fast: a flaky performance gate
 * corrupts mutation verdicts and CI alike.
 */

/** Default ceiling for CPU-heavy end-to-end work (25× the measured baseline). */
export const DEFAULT_BUDGET_MS = 30_000;

/**
 * Read a positive millisecond budget from `envName`, falling back to
 * `defaultMs` when the variable is absent or not a positive finite number.
 */
export function budgetMs(envName: string, defaultMs = DEFAULT_BUDGET_MS): number {
  const raw = process.env[envName];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}
