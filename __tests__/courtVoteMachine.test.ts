// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  CourtVoteTransitionError,
  createCourtVoteMachine,
  hashCourtVerdict,
  hashCourtVoteCommit,
  hashDisputeVerdict,
  reduceCourtVoteMachine,
  type CourtVoteMachineState,
} from '../courtVoteMachine';

const SESSION = '11'.repeat(32);
const OTHER_SESSION = '22'.repeat(32);

const COMMIT_DEADLINE = 200;
const REVEAL_DEADLINE = 400;
const OUTCOMES = ['no', 'yes'] as const;

const SALTS = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)] as const;
const COMMIT_EVENTS = ['d1'.repeat(32), 'd2'.repeat(32), 'd3'.repeat(32)] as const;
const REVEAL_EVENTS = ['e1'.repeat(32), 'e2'.repeat(32), 'e3'.repeat(32)] as const;

function commitFor(idx: number, outcome: string, sessionHash = SESSION) {
  return {
    type: 'accept_commit' as const,
    idx,
    commitHash: hashCourtVoteCommit({ sessionHash, outcome, salt: SALTS[idx - 1] }),
    eventId: COMMIT_EVENTS[idx - 1],
    now: 100,
  };
}

function revealFor(idx: number, outcome: string) {
  return {
    type: 'accept_reveal' as const,
    idx,
    outcome,
    salt: SALTS[idx - 1],
    eventId: REVEAL_EVENTS[idx - 1],
    now: 300,
  };
}

function initial(sessionHash = SESSION): CourtVoteMachineState {
  return createCourtVoteMachine({
    sessionHash,
    participantIndices: [1, 2, 3],
    allowedOutcomes: [...OUTCOMES],
    commitDeadline: COMMIT_DEADLINE,
    revealDeadline: REVEAL_DEADLINE,
  });
}

function toRevealOpen(state: CourtVoteMachineState): CourtVoteMachineState {
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: COMMIT_DEADLINE });
  return reduceCourtVoteMachine(state, { type: 'open_reveals', now: COMMIT_DEADLINE + 1 });
}

describe('Court vote state machine', () => {
  it('tallies only committed reveals and freezes a canonical verdict hash', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    state = reduceCourtVoteMachine(state, commitFor(2, 'yes'));
    state = reduceCourtVoteMachine(state, commitFor(3, 'no'));
    state = toRevealOpen(state);
    state = reduceCourtVoteMachine(state, revealFor(1, 'yes'));
    state = reduceCourtVoteMachine(state, revealFor(2, 'yes'));
    state = reduceCourtVoteMachine(state, revealFor(3, 'no'));
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: REVEAL_DEADLINE + 1 });

    expect(state.phase).toBe('tally_final');
    expect(state.verdict?.outcome).toBe('yes');
    expect(state.verdict?.supportingEventIds).toEqual(
      [REVEAL_EVENTS[0], REVEAL_EVENTS[1]].sort(),
    );
    expect(state.verdict?.verdictHash).toBe(
      hashCourtVerdict({
        sessionHash: SESSION,
        outcome: 'yes',
        supportingEventIds: [REVEAL_EVENTS[0], REVEAL_EVENTS[1]].sort(),
      }),
    );
  });

  it('rejects reveals without a prior commit and commits after the deadline', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    state = toRevealOpen(state);

    expect(() => reduceCourtVoteMachine(state, revealFor(2, 'yes'))).toThrow(/without a prior/);
    expect(() =>
      reduceCourtVoteMachine(initial(), { ...commitFor(1, 'yes'), now: COMMIT_DEADLINE }),
    ).toThrow(/commit deadline/);
  });

  it('rejects reveals that do not match the exact session-bound commit', () => {
    let state = initial();
    // Juror 1 commits to 'no' but tries to reveal 'yes'.
    state = reduceCourtVoteMachine(state, commitFor(1, 'no'));
    state = toRevealOpen(state);
    expect(() => reduceCourtVoteMachine(state, revealFor(1, 'yes'))).toThrow(/does not match/);

    // A commit valid in another session is meaningless here.
    let foreign = initial(OTHER_SESSION);
    foreign = reduceCourtVoteMachine(foreign, commitFor(1, 'yes', OTHER_SESSION));
    foreign = toRevealOpen(foreign);
    expect(() =>
      reduceCourtVoteMachine(foreign, { ...revealFor(1, 'yes') }),
    ).not.toThrow();
    expect(() => reduceCourtVoteMachine(toRevealOpen(reduceCourtVoteMachine(initial(), {
      type: 'accept_commit',
      idx: 1,
      commitHash: hashCourtVoteCommit({ sessionHash: OTHER_SESSION, outcome: 'yes', salt: SALTS[0] }),
      eventId: COMMIT_EVENTS[0],
      now: 100,
    })), revealFor(1, 'yes'))).toThrow(/does not match/);
  });

  it('rejects outcomes outside the frozen allowlist', () => {
    let state = initial();
    const rogueCommit = hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'maybe', salt: SALTS[0] });
    state = reduceCourtVoteMachine(state, {
      type: 'accept_commit', idx: 1, commitHash: rogueCommit, eventId: COMMIT_EVENTS[0], now: 100,
    });
    state = toRevealOpen(state);
    expect(() => reduceCourtVoteMachine(state, {
      type: 'accept_reveal', idx: 1, outcome: 'maybe', salt: SALTS[0], eventId: REVEAL_EVENTS[0], now: 300,
    })).toThrow(/allowlist/);
  });

  it('allows exactly one commit per roster participant', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));

    const repeated = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    expect(repeated.commits).toHaveLength(1);

    expect(() =>
      reduceCourtVoteMachine(state, {
        type: 'accept_commit', idx: 1, commitHash: 'ff'.repeat(32), eventId: 'f0'.repeat(32), now: 101,
      }),
    ).toThrow(/conflicting vote commit/);
  });

  it('breaks ties deterministically in favor of the lexicographically smaller outcome', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    state = reduceCourtVoteMachine(state, commitFor(2, 'no'));
    state = toRevealOpen(state);
    state = reduceCourtVoteMachine(state, revealFor(1, 'yes'));
    state = reduceCourtVoteMachine(state, revealFor(2, 'no'));
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: REVEAL_DEADLINE + 1 });
    expect(state.verdict?.outcome).toBe('no');
  });

  it('expires after the reveal deadline and rejects late finalization', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    const expired = reduceCourtVoteMachine(state, { type: 'tick', now: REVEAL_DEADLINE });
    expect(expired.phase).toBe('expired');
    expect(expired.verdict).toBeUndefined();
    expect(() =>
      reduceCourtVoteMachine(expired, { type: 'finalize_tally', now: REVEAL_DEADLINE + 1 }),
    ).toThrow(CourtVoteTransitionError);
  });

  it('refuses to finalize a verdict without any valid reveal', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    state = toRevealOpen(state);
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
    expect(() =>
      reduceCourtVoteMachine(state, { type: 'finalize_tally', now: REVEAL_DEADLINE + 1 }),
    ).toThrow(/without any valid reveal/);
  });

  it('rejects out-of-roster voters and non-sequential participant lists', () => {
    expect(() =>
      createCourtVoteMachine({
        sessionHash: SESSION,
        participantIndices: [1, 3],
        allowedOutcomes: [...OUTCOMES],
        commitDeadline: COMMIT_DEADLINE,
        revealDeadline: REVEAL_DEADLINE,
      }),
    ).toThrow(/sequential/);

    expect(() =>
      reduceCourtVoteMachine(initial(), {
        type: 'accept_commit',
        idx: 4,
        commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'yes', salt: SALTS[0] }),
        eventId: COMMIT_EVENTS[0],
        now: 100,
      }),
    ).toThrow(/outside the certified roster/);
  });

  // Regression (2026-08-18 review): after close_reveals runs at/after the
  // reveal deadline, the machine is one step from finalization — a clock tick
  // must NOT expire it (the old tick handler expired every non-terminal phase
  // once the deadline passed, bricking the ceremony before finalize_tally).
  it('does not expire reveal_closed by tick before finalization', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes'));
    state = toRevealOpen(state);
    state = reduceCourtVoteMachine(state, revealFor(1, 'yes'));
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
    expect(state.phase).toBe('reveal_closed');

    state = reduceCourtVoteMachine(state, { type: 'tick', now: REVEAL_DEADLINE + 1 });
    expect(state.phase).toBe('reveal_closed');

    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: REVEAL_DEADLINE + 1 });
    expect(state.phase).toBe('tally_final');
    expect(state.verdict?.outcome).toBe('yes');
  });

  // V12 audit: a caller must not be able to roll the clock back to re-admit
  // reveals after a later close, or hold the ceremony open past a deadline a
  // later event already observed.
  it('rejects timestamp rollback on any time-bearing event', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, commitFor(1, 'yes')); // now 100
    expect(() => reduceCourtVoteMachine(state, commitFor(2, 'yes'))).not.toThrow();
    expect(() =>
      reduceCourtVoteMachine(state, { type: 'close_commits', now: 50 }),
    ).toThrow(/must not precede/);
    expect(() => reduceCourtVoteMachine(state, { type: 'tick', now: 99 })).toThrow(/must not precede/);
  });

  // V12 audit: returned state must be immutable so a holder cannot expand the
  // frozen ballot or roster between transitions.
  it('freezes configuration and ledger state against caller mutation', () => {
    const state = initial();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.participantIndices)).toBe(true);
    expect(Object.isFrozen(state.allowedOutcomes)).toBe(true);
    expect(() => (state.allowedOutcomes as string[]).push('maybe')).toThrow(TypeError);
    expect(() => (state.participantIndices as number[]).push(4)).toThrow(TypeError);

    const tallied = reduceCourtVoteMachine(
      reduceCourtVoteMachine(reduceCourtVoteMachine(initial(), commitFor(1, 'yes')), {
        type: 'accept_commit',
        idx: 2,
        commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'no', salt: SALTS[1] }),
        eventId: COMMIT_EVENTS[1],
        now: 101,
      }),
      { type: 'close_commits', now: COMMIT_DEADLINE },
    );
    expect(Object.isFrozen(tallied.commits)).toBe(true);
    expect(Object.isFrozen(tallied.commits[0])).toBe(true);
  });

  // V12 audit: the protocol tie-break must be canonical unsigned UTF-8 byte
  // order, which differs from JavaScript's UTF-16 `<` for supplementary-plane
  // characters (U+1F4A9 vs U+E000: UTF-16 orders 💩 first, UTF-8 orders the
  // 3-byte U+E000 first).
  it('breaks ties by canonical UTF-8 byte order, not UTF-16 code units', () => {
    const emoji = '\u{1F4A9}';
    const privateUse = '\uE000';
    const machine = createCourtVoteMachine({
      sessionHash: SESSION,
      participantIndices: [1, 2],
      allowedOutcomes: [emoji, privateUse],
      commitDeadline: COMMIT_DEADLINE,
      revealDeadline: REVEAL_DEADLINE,
    });
    let state = reduceCourtVoteMachine(machine, {
      type: 'accept_commit', idx: 1, commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: emoji, salt: SALTS[0] }), eventId: COMMIT_EVENTS[0], now: 100,
    });
    state = reduceCourtVoteMachine(state, {
      type: 'accept_commit', idx: 2, commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: privateUse, salt: SALTS[1] }), eventId: COMMIT_EVENTS[1], now: 101,
    });
    state = toRevealOpen(state);
    state = reduceCourtVoteMachine(state, { type: 'accept_reveal', idx: 1, outcome: emoji, salt: SALTS[0], eventId: REVEAL_EVENTS[0], now: 300 });
    state = reduceCourtVoteMachine(state, { type: 'accept_reveal', idx: 2, outcome: privateUse, salt: SALTS[1], eventId: REVEAL_EVENTS[1], now: 301 });
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: REVEAL_DEADLINE });
    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: REVEAL_DEADLINE + 1 });
    // \uE000 (3-byte UTF-8, EE 80 80) sorts before 💩 (4-byte UTF-8, F0 ...)
    expect(state.verdict?.outcome).toBe(privateUse);
  });

  // V12 audit: opening reveals at or after the reveal deadline must fail — a
  // late-open path could otherwise hold an empty ledger open forever.
  it('rejects opening vote reveals at or after the reveal deadline', () => {
    let state = initial();
    state = reduceCourtVoteMachine(state, { type: 'close_commits', now: COMMIT_DEADLINE });
    expect(() =>
      reduceCourtVoteMachine(state, { type: 'open_reveals', now: REVEAL_DEADLINE }),
    ).toThrow(/at or after the reveal deadline/);
  });

  // V12 audit: the exported hash helpers must reject malformed or unbounded
  // inputs instead of hashing coercible or oversized preimages.
  it('validates vote-commit and verdict hash inputs before hashing', () => {
    expect(() =>
      hashCourtVoteCommit({ sessionHash: 'not-hex', outcome: 'yes', salt: SALTS[0] }),
    ).toThrow(CourtVoteTransitionError);
    expect(() =>
      hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'x'.repeat(300), salt: SALTS[0] }),
    ).toThrow(CourtVoteTransitionError);
    expect(() =>
      hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'yes', salt: 'short' }),
    ).toThrow(CourtVoteTransitionError);
    expect(() =>
      hashDisputeVerdict({ disputeId: 'short', outcome: 'yes', supportingEventIds: ['a'.repeat(64)] }),
    ).toThrow(CourtVoteTransitionError);
    expect(() =>
      hashDisputeVerdict({ disputeId: 'a'.repeat(64), outcome: 'yes', supportingEventIds: [] }),
    ).toThrow(CourtVoteTransitionError);
    expect(() =>
      hashDisputeVerdict({ disputeId: 'a'.repeat(64), outcome: 'yes', supportingEventIds: ['ZZ'] }),
    ).toThrow(CourtVoteTransitionError);
  });
});
