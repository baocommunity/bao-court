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
import { wd } from './helpers/watchdog';

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

/**
 * Idle budget handed to the harness: a watchdog, so it follows the box.
 *
 * 8 s is the maximum SILENCE a phase may see (the child resets the clock on
 * every accepted record — see `scripts/court/juror-child.ts`), not a phase
 * clock. A stalled peer still aborts after this budget; an honest but starved
 * phase keeps making progress and is never aborted for being slow. 4 s was not
 * enough: under a 40+ load average a peer's share computation took longer than
 * that, and this test reported DKG_MISSING_PARTICIPANT for a live juror.
 */
const HARNESS_DEADLINE_MS = wd(8_000);

function runHarness(args: readonly string[]): Promise<{ report: HarnessReport; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      // The harness phase deadline models "a phase that takes hours"; the
      // test runs it at a small multiple so the suite stays fast. Round 51
      // found that a FIXED 4000 ms made three honest jurors "fail closed" on a
      // loaded box, which the test then read as a protocol failure (a false
      // capture in the r30 class). Derived from the same watchdog as everything
      // else: identical on an idle box, wider when the box is busy.
      ['--import', 'tsx', HARNESS, ...args, `--deadline-ms=${HARNESS_DEADLINE_MS}`],
      { cwd: ROOT, timeout: wd(120_000), maxBuffer: 8 * 1024 * 1024 },
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
  it('completes a real 3-process DKG + signing round with one group key', { timeout: wd(120_000) }, async () => {
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
    expect(report.latencyModel.phaseDeadlineMs).toBe(HARNESS_DEADLINE_MS);
  });

  it('fails closed with SIGN_MISSING_REVEAL when a process dies mid-signing', { timeout: wd(120_000) }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=kill', '--kill-phase=sign']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(stdout).toContain('every survivor failed closed with classification SIGN_MISSING_REVEAL');
    expect(stdout).toContain('no survivor produced a signature');
  });

  it('fails closed with DKG_MISSING_PARTICIPANT when a process dies mid-DKG', { timeout: wd(120_000) }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=kill', '--kill-phase=dkg']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(stdout).toContain('every survivor failed closed with classification DKG_MISSING_PARTICIPANT');
    expect(stdout).toContain('no survivor accepted a group key');
  });

  it('rejects a process replaying its previous round messages', { timeout: wd(120_000) }, async () => {
    const { report, stdout } = await runHarness(['--jurors=3', '--chaos=replay']);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(stdout).toContain('the replayer republished its round-1 signed commitment verbatim into round 2');
    expect(stdout).toContain('every honest process failed closed on the replayed commitment');
    expect(stdout).toContain('the honest processes blamed the replayer (juror 2)');
  });
});
