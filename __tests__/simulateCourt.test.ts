// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { runCourtSimulation } from '../scripts/simulateCourt';

/**
 * End-to-end court pipeline: selection → DKG → vote → sign → validate →
 * escrow → LN → Liquid.
 *
 * ─── Why there is no duration assertion here (round 51) ───────────────────
 *
 * This file used to carry a wall-clock gate. It started as an absolute 5 s
 * assertion, which produced two FALSE mutation "captures" (M40/M47) and was
 * reproduced by an external reviewer on a docs-only tree (12 red, no code
 * change). It was then raised to 30 s — which does not remove the class, it
 * hides it: under heavy parallel load the *same* pipeline still crossed a
 * relative-equivalent threshold, and the number would have been raised again.
 *
 * The behaviour this test owns is DETERMINISTIC and is asserted as such: the
 * eight steps, in order, each green, a real group key, a validating attestation
 * and the settlement counts. Nothing here needs the clock. Performance
 * regressions are measured by `scripts/bench-vs-baseline.mjs` (a benchmark, on
 * purpose: a benchmark may assert on time, a unit test may not), and a true
 * hang is caught by the harness watchdog (`__tests__/helpers/watchdog.ts`,
 * load-normalised, proven live in `__tests__/determinism.test.ts`).
 *
 * See `docs/TEST_DETERMINISM.md` §"No test asserts elapsed time".
 */
describe('full court simulation (single script, hermetic)', () => {
  const PIPELINE_STEPS = [
    'selection', 'dkg', 'vote', 'sign', 'validate', 'escrow', 'ln', 'liquid',
  ] as const;

  it('runs the whole pipeline green: selection → DKG → vote → sign → escrow → LN → Liquid', async () => {
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

  it('is reproducible: same seed → same pipeline result (no cross-run drift)', async () => {
    const a = await runCourtSimulation({ seed: 'repro' });
    const b = await runCourtSimulation({ seed: 'repro' });
    expect(a.groupPubkeyXOnly).toBe(b.groupPubkeyXOnly);
    expect(a.liquidAddress).toBe(b.liquidAddress);
    expect(a.lnSettled).toBe(b.lnSettled);
    expect(a.ok && b.ok).toBe(true);
  });

  it('is complete at the large instance too: pool 20 / jury 7 / 3 backups runs every step', async () => {
    // The old "is load-insensitive" test measured this instance with
    // `Date.now()`. The instance is worth keeping (it is the largest one the
    // suite runs); the CLOCK is not. Step identity + outcome is the contract.
    const r = await runCourtSimulation({ poolSize: 20, jurySize: 7, backups: 3 });

    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(r.steps.every((s) => s.ok), r.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`).join('; '))
      .toBe(true);
    expect(r.selectedCount).toBe(7);
    expect(r.attestationValid).toBe(true);
    expect(r.lnSettled + r.lnCancelled).toBeGreaterThan(0);
  });

  it('differs by seed: a different seed selects a different jury (the sim is not ignoring its input)', async () => {
    // Anti-vacuity lock for the two reproducibility tests above: a mutant that
    // hard-coded the seed (or ignored it) would make "same seed ⇒ same result"
    // trivially true. The group key is a function of the selected cohort.
    const a = await runCourtSimulation({ seed: 'seed-a' });
    const b = await runCourtSimulation({ seed: 'seed-b' });
    expect(a.groupPubkeyXOnly).not.toBe(b.groupPubkeyXOnly);
  });
});
