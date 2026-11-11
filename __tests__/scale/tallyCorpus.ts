// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 2 — plurality-tally sweep at scale.
 *
 * Every tally is a REAL production finalize: a valid `reveal_closed` vote
 * machine state is finalized through the public reducer (`finalize_tally`), so
 * the production plurality loop, the protocol tie-break, the canonical
 * verdict hash, and the ledger barrier (`assertValidRevealLedger`, which
 * re-derives every commit and re-checks roster membership) all run per case.
 *
 * The oracle is the INDEPENDENT reduce-based reference
 * (`__tests__/reference/refTally.ts`) — a different code shape at every step
 * (reduce-built count map, reduce-based winner, `Buffer.compare` UTF-8 byte
 * ordering), never a production call-through.
 *
 * Coverage:
 *   - outcome sets of 2..8 outcomes drawn from a pool that contains the
 *     UTF-16/UTF-8 DIVERGENCE pairs (`'😀'` U+1F600 vs `'\uFFFF'`, and
 *     U+10FFFF vs U+FFFF). JavaScript's default string order compares UTF-16
 *     code units, so a tie-break written with `<` picks the wrong winner for
 *     exactly these pairs — the campaign forces ties among them.
 *   - ledger sizes 2..50 with a skewed distribution (median 5, mean ≈ 12, tail
 *     at 50), plus the boundary sizes 2, 3, 49, 50 forced in every run.
 *   - 40% of tallies are constructed as EXACT ties across 2..k outcomes, so
 *     the tie-break is exercised far above its natural rate.
 *
 * Assertions per tally: same winner, same supporting-event-id sequence
 * (sorted, duplicate-free) as the oracle; on a 1% sample the canonical
 * verdict hash must also recompute.
 *
 * PERFORMANCE NOTE (documented in docs/benchmarks/SCALE_CAMPAIGN.md): the
 * ledger is assembled directly (a legal ledger that the production barrier
 * fully re-verifies) instead of replaying `accept_commit`/`accept_reveal` per
 * participant — the replay path is quadratic in ledger size and would cap the
 * corpus at ~10³ tallies. A CONTROL SAMPLE of fully-driven tallies (commit +
 * reveal events, no shortcut) runs in every invocation against the same
 * oracle, so the end-to-end path is covered too.
 */

import {
  CourtVoteTransitionError,
  createCourtVoteMachine,
  hashCourtVerdict,
  hashCourtVoteCommit,
  reduceCourtVoteMachine,
  type CourtVoteMachineState,
} from '../../courtVoteMachine';
import { refPluralityTally } from '../reference/refTally';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, type CampaignResult } from './corpus';

/** Session hash for every tally (the binding the ledger barrier re-derives). */
const SESSION_HASH = '11'.repeat(32);
const COMMIT_DEADLINE = 100;
const REVEAL_DEADLINE = 200;

/**
 * Outcome pool. The last four entries are the UTF-16/UTF-8 tie-break
 * divergence set: `'😀'` (U+1F600) sorts BEFORE `'\uFFFF'` in UTF-16 code-unit
 * order but AFTER it in UTF-8 byte order; U+10FFFF is the mirror case.
 */
const OUTCOMES = ['YES', 'NO', 'A', 'a', 'é', '日本', '😀', '\uFFFF', '\uFFFD', '\u{10FFFF}'] as const;
/** Members whose relative order differs between UTF-16 code units and UTF-8 bytes. */
const DIVERGENT_OUTCOMES: readonly string[] = ['😀', '\uFFFF', '\u{10FFFF}', '\uFFFD'];

/** FNV-1a of an outcome label (memoised) — a stable per-outcome salt seed. */
const outcomeDigest = new Map<string, string>();
function digestOf(outcome: string): string {
  const cached = outcomeDigest.get(outcome);
  if (cached !== undefined) return cached;
  let hash = 0x811c9dc5;
  for (let i = 0; i < outcome.length; i += 1) {
    hash ^= outcome.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const digest = (hash >>> 0).toString(16).padStart(8, '0');
  outcomeDigest.set(outcome, digest);
  return digest;
}

/** Salt for (outcome, participant): 64 lowercase hex chars, stable across tallies. */
function saltFor(outcome: string, idx: number): string {
  return (`a${digestOf(outcome)}${idx.toString(16).padStart(8, '0')}`).padEnd(64, 'a');
}

/** Reveal event id for one participant: unique inside its ledger, 64 lowercase hex. */
function eventIdFor(idx: number): string {
  return `e${idx.toString(16).padStart(8, '0')}`.padEnd(64, 'e');
}

/** Commit event id (distinct namespace from the reveal id). */
function commitEventIdFor(idx: number): string {
  return `c${idx.toString(16).padStart(8, '0')}`.padEnd(64, 'c');
}

/** One tally case as drawn: the ledger assignment plus its ballot. */
interface TallyCase {
  readonly rosterSize: number;
  readonly outcomes: readonly string[];
  readonly assignment: readonly string[];
  readonly forcedTie: boolean;
}

/** Draw one tally case from stream `r` (optionally with a forced ledger size). */
function drawTally(r: () => number, forcedSize?: number): TallyCase {
  // Skewed ledger size: median 5, mean ≈ 12, tail 50 (r^4).
  const rosterSize = forcedSize ?? 2 + Math.floor(r() ** 4 * 48);
  const outcomeCount = int(r, 2, Math.min(8, Math.max(2, rosterSize)));
  const forcedTie = forcedSize === undefined && r() < 0.4;
  const pool = r() < 0.5 ? DIVERGENT_OUTCOMES : OUTCOMES;
  const start = int(r, 0, pool.length - 1);
  const distinct: string[] = [];
  for (let offset = 0; offset < pool.length && distinct.length < outcomeCount; offset += 1) {
    const candidate = pool[(start + offset) % pool.length]!;
    if (!distinct.includes(candidate)) distinct.push(candidate);
  }
  // A 2..8 request can outrun the (smaller) divergent pool — top up.
  for (const extra of OUTCOMES) {
    if (distinct.length >= outcomeCount) break;
    if (!distinct.includes(extra)) distinct.push(extra);
  }

  const assignment: string[] = new Array<string>(rosterSize);
  if (forcedTie) {
    // EXACT tie: split evenly across the ballot — the protocol tie-break alone
    // decides the winner, which is precisely what this campaign pins.
    for (let i = 0; i < rosterSize; i += 1) assignment[i] = distinct[i % distinct.length]!;
  } else {
    for (let i = 0; i < rosterSize; i += 1) assignment[i] = distinct[int(r, 0, distinct.length - 1)]!;
  }
  return { rosterSize, outcomes: distinct, assignment, forcedTie };
}

/** Cached `reveal_closed` base states, keyed by (roster size, ballot). */
const revealClosedCache = new Map<string, CourtVoteMachineState>();
function revealClosedState(rosterSize: number, outcomes: readonly string[]): CourtVoteMachineState {
  const key = `${rosterSize}|${outcomes.join('\u0000')}`;
  const cached = revealClosedCache.get(key);
  if (cached !== undefined) return cached;
  let state = createCourtVoteMachine({
    sessionHash: SESSION_HASH,
    participantIndices: Array.from({ length: rosterSize }, (_, i) => i + 1),
    allowedOutcomes: [...outcomes],
    commitDeadline: COMMIT_DEADLINE,
    revealDeadline: REVEAL_DEADLINE,
  });
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: COMMIT_DEADLINE });
  state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: COMMIT_DEADLINE + 1 });
  state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
  revealClosedCache.set(key, state);
  return state;
}

/** Memoised commit hash per (outcome, participant) — the barrier re-derives the same value. */
const commitCache = new Map<string, string>();
function commitHashFor(outcome: string, idx: number): string {
  const key = `${idx}\u0000${outcome}`;
  const cached = commitCache.get(key);
  if (cached !== undefined) return cached;
  const hash = hashCourtVoteCommit({ sessionHash: SESSION_HASH, outcome, salt: saltFor(outcome, idx) });
  commitCache.set(key, hash);
  return hash;
}

/** The oracle's view of one ledger (same records the machine tallies). */
function oracleFor(testCase: TallyCase): { outcome: string; eventIds: readonly string[] } {
  return refPluralityTally(
    testCase.assignment.map((outcome, offset) => ({ outcome, eventId: eventIdFor(offset + 1) })),
  );
}

/** A fully-driven tally through EVERY vote-machine event (the control path). */
function driveFullTally(testCase: TallyCase): { outcome: string; supportingEventIds: readonly string[] } {
  let state = createCourtVoteMachine({
    sessionHash: SESSION_HASH,
    participantIndices: Array.from({ length: testCase.rosterSize }, (_, i) => i + 1),
    allowedOutcomes: [...testCase.outcomes],
    commitDeadline: COMMIT_DEADLINE,
    revealDeadline: REVEAL_DEADLINE,
  });
  for (let idx = 1; idx <= testCase.rosterSize; idx += 1) {
    state = reduceCourtVoteMachine(state, {
      type: 'accept_commit',
      idx,
      commitHash: hashCourtVoteCommit({ sessionHash: SESSION_HASH, outcome: testCase.assignment[idx - 1]!, salt: saltFor(testCase.assignment[idx - 1]!, idx) }),
      eventId: commitEventIdFor(idx),
      now: 10,
    });
  }
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: COMMIT_DEADLINE });
  state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: COMMIT_DEADLINE + 1 });
  for (let idx = 1; idx <= testCase.rosterSize; idx += 1) {
    const outcome = testCase.assignment[idx - 1]!;
    state = reduceCourtVoteMachine(state, {
      type: 'accept_reveal',
      idx,
      outcome,
      salt: saltFor(outcome, idx),
      eventId: eventIdFor(idx),
      now: COMMIT_DEADLINE + 2,
    });
  }
  state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
  state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: REVEAL_DEADLINE });
  if (!state.verdict) throw new Error('control tally did not produce a verdict');
  return state.verdict;
}

/**
 * Run the tally campaign.
 *
 * @param opts.size          number of tallies in the corpus
 * @param opts.seed          campaign seed
 * @param opts.controlSample fully-driven control tallies per invocation
 */
export function runTallyCampaign(opts: {
  readonly size: number;
  readonly seed?: number;
  readonly controlSample?: number;
}): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const controlSample = opts.controlSample ?? 200;
  const started = nowMs();
  const reporter = new CampaignReporter('tally', 'tallies', opts.size, seed);
  const r = childRng(seed, 'tally-campaign');

  const metrics = {
    tiesForced: 0,
    tiesObserved: 0,
    divergentOutcomeSets: 0,
    ledgerEntries: 0,
    maxLedger: 0,
    minLedger: Number.MAX_SAFE_INTEGER,
    verdictHashSamples: 0,
    controlTallies: 0,
    nonAsciiWinners: 0,
  };

  for (let index = 0; index < opts.size; index += 1) {
    // Forced boundary sizes open every run so the extremes are never left to
    // the draw's tail.
    const forcedSize = index < 4 ? ([2, 3, 49, 50] as const)[index] : undefined;
    const testCase = drawTally(r, forcedSize);
    const label = `tally#${index}`;

    const reveals: Array<{ idx: number; outcome: string; salt: string; eventId: string }> = [];
    const commits: Array<{ idx: number; commitHash: string; eventId: string }> = [];
    for (let idx = 1; idx <= testCase.rosterSize; idx += 1) {
      const outcome = testCase.assignment[idx - 1]!;
      reveals.push({ idx, outcome, salt: saltFor(outcome, idx), eventId: eventIdFor(idx) });
      commits.push({ idx, commitHash: commitHashFor(outcome, idx), eventId: commitEventIdFor(idx) });
    }

    const base = revealClosedState(testCase.rosterSize, testCase.outcomes);
    let verdictOutcome: string;
    let verdictIds: readonly string[];
    let verdictHash: string;
    try {
      const final = reduceCourtVoteMachine(
        { ...base, commits, reveals } as CourtVoteMachineState,
        { type: 'finalize_tally', now: REVEAL_DEADLINE },
      );
      if (!final.verdict) {
        reporter.fail(label, 'finalize_tally returned without a verdict');
        continue;
      }
      verdictOutcome = final.verdict.outcome;
      verdictIds = final.verdict.supportingEventIds;
      verdictHash = final.verdict.verdictHash;
    } catch (err) {
      const typed = err instanceof CourtVoteTransitionError ? '' : ' (UNTYPED: expected CourtVoteTransitionError)';
      reporter.fail(
        label,
        `finalize_tally threw on a legal ledger${typed}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      continue;
    }

    // INDEPENDENT oracle: reduce-based tally + Buffer.compare UTF-8 ordering.
    const reference = oracleFor(testCase);
    reporter.equals(label, verdictOutcome, reference.outcome, 'winner must match the independent reduce-based oracle');
    reporter.equalStrings(label, [...verdictIds], [...reference.eventIds], 'supporting event ids must match the oracle exactly (sorted UTF-8 byte order)');

    // 1% sample: the canonical verdict hash must also recompute.
    if (index % 100 === 0) {
      metrics.verdictHashSamples += 1;
      reporter.equals(
        label,
        verdictHash,
        hashCourtVerdict({ sessionHash: SESSION_HASH, outcome: verdictOutcome, supportingEventIds: verdictIds }),
        'sampled verdict hash must recompute from (session, outcome, supporting ids)',
      );
    }

    metrics.ledgerEntries += testCase.rosterSize;
    metrics.maxLedger = Math.max(metrics.maxLedger, testCase.rosterSize);
    metrics.minLedger = Math.min(metrics.minLedger, testCase.rosterSize);
    if (testCase.forcedTie) {
      metrics.tiesForced += 1;
    }
    if (isTied(reference.eventIds.length, testCase, reference.outcome)) metrics.tiesObserved += 1;
    if (testCase.outcomes.some((outcome) => DIVERGENT_OUTCOMES.includes(outcome))) metrics.divergentOutcomeSets += 1;
    if (!/^[\x20-\x7e]*$/.test(verdictOutcome)) metrics.nonAsciiWinners += 1;
  }

  // Control sample: the complete commit → reveal → finalize path, same oracle.
  const controlRng = childRng(seed, 'tally-control');
  for (let index = 0; index < controlSample; index += 1) {
    const testCase = drawTally(controlRng, index < 4 ? ([2, 3, 9, 12] as const)[index] : 2 + Math.floor(controlRng() ** 3 * 16));
    const label = `tally-control#${index}`;
    let built: { outcome: string; supportingEventIds: readonly string[] };
    try {
      built = driveFullTally(testCase);
    } catch (err) {
      reporter.fail(label, `fully-driven tally threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      continue;
    }
    const reference = oracleFor(testCase);
    reporter.equals(label, built.outcome, reference.outcome, 'control: fully-driven winner must match the oracle');
    reporter.equalStrings(label, [...built.supportingEventIds], [...reference.eventIds], 'control: fully-driven supporting ids must match the oracle');
    metrics.controlTallies += 1;
  }

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      ...metrics,
      meanLedger: Math.round((metrics.ledgerEntries / Math.max(1, opts.size)) * 100) / 100,
      talliesPerSecond: Math.round((opts.size / Math.max(1, wallMs)) * 1000),
    },
    [
      'ledger assembled directly (valid; the production ledger barrier re-verifies every record); control sample drives every event',
      'tie-break pool includes the UTF-16/UTF-8 divergence pairs (U+1F600 vs U+FFFF, U+10FFFF vs U+FFFF)',
      'ledger sizes: skewed 2..50 (median 5, mean ~12) with forced 2/3/49/50 boundaries',
    ],
  );
}

/** True when another outcome ties the winner's count, i.e. the tie-break decided. */
function isTied(winnerCount: number, testCase: TallyCase, winner: string): boolean {
  const counts = new Map<string, number>();
  for (const outcome of testCase.assignment) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  for (const [outcome, count] of counts) {
    if (outcome !== winner && count === winnerCount) return true;
  }
  return false;
}
