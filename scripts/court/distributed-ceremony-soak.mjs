// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `distributed-ceremony-soak` — the distributed ceremony, unattended, on a timer.
 *
 * One distributed ceremony is evidence; a hundred hours of them is a program.
 * This runner performs exactly the run `distributed-ceremony.mjs` performs (relay
 * on one box, one juror per box, coordinator local), but:
 *
 *   - it ROTATES scenarios per invocation — `happy-k2`, `happy-kn` (all-of-N),
 *     `kill` (SIGKILL a juror mid-signing over ssh), `replay` and `reorder`
 *     (Byzantine DELIVERY policies: the relay repeats or re-orders records, it
 *     can never forge one), plus `silence` when explicitly enabled;
 *   - it writes ONE JSONL record per run, with public material only:
 *       {ts, scenario, k, n, outcome, groupKeyFingerprint, signatureVerified,
 *        durationMs, perBoxWallMs, relayRttP50, classification, evidencePath}
 *   - it PREFLIGHTS the boxes (reachable? Node present?) and records a
 *     `blocked` outcome — with the reason — instead of hanging if one is down;
 *   - it CLEANS UP before and after: strays from an aborted run are killed by
 *     their exact command line (never `pkill -u`), the run dirs on the boxes are
 *     removed, no relay is left listening;
 *   - it accounts for BOOT GAPS: a reboot (or a long elapse) is recorded as a
 *     `gap` record, not as a failure — the program is measuring the ceremony,
 *     not uptime.
 *
 * The cadence, the timer and the control verbs live in
 * `scripts/court/ceremony-soakctl.sh` + `scripts/court/systemd/`.
 *
 * Usage:
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs run
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs run --scenario=kill
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs status
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs report --last=20
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs preflight
 *
 * State lives in `--state-dir` (default `~/.local/state/bao-court-ceremony-soak`):
 *   records.jsonl        one line per run / gap / block (append-only)
 *   state.json           rotation cursor, last run, last boot id, pause flag
 *   runs/<runId>/        the driver's evidence for that run (rolling cap)
 *   lock                 flock target (the systemd unit wraps the run in `flock -n`)
 *
 * NEVER written here: secret keys, seeds, nonces, bearer tokens. The record
 * carries a group-key FINGERPRINT (public), never key material.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DRIVER = join(HERE, 'distributed-ceremony.mjs');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const VERBS = ['run', 'status', 'report', 'preflight', 'next'];
const verb = process.argv[2] && VERBS.includes(process.argv[2]) ? process.argv[2] : 'run';

const stateDir = arg(
  'state-dir',
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'bao-court-ceremony-soak'),
);
const boxes = arg('boxes', 'vps16gb,bao8gb,bao-testnet').split(',').map((b) => b.trim()).filter(Boolean);
const relayBox = arg('relay-box', 'vps16gb');
const port = Number(arg('port', '18471'));
const intervalHours = Number(arg('interval-hours', '6'));
/** Whole-run hard budget. The systemd unit also bounds it; this is the inner bound. */
const deadlineMs = Number(arg('deadline-ms', '300000'));
const keepRuns = Number(arg('keep-runs', '120'));
const forcedScenario = arg('scenario', undefined);
const withSilence = flag('with-silence');
const sshDir = arg('ssh-dir', '/tmp/opencode/bao-dist-ssh');

const RECORDS = join(stateDir, 'records.jsonl');
const STATE = join(stateDir, 'state.json');
const RUNS = join(stateDir, 'runs');
const PAUSE = join(stateDir, 'PAUSED');

if (flag('help')) {
  console.log(`distributed-ceremony-soak — verbs: ${VERBS.join(', ')}
  --state-dir=  --boxes=  --relay-box=  --port=  --interval-hours=6
  --deadline-ms=300000  --keep-runs=120  --scenario=  --with-silence  --json`);
  process.exit(0);
}

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(RUNS, { recursive: true, mode: 0o700 });
mkdirSync(sshDir, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// Scenario rotation
// ---------------------------------------------------------------------------

/**
 * The rotation. Honest runs are the baseline rate; the fault runs are why the
 * baseline means anything. `kill` is why "100% verified" is checked separately
 * from "0% for kill-mid-signing" — a program that only ever reported success
 * would be measuring nothing.
 */
const ROTATION = [
  { name: 'happy-k2', args: ['--scenario=happy-k2', '--threshold=2'], k: 2, expectSignature: true },
  { name: 'happy-kn', args: ['--scenario=happy-kn'], k: null, expectSignature: true },
  { name: 'kill', args: ['--scenario=kill', '--threshold=3'], k: 3, expectSignature: false },
  { name: 'replay', args: ['--scenario=replay', '--relay-mode=replay'], k: 2, expectSignature: true },
  { name: 'reorder', args: ['--scenario=reorder', '--relay-mode=reorder'], k: 2, expectSignature: true },
];
if (withSilence) {
  ROTATION.push({ name: 'silence', args: ['--scenario=silence', '--relay-mode=silence'], k: 2, expectSignature: false });
}

function loadState() {
  const fresh = {
    version: 1,
    nextIndex: 0,
    lastRunTs: null,
    lastBootId: null,
    lastScenario: null,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
  };
  if (!existsSync(STATE)) return fresh;
  try {
    return { ...fresh, ...JSON.parse(readFileSync(STATE, 'utf8')) };
  } catch {
    return fresh;
  }
}
function saveState(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
}
function readRecords() {
  if (!existsSync(RECORDS)) return [];
  return readFileSync(RECORDS, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
function record(entry) {
  appendFileSync(RECORDS, JSON.stringify(entry) + '\n');
  return entry;
}

// ---------------------------------------------------------------------------
// Box helpers (ssh, no secrets)
// ---------------------------------------------------------------------------

const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=12',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${sshDir}/%r@%h:%p`,
  '-o', 'ControlPersist=120',
  '-o', 'LogLevel=ERROR',
];
function ssh(box, command, { timeout = 60000 } = {}) {
  const r = spawnSync('ssh', [...SSH_OPTS, box, command], {
    encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
/** bao-testnet has no system Node: the distributed run installed a static one. */
function nodeFor(box) {
  return box === 'bao-testnet' ? '/opt/bao-court-node/bin/node' : '/usr/bin/node';
}

/**
 * Reachability + Node, per box. Anything short of a working `node -v` is a
 * `blocked` reason: a soak that silently ran with two jurors would be reporting
 * on a topology it did not use.
 */
function preflight() {
  const results = [];
  for (const box of [...new Set([...boxes, relayBox])]) {
    const node = nodeFor(box);
    const r = ssh(box, `hostname; ${node} -v 2>&1 | head -1; nproc`, { timeout: 20000 });
    if (r.status !== 0) {
      results.push({ box, ok: false, reason: `ssh failed (status ${r.status}): ${(r.stderr || '').trim().slice(0, 120)}` });
      continue;
    }
    const [host, nodeVersion, cores] = r.stdout.trim().split('\n');
    const version = String(nodeVersion ?? '').trim();
    if (!/^v\d+\.\d+\.\d+/.test(version)) {
      results.push({ box, ok: false, reason: `Node missing or unreadable at ${node}: "${version}"`, hostname: host });
      continue;
    }
    results.push({ box, ok: true, hostname: host, nodeVersion: version, cores: Number(cores) });
  }
  return results;
}

/**
 * Kill strays from an ABORTED run, by EXACT command line.
 *
 * Never `pkill -u` and never a bare pattern that matches its own shell: the
 * dots are bracketed so the pattern text in this very command line does not
 * match the regex it describes. Only paths this program creates are touched.
 */
function cleanStrays() {
  const notes = [];
  for (const box of [...new Set([...boxes, relayBox])]) {
    const r = ssh(
      box,
      'pkill -f "bao-court-dist/.*juror[.]mjs" >/dev/null 2>&1; '
      + `pkill -f "relay-server[.]mjs --port=${port}" >/dev/null 2>&1; `
      + 'sleep 0.2; rm -rf /tmp/bao-court-dist; '
      + `left=$(pgrep -af "bao-court-dist/.*juror[.]mjs|relay-server[.]mjs --port=${port}" | grep -v pgrep | grep -cv "bash -c"); `
      + `listen=$(ss -lnt 2>/dev/null | grep -c ":${port} "); echo "left=$left listen=$listen"`,
      { timeout: 30000 },
    );
    notes.push({ box, ...(r.status === 0 ? parseKv(r.stdout) : { left: null, listen: null }) });
  }
  // Local scratch from the driver (contains that run's bearer token).
  rmSync('/tmp/opencode/bao-court-dist', { recursive: true, force: true });
  return notes;
}
function parseKv(text) {
  const out = {};
  for (const token of text.trim().split(/\s+/)) {
    const [k, v] = token.split('=');
    if (k) out[k] = v === undefined ? true : Number(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boot-gap accounting
// ---------------------------------------------------------------------------

function bootId() {
  // Linux: a fresh boot ⇒ a different id. On a platform without it, fall back
  // to uptime bucketing so a reboot still shows up as a gap rather than a lie.
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { /* fall through */ }
  try {
    const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return `uptime:${Math.floor(Date.now() / 1000 - up)}`;
  } catch {
    return 'unknown';
  }
}

/**
 * A reboot, or an elapse much longer than the cadence, is recorded as a `gap`
 * — the program was not observing, and saying so is more honest than either a
 * failure or a silent hole in the series.
 */
function gapReason(state) {
  const currentBoot = bootId();
  const reasons = [];
  if (state.lastBootId && currentBoot !== 'unknown' && state.lastBootId !== currentBoot) {
    reasons.push('boot-id changed (the coordinator rebooted)');
  }
  if (state.lastRunTs) {
    const elapsed = Date.now() - state.lastRunTs;
    const cadenceMs = intervalHours * 3600_000;
    if (elapsed > cadenceMs * 2.5) {
      reasons.push(`no invocation for ${(elapsed / 3600_000).toFixed(1)} h (cadence ${intervalHours} h)`);
    }
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}

// ---------------------------------------------------------------------------
// Artifact cap
// ---------------------------------------------------------------------------

function pruneRuns() {
  const dirs = readdirSync(RUNS)
    .map((name) => ({ name, path: join(RUNS, name), mtime: statSync(join(RUNS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const excess = dirs.slice(keepRuns);
  for (const dir of excess) rmSync(dir.path, { recursive: true, force: true });
  return excess.length;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

const SCENARIO = forcedScenario
  ? (ROTATION.find((s) => s.name === forcedScenario) ?? { name: forcedScenario, args: [`--scenario=${forcedScenario}`], k: null })
  : null;

function pickScenario(state) {
  if (SCENARIO) return SCENARIO;
  const idx = Number(state.nextIndex ?? 0) % ROTATION.length;
  return { ...ROTATION[idx], index: idx };
}

/** Median of the per-box publish-RTT p50s: one honest "RTT for this run". */
function relayRttP50(perBox) {
  const values = perBox.map((b) => b?.timings?.publish?.p50).filter((v) => typeof v === 'number');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Number(median.toFixed(2));
}

function runOne({ state, scenario, boot, gap }) {
  const startedAt = Date.now();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${scenario.name}-${randomBytes(3).toString('hex')}`;
  const evidenceDir = join(RUNS, runId);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

  const pre = preflight();
  const down = pre.filter((p) => !p.ok);
  if (down.length > 0) {
    const entry = {
      ts: new Date().toISOString(),
      scenario: scenario.name,
      k: scenario.k,
      n: boxes.length,
      outcome: 'blocked',
      groupKeyFingerprint: null,
      signatureVerified: false,
      durationMs: Date.now() - startedAt,
      perBoxWallMs: [],
      relayRttP50: null,
      classification: `BLOCKED: ${down.map((d) => `${d.box}: ${d.reason}`).join(' | ')}`.slice(0, 300),
      evidencePath: null,
      boxes: pre,
      gap: gap ?? null,
    };
    record({ ...entry, boot });
    console.log(`blocked: ${entry.classification}`);
    return { entry, code: 0 };
  }

  const strays = cleanStrays();
  const args = [
    '--import', 'tsx', DRIVER,
    `--boxes=${boxes.join(',')}`,
    `--relay-box=${relayBox}`,
    `--port=${port}`,
    `--jurors=${boxes.length}`,
    `--artifacts=${evidenceDir}`,
    ...scenario.args,
  ];
  console.log(`run ${scenario.name}: node ${args.slice(2).join(' ')}`);

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: deadlineMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: REPO,
    env: { ...process.env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(join(evidenceDir, 'driver.log'), stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''));

  // Whatever happened, do not leave the boxes dirty.
  const after = cleanStrays();
  const pruned = pruneRuns();

  const summaryPath = readdirSync(evidenceDir).find((f) => f.endsWith('-summary.json'));
  let summary = null;
  if (summaryPath) {
    try { summary = JSON.parse(readFileSync(join(evidenceDir, summaryPath), 'utf8')); } catch { summary = null; }
  }
  const run = summary?.runs?.[0] ?? null;
  const timedOut = result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT';

  const perBoxWallMs = (run?.perBox ?? []).map((b) => b.wallMsOnBox ?? null);
  const classifications = (run?.classifications ?? []).map((c) => c.classification).filter(Boolean);
  const signatureVerified = Boolean(run?.signatureVerified);
  const ok = Boolean(summary?.ok) && result.status === 0;

  let outcome = 'fail';
  if (timedOut) outcome = 'timeout';
  else if (ok) outcome = 'pass';

  const entry = {
    ts: new Date().toISOString(),
    scenario: scenario.name,
    k: run?.threshold ?? scenario.k,
    n: boxes.length,
    outcome,
    // PUBLIC only: a hash-prefixed fingerprint of the group key, never the key's
    // secret material (there is none) and never a share, seed or nonce.
    groupKeyFingerprint: run?.groupKeyFingerprint ?? (run?.groupKey ? `x-only(${String(run.groupKey).slice(0, 8)}…)` : null),
    signatureVerified,
    durationMs: Date.now() - startedAt,
    perBoxWallMs,
    relayRttP50: relayRttP50(run?.perBox ?? []),
    classification: classifications.length > 0
      ? (new Set(classifications).size === 1 ? classifications[0] : classifications.join('+'))
      : (timedOut ? 'DEADLINE_EXCEEDED' : (ok ? 'OK' : 'DRIVER_ERROR')),
    evidencePath: summaryPath ? relative(stateDir, join(evidenceDir, summaryPath)) : null,
    relayMode: run?.relayMode ?? null,
    relayRecords: run?.relayRecords ?? null,
    relayPolicyCounters: run?.relayPolicyCounters ?? null,
    duplicatesSeen: run?.duplicatesSeen ?? null,
    slowestBoxWallMs: run?.slowestBoxWallMs ?? null,
    gap: gap ?? null,
    cleanup: { straysBefore: strays, after, prunedRuns: pruned },
  };
  record({ ...entry, boot });

  console.log(`  ${outcome.toUpperCase()}  ${scenario.name}  ${entry.durationMs} ms  `
    + `k=${entry.k}  sig=${signatureVerified}  cls=${entry.classification}  rtt=${entry.relayRttP50} ms`);
  return { entry, code: outcome === 'pass' ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// status / report
// ---------------------------------------------------------------------------

function honestScenarios() {
  return new Set(ROTATION.filter((s) => s.expectSignature).map((s) => s.name));
}
function faultScenarios() {
  return new Set(ROTATION.filter((s) => !s.expectSignature).map((s) => s.name));
}

function statusBlock(records, state) {
  const runs = records.filter((r) => r.outcome && r.outcome !== 'gap');
  const byScenario = {};
  for (const scenario of ROTATION) {
    const mine = runs.filter((r) => r.scenario === scenario.name);
    byScenario[scenario.name] = {
      runs: mine.length,
      pass: mine.filter((r) => r.outcome === 'pass').length,
      fail: mine.filter((r) => r.outcome === 'fail' || r.outcome === 'timeout').length,
      blocked: mine.filter((r) => r.outcome === 'blocked').length,
    };
  }
  const honest = runs.filter((r) => honestScenarios().has(r.scenario));
  const fault = runs.filter((r) => faultScenarios().has(r.scenario));
  const honestVerified = honest.filter((r) => r.signatureVerified).length;
  const faultSigned = fault.filter((r) => r.signatureVerified).length;
  const histogram = {};
  for (const r of runs) histogram[r.classification ?? 'unknown'] = (histogram[r.classification ?? 'unknown'] ?? 0) + 1;
  const lastFailure = [...runs].reverse().find((r) => r.outcome === 'fail' || r.outcome === 'timeout' || r.outcome === 'blocked') ?? null;
  const last = runs[runs.length - 1] ?? null;
  const gaps = records.filter((r) => r.outcome === 'gap').length;
  const paused = existsSync(PAUSE);
  const nextRunMs = paused || !state.lastRunTs ? null : state.lastRunTs + intervalHours * 3600_000;

  return {
    host: hostname(),
    stateDir,
    paused,
    intervalHours,
    rotation: ROTATION.map((s) => s.name),
    totalRuns: runs.length,
    gaps,
    byScenario,
    signatureRate: {
      honest: { runs: honest.length, verified: honestVerified, rate: honest.length ? honestVerified / honest.length : null },
      fault: { runs: fault.length, signed: faultSigned, rate: fault.length ? faultSigned / fault.length : null },
      requirement: 'honest ⇒ 100% verified; kill/silence ⇒ 0% signed',
    },
    classificationHistogram: histogram,
    lastRun: last ? { ts: last.ts, scenario: last.scenario, outcome: last.outcome } : null,
    lastFailure: lastFailure
      ? { ts: lastFailure.ts, scenario: lastFailure.scenario, outcome: lastFailure.outcome, classification: lastFailure.classification }
      : null,
    nextRunAt: nextRunMs ? new Date(nextRunMs).toISOString() : null,
    consecutiveFailures: state.consecutiveFailures ?? 0,
    /** The honest line. Never drop it from the output. */
    note: 'Four boxes owned by ONE operator on one network path: a continuous '
      + 'transport/DKG/signing programme, not a Byzantine network. Fault runs '
      + '(kill/silence) assert fail-closed; they are not an adversary model.',
  };
}

function printStatus(block) {
  const rate = (r) => (r === null ? 'n/a' : `${(r * 100).toFixed(0)}%`);
  console.log(`ceremony soak status — ${block.host}  (${block.stateDir})`);
  console.log(`  paused: ${block.paused ? 'YES' : 'no'}   cadence: every ${block.intervalHours} h   runs: ${block.totalRuns}   gaps: ${block.gaps}`);
  console.log(`  rotation: ${block.rotation.join(' → ')}`);
  for (const [name, s] of Object.entries(block.byScenario)) {
    console.log(`    ${name.padEnd(10)} runs ${String(s.runs).padStart(3)}  pass ${String(s.pass).padStart(3)}  fail ${String(s.fail).padStart(3)}  blocked ${String(s.blocked).padStart(3)}`);
  }
  console.log(`  verified signatures (honest): ${block.signatureRate.honest.verified}/${block.signatureRate.honest.runs} = ${rate(block.signatureRate.honest.rate)}`);
  console.log(`  signatures from fault runs:   ${block.signatureRate.fault.signed}/${block.signatureRate.fault.runs} = ${rate(block.signatureRate.fault.rate)} (must be 0)`);
  console.log(`  classifications: ${Object.entries(block.classificationHistogram).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}`);
  console.log(`  last run: ${block.lastRun ? `${block.lastRun.ts} ${block.lastRun.scenario} ${block.lastRun.outcome}` : '—'}`);
  console.log(`  last failure: ${block.lastFailure ? `${block.lastFailure.ts} ${block.lastFailure.scenario} ${block.lastFailure.outcome} (${block.lastFailure.classification})` : 'none'}`);
  console.log(`  next run: ${block.nextRunAt ?? (block.paused ? 'paused' : 'on timer')}`);
  console.log(`  NOTE: ${block.note}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const state = loadState();

if (verb === 'status') {
  const block = statusBlock(readRecords(), state);
  if (flag('json')) console.log(JSON.stringify(block, null, 2));
  else printStatus(block);
  process.exit(0);
}

if (verb === 'report') {
  const n = Number(arg('last', '10'));
  const records = readRecords();
  const slice = records.slice(-n);
  if (flag('json')) {
    console.log(JSON.stringify({ records: slice, status: statusBlock(records, state) }, null, 2));
  } else {
    for (const r of slice) {
      console.log(
        `${r.ts}  ${String(r.scenario ?? '-').padEnd(10)} ${String(r.outcome ?? '-').padEnd(8)} `
        + `k=${String(r.k ?? '-').padEnd(2)} sig=${r.signatureVerified ? 'y' : 'n'} `
        + `${String(r.durationMs ?? '-').padStart(6)} ms  rtt=${r.relayRttP50 ?? '-'}  ${r.classification ?? ''}`,
      );
    }
    console.log('');
    printStatus(statusBlock(readRecords(), state));
  }
  process.exit(0);
}

if (verb === 'preflight') {
  const pre = preflight();
  for (const p of pre) {
    console.log(`${p.ok ? 'ok  ' : 'DOWN'} ${p.box.padEnd(14)} ${p.hostname ?? '-'}  ${p.nodeVersion ?? ''}  ${p.ok ? `cores ${p.cores}` : p.reason}`);
  }
  process.exit(pre.every((p) => p.ok) ? 0 : 2);
}

if (verb === 'next') {
  const scenario = pickScenario(state);
  console.log(scenario.name);
  process.exit(0);
}

// verb === 'run'
if (existsSync(PAUSE)) {
  console.log(`paused (${PAUSE}): not running. Remove the file or use ceremony-soakctl.sh start.`);
  process.exit(0);
}

const boot = bootId();
const gap = gapReason(state);
if (gap) {
  // NOT a failure: the program was not observing. Recorded, then still run.
  record({ ts: new Date().toISOString(), scenario: null, outcome: 'gap', reason: gap, boot });
  console.log(`gap recorded: ${gap}`);
}

const scenario = pickScenario(state);
console.log(`[${new Date().toISOString()}] ceremony soak — ${scenario.name} — boxes ${boxes.join(',')} relay ${relayBox}`);

const { entry, code } = runOne({ state, scenario, boot, gap });

// Rotation + bookkeeping advance only on a COMPLETED attempt (pass or fail):
// a blocked run is retried with the same scenario, because the scenario never
// got a chance to run and skipping it would quietly weaken the program.
const nextState = {
  ...state,
  lastRunTs: Date.now(),
  lastBootId: boot,
  lastScenario: scenario.name,
  consecutiveFailures: entry.outcome === 'pass' ? 0 : (state.consecutiveFailures ?? 0) + 1,
};
if (entry.outcome !== 'blocked' && !SCENARIO) {
  nextState.nextIndex = (Number(state.nextIndex ?? 0) + 1) % ROTATION.length;
}
saveState(nextState);

process.exit(code);
