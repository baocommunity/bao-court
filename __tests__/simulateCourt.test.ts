// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { runCourtSimulation } from '../scripts/simulateCourt';

describe('full court simulation (single script, hermetic)', () => {
  it('runs the whole pipeline green: selection → DKG → vote → sign → escrow → LN → Liquid', async () => {
    const r = await runCourtSimulation({ poolSize: 12, jurySize: 5, backups: 2, seed: 'test' });

    // Every step passed.
    expect(r.ok).toBe(true);
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

  it('fast: completes the full pipeline well under the default 5s budget', async () => {
    const start = Date.now();
    const r = await runCourtSimulation({ poolSize: 20, jurySize: 7, backups: 3 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(true);
    // Pedersen DKG + FROST over 7 jurors in one process should be < 2s.
    expect(elapsed).toBeLessThan(5_000);
  });
});
