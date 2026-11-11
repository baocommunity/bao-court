// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { runCourtSimulation } from '../scripts/simulateCourt';
import { budgetMs } from './helpers/budget';

describe('full court simulation (single script, hermetic)', () => {
  // DKG + FROST rounds are CPU-heavy; under a fully parallel suite run the
  // default 5s timeout is load-dependent (same class of flake as
  // docs/FIXES-2026-08-15.md #6). Give the sim an explicit budget.
  //
  // r29-11: the timeout must FOLLOW the budget, not be an independent absolute
  // gate. An operator who raises the ceiling with `SIM_BUDGET_MS=120000` would
  // otherwise get a 60 s vitest timeout — i.e. a timeout flake instead of a
  // clean assertion, the exact class the budget fix removed. 2× the budget plus
  // a floor keeps the ordering property (assertion < timeout) for every value.
  const SIM_BUDGET_MS = budgetMs('SIM_BUDGET_MS');
  const SIM_TIMEOUT = Math.max(SIM_BUDGET_MS * 2, 10_000);

  /**
   * Wall-clock budget for the end-to-end simulation.
   *
   * The old gate was an ABSOLUTE 5 s assertion. It failed under suite/sweep
   * load with no code change — twice red CI runs in #85 and two false mutation
   * "captures" (M40/M47) — and docs/MUTATION_TESTING.md §3.1/§7 concluded that
   * such a gate corrupts mutation results and CI alike. The replacement is:
   *
   *   - DETERMINISTIC first: the pipeline must produce exactly the eight steps
   *     in order, each green. That is the behaviour the test actually cares
   *     about, and it is load-insensitive by construction.
   *   - A generous CEILING second, default 30 s (≈25× the measured 1.2 s
   *     baseline for pool 20 / jury 7 on the reference box), env-tunable so a
   *     loaded or slower box raises it without editing the test:
   *     `SIM_BUDGET_MS=120000 npm test`. A real 100× regression (≈120 s)
   *     still exceeds the default and is caught.
   */
  const PIPELINE_STEPS = [
    'selection', 'dkg', 'vote', 'sign', 'validate', 'escrow', 'ln', 'liquid',
  ] as const;

  // r29-11: pin the ordering the derivation exists for — the wall-clock
  // assertion must always be able to fire before vitest's timeout does, at the
  // default budget and at an operator override. Without this, raising
  // SIM_BUDGET_MS silently converts a clean assertion into a timeout flake.
  it('derives the per-test timeout from the budget, never an independent absolute gate (r29-11)', () => {
    expect(SIM_TIMEOUT).toBeGreaterThan(SIM_BUDGET_MS);
    expect(SIM_TIMEOUT).toBeGreaterThanOrEqual(10_000);
    // 2× the budget is the documented rule; the floor only raises it.
    expect(SIM_TIMEOUT).toBe(Math.max(SIM_BUDGET_MS * 2, 10_000));
  });

  it('runs the whole pipeline green: selection → DKG → vote → sign → escrow → LN → Liquid', { timeout: SIM_TIMEOUT }, async () => {
    const r = await runCourtSimulation({ poolSize: 12, jurySize: 5, backups: 2, seed: 'test' });

    // Every step passed, in the published order, with no step silently gone.
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    for (const s of r.steps) {
      expect(s.ok, `step "${s.step}" should pass: ${s.detail}`).toBe(true);
    }

    // Deterministic selection + a real group key.
    expect(r.selectedCount).toBe(5);
    expect(r.groupPubkeyXOnly).toMatch(/^[0-9a-f]{64}$/);

    // Attestation validates under the group key.
    expect(r.attestationValid).toBe(true);

    // Escrow: 1 incoherent juror slashed 50% of 10k = 5k sats pool.
    expect(r.slashedPoolSats).toBeGreaterThan(0);

    // LN: 4 coherent settled, 1 incoherent cancelled.
    expect(r.lnSettled).toBe(4);
    expect(r.lnCancelled).toBe(1);

    // Liquid: deterministic P2WSH address + a broadcast happened.
    expect(r.liquidAddress).toMatch(/^tex1/);
    expect(r.broadcastTxid).toMatch(/^fake-txid-/);
  });

  it('is reproducible: same seed → same pipeline result (no cross-run drift)', { timeout: SIM_TIMEOUT }, async () => {
    const a = await runCourtSimulation({ seed: 'repro' });
    const b = await runCourtSimulation({ seed: 'repro' });
    expect(a.groupPubkeyXOnly).toBe(b.groupPubkeyXOnly);
    expect(a.liquidAddress).toBe(b.liquidAddress);
    expect(a.lnSettled).toBe(b.lnSettled);
    expect(a.ok && b.ok).toBe(true);
  });

  it('is load-insensitive: the pipeline is complete, and only a real regression breaks the budget', { timeout: SIM_TIMEOUT }, async () => {
    const start = Date.now();
    const r = await runCourtSimulation({ poolSize: 20, jurySize: 7, backups: 3 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(true);

    // Deterministic work first: the full eight-step pipeline ran, in order.
    // This is the assertion that fails on a behavioural regression, and it
    // cannot flake under load.
    expect(r.steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(r.steps.every((s) => s.ok)).toBe(true);

    // Then the generous ceiling (see SIM_BUDGET_MS above). Measured baseline:
    // ≈1.2 s. A docs-only tree once tripped the old 5 s gate at 8.9 s under
    // sweep load; 30 s absorbs that class of noise while still catching a 100×
    // regression (≈120 s). Override with SIM_BUDGET_MS on a slower box.
    expect(
      elapsed,
      `pipeline took ${elapsed}ms; budget ${SIM_BUDGET_MS}ms (set SIM_BUDGET_MS to raise it)`,
    ).toBeLessThan(SIM_BUDGET_MS);
  });
});
