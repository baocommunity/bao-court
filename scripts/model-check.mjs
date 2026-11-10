// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Standalone FULL exhaustive model-check runner for the BAO Court phase
 * machines. This is the ONLY place the multi-million-state instances run —
 * never inside `npm test` (a multi-million-state exhaustive sweep would die
 * in CI; see the run-mode split documented in
 * `__tests__/modelCheckingCore.ts`).
 *
 * Usage:
 *
 *   npx tsx scripts/model-check.mjs            # full sweep (several minutes)
 *   npx tsx scripts/model-check.mjs --fast     # skips the vote n=4 headline instance (CI-friendly)
 *   npx tsx scripts/model-check.mjs --only <name-substring>   # single instance (probing)
 *
 * The run is written to `__fixtures__/model-check-summary.json` — a cached
 * summary (per-instance state-space numbers + the properties checked). The
 * vitest suite (`__tests__/modelChecking.test.ts`) asserts that committed
 * fixture and cross-checks two cheap instances by re-exploring them, so a
 * stale fixture fails the suite. Re-run this script after any explorer or
 * machine change and commit the refreshed fixture.
 *
 * Exit code is non-zero if any instance throws a non-typed error or any
 * P1–P5 property fails (the explorer asserts them internally).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const {
  exploreMachine,
  printStats,
  voteAdapter,
  confirmAdapter,
  signingAdapter,
  VOTE_INSTANCES_FULL,
  CONFIRM_INSTANCES_FULL,
  SIGNING_INSTANCES_FULL,
  PROPERTIES_CHECKED,
  FAST_SKIP_NAMES,
} = await import('../__tests__/modelCheckingCore.ts');

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

const specs = [
  ...VOTE_INSTANCES_FULL.map((spec) => () => voteAdapter(spec)),
  ...CONFIRM_INSTANCES_FULL.map((spec) => () => confirmAdapter(spec)),
  ...SIGNING_INSTANCES_FULL.map((spec) => () => signingAdapter(spec)),
].filter((make) => {
  const name = make().name;
  if (only && !name.includes(only)) return false;
  if (fast && FAST_SKIP_NAMES.includes(name)) return false;
  return true;
});

console.log(
  `[model-check] mode=${fast ? 'fast' : 'full'} instances=${specs.length}`
  + (only ? ` filter=${only}` : ''),
);

const startedAt = Date.now();
const results = [];
for (const make of specs) {
  const adapter = make();
  const stats = exploreMachine(adapter);
  printStats(stats);
  results.push(stats);
}
const totalWallMs = Date.now() - startedAt;

const sum = (key) => results.reduce((acc, r) => acc + r[key], 0);
const summary = {
  tool: 'scripts/model-check.mjs',
  description: 'Exhaustive finite-state-space model checking of the BAO Court phase machines (courtVoteMachine, courtConfirmationMachine, courtSigningMachine). Regenerate with: npx tsx scripts/model-check.mjs',
  generatedAt: new Date().toISOString(),
  mode: fast ? 'fast' : 'full',
  totalWallMs,
  propertiesChecked: PROPERTIES_CHECKED,
  totals: {
    instances: results.length,
    states: sum('states'),
    abstractStates: sum('abstractStates'),
    progressEdges: sum('progressEdges'),
    selfLoops: sum('selfLoops'),
    applications: sum('applications'),
    typedThrows: sum('typedThrows'),
    rawThrows: sum('rawThrows'),
    illegalEventChecks: sum('illegalChecks'),
    determinismPathsReplayed: sum('determinismPathsReplayed'),
  },
  instances: results.map((r) => ({ ...r })),
};

const fixtureDir = join(root, '__fixtures__');
mkdirSync(fixtureDir, { recursive: true });
const fixturePath = join(fixtureDir, 'model-check-summary.json');
writeFileSync(fixturePath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  `\n[model-check] WROTE ${fixturePath}\n`
  + `[model-check] totals: ${JSON.stringify(summary.totals)}\n`
  + `[model-check] wall time: ${(totalWallMs / 1000).toFixed(1)}s`,
);
