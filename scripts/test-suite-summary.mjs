#!/usr/bin/env node
// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Reads a vitest --reporter=json output file and prints pass/fail counts for
 * the contract suites the paper calls out explicitly (parity, property,
 * invariant, model-checking, adversarial/fuzz), plus the totals.
 *
 * Usage: node scripts/test-suite-summary.mjs <test-results.json>
 * Exit 0 = no failed tests; 1 = any failure; 2 = usage.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: test-suite-summary.mjs <test-results.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));

const FAMILIES = [
  ['differential-parity', /differentialParity\.test\.ts$/],
  ['property-based', /properties[A-Z]\w*\.test\.ts$/],
  ['invariant-assertions', /invariantAssertions\.test\.ts$/],
  ['model-checking', /modelChecking\.test\.ts$/],
  ['adversarial', /(^|\/)(adversarial\w*|courtFuzz|courtRelayAdversary)\.test\.ts$/],
  ['regressions', /regressions\.test\.ts$/],
];

const counts = new Map();
for (const tr of report.testResults ?? []) {
  const base = tr.name.split('/').pop();
  for (const tr2 of tr.assertionResults ?? []) {
    const fam = FAMILIES.find(([, re]) => re.test(base))?.[0] ?? 'other';
    const c = counts.get(fam) ?? { passed: 0, failed: 0, skipped: 0 };
    if (tr2.status === 'passed') c.passed += 1;
    else if (tr2.status === 'pending' || tr2.status === 'skipped'
      || tr2.status === 'todo') c.skipped += 1;
    else c.failed += 1;
    counts.set(fam, c);
  }
}

const fmt = (c) => c
  ? `${c.passed} passed${c.failed ? `, ${c.failed} FAILED` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}`
  : 'not present';
const failures = report.numFailedTests ?? 0;

console.log('[test-suite-summary] contract suites (inside npm test):');
for (const [name] of FAMILIES) {
  console.log(`  ${name.padEnd(22)} ${fmt(counts.get(name))}`);
}
console.log(`  ${'TOTAL'.padEnd(22)} ${report.numPassedTests} passed`
  + `${failures ? `, ${failures} FAILED` : ''}`
  + `${report.numPendingTests ? `, ${report.numPendingTests} skipped` : ''}`
  + ` in ${new Set((report.testResults ?? []).map((t) => t.name)).size} files`);
process.exit(failures ? 1 : 0);
