// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `multi-process-ceremony` — the closest-to-distributed ceremony we can run
 * on one machine.
 *
 * WHAT IS REAL (and this is the point of the harness):
 *   - N separate OS PROCESSES (`child_process.fork`-style spawn of
 *     `juror-child.ts`), each with its own PID, heap, secret identity, and
 *     state directory under the run dir. No shared memory, no shared state
 *     object, no in-process call graph between jurors.
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
 *     loss, no partitions, no clock skew, no relay censorship/equivocation,
 *     no OS scheduler failure, no disk failure.
 *   - The relay here is honest and always available; a Byzantine relay is
 *     covered by the transport suites (inbox/outbox) and by peer-side
 *     verification, not by this harness.
 *   - Consensus is not Byzantine-fault-tolerant liveness here: one dead juror
 *     stalls the round until the deadline and the attempt aborts. That is the
 *     CURRENT protocol's behaviour (DKG requires the full certified roster),
 *     not a property this harness adds.
 *   - It says nothing about key custody: shares live in process memory for
 *     the duration of the run.
 *
 * Usage:
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=3            # happy path
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --chaos=kill --kill-phase=sign
 *   tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --chaos=replay
 *
 * Exit code 0 = every assertion passed; 1 = a specific assertion failed
 * (printed with its name). Writes `<run-dir>/report.json`.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { parseDkgCommitmentEvent } from '../../eventsParse';
import { verifyFinalSignature, buildAttestationMessage } from '../../crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
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

const jurorCount = Number(arg('jurors', '3'));
const threshold = Number(arg('threshold', String(Math.floor(jurorCount / 2) + 1)));
const chaos = arg('chaos', 'none'); // none | kill | replay
const killPhase = arg('kill-phase', 'sign'); // dkg | sign
const budgetMs = Number(arg('budget-ms', '300000'));
/** Per-phase wait bound inside each juror process (documented latency model). */
const deadlineMs = Number(arg('deadline-ms', '10000'));
const seed = arg('seed', randomBytes(32).toString('hex'));
const runDir = mkdtempSync(join(tmpdir(), 'bao-court-r30-'));

if (jurorCount < 3 || jurorCount > 7) {
  throw new Error('--jurors must be between 3 and 7 (the campaign range)');
}

// ---------------------------------------------------------------------------
// The relay: an honest, ordered, append-only bulletin over real HTTP
// ---------------------------------------------------------------------------

const log = [];
const started = Date.now();
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
        onRelayMessage?.(record);
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
    const since = Number(url.searchParams.get('since') ?? '0');
    const messages = log.filter((m) => m.seq > since);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages, next: log.length }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

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
// Scenario runners
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
    recomputed.toHex(true).slice(2) === groupKey,
    { recomputed: recomputed.toHex(true), reported: groupKey },
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

async function replay() {
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const report = {
  harness: 'multi-process-ceremony',
  version: 1,
  seed,
  jurorCount,
  threshold,
  chaos,
  killPhase: chaos === 'kill' ? killPhase : undefined,
  runDir,
  relay: relayUrl,
  latencyModel: {
    transport: 'HTTP/1.1 over loopback TCP, JSON envelopes, relay-assigned monotonic seq',
    publishJitterMs: '(idx*13 + round*29 + phaseIndex*7) % 41',
    commitmentToSharesGapMs: 150,
    pollIntervalMs: 20,
    phaseDeadlineMs: deadlineMs,
  },
  doesNotProve: [
    'localhost only: one kernel, one clock, no packet loss, no partitions, no clock skew',
    'the relay is honest and always available (Byzantine relays are covered by the transport suites)',
    'no Byzantine liveness: one dead juror aborts the attempt (current protocol behaviour)',
    'share custody is process memory for the duration of the run',
  ],
};

const budgetTimer = setTimeout(() => {
  console.error(`\nFAIL  harness exceeded its ${budgetMs} ms budget`);
  process.exit(1);
}, budgetMs);

try {
  if (chaos === 'none') await happyPath();
  else if (chaos === 'kill') await killMidRound();
  else if (chaos === 'replay') await replay();
  else throw new Error(`unknown --chaos=${chaos}`);

  report.failures = failures;
  report.ok = failures.length === 0;
  report.elapsedMs = Date.now() - started;
  report.relayMessages = log.length;
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));

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
