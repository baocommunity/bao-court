// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE determinism guard. Read `docs/TEST_DETERMINISM.md`.
 *
 * Two jobs, both about the same failure: a suite whose red is not information.
 *
 *  PART A — prove the WATCHDOG IS LIVE. Every ceiling in this suite is a
 *  promise that something fires when work runs away. An unproven promise is the
 *  vacuity class: the old 5 s gate "passed" for months while never once firing
 *  correctly. So this file *runs* a deliberately-hung test in its own vitest
 *  process and asserts the timeout fires — and, separately, measures the limit:
 *  vitest cannot preempt a synchronous loop, so the abort there is deferred
 *  (reported after the loop returns). Both facts are asserted, not assumed.
 *
 *  PART B — prove the RULES HOLD by construction. A rule written in a doc is a
 *  suggestion. These are structural scans over `__tests__/**`, so a future
 *  contributor cannot reintroduce a literal 5 s timeout, an elapsed-time
 *  assertion, a `setTimeout` used as synchronisation, a `waitFor`, or an
 *  unseeded `Math.random()` without this file going red and naming the line.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

import {
  DEFAULT_BUDGET_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  budgetMs,
  derivedTimeout,
  heavyTimeout,
  processTimeout,
  scaleTimeout,
  testTimeoutFor,
} from './helpers/budget';

const ROOT = process.cwd();

// ─────────────────────────────────────────────────────────────────────────────
// PART A — the watchdog is live
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the deliberate-hang probe in its own vitest process.
 *
 * `execFileSync` (not a shell) so the args are not reinterpreted; the
 * `VITEST*` variables are stripped because a worker's pool identity makes a
 * nested run refuse to start.
 *
 * Returns the `WATCHDOG_MARKER` contents (or null when the probe body never
 * reached its end) — the DETERMINISTIC evidence of preemption, so no assertion
 * here has to read a stopwatch.
 */
function runProbe(mode: 'async' | 'sync'): { status: number; output: string; marker: string | null } {
  const markerPath = join(tmpdir(), `bao-watchdog-${mode}-${process.pid}.txt`);
  rmSync(markerPath, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WATCHDOG_PROBE: mode,
    WATCHDOG_MARKER: markerPath,
  };
  for (const key of Object.keys(env)) {
    if (key === 'VITEST' || key.startsWith('VITEST_')) delete env[key];
  }
  let output = '';
  let status = 0;
  try {
    output = execFileSync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join('__tests__', 'determinism', 'watchdogProbe.config.ts'),
      ],
      { cwd: ROOT, env, encoding: 'utf8', stdio: 'pipe', timeout: processTimeout() },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    status = e.status ?? 1;
  }
  const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null;
  rmSync(markerPath, { force: true });
  return { status, output, marker };
}

describe('A. the per-test watchdog is live, not decorative (docs/TEST_DETERMINISM.md rule 4)', () => {
  it('fires on an awaited hang: a never-settling promise is aborted at the timeout', { timeout: heavyTimeout() }, () => {
    const { status, output, marker } = runProbe('async');

    // The run FAILED, and it failed FOR THE RIGHT REASON.
    expect(status).not.toBe(0);
    expect(output).toContain('Test timed out in 200ms');

    // The decisive evidence: the test body NEVER reached its end (no marker),
    // yet the process terminated. Without a live watchdog this run could not
    // have ended at all — a hanging promise has no other way out.
    expect(marker).toBeNull();
  });

  it('does NOT preempt synchronous code: the abort is deferred until the loop returns', { timeout: heavyTimeout() }, () => {
    // The measured limit of every in-process watchdog, asserted so the docs
    // cannot drift into claiming more than vitest can do.
    const { status, output, marker } = runProbe('sync');

    expect(status).not.toBe(0);
    expect(output).toContain('Test timed out in 200ms');

    // The 1.2 s busy loop ran TO COMPLETION despite the 200 ms ceiling: the
    // marker exists because vitest could not interrupt a blocked event loop,
    // and only reported the timeout afterwards. Residual: an infinite sync loop
    // would hang the run — only the process boundary can bound it.
    expect(marker, 'the sync probe must have finished its loop (no preemption)').not.toBeNull();
    expect(Number(marker)).toBeGreaterThanOrEqual(1_200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART B — the derived ceilings (rule 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('B. every ceiling is derived, and the ordering property holds', () => {
  it('testTimeoutFor always leaves room for the assertion to fire first (r29-11)', () => {
    // The property that matters, checked over the whole plausible range plus
    // the tier defaults — not one hand-picked example.
    const budgets = [1, 5, 250, 1_000, 5_000, 30_000, 60_000, 90_000, 150_000, 1e7];
    for (const budget of budgets) {
      expect(testTimeoutFor(budget), `budget ${budget}`).toBeGreaterThan(budget);
    }
    expect(testTimeoutFor(30_000)).toBe(60_000); // the r29-11 documented rule: 2×
    expect(testTimeoutFor(1)).toBe(10_000); // floor only ever raises it
  });

  it('rejects a nonsense budget instead of silently producing a nonsense timeout', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => testTimeoutFor(bad), `budget ${bad}`).toThrow(RangeError);
    }
  });

  it('has one policy point: the tiers and the defaults all come from budgetMs()', () => {
    // No tier may be a literal, and each must be env-overridable — the property
    // the soak program depends on when it raises a ceiling on a loaded box.
    process.env.BAO_HEAVY_BUDGET_MS = '7000';
    try {
      expect(heavyTimeout()).toBe(14_000);
    } finally {
      delete process.env.BAO_HEAVY_BUDGET_MS;
    }

    // Defaults are the documented, generous values (rule 4: never lowered for
    // speed). Pinned so a "make the suite feel fast" edit is a visible diff.
    expect(DEFAULT_BUDGET_MS).toBe(30_000);
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(60_000);
    expect(budgetMs('BAO_NO_SUCH_VARIABLE')).toBe(DEFAULT_BUDGET_MS);
    expect(derivedTimeout('BAO_NO_SUCH_VARIABLE')).toBe(60_000);
    expect(heavyTimeout()).toBe(120_000);
    expect(processTimeout()).toBe(180_000);
    expect(scaleTimeout()).toBe(300_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART C — structural rules (rules 1–4, enforced)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Files allowed to break a rule, with the REASON. An allowlist entry must name
 * why the exception is safe; "it was already like that" is not a reason.
 */
const ALLOW: Record<string, string> = {
  // The live-network suite is env-gated (BAO_LIVE_TAPROOT) and polls a real
  // chain: a sleep there is waiting for a THIRD PARTY, not for our own code,
  // so there is no deterministic drain to replace it with.
  '__tests__/taprootSpend-live.test.ts': 'polls a real network; env-gated',
};

/**
 * Locate every `it(...)`/`test(...)` call and report the ones that carry a
 * LITERAL numeric timeout — either as `{ timeout: 30_000 }` or as the legacy
 * trailing numeric argument. Parsed with the TypeScript AST, not a regex:
 * an ordinary numeric argument (`store(42)`, a `3_200` round, a `1_000`-sat
 * fee) is a false positive for a line matcher, and a guard that cries wolf is
 * a guard people delete.
 */
function literalTimeouts(): string[] {
  const found: string[] = [];

  /** Is this expression a bare numeric literal (`60_000`, `600000`)? */
  const isNumeric = (node: ts.Node): boolean => ts.isNumericLiteral(node);

  /** Does this object literal set `timeout:` to a numeric literal? */
  const hasLiteralTimeout = (node: ts.Node): boolean => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    return node.properties.some(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        prop.name.getText().replace(/['"]/g, '') === 'timeout' &&
        isNumeric(prop.initializer),
    );
  };

  const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const file of testFiles()) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        // `it(...)`, `test(...)`, `it.skipIf(c)(...)`, `it.each(x)(...)`: the
        // last callee link must be named it/test for the call to be a test.
        const calleeText = node.expression.getText(sf);
        const isTestCall = /(?:^|\.)(?:it|test)\b/.test(calleeText) ||
          /^(?:it|test)(?:\.\w+\([^)]*\))$/.test(calleeText);
        if (isTestCall) {
          for (const arg of node.arguments.slice(1)) {
            if (isNumeric(arg) || hasLiteralTimeout(arg)) {
              // The TEST NAME (first arg) may legitimately be numeric; every
              // later numeric argument is a timeout.
              found.push(`${file}:${lineOf(sf, arg)}: literal timeout ${arg.getText(sf)}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/** Walk a directory tree, collecting `.ts` files. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `__tests__/**\/*.ts` as repo-relative, POSIX-separated paths. */
function testFiles(): string[] {
  return walk(join(ROOT, '__tests__'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    // The guard scans itself in spirit, but its own rule NAMES (and failure
    // messages) contain the patterns it bans; self-scans would be a tautology.
    .filter((f) => f !== '__tests__/determinismGuard.test.ts')
    .sort();
}

/**
 * Strip comments before scanning, so a rule's own explanation cannot trip it.
 * Block comments are removed across the file; line comments are removed from
 * `//` preceded by start-or-space (so `https://` inside a string survives).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** Collect rule violations as `file:line: text` so a red run names the site. */
function violations(rule: (line: string, file: string) => boolean): string[] {
  const found: string[] = [];
  for (const file of testFiles()) {
    if (ALLOW[file]) continue;
    const lines = stripComments(readFileSync(join(ROOT, file), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (rule(line, file)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('C. the rules are enforced by construction, not by doc convention', () => {
  it('R1: no test declares a literal numeric timeout (derived only)', () => {
    // Parsed with the TypeScript AST, so an ordinary numeric argument is never
    // mistaken for a timeout — only a real `it(...)`/`test(...)` argument is.
    const bad = literalTimeouts();
    expect(bad, `literal per-test timeout(s) — use testTimeoutFor()/derivedTimeout():\n${bad.join('\n')}`)
      .toEqual([]);
  });

  it('R2: nothing asserts elapsed time as behaviour', () => {
    // A duration assertion measures the box. Watchdogs are allowed, but only
    // as `expect(elapsed).toBeLessThan(BUDGET)` where BUDGET is DERIVED — so
    // the banned shape is a clock read whose ceiling is a numeric literal.
    const bad = violations((line) => {
      if (!/expect\(\s*(?:Date|performance)\.now\(\)\s*-/.test(line)) {
        // A literal ceiling applied to a variable named like a duration.
        return /\.toBe(LessThan|GreaterThan)\(\s*\d[\d_]*\s*\)/.test(line) &&
          /\b(?:elapsed|elapsedMs|wallMs|durationMs)\b/.test(line);
      }
      // The clock read is on this line; the ceiling must not be a literal.
      return /\.toBe(LessThan|GreaterThan)\(\s*\d[\d_]*\s*\)/.test(line);
    });
    expect(bad, `elapsed-time assertion(s) — assert the work, not the clock:\n${bad.join('\n')}`)
      .toEqual([]);
  });

  it('R2b: every surviving duration watchdog is compared against a derived budget', () => {
    for (const file of testFiles()) {
      if (ALLOW[file]) continue;
      const lines = stripComments(readFileSync(join(ROOT, file), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!/\.toBeLessThan\(\s*(?:\d[\d_]*)\s*\)/.test(line)) return;
        // Only duration-shaped comparisons are in scope; `compare(a,b) < 0` and
        // `length < 3` are not clocks.
        if (!/\b(?:elapsed|elapsedMs|wallMs|durationMs|ms|Ms)\b/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (!/(?:BUDGET|budget|Timeout|_MS)/.test(context)) {
          throw new Error(
            `${file}:${i + 1}: numeric duration ceiling with no derived budget in scope\n${line.trim()}`,
          );
        }
      });
    }
  });

  it('R3: nothing sleeps as synchronisation', () => {
    const bad = violations(
      (line) =>
        /new Promise[^\n]*setTimeout\(\s*\w+\s*,\s*\d/.test(line) ||
        /await\s+new Promise[^\n]*setTimeout/.test(line),
    );
    expect(bad, `sleep used as sync — use drainJobs()/drainUntil():\n${bad.join('\n')}`).toEqual([]);
  });

  it('R4: no unseeded randomness in a test', () => {
    const bad = violations((line) => /Math\.random\s*\(/.test(line));
    expect(bad, `unseeded Math.random() — use mulberry32()/childRng():\n${bad.join('\n')}`)
      .toEqual([]);
  });

  it('R5: no time-based waiting primitives', () => {
    const bad = violations((line) => /\bvi\.waitFor\s*\(|(?<!\.)\bwaitFor\s*\(/.test(line));
    expect(bad, `time-based waitFor — use drainUntil() with an iteration bound:\n${bad.join('\n')}`)
      .toEqual([]);
  });

  it('R6: the suite never retries a test (a retry hides the race)', () => {
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/retry:\s*0/);
    expect(config).not.toMatch(/retry:\s*[1-9]/);
  });
});
