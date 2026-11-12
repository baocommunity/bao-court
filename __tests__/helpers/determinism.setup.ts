// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Per-worker determinism setup: calibrates the box ONCE per worker process and
 * installs the load-normalised watchdog as vitest's default timeout.
 *
 * Why a setup file and not `vitest.config.ts`: the config module is evaluated
 * in the main process BEFORE the worker pool starts, i.e. before the box is
 * under the very load the watchdog is meant to absorb. A setup file runs inside
 * each worker, alongside its siblings, so the calibration sample is taken in
 * the conditions the tests will actually run in.
 *
 * The cache in `watchdog.ts` is per module instance, and each worker is its own
 * process — so this costs one calibration per worker, not one per test file.
 *
 * Read `__tests__/helpers/watchdog.ts` before changing anything here, and
 * `docs/TEST_DETERMINISM.md` for the rules this enforces.
 */

import { vi } from 'vitest';

import { DEFAULT_WATCHDOG_MS, loadFactor, suiteTestTimeoutMs } from './watchdog';

const timeout = suiteTestTimeoutMs(DEFAULT_WATCHDOG_MS);

vi.setConfig({
  testTimeout: timeout,
  hookTimeout: timeout,
});

// Observable proof that this setup file ran and installed the watchdog. The
// determinism guard test asserts it — without the marker, a change that
// dropped `setupFiles` would silently restore vitest's absolute 5 s default and
// the guard would still pass.
(globalThis as { __baoWatchdogInstalled?: number }).__baoWatchdogInstalled = timeout;

// One line per worker in the vitest output: the evidence that the harness
// budget followed the box rather than a constant. Kept on stderr so a JSON
// reporter run (mutation sweeps, campaign artifacts) is unaffected.
if (process.env.BAO_TEST_WATCHDOG_TRACE === '1') {
  process.stderr.write(
    `[determinism] worker pid=${process.pid} loadFactor=${loadFactor().toFixed(2)} ` +
      `testTimeout=${timeout}ms\n`,
  );
}
