// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Determinism policy for the Court suite. Read `docs/TEST_DETERMINISM.md`.
 *
 * This file exists because its ABSENCE was the bug: with no config, vitest
 * applied its 5000 ms default to 1473 of 1523 tests. FROST DKG rounds and
 * signature validation are CPU-bound, so under suite/agent concurrency that
 * default aborted healthy tests — 19 `timed out in 5000ms` failures on a
 * docs-only tree, every failing file green in isolation.
 *
 * Every number below is DERIVED from `__tests__/helpers/budget.ts` (one policy
 * point) and is env-overridable, so a loaded box raises a ceiling without
 * editing a test:
 *
 *   BAO_TEST_TIMEOUT_MS     per-test timeout        (default 60 000)
 *   BAO_HOOK_TIMEOUT_MS     beforeAll/afterAll      (default 60 000)
 *   BAO_TEARDOWN_TIMEOUT_MS afterAll cleanup        (default 30 000)
 *   BAO_TEST_FILE_PARALLELISM=0  run one file at a time (bisecting a race)
 *
 * `retry: 0` is deliberate and must stay: a retry converts a real race into a
 * green tick. The suite is either deterministic or it is not — see the rules.
 */
import { defineConfig } from 'vitest/config';

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  budgetMs,
} from './__tests__/helpers/budget.ts';

export default defineConfig({
  test: {
    // --- derived ceilings (never literals) -------------------------------
    testTimeout: budgetMs('BAO_TEST_TIMEOUT_MS', DEFAULT_TEST_TIMEOUT_MS),
    hookTimeout: budgetMs('BAO_HOOK_TIMEOUT_MS', DEFAULT_HOOK_TIMEOUT_MS),
    teardownTimeout: budgetMs('BAO_TEARDOWN_TIMEOUT_MS', DEFAULT_TEARDOWN_TIMEOUT_MS),

    // --- determinism: no retries, no shuffled order ----------------------
    retry: 0,
    sequence: {
      shuffle: false,
      // Hooks run in declaration order; concurrent hooks are unordered by
      // construction and make failure output non-reproducible.
      concurrent: false,
    },

    // One process per file, no shared module state bleeding between files.
    // `forks` (not `threads`) keeps timers and GC independent of the parent.
    pool: 'forks',
    isolate: true,
    fileParallelism: process.env.BAO_TEST_FILE_PARALLELISM !== '0',

    // The watchdog probe is a deliberate hang; it is executed only by the
    // proof in determinismGuard.test.ts, never by the suite itself.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/__tests__/determinism/watchdogProbe.test.ts',
    ],
  },
});
