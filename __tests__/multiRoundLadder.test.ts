// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Multi-round ladder escalation for the universal-confirmation machine
 * (v0.9, universal-confirmation proposal §4.2):
 *
 *   - rounds grow host-side (r1=15, r2=45, r3=135 reference panels) with
 *     per-round roster expansion (`open_ladder_round.roundRoster`);
 *   - every round resolution with rounds remaining parks in
 *     `round_resolved`, where the host plays `escalate` or `concede` —
 *     the machine never auto-escalates;
 *   - flip-flop clawback accounting (`round_flip`) alongside the v0.8.5
 *     `overturned_confirmation` flag, append-only and idempotent;
 *   - append-only `outcomeHistory`; finality = LAST resolved round;
 *   - `maxLadderRounds` cap (default 2, bound 1..5) and full v0.8.5
 *     single-round backward compatibility.
 */

import { describe, expect, it } from 'vitest';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { hashCourtVerdict } from '../courtVoteMachine';

/** Deterministic 32-byte lowercase hex id from a hex-digit string. */
const id = (c: string): string => c.repeat(Math.ceil(64 / c.length)).slice(0, 64);

const SESSION = id('1');
const PROPOSAL = id('2');
const OUTCOMES = ['YES', 'NO'];

type Vote = readonly [idx: number, outcome: 'YES' | 'NO', ev: string];

interface CaseParams {
  readonly maxLadderRounds?: number;
  readonly roster?: readonly number[];
}

function create(params: CaseParams = {}): CourtConfirmationMachineState {
  return createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: OUTCOMES,
    participantIndices: params.roster ?? [1, 2, 3],
    confirmQuorum: 3,
    confirmDeadline: 2000,
    challengeDeadline: 3000,
    ...(params.maxLadderRounds !== undefined ? { maxLadderRounds: params.maxLadderRounds } : {}),
  });
}

function confirmAs(state: CourtConfirmationMachineState, indices: readonly number[]): CourtConfirmationMachineState {
  let s = state;
  for (const idx of indices) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: id(`c${idx}`),
      now: 1000 + idx,
    });
  }
  return s;
}

/** Challenge by juror 2 and close the window → ladder_pending. */
function challenge(state: CourtConfirmationMachineState): CourtConfirmationMachineState {
  let s = reduceCourtConfirmationMachine(state, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: id('d'),
    bondProofHash: id('e'),
    eventId: id('f'),
    now: 2500,
  });
  return reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
}

/** Open round `round` of the ladder (phase must be ladder_pending). */
function openRound(
  state: CourtConfirmationMachineState,
  round: number,
  opts: { readonly roster?: readonly number[]; readonly voteDeadline: number; readonly now: number },
): CourtConfirmationMachineState {
  return reduceCourtConfirmationMachine(state, {
    type: 'open_ladder_round',
    round,
    voteDeadline: opts.voteDeadline,
    ...(opts.roster !== undefined ? { roundRoster: opts.roster } : {}),
    now: opts.now,
  });
}

function voteRound(
  state: CourtConfirmationMachineState,
  votes: readonly Vote[],
  closeAt: number,
): CourtConfirmationMachineState {
  let s = state;
  for (const [idx, outcome, ev] of votes) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote',
      idx,
      outcome,
      eventId: id(ev),
      now: state.ladder!.voteDeadline - 1000 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: closeAt });
  return reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: closeAt + 50 });
}

interface RoundSpec {
  readonly votes: readonly Vote[];
  readonly roster?: readonly number[];
}

/**
 * Challenged case driven through the given rounds, escalating between them
 * (host-driven). Timestamps: round i is open at 3100 + (i-1)*2000 with its
 * vote deadline at 3000 + i*2000 — monotone for any round count.
 */
function ladderToResolved(rounds: ReadonlyArray<RoundSpec>, params: CaseParams = {}): CourtConfirmationMachineState {
  let s = confirmAs(create(params), [1, 2, 3]);
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
  s = challenge(s);
  for (let i = 0; i < rounds.length; i++) {
    const deadline = 3000 + (i + 1) * 2000;
    s = openRound(s, i + 1, { roster: rounds[i]!.roster, voteDeadline: deadline, now: deadline - 1900 });
    s = voteRound(s, rounds[i]!.votes, deadline);
    if (i < rounds.length - 1) {
      s = reduceCourtConfirmationMachine(s, { type: 'escalate', now: deadline + 100 });
    }
  }
  return s;
}

/** Majority-YES vote set for an n-seat panel (fixed-width hex event ids per round). */
const yesMajority = (n: number, round: number): Vote[] =>
  Array.from({ length: Math.floor(n / 2) + 1 }, (_, j) => [
    j + 1,
    'YES',
    `${round}${j.toString(16).padStart(3, '0')}`,
  ] as const);

describe('multi-round ladder: round growth and roster expansion', () => {
  it('grows 15 → 45 → 135 panels across three escalated rounds (round count tracked, panels host-side)', () => {
    // Reference panel sizes live host-side; the machine tracks rounds/votes
    // and accepts an expanded roster per round.
    const panels = [15, 45, 135].map((n) => Array.from({ length: n }, (_, i) => i + 1));
    const s = ladderToResolved(
      panels.map((panel, i) => ({
        roster: panel,
        votes: yesMajority(panel.length, i + 1),
      })),
      { roster: panels[0], maxLadderRounds: 3 },
    );
    expect(s.phase).toBe('fee_settlement'); // round 3 === maxLadderRounds 3
    expect(s.ladderRound).toBe(3);
    expect(s.verdict?.outcome).toBe('YES');
    expect(s.outcomeHistory.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(s.outcomeHistory.map((r) => r.winnerIndices.length)).toEqual([8, 23, 68]);
  });

  it('accepts an expanded round roster: a round-2 joiner outside the case roster may vote', () => {
    const s = ladderToResolved(
      [
        { votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] },
        { roster: [1, 2, 3, 4, 5], votes: [[1, 'NO', 'b1'], [2, 'NO', 'b2'], [3, 'NO', 'b3'], [5, 'NO', 'b5']] },
      ],
      { maxLadderRounds: 2 },
    );
    // Round 2 === maxLadderRounds → fee_settlement, final = round 2 winner.
    expect(s.phase).toBe('fee_settlement');
    expect(s.verdict?.outcome).toBe('NO');
    // idx 5 voted in round 2 but is not in the case roster [1,2,3].
    expect(s.ladder?.roundRoster).toEqual([1, 2, 3, 4, 5]);
    expect(s.outcomeHistory[1]!.winnerIndices).toEqual([1, 2, 3, 5]);
  });

  it('does NOT require the round roster to be a superset of the previous round (shrinking panel is legal)', () => {
    const s = ladderToResolved(
      [
        { roster: [1, 2, 3, 4, 5], votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] },
        { roster: [1, 2, 3], votes: [[1, 'NO', 'b1'], [2, 'YES', 'b2'], [3, 'YES', 'b3']] },
      ],
      { maxLadderRounds: 2 },
    );
    expect(s.phase).toBe('fee_settlement');
    expect(s.ladder?.roundRoster).toEqual([1, 2, 3]);
  });

  it('rejects malformed round rosters: non-sequential, < 3 seats, and votes outside the ROUND panel', () => {
    let s = confirmAs(create(), [1, 2, 3]);
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
    s = challenge(s);
    // Not sequential:
    expect(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'open_ladder_round', round: 1, voteDeadline: 5000, roundRoster: [1, 3, 4], now: 3100,
      }),
    ).toThrow(/ordered and sequential/);
    // Fewer than 3 seats:
    expect(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'open_ladder_round', round: 1, voteDeadline: 5000, roundRoster: [1, 2], now: 3100,
      }),
    ).toThrow(/at least 3 participants/);
    // Legal opening with an expanded panel; then a vote from idx 6 (outside
    // the round panel 1..5) is rejected:
    const opened = reduceCourtConfirmationMachine(s, {
      type: 'open_ladder_round', round: 1, voteDeadline: 5000, roundRoster: [1, 2, 3, 4, 5], now: 3100,
    });
    expect(() =>
      reduceCourtConfirmationMachine(opened, {
        type: 'accept_mass_vote', idx: 6, outcome: 'YES', eventId: id('6'), now: 4950,
      }),
    ).toThrow(/roster/);
    // And a round-roster tamper on a restored snapshot fails the close-time
    // ledger barrier (sequential 1..N, N ≥ 3 re-verified):
    const tampered: CourtConfirmationMachineState = {
      ...opened,
      ladder: {
        ...opened.ladder!,
        roundRoster: [1, 2],
        votes: [
          { idx: 1, outcome: 'YES', eventId: id('1') },
          { idx: 2, outcome: 'YES', eventId: id('2') },
        ],
      },
    };
    expect(() =>
      reduceCourtConfirmationMachine(tampered, { type: 'close_ladder_round', now: 5000 }),
    ).toThrow(/at least 3 participants/);
  });
});

describe('multi-round ladder: escalate/concede decision matrix', () => {
  it('escalate re-opens the ladder for the next consecutive round; the machine never auto-escalates', () => {
    let s = ladderToResolved([{ votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] }]);
    // Upheld at round 1 — still parks in round_resolved (host decides).
    expect(s.phase).toBe('round_resolved');
    s = reduceCourtConfirmationMachine(s, { type: 'escalate', now: 5100 });
    expect(s.phase).toBe('ladder_pending');
    // Round numbering stays consecutive after escalation:
    s = openRound(s, 2, { voteDeadline: 7000, now: 5200 });
    expect(s.ladderRound).toBe(2);
  });

  it('concede settles with the current round outcome as final', () => {
    let s = ladderToResolved([{ votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] }]);
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 5100 });
    expect(s.phase).toBe('fee_settlement');
    const done = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 5200 });
    expect(done.phase).toBe('final');
    expect(done.verdict?.outcome).toBe('NO');
    expect(done.verdict?.upheld).toBe(false);
    expect(done.verdict?.supportingEventIds).toEqual([id('a1'), id('a2')].sort());
    expect(done.verdict?.verdictHash).toBe(
      hashCourtVerdict({ sessionHash: SESSION, outcome: 'NO', supportingEventIds: [id('a1'), id('a2')].sort() }),
    );
  });

  it('rejects escalate/concede outside round_resolved and double decisions', () => {
    const resolved = ladderToResolved([{ votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] }]);
    // From fee_settlement (post-concede):
    const conceded = reduceCourtConfirmationMachine(resolved, { type: 'concede', now: 5100 });
    expect(() => reduceCourtConfirmationMachine(conceded, { type: 'escalate', now: 5110 })).toThrow(/during fee_settlement/);
    expect(() => reduceCourtConfirmationMachine(conceded, { type: 'concede', now: 5110 })).toThrow(/during fee_settlement/);
    // Double decision from round_resolved:
    const escalated = reduceCourtConfirmationMachine(resolved, { type: 'escalate', now: 5100 });
    expect(() => reduceCourtConfirmationMachine(escalated, { type: 'escalate', now: 5110 })).toThrow(/during ladder_pending/);
    expect(() => reduceCourtConfirmationMachine(escalated, { type: 'concede', now: 5110 })).toThrow(/during ladder_pending/);
    // From earlier phases:
    expect(() => reduceCourtConfirmationMachine(create(), { type: 'escalate', now: 1100 })).toThrow(/during confirm_open/);
    expect(() => reduceCourtConfirmationMachine(create(), { type: 'concede', now: 1100 })).toThrow(/during confirm_open/);
    // Finalize before the host decision is illegal:
    expect(() => reduceCourtConfirmationMachine(resolved, { type: 'finalize', now: 5100 })).toThrow(
      /during round_resolved/,
    );
  });

  it('a round_resolved case is tick-exempt while awaiting the host decision (the appeal window is host policy)', () => {
    const resolved = ladderToResolved([{ votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] }]);
    expect(reduceCourtConfirmationMachine(resolved, { type: 'tick', now: 999_999 }).phase).toBe('round_resolved');
  });
});

describe('multi-round ladder: flip-flop clawback accounting', () => {
  it("flags the previous round's majority with 'round_flip' when the winner changes; append-only and idempotent", () => {
    // r1: NO wins (proposal overturned → confirmers flagged once).
    // r2: YES wins (flip vs r1 → r1's NO voters flagged round_flip@r1).
    // r3: YES wins again (no flip → no new flags).
    const s = ladderToResolved(
      [
        { votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] },
        { votes: [[1, 'YES', 'b1'], [2, 'YES', 'b2'], [3, 'NO', 'b3']] },
        { votes: [[1, 'YES', 'c1'], [2, 'YES', 'c2'], [3, 'YES', 'c3']] },
      ],
      { maxLadderRounds: 3 },
    );
    expect(s.clawbackFlags).toEqual([
      { idx: 1, reason: 'overturned_confirmation', round: 1 },
      { idx: 2, reason: 'overturned_confirmation', round: 1 },
      { idx: 3, reason: 'overturned_confirmation', round: 1 },
      { idx: 1, reason: 'round_flip', round: 1 },
      { idx: 2, reason: 'round_flip', round: 1 },
    ]);
    // Frozen, append-only ledger:
    expect(Object.isFrozen(s.clawbackFlags)).toBe(true);
  });

  it('does not duplicate overturned_confirmation flags when a later round also rejects the proposal', () => {
    const s = ladderToResolved(
      [
        { votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] },
        { votes: [[1, 'NO', 'b1'], [2, 'NO', 'b2'], [3, 'NO', 'b3']] },
      ],
      { maxLadderRounds: 2 },
    );
    // Both rounds overturn; confirmers flagged exactly once (at round 1),
    // no round_flip (same winner both rounds).
    expect(s.clawbackFlags).toEqual([
      { idx: 1, reason: 'overturned_confirmation', round: 1 },
      { idx: 2, reason: 'overturned_confirmation', round: 1 },
      { idx: 3, reason: 'overturned_confirmation', round: 1 },
    ]);
  });

  it('keeps the ledger empty across upheld rounds with no flips', () => {
    const s = ladderToResolved(
      [
        { votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] },
        { votes: [[1, 'YES', 'b1'], [2, 'NO', 'b2'], [3, 'YES', 'b3']] },
      ],
      { maxLadderRounds: 2 },
    );
    expect(s.clawbackFlags).toHaveLength(0);
    expect(s.verdict?.upheld).toBe(true);
  });
});

describe('multi-round ladder: outcomeHistory integrity and finality', () => {
  it('records append-only frozen {round, outcome, winnerEventIds, winnerIndices} per resolved round', () => {
    const s = ladderToResolved(
      [
        { votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] },
        { votes: [[1, 'YES', 'b1'], [2, 'YES', 'b2'], [3, 'NO', 'b3']] },
      ],
      { maxLadderRounds: 2 },
    );
    expect(s.outcomeHistory).toEqual([
      { round: 1, outcome: 'NO', winnerEventIds: [id('a1'), id('a2')].sort(), winnerIndices: [1, 2] },
      { round: 2, outcome: 'YES', winnerEventIds: [id('b1'), id('b2')].sort(), winnerIndices: [1, 2] },
    ]);
    expect(Object.isFrozen(s.outcomeHistory)).toBe(true);
    expect(s.outcomeHistory.every((r) => Object.isFrozen(r) && Object.isFrozen(r.winnerEventIds) && Object.isFrozen(r.winnerIndices))).toBe(true);
  });

  it('finality = LAST resolved round: verdict outcome + supporting ids from that round only', () => {
    const s = ladderToResolved(
      [
        { votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] },
        { votes: [[1, 'YES', 'b1'], [2, 'YES', 'b2'], [3, 'NO', 'b3']] },
      ],
      { maxLadderRounds: 2 },
    );
    const done = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 7200 });
    expect(done.verdict?.outcome).toBe('YES');
    // Round 2's winning ids — round 1's winners must NOT leak into the verdict.
    expect(done.verdict?.supportingEventIds).toEqual([id('b1'), id('b2')].sort());
    expect(done.verdict?.verdictHash).toBe(
      hashCourtVerdict({ sessionHash: SESSION, outcome: 'YES', supportingEventIds: [id('b1'), id('b2')].sort() }),
    );
    expect(done.outcomeHistory).toHaveLength(2);
  });
});

describe('multi-round ladder: maxLadderRounds enforcement', () => {
  it('bounds the parameter 1..5 and rejects non-integers', () => {
    expect(() => create({ maxLadderRounds: 0 })).toThrow(/maxLadderRounds/);
    expect(() => create({ maxLadderRounds: 6 })).toThrow(/maxLadderRounds/);
    expect(() => create({ maxLadderRounds: 2.5 })).toThrow(/maxLadderRounds/);
    for (const n of [1, 2, 3, 4, 5]) expect(() => create({ maxLadderRounds: n })).not.toThrow();
  });

  it('defaults to 2: round 1 parks in round_resolved, round 2 settles directly', () => {
    const afterR1 = ladderToResolved([{ votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] }]);
    expect(afterR1.phase).toBe('round_resolved');
    expect(afterR1.maxLadderRounds).toBe(2);
    const afterR2 = ladderToResolved(
      [
        { votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] },
        { votes: [[1, 'YES', 'b1'], [2, 'YES', 'b2'], [3, 'YES', 'b3']] },
      ],
    );
    expect(afterR2.phase).toBe('fee_settlement');
  });

  it('rounds beyond the last settle without a concede; escalate is impossible once settled', () => {
    // maxLadderRounds=1: round 1 IS the final round — the v0.8.5 shape.
    const single = ladderToResolved(
      [{ votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] }],
      { maxLadderRounds: 1 },
    );
    expect(single.phase).toBe('fee_settlement');
    expect(() => reduceCourtConfirmationMachine(single, { type: 'escalate', now: 5200 })).toThrow(
      /during fee_settlement/,
    );
  });

  it('hand-restored snapshots cannot bypass the cap (ladder_pending above the cap, escalate at the cap)', () => {
    const single = ladderToResolved(
      [{ votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] }],
      { maxLadderRounds: 1 },
    );
    // Tampered snapshot: ladder_pending with the cap already reached.
    const rogue: CourtConfirmationMachineState = { ...single, phase: 'ladder_pending' };
    expect(() =>
      reduceCourtConfirmationMachine(rogue, { type: 'open_ladder_round', round: 2, voteDeadline: 6000, now: 5300 }),
    ).toThrow(/exceeds maxLadderRounds/);
    // Tampered snapshot: round_resolved with the cap already reached.
    const rogueEscalate: CourtConfirmationMachineState = {
      ...ladderToResolved([{ votes: [[1, 'YES', 'a1'], [2, 'YES', 'a2'], [3, 'YES', 'a3']] }]),
      maxLadderRounds: 1,
    };
    expect(() => reduceCourtConfirmationMachine(rogueEscalate, { type: 'escalate', now: 5110 })).toThrow(
      /maxLadderRounds/,
    );
  });
});

describe('multi-round ladder: v0.8.5 backward compatibility', () => {
  it('maxLadderRounds=1 reproduces the v0.8.5 single-round flow exactly (no concede needed)', () => {
    const s = ladderToResolved(
      [{ votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] }],
      { maxLadderRounds: 1 },
    );
    expect(s.phase).toBe('fee_settlement');
    expect(s.verdict?.outcome).toBe('NO');
    expect(s.clawbackFlags).toEqual([
      { idx: 1, reason: 'overturned_confirmation', round: 1 },
      { idx: 2, reason: 'overturned_confirmation', round: 1 },
      { idx: 3, reason: 'overturned_confirmation', round: 1 },
    ]);
    const done = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 5200 });
    expect(done.verdict?.verdictHash).toBe(
      hashCourtVerdict({ sessionHash: SESSION, outcome: 'NO', supportingEventIds: [id('a1'), id('a2')].sort() }),
    );
  });

  it('default-cap flow with an explicit concede is verdict-identical to the v0.8.5 single-round result', () => {
    const legacy = reduceCourtConfirmationMachine(
      ladderToResolved([{ votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] }], { maxLadderRounds: 1 }),
      { type: 'finalize', now: 5200 },
    );
    let modern = ladderToResolved([{ votes: [[1, 'NO', 'a1'], [2, 'NO', 'a2'], [3, 'YES', 'a3']] }]);
    modern = reduceCourtConfirmationMachine(modern, { type: 'concede', now: 5100 });
    modern = reduceCourtConfirmationMachine(modern, { type: 'finalize', now: 5200 });
    expect(modern.verdict?.verdictHash).toBe(legacy.verdict?.verdictHash);
    expect(modern.verdict).toEqual(legacy.verdict);
    expect(modern.clawbackFlags).toEqual(legacy.clawbackFlags);
  });
});
