// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round-30 campaign gate for the multi-process ceremony harness.
 *
 * `scripts/court/multi-process-ceremony.mjs` runs a REAL DKG + signing round
 * across N separate OS processes over a real loopback HTTP relay, with three
 * scenarios: happy path, SIGKILL mid-round, and cross-round message replay.
 * This suite runs all three (bounded: ~12 s total with 4 s phase deadlines)
 * so `npm test` cannot regress them.
 *
 * The harness prints its own PASS/FAIL lines and exits non-zero on any failed
 * assertion; here we additionally parse the JSON report to assert the
 * machine-readable verdict, not just the exit code.
 */

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetMs, childTimeoutFor, heavyTimeout } from './helpers/budget';

/**
 * Phase deadline for the ceremony harness — derived, never a literal (rule 1).
 * A literal `--deadline-ms=4000` made a healthy multi-process DKG report
 * `DKG_MISSING_PARTICIPANT` when the box was loaded. Override with
 * `CEREMONY_PHASE_DEADLINE_MS`.
 */
const CEREMONY_PHASE_DEADLINE_MS = budgetMs('CEREMONY_PHASE_DEADLINE_MS', 20_000);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'scripts/court/multi-process-ceremony.mjs');

interface HarnessReport {
  readonly ok: boolean;
  readonly failures: readonly { name: string; detail?: unknown }[];
  readonly jurorCount: number;
  readonly chaos: string;
  readonly runDir: string;
  readonly relayMessages: number;
  readonly latencyModel: Record<string, unknown>;
  readonly doesNotProve: readonly string[];
}

function runHarness(args: readonly string[]): Promise<{ report: HarnessReport; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', HARNESS, ...args, `--deadline-ms=${CEREMONY_PHASE_DEADLINE_MS}`],
      { cwd: ROOT, timeout: childTimeoutFor(heavyTimeout()), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // The harness writes report.json even when assertions fail; read it
        // first so a failure message carries the harness's own detail.
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

describe('multi-process ceremony (round 30)', () => {
  it('completes a real 3-process DKG + signing round with one group key', { timeout: heavyTimeout() }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=none']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.jurorCount).toBe(3);
    expect(report.relayMessages).toBeGreaterThanOrEqual(18);
    // Every check the harness makes (group-key agreement, signature
    // verification, per-juror state isolation) passed.
    expect(stdout).toContain('all processes independently computed the SAME group key');
    expect(stdout).toContain('the aggregated signature verifies against the group key');
    // The honest-scope statement ships with the report, not in a doc nobody reads.
    expect(report.doesNotProve.length).toBeGreaterThan(2);
    // Pin the DERIVATION, not the number: the harness must receive exactly the
    // configured deadline, so raising it can never silently desynchronise the
    // two sides (docs/TEST_DETERMINISM.md rule 5).
    expect(report.latencyModel.phaseDeadlineMs).toBe(CEREMONY_PHASE_DEADLINE_MS);
  });

  it('fails closed with SIGN_MISSING_REVEAL when a process dies mid-signing', { timeout: heavyTimeout() }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=kill', '--kill-phase=sign']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(stdout).toContain('every survivor failed closed with classification SIGN_MISSING_REVEAL');
    expect(stdout).toContain('no survivor produced a signature');
  });

  it('fails closed with DKG_MISSING_PARTICIPANT when a process dies mid-DKG', { timeout: heavyTimeout() }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=kill', '--kill-phase=dkg']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(stdout).toContain('every survivor failed closed with classification DKG_MISSING_PARTICIPANT');
    expect(stdout).toContain('no survivor accepted a group key');
  });

  it('rejects a process replaying its previous round messages', { timeout: heavyTimeout() }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=replay']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(stdout).toContain('the replayer republished its round-1 signed commitment verbatim into round 2');
    expect(stdout).toContain('every honest process failed closed on the replayed commitment');
    expect(stdout).toContain('the honest processes blamed the replayer (juror 2)');
  });
});
