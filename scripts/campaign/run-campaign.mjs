// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * SCALE CAMPAIGN RUNNER — the round's large-corpus artifact generator.
 *
 * CI runs the FAST subset through `npm test`
 * (`__tests__/scale/scaleCampaign.test.ts`). This script runs the FULL corpus
 * (or any subset / size), prints a summary table, and writes the JSON artifact
 * the round commits under `docs/benchmarks/`.
 *
 * Usage:
 *
 *   npx tsx scripts/campaign/run-campaign.mjs --fast
 *   npx tsx scripts/campaign/run-campaign.mjs --full
 *   npx tsx scripts/campaign/run-campaign.mjs --full --json --out docs/benchmarks/campaign-2026-11-11.json
 *   npx tsx scripts/campaign/run-campaign.mjs --full --only tally,validator --events=20000
 *
 *   --fast | --full        profile (default: fast)
 *   --json                 print the full JSON result to stdout
 *   --out <path>           artifact path (default: docs/benchmarks/campaign-<date>.json
 *                          for --full, docs/benchmarks/campaign-<date>-fast.json for --fast)
 *   --no-write             print only, do not touch the filesystem
 *   --only <a,b,c>         restrict to campaigns (confirmation,tally,merkle,validator,selection,encoding)
 *   --seed <n>             campaign seed (default 20261111)
 *   --events <n> / --sequences <n> / --tallies <n> / --batches <n> / --draws <n> /
 *   --encodings <n> / --chi-square <n>
 *                          per-campaign corpus-size override (the documented split)
 *   --merge                merge into an existing artifact at --out instead of
 *                          replacing it (split invocations, one committed file)
 *   --help
 *
 * The exit code is non-zero when ANY campaign records a failure, so the script
 * is usable as a gate. Every number it prints and writes is the ACTUAL corpus
 * size that ran — never a declared size.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORPUS_NAMES,
  DEFAULT_SEED,
  declaredSizes,
  runCampaign,
} from '../../__tests__/scale/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const OVERRIDE_FLAGS = {
  '--sequences': 'confirmation',
  '--tallies': 'tally',
  '--batches': 'merkle',
  '--events': 'validator',
  '--draws': 'selection',
  '--encodings': 'encoding',
};

function usage() {
  console.log(`usage: npx tsx scripts/campaign/run-campaign.mjs [--fast|--full] [--json]
                          [--out <path>] [--no-write] [--only a,b,c] [--seed <n>] [--merge]
                          [--sequences n] [--tallies n] [--batches n] [--events n]
                          [--draws n] [--encodings n] [--chi-square n]`);
}

function parseArgs(argv) {
  const options = {
    profile: 'fast',
    json: false,
    out: null,
    write: true,
    only: null,
    seed: DEFAULT_SEED,
    sizes: {},
    chiSquareDraws: undefined,
    merge: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--fast') options.profile = 'fast';
    else if (arg === '--full') options.profile = 'full';
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--merge') options.merge = true;
    else if (arg === '--out') options.out = next();
    else if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--chi-square') options.chiSquareDraws = Number(next());
    else if (arg === '--only') {
      const names = next().split(',').map((name) => name.trim()).filter(Boolean);
      const unknown = names.filter((name) => !CORPUS_NAMES.includes(name));
      if (unknown.length > 0) throw new Error(`unknown campaign(s): ${unknown.join(', ')}`);
      options.only = names;
    } else if (OVERRIDE_FLAGS[arg] !== undefined) {
      const value = Number(next());
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${arg} needs a positive integer`);
      options.sizes[OVERRIDE_FLAGS[arg]] = value;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 1) throw new Error('--seed needs a positive integer');
  return options;
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Print one campaign's row of the summary table. */
function printResult(result) {
  const failed = result.failedChecks === 0 ? 'ok' : 'FAIL';
  console.log(
    `  ${result.name.padEnd(13)} ${String(result.corpus).padStart(9)} ${result.units.padEnd(10)} `
    + `${String(result.checks).padStart(9)} ${String(result.failedChecks).padStart(7)} `
    + `${fmtMs(result.wallMs).padStart(9)}  ${failed}`,
  );
}

function printFailures(result, limit = 3) {
  for (const failure of result.failures.slice(0, limit)) {
    console.error(`\n  ✗ [${failure.corpus}] ${failure.case}\n      ${failure.message.split('\n').join('\n      ')}`);
  }
  if (result.failedChecks > result.failures.length) {
    console.error(`  … ${result.failedChecks - result.failures.length} further failure(s) not shown`);
  }
}

function header() {
  console.log(
    `\n  ${'campaign'.padEnd(13)} ${'corpus'.padStart(9)} ${'unit'.padEnd(10)} `
    + `${'checks'.padStart(9)} ${'failed'.padStart(7)} ${'wall'.padStart(9)}`,
  );
  console.log(`  ${'-'.repeat(70)}`);
}

/** Total wall time across the corpora currently in an artifact. */
function totalWallMs(corpora) {
  return Math.round(corpora.reduce((sum, result) => sum + result.wallMs, 0));
}

/** Build the artifact document for one invocation. */
function artifactFor(run, invocations) {
  return {
    generatedAt: new Date().toISOString(),
    tool: 'scripts/campaign/run-campaign.mjs',
    profile: run.profile,
    seed: run.seed,
    wallMs: Math.round(run.wallMs),
    totalWallMs: totalWallMs(run.results),
    failedChecks: run.failedChecks,
    declaredSizes: declaredSizes(run.profile),
    actualSizes: Object.fromEntries(run.results.map((result) => [result.name, result.corpus])),
    corpora: run.results,
    invocations,
  };
}

/** Merge a new run into an existing artifact (split invocations, one file). */
function mergeArtifact(existingPath, run, invocations) {
  let existing = null;
  if (existsSync(existingPath)) {
    try {
      existing = JSON.parse(readFileSync(existingPath, 'utf8'));
    } catch (err) {
      throw new Error(`cannot merge into ${existingPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (existing === null || existing.profile !== run.profile || existing.seed !== run.seed) {
    return artifactFor(run, invocations);
  }
  const byName = new Map(existing.corpora.map((result) => [result.name, result]));
  for (const result of run.results) byName.set(result.name, result);
  const corpora = CORPUS_NAMES.filter((name) => byName.has(name)).map((name) => byName.get(name));
  return {
    ...existing,
    generatedAt: new Date().toISOString(),
    wallMs: Math.round(run.wallMs),
    totalWallMs: totalWallMs(corpora),
    failedChecks: corpora.reduce((sum, result) => sum + result.failedChecks, 0),
    actualSizes: Object.fromEntries(corpora.map((result) => [result.name, result.corpus])),
    corpora,
    invocations: [...(existing.invocations ?? []), ...invocations],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = options.profile;
  console.log(`\nBAO Court scale campaign — profile '${profile}', seed ${options.seed}`);
  const invocation = {
    startedAt: new Date().toISOString(),
    profile,
    seed: options.seed,
    only: options.only ?? [...CORPUS_NAMES],
    sizeOverrides: options.sizes,
    chiSquareDraws: options.chiSquareDraws ?? null,
    wallMs: 0,
    failedChecks: 0,
    corpora: [],
  };

  header();
  const run = runCampaign({
    profile,
    seed: options.seed,
    ...(options.only !== null ? { only: options.only } : {}),
    sizes: options.sizes,
    ...(options.chiSquareDraws !== undefined ? { chiSquareDraws: options.chiSquareDraws } : {}),
    onStart: (name, size) => process.stderr.write(`  running ${name} (${size})…\n`),
    onFinish: printResult,
  });

  invocation.wallMs = Math.round(run.wallMs);
  invocation.failedChecks = run.failedChecks;
  invocation.corpora = run.results.map((result) => ({ name: result.name, corpus: result.corpus, failedChecks: result.failedChecks }));

  const failing = run.results.filter((result) => result.failedChecks > 0);
  for (const result of failing) printFailures(result);

  const totalCorpus = run.results.reduce((sum, result) => sum + result.corpus, 0);
  console.log(`  ${'-'.repeat(70)}`);
  console.log(
    `  ${run.corporaRun} campaign(s), ${totalCorpus} corpus units, ${run.failedChecks} failed check(s), `
    + `wall ${fmtMs(run.wallMs)}, seed ${run.seed}\n`,
  );

  // The FULL run owns the canonical `campaign-<date>.json` artifact; a FAST
  // run writes a profile-suffixed file so it can never overwrite the round's
  // committed full-corpus record by accident.
  const date = new Date().toISOString().slice(0, 10);
  const outPath = options.out
    ?? join(root, 'docs', 'benchmarks', profile === 'full' ? `campaign-${date}.json` : `campaign-${date}-fast.json`);
  const artifact = options.merge
    ? mergeArtifact(outPath, run, [invocation])
    : artifactFor(run, [invocation]);

  if (options.write) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`  artifact: ${relative(process.cwd(), outPath)}${options.merge ? ' (merged)' : ''}\n`);
  }

  if (options.json) console.log(JSON.stringify(artifact, null, 2));

  process.exit(run.failedChecks === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  campaign runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
