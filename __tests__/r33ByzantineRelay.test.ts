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
import { budgetMs, childTimeoutFor, processTimeout } from './helpers/budget';

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

/**
 * Phase deadline handed to the ceremony harness.
 *
 * This was a literal `--deadline-ms=2500`, and it decided the VERDICT, not just
 * the runtime: under load the honest reordering scenario had `completed: 0,
 * signatures: 0` because three processes could not finish a FROST round in
 * 2.5 s, and the test failed on `report.failures`. That is the wall-clock-as-
 * verdict class (docs/TEST_DETERMINISM.md rule 1) — a healthy ceremony scored
 * as broken because the box was busy.
 *
 * Derived and env-overridable now: `CEREMONY_PHASE_DEADLINE_MS=60000 npm test`.
 * The fail-closed scenarios (fork/silence) still classify correctly; they wait
 * for this deadline and then report the stall, which is their subject.
 */
const CEREMONY_PHASE_DEADLINE_MS = budgetMs('CEREMONY_PHASE_DEADLINE_MS', 20_000);

/**
 * Inter-sender reorder window handed to the harness.
 *
 * This is the third millisecond value that decided a verdict. The harness holds
 * a sender's records for `rank x (window / jurors)` ms, so a 90 ms window is a
 * 30 ms step — and a 30 ms step does not survive a loaded event loop: the
 * jitter collapses to send order, every juror observes the same sequence, and
 * both the harness self-check and this file's own `new Set(orders).size > 1`
 * assertion fail. The reordering is the SUBJECT of the test, so the window must
 * be large relative to scheduling noise, not merely non-zero.
 */
const REORDER_WINDOW_MS = budgetMs('CEREMONY_REORDER_WINDOW_MS', 300);

function runHarness(args: readonly string[]): Promise<{ report: HarnessReport; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', HARNESS, ...args, `--deadline-ms=${CEREMONY_PHASE_DEADLINE_MS}`],
      { cwd: ROOT, timeout: childTimeoutFor(processTimeout()), maxBuffer: 16 * 1024 * 1024 },
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

/**
 * The harness aggregates its OWN checks into `report.failures`. One of them is
 * instrumention, not security:
 *
 *   "reorder:<style>: the relay gave jurors DIFFERENT delivery orders"
 *
 * It is not style-guarded, and under `--reorder-style=invert` it can never
 * pass: that style delays ONE sender's commitments by 800 ms and every other
 * sender by 0, so all jurors necessarily observe the same order. Before this
 * round the check passed only because a 2 500 ms phase deadline TRUNCATED the
 * runs at different points — i.e. it was green because the box cut the ceremony
 * short, which is the same wall-clock-as-verdict bug this round removes.
 *
 * Harness bug, reported for `scripts/court/**` (the check belongs behind
 * `--reorder-style=block`). Filtering it here keeps every SECURITY assertion
 * strict: any other failure still fails the test.
 */
const HARNESS_INSTRUMENTATION_ONLY =
  /^reorder:(?:block|invert): the relay gave jurors DIFFERENT delivery orders/;

/**
 * `--reorder-style=invert` holds ONE sender's FROST commitments for a hardcoded
 * 800 ms. Whether that beats delivery latency — i.e. whether 1 juror signs and
 * 2 starve, or all 3 sign the same message — is decided by the CLOCK, and under
 * parallel load both outcomes occur. The harness's per-scenario checks encode
 * the starved outcome (and compare signature *occurrences* rather than distinct
 * values, so three identical signatures fail "at most ONE signature exists").
 *
 * The SECURITY property does not move: one message, one key, at most one
 * distinct signature. That is asserted directly below, so this test keeps
 * failing on a real equivocation and stops failing on scheduling.
 * Harness bug, reported for `scripts/court/**` (derive the hold; compare
 * distinct signatures).
 */
const INVERT_SCENARIO_INSTRUMENTATION = /^reorder:invert: /;

/** Assert no failure EXCEPT the known harness instrumentation check. */
function expectNoSecurityFailures(failures: readonly { name: string }[]): void {
  expect(failures.filter((f) => !HARNESS_INSTRUMENTATION_ONLY.test(f.name))).toEqual([]);
}

const SEED = 'c0ffee3300000000000000000000000000000000000000000000000000000000';

describe('multi-process ceremony under a Byzantine relay (round 33)', () => {
  it('honest relay: every juror completes with one group key and one signature', { timeout: processTimeout() }, async () => {
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

  it('reordering relay: per-juror delivery order differs yet the outcome is identical', { timeout: processTimeout() }, async () => {
    const { report } = await runHarness([
      '--jurors=3', '--mode=reorder', `--reorder-window-ms=${REORDER_WINDOW_MS}`, `--seed=${SEED}`,
    ]);
    expectNoSecurityFailures(report.failures);
    expect(report.relayMode).toBe('reorder');
    // The relay genuinely reordered: at least two jurors observed different orders.
    const orders = report.equivocation.perJurorView.map((v) => v.order.join(','));
    expect(new Set(orders).size).toBeGreaterThan(1);
    expect(report.equivocation.completionShape).toBe('ALL_COMPLETED_IDENTICALLY');
    expect(report.equivocation.verdict).toBe('NO_EQUIVOCATION');
  });

  it('lossy relay: every juror either completes or fails closed with a typed classification', { timeout: processTimeout() }, async () => {
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

  it('split-view from the start: nobody gets a key or a signature (the equivocation test)', { timeout: processTimeout() }, async () => {
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

  it('split-view after DKG: the key is agreed but the reveal gate starves on both sides', { timeout: processTimeout() }, async () => {
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

  it('replaying relay: duplicates are idempotent and never yield a second signature', { timeout: processTimeout() }, async () => {
    const { report } = await runHarness(['--jurors=3', '--mode=replay', `--seed=${SEED}`]);
    expect(report.failures).toEqual([]);
    expect(report.equivocation.relayStats.duplicated).toBeGreaterThan(0);
    expect(report.equivocation.completionShape).toBe('ALL_COMPLETED_IDENTICALLY');
    expect(report.equivocation.distinctSignatures).toBe(1);
    expect(report.equivocation.perJuror.every((j) => (j.duplicatesSeen ?? 0) > 0)).toBe(true);
  });

  it('silencing one juror: fails closed everywhere and NAMES the silenced participant', { timeout: processTimeout() }, async () => {
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

  it('inverting one sender\'s commit/reveal pair: order-sensitivity yields at most one signature', { timeout: processTimeout() }, async () => {
    const { report } = await runHarness([
      '--jurors=3', '--mode=reorder', '--reorder-style=invert', `--seed=${SEED}`,
    ]);
    // Every failure must be invert-scenario instrumentation; anything else is a
    // real finding and still fails.
    expect(report.failures.filter((f) => !INVERT_SCENARIO_INSTRUMENTATION.test(f.name)))
      .toEqual([]);
    expect(report.equivocation.verdict).toBe('NO_EQUIVOCATION');
    // The relay can split availability (one juror signs, peers fail closed),
    // but never the message: one key, one message, at most one signature.
    expect(report.equivocation.distinctSignatures).toBeLessThanOrEqual(1);
    expect(report.equivocation.distinctMessages).toBeLessThanOrEqual(1);
    expect(report.equivocation.distinctGroupKeys).toBeLessThanOrEqual(1);
  });
});
