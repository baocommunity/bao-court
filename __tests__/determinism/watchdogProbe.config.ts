// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Minimal config for the watchdog-liveness proof ONLY. It exists so the proof
 * can run the deliberate-hang probe with a tiny timeout, independently of the
 * real suite's derived ceilings.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/determinism/watchdogProbe.test.ts'],
    testTimeout: 200,
    hookTimeout: 5_000,
    retry: 0,
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
  },
});
