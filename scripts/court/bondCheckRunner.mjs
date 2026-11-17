// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE BOND-CHECK RUNNER — the half of the bond gate that touches a process.
 *
 * `bondCheckGate.ts` decides what a verdict MEANS and is browser-safe on
 * purpose; this module is the Node side and lives with the harness because it
 * owns `spawn`. It exists as its own file so the hostile-verifier tests
 * (`__tests__/bondGateHostile.test.ts`) exercise the SAME code the ceremony
 * runs, rather than a copy of it.
 *
 * ─── THE THREAT MODEL, IN ONE SENTENCE ────────────────────────────────────
 * The checker is UNTRUSTED: `BAO_COURT_BOND_CHECK_CMD` is a command line an
 * operator pastes into an environment, and the thing it protects against is a
 * checker that lies (prints `ok:true` for a bond nobody paid), cheats (parses
 * the request and answers a different question), leaks (reads the ceremony's
 * environment), or refuses to stop (hangs, or leaves a daemon behind). Every
 * decision below is made in the GATE, never in the command — so the runner's
 * job is to make the command's observable behaviour a bounded, honest
 * transport: exact argv, no shell execution of values, a bounded amount of
 * output, a bounded lifetime, no inherited secrets, and a process group that
 * dies with the gate's verdict.
 *
 * ─── WHAT THE RUNNER GUARANTEES (each is tested) ──────────────────────────
 *  1. ARGV, NOT A SHELL STRING. Every value is single-quoted (`shQuote`) for
 *     the `/bin/sh -c` we must use (the command itself is a command LINE, with
 *     pipes and `cd` in it), so a `proofRef` of `x; touch pwned` or
 *     `$(id)` reaches the checker as ONE literal argument and executes nothing.
 *     Values are additionally validated upstream (`buildBondCheckArgs`): rails
 *     and networks are enumerations, the pubkey is 64 lowercase hex (so it can
 *     never start with `-`), the proofRef is 1..512 non-space printable ASCII.
 *     A request that cannot be made inert is REFUSED (typed), never run.
 *  2. A BOUNDED LIFETIME. `timeoutMs` is a hard ceiling. The child runs in its
 *     OWN PROCESS GROUP (`detached`), so the gate signals the GROUP: SIGTERM at
 *     the deadline, SIGKILL after `killGraceMs`, and the promise settles
 *     WITHOUT waiting for a SIGTERM-ignoring child (`spawnSync`'s timeout only
 *     kills the direct child and then waits for stdout to close — measured:
 *     a 600 ms budget took 5,006 ms, and unbounded with an endless trap).
 *  3. NO ORPHANS. When the child exits, whatever it left running in its group
 *     is killed too — a checker that backgrounds work (`( sleep 30; … ) &`)
 *     cannot keep acting after its verdict, and a timed-out check cannot keep
 *     scanning. (Measured before the fix: the backgrounded grandchild survived
 *     and wrote its file seconds after the gate had returned.)
 *  4. BOUNDED OUTPUT, BOTH STREAMS. stdout is capped at
 *     `BOND_CHECK_MAX_OUTPUT_BYTES` (8 MiB) and the cap is a REFUSAL, not a
 *     transport error: over the ceiling the group is killed and the answer is
 *     `BOND_CHECK_MALFORMED`, which is a decision (never retried). stderr is
 *     captured separately with its own tail cap and is NEVER parsed as an
 *     answer — a verdict printed on stderr is not a verdict.
 *  5. NO AMBIENT SECRETS. The child gets a scrubbed environment (an allowlist,
 *     not a blocklist): PATH/HOME/TMPDIR/locale/TZ/SSH_AUTH_SOCK plus whatever
 *     the operator names in `BAO_COURT_BOND_CHECK_ENV`. The ceremony's own
 *     variables (`BAO_COURT_*`, relay tokens, juror key material in the
 *     coordinator's environment) are not passed. This is defence against
 *     ACCIDENTAL leakage (`env` in a log, a crash dump, a child of the
 *     checker), not a sandbox: the command still runs as the operator and can
 *     read the filesystem. See docs/BOND_GATE_THREAT_MODEL.md §"Residual".
 *  6. THE EXIT CODE WINS. A body that says `ok:true` from a non-zero exit (or
 *     from a signal-killed process) is `BOND_CHECK_FAILED`.
 *
 * Retries are here too (`runBondCheckWithRetry`) because "was this called
 * twice?" is part of the threat model: a TRANSIENT failure may be re-asked, a
 * DECISION may not.
 */

import { spawn } from 'node:child_process';

import {
  BOND_CHECK_MAX_OUTPUT_BYTES,
  buildBondCheckArgs,
  parseBondCheckOutput,
} from '../../bondCheckGate';

/** Operator escape hatch: extra variable NAMES to pass to the checker. */
export const BOND_CHECK_ENV_PASSTHROUGH = 'BAO_COURT_BOND_CHECK_ENV';

/**
 * The ONLY variables a checker inherits. Everything else is dropped, including
 * every `BAO_COURT_*` (so the gate cannot leak its own wiring) and every
 * ambient secret (relay tokens, NIP-46 material, `*_PRIVKEY`, …).
 *
 * `SSH_AUTH_SOCK` is included because the shipped host verifier reaches its
 * first-party node over ssh; it is a socket PATH, not a secret, and the
 * command already runs with the operator's filesystem access — dropping it
 * would break the real deployment without buying anything.
 */
export const BOND_CHECK_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSH_AUTH_SOCK',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

/** stderr kept for the artifact (a tail — a hostile checker must not fill it). */
export const BOND_CHECK_MAX_STDERR_BYTES = 8 * 1024;

/** Default SIGTERM→SIGKILL grace after the deadline. */
export const BOND_CHECK_KILL_GRACE_MS = 250;

/**
 * Single-quote a value for `/bin/sh`. A value can therefore never add a flag,
 * start a command, expand a variable or span a newline — the shell sees exactly
 * one word.
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The environment the checker runs with: the allowlist above, plus the names
 * the operator listed in `BAO_COURT_BOND_CHECK_ENV` (comma-separated). Names,
 * never values — the value still comes from the coordinator's environment, so a
 * host that needs its own RPC credential passes `BAO_LIQUID_ESPLORA_URL`, and
 * the ceremony's secrets stay home unless the operator deliberately names one.
 */
export function bondCheckEnv(source = process.env) {
  const env = {};
  const passthrough = String(source[BOND_CHECK_ENV_PASSTHROUGH] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of [...BOND_CHECK_ENV_ALLOWLIST, ...passthrough]) {
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: already gone. The gate's verdict does not depend on the corpse.
  }
}

/**
 * Run the operator's bond-check command for ONE request.
 *
 * Never throws: every failure mode — unquotable request, spawn error, timeout,
 * output over the ceiling, contradiction between exit code and body, junk —
 * becomes a typed `BondCheckVerdict` that the gate can decide on.
 */
export async function runBondCheck(options) {
  const {
    command,
    request,
    timeoutMs = 60_000,
    killGraceMs = BOND_CHECK_KILL_GRACE_MS,
    env = bondCheckEnv(),
    maxOutputBytes = BOND_CHECK_MAX_OUTPUT_BYTES,
    maxStderrBytes = BOND_CHECK_MAX_STDERR_BYTES,
  } = options;
  const started = Date.now();
  const finish = (fields) => ({
    elapsedMs: Date.now() - started,
    exitCode: null,
    signal: null,
    stderr: '',
    timedOut: false,
    pid: null,
    ...fields,
  });

  let argv;
  try {
    argv = buildBondCheckArgs(request);
  } catch (error) {
    // The request itself is the attacker's surface (a hostile roster entry, a
    // 1 MiB proofRef, a pubkey that looks like a flag). Refuse it — never run
    // it — and never let a validation error escape as a harness crash.
    return finish({
      verdict: {
        ok: false,
        code: 'BOND_CHECK_MALFORMED',
        detail: `the bond check request cannot be expressed as inert argv: ${error instanceof Error ? error.message : String(error)}`,
        proofRef: null,
        sources: [],
      },
    });
  }

  const argvLine = argv.map(shQuote).join(' ');
  const child = spawn('/bin/sh', ['-c', `${command} ${argvLine}`], {
    detached: true, // its own process group: the gate can signal the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stderrText = '';
  let overCap = false;
  let timedOut = false;
  let settled = false;
  let sigkillTimer = null;
  let timeoutTimer = null;

  const pid = child.pid ?? null;

  return await new Promise((resolve) => {
    const settle = (fields) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      // Whatever the child left behind dies with the verdict. This is what
      // stops a backgrounded daemon from outliving its own check.
      killGroup(pid, 'SIGKILL');
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.removeAllListeners();
      resolve(finish({ pid, ...fields }));
    };

    const onTimeout = () => {
      timedOut = true;
      killGroup(pid, 'SIGTERM');
      sigkillTimer = setTimeout(() => {
        killGroup(pid, 'SIGKILL');
        // Do NOT wait for 'close': a SIGTERM-ignoring checker would otherwise
        // hold the ceremony hostage for as long as it likes.
        settle({
          verdict: {
            ok: false,
            code: 'BOND_CHECK_TIMEOUT',
            detail: `the bond check did not answer within ${timeoutMs} ms`,
            proofRef: null,
            sources: [],
          },
          timedOut: true,
          signal: 'SIGKILL',
          stderr: stderrText,
        });
      }, killGraceMs);
    };

    const overCapVerdict = () => ({
      ok: false,
      code: 'BOND_CHECK_MALFORMED',
      detail: `the bond check printed more than ${maxOutputBytes} bytes, over the ceiling`
        + ' (the gate refuses an unbounded answer before parsing it)',
      proofRef: null,
      sources: [],
    });

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        // Over the ceiling is a DECISION, not a transport failure: kill the
        // group and refuse at once instead of buffering the rest of an
        // unbounded stream (the old path produced ENOBUFS → a transient
        // BOND_CHECK_FAILED that was then retried three times).
        overCap = true;
        killGroup(pid, 'SIGKILL');
        settle({
          verdict: overCapVerdict(),
          timedOut,
          signal: 'SIGKILL',
          stderr: stderrText,
          outputBytes: stdoutBytes,
        });
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk) => {
      // Keep a bounded TAIL: the end of a stack trace is the useful part.
      stderrText = (stderrText + chunk.toString('utf8')).slice(-maxStderrBytes);
    });

    child.on('error', (error) => {
      settle({
        verdict: {
          ok: false,
          code: 'BOND_CHECK_FAILED',
          detail: `the bond check could not be run: ${error.message}`,
          proofRef: null,
          sources: [],
        },
        stderr: stderrText,
      });
    });

    /**
     * THE GROUP DIES WITH THE PROCESS, not with the pipe. Node's `close` fires
     * when stdio closes — so a checker that backgrounds a child inheriting
     * stdout keeps the gate waiting on the PIPE until that child finishes
     * (measured: a 1 s backgrounded writer held a 5 s budget open and wrote its
     * file). Killing the group the moment the direct child exits closes the
     * pipe immediately, so `close` carries the whole answer and no survivor
     * gets the extra second.
     */
    child.on('exit', () => {
      killGroup(pid, 'SIGKILL');
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (timedOut) {
        settle({
          verdict: {
            ok: false,
            code: 'BOND_CHECK_TIMEOUT',
            detail: `the bond check did not answer within ${timeoutMs} ms`,
            proofRef: null,
            sources: [],
          },
          timedOut: true,
          exitCode: code,
          signal: signal ?? 'SIGTERM',
          stderr: stderrText,
          outputBytes: stdoutBytes,
        });
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const verdict = parseBondCheckOutput(stdout, request);
      if (verdict.ok && code !== 0) {
        // THE EXIT CODE WINS: a contradiction is never a pass. `code === null`
        // means the process was signalled — also not a pass.
        const tail = stderrText.trim().slice(0, 300);
        settle({
          verdict: {
            ok: false,
            code: 'BOND_CHECK_FAILED',
            detail: `the bond check exited ${code === null ? `on ${signal ?? 'a signal'}` : code}`
              + ` but claimed success${tail ? ` — ${tail}` : ''}`,
            proofRef: verdict.proofRef,
            sources: verdict.sources,
          },
          exitCode: code,
          signal: signal ?? null,
          stderr: stderrText,
          outputBytes: stdoutBytes,
        });
        return;
      }
      if (!verdict.ok && verdict.code === 'BOND_CHECK_MALFORMED') {
        const tail = stderrText.trim().slice(0, 300);
        if (tail) verdict.detail = `${verdict.detail ?? 'malformed output'} — ${tail}`;
      }
      settle({
        verdict,
        exitCode: code,
        signal: signal ?? null,
        stderr: stderrText,
        outputBytes: stdoutBytes,
      });
    });

    timeoutTimer = setTimeout(onTimeout, Math.max(1, Number(timeoutMs) || 1));
  });
}

/**
 * Which verdicts may be RETRIED? Only the ones that mean "the check could not
 * look" — never a decision. Retrying a transport failure can only give the
 * check another chance to succeed, so fail-closed is preserved; retrying
 * `BOND_SPENT` or a `BOND_PROOF_MISMATCH` would re-ask a question that has
 * already been answered.
 */
export const BOND_TRANSIENT_CODES = Object.freeze([
  'BOND_CHECK_FAILED',
  'BOND_CHECK_TIMEOUT',
  'BOND_UNVERIFIABLE',
]);

/** `runBondCheck` with the bounded retry, and the attempt history recorded. */
export async function runBondCheckWithRetry(options) {
  const { request, attempts = 3, backoffMs = 200, sleep } = options;
  const nap = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const history = [];
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await runBondCheck(options);
    history.push({
      attempt,
      ok: last.verdict.ok,
      code: last.verdict.code,
      elapsedMs: last.elapsedMs,
    });
    if (last.verdict.ok) break;
    if (!BOND_TRANSIENT_CODES.includes(String(last.verdict.code))) break; // a DECISION
    if (attempt === attempts) break;
    await nap(backoffMs * 3 ** (attempt - 1));
  }
  return { ...last, attempts: history.length, history };
}
