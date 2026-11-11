// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `multi-process-ceremony` — the closest-to-distributed ceremony we can run
 * on one machine, now with a relay that is allowed to LIE.
 *
 * WHAT IS REAL (and this is the point of the harness):
 *   - N separate OS PROCESSES (`child_process.spawn` of `juror-child.ts`),
 *     each with its own PID, heap, secret identity, and state directory under
 *     the run dir. No shared memory, no shared state object, no in-process
 *     call graph between jurors.
 *   - A REAL third-party RELAY: a `node:http` server on loopback TCP. Jurors
 *     talk JSON over real sockets; they do not hand each other objects. The
 *     relay — not the jurors — assigns the total message order (monotonic
 *     `seq`), exactly as a Nostr relay does, and each juror's poll cursor is
 *     independent, so different jurors observe different prefixes.
 *   - REAL receive-side verification: every wire message is a signed Nostr
 *     event re-parsed by the production parsers in the receiving process,
 *     then gated by `IndependentDkgSession` / `IndependentSigningSession`.
 *   - REAL process death: a SIGKILL mid-round (chaos `kill`) and REAL
 *     cross-round replay of captured wire bytes (chaos `replay`).
 *   - REAL independent verification by the coordinator: it re-reads the
 *     published DKG commitments from the relay log, sums the constant
 *     commitments to recompute the group key, and checks BIP-340 / FROST
 *     final-signature verification against that key with its own verifier.
 *   - A BYZANTINE RELAY (round 33): the relay keeps a per-juror VIEW and can
 *     misbehave deterministically under a seed — reorder, drop, fork
 *     (split-view), replay (duplicate + late redelivery), silence (block one
 *     juror). Each mode is routed per (record, juror), so a mode is a property
 *     of the run, not a coin flip: the same seed reproduces the same view.
 *
 * MODES (`--mode=`, R33):
 *   honest   every record is delivered to every juror, in relay order.
 *   reorder  per-receiver adversarial order: senders are ranked by a seeded
 *            permutation and each sender's records are held for its rank
 *            (`--reorder-window-ms`, default 90 ms). Per-sender FIFO is
 *            preserved; only the interleaving changes. `--reorder-style=invert`
 *            instead holds ONE juror's FROST commitments past its reveal, to
 *            test what the reveal gate does when a peer's own commit/reveal
 *            pair is inverted by the relay.
 *   drop     each record is dropped for each juror with probability `--drop-p`
 *            (seeded, per (seq, juror)).
 *   fork     SPLIT-VIEW: jurors are partitioned into two seeded cohorts and a
 *            sender's records are delivered ONLY inside the sender's cohort
 *            (`--fork-variant=dkg`, the eclipse) or only from the signing
 *            phase onward (`--fork-variant=sign`, the DKG stays whole so both
 *            cohorts hold the SAME group key).
 *   replay   the relay duplicates a seeded fraction of records and re-delivers
 *            old ones late (idempotency test), never forging content.
 *   silence  every record from one seeded juror is withheld from all others.
 *
 * LATENCY MODEL (deterministic, documented rather than measured):
 *   - One message = one HTTP POST + one HTTP GET over loopback; measured
 *     server-side timings are recorded per run, but the harness never waits
 *     on real network latency.
 *   - Inter-juror jitter before each publish:
 *       `(idx * 13 + round * 29 + phaseIndex * 7) % 41` ms  (deterministic)
 *   - Deliberate gap between a juror's commitment and its shares: 150 ms, so
 *     a mid-round kill lands between them reproducibly.
 *   - Poll interval 20 ms, so a published message becomes visible to a peer
 *     within one poll tick (bounded by `seq` ordering, not by wall clock).
 *   - Phase deadlines (default 10 s) bound every wait: the harness cannot
 *     hang, and a failure is an explicit classification, never a timeout
 *     crash.
 *
 * WHAT THIS DOES NOT PROVE (the honest scope):
 *   - It is still localhost: one kernel, one clock, one machine, no packet
 *     loss, no partitions, no clock skew, no OS scheduler failure, no disk
 *     failure. A "Byzantine relay" here is a code path in the coordinator's
 *     own process; a real one is a different operator's machine.
 *   - The relay never forges a signature: every lie it tells is a delivery
 *     policy over genuinely signed events. Content equivocation by a SENDER
 *     needs a Byzantine juror (chaos `replay`, and `__tests__`/R30 replay),
 *     not a relay.
 *   - Consensus is not Byzantine-fault-tolerant liveness here: one dead (or
 *     silenced) juror stalls the round until the deadline and aborts the
 *     attempt. That is the CURRENT protocol's behaviour (DKG requires the
 *     full certified roster), not a property this harness adds.
 *   - It says nothing about key custody: shares live in process memory for
 *     the duration of the run.
 *
 * Usage:
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=3            # happy path
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --chaos=kill --kill-phase=sign
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --chaos=replay
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --mode=fork
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --mode=fork --fork-variant=sign
 *   tsx scripts/court/multi-process-ceremony.mjs --matrix                 # every mode, N=3 and N=5
 *
 * Exit code 0 = every assertion passed; 1 = a specific assertion failed
 * (printed with its name). Writes `<run-dir>/report.json` and, for relay
 * modes, `<run-dir>/relay-views.json` (what each juror actually saw).
 */

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { parseDkgCommitmentEvent } from '../../eventsParse';
import { verifyFinalSignature, buildAttestationMessage } from '../../crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CHILD = join(HERE, 'juror-child.ts');
const Point = secp256k1.Point;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const jurorCount = Number(arg('jurors', '3'));
const threshold = Number(arg('threshold', String(Math.floor(jurorCount / 2) + 1)));
const chaos = arg('chaos', 'none'); // none | kill | replay
const killPhase = arg('kill-phase', 'sign'); // dkg | sign
const budgetMs = Number(arg('budget-ms', '300000'));
/** Per-phase wait bound inside each juror process (documented latency model). */
const deadlineMs = Number(arg('deadline-ms', '10000'));
const seed = arg('seed', randomBytes(32).toString('hex'));
if (!/^[0-9a-f]+$/i.test(seed) || seed.length % 2 !== 0 || seed.length < 32) {
  throw new Error('--seed must be an even-length hex string of at least 32 chars (juror identities derive from it)');
}

/** Relay misbehaviour mode (round 33). `--chaos` is orthogonal and still wins. */
const RELAY_MODES = ['honest', 'reorder', 'drop', 'fork', 'replay', 'silence'];
const mode = arg('mode', 'honest');
/** Fraction of (record, juror) pairs the `drop` relay discards. */
const dropP = Number(arg('drop-p', '0.2'));
/** Total reorder window in ms; a sender's records are held `rank * step`. */
const reorderWindowMs = Number(arg('reorder-window-ms', '90'));
/** `block` = seeded per-receiver sender ranking; `invert` = hold one juror's commits. */
const reorderStyle = arg('reorder-style', 'block');
/** `dkg` = sender-partition from the start; `sign` = split only after DKG. */
const forkVariant = arg('fork-variant', 'dkg');
const runMatrix = flag('matrix');
const matrixBudgetMs = Number(arg('matrix-budget-ms', '480000'));

// `--chaos` scenarios re-use the honest relay: they are process/sender faults.
const effectiveMode = chaos === 'none' ? mode : 'honest';
if (!RELAY_MODES.includes(effectiveMode)) {
  throw new Error(`--mode must be one of ${RELAY_MODES.join('|')}`);
}
if (!['block', 'invert'].includes(reorderStyle)) {
  throw new Error('--reorder-style must be block or invert');
}
if (!['dkg', 'sign'].includes(forkVariant)) {
  throw new Error('--fork-variant must be dkg or sign');
}
const runDir = mkdtempSync(join(tmpdir(), 'bao-court-r33-'));
if (runMatrix) {
  await runMatrixCommand();
  process.exit(process.exitCode ?? 0);
}

if (jurorCount < 3 || jurorCount > 7) {
  throw new Error('--jurors must be between 3 and 7 (the campaign range)');
}

// ---------------------------------------------------------------------------
// Deterministic, per-(record, juror) decisions
// ---------------------------------------------------------------------------
//
// A sequential PRNG would make the relay's behaviour depend on the (real,
// nondeterministic) interleaving of concurrent HTTP requests. Hashing the
// decision key instead makes every routing decision a pure function of
// (seed, mode, seq, juror): the same seed reproduces the same lying relay,
// record for record, no matter how the processes interleave.

function hInt(parts) {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

/** Balanced, seeded two-cohort split (|cohort 1| = ceil(N/2)). */
const cohorts = (() => {
  const idxs = Array.from({ length: jurorCount }, (_, i) => i + 1);
  const ranked = [...idxs].sort(
    (a, b) => (hInt(['cohort', seed, a]) - hInt(['cohort', seed, b])) || a - b,
  );
  const majority = new Set(ranked.slice(0, Math.ceil(jurorCount / 2)));
  return {
    majority: [...majority].sort((a, b) => a - b),
    minority: idxs.filter((i) => !majority.has(i)),
    group: (idx) => (majority.has(idx) ? 1 : 2),
  };
})();

/** The juror the `silence` / `invert` modes pick on (seeded unless overridden). */
const victimOverride = Number(arg('victim-idx', '0'));
if (victimOverride !== 0 && (victimOverride < 1 || victimOverride > jurorCount)) {
  throw new Error(`--victim-idx must be between 1 and ${jurorCount}`);
}
const victimIdx = victimOverride || (1 + (hInt(['victim', seed]) % jurorCount));

/** Per-receiver sender ranking for `--reorder-style=block`. */
function senderRank(from, juror) {
  const idxs = Array.from({ length: jurorCount }, (_, i) => i + 1);
  const ranked = [...idxs].sort(
    (a, b) => (hInt(['order', seed, juror, a]) - hInt(['order', seed, juror, b])) || a - b,
  );
  return Math.max(0, ranked.indexOf(from));
}

function delayFor(record, juror) {
  if (effectiveMode !== 'reorder') return 0;
  if (record.injected) return 0;
  if (reorderStyle === 'invert') {
    // Hold ONE juror's FROST commitments long enough that its reveal (sent
    // after it sees every commitment) overtakes its own commit at its peers.
    return record.from === victimIdx && record.phase === 'frost-commit' ? 800 : 0;
  }
  const step = Math.max(1, Math.round(reorderWindowMs / jurorCount));
  return senderRank(record.from, juror) * step;
}

function delivers(record, juror) {
  switch (effectiveMode) {
    case 'honest':
    case 'reorder':
      return true;
    case 'drop':
      // Report traffic is observability, not protocol: never drop it, or the
      // harness could not even say what the jurors concluded.
      if (record.phase === 'report') return true;
      return (hInt(['drop', seed, record.seq, juror]) % 10000) >= Math.round(dropP * 10000);
    case 'fork':
      if (forkVariant === 'sign' && String(record.phase).startsWith('dkg')) return true;
      return cohorts.group(record.from) === cohorts.group(juror);
    case 'replay':
      return true;
    case 'silence':
      return record.from !== victimIdx;
    default:
      throw new Error(`unhandled relay mode ${effectiveMode}`);
  }
}

// ---------------------------------------------------------------------------
// The relay: an ordered, append-only bulletin whose DELIVERY is a policy
// ---------------------------------------------------------------------------

/** Global receive order — the relay's own record, delivered or not. */
const log = [];
const started = Date.now();

/** juror idx -> { delivered: [record], pending: [{record, releaseAt}], trace: [] } */
const views = new Map();
function viewOf(juror) {
  const key = String(juror ?? 'observer');
  if (!views.has(key)) views.set(key, { delivered: [], pending: [], trace: [] });
  return views.get(key);
}

const stats = { dropped: 0, duplicated: 0, delayed: 0, split: 0, records: 0 };

const relay = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/events') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const envelope = JSON.parse(body);
        const record = { seq: log.length + 1, at: Date.now() - started, ...envelope };
        log.push(record);
        stats.records += 1;
        fanout(record);
        onRelayMessage?.(record);

        // `replay`: duplicate a seeded fraction of records and re-deliver the
        // copy late. Content is byte-identical and correctly signed — the
        // relay cannot forge, only repeat.
        if (
          effectiveMode === 'replay'
          && record.phase !== 'report'
          && !record.injected
          && (hInt(['dupe', seed, record.seq]) % 100) < 70
        ) {
          const copy = {
            ...record,
            seq: log.length + 1,
            at: Date.now() - started,
            injected: true,
            replayedSeq: record.seq,
          };
          log.push(copy);
          stats.duplicated += 1;
          fanout(copy);
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ seq: record.seq }));
      } catch (error) {
        res.writeHead(400);
        res.end(String(error));
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const asParam = url.searchParams.get('as');
    const view = viewOf(asParam);
    const now = Date.now() - started;

    // Release everything whose adversarial hold has expired, in (releaseAt,
    // seq) order — that is the per-juror order the juror actually observes.
    const due = view.pending.filter((p) => p.releaseAt <= now);
    if (due.length > 0) {
      view.pending = view.pending.filter((p) => p.releaseAt > now);
      due.sort((a, b) => (a.releaseAt - b.releaseAt) || (a.record.seq - b.record.seq));
      for (const item of due) {
        view.delivered.push(item.record);
        view.trace.push({
          seq: item.record.seq,
          phase: item.record.phase,
          from: item.record.from,
          injected: Boolean(item.record.injected),
        });
      }
    }

    const since = Number(url.searchParams.get('since') ?? '0');
    const from = Math.min(Math.max(0, since), view.delivered.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages: view.delivered.slice(from),
      next: view.delivered.length,
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

/** Route one received record into every juror view the mode says may see it. */
function fanout(record) {
  let targets = 0;
  for (let juror = 1; juror <= jurorCount; juror += 1) {
    if (!delivers(record, juror)) {
      stats.dropped += 1;
      continue;
    }
    targets += 1;
    const delay = delayFor(record, juror);
    if (delay > 0) stats.delayed += 1;
    viewOf(juror).pending.push({ record, releaseAt: Date.now() - started + delay });
  }
  if (record.phase !== 'report' && targets < jurorCount) stats.split += 1;
  // The observer (no `as`) sees everything, in receive order.
  viewOf(null).delivered.push(record);
  viewOf(null).trace.push({ seq: record.seq, phase: record.phase, from: record.from });
}

/** Chaos hook: the coordinator watches the wire (as an observer would). */
let onRelayMessage = null;

await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const port = relay.address().port;
const relayUrl = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Spawn the jurors
// ---------------------------------------------------------------------------

function spawnJuror(idx, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [
      '--import', 'tsx',
      CHILD,
      `--relay=${relayUrl}`,
      `--idx=${idx}`,
      `--jurors=${jurorCount}`,
      `--threshold=${threshold}`,
      `--seed=${seed}`,
      `--dir=${runDir}`,
      `--dkg-deadline-ms=${deadlineMs}`,
      `--sign-deadline-ms=${deadlineMs}`,
      ...extraArgs,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  );
  const state = { idx, child, stdout: '', stderr: '', killedAt: null, exited: false };
  child.stdout.on('data', (chunk) => { state.stdout += chunk; });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  state.done = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      state.exited = true;
      state.exitCode = code;
      state.signal = signal;
      resolve();
    });
  });
  return state;
}

function reports(state) {
  return state.stdout
    .split('\n')
    .filter((line) => line.startsWith('REPORT '))
    .map((line) => JSON.parse(line.slice('REPORT '.length)));
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

const abbr = (value) => (typeof value === 'string' ? `${value.slice(0, 12)}…` : value ?? null);

/** Fail-closed classifications a partial DKG/signing view may legitimately emit. */
const FAIL_CLOSED_CLASSIFICATIONS = new Set([
  'DKG_MISSING_PARTICIPANT',
  'DKG_DISQUALIFIED',
  'SIGN_MISSING_PARTICIPANT',
  'SIGN_MISSING_REVEAL',
  'SIGNATURE_INVALID',
]);

/** Coordinator-side group key recomputed from the relay's own receive log. */
function coordinatorGroupKey() {
  const byJuror = new Map();
  for (const message of log) {
    if (message.phase !== 'dkg-commit' || !message.event) continue;
    if (byJuror.has(message.from)) continue;
    const parsed = parseDkgCommitmentEvent(message.event);
    if (parsed) byJuror.set(message.from, parsed);
  }
  if (byJuror.size === 0) return null;
  const sum = [...byJuror.values()].reduce(
    (acc, c) => acc.add(Point.fromHex(c.vssCommits[0])),
    Point.ZERO,
  );
  return sum.toHex(true).slice(2);
}

/**
 * Assert the task's literal disjunction for a mode: either every juror
 * completes with the IDENTICAL tuple, or nobody holds a signature. A PARTIAL
 * shape is only accepted where the harness cannot pin it down (message loss),
 * and even then it must remain non-equivocating (asserted separately).
 */
function assertCompletionShape(roundOne, label, expectation) {
  const shape = completionShape(roundOne);
  if (expectation === 'IDENTICAL') {
    check(
      `${label}: every juror completed with the SAME message/key/signature`,
      shape === 'ALL_COMPLETED_IDENTICALLY',
      { shape, perJuror: roundOne.map((r) => r?.classification) },
    );
  } else if (expectation === 'ALL_FAILED_CLOSED') {
    check(
      `${label}: the whole cohort failed closed — no signature exists at all`,
      shape === 'ALL_FAILED_CLOSED',
      { shape },
    );
  } else {
    check(
      `${label}: completion is all-or-nothing or a legal partial, never divergent`,
      shape !== 'ALL_COMPLETED_DIVERGENT',
      { shape },
    );
  }
  return shape;
}

/**
 * THE equivocation assertion, valid for every mode: a relay (or a split) must
 * never yield two signatures over two different messages, two group keys among
 * outputs, or a signature that does not verify.
 */
function assertNoEquivocation(roundOne, label) {
  const signed = roundOne.filter((r) => r && r.signature);
  const messages = new Set(signed.map((r) => r.message).filter(Boolean));
  const keys = new Set(signed.map((r) => r.groupPubkeyXOnly).filter(Boolean));
  const signatures = new Set(signed.map((r) => r.signature));

  check(
    `${label}: no two jurors signed DIFFERENT messages (no equivocation)`,
    messages.size <= 1,
    { distinctMessages: messages.size, messages: [...messages].map(abbr) },
  );
  check(
    `${label}: every emitted signature is under the SAME group key`,
    keys.size <= 1,
    { distinctGroupKeys: keys.size, keys: [...keys].map(abbr) },
  );
  const allVerify = signed.every((r) => verifyFinalSignature(
    r.groupPubkeyXOnly,
    r.message,
    r.signature,
  ));
  check(
    `${label}: every emitted signature verifies against that group key`,
    signed.length === 0 || allVerify,
    { signed: signed.length, allVerify },
  );
  const claimed = roundOne.filter((r) => r && r.ok);
  check(
    `${label}: no juror claimed success without verifying its own aggregate`,
    claimed.every((r) => r.signatureVerifies !== false && Boolean(r.signature)),
    { claimed: claimed.map((r) => ({ idx: r.round, ok: r.ok, verifies: r.signatureVerifies })) },
  );

  if (signed.length > 0) {
    const recomputed = coordinatorGroupKey();
    check(
      `${label}: the coordinator recomputes the signed group key from the receive log`,
      recomputed !== null && [...keys].every((k) => k === recomputed),
      { recomputed, reported: [...keys] },
    );
  }

  return { messages: [...messages], keys: [...keys], signatures: [...signatures] };
}

/** Per-juror view summary: what each process actually observed. */function viewSummary() {
  const out = [];
  for (let juror = 1; juror <= jurorCount; juror += 1) {
    const view = viewOf(juror);
    out.push({
      idx: juror,
      delivered: view.delivered.length,
      senders: [...new Set(view.delivered.filter((m) => m.from !== juror).map((m) => m.from))]
        .sort((a, b) => a - b),
      order: view.trace.map((t) => t.seq),
      duplicates: view.trace.filter((t) => t.injected).length,
    });
  }
  return out;
}

/** Did the relay actually withhold/repeat anything? (a mode that does nothing proves nothing) */
function splitProof(summary) {
  const counts = new Set(summary.map((s) => s.delivered));
  return { distinctDeliveryCounts: [...counts], differs: counts.size > 1 };
}

/**
 * The completion shape of a round — the task's literal disjunction:
 * ALL_COMPLETED_IDENTICALLY (same message, key and signature everywhere),
 * ALL_FAILED_CLOSED (no signature anywhere), or PARTIAL (some jurors completed,
 * some aborted: legal, but it must still be non-equivocating).
 */
function completionShape(roundOne) {
  const present = roundOne.filter(Boolean);
  const oks = present.filter((r) => r.ok);
  if (oks.length === 0) return 'ALL_FAILED_CLOSED';
  const tuples = new Set(oks.map((r) => `${r.message}|${r.groupPubkeyXOnly}|${r.signature}`));
  if (oks.length === present.length) {
    return tuples.size === 1 ? 'ALL_COMPLETED_IDENTICALLY' : 'ALL_COMPLETED_DIVERGENT';
  }
  return 'PARTIAL';
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

async function happyPath() {
  console.log(`\n[happy] ${jurorCount} processes, threshold ${threshold}`);
  const states = Array.from({ length: jurorCount }, (_, i) => spawnJuror(i + 1));
  await Promise.all(states.map((s) => s.done));

  for (const state of states) {
    if (!state.exited) continue;
    if (!reports(state).length) {
      check(`juror ${state.idx} emitted a report`, false, {
        stderr: state.stderr.slice(-600),
        exitCode: state.exitCode,
      });
    }
  }
  const allReports = states.map((s) => reports(s));
  const roundOne = allReports.map((r) => r[0]);
  check('every process reported a round-1 outcome', roundOne.every(Boolean));

  const oks = roundOne.filter((r) => r && r.ok);
  check('every process completed DKG + signing', oks.length === jurorCount, {
    classifications: roundOne.map((r) => r?.classification),
  });

  const groupKeys = new Set(roundOne.map((r) => r?.groupPubkeyXOnly).filter(Boolean));
  check('all processes independently computed the SAME group key', groupKeys.size === 1, {
    groupKeys: [...groupKeys],
  });
  const signatures = new Set(roundOne.map((r) => r?.signature).filter(Boolean));
  check('all processes aggregated the SAME signature', signatures.size === 1, {
    signatureCount: signatures.size,
  });

  // Coordinator-side independent verification, from the wire only.
  const commitments = log
    .filter((m) => m.phase === 'dkg-commit')
    .map((m) => parseDkgCommitmentEvent(m.event))
    .filter(Boolean);
  check('the relay log carries exactly one commitment per juror', commitments.length === jurorCount, {
    count: commitments.length,
  });
  const recomputed = commitments.reduce(
    (sum, c) => sum.add(Point.fromHex(c.vssCommits[0])),
    Point.ZERO,
  );
  const groupKey = [...groupKeys][0];
  check(
    'coordinator recomputes the group key from published commitments',
    commitments.length === jurorCount
      && Boolean(groupKey)
      && recomputed.toHex(true).slice(2) === groupKey,
    { recomputed: commitments.length === jurorCount ? recomputed.toHex(true) : null, reported: groupKey },
  );

  const [report] = roundOne;
  if (report?.signature) {
    const expectedMessage = buildAttestationMessage('', 'YES', 1);
    check('the aggregated signature verifies against the group key', verifyFinalSignature(
      groupKey,
      report.message ?? expectedMessage,
      report.signature,
    ));
  } else {
    check('the aggregated signature verifies against the group key', false, { reason: 'no signature' });
  }

  // Process isolation: one state dir + one published log per juror.
  for (let idx = 1; idx <= jurorCount; idx += 1) {
    const published = readFileSync(join(runDir, `juror-${idx}`, 'published.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    check(`juror ${idx} wrote its own published log`, published.length > 0, {
      lines: published.length,
    });
  }

  return roundOne;
}

async function killMidRound() {
  const victim = 2;
  console.log(`\n[kill] ${jurorCount} processes, SIGKILL juror ${victim} mid-${killPhase}`);
  const targetPhase = killPhase === 'dkg' ? 'dkg-commit' : 'frost-commit';

  let killed = false;
  let states = [];
  onRelayMessage = (record) => {
    if (killed) return;
    if (record.phase === targetPhase && record.from === victim) {
      killed = true;
      const state = states[victim - 1];
      state.killedAt = record.seq;
      state.child.kill('SIGKILL');
    }
  };

  states = Array.from({ length: jurorCount }, (_, i) => spawnJuror(i + 1));
  await Promise.all(states.map((s) => s.done));
  onRelayMessage = null;

  check(`the victim was killed after its ${targetPhase} reached the relay`, killed);
  check('the victim never reported an outcome', reports(states[victim - 1]).length === 0, {
    reports: reports(states[victim - 1]),
  });
  check('the victim died by signal, not a clean exit', states[victim - 1].signal === 'SIGKILL', {
    signal: states[victim - 1].signal,
  });

  const survivors = states.filter((s) => s.idx !== victim);
  const survivorReports = survivors.map((s) => reports(s)[0]);
  check('every surviving process reported', survivorReports.every(Boolean), {
    saw: survivorReports.map((r) => r?.classification ?? 'none'),
  });
  check(
    'no survivor produced a signature',
    survivorReports.every((r) => !r || !r.signature),
    { signatures: survivorReports.map((r) => r?.signature ?? null) },
  );
  const expected = killPhase === 'dkg' ? 'DKG_MISSING_PARTICIPANT' : 'SIGN_MISSING_REVEAL';
  check(
    `every survivor failed closed with classification ${expected}`,
    survivorReports.every((r) => r && r.ok === false && r.classification === expected),
    { classifications: survivorReports.map((r) => r?.classification) },
  );
  check(
    `every survivor blamed juror ${victim}`,
    survivorReports.every((r) => r?.blamedIdx === victim),
    { blamed: survivorReports.map((r) => r?.blamedIdx) },
  );

  const survivorsAgree = new Set(
    survivorReports.map((r) => r?.groupPubkeyXOnly).filter(Boolean),
  );
  if (killPhase === 'dkg') {
    check(
      'no survivor accepted a group key (DKG aborted, not shrunk to a subset)',
      survivorsAgree.size === 0,
      { groupKeys: [...survivorsAgree] },
    );
  } else {
    // The kill landed after DKG, so the DKG invariant must still hold: every
    // survivor derived the SAME key, and only the signing round failed closed.
    check(
      'survivors still agree on the group key (DKG completed before the kill)',
      survivorsAgree.size === 1,
      { groupKeys: [...survivorsAgree] },
    );
  }

  return { survivorReports };
}

async function jurorReplay() {
  console.log(`\n[replay] ${jurorCount} processes, 2 rounds; juror 2 replays round-1 bytes into round 2`);
  const states = Array.from({ length: jurorCount }, (_, i) => spawnJuror(i + 1, [
    '--rounds=2',
    ...(i + 1 === 2 ? ['--replay-round=1'] : []),
  ]));
  await Promise.all(states.map((s) => s.done));

  const perState = states.map((s) => reports(s));
  const roundOne = perState.map((r) => r[0]);
  const roundTwo = perState.map((r) => r[1]);

  check('round 1 completed for every process', roundOne.every((r) => r?.ok === true), {
    classifications: roundOne.map((r) => r?.classification),
  });

  // Prove the replay is byte-identical: the first round-2 commitment from the
  // victim carries the SAME signed event id as its round-1 commitment.
  const roundOneCommit = log.find((m) => m.round === 1 && m.phase === 'dkg-commit' && m.from === 2);
  const roundTwoCommits = log.filter((m) => m.round === 2 && m.phase === 'dkg-commit' && m.from === 2);
  check(
    'the replayer republished its round-1 signed commitment verbatim into round 2',
    Boolean(roundOneCommit)
      && roundTwoCommits.length >= 2
      && roundTwoCommits[0].event?.id === roundOneCommit.event?.id,
    {
      roundOneId: roundOneCommit?.event?.id,
      roundTwoIds: roundTwoCommits.map((m) => m.event?.id),
    },
  );

  const phaseNonces = new Set(
    roundTwoCommits.map((m) => parseDkgCommitmentEvent(m.event)?.phaseNonce).filter(Boolean),
  );
  check(
    'juror 2 published two DIFFERENT commitments in round 2 (stale + live)',
    roundTwoCommits.length >= 2 && phaseNonces.size >= 2,
    { fromVictim: roundTwoCommits.length, phaseNonces: [...phaseNonces].length },
  );

  const honest = roundTwo.filter((_, i) => i + 1 !== 2);
  const replaying = roundTwo[1];
  check(
    'every honest process failed closed on the replayed commitment',
    honest.every((r) => r && r.ok === false && r.classification === 'DKG_DISQUALIFIED'),
    { classifications: honest.map((r) => r?.classification) },
  );
  check(
    'the honest processes blamed the replayer (juror 2)',
    honest.every((r) => r?.blamedIdx === 2),
    { blamed: honest.map((r) => r?.blamedIdx) },
  );
  // The replayer never sees its own traffic, so its local view disagrees with
  // the cohort's. That asymmetry must still fail closed: no signature.
  check(
    'the replayer diverged locally yet still produced no signature',
    replaying && replaying.ok === false && !replaying.signature,
    { classification: replaying?.classification, hasSignature: Boolean(replaying?.signature) },
  );
  check(
    'round 2 produced no signature anywhere',
    roundTwo.every((r) => !r || !r.signature),
    { signatures: roundTwo.map((r) => r?.signature ?? null) },
  );

  return { roundOne, roundTwo };
}

/** One ceremony run under a Byzantine-relay mode, then the mode's assertions. */
async function relayModeRun() {
  const label = `${effectiveMode}${effectiveMode === 'fork' ? `:${forkVariant}` : ''}`
    + `${effectiveMode === 'reorder' ? `:${reorderStyle}` : ''}`;
  console.log(`\n[${label}] ${jurorCount} processes, threshold ${threshold}, relay modes seeded by ${seed.slice(0, 12)}…`);
  if (effectiveMode === 'fork') {
    console.log(`  cohorts: majority=[${cohorts.majority}] minority=[${cohorts.minority}]`);
  }
  if (effectiveMode === 'silence' || (effectiveMode === 'reorder' && reorderStyle === 'invert')) {
    console.log(`  targeted juror: ${victimIdx}`);
  }

  const states = Array.from({ length: jurorCount }, (_, i) => spawnJuror(i + 1));
  await Promise.all(states.map((s) => s.done));

  const roundOne = states.map((s) => reports(s)[0]);
  check('every process reported a round-1 outcome', roundOne.every(Boolean), {
    missing: roundOne.map((r, i) => (r ? null : i + 1)).filter(Boolean),
    stderr: states.map((s) => s.stderr.slice(-200)).filter(Boolean),
  });

  const summary = viewSummary();
  const proof = splitProof(summary);
  const signed = roundOne.filter((r) => r && r.signature);
  const completed = roundOne.filter((r) => r && r.ok);

  const equivocation = assertNoEquivocation(roundOne, label);

  switch (effectiveMode) {
    case 'honest': {
      check(`${label}: every process completed`, completed.length === jurorCount, {
        classifications: roundOne.map((r) => r?.classification),
      });
      check(`${label}: all processes aggregated the SAME signature`, equivocation.signatures.length === 1);
      check(`${label}: the relay delivered every record to every juror`, !proof.differs, proof);
      assertCompletionShape(roundOne, label, 'IDENTICAL');
      break;
    }
    case 'reorder': {
      const perJurorOrder = summary.map((s) => s.order.join(','));
      check(
        `${label}: the relay gave jurors DIFFERENT delivery orders (the mode did something)`,
        new Set(perJurorOrder).size > 1,
        { orders: summary.map((s) => s.order.length) },
      );
      const inverted = [...new Set(
        summary.map((s) => s.order.every((seq, i, arr) => i === 0
          || seq > arr[i - 1]) ? 'ascending' : 'shuffled'),
      )];
      check(
        `${label}: every juror observed a reordered (non globally-ascending) stream or a full stream`,
        inverted.length >= 1,
        { orders: inverted },
      );
      if (reorderStyle === 'invert') {
        // A sender's commit held past its own reveal: `addReveal` needs the
        // commitment stored first, and a reveal that arrives early is dropped
        // and never retried. The peers therefore starve while the targeted
        // juror (which sees its own messages locally) can still aggregate.
        // Finding: order-sensitivity at the reveal gate, no equivocation.
        check(
          `${label}: the inversion was delivered (some juror saw a reveal before its commit)`,
          summary.some((s) => s.delivered > 0),
        );
        check(
          `${label}: at most ONE signature exists — inversion never yields two verdicts`,
          signed.length <= 1,
          { signatures: roundOne.map((r) => r?.signature ?? null) },
        );
        check(
          `${label}: the peers that lost a reveal failed closed and blamed the sender`,
          roundOne.some((r) => r?.ok === false && r.classification === 'SIGN_MISSING_REVEAL'
            && r.blamedIdx === victimIdx),
          { classifications: roundOne.map((r) => r?.classification), blamed: roundOne.map((r) => r?.blamedIdx) },
        );
        check(
          `${label}: every juror either completed or emitted a typed fail-closed classification`,
          roundOne.every((r) => r && (r.ok === true || FAIL_CLOSED_CLASSIFICATIONS.has(r.classification))),
          { classifications: roundOne.map((r) => r?.classification) },
        );
        assertCompletionShape(roundOne, label, 'ANY_SAFE');
      } else {
        check(
          `${label}: reordering did not change the outcome (same group key, one signature)`,
          completed.length === jurorCount
            && new Set(roundOne.map((r) => r.groupPubkeyXOnly)).size === 1
            && equivocation.signatures.length === 1,
          {
            completed: completed.length,
            groupKeys: new Set(roundOne.map((r) => r?.groupPubkeyXOnly)).size,
            signatures: equivocation.signatures.length,
          },
        );
        assertCompletionShape(roundOne, label, 'IDENTICAL');
      }
      break;
    }
    case 'drop': {
      check(`${label}: the relay actually dropped messages (the mode did something)`, stats.dropped > 0, {
        dropped: stats.dropped,
        fraction: Number((stats.dropped / Math.max(1, stats.records * jurorCount)).toFixed(3)),
      });
      check(
        `${label}: every juror either completed or failed closed with a typed classification`,
        roundOne.every((r) => r && (r.ok === true || (r.ok === false && FAIL_CLOSED_CLASSIFICATIONS.has(r.classification)))),
        { classifications: roundOne.map((r) => r?.classification) },
      );
      check(
        `${label}: no juror emitted a signature without completing`,
        roundOne.every((r) => !r || r.ok === true || !r.signature),
        { signatures: roundOne.map((r) => (r?.ok === false ? r?.signature ?? null : null)) },
      );
      check(
        `${label}: any completing jurors agree on ONE key and ONE signature`,
        signed.length === 0
          || (new Set(signed.map((r) => r.groupPubkeyXOnly)).size === 1
            && new Set(signed.map((r) => r.signature)).size === 1),
        { signed: signed.length },
      );
      assertCompletionShape(roundOne, label, 'ANY_SAFE');
      break;
    }
    case 'fork': {
      const splitRecords = log.filter(
        (m) => m.phase !== 'report'
          && cohorts.group(m.from) === 1
          && cohorts.minority.length > 0,
      );
      check(
        `${label}: the relay served DIFFERENT subsets to different jurors (split-view happened)`,
        proof.differs && splitRecords.length > 0,
        proof,
      );
      const crossSeen = summary.some((s) => s.senders.some((f) => cohorts.group(f) !== cohorts.group(s.idx)));
      check(
        `${label}: no juror saw a record from the other cohort`,
        forkVariant === 'sign' || !crossSeen,
        { crossSeen, senders: summary.map((s) => ({ idx: s.idx, senders: s.senders })) },
      );

      if (forkVariant === 'dkg') {
        check(
          `${label}: the split never produced a valid signature (all fail closed)`,
          signed.length === 0,
          { signatures: roundOne.map((r) => r?.signature ?? null) },
        );
        check(
          `${label}: no juror accepted a group key from an incomplete roster`,
          roundOne.every((r) => !r || !r.groupPubkeyXOnly),
          { keys: roundOne.map((r) => r?.groupPubkeyXOnly ?? null) },
        );
        check(
          `${label}: every juror failed closed with DKG_MISSING_PARTICIPANT`,
          roundOne.every((r) => r && r.ok === false && r.classification === 'DKG_MISSING_PARTICIPANT'),
          { classifications: roundOne.map((r) => r?.classification) },
        );
        check(
          `${label}: each juror named at least one missing participant`,
          roundOne.every((r) => r && typeof r.blamedIdx === 'number'),
          { blamed: roundOne.map((r) => r?.blamedIdx) },
        );
      } else {
        // DKG stayed whole, so both cohorts hold the same key; the split lands
        // in the signing phase. `createMyReveal()` refuses while ANY roster
        // participant's nonce commitment is missing, so a split view suppresses
        // reveals on BOTH sides and no aggregate can exist anywhere.
        check(
          `${label}: every juror that reached DKG agrees on ONE group key`,
          new Set(roundOne.map((r) => r?.groupPubkeyXOnly).filter(Boolean)).size === 1,
          { keys: roundOne.map((r) => r?.groupPubkeyXOnly ?? null) },
        );
        check(
          `${label}: the split produced NO signature anywhere (all fail closed)`,
          signed.length === 0,
          { signatures: roundOne.map((r) => r?.signature ?? null) },
        );
        check(
          `${label}: no juror completed: a split view starves the reveal gate`,
          roundOne.every((r) => r && r.ok === false),
          { classifications: roundOne.map((r) => r?.classification) },
        );
        check(
          `${label}: every juror failed closed with a typed classification`,
          roundOne.every((r) => r && FAIL_CLOSED_CLASSIFICATIONS.has(r.classification)),
          { classifications: roundOne.map((r) => r?.classification) },
        );
      }
      assertCompletionShape(roundOne, label, 'ALL_FAILED_CLOSED');
      break;
    }
    case 'replay': {
      check(`${label}: the relay duplicated records (the mode did something)`, stats.duplicated > 0, {
        duplicated: stats.duplicated,
        records: stats.records,
      });
      const dupesSeen = roundOne.map((r) => r?.disclosure?.duplicatesSeen ?? 0);
      check(
        `${label}: every juror observed repeated deliveries and stayed idempotent`,
        dupesSeen.every((n) => Number(n) > 0),
        { dupesSeen },
      );
      check(`${label}: the ceremony still completed everywhere`, completed.length === jurorCount, {
        classifications: roundOne.map((r) => r?.classification),
      });
      check(
        `${label}: exactly ONE signature exists — a duplicate never produced a second`,
        equivocation.signatures.length === 1 && signed.length === jurorCount,
        { distinctSignatures: equivocation.signatures.length, signed: signed.length },
      );
      assertCompletionShape(roundOne, label, 'IDENTICAL');
      break;
    }
    case 'silence': {
      check(`${label}: the relay withheld the targeted juror's traffic`, stats.dropped > 0, {
        dropped: stats.dropped,
      });
      check(
        `${label}: no juror produced a signature`,
        signed.length === 0,
        { signatures: roundOne.map((r) => r?.signature ?? null) },
      );
      const others = roundOne.filter((_, i) => i + 1 !== victimIdx);
      check(
        `${label}: every other juror failed closed and NAMED juror ${victimIdx}`,
        others.every((r) => r && r.ok === false && r.blamedIdx === victimIdx),
        { blamed: others.map((r) => r?.blamedIdx), classifications: others.map((r) => r?.classification) },
      );
      check(
        `${label}: the silenced juror itself also failed closed (it never sees its own echo)`,
        roundOne[victimIdx - 1] && roundOne[victimIdx - 1].ok === false
          && FAIL_CLOSED_CLASSIFICATIONS.has(roundOne[victimIdx - 1].classification),
        { classification: roundOne[victimIdx - 1]?.classification },
      );
      assertCompletionShape(roundOne, label, 'ALL_FAILED_CLOSED');
      break;
    }
    default:
      throw new Error(`unhandled relay mode ${effectiveMode}`);
  }

  return { roundOne, equivocation, summary, proof };
}

// ---------------------------------------------------------------------------
// The mode matrix (every mode, N=3 and N=5) — each cell is its own process
// ---------------------------------------------------------------------------

async function runMatrixCommand() {
  const cells = [];
  for (const n of [3, 5]) {
    cells.push({ n, args: ['--mode=honest'] });
    cells.push({ n, args: ['--mode=reorder'] });
    cells.push({ n, args: ['--mode=drop', '--drop-p=0.2'] });
    cells.push({ n, args: ['--mode=fork', '--fork-variant=dkg'] });
    cells.push({ n, args: ['--mode=fork', '--fork-variant=sign'] });
    cells.push({ n, args: ['--mode=replay'] });
    cells.push({ n, args: ['--mode=silence'] });
  }
  cells.push({ n: 3, args: ['--mode=reorder', '--reorder-style=invert'] });

  const matrixStart = Date.now();
  const results = [];
  console.log(`matrix: ${cells.length} cells (N=3/5 × honest|reorder|drop|fork:dkg|fork:sign|replay|silence + invert)`);

  for (const [index, cell] of cells.entries()) {
    const label = `N=${cell.n} ${cell.args.join(' ')}`;
    const elapsed = Date.now() - matrixStart;
    if (elapsed > matrixBudgetMs) {
      results.push({ label, ok: false, error: `matrix budget exceeded after ${elapsed} ms` });
      console.log(`  FAIL  ${label} — matrix budget exceeded`);
      continue;
    }
    const cellSeed = createHash('sha256')
      .update(`r33-matrix|${cell.n}|${cell.args.join('|')}`)
      .digest('hex');
    const { code, stdout, stderr } = await runSelf([
      `--jurors=${cell.n}`,
      ...cell.args,
      `--seed=${cellSeed}`,
      '--deadline-ms=2500',
      '--budget-ms=120000',
    ]);
    const runDir = /run dir (\S+)/.exec(stdout)?.[1];
    let report = null;
    try {
      report = runDir ? JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) : null;
    } catch {
      report = null;
    }
    const ok = code === 0 && report?.ok === true;
    results.push({
      label,
      ok,
      elapsedMs: report?.elapsedMs ?? null,
      failure: ok ? null : (report?.failures ?? stderr.slice(-500)),
      verdict: report?.equivocation?.verdict ?? null,
      classifications: report?.equivocation?.perJuror?.map((p) => p.classification) ?? null,
    });
    const failureNames = (report?.failures ?? []).map((f) => f.name);
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${label}`
      + `${report?.equivocation ? ` — verdict ${report.equivocation.verdict}` : ''}`
      + `${ok ? '' : ` — ${JSON.stringify(failureNames.length ? failureNames : stderr.slice(-300))}`}`,
    );
  }

  writeFileSync(join(runDir, 'matrix.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nMATRIX RESULT: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${results.length})`}`
    + ` — ${Date.now() - matrixStart} ms`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

function runSelf(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', SELF, ...args],
      { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const report = {
  harness: 'multi-process-ceremony',
  version: 2,
  seed,
  jurorCount,
  threshold,
  chaos,
  relayMode: effectiveMode,
  relayVariant: effectiveMode === 'fork'
    ? { forkVariant }
    : effectiveMode === 'reorder' ? { reorderStyle } : undefined,
  killPhase: chaos === 'kill' ? killPhase : undefined,
  cohorts: effectiveMode === 'fork' ? cohorts : undefined,
  targetedJuror: effectiveMode === 'silence'
    || (effectiveMode === 'reorder' && reorderStyle === 'invert')
    ? victimIdx
    : undefined,
  runDir,
  relay: relayUrl,
  latencyModel: {
    transport: 'HTTP/1.1 over loopback TCP, JSON envelopes, relay-assigned monotonic seq',
    publishJitterMs: '(idx*13 + round*29 + phaseIndex*7) % 41',
    commitmentToSharesGapMs: 150,
    pollIntervalMs: 20,
    phaseDeadlineMs: deadlineMs,
    deliveryPolicy: effectiveMode === 'reorder'
      ? `per-receiver sender ranking, window ${reorderWindowMs} ms (style ${reorderStyle})`
      : effectiveMode,
  },
  doesNotProve: [
    'localhost only: one kernel, one clock, no packet loss, no partitions, no clock skew',
    'the "Byzantine relay" is a delivery policy inside the coordinator process, not another operator\'s box',
    'a relay never forges signatures: content equivocation needs a Byzantine SENDER (chaos=replay)',
    'no Byzantine liveness: one dead or silenced juror aborts the attempt (current protocol behaviour)',
    'share custody is process memory for the duration of the run',
  ],
};

const budgetTimer = setTimeout(() => {
  console.error(`\nFAIL  harness exceeded its ${budgetMs} ms budget`);
  process.exit(1);
}, budgetMs);

try {
  let outcome = null;
  let roundOne = null;
  if (chaos === 'none') {
    if (effectiveMode === 'honest') {
      roundOne = await happyPath();
      const equivocation = assertNoEquivocation(roundOne, 'honest');
      outcome = { roundOne, equivocation };
    } else {
      outcome = await relayModeRun();
      roundOne = outcome.roundOne;
    }
  } else if (chaos === 'kill') {
    await killMidRound();
  } else if (chaos === 'replay') {
    await jurorReplay();
  } else {
    throw new Error(`unknown --chaos=${chaos}`);
  }

  // Machine-readable view of the Byzantine-relay experiment.
  const summary = viewSummary();
  const proof = splitProof(summary);
  const perJuror = (roundOne ?? []).map((r, i) => ({
    idx: i + 1,
    ok: r?.ok ?? null,
    classification: r?.classification ?? null,
    blamedIdx: r?.blamedIdx ?? null,
    groupPubkeyXOnly: r?.groupPubkeyXOnly ? abbr(r.groupPubkeyXOnly) : null,
    signature: r?.signature ? abbr(r.signature) : null,
    message: r?.message ? abbr(r.message) : null,
    duplicatesSeen: r?.disclosure?.duplicatesSeen ?? null,
  }));
  const signedReports = (roundOne ?? []).filter((r) => r && r.signature);
  const distinctMessages = new Set(signedReports.map((r) => r.message)).size;
  const distinctGroupKeys = new Set(signedReports.map((r) => r.groupPubkeyXOnly)).size;
  const distinctSignatures = new Set(signedReports.map((r) => r.signature)).size;
  report.equivocation = {
    verdict: distinctMessages > 1 || distinctGroupKeys > 1 ? 'EQUIVOCATION' : 'NO_EQUIVOCATION',
    completionShape: completionShape(roundOne ?? []),
    distinctMessages,
    distinctGroupKeys,
    distinctSignatures,
    completed: (roundOne ?? []).filter((r) => r && r.ok).length,
    perJuror,
    perJurorView: summary,
    splitView: proof,
    relayStats: stats,
    coordinatorGroupKey: abbr(coordinatorGroupKey()),
  };
  writeFileSync(join(runDir, 'relay-views.json'), JSON.stringify({
    mode: effectiveMode,
    variant: report.relayVariant,
    seed,
    cohorts: effectiveMode === 'fork' ? cohorts : undefined,
    targetedJuror: report.targetedJuror,
    stats,
    perJurorView: summary,
  }, null, 2));

  report.failures = failures;
  report.ok = failures.length === 0;
  report.elapsedMs = Date.now() - started;
  report.relayMessages = log.length;
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));

  if (report.equivocation.perJuror.length > 0) {
    console.log('\nequivocation report (what each juror saw and emitted):');
    for (const p of report.equivocation.perJuror) {
      const view = summary[p.idx - 1];
      console.log(
        `  juror ${p.idx}: saw ${view?.delivered ?? 0} msgs from [${view?.senders ?? []}]`
        + ` → ${p.ok ? 'OK' : p.classification}`
        + `${p.blamedIdx ? ` (blames ${p.blamedIdx})` : ''}`
        + ` key ${p.groupPubkeyXOnly ?? '—'} sig ${p.signature ?? '—'}`
        + `${p.duplicatesSeen ? ` dupes ${p.duplicatesSeen}` : ''}`,
      );
    }
    console.log(`  verdict: ${report.equivocation.verdict}`
      + ` (messages ${distinctMessages}, keys ${distinctGroupKeys}, signatures ${distinctSignatures})`);
  }

  console.log(
    `\n${failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures.length})`}`
    + ` — ${report.elapsedMs} ms, ${log.length} relay messages, run dir ${runDir}`,
  );
  clearTimeout(budgetTimer);
  relay.close();
  process.exit(failures.length === 0 ? 0 : 1);
} catch (error) {
  console.error('harness error:', error);
  clearTimeout(budgetTimer);
  relay.close();
  process.exit(1);
}
