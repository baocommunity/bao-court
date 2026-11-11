// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Mutation-testing runner for the BAO Court spec.
 *
 * Applies each mutant from `scripts/mutation/mutants.mjs` to a COPY of the
 * source tree (never the working tree), runs three detectors over the mutant,
 * restores the file, and records which detector — if any — noticed.
 *
 *   Detector A  the vitest suite (`npm test`, full 61-file battery)
 *   Detector B  the model explorer (`scripts/mutation/model-probe.mjs`, the
 *               bounded inline instance set of __tests__/modelCheckingCore.ts)
 *   Detector C  the invariant spot-check (`scripts/mutation/spot-check.mjs`)
 *
 * A mutant with no detector firing is a SURVIVOR: the spec (invariants +
 * proofs + tests) is blind to that bug class.
 *
 * Guarantees:
 *   • never writes to the repository it is launched from — all mutation
 *     happens inside `<tmp>/bao-court-mutation-<pid>/`;
 *   • deterministic — mutants run in id order, no randomness, results sorted;
 *   • signal-safe — SIGINT/SIGTERM kill children, remove the sandbox tree,
 *     and still run the clean-tree assertion;
 *   • self-checking — the run aborts unless the pristine sandbox is green
 *     (so a capture is never environmental noise), and the repository's
 *     `git status` must be byte-identical before and after the run.
 *
 * Usage:
 *   node scripts/mutation/run-mutants.mjs                 # full sweep
 *   node scripts/mutation/run-mutants.mjs --jobs 6        # parallelism
 *   node scripts/mutation/run-mutants.mjs --only M01,M06  # subset
 *   node scripts/mutation/run-mutants.mjs --no-baseline    # skip the green check
 *   node scripts/mutation/run-mutants.mjs --out /tmp/x.json
 *   node scripts/mutation/run-mutants.mjs --test-timeout 420  # seconds per mutant suite
 *
 * Crash-safety: each finished mutant is appended to `<out>.partial.jsonl`
 * immediately, so a killed or interrupted sweep still yields per-mutant
 * evidence; the file is folded into the final report and removed.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS, CLASSES, validateCatalogue } from './mutants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const jobs = Math.max(1, Number(argValue('--jobs', '4')) || 4);
const only = argValue('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const runBaseline = !argv.includes('--no-baseline');
// Detector A runs the full vitest battery EXCEPT the exhaustive model-check
// file: that file's work is exactly Detector B (the explorer probe), and
// counting it twice would both distort the per-detector comparison and
// multiply the sweep cost by ~4× (it is 170s of the 176s suite). Opt back in
// with --include-model-check.
const includeModelCheck = argv.includes('--include-model-check');
// testTimeout is raised well above the 5s default: this box is shared with
// other agent sessions, and a load-induced timeout must never be recorded as
// a capture (a capture is an ASSERTION failure, not slowness).
const SUITE_ARGS = ['run', '--maxWorkers=2', '--testTimeout=60000', '--hookTimeout=60000', '--reporter=json'];
// Two files are excluded from Detector A, for two different reasons:
//   • modelChecking.test.ts — its work IS Detector B (double counting), and
//     it is 170s of the 176s suite;
//   • simulateCourt.test.ts — it asserts WALL-CLOCK budget ("finishes under
//     5s"), a performance gate, not a semantic assertion. On a shared box
//     under load it fails for every mutant and would be recorded as a false
//     capture (observed in the first sweep: M40/M47/M52). CI runs it in its
//     own job (`npm run simulate:court`).
const SUITE_EXCLUDES = includeModelCheck
  ? ['**/simulateCourt.test.ts']
  : ['**/modelChecking.test.ts', '**/simulateCourt.test.ts'];
const SUITE_SCOPE = includeModelCheck
  ? 'full suite minus __tests__/simulateCourt.test.ts (wall-clock budget gate)'
  : 'full suite minus __tests__/modelChecking.test.ts (Detector B) and __tests__/simulateCourt.test.ts (wall-clock budget gate)';
const excludeArgs = SUITE_EXCLUDES.flatMap((glob) => ['--exclude', glob]);
const outPath = resolve(argValue('--out', join(repoRoot, 'scripts', 'mutation', 'last-run.json')));
const verbose = argv.includes('--verbose');

// A mutant may make the suite loop instead of fail (never-converging ladder,
// unbounded retry). Such a mutant IS detected — the suite never goes green —
// but the run must not inherit the hang, so the per-mutant cap is a knob.
const testTimeoutSec = Math.max(60, Number(argValue('--test-timeout', '900')) || 900);
const TEST_TIMEOUT_MS = testTimeoutSec * 1000;
const SPOT_TIMEOUT_MS = 180_000;
const MODEL_TIMEOUT_MS = 900_000;
const checkpointPath = `${outPath}.partial.jsonl`;

// ─── signal-safe sandbox bookkeeping ────────────────────────────────────────
const children = new Set();
let sandboxRoot = null;
let interruptedBy = null;
let cleanupDone = false;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (sandboxRoot) {
    await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function fail(code) {
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    interruptedBy = signal;
    console.error(`\n[mutants] ${signal} — cleaning up sandboxes…`);
    await cleanup();
    console.error('[mutants] sandboxes removed; the working tree was never touched.');
    fail(signal === 'SIGINT' ? 130 : 143);
  });
}

process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
});

// ─── child-process helper (timeout + captured logs) ─────────────────────────
function run(cmd, args, { cwd, timeoutMs, logFile }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      children.delete(child);
      resolvePromise({ code: -1, out, err: `${err}\nspawn error: ${error.message}`, wallMs: Date.now() - startedAt, timedOut: false });
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (logFile) await writeFile(logFile, `${out}\n--- stderr ---\n${err}`).catch(() => {});
      resolvePromise({
        code: code ?? -1,
        signal,
        out,
        err,
        wallMs: Date.now() - startedAt,
        timedOut: signal === 'SIGKILL' && Date.now() - startedAt >= timeoutMs - 1000,
      });
    });
  });
}

/** Recursive copy that skips the mutation run artifacts and VCS metadata. */
async function copyTree(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(from.length + 1);
      if (!rel) return true;
      if (rel === '.git' || rel.startsWith('.git/')) return false;
      if (rel === 'node_modules/.vite' || rel.startsWith('node_modules/.vite/')) return false;
      if (rel === 'scripts/mutation/last-run.json') return false;
      return true;
    },
  });
}

// ─── detectors ──────────────────────────────────────────────────────────────
function parseVitestJson(path) {
  return readFile(path, 'utf8').then((text) => {
    const report = JSON.parse(text);
    const failing = [];
    let failedSuites = 0;
    for (const file of report.testResults ?? []) {
      const assertionFailures = (file.assertionResults ?? []).filter((a) => a.status === 'failed');
      if (assertionFailures.length === 0 && file.status === 'failed') {
        failedSuites += 1;
        const message = (file.message ?? '').split('\n')[0].slice(0, 300);
        failing.push({ file: relative(file.name), name: `<suite failed to run>`, message });
      }
      for (const assertion of assertionFailures) {
        failing.push({
          file: relative(file.name),
          name: assertion.fullName ?? assertion.title ?? '<unnamed>',
          message: (assertion.failureMessages ?? []).join(' ').split('\n')[0].slice(0, 300),
        });
      }
    }
    return {
      totalTests: report.numTotalTests ?? 0,
      passedTests: report.numPassedTests ?? 0,
      failedTests: report.numFailedTests ?? failing.length,
      failedSuites,
      failing: failing.slice(0, 40),
      success: report.success === true && failing.length === 0,
    };
  });
}

function relative(file) {
  if (!file) return '<unknown>';
  return file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file;
}

async function detectTests(sandbox, id) {
  const reportPath = join(sandbox, `.mutation-${id}-tests.json`);
  const result = await run(
    process.execPath,
    [
      join(sandbox, 'node_modules', 'vitest', 'vitest.mjs'),
      ...SUITE_ARGS,
      ...excludeArgs,
      `--outputFile=${reportPath}`,
    ],
    { cwd: sandbox, timeoutMs: TEST_TIMEOUT_MS, logFile: join(sandbox, `.mutation-${id}-tests.log`) },
  );
  if (!existsSync(reportPath)) {
    return {
      captured: true,
      timedOut: result.timedOut,
      note: `suite produced no report (exit ${result.code}${result.timedOut ? ', timed out' : ''}) — the mutant broke the build/suite harness`,
      wallMs: result.wallMs,
      failing: [{ file: '<suite>', name: '<no report>', message: (result.err || result.out).slice(-300) }],
    };
  }
  const parsed = await parseVitestJson(reportPath);
  await rm(reportPath, { force: true });
  return {
    captured: !parsed.success,
    timedOut: result.timedOut,
    wallMs: result.wallMs,
    ...parsed,
  };
}

async function detectSpot(sandbox, id) {
  const result = await run(
    process.execPath,
    [join(sandbox, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/mutation/spot-check.mjs'],
    { cwd: sandbox, timeoutMs: SPOT_TIMEOUT_MS, logFile: join(sandbox, `.mutation-${id}-spot.log`) },
  );
  const jsonLine = result.out.trim().split('\n').filter(Boolean).pop();
  try {
    const parsed = JSON.parse(jsonLine);
    const failed = parsed.probes.filter((p) => !p.ok).map((p) => ({ id: p.id, error: p.error }));
    return { captured: failed.length > 0, wallMs: result.wallMs, failed };
  } catch {
    return {
      captured: true,
      wallMs: result.wallMs,
      failed: [{ id: 'harness', error: `spot-check did not run (exit ${result.code}): ${(result.err || result.out).slice(-200)}` }],
    };
  }
}

async function detectModel(sandbox, id, machine, deep) {
  const args = ['scripts/mutation/model-probe.mjs', machine];
  if (deep) args.push('--deep');
  const result = await run(
    process.execPath,
    [join(sandbox, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ...args],
    {
    cwd: sandbox,
    timeoutMs: MODEL_TIMEOUT_MS,
    logFile: join(sandbox, `.mutation-${id}-model.log`),
  });
  const jsonLine = result.out.trim().split('\n').filter(Boolean).pop();
  try {
    const parsed = JSON.parse(jsonLine);
    return {
      captured: parsed.violated === true,
      wallMs: result.wallMs,
      instances: parsed.instances,
      note: parsed.violated ? parsed.instances.find((i) => !i.ok)?.error : undefined,
    };
  } catch {
    return {
      captured: true,
      wallMs: result.wallMs,
      instances: [],
      note: `model probe failed to run (exit ${result.code}) — treat as a detection: ${(result.err || result.out).slice(-200)}`,
    };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const count = validateCatalogue(MUTANTS);
  console.log(`[mutants] catalogue: ${count} mutants, ${Object.keys(CLASSES).length} classes`);

  // Ambiguity guard: every find string must occur exactly once (per file).
  const pristine = new Map();
  for (const mutant of MUTANTS) {
    if (!pristine.has(mutant.file)) {
      pristine.set(mutant.file, await readFile(join(repoRoot, mutant.file), 'utf8'));
    }
    const occurrences = pristine.get(mutant.file).split(mutant.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${mutant.id}: find string occurs ${occurrences}× in ${mutant.file} (must be exactly once)`);
    }
  }

  const selected = only.length > 0 ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  if (selected.length === 0) throw new Error(`--only matched no mutant (${only.join(',')})`);

  const gitBefore = await gitStatus(repoRoot);
  const mutatedFiles = [...new Set(MUTANTS.map((m) => m.file))];
  const hashesBefore = await sourceHashes(mutatedFiles);
  sandboxRoot = await mkdtemp(join(tmpdir(), 'bao-court-mutation-'));
  const baseDir = join(sandboxRoot, 'base');
  console.log(`[mutants] sandbox: ${sandboxRoot}`);
  console.log('[mutants] copying pristine tree…');
  await copyTree(repoRoot, baseDir);

  // ── baseline: the pristine sandbox must be green, or every capture is noise
  let baseline = null;
  if (runBaseline) {
    // A pristine baseline must be green. One retry is allowed because this box
    // is shared with other agent sessions and a load-induced flake in the
    // baseline would otherwise abort a 40-minute campaign; a capture is still
    // only ever an ASSERTION failure, never slowness.
    for (let attempt = 1; attempt <= 2 && baseline === null; attempt += 1) {
      console.log(`[mutants] baseline: running the full suite on the pristine copy (attempt ${attempt})…`);
      const reportPath = join(baseDir, `baseline-tests-${attempt}.json`);
      const result = await run(
        process.execPath,
        [
          join(baseDir, 'node_modules', 'vitest', 'vitest.mjs'),
          ...SUITE_ARGS,
          ...excludeArgs,
          `--outputFile=${reportPath}`,
        ],
        { cwd: baseDir, timeoutMs: TEST_TIMEOUT_MS, logFile: join(baseDir, `baseline-tests-${attempt}.log`) },
      );
      const parsed = await parseVitestJson(reportPath);
      parsed.wallMs = result.wallMs;
      console.log(
        `[mutants] baseline: ${parsed.passedTests}/${parsed.totalTests} passed, `
        + `${parsed.failedTests} failed in ${(result.wallMs / 1000).toFixed(1)}s`,
      );
      if (parsed.success) {
        baseline = parsed;
      } else {
        for (const failure of parsed.failing) console.error(`[mutants]   baseline failure: ${failure.file} :: ${failure.name} — ${failure.message}`);
        await rm(reportPath, { force: true });
        if (attempt === 2) {
          throw new Error('pristine tree is NOT green — refusing to run mutants (every capture would be noise)');
        }
        console.error('[mutants] baseline not green — retrying once (environmental flake control)');
        baseline = null;
      }
      await rm(reportPath, { force: true });
    }
  }

  // ── worker pools: one sandbox each, pulling mutants from a shared cursor
  const results = new Array(selected.length).fill(null);
  let cursor = 0;
  let completed = 0;

  const worker = async (slot) => {
    const workDir = join(sandboxRoot, `work-${slot}`);
    await copyTree(baseDir, workDir);
    for (;;) {
      if (interruptedBy) return;
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const mutant = selected[index];
      const filePath = join(workDir, mutant.file);
      const original = pristine.get(mutant.file);
      const mutated = original.replace(mutant.find, mutant.replace);

      const startedAt = Date.now();
      try {
        await writeFile(filePath, mutated);
        const [tests, spot] = await Promise.all([
          detectTests(workDir, mutant.id),
          detectSpot(workDir, mutant.id),
        ]);
        let model = { captured: false, note: 'not modelled (no phase machine in this file)', wallMs: 0 };
        if (mutant.machine) {
          model = await detectModel(workDir, mutant.id, mutant.machine, mutant.deep === true);
        }
        const detectors = { tests: tests.captured, spot: spot.captured, model: model.captured };
        const capturedBy = Object.entries(detectors).filter(([, v]) => v).map(([k]) => k);
        results[index] = {
          id: mutant.id,
          cls: mutant.cls,
          file: mutant.file,
          intent: mutant.intent,
          machine: mutant.machine,
          captured: capturedBy.length > 0,
          capturedBy,
          detectors,
          tests: {
        scope: SUITE_SCOPE,
        timedOut: tests.timedOut === true,
        hitCap: tests.timedOut === true,
        failedTests: tests.failedTests, failedSuites: tests.failedSuites ?? 0, failing: tests.failing ?? [], wallMs: tests.wallMs },
          spot: { failed: spot.failed ?? [], wallMs: spot.wallMs },
          model: { instances: model.instances ?? [], note: model.note, wallMs: model.wallMs },
          wallMs: Date.now() - startedAt,
        };
      } finally {
        // Restore the mutated file from the pristine copy — no mutant survives
        // in the sandbox, and the sandbox is removed at the end regardless.
        await writeFile(filePath, original);
      }

      completed += 1;
      const record = results[index];
      // Durable per-mutant evidence: a killed sweep keeps everything finished
      // so far instead of losing the whole campaign.
      await appendFile(checkpointPath, `${JSON.stringify(record)}\n`).catch(() => {});
      const mark = record.captured ? `CAPTURED by ${record.capturedBy.join('+')}` : 'SURVIVED';
      console.log(
        `[mutants] ${String(completed).padStart(2)}/${selected.length} ${record.id} `
        + `${record.cls.padEnd(24)} ${mark} (${(record.wallMs / 1000).toFixed(0)}s)`,
      );
      if (verbose && !record.captured) console.log(`           intent: ${record.intent}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, (_, slot) => worker(slot)));

  if (interruptedBy) {
    throw new Error(`interrupted by ${interruptedBy}`);
  }

  // ── clean-tree assertion: this run must not have touched the repository
  const gitAfter = await gitStatus(repoRoot);
  const hashesAfter = await sourceHashes(mutatedFiles);
  const filesUnchanged = mutatedFiles.every((file) => hashesBefore[file] === hashesAfter[file]);
  const trackedTreeUnchanged = gitAfter === gitBefore;
  const pristineTree = filesUnchanged && trackedTreeUnchanged;
  if (!pristineTree) {
    console.error('[mutants] REPOSITORY CHANGED during the run — this is a runner bug, refusing to report.');
    if (!filesUnchanged) {
      console.error('[mutants] mutated source files differ from their pre-run bytes:');
      for (const file of mutatedFiles) {
        if (hashesBefore[file] !== hashesAfter[file]) console.error(`  ${file}`);
      }
    }
    if (!trackedTreeUnchanged) console.error('before:\n' + gitBefore + '\nafter:\n' + gitAfter);
  }

  const summary = summarize(results.filter(Boolean), baseline);
  const payload = {
    tool: 'scripts/mutation/run-mutants.mjs',
    generatedAt: new Date().toISOString(),
    repoRoot,
    precision: 'single semantic mutation per source file, applied to a sandbox copy',
    testDetectorScope: SUITE_SCOPE,
    cleanTree: {
      pristineBefore: gitBefore,
      pristineAfter: gitAfter,
      trackedTreeUnchanged,
      sourceFilesHashed: mutatedFiles,
      sourceFilesUnchanged: filesUnchanged,
      unchanged: pristineTree,
    },
    parallelism: jobs,
    testTimeoutSec,
    baseline,
    summary,
    mutants: results.filter(Boolean),
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  await rm(checkpointPath, { force: true });

  console.log('');
  console.log(`[mutants] mutation score: ${(summary.score * 100).toFixed(1)}% `
    + `(${summary.captured}/${summary.total} captured, ${summary.survived} survived)`);
  for (const [key, value] of Object.entries(summary.byDetector)) {
    console.log(`[mutants]   ${key.padEnd(6)} ${(value.score * 100).toFixed(1).padStart(5)}% (${value.captured}/${value.total})`);
  }
  console.log(`[mutants] clean tree: ${pristineTree ? 'PRISTINE (repo untouched)' : 'DIRTY — RUNNER BUG'}`);
  console.log(`[mutants] results: ${outPath}`);

  await cleanup();
  if (!pristineTree) fail(1);
}

function summarize(mutants, baseline) {
  const total = mutants.length;
  const captured = mutants.filter((m) => m.captured).length;
  const byClass = {};
  for (const cls of Object.keys(CLASSES)) {
    const group = mutants.filter((m) => m.cls === cls);
    if (group.length === 0) continue;
    byClass[cls] = {
      description: CLASSES[cls],
      total: group.length,
      captured: group.filter((m) => m.captured).length,
      score: group.length === 0 ? 0 : group.filter((m) => m.captured).length / group.length,
      survivors: group.filter((m) => !m.captured).map((m) => m.id),
    };
  }
  const byDetector = {};
  for (const detector of ['tests', 'spot', 'model']) {
    const hit = mutants.filter((m) => m.detectors[detector]).length;
    byDetector[detector] = { total, captured: hit, score: total === 0 ? 0 : hit / total };
  }
  // Model checking only applies where a phase machine is modelled at all.
  const modelled = mutants.filter((m) => m.machine !== null);
  byDetector.model.applicable = modelled.length;
  byDetector.model.scoreApplicable = modelled.length === 0 ? 0 : modelled.filter((m) => m.detectors.model).length / modelled.length;
  return {
    total,
    captured,
    survived: total - captured,
    score: total === 0 ? 0 : captured / total,
    byClass,
    byDetector,
    survivors: mutants.filter((m) => !m.captured).map((m) => ({ id: m.id, cls: m.cls, file: m.file, intent: m.intent })),
    baselineTests: baseline?.totalTests ?? null,
  };
}

/**
 * Tracked-file status only. The run writes its OWN artifacts (last-run.json,
 * logs) and those are untracked by design — the invariant this runner must
 * prove is that no TRACKED source file changed and that every mutant was
 * applied to a copy. Untracked noise would defeat that comparison.
 */
async function gitStatus(cwd) {
  const result = await run('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
    cwd,
    timeoutMs: 60_000,
  });
  return result.out.trim();
}

/** sha256 of every file the catalogue can mutate — the hard "repo untouched" proof. */
async function sourceHashes(files) {
  const hashes = {};
  for (const file of files) {
    const bytes = await readFile(join(repoRoot, file));
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  return hashes;
}

main().catch(async (error) => {
  console.error(`[mutants] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  fail(1);
});
