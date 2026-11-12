// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round 51 — the determinism kit's own tests, and the STATIC GUARD that keeps
 * the class of flake this round removed from coming back.
 *
 * History (docs/TEST_DETERMINISM.md): the suite was load-sensitive for four
 * rounds. A 5 s wall-clock gate produced two FALSE mutation captures and was
 * reproduced by an external reviewer (docs-only tree → 12 red); review-round-10
 * had 15 timing flakes under heavy parallel load, green on re-runs; the soak
 * rounds found load-dependent behaviour twice. Every previous answer raised a
 * number. This file is the answer that does not need raising:
 *
 *   1. the watchdog is DERIVED from a measurement of the box it runs on
 *      (`helpers/watchdog.ts`), bounded on both sides and overridable;
 *   2. the gate is PROVEN LIVE — a deliberately starved run must trip it, so a
 *      watchdog that silently stopped working cannot pass as "quiet";
 *   3. the RULES are enforced statically: no test may assert on a duration, no
 *      test may sleep as synchronisation, no test may call `Math.random()`, and
 *      no timeout may be a bare literal. A future change that reintroduces any
 *      of them fails HERE, with the file and line.
 *
 * The static guard is deliberately a source scan, not an AST pass: it must run
 * in the same suite it polices, cost nothing, and be readable by a reviewer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WATCHDOG_MS,
  MAX_LOAD_FACTOR,
  WATCHDOG_ENV,
  WatchdogExceededError,
  bestMsPerUnit,
  loadFactor,
  runUnderWatchdog,
  suiteTestTimeoutMs,
  watchdogMs,
} from './helpers/watchdog';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.test.ts` under `__tests__/` (the files this guard polices). */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts')) out.push(path);
    }
  };
  walk(join(REPO, '__tests__'));
  return out.sort();
}

/** Strip `//` and block comments so prose about a banned token is not a hit. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, prefix: string) => prefix + ' '.repeat(m.length - prefix.length));
}

/** `file:line:text` for every line of `source` matching `pattern`. */
function hits(source: string, pattern: RegExp, file: string): string[] {
  const found: string[] = [];
  const lines = stripComments(source).split('\n');
  lines.forEach((line, i) => {
    if (pattern.test(line)) found.push(`${relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    pattern.lastIndex = 0;
  });
  return found;
}

/** Text of every `expect(...)` call, up to a bounded window (multiline-safe). */
function expectArguments(source: string): string[] {
  const stripped = stripComments(source);
  const bodies: string[] = [];
  for (let i = stripped.indexOf('expect('); i !== -1; i = stripped.indexOf('expect(', i + 1)) {
    // Keep the window small enough that adjacent statements do not leak in,
    // but wide enough for a wrapped `expect(\n  expr,\n  message,\n)`.
    bodies.push(stripped.slice(i, i + 240));
  }
  return bodies;
}

describe('determinism: the watchdog is derived, bounded and installed', () => {
  it('calibrates the box it is running on (finite, positive, bounded factor)', () => {
    const unit = bestMsPerUnit();
    // A per-unit cost that is zero would make every derived bound zero; one
    // that is minutes would mean the calibration itself never ran.
    expect(unit).toBeGreaterThan(0);
    expect(unit).toBeLessThan(1_000);
    const factor = loadFactor();
    expect(Number.isFinite(factor)).toBe(true);
    expect(factor).toBeGreaterThanOrEqual(1);
    expect(factor).toBeLessThanOrEqual(MAX_LOAD_FACTOR);
  });

  it('installs itself as the harness timeout (the setup file really ran)', () => {
    // `helpers/determinism.setup.ts` sets this marker in the same call that
    // installs `vi.setConfig`. Without it, this file's `expect` would still pass
    // against a suite running on vitest's absolute 5 s default — the exact
    // regression this round exists to prevent.
    expect((globalThis as { __baoWatchdogInstalled?: number }).__baoWatchdogInstalled).toBeGreaterThanOrEqual(
      DEFAULT_WATCHDOG_MS,
    );
  });

  it('the gate FIRES on a deliberately starved run (a watchdog nobody has seen fire is a deleted one)', () => {
    // 1. The gate lives: a STARVED body (25 ms of spinning) must exceed a 5 ms
    //    budget. The spinning has to happen INSIDE the guarded body — a guard
    //    around a constant fails nothing, which is exactly how a disabled
    //    watchdog would look.
    let caught: unknown;
    try {
      runUnderWatchdog(5, () => {
        const t0 = performance.now();
        let spun = 0;
        while (performance.now() - t0 < 25) spun += 1;
        return sweptWork(spun);
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WatchdogExceededError);
    expect((caught as WatchdogExceededError).budgetMs).toBe(5);
    expect((caught as WatchdogExceededError).elapsedMs).toBeGreaterThanOrEqual(5);

    // 2. And it does not misfire: the same helper over a generous budget lets
    //    a trivial body through. (A gate that always throws is not a gate.)
    expect(runUnderWatchdog(60_000, () => 41 + 1)).toBe(42);
  });

  it('the ordering property holds for every default: harness timeout > declared gate', () => {
    expect(suiteTestTimeoutMs(DEFAULT_WATCHDOG_MS)).toBeGreaterThan(watchdogMs(DEFAULT_WATCHDOG_MS));
    // Env override still respects the ordering (r29-11's class: an override
    // that turned a clean assertion into an opaque timeout flake).
    const previous = process.env[WATCHDOG_ENV];
    try {
      process.env[WATCHDOG_ENV] = '2500';
      expect(suiteTestTimeoutMs(DEFAULT_WATCHDOG_MS)).toBeGreaterThan(watchdogMs(DEFAULT_WATCHDOG_MS));
    } finally {
      if (previous === undefined) delete process.env[WATCHDOG_ENV];
      else process.env[WATCHDOG_ENV] = previous;
    }
  });
});

/** Fold `spun` into a value so the starvation loop cannot be optimised away. */
function sweptWork(spun: number): number {
  return (spun % 97) + 1;
}

describe('determinism: the static rules hold across the whole suite', () => {
  // This file is excluded from its own scans: it legitimately reads a clock to
  // STARVE the gate (that is how the gate is proven live) and it names the
  // banned tokens in its own rules. Every other test file is policed.
  const SELF = join(REPO, '__tests__', 'determinism.test.ts');
  const files = testFiles().filter((file) => file !== SELF);

  it('polices a non-empty set of test files (the guard cannot pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith('simulateCourt.test.ts'))).toBe(true);
  });

  it('NO test asserts on elapsed time (a duration threshold measures the box, not the code)', () => {
    // The banned shape: an `expect(...)` whose argument window reads a clock or
    // a duration name. Asserting `toBeLessThan(120_000)` on `elapsed` and
    // `expect(Date.now() - start).toBeLessThan(budget)` are the two historical
    // spellings; both produced false captures.
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const body of expectArguments(source)) {
        if (/\b(Date\.now\(\)|performance\.now\(\)|elapsed\w*|tookMs|durationMs)\b/.test(body)) {
          offenders.push(`${relative(REPO, file)}: ${body.split('\n')[0]?.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders, `an assertion reads the clock:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('NO test sleeps as a synchronisation device (no setTimeout/setInterval outside the allowlist)', () => {
    // Allowlist: the env-gated LIVE taproot test, which waits on a real network
    // (never part of `npm test`). Everything else must await a promise that the
    // code under test resolves — polling a deadline is a clock assertion with
    // extra steps.
    const ALLOWLIST = new Set(['__tests__/taprootSpend-live.test.ts']);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO, file);
      if (ALLOWLIST.has(rel)) continue;
      offenders.push(...hits(readFileSync(file, 'utf8'), /\b(setTimeout|setInterval)\s*\(/, file));
    }
    expect(offenders, `a test waits on a timer:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('NO test polls a deadline (vi.waitFor with a timeout is a wall-clock assertion)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      offenders.push(...hits(readFileSync(file, 'utf8'), /\b(vi\.)?waitFor\s*\(/, file));
    }
    expect(offenders, `a test polls for a condition:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('NO unseeded randomness in a test (every generator is a seeded stream)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // `keys.ts` CSPRNG fixtures stay value-independent and are allowed; the
      // rule is about generator-driven tests and about fixtures whose VALUES
      // reach an assertion.
      offenders.push(...hits(readFileSync(file, 'utf8'), /\bMath\.random\s*\(/, file));
    }
    expect(offenders, `unseeded randomness:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('NO bare numeric test timeout (every watchdog goes through wd())', () => {
    // `{ timeout: 120_000 }` and the positional `}, 30_000);` / `600_000,` are
    // both banned: a literal cannot follow the box, has no env override, and is
    // exactly the shape that flaked in round 10. Subprocess option timeouts
    // (`spawnSync`, `execFile`) are watchdogs too, so they go through wd()
    // for the same reason.
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (/timeout\s*:\s*[0-9]/.test(line)) {
          offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
          return;
        }
        // A number alone on its own line that CLOSES the call, and is large
        // enough that it cannot be anything but a timeout: the positional third
        // argument of `it(name, fn, TIMEOUT)`. (Threshold 5 s: the harness
        // default is 5 s, so a smaller positional number is always a real
        // argument — a fee, a clock literal — never a watchdog.)
        if (/^\s*[0-9][0-9_]*\s*,?\s*$/.test(line)) {
          const value = Number(line.trim().replace(/[,_]/g, ''));
          let next = i + 1;
          while (next < lines.length && lines[next]!.trim() === '') next += 1;
          if (value >= 5_000 && /^\);?$/.test((lines[next] ?? '').trim())) {
            offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }
    expect(offenders, `a bare numeric timeout:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('NO absolute subprocess deadline in a test (a fixed --deadline-ms trips under load)', () => {
    // Round 51's reproduction: the multi-process harness ran with
    // `--deadline-ms=4000`, so a loaded box made three honest jurors "fail
    // closed" and the test read that as a protocol failure. The deadline is a
    // watchdog and must be derived like every other one.
    const offenders: string[] = [];
    for (const file of files) {
      offenders.push(...hits(readFileSync(file, 'utf8'), /--deadline-ms=\d/, file));
    }
    expect(offenders, `a fixed subprocess deadline:\n${offenders.join('\n')}`).toEqual([]);
  });
});
