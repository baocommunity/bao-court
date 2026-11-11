// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round-33 campaign gate: the BYZANTINE-RELAY matrix.
 *
 * R30 (`__tests__/r30MultiProcessCeremony.test.ts`) removed the "all in one
 * process" assumption. R33 removes the honest-relay assumption: the loopback
 * relay in `scripts/court/multi-process-ceremony.mjs` can reorder, drop,
 * fork (split-view), replay and silence, deterministically under a seed.
 *
 * Each cell asserts the SECURITY outcome, not just "it ran":
 *   honest / reorder / replay  → completes, ONE message, ONE key, ONE signature
 *   drop                       → completes or fails closed, never diverges
 *   fork:dkg (eclipse)         → everybody fails closed, no key, no signature
 *   fork:sign (late split)     → nobody can reveal, no signature anywhere
 *   silence(one juror)         → fails closed and NAMES the silenced juror
 *
 * Bounded: seven cells, ~4 s each with 2.5 s phase deadlines.
 */

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'scripts/court/multi-process-ceremony.mjs');

interface JurorOutcome {
  readonly idx: number;
  readonly ok: boolean | null;
  readonly classification: string | null;
  readonly blamedIdx: number | null;
  readonly groupPubkeyXOnly: string | null;
  readonly signature: string | null;
  readonly message: string | null;
  readonly duplicatesSeen: number | null;
}

interface HarnessReport {
  readonly ok: boolean;
  readonly failures: readonly { name: string; detail?: unknown }[];
  readonly jurorCount: number;
  readonly relayMode: string;
  readonly relayVariant?: Record<string, string>;
  readonly targetedJuror?: number;
  readonly runDir: string;
  readonly relayMessages: number;
  readonly doesNotProve: readonly string[];
  readonly equivocation: {
    readonly verdict: 'NO_EQUIVOCATION' | 'EQUIVOCATION';
    readonly completionShape: string;
    readonly distinctMessages: number;
    readonly distinctGroupKeys: number;
    readonly distinctSignatures: number;
    readonly completed: number;
    readonly perJuror: readonly JurorOutcome[];
    readonly perJurorView: readonly {
      idx: number;
      delivered: number;
      senders: readonly number[];
      order: readonly number[];
      duplicates: number;
    }[];
    readonly splitView: { differs: boolean; distinctDeliveryCounts: readonly number[] };
    readonly relayStats: { records: number; dropped: number; duplicated: number; delivered?: number };
  };
}

function runHarness(args: readonly string[]): Promise<{ report: HarnessReport; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', HARNESS, ...args, '--deadline-ms=2500'],
      { cwd: ROOT, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const runDir = /run dir (\S+)/.exec(stdout)?.[1];
        if (!runDir) {
          reject(new Error(`harness produced no run dir.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as HarnessReport;
        if (error && report.ok) {
          reject(new Error(`harness exited non-zero but reported ok.\n${stdout}\n${stderr}`));
          return;
        }
        resolve({ report, stdout });
      },
    );
  });
}

const SEED = 'c0ffee3300000000000000000000000000000000000000000000000000000000';

describe('multi-process ceremony under a Byzantine relay (round 33)', () => {
  it('honest relay: every juror completes with one group key and one signature', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=3', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.relayMode).toBe('honest');
    expect(report.equivocation.completionShape).toBe('ALL_COMPLETED_IDENTICALLY');
    expect(report.equivocation.verdict).toBe('NO_EQUIVOCATION');
    expect(report.equivocation.completed).toBe(3);
    expect(report.equivocation.distinctSignatures).toBe(1);
    expect(report.equivocation.distinctGroupKeys).toBe(1);
    expect(report.equivocation.splitView.differs).toBe(false);
  });

  it('reordering relay: per-juror delivery order differs yet the outcome is identical', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=3', '--mode=reorder', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.relayMode).toBe('reorder');
    // The relay genuinely reordered: at least two jurors observed different orders.
    const orders = report.equivocation.perJurorView.map((v) => v.order.join(','));
    expect(new Set(orders).size).toBeGreaterThan(1);
    expect(report.equivocation.completionShape).toBe('ALL_COMPLETED_IDENTICALLY');
    expect(report.equivocation.verdict).toBe('NO_EQUIVOCATION');
  });

  it('lossy relay: every juror either completes or fails closed with a typed classification', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=3', '--mode=drop', '--drop-p=0.2', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.equivocation.relayStats.dropped).toBeGreaterThan(0);
    expect(report.equivocation.completionShape).not.toBe('ALL_COMPLETED_DIVERGENT');
    expect(report.equivocation.verdict).toBe('NO_EQUIVOCATION');
    for (const juror of report.equivocation.perJuror) {
      if (juror.ok) continue;
      expect([
        'DKG_MISSING_PARTICIPANT',
        'DKG_DISQUALIFIED',
        'SIGN_MISSING_PARTICIPANT',
        'SIGN_MISSING_REVEAL',
      ]).toContain(juror.classification);
      expect(juror.signature).toBeNull();
    }
  });

  it('split-view from the start: nobody gets a key or a signature (the equivocation test)', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=5', '--mode=fork', '--fork-variant=dkg', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.equivocation.splitView.differs).toBe(true);
    expect(report.equivocation.completionShape).toBe('ALL_FAILED_CLOSED');
    expect(report.equivocation.distinctMessages).toBe(0);
    expect(report.equivocation.distinctSignatures).toBe(0);
    for (const juror of report.equivocation.perJuror) {
      expect(juror.ok).toBe(false);
      expect(juror.classification).toBe('DKG_MISSING_PARTICIPANT');
      expect(juror.groupPubkeyXOnly).toBeNull();
      expect(juror.signature).toBeNull();
      expect(typeof juror.blamedIdx).toBe('number');
    }
    // No juror ever saw a record from the other cohort.
    expect(report.equivocation.perJurorView.some((v) => v.senders.length < report.jurorCount - 1)).toBe(true);
  });

  it('split-view after DKG: the key is agreed but the reveal gate starves on both sides', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=3', '--mode=fork', '--fork-variant=sign', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.equivocation.splitView.differs).toBe(true);
    const keys = new Set(report.equivocation.perJuror.map((j) => j.groupPubkeyXOnly));
    expect(keys.size).toBe(1); // DKG completed before the split
    expect(report.equivocation.completionShape).toBe('ALL_FAILED_CLOSED');
    expect(report.equivocation.distinctSignatures).toBe(0);
    for (const juror of report.equivocation.perJuror) {
      expect(juror.classification).toBe('SIGN_MISSING_PARTICIPANT');
      expect(juror.signature).toBeNull();
    }
  });

  it('replaying relay: duplicates are idempotent and never yield a second signature', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=3', '--mode=replay', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.equivocation.relayStats.duplicated).toBeGreaterThan(0);
    expect(report.equivocation.completionShape).toBe('ALL_COMPLETED_IDENTICALLY');
    expect(report.equivocation.distinctSignatures).toBe(1);
    expect(report.equivocation.perJuror.every((j) => (j.duplicatesSeen ?? 0) > 0)).toBe(true);
  });

  it('silencing one juror: fails closed everywhere and NAMES the silenced participant', { timeout: 180_000 }, async () => {
    const { report } = await runHarness(['--jurors=3', '--mode=silence', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    const victim = report.targetedJuror;
    expect(typeof victim).toBe('number');
    expect(report.equivocation.completionShape).toBe('ALL_FAILED_CLOSED');
    expect(report.equivocation.distinctSignatures).toBe(0);
    for (const juror of report.equivocation.perJuror) {
      expect(juror.ok).toBe(false);
      if (juror.idx === victim) continue;
      expect(juror.blamedIdx).toBe(victim);
      expect(juror.classification).toBe('DKG_MISSING_PARTICIPANT');
    }
  });

  it('inverting one sender\'s commit/reveal pair: order-sensitivity yields at most one signature', { timeout: 180_000 }, async () => {
    const { report } = await runHarness([
      '--jurors=3', '--mode=reorder', '--reorder-style=invert', `--seed=${SEED}`,
    ]);
    expect(report.failures).toEqual([]);
    expect(report.equivocation.verdict).toBe('NO_EQUIVOCATION');
    // The relay can split availability (one juror signs, peers fail closed),
    // but never the message: one key, one message, at most one signature.
    expect(report.equivocation.distinctSignatures).toBeLessThanOrEqual(1);
    expect(report.equivocation.distinctMessages).toBeLessThanOrEqual(1);
    expect(report.equivocation.distinctGroupKeys).toBeLessThanOrEqual(1);
  });
});
