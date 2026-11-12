#!/usr/bin/env node
// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
//
// Summarise a `loaded-run.sh` campaign: per-test failure counts and causes.
//
//   node scripts/determinism/summarise-campaign.mjs <log-dir> [iterations]
//
// Reads `run-<n>.log` files produced by the harness and prints
// `count/iterations` per failing test, then the distinct failure causes. This
// is the number docs/TEST_DETERMINISM.md quotes; it is derived from the logs,
// never typed by hand.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: summarise-campaign.mjs <log-dir> [iterations]');
  process.exit(2);
}

const runs = readdirSync(dir)
  .filter((f) => /^run-\d+\.log$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

const declared = Number(process.argv[3] ?? runs.length);
const failures = new Map();
const causes = new Map();
let testsSeen = 0;

for (const run of runs) {
  const text = readFileSync(join(dir, run), 'utf8');
  for (const line of text.split('\n')) {
    // "     × test name 1234ms"  — a failing test.
    const fail = /^\s+×\s+(.+?)\s+\d+(?:\.\d+)?m?s\s*$/.exec(line);
    if (fail) failures.set(fail[1], (failures.get(fail[1]) ?? 0) + 1);
  }
  const totals = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(text);
  if (totals) testsSeen = Math.max(testsSeen, Number(totals[2]) + Number(totals[1] ?? 0));
  for (const m of text.matchAll(/^Error: (.+)$/gm)) {
    causes.set(m[1].replace(/\d+ms/g, 'Nms'), (causes.get(m[1].replace(/\d+ms/g, 'Nms')) ?? 0) + 1);
  }
}

console.log(`iterations: ${runs.length} of ${declared} declared`);
console.log(`tests per iteration: ${testsSeen}`);
console.log(`distinct failing tests: ${failures.size}`);
console.log('');
if (failures.size) {
  console.log('per-test flake rate (failures / iterations):');
  for (const [name, count] of [...failures].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(2)}/${runs.length}  ${name}`);
  }
  console.log('');
}
console.log('failure causes:');
if (!causes.size) console.log('  (none)');
for (const [cause, count] of [...causes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}×  ${cause}`);
}
