#!/usr/bin/env node
// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Digit-identical comparison between a freshly regenerated model-check run
 * and the committed fixture `__fixtures__/model-check-summary.json`.
 *
 * The state-space numbers (states, edges, applications, throws, tally
 * counts, …) are DETERMINISTIC — a machine or explorer change that moves a
 * single digit must fail here. Only timing fields (generatedAt, totalWallMs,
 * per-instance wallMs) are legitimately non-reproducible and are excluded.
 *
 * Modes of the regenerated run:
 *   - `fast` (default in scripts/reproduce.sh): the regenerated fixture must
 *     contain EXACTLY the committed instance set minus FAST_SKIP_NAMES, and
 *     every shared instance must be digit-identical to its committed twin.
 *     The committed fixture itself must be mode `full` (the paper cites
 *     full-sweep numbers) with internally consistent totals.
 *   - `full`: instance sets must be identical.
 *   - `--allow-subset`: probing mode (e.g. `--only <name>`); every
 *     regenerated instance must still be digit-identical to its committed
 *     twin, no set equality required.
 *
 * Usage:
 *   npx tsx scripts/compare-model-check-fixture.mjs \
 *     --expected <pre-run copy of the committed fixture> \
 *     --actual   <freshly regenerated fixture> [--allow-subset]
 *   npx tsx scripts/compare-model-check-fixture.mjs --hash <fixture>
 *     # prints the timestamp-independent sha256 ("stable artifact hash")
 *
 * Exit 0 = digit-identical (or hash printed); 1 = any mismatch.
 * Run under tsx (not plain node) so it can import FAST_SKIP_NAMES from the
 * same core the model-check runner uses — no drift between the skip list
 * here and the one that produced the fixture.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FAST_SKIP_NAMES } from '../__tests__/modelCheckingCore.ts';

/** Fields that legitimately differ between runs (wall-clock, timestamps). */
const VOLATILE_INSTANCE_FIELDS = new Set(['wallMs']);
const VOLATILE_TOP_FIELDS = new Set(['generatedAt', 'totalWallMs']);

/** totals.<key> is summed from instance.<sourceKey>. */
const TOTALS_SOURCES = {
  states: 'states',
  abstractStates: 'abstractStates',
  progressEdges: 'progressEdges',
  selfLoops: 'selfLoops',
  applications: 'applications',
  typedThrows: 'typedThrows',
  rawThrows: 'rawThrows',
  illegalEventChecks: 'illegalChecks',
  determinismPathsReplayed: 'determinismPathsReplayed',
};

function stripVolatile(summary) {
  const out = JSON.parse(JSON.stringify(summary));
  for (const k of VOLATILE_TOP_FIELDS) delete out[k];
  for (const inst of out.instances ?? []) {
    for (const k of VOLATILE_INSTANCE_FIELDS) delete inst[k];
  }
  return out;
}

function deepEqual(a, b, path, diffs) {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null
    || typeof a !== 'object' || typeof b !== 'object') {
    diffs.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    diffs.push(`${path}: key sets differ (${ka.join(',')} vs ${kb.join(',')})`);
    return;
  }
  for (const k of ka) deepEqual(a[k], b[k], `${path}.${k}`, diffs);
}

function verifyTotals(expected, label, errors) {
  for (const [totKey, srcKey] of Object.entries(TOTALS_SOURCES)) {
    const sum = expected.instances.reduce((acc, i) => acc + (i[srcKey] ?? 0), 0);
    if (expected.totals?.[totKey] !== sum) {
      errors.push(
        `${label}: totals.${totKey} (${expected.totals?.[totKey]})`
          + ` != sum over instances (${sum})`,
      );
    }
  }
}

function compare(expected, actual, { allowSubset }) {
  const errors = [];
  const notes = [];

  if (expected.mode !== 'full') {
    errors.push(
      `committed fixture mode is "${expected.mode}", must be "full"`
        + ' (the paper cites full-sweep numbers — re-run WITHOUT --fast and commit)',
    );
  }
  verifyTotals(expected, 'committed fixture', errors);

  const byName = new Map(expected.instances.map((i) => [i.name, i]));
  for (const inst of actual.instances) {
    const twin = byName.get(inst.name);
    if (!twin) {
      errors.push(`regenerated instance "${inst.name}" not present in committed fixture`);
      continue;
    }
    const diffs = [];
    deepEqual(stripVolatile({ instances: [twin] }).instances[0],
      stripVolatile({ instances: [inst] }).instances[0],
      inst.name, diffs);
    if (diffs.length) {
      errors.push(`instance "${inst.name}" differs from committed fixture:\n  `
        + diffs.join('\n  '));
    }
  }

  if (!allowSubset) {
    const actualNames = new Set(actual.instances.map((i) => i.name));
    if (actual.mode === 'fast') {
      const expectedFast = expected.instances
        .map((i) => i.name)
        .filter((n) => !FAST_SKIP_NAMES.includes(n));
      const missing = expectedFast.filter((n) => !actualNames.has(n));
      const extra = [...actualNames].filter((n) => !expectedFast.includes(n));
      if (missing.length) errors.push(`fast run missing instances: ${missing.join(', ')}`);
      if (extra.length) errors.push(`fast run has unexpected instances: ${extra.join(', ')}`);
      if (FAST_SKIP_NAMES.length === 0) {
        notes.push('FAST_SKIP_NAMES is empty — fast mode equals full mode');
      } else {
        notes.push(`fast mode: skipped committed instances: ${FAST_SKIP_NAMES.join(', ')}`);
      }
    } else if (actual.mode === 'full') {
      const expectedNames = expected.instances.map((i) => i.name);
      const missing = expectedNames.filter((n) => !actualNames.has(n));
      const extra = [...actualNames].filter((n) => !expectedNames.includes(n));
      if (missing.length) errors.push(`full run missing instances: ${missing.join(', ')}`);
      if (extra.length) errors.push(`full run has unexpected instances: ${extra.join(', ')}`);
    } else {
      errors.push(`regenerated fixture has unknown mode "${actual.mode}"`);
    }
  }

  return { errors, notes };
}

function stableHash(summary) {
  const canonical = stripVolatile(summary);
  canonical.instances.sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256')
    .update(JSON.stringify(canonical, null, 2))
    .digest('hex');
}

const args = process.argv.slice(2);
const hashIdx = args.indexOf('--hash');
if (hashIdx >= 0) {
  const summary = JSON.parse(readFileSync(args[hashIdx + 1], 'utf8'));
  console.log(stableHash(summary));
  process.exit(0);
}

const expectedIdx = args.indexOf('--expected');
const actualIdx = args.indexOf('--actual');
if (expectedIdx < 0 || actualIdx < 0) {
  console.error('usage: --expected <file> --actual <file> [--allow-subset] | --hash <file>');
  process.exit(2);
}
const expected = JSON.parse(readFileSync(args[expectedIdx + 1], 'utf8'));
const actual = JSON.parse(readFileSync(args[actualIdx + 1], 'utf8'));
const { errors, notes } = compare(expected, actual, {
  allowSubset: args.includes('--allow-subset'),
});

for (const n of notes) console.log(`[compare-model-check] note: ${n}`);
if (errors.length) {
  console.error(`[compare-model-check] FAIL — ${errors.length} difference(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `[compare-model-check] OK — ${actual.instances.length} regenerated instance(s)`
    + ` digit-identical to committed fixture (timing fields excluded)`
    + `${actual.mode === 'fast' ? ` [fast mode; committed also carries: ${FAST_SKIP_NAMES.join(', ')}]` : ''}`,
);
