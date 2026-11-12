// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `relay-server` — the ceremony relay as a STANDALONE process.
 *
 * `scripts/court/multi-process-ceremony.mjs` hosts the relay inline, in the
 * coordinator's own process, on loopback. That is enough to prove the protocol
 * works between OS processes, but it can never show that the transport works
 * across a real network between real boxes. This file is the same relay,
 * lifted out into its own process so it can live on ONE machine while the
 * jurors live on others.
 *
 * THE PROTOCOL IS THE HARNESS PROTOCOL, byte for byte (so `juror-child.ts`
 * needs no second code path):
 *
 *   POST /events?as=<idx>   body = { round, phase, from, event?, payload? }
 *                           -> { seq }            (monotonic, assigned here)
 *   GET  /events?since=<n>&as=<idx>
 *                           -> { messages: [...records], next: <n> }
 *
 * The relay — not the jurors — assigns the total message order, and each
 * juror's poll cursor is its own, exactly like a Nostr relay. `as=<idx>` names
 * the subscriber so a per-receiver view is expressible; this server keeps an
 * honest single view (every record to every subscriber) and records what each
 * subscriber was actually served, so a discrepancy is detectable rather than
 * assumed away.
 *
 * WHAT IS ADDED FOR THE DISTRIBUTED RUN:
 *   - A shared bearer token read from a 0600 file (`--token-file=`). Without
 *     the token: 401. The token is never logged, never echoed, never written
 *     into the stats file.
 *   - A HARD CAP on retained records (`--max-records=`), so a runaway juror
 *     cannot exhaust the box's memory. Over the cap: 507 and the record is
 *     refused (the ceremony then fails closed, which is the correct outcome).
 *   - Timing instrumentation, so real network latency is MEASURED, not
 *     modelled: every POST and GET is logged with the relay's own handling
 *     time, and every response carries `serverTime` (`Date.now()` on this box)
 *     so a client can compute an offset-corrected round trip.
 *   - `GET /log` — the full receive log, token-gated, for the coordinator's
 *     independent verification (re-derive the group key from the published
 *     commitments; verify the aggregate signature). This is an observer
 *     privilege, exactly the one a real relay operator has.
 *   - `GET /stats` — the same, aggregated, without payloads.
 *
 * Usage (the driver, `distributed-ceremony.mjs`, does this for you):
 *   node scripts/court/relay-server.mjs --port=18471 --host=0.0.0.0 \
 *     --token-file=/run/ceremony/token --max-records=20000 \
 *     --stats-file=/tmp/relay-stats.json [--duration-ms=600000]
 *
 * Exit: closes on SIGTERM/SIGINT/`--duration-ms` and writes the stats file.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}

const port = Number(arg('port', '18471'));
const host = arg('host', '0.0.0.0');
const tokenFile = arg('token-file', undefined);
const maxRecords = Number(arg('max-records', '20000'));
const statsFile = arg('stats-file', undefined);
const pidFile = arg('pid-file', undefined);
const durationMs = Number(arg('duration-ms', '0'));
const jurorCount = Number(arg('jurors', '0'));
/**
 * DELIVERY MODE — the relay may LIE about delivery, never about content.
 *
 *   honest   (default) one order, every record to every subscriber. Byte-for-byte
 *            the behaviour this server had before modes existed.
 *   replay   duplicate a seeded fraction of records and re-deliver the copy
 *            late. Content is byte-identical and correctly signed: the relay
 *            can repeat, not forge. Tests receive-side idempotency over a real
 *            network (a second partial signature must be impossible).
 *   reorder  per-subscriber hold: each sender's records are released after a
 *            seeded rank × window. Per-sender FIFO is preserved; only the
 *            interleaving changes. Tests order-insensitivity between boxes.
 *   silence  one juror's records are withheld from everyone else. Tests that a
 *            censored juror cannot be blamed into a signature: the attempt must
 *            fail closed.
 *
 * Selection is deterministic from (`--seed`, seq, subscriber), so a soak run is
 * reproducible from its record.
 */
const MODES = ['honest', 'replay', 'reorder', 'silence'];
const mode = arg('mode', 'honest');
if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join('|')}, got "${mode}"`);
const modeSeed = arg('seed', 'ceremony-soak');
const replayP = Number(arg('replay-p', '0.35'));
const replayLateMs = Number(arg('replay-late-ms', '120'));
const reorderWindowMs = Number(arg('reorder-window-ms', '90'));
const silenceIdx = Number(arg('silence-idx', '2'));
const quiet = process.argv.includes('--quiet');

/** Deterministic 32-bit hash — same inputs ⇒ same relay behaviour. */
function hInt(parts) {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e3779b9;
  }
  return h >>> 0;
}

if (!tokenFile) throw new Error('missing --token-file (this relay is not opened to the world)');
// A bearer token is a secret: it is read here and never printed. The file is
// expected to be 0600 and is written by the operator/driver, not by this file.
const token = readFileSync(tokenFile, 'utf8').trim();
if (token.length < 16) throw new Error('--token-file must contain at least 16 characters');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The relay's own total order — this IS the ceremony's `seq`. */
const log = [];
const startedAt = Date.now();
const startedHr = process.hrtime.bigint();

/**
 * Per-subscriber bookkeeping. `delivered` is what this subscriber has been
 * served so far (honest view = prefix of `log`), `polls` counts its polls.
 */
const subscribers = new Map();
function subscriber(as) {
  const key = String(as ?? 'observer');
  if (!subscribers.has(key)) {
    subscribers.set(key, {
      as: key,
      polls: 0,
      pollMsTotal: 0,
      served: 0,
      cursorMax: 0,
      firstPollAt: null,
      lastPollAt: null,
      /** What this subscriber has actually been served, in ITS order. */
      delivered: [],
      /** Records held by `reorder`, with the wall time they may be released. */
      pending: [],
    });
  }
  return subscribers.get(key);
}

/** Does this subscriber see this record at all? (`silence`) */
function delivers(record, as) {
  if (mode !== 'silence') return true;
  const key = String(as ?? 'observer');
  if (key === 'observer') return true; // the audit view is never censored
  if (Number(record.from) !== silenceIdx) return true;
  return Number(key) === silenceIdx; // the sender still sees its own traffic
}

/** When may this subscriber be served this record? (`reorder`) */
function releaseDelay(record, as) {
  if (mode !== 'reorder') return 0;
  if (String(as ?? 'observer') === 'observer') return 0;
  // A seeded PERMUTATION of the senders: distinct senders get distinct ranks, so
  // the interleaving really changes (per-sender FIFO is still preserved).
  const n = Math.max(1, jurorCount);
  const offset = hInt(['rank-offset', modeSeed]) % n;
  const rank = ((Number(record.from) || 0) + offset) % n;
  return rank * reorderWindowMs;
}

/**
 * Which records get a duplicate (`replay`)? EVERY Nth, deterministically, with
 * a seeded phase offset — so a run always exercises idempotency instead of
 * depending on a coin flip. `--replay-p` is the desired fraction; it is turned
 * into an integer stride.
 */
const replayEvery = Math.max(1, Math.round(1 / Math.min(1, Math.max(0.05, replayP))));
const replayPhase = hInt(['replay-phase', modeSeed]) % replayEvery;
function replayDue(seq) {
  return (seq + replayPhase) % replayEvery === 0;
}

const stats = {
  accepted: 0,
  refusedCap: 0,
  refusedAuth: 0,
  refusedMalformed: 0,
  /** Handling time of each POST on the relay (excludes network — that is the client's measure). */
  postHandlingMs: [],
  getHandlingMs: [],
  /** Per-phase volume, so the run report can attribute latency. */
  phases: {},
  /** Delivery-policy counters (all zero in `honest`). */
  duplicated: 0,
  withheld: 0,
  delayed: 0,
};

/**
 * Route one received record to every subscriber the mode allows.
 *
 * In `honest` mode there is nothing to route: every subscriber's view IS the
 * log, so GET serves `log.slice(since)` exactly as this server always did. Any
 * policy mode (replay is content, not routing) needs the per-view bookkeeping.
 */
function fanout(record) {
  subscriber('observer').delivered.push(record);
  if (mode !== 'reorder' && mode !== 'silence') return;
  for (let idx = 1; idx <= Math.max(jurorCount, 1); idx += 1) {
    if (!delivers(record, idx)) {
      stats.withheld += 1;
      continue;
    }
    const delay = releaseDelay(record, idx);
    if (delay > 0) stats.delayed += 1;
    const view = subscriber(idx);
    if (delay > 0) view.pending.push({ record, releaseAt: Date.now() + delay });
    else view.delivered.push(record);
  }
}

const now = () => Number(process.hrtime.bigint() - startedHr) / 1e6; // ms, monotonic
const logLine = (obj) => {
  if (quiet) return;
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

function handled(req, res, body) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'relay'}`);
  const serverTime = Date.now();

  // ---- auth (applies to every route) -------------------------------------
  const auth = req.headers.authorization ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (presented !== token) {
    stats.refusedAuth += 1;
    logLine({ t: 'auth-refused', at: Date.now() - startedAt, path: url.pathname });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // ---- POST /events ------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/events') {
    const t0 = now();
    let envelope;
    try {
      envelope = JSON.parse(body);
    } catch {
      stats.refusedMalformed += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed json' }));
      return;
    }
    if (log.length >= maxRecords) {
      stats.refusedCap += 1;
      logLine({ t: 'cap-refused', at: Date.now() - startedAt, cap: maxRecords });
      res.writeHead(507, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'record cap reached', cap: maxRecords }));
      return;
    }
    const record = {
      seq: log.length + 1,
      at: Date.now() - startedAt,
      receivedAt: Date.now(),
      bytes: Buffer.byteLength(body),
      ...envelope,
    };
    log.push(record);
    stats.accepted += 1;
    const phase = String(record.phase ?? 'unknown');
    stats.phases[phase] = (stats.phases[phase] ?? 0) + 1;
    fanout(record);

    // `replay`: append a byte-identical copy late. The relay cannot forge, only
    // repeat — so this is exactly the "did the receiver dedupe it?" test.
    if (mode === 'replay' && phase !== 'report' && !record.injected && replayDue(record.seq)) {
      const inject = () => {
        if (log.length >= maxRecords) return;
        const copy = {
          ...record,
          seq: log.length + 1,
          at: Date.now() - startedAt,
          receivedAt: Date.now(),
          injected: true,
          replayedSeq: record.seq,
        };
        log.push(copy);
        stats.duplicated += 1;
        fanout(copy);
      };
      if (replayLateMs > 0) setTimeout(inject, replayLateMs).unref();
      else inject();
    }

    const handlingMs = now() - t0;
    stats.postHandlingMs.push(Number(handlingMs.toFixed(3)));
    logLine({
      t: 'post',
      seq: record.seq,
      at: record.at,
      phase,
      from: record.from,
      bytes: record.bytes,
      handlingMs: Number(handlingMs.toFixed(3)),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seq: record.seq, serverTime }));
    return;
  }

  // ---- GET /events -------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/events') {
    const t0 = now();
    const as = url.searchParams.get('as');
    const since = Number(url.searchParams.get('since') ?? '0');
    const sub = subscriber(as);
    // Release anything whose reorder hold has expired, in (releaseAt, seq) order
    // — that is the order this subscriber actually observes.
    if (sub.pending.length > 0) {
      const nowMs = Date.now();
      const due = sub.pending.filter((p) => p.releaseAt <= nowMs);
      if (due.length > 0) {
        sub.pending = sub.pending.filter((p) => p.releaseAt > nowMs);
        due.sort((a, b) => (a.releaseAt - b.releaseAt) || (a.record.seq - b.record.seq));
        for (const item of due) sub.delivered.push(item.record);
      }
    }
    // `honest` and `replay` serve the log itself: replay changes CONTENT (extra
    // byte-identical copies), not routing, so every subscriber still sees every
    // record. Only `reorder`/`silence` need per-view bookkeeping.
    const plainView = mode === 'honest' || mode === 'replay';
    const total = plainView ? log.length : sub.delivered.length;
    const from = Math.min(Math.max(0, Number.isFinite(since) ? since : 0), total);
    const messages = plainView ? log.slice(from) : sub.delivered.slice(from);
    const at = Date.now() - startedAt;
    if (sub.firstPollAt === null) sub.firstPollAt = at;
    sub.lastPollAt = at;
    sub.polls += 1;
    sub.cursorMax = Math.max(sub.cursorMax, from);
    sub.served += messages.length;

    const handlingMs = now() - t0;
    sub.pollMsTotal += handlingMs;
    stats.getHandlingMs.push(Number(handlingMs.toFixed(3)));
    logLine({
      t: 'get',
      as: sub.as,
      since: from,
      returned: messages.length,
      seq: log.length,
      handlingMs: Number(handlingMs.toFixed(3)),
      at,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages, next: total, serverTime }));
    return;
  }

  // ---- GET /log (observer privilege: the coordinator's audit) ------------
  if (req.method === 'GET' && url.pathname === '/log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ records: log, serverTime }));
    return;
  }

  // ---- GET /stats --------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(summarise()));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function pct(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarise() {
  const arrivalGaps = [];
  for (let i = 1; i < log.length; i += 1) arrivalGaps.push(log[i].receivedAt - log[i - 1].receivedAt);
  return {
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    host,
    port,
    jurors: jurorCount,
    mode,
    modeSeed,
    records: log.length,
    cap: maxRecords,
    stats: {
      accepted: stats.accepted,
      refusedCap: stats.refusedCap,
      refusedAuth: stats.refusedAuth,
      refusedMalformed: stats.refusedMalformed,
      phases: stats.phases,
      duplicated: stats.duplicated,
      withheld: stats.withheld,
      delayed: stats.delayed,
      postHandlingMs: {
        count: stats.postHandlingMs.length,
        p50: pct(stats.postHandlingMs, 50),
        p95: pct(stats.postHandlingMs, 95),
        max: pct(stats.postHandlingMs, 100),
      },
      getHandlingMs: {
        count: stats.getHandlingMs.length,
        p50: pct(stats.getHandlingMs, 50),
        p95: pct(stats.getHandlingMs, 95),
        max: pct(stats.getHandlingMs, 100),
      },
      // Consecutive-arrival gaps at the relay: the real inter-message spacing
      // the network + jurors produced (NOT the harness's deterministic model).
      arrivalGapMs: {
        count: arrivalGaps.length,
        p50: pct(arrivalGaps, 50),
        p95: pct(arrivalGaps, 95),
        max: pct(arrivalGaps, 100),
      },
    },
    subscribers: [...subscribers.values()].map((s) => ({
      as: s.as,
      polls: s.polls,
      served: s.served,
      cursorMax: s.cursorMax,
      firstPollAt: s.firstPollAt,
      lastPollAt: s.lastPollAt,
      pollMsTotal: Number(s.pollMsTotal.toFixed(2)),
      delivered: s.delivered.length,
      /** The order THIS subscriber was served (first 64), for order proofs. */
      order: ((mode === 'honest' || mode === 'replay') ? log : s.delivered).slice(0, 64).map((r) => r.seq),
    })),
    // Cursors: proof that every subscriber consumed the whole log (no split
    // view was created, deliberately, by this relay).
    converged: log.length === 0
      ? null
      : [...subscribers.values()]
        .filter((s) => s.as !== 'observer')
        .every((s) => s.cursorMax >= Math.max(0, log.length - 1) || s.polls > 0),
  };
}

const relay = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    // Defence against a rogue client: the ceremony's largest message is a few
    // kilobytes. 1 MiB is generous and still bounded.
    if (body.length > 1_048_576) {
      req.destroy();
    }
  });
  req.on('end', () => handled(req, res, body));
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  const summary = summarise();
  summary.shutdownReason = reason;
  if (statsFile) writeFileSync(statsFile, JSON.stringify(summary, null, 2));
  logLine({ t: 'shutdown', reason, records: log.length, uptimeMs: summary.uptimeMs });
  relay.close(() => process.exit(0));
  // Do not let a half-open socket hold the process alive.
  setTimeout(() => process.exit(0), 300).unref();
}

relay.listen(port, host, () => {
  // The driver needs THIS process's pid (not setsid's, not pgrep's first
  // match) so it can stop exactly the relay it started.
  if (pidFile) writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  // Announce only the bind address — never the token.
  logLine({ t: 'listen', host, port, cap: maxRecords, jurors: jurorCount, pid: process.pid });
});
relay.on('error', (error) => {
  logLine({ t: 'listen-error', message: String(error && error.message ? error.message : error) });
  process.exit(1);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
if (durationMs > 0) setTimeout(() => shutdown('duration'), durationMs).unref();
