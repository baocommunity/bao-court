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
 *   - it also rotates BOND-GATED scenarios (`bonded-*`), where every seat costs
 *     a REAL funded bond the host proves before the DKG starts:
 *       bonded-liquid-k2   three seats on the Liquid testnet juror-bound bonds, k=2
 *       bonded-onchain-kn  all-of-N on the Bitcoin testnet4 2-of-2 bonds
 *       bonded-wrongseat   a bond presented for the WRONG seat, on BOTH rails
 *                          (BOND_JUROR_MISMATCH + BOND_SCRIPT_MISMATCH), typed stop
 *       bonded-unbound     the legacy court-only Liquid lock (BOND_JUROR_UNBOUND)
 *       bonded-timeout     a bond check that never answers (BOND_CHECK_TIMEOUT)
 *     The bonds are the SAME funded outpoints every run and are never spent, so
 *     these scenarios prove the GATE, not fresh funding — see
 *     `scripts/court/bond-plan.json` and `docs/MULTI_PROCESS_CEREMONY.md`.
 *   - it writes ONE JSONL record per run, with public material only:
 *       {ts, scenario, bondMode, bonds, k, n, outcome, groupKeyFingerprint,
 *        signatureVerified, durationMs, perBoxWallMs, relayRttP50,
 *        classification, evidencePath, assertions, cleanup}
 *   - it ASSERTS every scenario's claim against the driver's artifact and FAILS
 *     the run when one is violated (honest ⇒ one verified signature and every
 *     admitted seat `bondVerified:true`; negative ⇒ no key, no signature, the
 *     expected typed code, the expected exclusions, `ROSTER_BELOW_THRESHOLD`);
 *   - it PREFLIGHTS the boxes (reachable? Node present?) and records a
 *     `blocked` outcome — with the reason — instead of hanging if one is down;
 *   - it CLEANS UP before and after: strays from an aborted run are killed by
 *     their exact command line (never `pkill -u`), the run dirs on the boxes are
 *     removed, no relay is left listening, and no HTLC is left held;
 *   - it accounts for BOOT GAPS: a reboot (or a long elapse) is recorded as a
 *     `gap` record, not as a failure — the program is measuring the ceremony,
 *     not uptime.
 *
 * The cadence, the timer and the control verbs live in
 * `scripts/court/ceremony-soakctl.sh` + `scripts/court/systemd/`.
 *
 * Usage:
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs run
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs run --scenario=bonded-liquid-k2
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs status
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs report --last=20
 *   node --import tsx scripts/court/distributed-ceremony-soak.mjs preflight
 *
 * The bond gate command (the HOST's proof, see `bondCheckGate.ts`):
 *   BAO_COURT_BOND_CHECK_CMD=<full command>   used verbatim (wins over everything)
 *   BAO_COURT_BOND_CLI=<path to verify-bond.mts>   composed with the plan's public
 *                                                  config (group key, asset, court
 *                                                  key, node box, depth)
 * Neither ⇒ every `bonded-*` scenario records `blocked` with
 * `BOND_GATE_NOT_CONFIGURED` (never a silent `rail:none` pass).
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
import { assertBondRun, assertCleanup, bondsForMode, seatIndices } from './soakBondAssertions.ts';

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
/** The Lightning node the held-HTLC probe asks, and the CLI it uses there. */
const lnBox = arg('ln-box', 'bao8gb');
const lnCli = arg(
  'ln-cli',
  'lightning-cli --lightning-dir=/home/cln/.lightning --network=signet',
);

const RECORDS = join(stateDir, 'records.jsonl');
const STATE = join(stateDir, 'state.json');
const RUNS = join(stateDir, 'runs');
const PAUSE = join(stateDir, 'PAUSED');

if (flag('help')) {
  console.log(`distributed-ceremony-soak — verbs: ${VERBS.join(', ')}
  --state-dir=  --boxes=  --relay-box=  --port=  --interval-hours=6
  --deadline-ms=300000  --keep-runs=120  --scenario=  --with-silence  --json
  --bond-plan=  --bond-cli=  --bond-check-cmd=  --soak-env-file=  --ln-box=  --ln-cli=
  env: BAO_COURT_BOND_CHECK_CMD (verbatim) | BAO_COURT_BOND_CLI (path to verify-bond.mts)`);
  process.exit(0);
}

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(RUNS, { recursive: true, mode: 0o700 });
mkdirSync(sshDir, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// The bond plan (PUBLIC data: outpoints, pubkeys, locks — no secrets)
// ---------------------------------------------------------------------------

const BOND_PLAN_PATH = arg('bond-plan', join(HERE, 'bond-plan.json'));
const bondPlan = JSON.parse(readFileSync(BOND_PLAN_PATH, 'utf8'));

/**
 * The gate command. `BAO_COURT_BOND_CHECK_CMD` is the driver's own contract and
 * is used verbatim when present. Otherwise `BAO_COURT_BOND_CLI` (the host's
 * `verify-bond.mts`) is composed with the plan's PUBLIC configuration — the
 * flags that say WHAT "the right script" is live in the command line, which is
 * where the operator's policy belongs.
 */
/**
 * The gate command, and WHERE it came from.
 *
 * The timer is the authority in practice: `ceremony-soakctl.sh install` writes
 * the command into `~/.config/bao-court/ceremony-soak.env`, which the unit reads
 * through `EnvironmentFile=-`. A shell that runs `status` has none of those
 * variables, so without this fallback `status` would print "NOT CONFIGURED"
 * while the timer was ARMED — a status line that lies about the program it is
 * describing. Read the same file (when the vars are unset) and say which source
 * won, so the answer is the same in a shell and in the unit.
 */
const SOAK_ENV_FILE = arg(
  'soak-env-file',
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'bao-court', 'ceremony-soak.env'),
);
/** systemd `EnvironmentFile` syntax: `KEY=value`, `#` comments, no expansion. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
const soakEnv = readEnvFile(SOAK_ENV_FILE);

const bondCheckCmdOverride = arg('bond-check-cmd', '').trim()
  || (process.env.BAO_COURT_BOND_CHECK_CMD ?? '').trim()
  || (soakEnv.BAO_COURT_BOND_CHECK_CMD ?? '').trim();
const bondCli = arg('bond-cli', '').trim()
  || (process.env.BAO_COURT_BOND_CLI ?? '').trim()
  || (soakEnv.BAO_COURT_BOND_CLI ?? '').trim();
const bondGateSource = arg('bond-check-cmd', '').trim() !== '' || arg('bond-cli', '').trim() !== ''
  ? 'argument'
  : ((process.env.BAO_COURT_BOND_CHECK_CMD ?? '').trim() !== '' || (process.env.BAO_COURT_BOND_CLI ?? '').trim() !== ''
    ? 'environment'
    : ((soakEnv.BAO_COURT_BOND_CHECK_CMD ?? '').trim() !== '' || (soakEnv.BAO_COURT_BOND_CLI ?? '').trim() !== ''
      ? `env-file ${SOAK_ENV_FILE}`
      : 'none'));
const composedBondCmd = bondCli === ''
  ? ''
  : [
    `npx tsx ${bondCli}`,
    `--court-group-pubkey=${bondPlan.liquid.courtGroupPubkey}`,
    `--asset=${bondPlan.liquid.asset}`,
    `--court-pubkey=${bondPlan.onchain.courtPubkey}`,
    `--bitcoind-ssh=${bondPlan.onchain.bitcoindSsh}`,
    `--confirmations=${Math.max(bondPlan.liquid.confirmations, bondPlan.onchain.confirmations)}`,
  ].join(' ');
const bondGateCmd = bondCheckCmdOverride !== '' ? bondCheckCmdOverride : composedBondCmd;
/** A check that never answers, for the timeout scenario (deterministic, not a race). */
const SLEEPER_BOND_CMD = "sh -c 'exec sleep 5' soak";

// ---------------------------------------------------------------------------
// Scenario rotation
// ---------------------------------------------------------------------------

/**
 * The rotation. Honest runs are the baseline rate; the fault runs are why the
 * baseline means anything. `kill` is why "100% verified" is checked separately
 * from "0% for kill-mid-signing" — a program that only ever reported success
 * would be measuring nothing.
 *
 * The `bonded-*` entries are INTERLEAVED with the transport ones on purpose: a
 * gate that is only exercised once every ten slots is a gate nobody would
 * notice failing. Every bond scenario carries `bondMode` (the plan lookup) and
 * is asserted against the artifact before its record is written.
 */
const ROTATION = [
  {
    name: 'bonded-liquid-k2',
    args: ['--scenario=happy-k2', '--threshold=2'],
    k: 2,
    expectSignature: true,
    bondMode: 'liquid',
    bondLeadRail: 'liquid',
  },
  { name: 'happy-k2', args: ['--scenario=happy-k2', '--threshold=2'], k: 2, expectSignature: true },
  {
    name: 'bonded-onchain-kn',
    args: ['--scenario=happy-kn'],
    k: null,
    expectSignature: true,
    bondMode: 'onchain',
    bondLeadRail: 'onchain',
  },
  { name: 'happy-kn', args: ['--scenario=happy-kn'], k: null, expectSignature: true },
  {
    name: 'bonded-wrongseat',
    args: ['--scenario=happy-kn', '--expect-classification=ROSTER_BELOW_THRESHOLD'],
    k: 3,
    expectSignature: false,
    bondMode: 'wrongseat',
    // The rail that is refused FIRST alternates per invocation (state.bondLeadRail);
    // both bindings are presented every run, so both codes are always proven.
    bondLeadRail: 'rotate',
  },
  { name: 'kill', args: ['--scenario=kill', '--threshold=3'], k: 3, expectSignature: false },
  {
    name: 'bonded-unbound',
    args: ['--scenario=happy-kn', '--expect-classification=ROSTER_BELOW_THRESHOLD'],
    k: 3,
    expectSignature: false,
    bondMode: 'unbound',
    bondLeadRail: 'liquid',
  },
  { name: 'replay', args: ['--scenario=replay', '--relay-mode=replay'], k: 2, expectSignature: true },
  {
    name: 'bonded-timeout',
    args: [
      '--scenario=happy-kn',
      '--bond-check-timeout-ms=1200',
      '--expect-classification=ROSTER_BELOW_THRESHOLD',
    ],
    k: 3,
    expectSignature: false,
    bondMode: 'timeout',
    bondLeadRail: 'liquid',
    bondCheckCmd: SLEEPER_BOND_CMD,
  },
  { name: 'reorder', args: ['--scenario=reorder', '--relay-mode=reorder'], k: 2, expectSignature: true },
];
if (withSilence) {
  ROTATION.push({ name: 'silence', args: ['--scenario=silence', '--relay-mode=silence'], k: 2, expectSignature: false });
}

const BOND_SCENARIOS = ROTATION.filter((s) => s.bondMode);

function loadState() {
  const fresh = {
    version: 2,
    nextIndex: 0,
    lastRunTs: null,
    lastBootId: null,
    lastScenario: null,
    consecutiveFailures: 0,
    /** Which rail `bonded-wrongseat` refuses first on its next invocation. */
    bondLeadRail: 'liquid',
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
  for (const box of [...new Set([...boxes, relayBox, ...bondPlan.boxes])]) {
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
  for (const box of [...new Set([...boxes, relayBox, ...bondPlan.boxes])]) {
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

/**
 * Is the coordinator still listening on the relay port? `ss` prints one line
 * per socket; a bound port after teardown means the relay outlived the run.
 */
function coordinatorListening() {
  const r = spawnSync('ss', ['-lnt'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return false;
  return (r.stdout ?? '').split('\n').some((line) => line.includes(`:${port} `));
}

/**
 * Held HTLCs — the count of HTLCs still held on the Lightning node.
 *
 * None of this rotation's bonds is a Lightning bond, so the expected count is
 * ZERO; measuring it (rather than assuming it) is what makes "the soak leaves no
 * money held" a claim instead of a hope. `null` = the probe could not answer, and
 * that is recorded as unknown, never as zero.
 *
 * Only the COUNT crosses the wire: `listhtlcs` output carries payment hashes.
 */
function heldHtlcs() {
  // `grep -c` exits 1 when the count is zero — the answer "no held HTLCs" is a
  // SUCCESS, so `|| true` keeps it from being read as a failed probe.
  const r = ssh(
    lnBox,
    `${lnCli} listhtlcs 2>/dev/null | grep -c '"state": "\\(SENT\\|RCVD\\)_ADD' || true`,
    { timeout: 20000 },
  );
  const count = Number((r.stdout ?? '').trim());
  return r.status === 0 && Number.isFinite(count) ? count : null;
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

/**
 * The bond-gated half of a scenario: which bonds, which box order, which gate
 * command, and what the artifact must therefore show.
 *
 * Box order is the PLAN's, not the soak's: seat i runs `<jurorKeysDir>/juror-<i>.sec`
 * on `plan.boxes[i]`, and the bond funded to that key is `plan.seats[i]`. Passing
 * the soak's default order would seat each bond under another box's key — which
 * the gate would (correctly) refuse, so the scenario would be measuring a typo.
 */
function bondPlanFor(scenario, state) {
  if (!scenario.bondMode) return null;
  const leadRail = scenario.bondLeadRail === 'rotate'
    ? (state.bondLeadRail === 'onchain' ? 'onchain' : 'liquid')
    : (scenario.bondLeadRail ?? 'liquid');
  const expectation = bondsForMode(bondPlan, scenario.bondMode, leadRail);
  return {
    mode: scenario.bondMode,
    leadRail,
    expectation,
    boxes: bondPlan.boxes,
    jurorKeysDir: bondPlan.jurorKeysDir,
    bondSats: bondPlan.bondSats,
    cmd: scenario.bondCheckCmd ?? bondGateCmd,
    bondsSpec: expectation.bonds
      .map((b) => `${b.rail}:${b.network}:${b.proofRef}`)
      .join(','),
  };
}

function runOne({ state, scenario, boot, gap }) {
  const startedAt = Date.now();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${scenario.name}-${randomBytes(3).toString('hex')}`;
  const evidenceDir = join(RUNS, runId);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

  const bond = bondPlanFor(scenario, state);
  const runBoxes = bond ? bond.boxes : boxes;
  /** Public-only description of what this run claimed, written on EVERY outcome. */
  const bondRecord = bond
    ? {
      mode: bond.mode,
      leadRail: bond.leadRail,
      bondSats: bond.bondSats,
      jurorKeysDir: bond.jurorKeysDir,
      gateCmd: bond.cmd === '' ? null : bond.cmd,
      bonds: bond.expectation.bonds.map((b, i) => ({
        seat: i + 1,
        box: bond.boxes[i],
        rail: b.rail,
        network: b.network,
        proofRef: b.proofRef,
      })),
      expect: {
        admitted: bond.expectation.admittedSeats,
        excluded: bond.expectation.excludedSeats,
        codes: bond.expectation.codes,
        signature: bond.expectation.expectSignature,
      },
    }
    : null;

  const pre = preflight();
  const down = pre.filter((p) => !p.ok);
  if (down.length > 0) {
    const entry = {
      ts: new Date().toISOString(),
      scenario: scenario.name,
      bondMode: bond?.mode ?? null,
      bonds: bondRecord?.bonds ?? [],
      k: scenario.k,
      n: runBoxes.length,
      outcome: 'blocked',
      groupKeyFingerprint: null,
      signatureVerified: false,
      durationMs: Date.now() - startedAt,
      perBoxWallMs: [],
      relayRttP50: null,
      classification: `BLOCKED: ${down.map((d) => `${d.box}: ${d.reason}`).join(' | ')}`.slice(0, 300),
      evidencePath: null,
      boxes: pre,
      bond: bondRecord,
      gap: gap ?? null,
    };
    record({ ...entry, boot });
    console.log(`blocked: ${entry.classification}`);
    return { entry, code: 0 };
  }

  // A bond scenario with no gate command is a MISCONFIGURATION, not a pass:
  // running it with the gate inert would report `rail:none` evidence under a
  // `bonded-*` name, which is the one thing this rotation must never do.
  if (bond && bond.cmd === '') {
    const entry = {
      ts: new Date().toISOString(),
      scenario: scenario.name,
      bondMode: bond.mode,
      bonds: bondRecord?.bonds ?? [],
      k: scenario.k,
      n: runBoxes.length,
      outcome: 'blocked',
      groupKeyFingerprint: null,
      signatureVerified: false,
      durationMs: Date.now() - startedAt,
      perBoxWallMs: [],
      relayRttP50: null,
      classification: 'BLOCKED: BOND_GATE_NOT_CONFIGURED — set BAO_COURT_BOND_CHECK_CMD '
        + '(the host command that proves a bond) or BAO_COURT_BOND_CLI (path to verify-bond.mts)',
      evidencePath: null,
      boxes: pre,
      bond: bondRecord,
      gap: gap ?? null,
    };
    record({ ...entry, boot });
    console.log(`blocked: ${entry.classification}`);
    return { entry, code: 0 };
  }

  const strays = cleanStrays();
  const args = [
    '--import', 'tsx', DRIVER,
    `--boxes=${runBoxes.join(',')}`,
    `--relay-box=${relayBox}`,
    `--port=${port}`,
    `--jurors=${runBoxes.length}`,
    `--artifacts=${evidenceDir}`,
    ...scenario.args,
  ];
  if (bond) {
    args.push(
      '--require-bonds',
      `--bond-sats=${bond.bondSats}`,
      `--bonds=${bond.bondsSpec}`,
      `--juror-keys=${bond.jurorKeysDir}`,
    );
  }
  console.log(`run ${scenario.name}: node ${args.slice(2).join(' ')}`);
  if (bond) console.log(`  bond gate: ${bond.cmd}`);

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: deadlineMs,
    maxBuffer: 64 * 1024 * 1024,
    cwd: REPO,
    env: bond
      // The gate is passed to the DRIVER, which appends the fixed argv.
      ? { ...process.env, BAO_COURT_BOND_CHECK_CMD: bond.cmd }
      : { ...process.env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(join(evidenceDir, 'driver.log'), stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''));

  // Whatever happened, do not leave the boxes dirty.
  const after = cleanStrays();
  const listening = coordinatorListening();
  const htlcCount = heldHtlcs();
  const pruned = pruneRuns();

  const summaryPath = readdirSync(evidenceDir).find((f) => f.endsWith('-summary.json'));
  let summary = null;
  if (summaryPath) {
    try { summary = JSON.parse(readFileSync(join(evidenceDir, summaryPath), 'utf8')); } catch { summary = null; }
  }
  /**
   * The PER-RUN artifact, not just the summary entry.
   *
   * The summary carries the headline numbers but not the gate's `verdicts` (one
   * entry per seat: rail, proofRef, code, sources), and those verdicts are the
   * only place a typed refusal can be asserted from. Prefer the full artifact and
   * fall back to the summary so an older driver still yields a record.
   */
  const runPath = readdirSync(evidenceDir).find((f) => f.endsWith('.json') && !f.endsWith('-summary.json'));
  let run = summary?.runs?.[0] ?? null;
  let runArtifactPath = summaryPath;
  if (runPath) {
    try {
      run = JSON.parse(readFileSync(join(evidenceDir, runPath), 'utf8'));
      runArtifactPath = runPath;
    } catch { /* keep the summary entry */ }
  }
  const timedOut = result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT';

  const perBoxWallMs = (run?.perBox ?? []).map((b) => b.wallMsOnBox ?? null);
  const classifications = (run?.classifications ?? []).map((c) => c.classification).filter(Boolean);
  const signatureVerified = Boolean(run?.signatureVerified);
  const ok = Boolean(summary?.ok) && result.status === 0;

  // ── the assertions: an expectation that is not checked is not evidence ───
  const assertionFailures = [];
  const cleanupFailures = assertCleanup({
    boxes: after.map((b) => ({ box: b.box, left: b.left ?? null, listen: b.listen ?? null })),
    coordinatorListening: listening,
    heldHtlcs: htlcCount,
  });
  assertionFailures.push(...cleanupFailures);
  if (bond) {
    if (!run) assertionFailures.push('the driver wrote no run artifact for a bond-gated run');
    else assertionFailures.push(...assertBondRun(run, bond.expectation));
  }
  if (timedOut) assertionFailures.push('the run exceeded its deadline');
  if (assertionFailures.length === 0 && !ok) assertionFailures.push('the driver reported failures');

  let outcome = 'fail';
  if (timedOut) outcome = 'timeout';
  else if (ok && assertionFailures.length === 0) outcome = 'pass';

  const entry = {
    ts: new Date().toISOString(),
    scenario: scenario.name,
    bondMode: bond?.mode ?? null,
    bonds: bondRecord?.bonds ?? [],
    k: run?.threshold ?? scenario.k,
    n: runBoxes.length,
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
    evidencePath: runArtifactPath ? relative(stateDir, join(evidenceDir, runArtifactPath)) : null,
    relayMode: run?.relayMode ?? null,
    relayRecords: run?.relayRecords ?? null,
    relayPolicyCounters: run?.relayPolicyCounters ?? null,
    duplicatesSeen: run?.duplicatesSeen ?? null,
    slowestBoxWallMs: run?.slowestBoxWallMs ?? null,
    /** What the gate DID, from the artifact (never from a log line). */
    bondGate: bond
      ? {
        enforced: run?.bondGate?.enforced ?? false,
        // A stopped run records the gate's verdict OBJECTS, a completed one the
        // indices; normalise so every record has the same shape.
        admitted: seatIndices(run?.bondGate?.admitted),
        excluded: seatIndices(run?.bondGate?.excluded),
        classification: run?.bondGate?.classification ?? run?.classification ?? null,
        codes: [...new Set([
          ...(run?.bondGate?.verdicts ?? []).map((v) => v.code).filter(Boolean),
          ...(run?.identities ?? []).map((i) => i.bondCode).filter(Boolean),
        ])],
        admittedBondsVerified: (run?.identities ?? []).filter((i) => i.bondVerified === true).length,
      }
      : null,
    bond: bondRecord,
    signatures: (run?.signatures ?? []).length,
    assertions: {
      ok: assertionFailures.length === 0,
      failures: assertionFailures,
      heldHtlcs: htlcCount,
      coordinatorListening: listening,
    },
    gap: gap ?? null,
    cleanup: { straysBefore: strays, after, prunedRuns: pruned },
  };
  record({ ...entry, boot });

  console.log(`  ${outcome.toUpperCase()}  ${scenario.name}  ${entry.durationMs} ms  `
    + `k=${entry.k}  sig=${signatureVerified}  cls=${entry.classification}  rtt=${entry.relayRttP50} ms`
    + `${entry.bondGate ? `  bonds admitted=${entry.bondGate.admitted.join(',') || '-'} excluded=${entry.bondGate.excluded.join(',') || '-'}` : ''}`);
  if (assertionFailures.length > 0) {
    for (const failure of assertionFailures) console.log(`    ASSERTION FAILED: ${failure}`);
  }
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

/**
 * The armed timer's next elapse, straight from systemd (`--user`), or null when
 * no timer is installed (a manual/cron deployment). Never fatal: status must
 * work on a box where the timer was never installed.
 */
function systemdNextElapse() {
  const r = spawnSync('systemctl', [
    '--user', 'show', 'bao-court-ceremony-soak.timer',
    '-p', 'NextElapseUSecRealtime', '-p', 'ActiveState', '--no-pager',
  ], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return null;
  const next = /NextElapseUSecRealtime=(.+)/.exec(r.stdout ?? '')?.[1]?.trim();
  if (!next || next === 'n/a') return null;
  // `systemctl show` prints a timestamp like "Thu 2026-11-12 18:02:03 GMT".
  const parsed = new Date(next);
  return Number.isNaN(parsed.getTime()) ? null : { next: parsed.toISOString(), raw: next };
}

/**
 * The bond-gated half of the status block: how often the gate actually ran, how
 * often every admitted seat carried a VERIFIED bond, and which typed refusals
 * the negative runs produced. A `bonded-*` run whose gate never ran would show up
 * here as `gateNotEnforced > 0`, which is the failure this rotation exists to
 * catch.
 */
function bondStatusBlock(runs) {
  const mine = runs.filter((r) => r.bondMode);
  const honest = mine.filter((r) => r.bond?.expect?.signature);
  const negative = mine.filter((r) => r.bond?.expect && !r.bond.expect.signature);
  const refusalHistogram = {};
  for (const r of mine) {
    for (const code of r.bondGate?.codes ?? []) refusalHistogram[code] = (refusalHistogram[code] ?? 0) + 1;
  }
  const codesSatisfied = negative.filter((r) => {
    const want = r.bond?.expect?.codes ?? [];
    const seen = new Set(r.bondGate?.codes ?? []);
    return want.length > 0 && want.every((c) => seen.has(c));
  }).length;
  return {
    scenarios: BOND_SCENARIOS.map((s) => s.name),
    runs: mine.length,
    honest: {
      runs: honest.length,
      // Every admitted seat verified AND exactly one signature: the scenario's claim.
      allBondsVerified: honest.filter((r) => r.signatureVerified === true
        && (r.bondGate?.admittedBondsVerified ?? 0) === (r.n ?? 0)).length,
      signaturesVerified: honest.filter((r) => r.signatureVerified).length,
    },
    negative: {
      runs: negative.length,
      expectedCodePresent: codesSatisfied,
      noKeyNoSignature: negative.filter((r) => r.signatureVerified === false).length,
    },
    gateNotEnforced: mine.filter((r) => r.bondGate && r.bondGate.enforced !== true).length,
    refusalHistogram,
    assertionFailures: mine.filter((r) => r.assertions && r.assertions.ok === false).length,
    heldHtlcs: (() => {
      const values = mine.map((r) => r.assertions?.heldHtlcs).filter((v) => typeof v === 'number');
      return values.length === 0 ? null : Math.max(...values);
    })(),
    note: 'The SAME funded outpoints every run, never spent: these scenarios prove '
      + 'the bond GATE (a seat costs a bond the host can prove; another seat\'s bond, '
      + 'the legacy court-only lock and a silent check are all refused), not fresh funding.',
  };
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
      bondMode: scenario.bondMode ?? null,
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
  // `nextCadenceSlot` is arithmetic (last run + cadence). The AUTHORITY on the
  // next run is the systemd timer: read it when it is installed, so status
  // never claims a time the scheduler is not going to keep.
  const nextCadenceMs = paused || !state.lastRunTs ? null : state.lastRunTs + intervalHours * 3600_000;
  const nextSystemd = systemdNextElapse();

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
      requirement: 'honest ⇒ 100% verified; kill/silence/bonded-negative ⇒ 0% signed',
    },
    bond: bondStatusBlock(runs),
    bondGateConfigured: bondGateCmd !== '',
    bondGateSource,
    classificationHistogram: histogram,
    lastRun: last ? { ts: last.ts, scenario: last.scenario, outcome: last.outcome } : null,
    lastFailure: lastFailure
      ? { ts: lastFailure.ts, scenario: lastFailure.scenario, outcome: lastFailure.outcome, classification: lastFailure.classification }
      : null,
    nextCadenceSlot: nextCadenceMs ? new Date(nextCadenceMs).toISOString() : null,
    nextRunAt: nextSystemd?.next ?? (nextCadenceMs ? new Date(nextCadenceMs).toISOString() : null),
    nextRunSource: nextSystemd ? 'systemd timer' : 'last run + cadence',
    consecutiveFailures: state.consecutiveFailures ?? 0,
    /** The honest line. Never drop it from the output. */
    note: 'Four boxes owned by ONE operator on one network path: a continuous '
      + 'transport/DKG/signing programme, not a Byzantine network. Fault runs '
      + '(kill/silence/bonded-negative) assert fail-closed; they are not an adversary model.',
  };
}

function printStatus(block) {
  const rate = (r) => (r === null ? 'n/a' : `${(r * 100).toFixed(0)}%`);
  console.log(`ceremony soak status — ${block.host}  (${block.stateDir})`);
  console.log(`  paused: ${block.paused ? 'YES' : 'no'}   cadence: every ${block.intervalHours} h   runs: ${block.totalRuns}   gaps: ${block.gaps}`);
  console.log(`  rotation: ${block.rotation.join(' → ')}`);
  for (const [name, s] of Object.entries(block.byScenario)) {
    console.log(`    ${name.padEnd(18)} runs ${String(s.runs).padStart(3)}  pass ${String(s.pass).padStart(3)}  fail ${String(s.fail).padStart(3)}  blocked ${String(s.blocked).padStart(3)}${s.bondMode ? `  [bond ${s.bondMode}]` : ''}`);
  }
  console.log(`  verified signatures (honest): ${block.signatureRate.honest.verified}/${block.signatureRate.honest.runs} = ${rate(block.signatureRate.honest.rate)}`);
  console.log(`  signatures from fault runs:   ${block.signatureRate.fault.signed}/${block.signatureRate.fault.runs} = ${rate(block.signatureRate.fault.rate)} (must be 0)`);
  const b = block.bond;
  console.log(`  bond gate: ${block.bondGateConfigured ? 'ARMED' : 'NOT CONFIGURED (bonded-* scenarios will block)'}`
    + `${block.bondGateConfigured ? `  (from ${block.bondGateSource})` : ''}`);
  console.log(`    runs ${b.runs}  honest all-verified ${b.honest.allBondsVerified}/${b.honest.runs}  `
    + `negative with expected code ${b.negative.expectedCodePresent}/${b.negative.runs}  `
    + `gate-not-enforced ${b.gateNotEnforced}  assertion-failures ${b.assertionFailures}  heldHtlcs ${b.heldHtlcs ?? 'n/a'}`);
  console.log(`    refusals: ${Object.entries(b.refusalHistogram).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}`);
  console.log(`    NOTE: ${b.note}`);
  console.log(`  classifications: ${Object.entries(block.classificationHistogram).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}`);
  console.log(`  last run: ${block.lastRun ? `${block.lastRun.ts} ${block.lastRun.scenario} ${block.lastRun.outcome}` : '—'}`);
  console.log(`  last failure: ${block.lastFailure ? `${block.lastFailure.ts} ${block.lastFailure.scenario} ${block.lastFailure.outcome} (${block.lastFailure.classification})` : 'none'}`);
  console.log(`  next run: ${block.nextRunAt ?? (block.paused ? 'paused' : 'on timer')}  (${block.nextRunSource})`);
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
        `${r.ts}  ${String(r.scenario ?? '-').padEnd(18)} ${String(r.outcome ?? '-').padEnd(8)} `
        + `k=${String(r.k ?? '-').padEnd(2)} sig=${r.signatureVerified ? 'y' : 'n'} `
        + `${String(r.durationMs ?? '-').padStart(6)} ms  rtt=${r.relayRttP50 ?? '-'}  `
        + `${r.bondMode ? `bond=${r.bondMode} ` : ''}${r.classification ?? ''}`,
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
  console.log(`bond gate: ${bondGateCmd !== '' ? `${bondGateCmd}  (from ${bondGateSource})` : 'NOT CONFIGURED'}`);
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
console.log(`[${new Date().toISOString()}] ceremony soak — ${scenario.name} — boxes ${boxes.join(',')} relay ${relayBox}`
  + `${scenario.bondMode ? ` (bond-gated: ${scenario.bondMode})` : ''}`);

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
  // Alternate which rail `bonded-wrongseat` refuses first.
  if (scenario.bondMode === 'wrongseat') {
    nextState.bondLeadRail = (state.bondLeadRail === 'onchain' ? 'liquid' : 'onchain');
  }
}
saveState(nextState);

process.exit(code);
