// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Deterministic async drains. Read `docs/TEST_DETERMINISM.md` rule 2.
 *
 * A test must never synchronise on elapsed time. `await new Promise(r =>
 * setTimeout(r, 0))` looks like "wait a tick" but is a wall-clock bet: the
 * macrotask queue is only reached after the event loop is free, so on a loaded
 * box (or under a busy timer phase) it can run before — or long after — the
 * work it was meant to let finish. The tell is that the assertion afterwards
 * passes for the wrong reason: it observes a partially-drained chain, so a
 * regression that WOULD double-emit is never seen. That is the vacuity class.
 *
 * The replacement is bounded by ITERATION COUNT, not milliseconds: pump the
 * microtask queue a fixed number of turns. The chain under test is a fixed
 * number of `await`s, so a fixed number of turns is sufficient by construction,
 * and a chain that grows unexpectedly fails loudly instead of waiting forever.
 */

/**
 * Drain `maxTurns` microtask turns.
 *
 * Use when the code under test awaits only promises (the common case in this
 * repo — the Court modules are timer-free by design). If a chain needs a real
 * macrotask, that is a production signal: report it rather than sleeping here.
 */
export async function drainJobs(maxTurns = 64): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) await Promise.resolve();
}

/**
 * Drain microtasks until `predicate()` holds, bounded by ITERATION COUNT.
 *
 * This is the deterministic shape of `waitFor`: it advances the chain a turn at
 * a time and stops as soon as the condition is satisfied, so the result does
 * not depend on how fast the host is. It still fails fast — after `maxTurns`
 * turns the predicate is asserted (not slept on), so a genuine absence of the
 * effect is reported as a normal assertion failure with the real state.
 */
export async function drainUntil(
  predicate: () => boolean,
  maxTurns = 64,
  label = 'condition',
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error(`drainUntil: ${label} still false after ${maxTurns} microtask turns`);
  }
}
