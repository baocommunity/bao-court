// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * OVER-STRICTNESS — the r37-1 class, as a STANDING suite (v0.15.3).
 *
 * WHY THIS FILE EXISTS. Three rounds in a row shipped a barrier that was
 * correct for a state the MACHINE produces and wrong for a state a HOST
 * legitimately persists:
 *
 *   r37-1  the escalation log's completeness rule learned about
 *          `ladder_pending`; the "rounds the case never opened" bound did not.
 *          A host restoring a mid-escalation snapshot was refused.
 *   r9-4   "one round number per case" was re-derived in the transport mapper
 *          as `ladder.round === ladderRound`, which needs a `ladder` object at
 *          all.
 *   r12-1  the counter barrier required `ladderRound === 0` when no `ladder` is
 *          open. That clause is true of every machine-produced state and FALSE
 *          of the host's G-4 lane projection, whose round counter is backed by
 *          `market_disputes.dispute_round` and whose `ladder` lives in the case
 *          row. Measured on the host: 42 of 185 court tests red, including
 *          R50's first-contact escalation; green at v0.15.1, and reverting only
 *          that clause made 52/52 green.
 *
 * The class is not "a missing check" — it is a check that states an invariant in
 * terms of SHAPE ("no ladder object") when the invariant is about PROVENANCE
 * ("whose ledger vouches for this round"). The fix is a declared projection
 * (`projection: 'lane'`) plus a counter barrier that reads it; the
 * anti-recurrence measure is THIS suite:
 *
 *   1. {@link LEGAL_SHAPES} enumerates every state shape a host can legally
 *      produce — lane first-contact, lane at a later rung, lane mid-escalation,
 *      the host's older wire projection, the machine's own states at every
 *      phase, and the legacy shapes — and asserts each against every
 *      reader/barrier in {@link READERS}, in BOTH directions: a declared-accept
 *      cell that refuses and a declared-refuse cell that accepts are both red.
 *   2. A SWEEP walks every exported `assert(state)` of `confirmationMachineCore`
 *      and requires it to accept the lane shape unless the sweep's allow-list
 *      names it with the reason it is not the lane's reader. A NEW barrier
 *      therefore fails this suite until somebody decides — deliberately —
 *      whether it may refuse a legal host shape.
 *   3. The r12-1 attacks are re-run against the new rule: a forged counter is
 *      refused on BOTH shapes, a full state with a counter and no ledger is
 *      still refused, and a lane projection can reach neither a write path
 *      (clawback, verdict, round resolution/opening) nor launder itself into a
 *      full state by escalating.
 *
 * Determinism: fixed clocks, fixed ids, no network, no keys.
 */

import { describe, expect, it } from 'vitest';

import * as core from '../confirmationMachineCore';
import {
  assertValidConfirmationLedger,
  assertValidEscalationLog,
  assertValidMassVoteLedger,
  assertValidOutcomeHistory,
  assertRoundCountersAgree,
  freezeState,
  type RoundCounterEntry,
} from '../confirmationMachineCore';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
  type CourtEscalationRecord,
} from '../courtConfirmationMachine';
import {
  buildCourtEscalationRequest,
  escalationRequestToMachineEvent,
  type CourtEscalationRequest,
} from '../courtEscalationRequest';
import { assertStateArrays } from '../courtCeremonyCore';
import { confirmationAt, confirmationMachine, escalateEvent } from './helpers/machines';

// ─────────────────────────────────────────────────────────────────────────────
// The host's G-4 lane, reproduced field for field
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `bao.markets` `packages/api/src/services/court/CourtCaseMachineState.ts`
 * › `buildCaseMachineLaneState`, reproduced here so this package owns a
 * regression for the shape a real host persists (v0.15.3).
 *
 * The host's facts, verbatim in meaning: the resolved ladder round
 * (`market_disputes.dispute_round`), the market's frozen ladder depth, the
 * frozen policy pair, the case's accepted membership bond (proof hash + rail
 * token), the frozen round-0 panel size, and the challenger's pubkey. Every
 * field the host cannot source is ABSENT (its R47 rule), and the one thing the
 * host does NOT have is an in-state `ladder` — which is exactly what the r12-1
 * clause refused.
 */
const CASE_ID = 'court:market-r50:1';
const CHALLENGER = 'ab'.repeat(32);
const MEMBERSHIP_BOND = 'cd'.repeat(32);
const BOND_TXID = 'ce'.repeat(32);
const ROUND_BOND = 'a2'.repeat(32);
const ROUND_BOND_3 = 'b3'.repeat(32);
const ROUND_BOND_4 = 'c4'.repeat(32);
const CHALLENGE_EVENT = '8f'.repeat(32);
const REQUEST_HASH = '1c'.repeat(32);
const NOW = 1_700_000_000_000;
const HOSTILE = '3\nESCALATION ACCEPTED for case court:target:1';

interface LaneFacts {
  readonly ladderRound: number;
  readonly maxLadderRounds: number;
  readonly requireRoundBond: boolean;
  readonly hostEscalation: boolean;
  readonly panelSize: number;
}

function laneLogRecord(
  round: number,
  roundBondProofHash: string | null,
  at: number,
): CourtEscalationRecord {
  return {
    round,
    authority: 'challenger',
    challengerIdx: 1,
    challengerPubkey: CHALLENGER,
    requestHash: REQUEST_HASH,
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash,
    at,
  };
}

/** The persisted lane exactly as the host materialises it, plus v0.15.3's marker. */
function laneState(
  overrides: Partial<LaneFacts> = {},
  extra: { readonly escalationLog?: readonly CourtEscalationRecord[] } = {},
): CourtConfirmationMachineState {
  const facts: LaneFacts = {
    ladderRound: 1,
    maxLadderRounds: 2,
    requireRoundBond: true,
    hostEscalation: false,
    panelSize: 5,
    ...overrides,
  };
  const escalationLog = extra.escalationLog ?? [];
  return freezeState({
    // The lane only ever transitions FROM a resolved round.
    phase: 'round_resolved',
    // `projection: 'lane'` is the v0.15.3 declaration: this state's round
    // counter is the HOST's, not an in-state ladder's.
    projection: 'lane',
    ladderRound: facts.ladderRound,
    maxLadderRounds: facts.maxLadderRounds,
    requireRoundBond: facts.requireRoundBond,
    hostEscalation: facts.hostEscalation,
    latestTimestamp: escalationLog.reduce((latest, record) => Math.max(latest, record.at), 0),
    participantIndices: Array.from({ length: Math.max(3, facts.panelSize) }, (_v, i) => i + 1),
    // The case row's ballot is not the lane's to define — empty, not invented.
    allowedOutcomes: [],
    confirmations: [],
    challenges: [{
      idx: 1,
      bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND,
      eventId: CHALLENGE_EVENT,
    }],
    escalationLog: [...escalationLog],
    fees: [],
    clawbackFlags: [],
    outcomeHistory: [],
  } as unknown as CourtConfirmationMachineState);
}

/** The exact event the host's route mints for a legal escalation of this lane. */
function laneEscalate(
  state: CourtConfirmationMachineState,
  overrides: Partial<Extract<CourtConfirmationMachineEvent, { type: 'escalate' }>> = {},
): Extract<CourtConfirmationMachineEvent, { type: 'escalate' }> {
  return {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: 1,
    challengerPubkey: CHALLENGER,
    requestHash: REQUEST_HASH,
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: ROUND_BOND,
    roundIndex: state.ladderRound + 1,
    now: Math.max(NOW, state.latestTimestamp),
    ...overrides,
  } as Extract<CourtConfirmationMachineEvent, { type: 'escalate' }>;
}

/**
 * The wire request a host maps against a case view. It names the state's OWN
 * first accepted challenge, so the mapper's bond binding is satisfiable for any
 * shape that could legally produce an escalation at all.
 */
function wireRequestFor(state: CourtConfirmationMachineState): CourtEscalationRequest {
  const challenge = state.challenges[0] ?? {
    bondTxid: BOND_TXID, bondProofHash: MEMBERSHIP_BOND, eventId: CHALLENGE_EVENT,
  };
  return buildCourtEscalationRequest({
    caseId: CASE_ID,
    round: Math.max(1, state.ladderRound),
    challengerPubkey: CHALLENGER,
    bondTxid: challenge.bondTxid,
    bondProofHash: challenge.bondProofHash,
    roundBondProofHash: null,
    eventId: challenge.eventId,
    signedAtSec: 1_790_000_000,
  });
}

const BINDING = { caseId: CASE_ID, authenticatedPubkey: CHALLENGER };

// ─────────────────────────────────────────────────────────────────────────────
// The reader/barrier matrix
// ─────────────────────────────────────────────────────────────────────────────

type Reader =
  | 'counter:escalate'
  | 'counter:transport'
  | 'counter:open_ladder_round'
  | 'counter:resolve_round'
  | 'counter:flag_clawback'
  | 'counter:finalize'
  | 'escalationLog'
  | 'confirmationLedger'
  | 'outcomeHistory'
  | 'stateArrays'
  | 'transportMapper';

const READERS: readonly Reader[] = [
  'counter:escalate',
  'counter:transport',
  'counter:open_ladder_round',
  'counter:resolve_round',
  'counter:flag_clawback',
  'counter:finalize',
  'escalationLog',
  'confirmationLedger',
  'outcomeHistory',
  'stateArrays',
  'transportMapper',
];

const COUNTER_ENTRY: Readonly<Record<string, RoundCounterEntry>> = {
  'counter:escalate': 'escalate',
  'counter:transport': 'transport',
  'counter:open_ladder_round': 'open_ladder_round',
  'counter:resolve_round': 'resolve_round',
  'counter:flag_clawback': 'flag_clawback',
  'counter:finalize': 'finalize',
};

/**
 * The mapper's own domain (its preconditions, not the counter rule): it mints an
 * attribution record for a round that EXISTS and a challenge that EXISTS, so a
 * state at round 0 or with an empty challenge ledger is not its input at all.
 * Kept as a predicate so every cell still asserts one direction or the other.
 */
function mapperCanRead(state: CourtConfirmationMachineState): boolean {
  return state.ladderRound >= 1 && state.challenges.length > 0;
}

function read(state: CourtConfirmationMachineState, reader: Reader): void {
  switch (reader) {
    case 'escalationLog': return assertValidEscalationLog(state);
    case 'confirmationLedger': return assertValidConfirmationLedger(state);
    case 'outcomeHistory': return assertValidOutcomeHistory(state);
    case 'stateArrays': return assertStateArrays(
      state as unknown as Record<string, unknown>,
      ['participantIndices', 'allowedOutcomes', 'confirmations', 'challenges', 'fees',
        'clawbackFlags', 'outcomeHistory', 'escalationLog'],
      CourtConfirmationTransitionError,
    );
    case 'transportMapper':
      return void escalationRequestToMachineEvent(state, wireRequestFor(state), NOW, BINDING);
    default: return assertRoundCountersAgree(state, COUNTER_ENTRY[reader]);
  }
}

/**
 * The readers a LANE state must be able to reach (v0.15.3).
 *
 * The lane's counter is backed by its case row and its escalations are the one
 * write it exists to make, so `escalate` and the mapper accept it. Every reader
 * that needs the IN-STATE ladder — round opening, round resolution, the clawback
 * record, the verdict — must refuse it, which is what keeps r12-1's harm closed.
 */
const LANE_ACCEPT: readonly Reader[] = READERS.filter((reader) =>
  reader !== 'counter:open_ladder_round'
  && reader !== 'counter:resolve_round'
  && reader !== 'counter:flag_clawback'
  && reader !== 'counter:finalize');

/** The FULL-state rule: every reader, minus the mapper's own domain. */
function fullStateAccept(state: CourtConfirmationMachineState): readonly Reader[] {
  return READERS.filter((reader) => reader !== 'transportMapper' || mapperCanRead(state));
}

interface LegalShape {
  readonly name: string;
  /** True for the host's G-4 projection: only {@link LANE_ACCEPT} is reachable. */
  readonly lane: boolean;
  /** LAZY on purpose: on the pre-v0.15.3 head, BUILDING a lane row throws, and a
   * module-level fixture would fail collection instead of the row (measured:
   * "Tests no tests" rather than a red row — a fix is only evidence when its
   * test fails as a TEST). */
  readonly build: () => CourtConfirmationMachineState;
  /** Why the non-accepted readers refuse — printed when a cell disagrees. */
  readonly whyRefused: string;
  /**
   * Readers the row's own rule makes refuse even though the shape is legal-for
   * its group: the forged-lane row is declared as a lane so that the COMPLETENESS
   * rule (not the counter rule) is the one on trial.
   */
  readonly refuseExtra?: readonly Reader[];
}

/** The machine's own mid-ladder state: round 1 resolved, round 2 escalated + open. */
function machineMidLadder(): CourtConfirmationMachineState {
  let state = confirmationAt('ladder_vote_closed');
  state = reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: 500 });
  state = reduceCourtConfirmationMachine(state, escalateEvent(state, 600));
  return reduceCourtConfirmationMachine(state, {
    type: 'open_ladder_round', round: 2, voteDeadline: 900, now: 700,
  });
}

const LEGAL_SHAPES: readonly LegalShape[] = [
  {
    name: 'full: the factory state (nothing opened, counter 0)',
    lane: false,
    build: () => confirmationMachine({ maxLadderRounds: 3 }),
    whyRefused: 'the mapper has no round to attribute (round 0) and no challenge bond',
  },
  {
    name: 'full: challenge_window (challenge accepted, no ladder yet)',
    lane: false,
    build: () => confirmationAt('challenge_window'),
    whyRefused: 'the mapper has no round to attribute (round 0)',
  },
  {
    name: 'full: ladder_pending (round 1 about to be opened)',
    lane: false,
    build: () => confirmationAt('ladder_pending'),
    whyRefused: 'the mapper has no round to attribute (round 0)',
  },
  {
    name: 'full: round_resolved at round 1',
    lane: false,
    build: () => confirmationAt('round_resolved'),
    whyRefused: 'nothing — a full state satisfies every reader, mapper included',
  },
  {
    name: "full: mid-ladder (round 2 open, log holds round 2) — r37-1's shape",
    lane: false,
    build: machineMidLadder,
    whyRefused: 'nothing — the phrase "a round the case never opened" must include '
      + 'the open rung, which is r37-1 itself',
  },
  {
    name: 'full: fee_settlement after an early concede (ladder at round 1)',
    lane: false,
    build: () => reduceCourtConfirmationMachine(
      confirmationAt('round_resolved'), { type: 'concede', now: 500 },
    ),
    whyRefused: 'nothing',
  },
  {
    name: 'full: the final state (verdict minted)',
    lane: false,
    build: () => reduceCourtConfirmationMachine(
      reduceCourtConfirmationMachine(confirmationAt('round_resolved'), { type: 'concede', now: 500 }),
      { type: 'finalize', now: 600 },
    ),
    whyRefused: 'nothing — a terminal state is still a readable one',
  },
  {
    name: 'legacy: never challenged, fee_settlement (no ladder, counter 0)',
    lane: false,
    build: () => reduceCourtConfirmationMachine(confirmationAt('challenge_window'), {
      type: 'close_challenge_window', now: 300,
    }),
    whyRefused: 'the mapper has no round to attribute (round 0)',
  },
  {
    name: 'LANE: first contact (counter 1, G-4 projection, no ladder)',
    lane: true,
    build: laneState,
    whyRefused: 'the in-state ladder readers: a projection carries its ledger in the host '
      + 'case row, so only escalate and the mapper may act on it',
  },
  {
    name: 'LANE: at a later rung (counter 3, complete log [2, 3])',
    lane: true,
    build: () => laneState({ ladderRound: 3, maxLadderRounds: 5 }, {
      escalationLog: [
        laneLogRecord(2, ROUND_BOND, NOW),
        laneLogRecord(3, ROUND_BOND_3, NOW + 500),
      ],
    }),
    whyRefused: "same as first contact — the log vouches for the rungs, the ladder is the row's",
  },
  {
    name: 'LANE: mid-escalation (phase ladder_pending, log holds the pending rung)',
    lane: true,
    build: () => reduceCourtConfirmationMachine(laneState(), laneEscalate(laneState())),
    whyRefused: 'same as first contact (the ladder readers refuse; escalate is a PHASE '
      + 'refusal at this point, asserted in the G-4 block below)',
  },
  {
    name: 'LANE: a restored snapshot with a shorter log than the counter (refused, not accepted)',
    lane: true,
    // This row exists to prove the matrix still has teeth against a FORGED lane:
    // the counter says 3, the log holds one record, so the log barrier must
    // refuse even though the shape is declared as a lane.
    build: () => laneState({ ladderRound: 3, maxLadderRounds: 5 }, {
      escalationLog: [laneLogRecord(3, ROUND_BOND_3, NOW)],
    }),
    whyRefused: 'the log is incomplete for the counter the projection declares (r33-5)',
    refuseExtra: ['escalationLog'],
  },
];

describe('v0.15.3 — over-strictness, as a standing matrix (the r37-1 class)', () => {
  for (const shape of LEGAL_SHAPES) {
    it(`${shape.name}`, () => {
      const state = shape.build();
      const base = shape.lane ? LANE_ACCEPT : fullStateAccept(state);
      const accept = base.filter((reader) => !(shape.refuseExtra ?? []).includes(reader));
      const accepted: string[] = [];
      const refused: string[] = [];
      for (const reader of READERS) {
        const mustAccept = accept.includes(reader);
        let threw: unknown = null;
        try {
          read(state, reader);
        } catch (error) {
          threw = error;
        }
        if (threw === null) {
          accepted.push(reader);
          expect(mustAccept, `${shape.name} · ${reader} was accepted but the matrix says REFUSE `
            + `(${shape.whyRefused})`).toBe(true);
        } else {
          refused.push(reader);
          // A refusal is always THIS package's typed error — never a raw
          // TypeError from a `ladder` access on a shape that has none.
          expect(threw, `${shape.name} · ${reader} threw a foreign error`).toBeInstanceOf(
            CourtConfirmationTransitionError,
          );
          expect(mustAccept, `${shape.name} · ${reader} was REFUSED but the matrix says ACCEPT `
            + `(${shape.whyRefused}): ${(threw as Error).message}`).toBe(false);
        }
      }
      // Exhaustive and disjoint: every reader produced exactly one verdict.
      expect([...accepted, ...refused].sort()).toEqual([...READERS].sort());
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The G-4 first-contact path, end to end (the host's 42 red tests, in one)
// ─────────────────────────────────────────────────────────────────────────────

describe('v0.15.3 — the G-4 lane: first contact is ACCEPTED (42/185 red on the host)', () => {
  it('a declared lane projection escalates from round 1, and the result is a legal lane', () => {
    const state = laneState();
    const next = reduceCourtConfirmationMachine(state, laneEscalate(state));
    // The host's M4 claim: phase advances, exactly ONE log record, rung = 2.
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog).toHaveLength(1);
    expect(next.escalationLog[0].round).toBe(2);
    expect(next.escalationLog[0].authority).toBe('challenger');
    // `escalate` does not advance the counter — `open_ladder_round` does.
    expect(next.ladderRound).toBe(1);
    // NO LAUNDERING: the projection survives the transition, so the next move
    // cannot reach a write path on the strength of having escalated.
    expect(next.projection).toBe('lane');
    expect(next.ladder).toBeUndefined();
    // The mid-escalation shape is accepted by the log barrier (r37-1's own
    // shape, one host later).
    expect(() => assertValidEscalationLog(next)).not.toThrow();
    expect(() => assertRoundCountersAgree(next, 'escalate')).not.toThrow();
    // A second escalation cannot skip the un-opened rung.
    expect(() => reduceCourtConfirmationMachine(next, laneEscalate(next)))
      .toThrow(/cannot escalate during ladder_pending/);
  });

  it('a lane at a LATER rung escalates (the log vouches for the rungs already opened)', () => {
    const state = laneState({ ladderRound: 3, maxLadderRounds: 5 }, {
      escalationLog: [
        laneLogRecord(2, ROUND_BOND, NOW),
        laneLogRecord(3, ROUND_BOND_3, NOW + 500),
      ],
    });
    const next = reduceCourtConfirmationMachine(state, laneEscalate(state, {
      roundBondProofHash: ROUND_BOND_4,
      roundIndex: 4,
      now: NOW + 1000,
    }));
    expect(next.escalationLog.map((record) => record.round)).toEqual([2, 3, 4]);
    expect(next.ladderRound).toBe(3);
    expect(next.projection).toBe('lane');
  });

  it('the transport mapper mints the event from the SAME lane state', () => {
    // The host's R47 wire path reads a case view; v0.15.3 lets that view be the
    // persisted lane itself (before, the mapper demanded a `ladder` record, so
    // the host had to fabricate `ladder: { round }`).
    const state = laneState();
    const event = escalationRequestToMachineEvent(
      state, wireRequestFor(state), NOW, BINDING,
    );
    expect(event.roundIndex).toBe(2);
    expect(event.challengerIdx).toBe(1);
    expect(event.bondProofHash).toBe(MEMBERSHIP_BOND);
    // And the reducer accepts the event it mints — once the host adds the
    // per-round bond its own policy requires (the mapper carries whatever the
    // wire names, never invents one).
    expect(() => reduceCourtConfirmationMachine(state, { ...event, roundBondProofHash: ROUND_BOND }))
      .not.toThrow();
  });

  it('the host\'s pre-v0.15.3 WIRE projection (a fabricated `ladder: { round }`) still maps', () => {
    // Backward compatibility for a host that has not yet adopted the marker: the
    // r9-4 rule is satisfied by the one field the mapper reads.
    const fabricated = {
      phase: 'round_resolved',
      ladderRound: 2,
      ladder: { round: 2 },
      maxLadderRounds: 5,
      requireRoundBond: true,
      hostEscalation: false,
      challenges: [{ idx: 1, bondProofHash: MEMBERSHIP_BOND, bondTxid: BOND_TXID }],
    } as unknown as CourtConfirmationMachineState;
    expect(() => escalationRequestToMachineEvent(
      fabricated,
      buildCourtEscalationRequest({
        caseId: CASE_ID,
        round: 2,
        challengerPubkey: CHALLENGER,
        bondTxid: BOND_TXID,
        bondProofHash: MEMBERSHIP_BOND,
        roundBondProofHash: null,
        eventId: CHALLENGE_EVENT,
        signedAtSec: 1_790_000_000,
      }),
      NOW,
      BINDING,
    )).not.toThrow();
    expect(() => assertRoundCountersAgree(fabricated, 'transport')).not.toThrow();
  });

  it('r37-1: the restored MID-ESCALATION lane is accepted by its own readers', () => {
    // The r37-1 shape exactly: `ladder_pending` with the pending rung on the log.
    const state = reduceCourtConfirmationMachine(laneState(), laneEscalate(laneState()));
    expect(state.phase).toBe('ladder_pending');
    expect(() => assertValidEscalationLog(state)).not.toThrow();
    expect(() => assertValidConfirmationLedger(state)).not.toThrow();
    expect(() => assertRoundCountersAgree(state, 'escalate')).not.toThrow();
    expect(() => assertRoundCountersAgree(state, 'transport')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTION 1 — the r12-1 attacks are still refused (on BOTH shapes)
// ─────────────────────────────────────────────────────────────────────────────

describe('v0.15.3 — direction 1: r12-1\'s exploits still fail', () => {
  const FORGED: readonly unknown[] = [
    HOSTILE, 2.5, -1, null, '3', Number.NaN, Number.MAX_SAFE_INTEGER + 2,
  ];

  it('a forged counter is refused on a LANE projection too (the domain check is provenance-blind)', () => {
    for (const forged of FORGED) {
      const state = { ...laneState(), ladderRound: forged } as CourtConfirmationMachineState;
      for (const entry of ['escalate', 'transport', 'flag_clawback', 'finalize'] as const) {
        expect(() => assertRoundCountersAgree(state, entry), `${String(forged)} · ${entry}`)
          .toThrow(/round counters disagree/);
      }
      // Nothing is written before the barrier.
      expect(state.clawbackFlags).toEqual([]);
      expect(state.escalationLog).toEqual([]);
    }
  });

  it('a forged counter with NO ladder in a FULL state (no marker) is still refused', () => {
    // r12-1's clause, preserved for the shape it was written about — and now
    // saying WHY, so the next host projection does not have to discover it.
    const full = {
      ...confirmationAt('round_resolved'),
      phase: 'fee_settlement',
      ladder: undefined,
      ladderRound: 3,
    } as CourtConfirmationMachineState;
    const err = (() => {
      try { assertRoundCountersAgree(full, 'escalate'); } catch (error) { return error as Error; }
      throw new Error('expected a refusal');
    })();
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/no ladder round is open/);
    expect(err.message).toMatch(/does not declare projection: 'lane'/);
    for (const entry of ['escalate', 'transport', 'flag_clawback', 'finalize'] as const) {
      expect(() => assertRoundCountersAgree(full, entry), entry).toThrow(CourtConfirmationTransitionError);
    }
    // The reducer refuses the clawback on the same state, before any write.
    const before = full.clawbackFlags.length;
    expect(() => reduceCourtConfirmationMachine(
      full, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
    )).toThrow(/FULL machine state/);
    expect(full.clawbackFlags).toHaveLength(before);
  });

  it('a forged counter with NO ladder in a LANE projection cannot pass as a write path', () => {
    // The r12-1 shape (a forged counter) on the NEW shape (a declared lane):
    // the domain check refuses first, so the marker never becomes a way past it.
    const forged = {
      ...laneState({ ladderRound: 3, maxLadderRounds: 5 }),
      phase: 'fee_settlement',
      ladderRound: Number.MAX_SAFE_INTEGER + 2,
    } as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(
      forged, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: NOW + 1 },
    )).toThrow(/not a non-negative safe integer|round counters disagree/);
    expect(forged.clawbackFlags).toEqual([]);
  });

  it('a lane projection cannot reach a WRITE path (clawback, verdict, resolve, open)', () => {
    // A hostile host re-stamps the projection's phase: the counter is legal, the
    // marker is legal, and the entry still refuses because it reads the in-state
    // ledger — which a projection by definition does not have.
    const feeSettlement = {
      ...laneState({ ladderRound: 3, maxLadderRounds: 5 }),
      phase: 'fee_settlement',
    } as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(
      feeSettlement, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: NOW + 100 },
    )).toThrow(/FULL machine state/);
    expect(feeSettlement.clawbackFlags).toEqual([]);
    expect(() => reduceCourtConfirmationMachine(
      feeSettlement, { type: 'finalize', now: NOW + 100 },
    )).toThrow(CourtConfirmationTransitionError);
    const voteClosed = { ...laneState(), phase: 'ladder_vote_closed' } as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(
      voteClosed, { type: 'resolve_round', now: NOW + 100 },
    )).toThrow(CourtConfirmationTransitionError);
    const pending = {
      ...laneState(), phase: 'ladder_pending',
    } as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(
      pending,
      { type: 'open_ladder_round', round: 2, voteDeadline: NOW + 9_000_000, now: NOW + 100 },
    )).toThrow(CourtConfirmationTransitionError);
    // The barriers behind those refusals, named: the counter rule and the
    // mass-vote ledger (a projection has no votes to validate).
    expect(() => assertRoundCountersAgree(pending, 'open_ladder_round'))
      .toThrow(/FULL machine state/);
    expect(() => assertValidMassVoteLedger(pending)).toThrow(/ladder state is missing/);
  });

  it('the marker is not an authorisation: an unknown projection is a typed refusal', () => {
    for (const marker of ['wallet', 'LANE', 'full', 1, null]) {
      const state = { ...laneState(), projection: marker } as unknown as CourtConfirmationMachineState;
      const err = (() => {
        try {
          reduceCourtConfirmationMachine(state, laneEscalate(laneState()));
        } catch (error) { return error as Error; }
        throw new Error(`expected a refusal for projection ${String(marker)}`);
      })();
      expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message).toMatch(/unknown state projection/);
      // One line, escaped — the r11-1 property holds for the new refusal too.
      expect(err.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
    }
  });

  it('stripping the marker from the SAME state closes the door (only the declaration opens it)', () => {
    const declared = laneState();
    const bare = { ...declared, projection: undefined } as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(declared, laneEscalate(declared))).not.toThrow();
    expect(() => reduceCourtConfirmationMachine(bare, laneEscalate(declared)))
      .toThrow(/does not declare projection: 'lane'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTION 2 — a new barrier cannot silently re-strict a legal host shape
// ─────────────────────────────────────────────────────────────────────────────

describe('v0.15.3 — the sweep: every state-only barrier must accept the lane', () => {
  /**
   * Barriers that legitimately refuse a lane projection, each with the reason it
   * is not the lane's reader. Adding a name here is a DECISION, which is the
   * point: the alternative is a barrier that refuses a legal host shape and is
   * discovered by a host, in production, 42 tests later.
   */
  const NOT_THE_LANES_READER: Readonly<Record<string, string>> = {
    assertValidMassVoteLedger:
      'it validates a round panel\'s VOTES; the lane never opens a round (G-4), so it has no '
      + 'votes to validate',
  };

  it('sweeps every exported `assert(state)` in confirmationMachineCore', () => {
    const declared = laneState();
    const swept: string[] = [];
    for (const [name, value] of Object.entries(core)) {
      if (!name.startsWith('assert') || typeof value !== 'function') continue;
      // The rule: state-only barriers are swept. The counter barrier takes the
      // reader as a REQUIRED second argument (no default), so it is covered by
      // the matrix instead — and asserted explicitly below so a default could
      // not silently reappear.
      if (value.length !== 1) continue;
      swept.push(name);
      const reason = NOT_THE_LANES_READER[name];
      if (reason !== undefined) {
        expect(() => (value as (s: unknown) => void)(declared), `${name}: ${reason}`)
          .toThrow(CourtConfirmationTransitionError);
        continue;
      }
      expect(
        () => (value as (s: unknown) => void)(declared),
        `${name} refuses a legal G-4 lane projection — declare it in NOT_THE_LANES_READER `
        + 'with the reason, or fix the barrier (this is the r37-1 class)',
      ).not.toThrow();
    }
    // Teeth: the sweep is not vacuous — it saw the barriers that must tolerate a
    // projection, and the counter barrier is state+reader with no default.
    expect(swept).toEqual(expect.arrayContaining([
      'assertValidEscalationLog', 'assertValidConfirmationLedger',
      'assertValidOutcomeHistory', 'assertValidMassVoteLedger',
    ]));
    expect((core.assertRoundCountersAgree as (...args: unknown[]) => void).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Absent" means the machine produced it
// ─────────────────────────────────────────────────────────────────────────────

describe('v0.15.3 — "absent" means the machine produced it', () => {
  it('the factory and the reducer never set `projection`', () => {
    const fresh = createCourtConfirmationMachine({
      sessionHash: '11'.repeat(32),
      proposalHash: '33'.repeat(32),
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [1, 2, 3],
      confirmQuorum: 1,
      confirmDeadline: 100,
      challengeDeadline: 200,
    });
    expect(fresh).not.toHaveProperty('projection');
    const next = reduceCourtConfirmationMachine(fresh, {
      type: 'accept_confirmation',
      idx: 1,
      confirmHash: hashCourtConfirmation({
        sessionHash: '11'.repeat(32), proposalHash: '33'.repeat(32), idx: 1,
      }),
      eventId: 'aa'.repeat(32),
      now: 10,
    });
    expect(next).not.toHaveProperty('projection');
  });
});
