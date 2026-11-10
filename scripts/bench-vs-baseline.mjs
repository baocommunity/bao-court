#!/usr/bin/env node
// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Compares a fresh `bench --json` run against the committed baseline medians
 * (docs/benchmarks/baseline-medians.json, transcribed from
 * docs/benchmarks/BASELINE.md).
 *
 * Verdict rules (documented in docs/REPRODUCIBILITY.md § variance bounds):
 *   ok           within ±boundPct of the baseline median
 *   OVER-BOUND   slower than baseline by more than boundPct (expected on a
 *                loaded shared host — BASELINE.md documents load-driven
 *                swings up to x30; a warning, not a failure)
 *   REGRESSION   slower than baseline by more than regressionFactor (x3) —
 *                unambiguous regression or wrong machine class → exit 1
 *   FASTER       >50% faster than baseline — fine, but the baseline row is
 *                probably stale → informational
 *   no-baseline  benchmark has no baseline row yet (new capability row) →
 *                informational
 *
 * Usage: node scripts/bench-vs-baseline.mjs --bench <bench.json> \
 *          [--baseline docs/benchmarks/baseline-medians.json]
 * Exit 0 = no REGRESSION rows; 1 = at least one REGRESSION; 2 = usage/bad input.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const benchIdx = args.indexOf('--bench');
if (benchIdx < 0) {
  console.error('usage: --bench <bench.json> [--baseline <file>]');
  process.exit(2);
}
const benchPath = args[benchIdx + 1];
const baselinePath = args.includes('--baseline')
  ? args[args.indexOf('--baseline') + 1]
  : join(ROOT, 'docs', 'benchmarks', 'baseline-medians.json');

const bench = JSON.parse(readFileSync(benchPath, 'utf8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const boundPct = baseline.boundPct ?? 20;
const regressionFactor = baseline.regressionFactor ?? 3;

// Load-aware gate: BASELINE.md documents load-driven swings up to x18 (x30
// under saturation) on a shared host. On a QUIET box (load < 2) a REGRESSION
// row is a hard failure; under load it is downgraded to OVER-BOUND with an
// explicit note — the hard gate is only meaningful on the quiet host the
// baselines were taken on. See docs/REPRODUCIBILITY.md § variance bounds.
const loadAvg = bench.meta?.loadAvg1m;
const quiet = typeof loadAvg === 'number' && loadAvg < 2;
console.log(`[bench-vs-baseline] host loadAvg1m=${loadAvg ?? 'unknown'}`
  + ` — regression gate ${quiet ? 'ENFORCED (quiet box)' : 'DOWNgraded to warning (loaded box; re-run on load < 2 to enforce)'}`);

const rows = [];
let regressions = 0;
let overBound = 0;
let comparable = 0;

for (const b of bench.benchmarks) {
  const key = `${b.name}|${b.params}`;
  const expected = baseline.mediansUs[key];
  if (b.medianUsPerOp == null) {
    rows.push({ key, verdict: 'no-median', note: 'pipeline benchmark (no median)' });
    continue;
  }
  if (!expected) {
    rows.push({ key, verdict: 'no-baseline', median: b.medianUsPerOp });
    continue;
  }
  comparable += 1;
  const devPct = ((b.medianUsPerOp - expected.us) / expected.us) * 100;
  let verdict = 'ok';
  if (devPct > (regressionFactor - 1) * 100) {
    verdict = quiet ? 'REGRESSION' : 'OVER-BOUND-LOADED';
    if (quiet) regressions += 1; else overBound += 1;
  } else if (devPct > boundPct) {
    verdict = 'OVER-BOUND';
    overBound += 1;
  } else if (devPct < -50) {
    verdict = 'FASTER';
  }
  rows.push({ key, verdict, median: b.medianUsPerOp, baselineUs: expected.us, devPct });
}

console.log(`[bench-vs-baseline] bound=±${boundPct}% regression=${regressionFactor}x`
  + ` comparable=${comparable} over-bound=${overBound} regressions=${regressions}`);
for (const r of rows) {
  if (r.verdict === 'ok') continue;
  const dev = r.devPct != null ? ` (${r.devPct >= 0 ? '+' : ''}${r.devPct.toFixed(1)}%)` : '';
  console.log(`  ${r.verdict.padEnd(12)} ${r.key}`
    + `${r.median != null ? ` median=${r.median} µs` : ''}`
    + `${r.baselineUs != null ? ` baseline=${r.baselineUs} µs` : ''}${dev}`);
}
if (regressions > 0) {
  console.error(`[bench-vs-baseline] FAIL — ${regressions} REGRESSION row(s) (>${regressionFactor}x baseline on a quiet box)`);
  process.exit(1);
}
console.log('[bench-vs-baseline] OK — no regression rows'
  + (overBound ? ` (${overBound} over-bound row(s): load warning and/or baseline-stale, see docs/REPRODUCIBILITY.md)` : ''));
