// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Property-based invariant sweep (security round 3) — universal-confirmation
 * machine.
 *
 * Deterministic seeded generators (mulberry32 LCG — no new dependencies)
 * drive random LEGAL event sequences (random rosters 2..25, random outcome
 * sets 2..5, random challenge/ladder interleavings) through the machine and
 * assert, after EVERY transition:
 *
 *   P1  the reducer never throws on a legal sequence;
 *   P2  terminal phases are only { final, expired, aborted };
 *   P3  every 'final' verdict recomputes: verdictHash === hashCourtVerdict(...),
 *       supporting ids are non-empty, sorted, drawn from the correct ledger,
 *       and upheld === (outcome === proposedOutcome);
 *   P4  latestTimestamp is monotonic non-decreasing and equals the greatest
 *       accepted event timestamp (abort carries no clock);
 *   P5  freeze holds: the exported state object and every nested ledger,
 *       record, verdict, and failure object satisfy Object.isFrozen;
 *   P6  hostile / out-of-place events fail closed with the TYPED
 *       CourtConfirmationTransitionError — a raw Error/TypeError/RangeError
 *       (or a foreign error class) escaping the reducer is a finding.
 */

import { describe, expect, it } from 'vitest';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { hashCourtVerdict, CourtVoteTransitionError } from '../courtVoteMachine';

// ─── seeded LCG (mulberry32) ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX_DIGITS = '0123456789abcdef';
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const hex32 = (r: () => number): string =>
  Array.from({ length: 64 }, () => HEX_DIGITS[Math.floor(r() * 16)]).join('');

const TERMINAL_PHASES = new Set(['final', 'expired', 'aborted']);
const ALL_PHASES = [
  'confirm_open', 'confirm_closed', 'challenge_window', 'ladder_pending',
  'ladder_vote_open', 'ladder_vote_closed', 'fee_settlement',
  'final', 'expired', 'aborted',
];

// ─── P5: freeze discipline ──────────────────────────────────────────────────

function assertFullyFrozen(state: CourtConfirmationMachineState): void {
  expect(Object.isFrozen(state)).toBe(true);
  const ledgerKeys = [
    'confirmations', 'challenges', 'clawbackFlags', 'fees',
    'participantIndices', 'allowedOutcomes', 'evidenceIds',
  ] as const;
  for (const key of ledgerKeys) {
    const ledger = state[key];
    expect(Object.isFrozen(ledger)).toBe(true);
    for (const record of ledger) expect(Object.isFrozen(record)).toBe(true);
  }
  if (state.ladder) {
    expect(Object.isFrozen(state.ladder)).toBe(true);
    expect(Object.isFrozen(state.ladder.votes)).toBe(true);
    for (const vote of state.ladder.votes) expect(Object.isFrozen(vote)).toBe(true);
  }
  if (state.verdict) {
    expect(Object.isFrozen(state.verdict)).toBe(true);
    expect(Object.isFrozen(state.verdict.supportingEventIds)).toBe(true);
  }
  if (state.failure) expect(Object.isFrozen(state.failure)).toBe(true);
}

// ─── P6: hostile probes fail closed with the TYPED error ────────────────────

function expectTypedError(
  state: CourtConfirmationMachineState,
  event: unknown,
  label: string,
  log: string,
): void {
  let thrown: unknown;
  try {
    reduceCourtConfirmationMachine(state, event as CourtConfirmationMachineEvent);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `probe ${label} did not throw; sequence:\n${log}`).toBeInstanceOf(
    CourtConfirmationTransitionError,
  );
  expect(
    (thrown as Error).name,
    `probe ${label} threw a non-typed error; sequence:\n${log}`,
  ).toBe('CourtConfirmationTransitionError');
}

function runHostileProbes(state: CourtConfirmationMachineState, log: string): void {
  if (TERMINAL_PHASES.has(state.phase)) {
    // Terminal states reject everything except the tick no-op: abort and
    // value-bearing events are both refused.
    expectTypedError(state, { type: 'abort', reason: 'probe' }, 'abort-from-terminal', log);
    expectTypedError(state, { type: 'finalize', now: state.latestTimestamp }, 'finalize-after-terminal', log);
    // …and the tick no-op from a terminal phase is legal and returns frozen state.
    const ticked = reduceCourtConfirmationMachine(state, { type: 'tick', now: state.latestTimestamp });
    expect(Object.isFrozen(ticked)).toBe(true);
    expect(ticked.phase).toBe(state.phase);
    return;
  }
  // Clock regression is always rejected…
  expectTypedError(state, { type: 'tick', now: state.latestTimestamp - 1 }, 'clock-regression', log);
  // …null and unknown events are rejected…
  expectTypedError(state, null, 'null-event', log);
  expectTypedError(state, { type: 'definitely_not_an_event' }, 'unknown-type', log);
  // …a hand-tampered (non-array) ledger is rejected…
  expectTypedError(
    { ...state, confirmations: 'tampered' } as unknown as CourtConfirmationMachineState,
    { type: 'tick', now: state.latestTimestamp },
    'tampered-ledger',
    log,
  );
  // …finalize out of phase is rejected…
  if (state.phase !== 'fee_settlement') {
    expectTypedError(state, { type: 'finalize', now: state.latestTimestamp }, 'finalize-out-of-phase', log);
  }
  // …and a confirmation with a wrong canonical hash is rejected in every phase.
  expectTypedError(
    state,
    {
      type: 'accept_confirmation',
      idx: state.participantIndices[0]!,
      confirmHash: '00'.repeat(32),
      eventId: '11'.repeat(32),
      now: state.latestTimestamp,
    },
    'wrong-confirm-hash',
    log,
  );
}

// ─── legal-sequence generator ───────────────────────────────────────────────

interface SequenceContext {
  r: () => number;
  clock: number;
  participantIndices: readonly number[];
  allowedOutcomes: readonly string[];
  newEventId: () => string;
}

interface SequenceStats {
  steps: number;
  terminal: 'final' | 'expired' | 'aborted' | 'open';
  ladderReached: boolean;
  overturned: boolean;
}

function runSequence(seed: number, maxSteps = 90): SequenceStats {
  const r = mulberry32(seed);
  const rosterSize = int(r, 2, 25);
  const participantIndices = Array.from({ length: rosterSize }, (_, i) => i + 1);
  const allowedOutcomes = Array.from({ length: int(r, 2, 5) }, (_, i) => `outcome-${i}`);
  const proposedOutcome = pick(r, allowedOutcomes);
  const confirmQuorum = int(r, 1, rosterSize);
  const base = int(r, 1_700_000_000, 1_800_000_000);
  const confirmDeadline = base + int(r, 1, 2_000);
  const challengeDeadline = confirmDeadline + int(r, 1, 5_000);

  const usedEventIds = new Set<string>();
  const newEventId = (): string => {
    let id = hex32(r);
    while (usedEventIds.has(id)) id = hex32(r);
    usedEventIds.add(id);
    return id;
  };
  const ctx: SequenceContext = { r, clock: base, participantIndices, allowedOutcomes, newEventId };
  const log: string[] = [];

  let state = createCourtConfirmationMachine({
    sessionHash: hex32(r),
    proposalHash: hex32(r),
    proposedOutcome,
    allowedOutcomes,
    evidenceIds: Array.from({ length: int(r, 0, 3) }, () => hex32(r)),
    participantIndices,
    confirmQuorum,
    confirmDeadline,
    challengeDeadline,
  });

  // Sanity of the generator's own inputs.
  assertFullyFrozen(state);
  expect(state.phase).toBe('confirm_open');

  const stats: SequenceStats = { steps: 0, terminal: 'open', ladderReached: false, overturned: false };
  let prevLatest = state.latestTimestamp;

  for (let step = 0; step < maxSteps; step += 1) {
    if (TERMINAL_PHASES.has(state.phase)) break;

    const event = nextLegalEvent(state, ctx, confirmDeadline, challengeDeadline, log);
    log.push(`${state.phase} <- ${JSON.stringify(event)}`);

    // P1: the reducer must never throw on a legal event.
    let next: CourtConfirmationMachineState;
    try {
      next = reduceCourtConfirmationMachine(state, event);
    } catch (err) {
      throw new Error(
        `P1 violated: legal ${event.type} threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\nsequence:\n${log.join('\n')}`,
      );
    }

    // P4: monotonic latestTimestamp.
    if (event.type === 'abort') {
      expect(next.latestTimestamp).toBe(prevLatest);
    } else {
      expect(event.now, `event.now regression\n${log.join('\n')}`).toBeGreaterThanOrEqual(prevLatest);
      expect(next.latestTimestamp, `latestTimestamp != event.now for ${event.type}\n${log.join('\n')}`).toBe(event.now);
      prevLatest = next.latestTimestamp;
    }

    // P2: phase stays inside the declared union; terminals are only the three.
    expect(ALL_PHASES).toContain(next.phase);
    if (TERMINAL_PHASES.has(next.phase)) {
      expect(['final', 'expired', 'aborted']).toContain(next.phase);
      stats.terminal = next.phase as SequenceStats['terminal'];
    }

    // P5: freeze holds on the whole exported graph.
    assertFullyFrozen(next);

    // P3: final verdicts recompute against the canonical verdict hash.
    if (next.phase === 'final') {
      const verdict = next.verdict;
      expect(verdict, 'final without a verdict').toBeDefined();
      if (!verdict) break;
      expect(verdict.supportingEventIds.length).toBeGreaterThanOrEqual(1);
      expect([...verdict.supportingEventIds]).toEqual([...verdict.supportingEventIds].sort());
      expect(verdict.upheld).toBe(verdict.outcome === next.proposedOutcome);
      expect(verdict.verdictHash).toBe(
        hashCourtVerdict({
          sessionHash: next.sessionHash,
          outcome: verdict.outcome,
          supportingEventIds: verdict.supportingEventIds,
        }),
      );
      const source = verdict.upheld
        ? next.confirmations.map((c) => c.eventId)
        : (next.ladder?.votes ?? []).filter((v) => v.outcome === verdict.outcome).map((v) => v.eventId);
      for (const id of verdict.supportingEventIds) expect(source).toContain(id);
      // An overturned proposal flags every confirming juror for clawback.
      if (!verdict.upheld) {
        for (const record of next.confirmations) {
          expect(
            next.clawbackFlags.some((f) => f.idx === record.idx && f.reason === 'overturned_confirmation'),
          ).toBe(true);
        }
        stats.overturned = true;
      }
    }

    if (next.ladder !== undefined) stats.ladderReached = true;

    // P6: hostile probes from the reached state fail closed, typed.
    runHostileProbes(next, log.join('\n'));

    state = next;
    if (event.type !== 'abort') ctx.clock = event.now;
    stats.steps += 1;
  }
  return stats;
}

function nextLegalEvent(
  state: CourtConfirmationMachineState,
  ctx: SequenceContext,
  confirmDeadline: number,
  challengeDeadline: number,
  log: string[],
): CourtConfirmationMachineEvent {
  const { r, clock } = ctx;
  const now = clock;
  const maybeAbort = (): (() => CourtConfirmationMachineEvent)[] =>
    r() < 0.08 ? [() => ({ type: 'abort', reason: 'host-abort' })] : [];
  const recordFee = (): CourtConfirmationMachineEvent => ({
    type: 'record_fee',
    feeEventId: ctx.newEventId(),
    now,
  });
  // A tick that stays strictly before `deadline` (legal no-op / clock advance).
  const tickBefore = (deadline: number): CourtConfirmationMachineEvent[] => {
    const slack = deadline - 1 - clock;
    if (slack < 1) return [];
    return [{ type: 'tick', now: clock + int(r, 1, Math.min(50, slack)) }];
  };
  // A tick at/after `deadline` — legal, expires the case in tickable phases.
  const tickPast = (deadline: number): CourtConfirmationMachineEvent => ({
    type: 'tick',
    now: Math.max(clock, deadline) + int(r, 0, 100),
  });

  switch (state.phase) {
    case 'confirm_open': {
      const unconfirmed = ctx.participantIndices.filter(
        (i) => !state.confirmations.some((c) => c.idx === i),
      );
      const options: (() => CourtConfirmationMachineEvent)[] = [recordFee];
      if (clock < confirmDeadline && unconfirmed.length > 0) {
        options.push(() => {
          const idx = pick(r, unconfirmed);
          return {
            type: 'accept_confirmation',
            idx,
            confirmHash: hashCourtConfirmation({
              sessionHash: state.sessionHash,
              proposalHash: state.proposalHash,
              idx,
            }),
            eventId: ctx.newEventId(),
            now,
          };
        });
        // Idempotent re-send of an existing confirmation.
        if (state.confirmations.length > 0) {
          options.push(() => {
            const record = pick(r, state.confirmations);
            return {
              type: 'accept_confirmation',
              idx: record.idx,
              confirmHash: record.confirmHash,
              eventId: record.eventId,
              now,
            };
          });
        }
        options.push(...tickBefore(confirmDeadline).map((e) => () => e));
      }
      if (clock >= confirmDeadline && state.confirmations.length >= state.confirmQuorum) {
        options.push(() => ({ type: 'close_confirmations', now: Math.max(clock, confirmDeadline) }));
      }
      // The clock can only cross the deadline BY a close (or expire): closing
      // at exactly the deadline is legal whenever the quorum stands.
      if (clock < confirmDeadline && state.confirmations.length >= state.confirmQuorum) {
        options.push(() => ({ type: 'close_confirmations', now: confirmDeadline }));
      }
      options.push(() => tickPast(confirmDeadline));
      options.push(...maybeAbort());
      return pick(r, options)();
    }
    case 'confirm_closed': {
      const options: (() => CourtConfirmationMachineEvent)[] = [recordFee];
      if (clock < challengeDeadline) options.push(() => ({ type: 'open_challenge_window', now }));
      options.push(() => tickPast(challengeDeadline));
      options.push(...maybeAbort());
      return pick(r, options)();
    }
    case 'challenge_window': {
      const unchallenged = ctx.participantIndices.filter(
        (i) => !state.challenges.some((c) => c.idx === i),
      );
      const options: (() => CourtConfirmationMachineEvent)[] = [recordFee];
      if (clock < challengeDeadline) {
        if (unchallenged.length > 0) {
          options.push(() => ({
            type: 'accept_challenge',
            idx: pick(r, unchallenged),
            bondTxid: hex32(r),
            bondProofHash: hex32(r),
            eventId: ctx.newEventId(),
            now,
          }));
        }
        options.push(...tickBefore(challengeDeadline).map((e) => () => e));
      }
      options.push(() => ({ type: 'close_challenge_window', now: Math.max(clock, challengeDeadline) }));
      options.push(() => tickPast(challengeDeadline));
      options.push(...maybeAbort());
      return pick(r, options)();
    }
    case 'ladder_pending': {
      const options: (() => CourtConfirmationMachineEvent)[] = [
        recordFee,
        () => ({
          type: 'open_ladder_round',
          round: state.ladderRound + 1,
          voteDeadline: clock + int(r, 1, 3_000),
          now,
        }),
        () => ({ type: 'tick', now: clock + int(r, 1, 100) }), // exempt phase: any now is legal
        ...maybeAbort(),
      ];
      return pick(r, options)();
    }
    case 'ladder_vote_open': {
      const deadline = state.ladder!.voteDeadline;
      const nonVoted = ctx.participantIndices.filter(
        (i) => !state.ladder!.votes.some((v) => v.idx === i),
      );
      const options: (() => CourtConfirmationMachineEvent)[] = [recordFee];
      if (clock < deadline) {
        if (nonVoted.length > 0) {
          options.push(() => ({
            type: 'accept_mass_vote',
            idx: pick(r, nonVoted),
            outcome: pick(r, ctx.allowedOutcomes),
            eventId: ctx.newEventId(),
            now,
          }));
        }
        // Idempotent re-send of an existing mass vote.
        if (state.ladder!.votes.length > 0) {
          options.push(() => {
            const vote = pick(r, state.ladder!.votes);
            return {
              type: 'accept_mass_vote',
              idx: vote.idx,
              outcome: vote.outcome,
              eventId: vote.eventId,
              now,
            };
          });
        }
        options.push(...tickBefore(deadline).map((e) => () => e));
      }
      options.push(() => ({ type: 'close_ladder_round', now: Math.max(clock, deadline) }));
      options.push(() => tickPast(deadline));
      options.push(...maybeAbort());
      return pick(r, options)();
    }
    case 'ladder_vote_closed': {
      const options: (() => CourtConfirmationMachineEvent)[] = [
        () => ({ type: 'resolve_round', now }),
        recordFee,
        () => ({ type: 'tick', now: clock + int(r, 1, 100) }), // exempt phase
        ...maybeAbort(),
      ];
      return pick(r, options)();
    }
    case 'fee_settlement': {
      const reasons = ['manual_flag', 'host_adjustment', 'overturned_confirmation'];
      const options: (() => CourtConfirmationMachineEvent)[] = [
        recordFee,
        () => ({
          type: 'flag_clawback',
          idx: pick(r, ctx.participantIndices),
          reason: pick(r, reasons),
          now,
        }),
        () => ({ type: 'finalize', now }),
        () => ({ type: 'tick', now: clock + int(r, 1, 100) }), // exempt phase
        ...maybeAbort(),
      ];
      return pick(r, options)();
    }
    default:
      throw new Error(`generator reached unknown phase ${state.phase} (log:\n${log.join('\n')})`);
  }
}

// ─── the sweep ──────────────────────────────────────────────────────────────

const SEQUENCES = 400;

describe('properties: confirmation machine legal-sequence sweep', () => {
  it(`P1/P2/P4/P5: ${SEQUENCES} random legal sequences never throw, stay in-phase, keep the clock monotonic and the state graph frozen`, () => {
    const terminals = { final: 0, expired: 0, aborted: 0, open: 0 };
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const stats = runSequence(seed);
      terminals[stats.terminal] += 1;
      expect(stats.steps).toBeGreaterThan(0);
    }
    // Generator coverage: every terminal phase is actually reached.
    expect(terminals.final).toBeGreaterThan(0);
    expect(terminals.expired).toBeGreaterThan(0);
    expect(terminals.aborted).toBeGreaterThan(0);
  });

  it('P3: challenge/ladder paths are exercised, verdicts recompute, overturns flag confirmers', () => {
    let ladderReached = 0;
    let overturned = 0;
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const stats = runSequence(seed);
      if (stats.ladderReached) ladderReached += 1;
      if (stats.overturned) overturned += 1;
    }
    expect(ladderReached).toBeGreaterThan(0);
    expect(overturned).toBeGreaterThan(0);
  });

  it('P6 (FINDING r3, restored-state edge only): finalize with an upheld verdict over an EMPTY but well-formed confirmation ledger escapes a FOREIGN CourtVoteTransitionError', () => {
    // Legal sequences cannot produce this state (close_confirmations enforces
    // the quorum), but a hand-restored snapshot can. The ledger barrier
    // (assertValidConfirmationLedger) accepts an empty ledger, and finalize
    // then calls hashCourtVerdict with zero supporting ids, which throws the
    // VOTE machine's error class out of the CONFIRMATION machine. Reported
    // as a round-3 finding; asserted here so the escape is regression-visible.
    const r = mulberry32(99);
    const participants = [1, 2, 3];
    const base = 1_750_000_000;
    let state = createCourtConfirmationMachine({
      sessionHash: hex32(r),
      proposalHash: hex32(r),
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: participants,
      confirmQuorum: 1,
      confirmDeadline: base + 100,
      challengeDeadline: base + 200,
    });
    const idx = 1;
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: state.sessionHash, proposalHash: state.proposalHash, idx }),
      eventId: hex32(r),
      now: base,
    });
    state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: base + 100 });
    state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: base + 100 });
    state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: base + 200 });
    expect(state.phase).toBe('fee_settlement');
    const restored = { ...state, confirmations: [] } as CourtConfirmationMachineState;
    let thrown: unknown;
    try {
      reduceCourtConfirmationMachine(restored, { type: 'finalize', now: base + 200 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CourtVoteTransitionError);
    expect(thrown).not.toBeInstanceOf(CourtConfirmationTransitionError);
  });
});
