// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Bounded model-explorer probe for ONE machine, used by the mutation runner.
 *
 * This is the model-checking DETECTOR: on a mutated source tree it explores
 * the reachable state space of the mutated machine and reports whether the
 * explorer's own properties (P1–P5, the invariant checker, the typed-error
 * discipline) are violated. It deliberately uses the REDUCED inline instance
 * set from `__tests__/modelCheckingCore.ts` (the same instances `npm test`
 * runs), because a mutant sweep must stay inside a bounded budget —
 * `scripts/model-check.mjs --fast` is the 9-minute full sweep and is run once
 * per release, not per mutant.
 *
 * Usage (from the repo root of the tree under test):
 *   npx tsx scripts/mutation/model-probe.mjs confirmation [--deep]
 *   npx tsx scripts/mutation/model-probe.mjs vote
 *   npx tsx scripts/mutation/model-probe.mjs signing
 *
 * Output: one JSON object on stdout (nothing else on stdout — the explorer is
 * silent; diagnostics go to stderr). Exit 0 = no violation, 1 = violation,
 * 2 = probe failure (mutant did not compile / instance blew its bound — that
 * is a detection too, reported as `inconclusive: false`).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const core = await import(join(root, '__tests__', 'modelCheckingCore.ts'));

const [machine, ...rest] = process.argv.slice(2);
const deep = rest.includes('--deep');

if (!['confirmation', 'vote', 'signing'].includes(machine)) {
  console.error(`[model-probe] unknown machine: ${machine}`);
  process.exit(2);
}

/** Reduced-clock confirmation instances (mirrors modelChecking.test.ts). */
const CONFIRM_REDUCED = (deep)
  ? [
      { name: 'confirm n=3 q=1 r=2 [probe clock 4/8/10]', n: 3, quorum: 1, maxLadderRounds: 2, challengers: [1], inlineClock: [4, 8, 10] },
      { name: 'confirm n=3 q=3 r=1 [probe clock 4/8/10]', n: 3, quorum: 3, maxLadderRounds: 1, challengers: [1, 2, 3], inlineClock: [4, 8, 10] },
    ]
  : [{ name: 'confirm n=3 q=1 r=2 [probe clock 4/8/10]', n: 3, quorum: 1, maxLadderRounds: 2, challengers: [1], inlineClock: [4, 8, 10] }];

const specs = {
  confirmation: () => CONFIRM_REDUCED.map((s) => [s.name, () => core.confirmAdapter(s)]),
  vote: () => [
    ['vote n=2 k=2 [probe]', () => core.voteAdapter({ name: 'vote n=2 k=2 [probe]', n: 2, outcomes: ['yes', 'no'] })],
    ['vote n=2 k=3 [probe]', () => core.voteAdapter({ name: 'vote n=2 k=3 [probe]', n: 2, outcomes: ['a', 'b', 'c'] })],
  ],
  signing: () => core.SIGNING_INSTANCES_INLINE.map((s) => [s.name, () => core.signingAdapter(s)]),
}[machine]();

const instances = [];
let violated = false;
let inconclusive = false;

for (const [name, make] of specs) {
  const startedAt = Date.now();
  try {
    const stats = core.exploreMachine(make());
    instances.push({ name, ok: true, states: stats.states, wallMs: Date.now() - startedAt });
  } catch (err) {
    violated = true;
    instances.push({
      name,
      ok: false,
      wallMs: Date.now() - startedAt,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

const payload = { machine, deep, instances, violated, inconclusive };
process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(violated ? 1 : 0);
