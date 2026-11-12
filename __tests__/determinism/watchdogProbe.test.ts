// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Deliberate-hang probe for `determinismGuard.test.ts`. NEVER run by the
 * suite — it is excluded in `vitest.config.ts` and executed only by the
 * watchdog-liveness proof, in its own vitest process with a tiny timeout.
 *
 * Measured behaviour on vitest 4.1.12 (and asserted by the guard):
 *
 * `WATCHDOG_PROBE=async`  — a promise that never settles. The timeout is
 *                           asynchronous, so vitest aborts at ~200 ms: the
 *                           watchdog is LIVE, not decorative. The completion
 *                           marker is never written, because the body never
 *                           finishes — yet the process terminates. That, not a
 *                           stopwatch, is the proof.
 * `WATCHDOG_PROBE=sync`   — a bounded synchronous busy loop (~1.2 s). vitest
 *                           cannot interrupt a blocked event loop: the loop
 *                           runs to completion (the marker IS written) and the
 *                           timeout is then reported RETROACTIVELY. Residual:
 *                           an INFINITE synchronous loop hangs the run, because
 *                           no in-process watchdog can preempt it — only a
 *                           process-level bound (the loaded-run harness's
 *                           `timeout`) can.
 */
import { writeFileSync } from 'node:fs';

import { it } from 'vitest';

const PROBE = process.env.WATCHDOG_PROBE ?? 'async';
const SYNC_BUSY_MS = 1200;

it('probe: hang in the requested mode', async () => {
  if (PROBE === 'sync') {
    // Bounded on purpose: it must outlive the probe's 200 ms timeout by a wide
    // margin while still terminating, so the proof itself is finite.
    const started = Date.now();
    while (Date.now() - started < SYNC_BUSY_MS) {
      // burn the event loop — no awaits, no timers, nothing to interrupt
    }
    // Reached ONLY if vitest failed to preempt the loop. The guard asserts this
    // file exists; a stopwatch reading would have measured the host instead.
    if (process.env.WATCHDOG_MARKER) {
      writeFileSync(process.env.WATCHDOG_MARKER, String(Date.now() - started));
    }
    return;
  }
  await new Promise<void>(() => {
    // never settles — the marker is never written
  });
});
