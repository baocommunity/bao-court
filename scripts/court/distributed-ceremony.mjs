// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `distributed-ceremony` — the ceremony across REAL BOXES on a REAL NETWORK.
 *
 * The loopback harness (`multi-process-ceremony.mjs`) proves the protocol
 * between OS processes on one kernel. The reviewer's standing objection is the
 * one it cannot answer: *nothing ran distributed*. This driver answers it with
 * the smallest topology that is still genuinely distributed:
 *
 *   - ONE juror per physical box (own kernel, clock, network path, disk).
 *   - The relay is a SEPARATE PROCESS on a DIFFERENT box, reached over the
 *     public network, with a shared bearer token and a hard record cap:
 *     `scripts/court/relay-server.mjs`.
 *   - The juror binary is a single-file `esbuild` bundle (`juror.mjs`) scp'd to
 *     each box. No repo checkout, no `node_modules`, no `tsx` on the boxes.
 *   - Each box GENERATES ITS OWN key locally (0600 file, never transmitted);
 *     only its x-only public key travels, and the roster goes back out as
 *     public material. The coordinator never holds a juror secret.
 *   - The coordinator (this machine) verifies the result itself: it re-derives
 *     the group key from the DKG commitments in the relay's own receive log
 *     and verifies the aggregate signature with its own verifier.
 *   - Timing is MEASURED: per-box wall time (measured on the box), client-side
 *     round trip per POST/GET (measured in the juror process), and the relay's
 *     own handling time and arrival gaps.
 *
 * SCENARIOS
 *   happy  N jurors, threshold k: everyone finishes, one group key, one
 *          signature, coordinator verifies. Run twice (k=2 and k=N) by default.
 *   kill   one juror is SIGKILLed over ssh the moment its FROST commitment
 *          reaches the relay — i.e. after it committed and before it revealed.
 *          The survivors must fail closed with the typed classification
 *          (`SIGN_MISSING_REVEAL`) and emit NO signature; the coordinator
 *          proves no partial or aggregate leaked anywhere on the wire.
 *
 * WHAT THIS STILL DOES NOT PROVE: three boxes in one continent, no Byzantine
 * network (links are honest, only loss/partition-free), no real stake, keys on
 * each box's disk, and the operator of all four machines is the same person.
 * See docs/DISTRIBUTED_CEREMONY.md §"What this proves".
 *
 * Usage:
 *   node scripts/court/distributed-ceremony.mjs                       # both happy runs
 *   node scripts/court/distributed-ceremony.mjs --scenario=all         # + kill run
 *   node scripts/court/distributed-ceremony.mjs --scenario=kill --threshold=3
 *   node scripts/court/distributed-ceremony.mjs --boxes=vps16gb,bao8gb
 *
 * Exit 0 = every assertion passed. Artifacts are written to
 * docs/benchmarks/distributed-ceremony/.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { build } from 'esbuild';
import { parseDkgCommitmentEvent } from '../../eventsParse';
import { verifyFinalSignature, buildAttestationMessage } from '../../crypto';
import { UNBONDED, formatCourtBondRef, parseCourtBondRef } from '../../bondVerification';
import {
  BOND_CHECK_ENV,
  buildBondCheckArgs,
  gateRosterOnBonds,
  parseBondCheckOutput,
} from '../../bondCheckGate';

const Point = secp256k1.Point;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CHILD = join(HERE, 'juror-child.ts');
const RELAY = join(HERE, 'relay-server.mjs');
const DEFAULT_ARTIFACTS = join(ROOT, 'docs', 'benchmarks', 'distributed-ceremony');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * `happy` (both thresholds) | `happy-k2` | `happy-kn` (all-of-N) | `kill` |
 * `replay` | `reorder` | `silence` | `all`. The single-scenario names are what
 * the soak runner (`distributed-ceremony-soak.mjs`) rotates through.
 */
const scenario = arg('scenario', 'happy');
/** Relay delivery policy for every run of this invocation (see relay-server). */
const relayModeArg = arg('relay-mode', 'honest');
/**
 * `--scenario=replay|reorder|silence` implies its own relay policy unless
 * `--relay-mode=` says otherwise: the scenario NAME is the policy.
 */
const relayMode = relayModeArg !== 'honest'
  ? relayModeArg
  : (['replay', 'reorder', 'silence'].includes(scenario) ? scenario : 'honest');
const jurorCount = Number(arg('jurors', '3'));
const killThreshold = Number(arg('threshold', arg('kill-threshold', '3')));
const relayBox = arg('relay-box', 'vps16gb');
const boxes = arg('boxes', 'vps16gb,bao8gb,bao-testnet').split(',').map((b) => b.trim()).filter(Boolean);
const port = Number(arg('port', '18471'));
const dkgDeadlineMs = Number(arg('dkg-deadline-ms', '15000'));
const signDeadlineMs = Number(arg('sign-deadline-ms', '12000'));
const killSignDeadlineMs = Number(arg('kill-sign-deadline-ms', '6000'));
const pollMs = Number(arg('poll-ms', '20'));
/**
 * Kill-run only: the honest commit→reveal gap is about one poll interval, far
 * shorter than the time it takes to deliver a SIGKILL over ssh from another
 * box. Stretch that same gap so the fault can be delivered where the scenario
 * says it is — the window is documented, and the reveal gate itself is
 * unchanged.
 */
const killRevealDelayMs = Number(arg('kill-reveal-delay-ms', '450'));
/**
 * Where run artifacts go. The soak runner points this at its own state dir so a
 * 100-hour program does not commit thousands of JSON files into the repo.
 */
const ARTIFACTS = arg('artifacts', DEFAULT_ARTIFACTS);
const silenceIdx = Number(arg('silence-idx', '2'));
const replayP = Number(arg('replay-p', '0.35'));
const reorderWindowMs = Number(arg('reorder-window-ms', '90'));
const sshDir = arg('ssh-dir', '/tmp/opencode/bao-dist-ssh');
/**
 * BOND REFERENCE carried on every roster entry (operator direction: rosters
 * become stake-backed later, Liquid testnet first). This round sets
 * `rail:none` — carried and RECORDED, never treated as verified. The default
 * network is `testnet` because public testnet4 / signet-public evidence
 * outranks private signet; change with `--bond-rail=` / `--bond-network=`.
 */
const bondRail = arg('bond-rail', 'none');
const bondNetwork = arg('bond-network', 'testnet');
const bondProofRef = arg('bond-proof-ref', '');
const bondRef = parseCourtBondRef({
  rail: bondRail,
  network: bondNetwork,
  proofRef: bondProofRef === '' ? null : bondProofRef,
});
/**
 * PER-JUROR bond references (one per box, in box order). Two forms:
 *   --bonds=liquid:testnet:<txid:vout>,liquid:testnet:<txid:vout>,onchain:testnet:<txid:vout>
 *   --bonds-file=<path to JSON [{"rail","network","proofRef"}, …]>
 * Without either, every juror carries the single `--bond-*` reference above.
 * Parsing is do-not-guess: a short/long list or an unknown rail fails here,
 * before any process starts.
 */
const bondsSpec = arg('bonds', '');
const bondsFile = arg('bonds-file', '');
/**
 * THE BOND GATE.
 *
 *   BAO_COURT_BOND_CHECK_CMD   the host command that PROVES a bond (required to
 *                              arm the gate; unset ⇒ no enforcement at all)
 *   --require-bonds            a juror claiming `rail:none` loses its seat too
 *   --bond-sats=<n>            the bond the ceremony requires (default 0 = no
 *                              floor: whatever value the rail proves)
 *   --bond-check-timeout-ms    per-juror command budget (fail closed on expiry)
 *   --expect-classification=…  assert the ceremony STOPPED with this code
 *                              (e.g. ROSTER_BELOW_THRESHOLD) instead of a
 *                              below-threshold roster being a driver failure
 *
 * With the command unset the harness behaves exactly as before: the reference
 * is carried and recorded, `bondVerified:false`, nothing enforced.
 */
const bondCheckCmd = (arg('bond-check-cmd', '') || process.env[BOND_CHECK_ENV] || '').trim();
const requireBonds = flag('require-bonds');
const bondSats = Number(arg('bond-sats', '0'));
const bondCheckTimeoutMs = Number(arg('bond-check-timeout-ms', '60000'));
const expectClassification = arg('expect-classification', '');
if (!Number.isSafeInteger(bondSats) || bondSats < 0) {
  throw new Error(`--bond-sats must be a non-negative integer (got "${arg('bond-sats', '0')}")`);
}
const bondGateArmed = bondCheckCmd !== '';
if (requireBonds && !bondGateArmed) {
  // A strict run with nothing to check with is a MISCONFIGURATION, not
  // "no enforcement": silently ignoring --require-bonds is exactly the class
  // of bug this gate exists to close.
  throw new Error(
    `--require-bonds needs ${BOND_CHECK_ENV} (the host command that proves a bond). `
      + 'Refusing to run a strict ceremony with no bond check.',
  );
}

/** One per-juror bond reference, from `--bonds` / `--bonds-file` / the default. */
function parseBondsSpec(spec) {
  return spec.split(',').map((chunk) => {
    const trimmed = chunk.trim();
    const first = trimmed.indexOf(':');
    const second = first === -1 ? -1 : trimmed.indexOf(':', first + 1);
    if (first === -1 || second === -1) {
      throw new Error(`--bonds entry "${trimmed}" must be <rail>:<network>:<proofRef>`);
    }
    return parseCourtBondRef({
      rail: trimmed.slice(0, first),
      network: trimmed.slice(first + 1, second),
      proofRef: trimmed.slice(second + 1),
    });
  });
}
const perJurorBonds = bondsFile !== ''
  ? JSON.parse(readFileSync(bondsFile, 'utf8')).map((entry) => parseCourtBondRef(entry))
  : (bondsSpec !== '' ? parseBondsSpec(bondsSpec) : null);
if (perJurorBonds && perJurorBonds.length !== boxes.length) {
  throw new Error(
    `per-juror bonds name ${perJurorBonds.length} juror(s) but the topology has ${boxes.length} box(es)`
      + ' — every box needs exactly one bond reference',
  );
}
/** The bond reference this box's juror runs under (positional, box order). */
const bondForPosition = (position) => (perJurorBonds ? perJurorBonds[position - 1] : bondRef);
/** Keep the boxes' run dirs (bundles, logs) for debugging instead of tearing down. */
const keep = flag('keep');
/** Node per box. bao-testnet has no system Node: static tarball under /opt. */
function nodeFor(box) {
  if (box === 'bao-testnet') return '/opt/bao-court-node/bin/node';
  return '/usr/bin/node';
}

mkdirSync(sshDir, { recursive: true, mode: 0o700 });
const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=12',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${sshDir}/%r@%h:%p`,
  '-o', 'ControlPersist=300',
  '-o', 'LogLevel=ERROR',
];

/**
 * Every remote call goes over one multiplexed (ControlMaster) connection per
 * box, so the launch/kill path costs milliseconds instead of a TCP+ssh
 * handshake — that matters for the mid-signing kill. A multiplexed socket can
 * drop under repeated use (255), which is a transport hiccup, not a ceremony
 * result: retry those, never retry a real command failure.
 */
function ssh(box, command, { timeout = 120000, allowFail = false, attempts = 3 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync('ssh', [...SSH_OPTS, box, command], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 256 * 1024 * 1024,
    });
    last = { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
    if (result.status === 0) return last;
    if (result.status !== 255 || attempt === attempts) break;
    // Drop a stale multiplexed socket so the retry opens a fresh one.
    spawnSync('ssh', ['-O', 'exit', '-o', `ControlPath=${sshDir}/%r@%h:%p`, box], { timeout: 5000 });
    spawnSync('sleep', ['0.2']);
  }
  if (last.status !== 0 && !allowFail) {
    throw new Error(`ssh ${box} failed (${last.status}): ${(last.stderr || '').slice(0, 400)}\ncmd: ${command}`);
  }
  return last;
}

/**
 * Fire-and-forget ssh. `ssh -f` still waits for the remote process tree on
 * these boxes, so a long-running remote daemon would block the driver for the
 * whole ceremony. Detaching the LOCAL ssh lets the driver proceed at once; the
 * remote process is tracked by its own pid file, which is the only thing we
 * actually need.
 */
function sshFireAndForget(box, command) {
  const child = spawn('ssh', [...SSH_OPTS, box, command], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/** Non-blocking ssh, used to launch every juror at (almost) the same instant. */
function sshAsync(box, command, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, box, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`ssh ${box} timed out`)); }, timeout);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, status: 0 });
      else reject(new Error(`ssh ${box} failed (${code}): ${stderr.slice(0, 300)}`));
    });
  });
}

function scp(box, local, remote, attempts = 3) {
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawnSync('scp', [...SSH_OPTS, '-q', local, `${box}:${remote}`], {
      encoding: 'utf8',
      timeout: 120000,
    });
    if (result.status === 0) return;
    if (result.status !== 255 || attempt === attempts) break;
    spawnSync('sleep', ['0.2']);
  }
  throw new Error(`scp ${local} -> ${box}:${remote} failed: ${(result.stderr || '').slice(0, 300)}`);
}

function scpFrom(box, remote, local) {
  const result = spawnSync('scp', [...SSH_OPTS, '-q', `${box}:${remote}`, local], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures = [];
function check(name, ok, detail) {
  const record = { name, ok: Boolean(ok), detail: detail ?? null };
  if (!ok) failures.push(record);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${JSON.stringify(detail ?? null)}`}`);
  return Boolean(ok);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = () => Date.now();

// ---------------------------------------------------------------------------
// The bond check (host-supplied command; see bondCheckGate.ts)
// ---------------------------------------------------------------------------

/** Single-quote for /bin/sh: a proofRef must never be able to add a flag. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the host's bond check for ONE juror and normalise whatever happens into a
 * verdict. Every path that is not "exit 0 and `{ok:true}`, with the sources
 * that agreed" is a refusal — a crash, a timeout, a log line instead of JSON,
 * a non-zero exit that still claims success.
 */
function runBondCheck(request) {
  const started = ms();
  const argv = buildBondCheckArgs(request);
  const result = spawnSync('/bin/sh', ['-c', `${bondCheckCmd} ${argv.map(shQuote).join(' ')}`], {
    encoding: 'utf8',
    timeout: bondCheckTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const elapsedMs = ms() - started;
  const stderr = (result.stderr ?? '').trim().slice(0, 300);
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return {
      verdict: {
        ok: false,
        code: 'BOND_CHECK_TIMEOUT',
        detail: `the bond check did not answer within ${bondCheckTimeoutMs} ms`,
        proofRef: null,
        sources: [],
      },
      exitCode: null,
      signal: 'SIGTERM',
      elapsedMs,
      stderr,
    };
  }
  if (result.error) {
    return {
      verdict: {
        ok: false,
        code: 'BOND_CHECK_FAILED',
        detail: `the bond check could not be run: ${result.error.message}`,
        proofRef: null,
        sources: [],
      },
      exitCode: null,
      signal: null,
      elapsedMs,
      stderr,
    };
  }
  const verdict = parseBondCheckOutput(result.stdout ?? '');
  if (verdict.ok && result.status !== 0) {
    return {
      verdict: {
        ok: false,
        code: 'BOND_CHECK_FAILED',
        detail: `the bond check exited ${result.status} but claimed success${stderr ? ` — ${stderr}` : ''}`,
        proofRef: verdict.proofRef,
        sources: verdict.sources,
      },
      exitCode: result.status,
      signal: result.signal ?? null,
      elapsedMs,
      stderr,
    };
  }
  if (!verdict.ok && verdict.code === 'BOND_CHECK_MALFORMED' && stderr) {
    verdict.detail = `${verdict.detail ?? 'malformed output'} — ${stderr}`;
  }
  return {
    verdict,
    exitCode: result.status,
    signal: result.signal ?? null,
    elapsedMs,
    stderr,
  };
}

function pct(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function summariseTimings(jsonl) {
  const rows = jsonl.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const pub = rows.filter((r) => r.op === 'publish').map((r) => r.ms);
  const poll = rows.filter((r) => r.op === 'poll').map((r) => r.ms);
  const delta = rows.map((r) => r.serverDeltaMs).filter((v) => typeof v === 'number');
  return {
    requests: rows.length,
    publish: { count: pub.length, p50: pct(pub, 50), p95: pct(pub, 95), max: pct(pub, 100) },
    poll: { count: poll.length, p50: pct(poll, 50), p95: pct(poll, 95), max: pct(poll, 100) },
    /**
     * clientNow − relayServerTime measured AFTER the response arrived: the
     * response leg plus any clock offset between the two boxes. It is NOT a
     * one-way latency measurement (no clock sync), which is why the RTT figure
     * used in the report is the client-observed request duration.
     */
    serverDeltaMs: { p50: pct(delta, 50), min: pct(delta, 0), max: pct(delta, 100) },
  };
}

async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Cluster preparation (once per driver invocation)
// ---------------------------------------------------------------------------

const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function bundleJuror(outfile) {
  await build({
    entryPoints: [CHILD],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'error',
    // The bundle is self-contained: node builtins stay external (they are
    // always present), everything else is inlined so a box needs ONLY node.
    banner: {
      js: '// generated by scripts/court/distributed-ceremony.mjs — do not edit. Source: scripts/court/juror-child.ts',
    },
  });
  return outfile;
}

function remoteDirFor(runId) {
  return `/tmp/bao-court-dist/${runId}`;
}

/**
 * Probe the relay box's public address. The jurors live behind different
 * networks (and `vps16gb` is not resolvable from the others), so the relay URL
 * is the box's public IP: a real, routable address, not a hostname alias.
 */
function relayAddress(box) {
  const { stdout } = ssh(box, 'curl -s --max-time 8 https://api.ipify.org');
  const ip = stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`could not determine the public address of ${box}: ${ip}`);
  return ip;
}

async function startRelay({ runId, token, tokenLocal, relayIpForProbe }) {
  const dir = remoteDirFor(runId);
  // A stale relay from a previous attempt would silently SERVE THE WRONG LOG
  // (every record from an earlier ceremony in the same seq space). Kill
  // anything of ours before binding.
  ssh(
    relayBox,
    `pkill -f "relay-server[.]mjs --port=${port}" >/dev/null 2>&1; true`,
    { allowFail: true },
  );
  await sleep(250);
  ssh(relayBox, `mkdir -p ${dir} && chmod 700 ${dir}`);
  scp(relayBox, RELAY, `${dir}/relay-server.mjs`);

  // The token is a secret: it is written 0600 on the relay box and never
  // printed by any command in this driver (nor by the relay itself).
  scp(relayBox, tokenLocal, `${dir}/relay-token`);
  ssh(relayBox, `chmod 600 ${dir}/relay-token`);

  const node = nodeFor(relayBox);
  sshFireAndForget(
    relayBox,
    `cd ${dir} && setsid nohup ${node} relay-server.mjs --port=${port} --host=0.0.0.0 `
    + `--token-file=${dir}/relay-token --max-records=20000 --jurors=${jurorCount} `
    // Delivery policy: the relay may lie about DELIVERY (replay duplicates,
    // reorder holds, silence censors), never about content.
    + `--mode=${relayMode} --seed=${runId} --silence-idx=${silenceIdx} `
    + `--replay-p=${replayP} --reorder-window-ms=${reorderWindowMs} `
    + `--pid-file=${dir}/relay.pid --stats-file=${dir}/relay-stats.json `
    + `> ${dir}/relay.log 2>&1 < /dev/null`,
  );
  // The relay writes its OWN pid: killing setsid's or a pgrep first-match pid
  // is how a stale relay survived and served an earlier run's log.
  let pid = 0;
  for (let attempt = 0; attempt < 40 && !pid; attempt += 1) {
    await sleep(100);
    const { stdout } = ssh(relayBox, `cat ${dir}/relay.pid 2>/dev/null || true`, { allowFail: true });
    pid = Number(stdout.trim()) || 0;
  }
  if (!pid) throw new Error('relay did not start (no pid file)');
  // Binding can silently lose a race with a dying predecessor: prove that the
  // process ANSWERING on the port is the one we just started.
  let answeringPid = null;
  for (let attempt = 0; attempt < 30 && answeringPid !== pid; attempt += 1) {
    await sleep(100);
    try {
      const probe = await fetchJson(`http://${relayIpForProbe}:${port}/stats`, {
        headers: { authorization: `Bearer ${token}` },
      });
      answeringPid = probe.pid ?? null;
      if (!probe.pid) break;
    } catch { /* not listening yet */ }
  }
  if (answeringPid !== pid) {
    throw new Error(`port ${port} is answered by pid ${String(answeringPid)}, not the relay we started (${pid})`);
  }
  return { dir, pid, tokenLocal };
}

async function stopRelay({ dir, pid, localStatsPath }) {
  ssh(relayBox, `kill -TERM ${pid} 2>/dev/null; sleep 0.6; kill -9 ${pid} 2>/dev/null; true`, { allowFail: true });
  // Pull the relay's OWN timings back before we delete the run dir. Without
  // this file the run has client-side RTT only, never the server's handling.
  const ok = scpFrom(relayBox, `${dir}/relay-stats.json`, localStatsPath);
  let stats = null;
  if (ok && existsSync(localStatsPath)) {
    stats = JSON.parse(readFileSync(localStatsPath, 'utf8'));
  }
  return stats;
}

// ---------------------------------------------------------------------------
// One ceremony run
// ---------------------------------------------------------------------------

async function runCeremony({ label, threshold, kill, policy, expectSignature, bundlePath, token, relayIp, runId }) {
  const dir = remoteDirFor(runId);
  const ceremonyId = randomBytes(32).toString('hex'); // public: disambiguates this run
  const relayUrl = `http://${relayIp}:${port}`;
  const auth = { authorization: `Bearer ${token}` };
  // The shared bearer token, written 0600 locally and scp'd 0600 to the boxes.
  writeFileSync(join(dirname(bundlePath), 'relay-token'), token, { mode: 0o600 });

  console.log(`\n[${label}] N=${jurorCount} k=${threshold} relay=${relayBox} (${relayUrl}) boxes=${boxes.join(',')}`);

  // ── relay ───────────────────────────────────────────────────────────────
  const relay = await startRelay({
    runId, token, tokenLocal: join(dirname(bundlePath), 'relay-token'), relayIpForProbe: relayIp,
  });
  let relayStats = null;
  let relayLiveStats = null;
  let outcome = null;
  try {
    const health = await fetchJson(`${relayUrl}/stats`, { headers: auth });
    check(`${label}: the coordinator reaches the relay over the public network`, health.port === port, health);
    check(
      `${label}: the answering relay is the process this run started, with an empty log`,
      health.pid === relay.pid && health.records === 0,
      { records: health.records, uptimeMs: health.uptimeMs, pid: health.pid, expectedPid: relay.pid },
    );
    check(
      `${label}: the relay is running this scenario's delivery policy`,
      health.mode === relayMode,
      { expected: relayMode, actual: health.mode ?? null },
    );
    const unauth = await fetch(`${relayUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    check(`${label}: the relay refuses an unauthenticated observer (bearer token is enforced)`, unauth.status === 401, {
      status: unauth.status,
    });

    // ── ship the juror binary + launcher ──────────────────────────────────
    const launcher = join(dirname(bundlePath), 'run-juror.sh');
    writeFileSync(launcher, `#!/bin/sh
# generated by distributed-ceremony.mjs — one juror, one box, one process.
set -u
D=$(cd "$(dirname "$0")" && pwd)
IDX=$1; N=$2; K=$3; SEED=$4; RELAY=$5; DEAD=$6; POLL=$7; SDEAD=$8
NODE_BIN=$9; REVEAL_DELAY=\${10:-0}
START=$(date +%s%3N)
"$NODE_BIN" "$D/juror.mjs" \\
  --relay-url="$RELAY" \\
  --token-file="$D/relay-token" \\
  --identity-file="$D/identity-$IDX.json" \\
  --roster-file="$D/roster.json" \\
  --timings-file="$D/timings-$IDX.jsonl" \\
  --idx="$IDX" --jurors="$N" --threshold="$K" --seed="$SEED" \\
  --dir="$D/state" --poll-ms="$POLL" \\
  --dkg-deadline-ms="$DEAD" --sign-deadline-ms="$SDEAD" --reveal-delay-ms="$REVEAL_DELAY" \\
  > "$D/juror-$IDX.log" 2>&1 &
NPID=$!
echo "$NPID" > "$D/pid-$IDX"
wait "$NPID"; RC=$?
END=$(date +%s%3N)
echo "WALL_MS $((END-START)) RC $RC" >> "$D/juror-$IDX.log"
touch "$D/done-$IDX"
`, { mode: 0o755 });

    const hostInfo = [];
    for (const [i, box] of boxes.entries()) {
      const idx = i + 1;
      ssh(box, `mkdir -p ${dir} && chmod 700 ${dir}`);
      scp(box, bundlePath, `${dir}/juror.mjs`);
      scp(box, launcher, `${dir}/run-juror.sh`);
      scp(box, join(dirname(bundlePath), 'relay-token'), `${dir}/relay-token`);
      ssh(box, `chmod 600 ${dir}/relay-token && chmod 755 ${dir}/run-juror.sh`);
      const { stdout } = ssh(box, `hostname; ${nodeFor(box)} -v; nproc; uname -r`);
      const [hostname, nodeVersion, cores, kernel] = stdout.trim().split('\n');
      hostInfo.push({ idx, box, hostname, nodeVersion, cores: Number(cores), kernel });
    }
    check(`${label}: every juror runs on a DISTINCT box`, new Set(hostInfo.map((h) => h.hostname)).size === boxes.length, hostInfo);

    // ── phase 1: each box generates its own identity, publishes its pubkey ─
    const roster = [];
    for (const [i, box] of boxes.entries()) {
      const idx = i + 1;
      const { stdout } = ssh(
        box,
        `cd ${dir} && ${nodeFor(box)} juror.mjs --identity-only --identity-file=${dir}/identity-${idx}.json `
        + `--idx=${idx} --jurors=${jurorCount} --threshold=${threshold} --seed=${ceremonyId} `
        + `--dir=${dir}/state --relay-url=${relayUrl}`,
      );
      const match = stdout.match(/^IDENTITY ([0-9a-f]{64})$/m);
      if (!match) throw new Error(`box ${box} did not publish an identity: ${stdout.slice(0, 200)}`);
      roster.push({ idx, box, pubkey: match[1] });
    }
    check(
      `${label}: every identity was generated ON its own box and is distinct`,
      new Set(roster.map((r) => r.pubkey)).size === boxes.length,
      roster.map((r) => ({ idx: r.idx, box: r.box, pubkey: r.pubkey.slice(0, 16) + '…' })),
    );

    // ── THE BOND GATE: prove every seat BEFORE the DKG starts ─────────────
    //
    // This is the enforcement point. It runs after the boxes publish their
    // keys (the check needs --juror-pubkey) and BEFORE the roster is written
    // and any juror process starts, so an excluded juror never takes part in
    // a DKG. The proof itself is the HOST's: this repository shells out to
    // BAO_COURT_BOND_CHECK_CMD and decides only what a verdict MEANS.
    const claims = roster.map((entry) => ({
      idx: entry.idx,
      box: entry.box,
      pubkey: entry.pubkey,
      bond: bondForPosition(entry.idx),
    }));
    const gateStartedAt = ms();
    const bondCheckRuns = [];
    const verdicts = new Map();
    if (bondGateArmed) {
      for (const claim of claims) {
        // `rail:none` has nothing to prove — the gate refuses it under
        // --require-bonds and admits it unverified otherwise. No command run.
        if (claim.bond.rail === 'none') continue;
        if (claim.bond.proofRef === null) continue;
        const request = {
          rail: claim.bond.rail,
          network: claim.bond.network,
          proofRef: claim.bond.proofRef,
          bondSats,
          jurorPubkey: claim.pubkey,
        };
        const run = runBondCheck(request);
        verdicts.set(claim.idx, run.verdict);
        bondCheckRuns.push({
          idx: claim.idx,
          box: claim.box,
          rail: claim.bond.rail,
          network: claim.bond.network,
          proofRef: claim.bond.proofRef,
          bondSats,
          jurorPubkey: claim.pubkey,
          ok: run.verdict.ok,
          code: run.verdict.code,
          detail: run.verdict.detail,
          sources: run.verdict.sources,
          exitCode: run.exitCode,
          elapsedMs: run.elapsedMs,
        });
        console.log(
          `  bond check juror ${claim.idx} (${claim.box}): ${run.verdict.ok ? 'PROVEN' : `REFUSED ${run.verdict.code}`}`
            + ` ${formatCourtBondRef(claim.bond)} in ${run.elapsedMs} ms`
            + `${run.verdict.sources.length ? ` sources=${run.verdict.sources.join('+')}` : ''}`,
        );
      }
    }
    const gate = gateRosterOnBonds({
      jurors: claims,
      threshold,
      enforced: bondGateArmed,
      requireBonds,
      verdicts,
    });
    check(
      `${label}: the bond gate ${bondGateArmed ? 'ran on every claimed bond' : 'is INERT (no ' + BOND_CHECK_ENV + ')'}`,
      bondGateArmed
        ? bondCheckRuns.length === claims.filter((c) => c.bond.rail !== 'none' && c.bond.proofRef !== null).length
        : true,
      { armed: bondGateArmed, checks: bondCheckRuns.length, requireBonds, bondSats },
    );
    for (const verdict of gate.excluded) {
      console.log(
        `  EXCLUDED juror ${verdict.idx}: ${verdict.refusal}`
          + `${verdict.code ? ` (${verdict.code})` : ''} ${verdict.bondRef}`
          + `${verdict.detail ? ` — ${verdict.detail}` : ''}`,
      );
    }
    if (!gate.ok) {
      // FAIL CLOSED: no roster is written, no juror is launched, nothing is
      // signed. The run artifact carries the classification and every refusal.
      const classification = gate.classification ?? 'ROSTER_BELOW_THRESHOLD';
      console.log(`  ROSTER BELOW THRESHOLD: ${gate.admitted.length} admitted, ${threshold} required — ceremony refuses to start`);
      const stopped = {
        label,
        runId,
        threshold,
        kill: Boolean(kill),
        relayUrl,
        relayBox,
        relayIp,
        boxes: hostInfo,
        identities: claims.map((claim) => {
          const verdict = [...gate.admitted, ...gate.excluded].find((v) => v.idx === claim.idx);
          return {
            idx: claim.idx,
            box: claim.box,
            pubkey: claim.pubkey,
            bond: claim.bond,
            bondRef: formatCourtBondRef(claim.bond),
            bondVerified: verdict?.bondVerified ?? false,
            admitted: verdict?.admitted ?? false,
            refusal: verdict?.refusal ?? null,
            bondCode: verdict?.code ?? null,
            sources: verdict?.sources ?? [],
          };
        }),
        bondPlan: {
          enforced: bondGateArmed,
          requireBonds,
          bondSats,
          checkCmd: bondCheckCmd === '' ? null : bondCheckCmd,
          threshold,
          admitted: gate.admitted.map((v) => v.idx),
          excluded: gate.excluded.map((v) => v.idx),
          classification,
          note: 'no roster written, no juror launched: the ceremony failed closed at the bond gate',
        },
        bondGate: { ...gate, verdicts: bondCheckRuns },
        classification,
        signatures: [],
        signatureVerified: false,
        groupKey: null,
        groupKeyFingerprint: null,
        relayRecords: 0,
        classifications: claims.map((claim) => ({
          idx: claim.idx,
          classification: [...gate.admitted, ...gate.excluded].find((v) => v.idx === claim.idx)?.admitted
            ? null
            : classification,
        })),
        perBox: [],
        coordinatorWallMs: ms() - gateStartedAt,
      };
      check(
        `${label}: the ceremony failed closed with ${classification} and emitted NO key and NO signature`,
        classification === 'ROSTER_BELOW_THRESHOLD' && stopped.groupKey === null && stopped.signatures.length === 0,
        { classification, admitted: gate.admitted.length, threshold },
      );
      if (expectClassification !== '' && expectClassification !== classification) {
        failures.push({
          name: `${label}: expected classification ${expectClassification}, got ${classification}`,
          ok: false,
          detail: { classification },
        });
        exitCode = 1;
      }
      return stopped;
    }
    if (expectClassification !== '') {
      throw new Error(`--expect-classification=${expectClassification} was requested but the ceremony proceeded`);
    }

    // ── re-seat the survivors at sequential indices (same keys, own boxes) ─
    //
    // The protocol needs indices 1..m, so an excluded juror leaves a gap only
    // in the OLD numbering. Each survivor keeps the key it generated ON its
    // box (the identity file is copied to its new position), so the bond proof
    // taken above stays valid for the key that actually sits.
    const seats = gate.admitted.map((verdict, i) => {
      const entry = roster.find((r) => r.idx === verdict.idx);
      return { seat: i + 1, idx: verdict.idx, box: entry.box, pubkey: verdict.pubkey, bond: verdict.bond, verdict };
    });
    const seatCount = seats.length;
    for (const seat of seats) {
      if (seat.seat === seat.idx) continue;
      ssh(seat.box, `cd ${dir} && cp -f identity-${seat.idx}.json identity-${seat.seat}.json && chmod 600 identity-${seat.seat}.json`);
    }
    // Every roster entry carries its bond REFERENCE and this run's verdict.
    // `rail:none` still means "no bond claimed" (recorded, never verified).
    const rosterJson = JSON.stringify(
      seats.map((seat) => ({ idx: seat.seat, pubkey: seat.pubkey, bond: seat.bond })),
      null,
      2,
    );
    writeFileSync(join(dirname(bundlePath), 'roster.json'), rosterJson);
    for (const box of seats.map((s) => s.box)) {
      scp(box, join(dirname(bundlePath), 'roster.json'), `${dir}/roster.json`);
      ssh(box, `chmod 644 ${dir}/roster.json`);
    }

    // ── phase 2: launch one juror per box, IN PARALLEL ────────────────────
    // Sequential launches cost one ssh round trip each, and a slow box then
    // starts its juror seconds after the others — inside a 15 s DKG deadline
    // that is a false "missing participant". Launch them together.
    const t0 = ms();
    // Marker files first (one ssh each, in parallel), then the launches.
    const staged = await Promise.allSettled(seats.map((seat) => sshAsync(
      seat.box,
      `cd ${dir} && rm -f done-${seat.seat} pid-${seat.seat} timings-${seat.seat}.jsonl && chmod 755 ${dir}/run-juror.sh && echo staged`,
    )));
    const stagedFailures = staged.filter((r) => r.status === 'rejected');
    check(
      `${label}: every seated box accepted the juror launcher`,
      stagedFailures.length === 0,
      stagedFailures.map((r) => String(r.reason && r.reason.message ? r.reason.message : r.reason)),
    );
    for (const seat of seats) {
      const idx = seat.seat;
      sshFireAndForget(
        seat.box,
        `cd ${dir} && setsid nohup sh ${dir}/run-juror.sh ${idx} ${seatCount} ${threshold} ${ceremonyId} `
        + `${relayUrl} ${dkgDeadlineMs} ${pollMs} ${kill ? killSignDeadlineMs : signDeadlineMs} `
        + `${nodeFor(seat.box)} ${kill ? killRevealDelayMs : 0} > ${dir}/launch-${idx}.log 2>&1 < /dev/null`,
      );
    }
    // Give every box the same beat to reach its first poll (launch is now
    // within milliseconds of each other, but ssh multiplexing is not free).
    await sleep(150);

    // ── optional: kill one juror mid-signing, over ssh ────────────────────
    let killed = null;
    if (kill) {
      const victimIdx = 2;
      const victimSeat = seats.find((s) => s.seat === victimIdx);
      if (!victimSeat) throw new Error('--scenario=kill needs a juror seated at index 2');
      const victimBox = victimSeat.box;
      const deadline = ms() + 30000;
      let target = null;
      while (ms() < deadline && !target) {
        try {
          const log = await fetchJson(`${relayUrl}/log`, { headers: auth });
          target = log.records.find((r) => r.phase === 'frost-commit' && r.from === victimIdx) ?? null;
        } catch { /* relay momentarily busy */ }
        if (!target) await sleep(20);
      }
      if (!target) throw new Error('the victim never published a FROST commitment');
      const killAt = ms();
      const { stdout } = ssh(victimBox, `cat ${dir}/pid-${victimIdx} 2>/dev/null || pgrep -f "juror.mjs --relay-url" | head -1`);
      const victimPid = Number(stdout.trim());
      if (!victimPid) throw new Error('could not find the victim pid');
      ssh(victimBox, `kill -9 ${victimPid}`, { allowFail: true });
      killed = {
        idx: victimIdx,
        box: victimBox,
        pid: victimPid,
        killedAfterSeq: target.seq,
        killLatencyMs: ms() - killAt,
        observedPhase: target.phase,
      };
      console.log(`  killed juror ${victimIdx} on ${victimBox} (pid ${victimPid}) right after its frost-commit (seq ${target.seq})`);
    }

    // ── wait for every juror to finish (marker file per box) ──────────────
    const markers = seats.map((seat) => ({ box: seat.box, idx: seat.seat, origIdx: seat.idx, done: false }));
    const waitDeadline = ms() + 90000;
    while (ms() < waitDeadline && markers.some((m) => !m.done)) {
      for (const marker of markers) {
        if (marker.done) continue;
        const { status } = ssh(marker.box, `test -f ${dir}/done-${marker.idx}`, { allowFail: true, timeout: 20000 });
        if (status === 0) marker.done = true;
      }
      if (markers.some((m) => !m.done)) await sleep(150);
    }
    const wallMs = ms() - t0;
    check(`${label}: every juror process terminated`, markers.every((m) => m.done), markers);

    // ── collect the boxes' own logs + timings ─────────────────────────────
    const perBox = [];
    for (const marker of markers) {
      const localLog = join(dirname(bundlePath), `juror-${marker.idx}.log`);
      const localTimings = join(dirname(bundlePath), `timings-${marker.idx}.jsonl`);
      scpFrom(marker.box, `${dir}/juror-${marker.idx}.log`, localLog);
      scpFrom(marker.box, `${dir}/timings-${marker.idx}.jsonl`, localTimings);
      const logText = existsSync(localLog) ? readFileSync(localLog, 'utf8') : '';
      const wallLine = logText.match(/^WALL_MS (\d+) RC (-?\d+)$/m);
      const reports = logText.split('\n').filter((l) => l.startsWith('REPORT ')).map((l) => JSON.parse(l.slice(7)));
      const timings = existsSync(localTimings) ? summariseTimings(readFileSync(localTimings, 'utf8')) : null;
      perBox.push({
        idx: marker.idx,
        // `idx` is the protocol index (seat); `origIdx` the box's original
        // position. They differ only when the bond gate excluded a juror.
        origIdx: marker.origIdx,
        box: marker.box,
        hostname: hostInfo.find((h) => h.idx === marker.origIdx)?.hostname,
        nodeVersion: hostInfo.find((h) => h.idx === marker.origIdx)?.nodeVersion,
        wallMsOnBox: wallLine ? Number(wallLine[1]) : null,
        exitCode: wallLine ? Number(wallLine[2]) : null,
        report: reports[0] ?? null,
        reports: reports.length,
        stderrTail: logText.split('\n').filter((l) => /error|Error/.test(l)).slice(0, 3),
        timings,
      });
    }

    const bondEchoes = perBox.filter((b) => b.report);
    // Each juror echoes ITS OWN roster bond (per-juror refs differ), verbatim.
    const bondForSeat = (seat) => seats.find((s) => s.seat === seat)?.bond ?? UNBONDED;
    check(
      `${label}: every reporting juror carried its own roster bond reference through the ceremony verbatim`,
      bondEchoes.length > 0
      && bondEchoes.every((b) => JSON.stringify(b.report.bond) === JSON.stringify(bondForSeat(b.idx))),
      {
        rosterBonds: seats.map((s) => `${s.seat}:${formatCourtBondRef(s.bond)}`),
        echoed: perBox.map((b) => (b.report?.bond ? formatCourtBondRef(b.report.bond) : null)),
      },
    );
    check(
      `${label}: ${bondGateArmed ? 'every seated juror carries a VERIFIED bond' : 'the bond reference is a CLAIM, not verification (gate inert)'}`,
      bondGateArmed
        ? seats.every((s) => s.verdict.bondVerified === true)
        : seats.every((s) => s.bond.rail === 'none' ? s.bond.proofRef === null : typeof s.bond.proofRef === 'string'),
      bondGateArmed ? seats.map((s) => ({ seat: s.seat, bond: s.verdict.bondRef, verified: s.verdict.bondVerified })) : bondRef,
    );

    // ── the relay's own receive log: the coordinator's audit trail ────────
    const wire = await fetchJson(`${relayUrl}/log`, { headers: auth });
    const records = wire.records;
    /**
     * One commitment per juror, from the relay's log. A REPLAYED record is a
     * byte-identical repeat of the same signed event: the coordinator dedupes it
     * exactly as a receiving juror does. Two DIFFERENT commitments from one
     * juror is equivocation and must never be papered over.
     */
    const commitmentEvents = records.filter((r) => r.phase === 'dkg-commit' && r.event);
    const parsedCommitments = commitmentEvents.map((r) => parseDkgCommitmentEvent(r.event)).filter(Boolean);
    const perJurorCommitments = new Map();
    let duplicateCommitments = 0;
    const equivocatingJurors = [];
    for (const [i, parsed] of parsedCommitments.entries()) {
      const existing = perJurorCommitments.get(parsed.jurorIdx);
      if (!existing) {
        perJurorCommitments.set(parsed.jurorIdx, { parsed, eventId: commitmentEvents[i].event.id });
        continue;
      }
      const identical = existing.eventId === commitmentEvents[i].event.id
        && JSON.stringify(existing.parsed.vssCommits) === JSON.stringify(parsed.vssCommits)
        && existing.parsed.pok === parsed.pok;
      if (identical) duplicateCommitments += 1;
      else equivocatingJurors.push(parsed.jurorIdx);
    }
    const commitments = [...perJurorCommitments.values()].map((v) => v.parsed);
    const groupKeyRecomputed = commitments.length === seatCount && equivocatingJurors.length === 0
      ? commitments.reduce((sum, c) => sum.add(Point.fromHex(c.vssCommits[0])), Point.ZERO).toHex(true).slice(2)
      : null;

    const reportedKeys = new Set(perBox.map((b) => b.report?.groupPubkeyXOnly).filter(Boolean));
    const reportedSignatures = new Set(perBox.map((b) => b.report?.signature).filter(Boolean));
    const signedReports = perBox.filter((b) => b.report?.signature);

    // ── assertions ────────────────────────────────────────────────────────
    let signatureVerified = false;
    if (!kill && expectSignature) {
      check(`${label}: every juror reported an outcome`, perBox.every((b) => b.report), {
        saw: perBox.map((b) => b.report?.classification ?? 'none'),
      });
      check(`${label}: every juror completed DKG + signing`, perBox.every((b) => b.report?.ok === true), {
        classifications: perBox.map((b) => b.report?.classification),
      });
      check(`${label}: all boxes independently computed the SAME group key`, reportedKeys.size === 1, [...reportedKeys]);
      check(`${label}: all boxes aggregated the SAME signature`, reportedSignatures.size === 1, [...reportedSignatures]);
      check(
        `${label}: the coordinator re-derives the group key from the relay's own log`,
        groupKeyRecomputed !== null && groupKeyRecomputed === [...reportedKeys][0],
        { recomputed: groupKeyRecomputed, reported: [...reportedKeys] },
      );
      const expectedMessage = buildAttestationMessage('', 'YES', 1);
      const aggregate = perBox[0].report?.signature ?? '';
      signatureVerified = Boolean(groupKeyRecomputed)
        && aggregate.length === 128
        && verifyFinalSignature(
          groupKeyRecomputed,
          perBox[0].report?.message ?? expectedMessage,
          aggregate,
        );
      check(
        `${label}: the coordinator verifies the FROST signature against THAT key`,
        signatureVerified,
        { message: perBox[0].report?.message ?? null, signatureBytes: aggregate.length / 2 },
      );
      check(
        `${label}: the relay log carries exactly one DISTINCT DKG commitment per juror (no equivocation)`,
        commitments.length === seatCount && equivocatingJurors.length === 0,
        { distinct: commitments.length, duplicatesIgnored: duplicateCommitments, equivocatingJurors },
      );
      check(
        `${label}: every juror's own wire log shows a reveal from every peer`,
        perBox.every((b) => (b.report?.disclosure?.committed ?? []).length === seatCount),
        perBox.map((b) => b.report?.disclosure?.committed ?? null),
      );
    } else if (!kill) {
      // Policy scenario that must NOT yield a signature (`silence`): a censored
      // juror must make the attempt fail closed, never be papered over.
      const cls = perBox.map((b) => b.report?.classification ?? 'none');
      check(`${label}: every juror reported a fail-closed outcome`, perBox.every((b) => b.report && b.report.ok === false), { cls });
      check(
        `${label}: every classification is a typed "missing peer" abort, never a signature`,
        cls.every((c) => ['DKG_MISSING_PARTICIPANT', 'SIGN_MISSING_PARTICIPANT', 'SIGN_MISSING_REVEAL'].includes(c)),
        { cls },
      );
      check(
        `${label}: NO juror emitted a signature (no partial, no aggregate)`,
        signedReports.length === 0 && !records.some((r) => r.phase === 'report' && r.payload && r.payload.signature),
        { signed: signedReports.map((b) => b.idx) },
      );
      check(
        `${label}: the censored juror's records reached the relay and were withheld from delivery`,
        records.some((r) => Number(r.from) === silenceIdx && r.phase === 'dkg-commit'),
        { withheld: null },
      );
    } else {
      const victim = perBox.find((b) => b.idx === killed.idx);
      const survivors = perBox.filter((b) => b.idx !== killed.idx);
      check(`${label}: the victim was killed after its FROST commitment reached the relay`, Boolean(killed), killed);
      check(`${label}: the victim emitted no REPORT (it died mid-signing)`, victim.reports === 0, {
        reports: victim.reports,
      });
      check(
        `${label}: every survivor failed closed with SIGN_MISSING_REVEAL`,
        survivors.every((b) => b.report?.classification === 'SIGN_MISSING_REVEAL'),
        survivors.map((b) => b.report?.classification ?? 'none'),
      );
      check(
        `${label}: NO survivor emitted a signature (no partial, no aggregate)`,
        survivors.every((b) => !b.report?.signature) && signedReports.length === 0,
        survivors.map((b) => ({ idx: b.idx, signature: b.report?.signature ?? null })),
      );
      check(
        `${label}: the relay never carried a reveal from the victim`,
        !records.some((r) => r.phase === 'frost-reveal' && r.from === killed.idx),
        { reveals: records.filter((r) => r.phase === 'frost-reveal').map((r) => r.from) },
      );
      check(
        `${label}: no aggregate leaked onto the wire (the relay saw zero ` + '`report` payloads carrying a signature)',
        !records.some((r) => r.phase === 'report' && r.payload && r.payload.signature),
        { reportRecords: records.filter((r) => r.phase === 'report').length },
      );
      check(
        `${label}: survivors still agree on the group key (the DKG had completed before the kill)`,
        new Set(survivors.map((b) => b.report?.groupPubkeyXOnly).filter(Boolean)).size === 1,
        survivors.map((b) => b.report?.groupPubkeyXOnly ?? null),
      );
      check(
        `${label}: the coordinator's recomputed group key matches the survivors'`,
        groupKeyRecomputed !== null
        && groupKeyRecomputed === survivors[0]?.report?.groupPubkeyXOnly,
        { recomputed: groupKeyRecomputed, survivors: survivors.map((b) => b.report?.groupPubkeyXOnly ?? null) },
      );
    }

    const live = await fetchJson(`${relayUrl}/stats`, { headers: auth });
    if (policy === 'replay') {
      const dupes = perBox.reduce((sum, b) => sum + (b.report?.disclosure?.duplicatesSeen ?? 0), 0);
      check(`${label}: the relay genuinely duplicated records (the mode did something)`, live.stats.duplicated > 0, {
        duplicated: live.stats.duplicated,
      });
      check(`${label}: duplicate deliveries were seen and deduped by the jurors`, dupes > 0, { duplicatesSeen: dupes });
      check(
        `${label}: duplicates produced no second signature (exactly one aggregate on the wire)`,
        new Set(perBox.map((b) => b.report?.signature).filter(Boolean)).size === 1,
        { signatures: [...reportedSignatures] },
      );
    }
    if (policy === 'reorder') {
      const orders = live.subscribers
        .filter((s) => s.as !== 'observer' && s.order.length > 0)
        .map((s) => s.order.join(','));
      check(
        `${label}: the relay served different delivery orders to different boxes (reordering happened)`,
        live.stats.delayed > 0 && new Set(orders).size > 1,
        { delayed: live.stats.delayed, distinctOrders: new Set(orders).size },
      );
      check(
        `${label}: reordering did not change the outcome (one group key, one verified signature)`,
        signatureVerified && reportedKeys.size === 1 && reportedSignatures.size === 1,
        { keys: [...reportedKeys].length, signatures: [...reportedSignatures].length },
      );
    }
    if (policy === 'silence') {
      check(`${label}: the relay genuinely withheld the censored juror's traffic`, live.stats.withheld > 0, {
        withheld: live.stats.withheld,
        silencedIdx: silenceIdx,
      });
    }
    check(
      `${label}: the relay stayed under its hard record cap and refused no ceremony traffic`,
      live.stats.refusedCap === 0 && live.stats.refusedMalformed === 0,
      { cap: live.cap, records: live.records, refusedCap: live.stats.refusedCap, refusedMalformed: live.stats.refusedMalformed },
    );
    check(
      `${label}: the only 401 the relay issued was the coordinator's own unauthenticated probe`,
      live.stats.refusedAuth === 1,
      { refusedAuth: live.stats.refusedAuth },
    );
    const jurorSubs = live.subscribers.filter((s) => s.as !== 'observer');
    check(
      `${label}: every juror polled the relay and was served the same honest view`,
      jurorSubs.length === seatCount && jurorSubs.every((s) => s.polls > 0),
      jurorSubs.map((s) => ({ as: s.as, polls: s.polls, served: s.served, cursorMax: s.cursorMax })),
    );
    const signatureOfAggregate = records.find((r) => r.phase === 'report' && r.payload && r.payload.signature);
    check(
      `${label}: ${expectSignature ? 'exactly one' : 'no'} aggregate signature reached the relay's ` + '`report` records',
      expectSignature ? Boolean(signatureOfAggregate) : !signatureOfAggregate,
      { leaked: Boolean(signatureOfAggregate) },
    );
    relayLiveStats = live;

    const wallOnBox = perBox.map((b) => b.wallMsOnBox).filter((v) => typeof v === 'number');
    outcome = {
      label,
      runId,
      threshold,
      kill: Boolean(kill),
      relayUrl,
      relayBox,
      relayIp,
      boxes: hostInfo,
      identities: seats.map((seat) => ({
        // `seat` is the protocol index; `idx` the box's original position.
        seat: seat.seat,
        idx: seat.idx,
        box: seat.box,
        pubkey: seat.pubkey,
        // VERBATIM, per juror: the bond reference the ceremony ran under, the
        // verdict the host's check returned, and the sources that agreed.
        bond: seat.bond,
        bondRef: seat.verdict.bondRef,
        bondVerified: seat.verdict.bondVerified,
        sources: seat.verdict.sources,
        bondCode: seat.verdict.code,
      })),
      // Excluded jurors are recorded too — an exclusion is evidence, not noise.
      bondExclusions: gate.excluded.map((v) => ({
        idx: v.idx,
        pubkey: v.pubkey,
        bondRef: v.bondRef,
        refusal: v.refusal,
        code: v.code,
        detail: v.detail,
        sources: v.sources,
      })),
      bondGate: {
        enforced: bondGateArmed,
        requireBonds,
        bondSats,
        checkCmd: bondCheckCmd === '' ? null : bondCheckCmd,
        threshold,
        admitted: gate.admitted.map((v) => v.idx),
        excluded: gate.excluded.map((v) => v.idx),
        classification: gate.classification,
        verdicts: bondCheckRuns,
      },
      bondPlan: {
        rails: [...new Set(seats.map((s) => s.bond.rail))],
        networks: [...new Set(seats.map((s) => s.bond.network))],
        perJuror: seats.map((s) => ({ seat: s.seat, bond: formatCourtBondRef(s.bond) })),
        verified: bondGateArmed,
        note: bondGateArmed
          ? 'every seated juror was proven by the host bond check BEFORE the DKG started; '
            + 'a bond proves collateral at verification time, not that the juror cannot be bribed afterwards'
          : 'carried and recorded only — no bond check command configured; '
            + 'public testnet4 / signet-public evidence outranks private signet',
      },
      coordinatorWallMs: wallMs,
      slowestBoxWallMs: wallOnBox.length ? Math.max(...wallOnBox) : null,
      fastestBoxWallMs: wallOnBox.length ? Math.min(...wallOnBox) : null,
      relayMode,
      policy: policy ?? null,
      expectSignature: Boolean(expectSignature),
      signatureVerified,
      groupKey: groupKeyRecomputed,
      // Public identity of the group: the x-only key and a short hash of it.
      // No secret material is involved (the group key is published on chain).
      groupKeyFingerprint: groupKeyRecomputed
        ? `sha256(${groupKeyRecomputed.slice(0, 16)}…)[0:16]=${createHash('sha256')
          .update(Buffer.from(groupKeyRecomputed, 'hex')).digest('hex').slice(0, 16)}`
        : null,
      signatures: [...reportedSignatures],
      relayRecords: records.length,
      relayPhases: records.reduce((acc, r) => ({ ...acc, [r.phase]: (acc[r.phase] ?? 0) + 1 }), {}),
      duplicateCommitmentsIgnored: duplicateCommitments,
      relayPolicyCounters: {
        duplicated: live.stats.duplicated,
        withheld: live.stats.withheld,
        delayed: live.stats.delayed,
      },
      classifications: perBox.map((b) => ({ idx: b.idx, classification: b.report?.classification ?? null })),
      duplicatesSeen: perBox.reduce((sum, b) => sum + (b.report?.disclosure?.duplicatesSeen ?? 0), 0),
      killed,
      relayLive: relayLiveStats,
      perBox,
    };
  } finally {
    relayStats = await stopRelay({
      dir, pid: relay.pid, localStatsPath: join(dirname(bundlePath), `${runId}-relay-stats.json`),
    });
    // Tear down everything this driver put on the boxes.
    if (!keep) {
      for (const box of boxes) {
        ssh(box, `rm -rf ${dir}`, { allowFail: true });
      }
      ssh(relayBox, `rm -rf ${dir}`, { allowFail: true });
    } else {
      console.log(`  --keep: left ${dir} on ${boxes.join(',')}`);
    }
  }
  // The relay's own timings, read from its shutdown stats file.
  return { ...outcome, relayShutdownStats: relayStats };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runIdBase = `dist-${runStamp}`;
const workDir = `/tmp/opencode/bao-court-dist/${runIdBase}`;
mkdirSync(workDir, { recursive: true, mode: 0o700 });

const token = randomBytes(32).toString('hex');
const bundlePath = join(workDir, 'juror.mjs');

const runs = [];
let exitCode = 0;

(async () => {
  console.log(`distributed ceremony — ${boxes.length} boxes, relay on ${relayBox}, coordinator on ${process.env.HOSTNAME ?? 'baospace'}`);
  console.log(
    bondGateArmed
      ? `  bond gate: ARMED — ${BOND_CHECK_ENV} runs on the coordinator, once per juror, before the DKG `
        + `(requireBonds=${requireBonds}, bondSats=${bondSats}, timeout=${bondCheckTimeoutMs} ms)\n`
        + `             cmd: ${bondCheckCmd}`
      : `  bond gate: INERT (${BOND_CHECK_ENV} unset) — bond references are carried and recorded, nothing enforced`,
  );

  // Pre-flight: clear anything a previous attempt left behind (only our own
  // paths/patterns), then check every box is reachable.
  for (const box of new Set([...boxes, relayBox])) {
    ssh(
      box,
      // Bracket the dots: a pattern that appears literally in this very
      // command line would match (and kill) its own shell.
      'pkill -f "relay-server[.]mjs --port=18471" >/dev/null 2>&1; '
      + 'pkill -f "bao-court-dist/.*juror[.]mjs" >/dev/null 2>&1; '
      + 'rm -rf /tmp/bao-court-dist; true',
      { allowFail: true, timeout: 30000 },
    );
  }
  for (const box of boxes) {
    const { stdout, status } = ssh(box, 'hostname', { allowFail: true, timeout: 20000 });
    console.log(`  box ${box}: ${status === 0 ? stdout.trim() : 'UNREACHABLE'}`);
    if (status !== 0) throw new Error(`box ${box} is unreachable — refusing to fake a topology`);
  }
  const relayIp = relayAddress(relayBox);

  await bundleJuror(bundlePath);
  const size = readFileSync(bundlePath).byteLength;
  console.log(`  juror bundle: ${bundlePath} (${(size / 1024).toFixed(0)} KiB, single file, no node_modules on the boxes)`);

  const plan = [];
  const happy = (label, threshold) => plan.push({ label, threshold, kill: false, expectSignature: true });
  if (scenario === 'happy' || scenario === 'all') {
    happy(`happy-n${jurorCount}-k2`, 2);
    happy(`happy-n${jurorCount}-k${jurorCount}`, jurorCount);
  }
  if (scenario === 'happy-k2' || scenario === 'all') happy(`happy-n${jurorCount}-k2`, 2);
  if (scenario === 'happy-kn') happy(`happy-n${jurorCount}-k${jurorCount}`, jurorCount);
  if ((scenario === 'kill' || scenario === 'all') && relayMode === 'honest') {
    plan.push({
      label: `kill-n${jurorCount}-k${killThreshold}`,
      threshold: killThreshold,
      kill: true,
      expectSignature: false,
    });
  }
  // Byzantine DELIVERY policies: the relay lies about delivery, never content.
  if (['replay', 'reorder', 'silence'].includes(scenario)) {
    plan.push({
      label: `${scenario}-n${jurorCount}-k2`,
      threshold: 2,
      kill: false,
      // replay/reorder must still produce one verified signature; silence must not.
      expectSignature: scenario !== 'silence',
      policy: scenario,
    });
  }
  if (plan.length === 0) {
    throw new Error(`unknown --scenario=${scenario} (happy|happy-k2|happy-kn|kill|replay|reorder|silence|all)`);
  }

  for (const [i, step] of plan.entries()) {
    const runId = `${runIdBase}-${i + 1}`;
    try {
      // `runCeremony` returns its result; the shutdown stats come back through
      // a closure variable because they are read in the `finally` teardown.
      const result = await runCeremony({
        label: step.label,
        threshold: step.threshold,
        kill: step.kill,
        policy: step.policy ?? null,
        expectSignature: step.expectSignature !== false,
        bundlePath,
        token,
        relayIp,
        runId,
      });
      result.relayStats = result.relayShutdownStats ?? null;
      delete result.relayShutdownStats;
      runs.push(result);
    } catch (error) {
      failures.push({ name: `${step.label}: driver error`, ok: false, detail: String(error && error.message ? error.message : error) });
      console.error(`  DRIVER ERROR in ${step.label}:`, error && error.message ? error.message : error);
      exitCode = 1;
    }
  }

  // Artifacts: machine-readable, public material only (no key material).
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const run of runs) {
    const file = join(ARTIFACTS, `${runIdBase}-${run.label}.json`);
    writeFileSync(file, JSON.stringify({ ...run, failures: failures.filter((f) => f.name?.includes(run.label)) }, null, 2));
    console.log(`  artifact: ${file}`);
  }
  writeFileSync(
    join(ARTIFACTS, `${runIdBase}-summary.json`),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      coordinator: process.env.HOSTNAME ?? 'baospace',
      relay: { box: relayBox, port, protocol: 'HTTP/1.1 JSON envelopes, relay-assigned monotonic seq' },
      boxes, jurorCount, pollMs, dkgDeadlineMs, signDeadlineMs, killSignDeadlineMs,
      bond: {
        enforced: bondGateArmed,
        requireBonds,
        bondSats,
        checkCmd: bondCheckCmd === '' ? null : bondCheckCmd,
        defaultRef: formatCourtBondRef(bondRef),
        perJuror: perJurorBonds ? perJurorBonds.map(formatCourtBondRef) : null,
        note: bondGateArmed
          ? 'the host bond check ran per juror BEFORE the DKG; only proven seats took part'
          : 'no bond check command configured: the bond reference is a claim, not a verified bond',
      },
      runs: runs.map((r) => ({
        label: r.label,
        scenario: r.label,
        threshold: r.threshold,
        n: jurorCount,
        kill: r.kill,
        relayMode: r.relayMode,
        policy: r.policy,
        expectSignature: r.expectSignature,
        signatureVerified: r.signatureVerified,
        classifications: r.classifications,
        classification: r.classification ?? null,
        bondGate: r.bondGate ? {
          enforced: r.bondGate.enforced,
          admitted: r.bondGate.admitted,
          excluded: r.bondGate.excluded,
          classification: r.bondGate.classification,
        } : null,
        signatures: r.signatures ?? [],
        identities: (r.identities ?? []).map((i) => ({
          seat: i.seat ?? i.idx, idx: i.idx, box: i.box, pubkey: i.pubkey,
          bondRef: i.bondRef ?? null, bondVerified: i.bondVerified ?? false, sources: i.sources ?? [],
        })),
        duplicatesSeen: r.duplicatesSeen ?? 0,
        relayPolicyCounters: r.relayPolicyCounters ?? null,
        coordinatorWallMs: r.coordinatorWallMs,
        slowestBoxWallMs: r.slowestBoxWallMs,
        fastestBoxWallMs: r.fastestBoxWallMs,
        groupKey: r.groupKey,
        groupKeyFingerprint: r.groupKeyFingerprint,
        relayRecords: r.relayRecords,
        relayPhases: r.relayPhases,
        perBox: r.perBox.map((b) => ({
          idx: b.idx, box: b.box, hostname: b.hostname, nodeVersion: b.nodeVersion,
          wallMsOnBox: b.wallMsOnBox, ok: b.report?.ok ?? null,
          classification: b.report?.classification ?? null,
          bond: b.report?.bond ?? null, timings: b.timings,
        })),
        relayStats: r.relayStats ? {
          records: r.relayStats.records,
          accepted: r.relayStats.stats?.accepted,
          refusedAuth: r.relayStats.stats?.refusedAuth,
          postHandlingMs: r.relayStats.stats?.postHandlingMs,
          getHandlingMs: r.relayStats.stats?.getHandlingMs,
          arrivalGapMs: r.relayStats.stats?.arrivalGapMs,
        } : null,
      })),
      failures,
      ok: failures.length === 0,
    }, null, 2),
  );

  console.log(`\n${failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f.name} ${JSON.stringify(f.detail)}`);
  // Remove the local secret-bearing work dir (token, identity files).
  spawnSync('rm', ['-rf', workDir]);
  process.exit(failures.length === 0 ? 0 : exitCode);
})().catch((error) => {
  console.error('driver error:', error);
  spawnSync('rm', ['-rf', workDir]);
  process.exit(1);
});
