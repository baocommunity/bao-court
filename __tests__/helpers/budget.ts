// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE single source of truth for every wall-clock number in the suite:
 * assertion budgets, vitest timeouts, and hook timeouts all derive from here.
 *
 * Read `docs/TEST_DETERMINISM.md` before changing a value. The rules, in order
 * of precedence:
 *
 *   1. **Never assert elapsed time as behaviour.** Assert the deterministic
 *      work instead (step count, iteration count, state transition, outcome).
 *      A duration assertion measures the box, not the code.
 *   2. **A watchdog, where one must exist, is DERIVED and provable.** It comes
 *      from `budgetMs()`, which is env-overridable, so a loaded box raises the
 *      ceiling without editing a test. Its liveness is proven by
 *      `__tests__/determinismGuard.test.ts` (a starved run must actually fire).
 *   3. **A per-test timeout is derived, never a literal.** `testTimeoutFor()`
 *      is the only sanctioned way to write one, and it always keeps the
 *      ordering `assertionBudget < testTimeout` so a clean assertion fires
 *      before vitest's abort (the r29-11 rule).
 *   4. **Never lower a default to make a suite feel fast.** A tight performance
 *      gate corrupts mutation verdicts and CI alike (M40/M47, #85).
 *
 * History: the suite had NO vitest config, so 1473 of 1523 tests ran at
 * vitest's 5000 ms default. Under suite/agent concurrency that produced 19
 * `timed out in 5000ms` failures with zero code change — every failing file
 * green in isolation. Two false mutation "captures" (M40/M47) came from the
 * same class. Raising one budget at a time (5 s → 30 s → a hand-written
 * `--testTimeout=60000`) hid the class without removing it; this module removes
 * it by deriving every ceiling from one policy point.
 */

/** Default assertion ceiling for CPU-heavy end-to-end work (30 s). */
export const DEFAULT_BUDGET_MS = 30_000;

/**
 * Default per-test timeout when a test declares none (60 s).
 *
 * Derived, not guessed: the heaviest CPU-bound test measured ~2.0 s on an idle
 * reference box; the same test measured 22.1 s while the host was at load 60
 * (19 foreign workers). 60 s is ~30× the idle baseline and ~2.7× the worst
 * observed loaded run, so a genuine regression still fails while scheduling
 * noise does not. Override with `BAO_TEST_TIMEOUT_MS=180000` — no test edit.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/** Default hook timeout (`beforeAll`/`afterAll`) — same derivation as above. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** Default teardown timeout — bounded, because a leaked handle must not hang CI. */
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

/**
 * Read a positive millisecond budget from `envName`, falling back to
 * `defaultMs` when the variable is absent or not a positive finite number.
 */
export function budgetMs(envName: string, defaultMs = DEFAULT_BUDGET_MS): number {
  const raw = process.env[envName];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

/**
 * Derive a vitest per-test timeout from an assertion budget.
 *
 * The multiplier and the floor together guarantee the r29-11 ordering
 * property — the assertion always gets to fire before vitest aborts the test —
 * for every budget, including an operator override:
 *
 *     testTimeoutFor(b) > b        for all b > 0
 *
 * `simulateCourt.test.ts` proved this for one file; `determinismGuard.test.ts`
 * proves it for the helper, and the structural guard rejects any test that
 * writes a literal timeout instead of calling this.
 */
export function testTimeoutFor(budget: number, floorMs = 10_000): number {
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new RangeError(`testTimeoutFor: budget must be a positive finite number, got ${budget}`);
  }
  return Math.max(Math.round(budget * 2), floorMs);
}

/** `testTimeoutFor` over an env-overridable budget, in one call. */
export function derivedTimeout(envName: string, defaultMs = DEFAULT_BUDGET_MS): number {
  return testTimeoutFor(budgetMs(envName, defaultMs));
}

/**
 * The three work TIERS. A test declares which tier it belongs to and inherits
 * both the assertion budget and the vitest timeout from one env-overridable
 * number, so raising one on a slow box can never desynchronise them.
 *
 * Anything not in a tier inherits the global derived default (60 s) and must
 * NOT declare a per-test timeout — see `determinismGuard.test.ts` R1.
 */

/** CPU-bound crypto corpora (DKG rounds, FROST signing, property sweeps) → 120 s timeout. */
export function heavyTimeout(): number {
  return derivedTimeout('BAO_HEAVY_BUDGET_MS', 60_000);
}

/** Real multi-process ceremonies (subprocess spawn + IPC) → 180 s timeout. */
export function processTimeout(): number {
  return derivedTimeout('BAO_PROCESS_BUDGET_MS', 90_000);
}

/** Scale campaigns (hundreds of thousands of generated cases) → 300 s timeout. */
export function scaleTimeout(): number {
  return derivedTimeout('BAO_SCALE_BUDGET_MS', 150_000);
}

/**
 * Bound for a CHILD process launched by a test, derived from that test's own
 * timeout and kept just under it (90 %).
 *
 * The ordering matters as much as it does for assertions: if the child's bound
 * equals or exceeds the test's, vitest aborts the test and the failure message
 * names a timeout instead of the child's own report. Staying just under leaves
 * the child room to fail with its real reason, while the absolute value barely
 * moves.
 */
export function childTimeoutFor(testTimeout: number, share = 0.9): number {
  if (!Number.isFinite(testTimeout) || testTimeout <= 0) {
    throw new RangeError(`childTimeoutFor: testTimeout must be positive, got ${testTimeout}`);
  }
  return Math.round(testTimeout * share);
}
