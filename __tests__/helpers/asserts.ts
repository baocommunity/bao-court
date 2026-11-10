// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Assertion helpers for the Court test suite: typed-error discipline,
 * freeze discipline, and monotonic-clock ledger checks.
 *
 * House rule: a machine under hostile input must throw its OWN typed
 * transition error — never an untyped TypeError. And every state a machine
 * returns is deeply frozen (snapshot-friendly discipline). These helpers
 * make both disciplines one-liners so tests assert them everywhere instead
 * of just where someone remembered.
 */
import { expect } from 'vitest';
import type { CourtConfirmationMachineState } from '../../courtConfirmationMachine';

/** Expect `fn` to throw ONLY `ErrorCtor` (or not throw at all); never an untyped crash. */
export function expectTypedOrOk(fn: () => unknown, ErrorCtor: new (m: string) => Error): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ErrorCtor);
  }
}

/** Run `fn`, returning the thrown error, or undefined when it does not throw. */
export function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Recursively assert every object/array reachable from `value` is frozen. */
export function assertDeeplyFrozen(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), `${path} must be frozen`).toBe(true);
  for (const [key, child] of Object.entries(value as object)) assertDeeplyFrozen(child, `${path}.${key}`);
}

/**
 * Freeze discipline for a confirmation-machine state: the state itself and
 * every named ledger (and each record within) must be frozen — including the
 * multi-round ladder ledgers (outcomeHistory, ladder.votes, roundRoster).
 */
export function assertConfirmationStateFrozen(state: CourtConfirmationMachineState): void {
  expect(Object.isFrozen(state)).toBe(true);
  const ledgerKeys = [
    'confirmations', 'challenges', 'clawbackFlags', 'fees',
    'participantIndices', 'allowedOutcomes', 'evidenceIds',
  ] as const;
  for (const key of ledgerKeys) {
    const ledger = state[key];
    expect(Object.isFrozen(ledger)).toBe(true);
    for (const record of ledger) expect(Object.isFrozen(record)).toBe(true);
  }
  // Multi-round ladder ledgers (v0.9.0): outcome history and round rosters.
  if (state.outcomeHistory) {
    expect(Object.isFrozen(state.outcomeHistory)).toBe(true);
    for (const record of state.outcomeHistory) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.winnerEventIds)).toBe(true);
      expect(Object.isFrozen(record.winnerIndices)).toBe(true);
    }
  }
  if (state.ladder) {
    expect(Object.isFrozen(state.ladder)).toBe(true);
    expect(Object.isFrozen(state.ladder.votes)).toBe(true);
    for (const vote of state.ladder.votes) expect(Object.isFrozen(vote)).toBe(true);
    if (state.ladder.roundRoster) expect(Object.isFrozen(state.ladder.roundRoster)).toBe(true);
  }
  if (state.verdict) {
    expect(Object.isFrozen(state.verdict)).toBe(true);
    expect(Object.isFrozen(state.verdict.supportingEventIds)).toBe(true);
  }
  if (state.failure) expect(Object.isFrozen(state.failure)).toBe(true);
}

/**
 * Monotonic-clock ledger check (finding F-12): any machine state that keeps
 * a `latestTimestamp` ledger must never move it backwards across a
 * transition.
 */
export function assertClockMonotonic(
  before: { readonly latestTimestamp?: number },
  after: { readonly latestTimestamp?: number },
  label = 'state',
): void {
  const prev = before.latestTimestamp;
  const next = after.latestTimestamp;
  if (prev === undefined || next === undefined) return;
  expect(next, `${label}: latestTimestamp must be monotonically non-decreasing`).toBeGreaterThanOrEqual(prev);
}
