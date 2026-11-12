// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Vitest configuration — deliberately tiny.
 *
 * The ONLY job here is to install the determinism setup file that replaces
 * vitest's absolute 5 s default timeout with a load-normalised watchdog
 * (`__tests__/helpers/watchdog.ts`). The per-worker calibration happens in
 * `__tests__/helpers/determinism.setup.ts`, not here: this module is evaluated
 * before the worker pool starts, i.e. before the load exists.
 *
 * `include` is pinned to the test directory so adding this file cannot silently
 * change WHICH files the suite runs (the default glob would also match any
 * `*.test.ts` that a future scratch file or vendored tree might carry).
 *
 * See `docs/TEST_DETERMINISM.md`.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['__tests__/helpers/determinism.setup.ts'],
    // Environment is per-file Node (the default); nothing here needs jsdom,
    // and adding it would make the whole suite slower for no benefit.
    environment: 'node',
  },
});
