// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Property-based invariant sweep (security round 3) — universal-confirmation
 * machine.
 *
 * Deterministic seeded generators (mulberry32 LCG — no new dependencies)
 * drive random LEGAL event sequences (random rosters 3..25, random outcome
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
import { mulberry32, int, pick, hex32 } from './helpers/rng';
import { assertConfirmationStateFrozen as assertFullyFrozen } from './helpers/asserts';
import { escalateEvent, unwitnessedEscalate } from './helpers/machines';

// ─── seeded LCG: now imported from helpers/rng (mulberry32) ─────────────────

const TERMINAL_PHASES = new Set(['final', 'expired', 'aborted']);
const ALL_PHASES = [
  'confirm_open', 'confirm_closed', 'challenge_window', 'ladder_pending',
  'ladder_vote_open', 'ladder_vote_closed', 'round_resolved', 'fee_settlement',
  'final', 'expired', 'aborted',
];

// ─── P5: freeze discipline — assertFullyFrozen now imported from helpers/asserts ──

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
    expectTypedError(state, unwitnessedEscalate(state.latestTimestamp), 'escalate-after-terminal', log);
    expectTypedError(state, { type: 'concede', now: state.latestTimestamp }, 'concede-after-terminal', log);
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
  // …and escalate/concede are refused outside round_resolved (v0.9.0).
  if (state.phase !== 'round_resolved') {
    expectTypedError(state, unwitnessedEscalate(state.latestTimestamp), 'escalate-out-of-phase', log);
    expectTypedError(state, { type: 'concede', now: state.latestTimestamp }, 'concede-out-of-phase', log);
  }
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
  multiRound: boolean;
  escalated: boolean;
  conceded: boolean;
}

function runSequence(seed: number, maxSteps = 90): SequenceStats {
  const r = mulberry32(seed);
  const rosterSize = int(r, 3, 25);
  const participantIndices = Array.from({ length: rosterSize }, (_, i) => i + 1);
  const allowedOutcomes = Array.from({ length: int(r, 2, 5) }, (_, i) => `outcome-${i}`);
  const proposedOutcome = pick(r, allowedOutcomes);
  const confirmQuorum = int(r, 1, rosterSize);
  const maxLadderRounds = int(r, 1, 3);
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
    maxLadderRounds,
  });

  // Sanity of the generator's own inputs.
  assertFullyFrozen(state);
  expect(state.phase).toBe('confirm_open');

  const stats: SequenceStats = {
    steps: 0, terminal: 'open', ladderReached: false, overturned: false,
    multiRound: false, escalated: false, conceded: false,
  };
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
      // v0.9.0 finality: a never-challenged upheld case is backed by the
      // confirmation ledger; a challenged case by the LAST resolved round's
      // winning-vote event ids.
      const source = next.challenges.length === 0 && verdict.upheld
        ? next.confirmations.map((c) => c.eventId)
        : (next.ladder?.votes ?? []).filter((v) => v.outcome === verdict.outcome).map((v) => v.eventId);
      for (const id of verdict.supportingEventIds) expect(source).toContain(id);
      // An overturned proposal flags every confirming juror for clawback
      // (idempotent per (idx, reason) — at least one flag each).
      if (!verdict.upheld) {
        for (const record of next.confirmations) {
          expect(
            next.clawbackFlags.some((f) => f.idx === record.idx && f.reason === 'overturned_confirmation'),
          ).toBe(true);
        }
        stats.overturned = true;
      }
      // Outcome history: append-only, rounds strictly increasing, the last
      // entry decides the verdict of a challenged case.
      const history = next.outcomeHistory ?? [];
      for (let h = 0; h < history.length; h += 1) {
        expect(history[h]!.round).toBe(h + 1);
        expect(history[h]!.winnerIndices.length).toBeGreaterThanOrEqual(1);
        expect(history[h]!.winnerEventIds.length).toBeGreaterThanOrEqual(1);
        if (h > 0) {
          // Flip-flop rule: the previous round's majority is flagged when the
          // next round's winner differs.
          if (history[h - 1]!.outcome !== history[h]!.outcome) {
            for (const idx of history[h - 1]!.winnerIndices) {
              expect(
                next.clawbackFlags.some((f) => f.idx === idx && f.reason === 'round_flip' && f.round === history[h - 1]!.round),
              ).toBe(true);
            }
          }
        }
      }
      if (next.challenges.length > 0) {
        expect(history[history.length - 1]?.outcome).toBe(verdict.outcome);
      }
    }

    if (next.ladder !== undefined) stats.ladderReached = true;
    if (next.ladderRound >= 2) stats.multiRound = true;
    if (event.type === 'escalate') stats.escalated = true;
    if (event.type === 'concede') stats.conceded = true;

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
  // Weighted candidates: productive transitions dominate; expiries, fees,
  // idempotent no-ops, and aborts stay rare but reachable (deterministic).
  type Weighted = { weight: number; make: () => CourtConfirmationMachineEvent };
  const options: Weighted[] = [];
  const add = (weight: number, make: () => CourtConfirmationMachineEvent): void => {
    options.push({ weight, make });
  };
  const maybeAbort = (weight = 0.4): void => {
    if (r() < 0.15) add(weight, () => ({ type: 'abort', reason: 'host-abort' }));
  };
  const recordFee = (): void => add(0.7, () => ({ type: 'record_fee', feeEventId: ctx.newEventId(), now }));
  // A tick that stays strictly before `deadline` (legal no-op / clock advance).
  const tickBefore = (deadline: number): void => {
    const slack = deadline - 1 - clock;
    if (slack >= 1) add(1.5, () => ({ type: 'tick', now: clock + int(r, 1, Math.min(50, slack)) }));
  };
  // A tick at/after `deadline` — legal, expires the case in tickable phases.
  const tickPast = (deadline: number): void =>
    add(0.8, () => ({ type: 'tick', now: Math.max(clock, deadline) + int(r, 0, 100) }));

  switch (state.phase) {
    case 'confirm_open': {
      const unconfirmed = ctx.participantIndices.filter(
        (i) => !state.confirmations.some((c) => c.idx === i),
      );
      recordFee();
      if (clock < confirmDeadline && unconfirmed.length > 0) {
        add(6, () => {
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
          add(0.7, () => {
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
        tickBefore(confirmDeadline);
      }
      // The clock can only cross the deadline BY a close (or expire): closing
      // at exactly the deadline is legal whenever the quorum stands.
      if (state.confirmations.length >= state.confirmQuorum) {
        add(6, () => ({ type: 'close_confirmations', now: Math.max(clock, confirmDeadline) }));
      }
      tickPast(confirmDeadline);
      maybeAbort();
      break;
    }
    case 'confirm_closed': {
      recordFee();
      if (clock < challengeDeadline) add(6, () => ({ type: 'open_challenge_window', now }));
      tickPast(challengeDeadline);
      maybeAbort();
      break;
    }
    case 'challenge_window': {
      const unchallenged = ctx.participantIndices.filter(
        (i) => !state.challenges.some((c) => c.idx === i),
      );
      recordFee();
      if (clock < challengeDeadline) {
        if (unchallenged.length > 0) {
          add(5, () => ({
            type: 'accept_challenge',
            idx: pick(r, unchallenged),
            bondTxid: hex32(r),
            bondProofHash: hex32(r),
            eventId: ctx.newEventId(),
            now,
          }));
        }
        tickBefore(challengeDeadline);
      }
      add(6, () => ({ type: 'close_challenge_window', now: Math.max(clock, challengeDeadline) }));
      tickPast(challengeDeadline);
      maybeAbort();
      break;
    }
    case 'ladder_pending': {
      recordFee();
      // v0.9.0: the host may expand the round panel (sequential 1..N, N ≥ 3);
      // mass votes are then validated against the ROUND panel.
      add(6, () => {
        const expand = r() < 0.5;
        const panelSize = expand ? int(r, 3, Math.max(3, ctx.participantIndices.length)) : ctx.participantIndices.length;
        return {
          type: 'open_ladder_round',
          round: state.ladderRound + 1,
          voteDeadline: clock + int(r, 1, 3_000),
          ...(expand ? { roundRoster: Array.from({ length: panelSize }, (_, i) => i + 1) } : {}),
          now,
        } as CourtConfirmationMachineEvent;
      });
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) })); // exempt phase: any now is legal
      maybeAbort();
      break;
    }
    case 'ladder_vote_open': {
      const deadline = state.ladder!.voteDeadline;
      // v0.9.0: votes are validated against the ROUND panel (explicit roster
      // when the host opened one, else the case roster).
      const panel = state.ladder!.roundRoster ?? ctx.participantIndices;
      const nonVoted = panel.filter((i) => !state.ladder!.votes.some((v) => v.idx === i));
      recordFee();
      if (clock < deadline) {
        if (nonVoted.length > 0) {
          add(6, () => ({
            type: 'accept_mass_vote',
            idx: pick(r, nonVoted),
            outcome: pick(r, ctx.allowedOutcomes),
            eventId: ctx.newEventId(),
            now,
          }));
        }
        // Idempotent re-send of an existing mass vote.
        if (state.ladder!.votes.length > 0) {
          add(0.7, () => {
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
        tickBefore(deadline);
      }
      // Closing an EMPTY round is legal, but resolve_round refuses it — only
      // close once at least one vote stands (otherwise expire instead).
      // FINDING r3-6 (FIXED in 0.9.1): the machine's creation guard now
      // rejects case rosters < 3, so the default round panel is always a
      // legal ≥ 3-seat panel; the ledger barrier below remains as
      // defense-in-depth for hand-restored snapshots.
      if (state.ladder!.votes.length > 0 && panel.length >= 3) {
        add(6, () => ({ type: 'close_ladder_round', now: Math.max(clock, deadline) }));
      }
      tickPast(deadline);
      maybeAbort();
      break;
    }
    case 'ladder_vote_closed': {
      add(7, () => ({ type: 'resolve_round', now }));
      recordFee();
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) })); // exempt phase
      maybeAbort();
      break;
    }
    case 'round_resolved': {
      // v0.9.0: the host explicitly escalates (rounds remain) or concedes —
      // the machine never auto-escalates and never auto-concedes. Both are
      // legal here (a park only happens below the cap).
      add(4, () => escalateEvent(state, now));
      add(4, () => ({ type: 'concede', now }));
      recordFee();
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) })); // exempt phase
      maybeAbort();
      break;
    }
    case 'fee_settlement': {
      const reasons = ['manual_flag', 'host_adjustment', 'overturned_confirmation'];
      recordFee();
      add(2, () => ({
        type: 'flag_clawback',
        idx: pick(r, ctx.participantIndices),
        reason: pick(r, reasons),
        now,
      }));
      add(6, () => ({ type: 'finalize', now }));
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) })); // exempt phase
      maybeAbort();
      break;
    }
    default:
      throw new Error(`generator reached unknown phase ${state.phase} (log:\n${log.join('\n')})`);
  }

  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = r() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.make();
  }
  return options[options.length - 1]!.make();
}

// ─── the sweep ──────────────────────────────────────────────────────────────

const SEQUENCES = 400;

describe('properties: confirmation machine legal-sequence sweep', () => {
  it(`P1/P2/P4/P5: ${SEQUENCES} random legal sequences never throw, stay in-phase, keep the clock monotonic and the state graph frozen`, { timeout: 120_000 }, () => {
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

  it('P3: challenge/ladder paths are exercised, verdicts recompute, overturns flag confirmers, multi-round escalation + concede paths run', { timeout: 120_000 }, () => {
    let ladderReached = 0;
    let overturned = 0;
    let multiRound = 0;
    let escalated = 0;
    let conceded = 0;
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const stats = runSequence(seed);
      if (stats.ladderReached) ladderReached += 1;
      if (stats.overturned) overturned += 1;
      if (stats.multiRound) multiRound += 1;
      if (stats.escalated) escalated += 1;
      if (stats.conceded) conceded += 1;
    }
    expect(ladderReached).toBeGreaterThan(0);
    expect(overturned).toBeGreaterThan(0);
    expect(multiRound).toBeGreaterThan(0);
    expect(escalated).toBeGreaterThan(0);
    expect(conceded).toBeGreaterThan(0);
  });

  it('P6 (FINDING r3-1, FIXED in 0.9.1): finalize over an EMPTY but well-formed confirmation ledger fails closed with the machine\'s OWN typed error', () => {
    // Legal sequences cannot produce this state (close_confirmations enforces
    // the quorum), but a hand-restored snapshot can. Since 0.9.1 finalize
    // fails closed BEFORE hashing: a final verdict needs ≥ 1 supporting
    // event, and the error is the CONFIRMATION machine's typed
    // CourtConfirmationTransitionError — the vote machine's foreign error
    // class no longer escapes.
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
    expect(thrown).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(thrown).not.toBeInstanceOf(CourtVoteTransitionError);
    expect((thrown as Error).message).toMatch(/zero supporting event ids/);
  });

  it('P6 (FINDING r3-6, FIXED in 0.9.1): a 2-member case roster is rejected at CREATION — the confirmation quorum + ladder round-panel semantics presuppose ≥ 3 seats', () => {
    // Before 0.9.1 the machine accepted 2-member rosters, but a challenged
    // case on one could never resolve: the v0.9.0 round panel DEFAULTS to the
    // case roster and the ledger barrier (MIN_ROUND_ROSTER = 3) rejects a
    // < 3-seat panel at close_ladder_round/resolve_round — a mid-ladder dead
    // end. Chosen fix: fail closed at creation (roster ≥ 3 ALWAYS — the
    // cleanest consistent rule; the only pre-existing test on a 2-member
    // confirmation roster, the quorum-shortfall case in
    // adversarialMachines.test.ts, was updated to a 3-member roster).
    const r = mulberry32(98);
    const base = 1_750_000_000;
    expect(() =>
      createCourtConfirmationMachine({
        sessionHash: hex32(r),
        proposalHash: hex32(r),
        proposedOutcome: 'YES',
        allowedOutcomes: ['YES', 'NO'],
        participantIndices: [1, 2],
        confirmQuorum: 1,
        confirmDeadline: base + 100,
        challengeDeadline: base + 200,
        maxLadderRounds: 2,
      }),
    ).toThrow(CourtConfirmationTransitionError);
    expect(() =>
      createCourtConfirmationMachine({
        sessionHash: hex32(r),
        proposalHash: hex32(r),
        proposedOutcome: 'YES',
        allowedOutcomes: ['YES', 'NO'],
        participantIndices: [1, 2],
        confirmQuorum: 1,
        confirmDeadline: base + 100,
        challengeDeadline: base + 200,
        maxLadderRounds: 2,
      }),
    ).toThrow(/confirmation roster must contain at least 3 participants/);

    // The challenge path on the now-minimal 3-member roster resolves with the
    // DEFAULT (case-roster) round panel — no explicit roundRoster needed.
    let state = createCourtConfirmationMachine({
      sessionHash: hex32(r),
      proposalHash: hex32(r),
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [1, 2, 3],
      confirmQuorum: 1,
      confirmDeadline: base + 100,
      challengeDeadline: base + 200,
      maxLadderRounds: 2,
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
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_challenge',
      idx: 2,
      bondTxid: hex32(r),
      bondProofHash: hex32(r),
      eventId: hex32(r),
      now: base + 150,
    });
    state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: base + 200 });
    expect(state.phase).toBe('ladder_pending');
    state = reduceCourtConfirmationMachine(state, { type: 'open_ladder_round', round: 1, voteDeadline: base + 400, now: base + 200 });
    expect(state.ladder?.roundRoster).toEqual([1, 2, 3]);
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_mass_vote',
      idx: 1,
      outcome: 'NO',
      eventId: hex32(r),
      now: base + 300,
    });
    state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: base + 400 });
    expect(state.phase).toBe('ladder_vote_closed');
    state = reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: base + 400 });
    // Round 1 of maxLadderRounds 2 parks in round_resolved (host-driven
    // escalate/concede); the dead end is gone either way.
    expect(state.phase).toBe('round_resolved');
    expect(state.verdict?.outcome).toBe('NO');
    expect(state.outcomeHistory).toHaveLength(1);
    state = reduceCourtConfirmationMachine(state, { type: 'concede', now: base + 400 });
    expect(state.phase).toBe('fee_settlement');
    const final = reduceCourtConfirmationMachine(state, { type: 'finalize', now: base + 400 });
    expect(final.phase).toBe('final');
    expect(final.verdict?.outcome).toBe('NO');
  });
});
