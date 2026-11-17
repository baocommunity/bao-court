// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE BOND GATE AGAINST A HOSTILE VERIFIER.
 *
 * The gate's own contract tests (`bondCheckGate.test.ts`) assume the command
 * behaves. This file assumes it does not: it is the operator of a malicious
 * `BAO_COURT_BOND_CHECK_CMD` — the exact position an attacker who controls the
 * box is in — and asserts what the gate does with a checker that LIES
 * (`ok:true` for a bond nobody paid, or for a different one), CHEATS (prints
 * two answers, answers on the wrong stream, answers after its budget),
 * LEAKS (reads the ceremony's environment), or REFUSES TO STOP (hangs, ignores
 * SIGTERM, leaves a daemon behind).
 *
 * Two layers are exercised:
 *   - `bondCheckGate.ts` — the parser and the roster decision (pure, and the
 *     layer that must stay right even if a caller forgets to compare);
 *   - `scripts/court/bondCheckRunner.mjs` — the SAME spawn/quote/timeout/env
 *     code the ceremony runs, loaded as a module (not re-implemented here).
 *
 * The threat model and the guarantee table live in
 * `docs/BOND_GATE_THREAT_MODEL.md`; every row there has a test here.
 *
 * NO DURATION ASSERTIONS: boundedness is proven by effect (a sentinel the
 * command would have written had it kept running), never by a clock reading —
 * see `docs/TEST_DETERMINISM.md`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bondIdentity,
  buildBondCheckArgs,
  gateRosterOnBonds,
  parseBondCheckOutput,
  type BondCheckVerdict,
  type JurorBondClaim,
} from '../bondCheckGate';
import { parseCourtBondRef } from '../bondVerification';
import { wd } from './helpers/watchdog';

const PUBKEY = 'a'.repeat(64);
const PROOF = '0f1186fabb1fbeb1862f67edadedb291f0a41a0bc0ca5936c3f1028577465d2a:0';

/** The bond the ceremony asks about (one object, reused: it is an identifier). */
const REQUEST = {
  rail: 'liquid' as const,
  network: 'testnet' as const,
  proofRef: PROOF,
  bondSats: 0,
  jurorPubkey: PUBKEY,
};

interface RunResult {
  verdict: BondCheckVerdict & { valueSats?: number | null };
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  stderr: string;
  timedOut: boolean;
  pid: number | null;
  outputBytes?: number;
}

interface RunnerModule {
  runBondCheck: (options: Record<string, unknown>) => Promise<RunResult>;
  runBondCheckWithRetry: (options: Record<string, unknown>) => Promise<RunResult & {
    attempts: number;
    history: Array<{ attempt: number; ok: boolean; code: string | null }>;
  }>;
  bondCheckEnv: (source?: Record<string, string | undefined>) => Record<string, string>;
  BOND_CHECK_ENV_ALLOWLIST: readonly string[];
  BOND_CHECK_ENV_PASSTHROUGH: string;
  shQuote: (value: unknown) => string;
}

const RUNNER_URL = new URL('../scripts/court/bondCheckRunner.mjs', import.meta.url).href;

let runner: RunnerModule;
let dir: string;

beforeAll(async () => {
  runner = (await import(/* @vite-ignore */ RUNNER_URL)) as RunnerModule;
  dir = mkdtempSync(join(tmpdir(), 'bao-court-bondgate-'));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Write an executable stub and return its absolute path. */
function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

/** A node stub — `node <script> <argv…>` ignores the flags a real checker parses. */
function nodeStub(name: string, body: string): string {
  return `${JSON.stringify(process.execPath).slice(1, -1)} ${stub(name, body)}`;
}

/**
 * A POSIX-shell stub. The hostile cases that need TIME use `sleep` in a script
 * rather than a JS timer: this suite forbids timers in tests (a timer is a clock
 * assertion with extra steps — see docs/TEST_DETERMINISM.md), and the shell is
 * the more honest attacker anyway.
 */
function shellStub(name: string, body: string): string {
  return `sh ${stub(name, body)}`;
}

/** A JSON body a stub can print as its one answer. */
function answer(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// ---------------------------------------------------------------------------
// 1. LYING SUCCESS — the checker says "proved" about something it did not prove
// ---------------------------------------------------------------------------

describe('hostile verifier — lying success', () => {
  it('refuses ok:true for a DIFFERENT proofRef (a bond nobody presented)', () => {
    const verdict = parseBondCheckOutput(
      answer({ ok: true, proofRef: 'deadbeef:1', sources: ['blockstream'] }),
      REQUEST,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('BOND_PROOF_MISMATCH');
  });

  it('refuses ok:true with NO proofRef at all', () => {
    const verdict = parseBondCheckOutput(answer({ ok: true, sources: ['blockstream'] }), REQUEST);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(verdict.detail).toMatch(/must carry the proven `proofRef`/);
  });

  it('refuses ok:true with an EMPTY sources list (proof from nobody)', () => {
    const verdict = parseBondCheckOutput(answer({ ok: true, proofRef: PROOF, sources: [] }), REQUEST);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('BOND_CHECK_MALFORMED');
  });

  it('refuses an ok:true that echoes a FOREIGN rail or network', () => {
    const rail = parseBondCheckOutput(
      answer({ ok: true, proofRef: PROOF, sources: ['s'], rail: 'onchain' }),
      REQUEST,
    );
    expect(rail.ok).toBe(false);
    expect(rail.code).toBe('BOND_RAIL_MISMATCH');

    const network = parseBondCheckOutput(
      answer({ ok: true, proofRef: PROOF, sources: ['s'], network: 'signet-public' }),
      REQUEST,
    );
    expect(network.ok).toBe(false);
    expect(network.code).toBe('BOND_RAIL_MISMATCH');
  });

  it('refuses ok:true for a bond worth LESS than the ceremony requires', () => {
    const floored = { ...REQUEST, bondSats: 1_000 };
    const verdict = parseBondCheckOutput(
      answer({ ok: true, proofRef: PROOF, sources: ['s'], valueSats: 999 }),
      floored,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('BOND_VALUE_BELOW_REQUIRED');
    expect(verdict.detail).toMatch(/999 sat/);
    // ... and the roster decision turns that into an exclusion, not a seat.
    const gate = gateRosterOnBonds({
      jurors: [{ idx: 1, pubkey: PUBKEY, bond: parseCourtBondRef(REQUEST) }],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([[1, verdict]]),
    });
    expect(gate.admitted).toHaveLength(0);
    expect(gate.excluded[0]?.refusal).toBe('BOND_CHECK_REFUSED');
    expect(gate.classification).toBe('ROSTER_BELOW_THRESHOLD');
  });

  it('refuses a non-numeric bond value and accepts exactly the floor', () => {
    const floored = { ...REQUEST, bondSats: 1_000 };
    expect(
      parseBondCheckOutput(
        answer({ ok: true, proofRef: PROOF, sources: ['s'], valueSats: '1000' }),
        floored,
      ).code,
    ).toBe('BOND_CHECK_MALFORMED');
    const exactly = parseBondCheckOutput(
      answer({ ok: true, proofRef: PROOF, sources: ['s'], valueSats: 1_000 }),
      floored,
    );
    expect(exactly.ok).toBe(true);
    expect(exactly.valueSats).toBe(1_000);
  });

  it('refuses TWO ok:true answers in one invocation (a second answer is not a second chance)', async () => {
    const body = answer({ ok: true, proofRef: PROOF, sources: ['s'] });
    expect(parseBondCheckOutput(`${body}\n${body}`, REQUEST).code).toBe('BOND_CHECK_MALFORMED');
    const run = await runner.runBondCheck({
      command: nodeStub('two-objects.mjs', `process.stdout.write(${JSON.stringify(`${body}${body}`)});`),
      request: REQUEST,
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
  });
});

// ---------------------------------------------------------------------------
// 2. TRUNCATION / STREAM GAMES — the answer is a shape, not a hint
// ---------------------------------------------------------------------------

describe('hostile verifier — truncation and stream games', () => {
  const cases: Array<[string, string, string]> = [
    ['truncated mid-JSON', "process.stdout.write('{\"ok\":true,\"proofRef\":\"x\"');", 'BOND_CHECK_MALFORMED'],
    ['a JSON ARRAY of answers', `process.stdout.write(${JSON.stringify(`[${answer({ ok: true, proofRef: PROOF, sources: ['s'] })}]`)});`, 'BOND_CHECK_MALFORMED'],
    ['two concatenated objects', `process.stdout.write(${JSON.stringify(`${answer({ ok: true, proofRef: PROOF, sources: ['s'] })}${answer({ ok: true, proofRef: PROOF, sources: ['s'] })}`)});`, 'BOND_CHECK_MALFORMED'],
    ['a bare string', "process.stdout.write('true');", 'BOND_CHECK_MALFORMED'],
    ['a log line before the verdict', `process.stdout.write(${JSON.stringify(`checking… ${answer({ ok: true, proofRef: PROOF, sources: ['s'] })}`)});`, 'BOND_CHECK_MALFORMED'],
  ];

  for (const [name, body, code] of cases) {
    it(`refuses ${name}`, async () => {
      const run = await runner.runBondCheck({
        command: nodeStub(`shape-${name.replace(/\W+/g, '-')}.mjs`, body),
        request: REQUEST,
        timeoutMs: 5_000,
      });
      expect(run.verdict.ok).toBe(false);
      expect(run.verdict.code).toBe(code);
    });
  }

  it('reads STDOUT only: a valid answer on stderr is not an answer', async () => {
    const run = await runner.runBondCheck({
      command: nodeStub(
        'stderr-only.mjs',
        `process.stderr.write(${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['s'] }))});`,
      ),
      request: REQUEST,
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(run.stderr).toContain('"ok":true');
  });

  it('THE EXIT CODE WINS: a valid ok:true body from a non-zero exit is a refusal', async () => {
    const run = await runner.runBondCheck({
      command: nodeStub(
        'exit-wins.mjs',
        `process.stdout.write(${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['s'] }))}); process.exit(3);`,
      ),
      request: REQUEST,
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_FAILED');
    expect(run.verdict.detail).toMatch(/exited 3/);
    expect(run.exitCode).toBe(3);
  });

  it('THE EXIT CODE WINS over a valid body killed by a SIGNAL too', async () => {
    const run = await runner.runBondCheck({
      command: nodeStub(
        'signal-wins.mjs',
        `import { writeSync } from 'node:fs';
         writeSync(1, ${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['s'] }))});
         process.kill(process.pid, 'SIGKILL');`,
      ),
      request: REQUEST,
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_FAILED');
    // `/bin/sh` may report the signal death itself (137) or the signal; either
    // way it is NOT exit 0 and the body is never read as a pass.
    expect(run.exitCode === 0).toBe(false);
  });

  it('refuses an ok:true followed by 100 MB of whitespace — and kills the writer', async () => {
    const run = await runner.runBondCheck({
      command: nodeStub(
        'hundred-megabytes.mjs',
        `process.stdout.write(${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['s'] }))});
         for (let i = 0; i < 100; i += 1) process.stdout.write(' '.repeat(1024 * 1024));`,
      ),
      request: REQUEST,
      timeoutMs: 10_000,
    });
    expect(run.verdict.ok).toBe(false);
    // A DECISION, not a transport failure: the old path produced ENOBUFS →
    // BOND_CHECK_FAILED → retried three times against an 8 MiB stream.
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(run.verdict.detail).toMatch(/over the ceiling/);
  }, wd(60_000));
});

// ---------------------------------------------------------------------------
// 3. HANGS AND TIMEOUTS — the budget is a ceiling, not a suggestion
// ---------------------------------------------------------------------------

describe('hostile verifier — hangs and timeouts', () => {
  it('gives up on a command that never answers, and the process group is gone', async () => {
    const run = await runner.runBondCheck({
      command: shellStub('forever.sh', 'while :; do sleep 1; done\n'),
      request: REQUEST,
      timeoutMs: 200,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_TIMEOUT');
    expect(run.timedOut).toBe(true);
    // The gate does not leak the process it gave up on.
    expect(() => process.kill(run.pid as number, 0)).toThrow();
  }, wd(60_000));

  it('does not wait for a checker that IGNORES SIGTERM (the measured 600 ms → unbounded hole)', async () => {
    // The checker swallows SIGTERM and would write its file after 1 s. The old
    // `spawnSync` path waited for the process (measured: a 600 ms budget took
    // 5,006 ms) and, against a trapping loop, never returned at all — so this
    // test would hang before it ever reached the assertion.
    const fired = join(dir, 'stubborn-fired.txt');
    const run = await runner.runBondCheck({
      command: shellStub(
        'stubborn.sh',
        `trap '' TERM\nsleep 1\necho 'still here' > ${JSON.stringify(fired)}\nsleep 300\n`,
      ),
      request: REQUEST,
      timeoutMs: 200,
    });
    expect(run.verdict.code).toBe('BOND_CHECK_TIMEOUT');
    expect(run.timedOut).toBe(true);
    expect(['SIGTERM', 'SIGKILL']).toContain(run.signal);
    // The escalation SIGKILLed the group, so the file the checker was going to
    // write 1 s later never appears.
    expect(existsSync(fired)).toBe(false);
  }, wd(90_000));

  it('does not wait on a checker that CLOSES stdout and keeps running', async () => {
    const fired = join(dir, 'closed-stdout-fired.txt');
    const run = await runner.runBondCheck({
      command: shellStub(
        'closed-stdout.sh',
        `exec 1>&- 2>&-\nsleep 2\necho 'still here' > ${JSON.stringify(fired)}\nsleep 300\n`,
      ),
      request: REQUEST,
      timeoutMs: 200,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_TIMEOUT');
    // A closed stdout is not a verdict and not an exit: the gate waits for the
    // PROCESS, then kills the group (empty ⇒ nothing can write later).
    expect(() => process.kill(run.pid as number, 0)).toThrow();
    expect(existsSync(fired)).toBe(false);
  }, wd(90_000));

  it('keeps partial output out of the verdict when a checker writes 4 KiB then hangs', async () => {
    const run = await runner.runBondCheck({
      command: shellStub(
        'partial-then-hang.sh',
        `printf '%s' '${answer({ ok: true, proofRef: PROOF, sources: ['s'] }).slice(0, 40)}'\nsleep 300\n`,
      ),
      request: REQUEST,
      timeoutMs: 200,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_TIMEOUT');
    expect(run.verdict.proofRef).toBeNull();
  }, wd(60_000));

  it('kills a checker that leaves a backgrounded child behind after its verdict', async () => {
    const fired = join(dir, 'orphan-fired.txt');
    const run = await runner.runBondCheck({
      command: shellStub(
        'leaves-an-orphan.sh',
        `( sleep 1; echo alive > ${JSON.stringify(fired)} ) &\n`
          + `printf '%s' '${answer({ ok: true, proofRef: PROOF, sources: ['s'] })}'\nexit 0\n`,
      ),
      request: REQUEST,
      timeoutMs: 5_000,
    });
    // The answer is honest in shape; the point is what did NOT survive it. The
    // backgrounded writer would need 1 s to write, and the gate settled in
    // milliseconds with the group killed — so the file must never appear. (No
    // sleeping: a killed process cannot write later, and this assertion is
    // about what the gate did, not about how fast the box is.)
    expect(run.verdict.ok).toBe(true);
    expect(existsSync(fired)).toBe(false);
  }, wd(90_000));
});

// ---------------------------------------------------------------------------
// 4. INJECTION THROUGH THE REQUEST
// ---------------------------------------------------------------------------

describe('hostile verifier — injection through the request', () => {
  /**
   * Every payload that must NOT reach a shell unquoted. NONE contains a space:
   * the proofRef grammar (`[\x21-\x7e]{1,512}`) has no whitespace, so a
   * space-bearing payload is already unexpressible (asserted at the end of this
   * block) and an attacker has to work without one — which is exactly why the
   * quoting has to hold for `;`, `$(…)`, backticks and `>`.
   */
  const PAYLOADS: Array<[string, string]> = [
    ['command separator', `${PROOF};id>${join(tmpdir(), 'pwned-semicolon')}`],
    ['command substitution', `${PROOF}$(id>${join(tmpdir(), 'pwned-subshell')})`],
    ['backticks', `${PROOF}\`id>${join(tmpdir(), 'pwned-backtick')}\``],
    ['subshell', `${PROOF};id>${join(tmpdir(), 'pwned-paren')};:`],
    ['variable expansion', `${PROOF}$HOME`],
    ['redirect', `${PROOF}>${join(tmpdir(), 'pwned-redirect')}`],
    ['flag-looking value', '--bond-sats=0'],
    ['argument that looks like a rail', '--rail=onchain'],
  ];

  for (const [name, payload] of PAYLOADS) {
    it(`delivers ${name} as ONE inert argv word and executes nothing`, async () => {
      const receipt = join(dir, `receipt-${name.replace(/\W+/g, '-')}.json`);
      // The stub records the argv it ACTUALLY received and echoes the proof
      // back verbatim, so the assertion is about what reached the command.
      const command = nodeStub(
        `receipt-${name.replace(/\W+/g, '-')}.mjs`,
        `import { writeFileSync } from 'node:fs';
         const argv = process.argv.slice(2);
         writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(argv));
         const proof = argv.find((a) => a.startsWith('--proof='));
         process.stdout.write(JSON.stringify({
           ok: false,
           code: 'BOND_INJECTION_PROBE',
           proofRef: proof === undefined ? null : proof.slice(8),
           sources: [],
         }));`,
      );
      const run = await runner.runBondCheck({
        command,
        request: { ...REQUEST, proofRef: payload },
        timeoutMs: 5_000,
      });
      // The command ran exactly once, saw exactly five flags, and the payload is
      // one literal value — the shell never saw it as syntax.
      const argv = JSON.parse(readFileSync(receipt, 'utf8')) as string[];
      expect(argv).toHaveLength(5);
      expect(argv[2]).toBe(`--proof=${payload}`);
      expect(run.verdict.code).toBe('BOND_INJECTION_PROBE');
      // What the command saw is the payload, character for character.
      expect(run.verdict.proofRef).toBe(payload);
      // The receipt proves what reached the command; the filesystem proves what
      // did not happen around it.
      expect(existsSync(join(tmpdir(), 'pwned-semicolon'))).toBe(false);
      expect(existsSync(join(tmpdir(), 'pwned-subshell'))).toBe(false);
      expect(existsSync(join(tmpdir(), 'pwned-backtick'))).toBe(false);
      expect(existsSync(join(tmpdir(), 'pwned-paren'))).toBe(false);
      expect(existsSync(join(tmpdir(), 'pwned-redirect'))).toBe(false);
      // Nothing was written into the temp dir by the shell either.
      expect(readdirSync(dir).filter((f) => f.startsWith('pwned'))).toEqual([]);
    }, wd(60_000));
  }

  it('refuses a SPACE-bearing payload before the command is ever spawned (the grammar has no whitespace)', async () => {
    const ran = join(dir, 'space-ran.txt');
    const run = await runner.runBondCheck({
      command: nodeStub(
        'space.mjs',
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ran)}, 'ran');`,
      ),
      request: { ...REQUEST, proofRef: `${PROOF}; touch ${join(tmpdir(), 'pwned-space')}` },
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(join(tmpdir(), 'pwned-space'))).toBe(false);
  });

  it('refuses a proofRef with a NEWLINE before the command is ever spawned', async () => {
    const ran = join(dir, 'newline-ran.txt');
    const run = await runner.runBondCheck({
      command: nodeStub(
        'newline.mjs',
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ran)}, 'ran');`,
      ),
      request: { ...REQUEST, proofRef: `${PROOF}\ntouch ${join(tmpdir(), 'pwned-newline')}` },
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(run.verdict.detail).toMatch(/request cannot be expressed as inert argv/);
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(join(tmpdir(), 'pwned-newline'))).toBe(false);
  });

  it('refuses a --juror-pubkey that looks like a FLAG (argument injection)', async () => {
    // A leading `-` can never reach the command: the pubkey is 64 lowercase hex.
    expect(() => buildBondCheckArgs({ ...REQUEST, jurorPubkey: '--help' })).toThrow(/64 lowercase hex/);
    expect(() => buildBondCheckArgs({ ...REQUEST, jurorPubkey: `-${'a'.repeat(63)}` })).toThrow(/64 lowercase hex/);
    const ran = join(dir, 'flag-pubkey-ran.txt');
    const run = await runner.runBondCheck({
      command: nodeStub(
        'flag-pubkey.mjs',
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ran)}, 'ran');`,
      ),
      request: { ...REQUEST, jurorPubkey: '--help' },
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(existsSync(ran)).toBe(false);
  });

  it('refuses a 1 MB proofRef (two layers: the bond ref parser and the argv builder)', async () => {
    const huge = 'a'.repeat(1024 * 1024);
    expect(() => parseCourtBondRef({ ...REQUEST, proofRef: huge })).toThrow(/at most 512/);
    expect(() => buildBondCheckArgs({ ...REQUEST, proofRef: huge })).toThrow(/proofRef/);
    const ran = join(dir, 'huge-proof-ran.txt');
    const run = await runner.runBondCheck({
      command: nodeStub(
        'huge-proof.mjs',
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ran)}, 'ran');`,
      ),
      request: { ...REQUEST, proofRef: huge },
      timeoutMs: 5_000,
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    // Not executed, and not a harness crash.
    expect(existsSync(ran)).toBe(false);
  });

  it('quotes a single quote in the value without escaping out of it', () => {
    expect(runner.shQuote(`it's`)).toBe(`'it'\\''s'`);
    const quoted = runner.shQuote(`a'; touch ${join(tmpdir(), 'pwned-quote')}; echo '`);
    const probe = spawnSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
    expect(probe.stdout).toBe(`a'; touch ${join(tmpdir(), 'pwned-quote')}; echo '`);
    expect(existsSync(join(tmpdir(), 'pwned-quote'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. ENVIRONMENT LEAKAGE — the checker is not handed the ceremony's secrets
// ---------------------------------------------------------------------------

describe('hostile verifier — environment leakage', () => {
  it('passes an ALLOWLIST, never the parent environment', async () => {
    const childEnv = join(dir, 'child-env.json');
    const command = nodeStub(
      'dump-env.mjs',
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(childEnv)}, JSON.stringify(process.env));
       process.stdout.write(${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['s'] }))});`,
    );
    const env = runner.bondCheckEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/root',
      LANG: 'C.UTF-8',
      BAO_COURT_BOND_CHECK_CMD: 'the gate itself',
      BAO_COURT_RELAY_TOKEN: 'relay-token',
      BAO_COURT_NOSTR_PRIVKEY: 'privkey',
      MNEMONIC: 'twelve words',
      SMJ_ORACLE_PRIVKEY: 'key',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
    expect(runner.BOND_CHECK_ENV_ALLOWLIST).not.toContain('BAO_COURT_BOND_CHECK_CMD');

    const run = await runner.runBondCheck({ command, request: REQUEST, timeoutMs: 5_000, env });
    expect(run.verdict.ok).toBe(true);
    const seen = JSON.parse(readFileSync(childEnv, 'utf8')) as Record<string, string>;
    for (const key of Object.keys(seen)) {
      expect(key).not.toMatch(/BAO_COURT|MNEMONIC|PRIVKEY|SECRET|TOKEN|KEY|PASS/i);
    }
    expect(seen.PATH).toBe('/usr/bin:/bin');
    // Nothing that looks like ceremony key material reached the checker.
    const values = Object.values(seen).join('\n');
    expect(values).not.toMatch(/privkey|twelve words|relay-token|aws/i);
  }, wd(60_000));

  it('passes EXTRA variables only when the operator names them', async () => {
    const env = runner.bondCheckEnv({
      PATH: '/bin',
      BAO_LIQUID_ESPLORA: 'https://example.invalid',
      BAO_COURT_BOND_CHECK_ENV: 'BAO_LIQUID_ESPLORA, NOT_SET',
      BAO_COURT_RELAY_TOKEN: 'still secret',
    });
    expect(env.BAO_LIQUID_ESPLORA).toBe('https://example.invalid');
    expect(env).not.toHaveProperty('NOT_SET');
    expect(env).not.toHaveProperty('BAO_COURT_RELAY_TOKEN');
    expect(runner.BOND_CHECK_ENV_PASSTHROUGH).toBe('BAO_COURT_BOND_CHECK_ENV');
  });

  it('does not leak the check COMMAND LINE (with whatever the operator put in it)', async () => {
    // The command line can carry a token (`--rpc-token=…`); the child's own
    // environment must not carry a second copy of it.
    const env = runner.bondCheckEnv({ PATH: '/bin', BAO_COURT_BOND_CHECK_CMD: 'verify --rpc-token=abc123' });
    expect(JSON.stringify(env)).not.toContain('abc123');
  });
});

// ---------------------------------------------------------------------------
// 6. ORDERING / REPLAY — one bond, one seat, one answer
// ---------------------------------------------------------------------------

describe('hostile verifier — ordering and replay', () => {
  const liquid = parseCourtBondRef(REQUEST);

  it('re-verifies ONE BOND, ONE SEAT when the hostile command says ok:true for both seats', async () => {
    // A hostile checker happily "proves" the same outpoint twice — that is
    // exactly the behaviour the gate must not trust.
    const command = nodeStub(
      'always-ok.mjs',
      `process.stdout.write(${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['blockstream'] }))});`,
    );
    const first = await runner.runBondCheck({ command, request: REQUEST, timeoutMs: 5_000 });
    const second = await runner.runBondCheck({ command, request: REQUEST, timeoutMs: 5_000 });
    expect(first.verdict.ok).toBe(true);
    expect(second.verdict.ok).toBe(true);

    const jurors: JurorBondClaim[] = [
      { idx: 1, pubkey: 'a'.repeat(64), bond: liquid },
      { idx: 2, pubkey: 'b'.repeat(64), bond: liquid },
    ];
    const gate = gateRosterOnBonds({
      jurors,
      threshold: 2,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, first.verdict],
        [2, second.verdict],
      ]),
    });
    expect(gate.admitted.map((v) => v.idx)).toEqual([1]);
    expect(gate.excluded[0]?.refusal).toBe('BOND_REUSED_ACROSS_SEATS');
    expect(gate.excluded[0]?.duplicateOf).toBe(1);
    expect(gate.classification).toBe('ROSTER_BELOW_THRESHOLD');
    expect(gate.ok).toBe(false);
  }, wd(60_000));

  it('re-verifies the duplicate rule for a RAIL/network change (same outpoint, different identity)', () => {
    const other = parseCourtBondRef({ rail: 'onchain', network: 'testnet', proofRef: PROOF });
    expect(bondIdentity(other)).not.toBe(bondIdentity(liquid));
  });

  it('does not re-ask a DECISION: a typed refusal is called exactly once', async () => {
    const calls = join(dir, 'decision-calls.txt');
    const command = nodeStub(
      'decision.mjs',
      `import { appendFileSync } from 'node:fs';
       appendFileSync(${JSON.stringify(calls)}, 'x');
       process.stdout.write(${JSON.stringify(answer({ ok: false, code: 'BOND_SPENT', detail: 'spent' }))});
       process.exit(1);`,
    );
    const run = await runner.runBondCheckWithRetry({
      command,
      request: REQUEST,
      timeoutMs: 5_000,
      attempts: 3,
      backoffMs: 0,
      sleep: async () => {},
    });
    expect(run.verdict.ok).toBe(false);
    expect(run.verdict.code).toBe('BOND_SPENT');
    expect(run.attempts).toBe(1);
    expect(readFileSync(calls, 'utf8')).toHaveLength(1);
  }, wd(60_000));

  it('does not re-ask a MALFORMED answer either (junk is a decision in v0.17)', async () => {
    const calls = join(dir, 'malformed-calls.txt');
    const command = nodeStub(
      'malformed.mjs',
      `import { appendFileSync } from 'node:fs';
       appendFileSync(${JSON.stringify(calls)}, 'x');
       process.stdout.write('not json');`,
    );
    const run = await runner.runBondCheckWithRetry({
      command,
      request: REQUEST,
      timeoutMs: 5_000,
      attempts: 3,
      backoffMs: 0,
      sleep: async () => {},
    });
    expect(run.verdict.code).toBe('BOND_CHECK_MALFORMED');
    expect(run.attempts).toBe(1);
    expect(readFileSync(calls, 'utf8')).toHaveLength(1);
  }, wd(60_000));

  it('re-asks ONLY a transient failure — and a checker that says ok:true on the second call is admitted with attempts:2', async () => {
    const counter = join(dir, 'transient-count.txt');
    const command = nodeStub(
      'transient.mjs',
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
       const path = ${JSON.stringify(counter)};
       const n = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
       writeFileSync(path, String(n + 1));
       if (n === 0) {
         process.stdout.write(JSON.stringify({ ok: false, code: 'BOND_UNVERIFIABLE', detail: 'explorer timed out' }));
         process.exit(1);
       }
       process.stdout.write(${JSON.stringify(answer({ ok: true, proofRef: PROOF, sources: ['blockstream'] }))});`,
    );
    const run = await runner.runBondCheckWithRetry({
      command,
      request: REQUEST,
      timeoutMs: 5_000,
      attempts: 3,
      backoffMs: 0,
      sleep: async () => {},
    });
    expect(run.verdict.ok).toBe(true);
    expect(run.attempts).toBe(2);
    expect(run.history.map((h) => h.code)).toEqual(['BOND_UNVERIFIABLE', null]);
    expect(readFileSync(counter, 'utf8')).toBe('2');
  }, wd(60_000));

  it('treats a bond identity case-insensitively (a re-typed txid is the same collateral)', () => {
    const upper = parseCourtBondRef({ ...REQUEST, proofRef: PROOF.toUpperCase() });
    expect(bondIdentity(upper)).toBe(bondIdentity(liquid));
  });
});
