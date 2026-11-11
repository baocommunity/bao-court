// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * REVIEW ROUND 6 — attacking the ROUND-5 fix (one-hash-one-index) and the
 * ROUND-37/38 fixes around it.
 *
 * Round 5 closed r38-1 (one bond witness bought two challengers' standing) by
 * making `accept_challenge` bind one `bondProofHash` to one roster index and
 * teaching `assertValidConfirmationLedger` the same rule. Round 37 (r37-1) fixed
 * the restore barrier refusing a LEGAL `ladder_pending` snapshot. This round
 * attacks exactly those two seams:
 *
 *   T1 one-hash-one-index            → §1 (2 EXPLOITABLE, fixed here; 1 registered)
 *   T2 complete ledger / over-strict → §2 (legal-state hunt: 0 refusals)
 *   T3 deriveLadderFlipRound ∧ cap   → §3 (1 host PARTIAL, probed)
 *   T4 the round-5 docs              → §4 (doc assertions turned into pins)
 *
 * Every test is a CLOSURE (red before the fix in this PR), a PIN of a guard that
 * holds, or a PIN of a residual named `(registered …)`.
 *
 * The closures were verified by restoring the two fixed files from `origin/main`
 * (`git checkout origin/main -- confirmationMachineHandlers.ts`): tests 1, 4, 5
 * and 16 fail there and pass here.
 */

import { describe, expect, it } from 'vitest';

import {
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  hostEscalationEvent,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  MAX_LADDER_ROUNDS,
  assertValidConfirmationLedger,
  assertValidEscalationLog,
} from '../confirmationMachineCore';
import {
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  escalationOptionEv,
  ladderCapWithinBound,
  ladderSignBoundary,
} from '../ladderEconomics';
import { hexId, padHexId } from './helpers/ids';

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;
const PUBKEY = hexId('7');
const REQUEST = hexId('8');
/** Juror 2's accepted membership (challenge) bond. */
const MEMBERSHIP_2 = hexId('e');
/** Juror 3's accepted membership (challenge) bond. */
const MEMBERSHIP_3 = hexId('b');
const BOND_TXID_2 = hexId('d');
const BOND_TXID_3 = hexId('f');
const roundBond = (r: number): string => padHexId(`a${r}`);

const restore = (s: CourtConfirmationMachineState): CourtConfirmationMachineState =>
  JSON.parse(JSON.stringify(s)) as CourtConfirmationMachineState;

/** A restored snapshot whose escalation log was REPLACED (readonly field). */
const withLog = (
  s: CourtConfirmationMachineState,
  records: readonly unknown[],
): CourtConfirmationMachineState =>
  ({ ...restore(s), escalationLog: records } as unknown as CourtConfirmationMachineState);

/** A clock that only moves forward, so a walk never trips the ledger. */
function makeClock(): { now: () => number; jumpTo: (t: number) => number } {
  let t = 0;
  return {
    now: () => (t += 1),
    jumpTo: (to: number) => (t = Math.max(t, to)),
  };
}

type Clock = ReturnType<typeof makeClock>;

function confirmAndOpenChallenge(strict = false, host = false, maxRounds = 4, clock = makeClock()) {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 10,
    challengeDeadline: 20,
    maxLadderRounds: maxRounds,
    requireRoundBond: strict,
    hostEscalation: host,
  });
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: padHexId(`c${idx}`),
      now: clock.now(),
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: clock.jumpTo(10) });
  return reduceCourtConfirmationMachine(s, {
    type: 'open_challenge_window',
    now: clock.jumpTo(11),
  });
}

/** A challenged case parked at `round_resolved` after round 1. */
function resolvedRoundOne(opts: {
  readonly strict?: boolean;
  readonly host?: boolean;
  readonly maxRounds?: number;
} = {}): { state: CourtConfirmationMachineState; clock: Clock } {
  const clock = makeClock();
  let s = confirmAndOpenChallenge(
    opts.strict ?? false,
    opts.host ?? false,
    opts.maxRounds ?? 4,
    clock,
  );
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: BOND_TXID_2,
    bondProofHash: MEMBERSHIP_2,
    eventId: padHexId('e2'),
    now: clock.jumpTo(12),
  });
  s = reduceCourtConfirmationMachine(s, {
    type: 'close_challenge_window',
    now: clock.jumpTo(20),
  });
  const deadline = 40;
  s = reduceCourtConfirmationMachine(s, {
    type: 'open_ladder_round',
    round: 1,
    voteDeadline: deadline,
    now: clock.jumpTo(21),
  });
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote',
      idx,
      outcome: 'NO',
      eventId: padHexId(`1b${idx}`),
      now: clock.now(),
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: clock.jumpTo(deadline) });
  s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: clock.now() });
  return { state: s, clock };
}

/** A challenged case parked at `ladder_pending` for round 2 (one log record). */
function ladderPending(strict = true): { state: CourtConfirmationMachineState; clock: Clock } {
  const { state, clock } = resolvedRoundOne({ strict });
  const escalated = reduceCourtConfirmationMachine(
    state,
    challengerEscalationEvent(state, clock.now(), {
      challengerPubkey: PUBKEY,
      requestHash: REQUEST,
      challengerIdx: 2,
      roundBondProofHash: roundBond(2),
    }),
  );
  return { state: escalated, clock };
}

/** Walk the legal path as far as `target`, returning the state and clock. */
function atPhase(
  target: 'ladder_vote_open' | 'ladder_vote_closed' | 'fee_settlement',
  strict = true,
): { state: CourtConfirmationMachineState; clock: Clock } {
  const { state, clock } = ladderPending(strict);
  let s = reduceCourtConfirmationMachine(state, {
    type: 'open_ladder_round',
    round: 2,
    voteDeadline: clock.now() + 100,
    now: clock.now(),
  });
  if (target === 'ladder_vote_open') return { state: s, clock };
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote',
      idx,
      outcome: 'NO',
      eventId: padHexId(`2b${idx}`),
      now: clock.now(),
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: clock.jumpTo(clock.now() + 100) });
  if (target === 'ladder_vote_closed') return { state: s, clock };
  s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: clock.now() });
  if (target === 'fee_settlement') {
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: clock.now() });
  }
  return { state: s, clock };
}

/** A duplicate-hash challenge ledger: juror 3 "owns" juror 2's bond witness. */
function withBorrowedBond(s: CourtConfirmationMachineState): CourtConfirmationMachineState {
  const tampered = restore(s);
  (tampered.challenges as unknown as unknown[]).push({
    idx: 3,
    bondTxid: BOND_TXID_2,
    bondProofHash: MEMBERSHIP_2,
    eventId: padHexId('e3'),
  });
  return tampered;
}

function barrierRefuses(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — one-hash-one-index: the barrier must be at every rung-spending entry
// ─────────────────────────────────────────────────────────────────────────────
describe('T1 — one bond witness, one challenger standing', () => {
  it('(r40-1) escalate REFUSES a restored ledger that binds one hash to two participants', () => {
    const { state, clock } = resolvedRoundOne();
    const tampered = withBorrowedBond(state);
    // The pair test r29-1 added (`idx` AND `bondProofHash`) is satisfied for
    // juror 3 by the forged record, so this escalation used to be accepted.
    const event = challengerEscalationEvent(tampered, clock.now(), {
      challengerPubkey: PUBKEY,
      requestHash: REQUEST,
      challengerIdx: 3,
    });
    const message = barrierRefuses(() => reduceCourtConfirmationMachine(tampered, event));
    expect(message).toMatch(/binds one bond proof hash to participants 2 and 3/);
  });

  it('(r40-1) the refusal lands BEFORE a seat is spent — the case is untouched', () => {
    const { state, clock } = resolvedRoundOne();
    const tampered = withBorrowedBond(state);
    expect(() =>
      reduceCourtConfirmationMachine(
        tampered,
        challengerEscalationEvent(tampered, clock.now(), {
          challengerPubkey: PUBKEY,
          requestHash: REQUEST,
          challengerIdx: 3,
        }),
      ),
    ).toThrow();
    // No mutation of the caller's state (fail closed, nothing appended).
    expect(tampered.phase).toBe('round_resolved');
    expect(tampered.escalationLog).toHaveLength(0);
    expect(tampered.ladderRound).toBe(1);
  });

  it('(r40-1) open_ladder_round refuses the same ledger when escalate was skipped', () => {
    const { state, clock } = ladderPending(true);
    const tampered = withBorrowedBond(state);
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(tampered, {
        type: 'open_ladder_round',
        round: 2,
        voteDeadline: clock.now() + 100,
        now: clock.now(),
      }),
    );
    expect(message).toMatch(/binds one bond proof hash to participants 2 and 3/);
  });

  it('the barrier runs at EVERY entry that READS the challenge pool', () => {
    // Entries that read `state.challenges` / the escalation log, each built at
    // the phase where it is legal, with the duplicate hash injected.
    const readers: Array<[string, RegExp, () => CourtConfirmationMachineState, () => unknown]> = [];

    // accept_challenge — its own live rule (the reducer half of r38-1).
    const clock0 = makeClock();
    const window = reduceCourtConfirmationMachine(
      confirmAndOpenChallenge(false, false, 4, clock0),
      {
        type: 'accept_challenge',
        idx: 2,
        bondTxid: BOND_TXID_2,
        bondProofHash: MEMBERSHIP_2,
        eventId: padHexId('e2'),
        now: clock0.now(),
      },
    );
    readers.push([
      'accept_challenge',
      /already bound to participant 2|one bond witness buys one challenger's standing/,
      () => window,
      () => reduceCourtConfirmationMachine(window, {
        type: 'accept_challenge',
        idx: 3,
        bondTxid: BOND_TXID_3,
        bondProofHash: MEMBERSHIP_2,
        eventId: padHexId('e9'),
        now: clock0.now(),
      }),
    ]);

    // escalate — the r40-1 closure.
    {
      const { state, clock } = resolvedRoundOne();
      readers.push([
        'escalate',
        /binds one bond proof hash to participants 2 and 3/,
        () => withBorrowedBond(state),
        () => reduceCourtConfirmationMachine(
          withBorrowedBond(state),
          challengerEscalationEvent(withBorrowedBond(state), clock.now(), {
            challengerPubkey: PUBKEY,
            requestHash: REQUEST,
            challengerIdx: 3,
          }),
        ),
      ]);
    }

    // open_ladder_round — the r40-1 closure for the skipped-escalate restore.
    {
      const { state, clock } = ladderPending(true);
      readers.push([
        'open_ladder_round',
        /binds one bond proof hash to participants 2 and 3/,
        () => withBorrowedBond(state),
        () => reduceCourtConfirmationMachine(withBorrowedBond(state), {
          type: 'open_ladder_round',
          round: 2,
          voteDeadline: clock.now() + 100,
          now: clock.now(),
        }),
      ]);
    }

    // resolve_round — the r38-1 barrier round 5 shipped.
    {
      const { state, clock } = atPhase('ladder_vote_closed');
      readers.push([
        'resolve_round',
        /binds one bond proof hash to participants 2 and 3/,
        () => withBorrowedBond(state),
        () => reduceCourtConfirmationMachine(withBorrowedBond(state), {
          type: 'resolve_round',
          now: clock.now(),
        }),
      ]);
    }

    // finalize — ditto.
    {
      const { state, clock } = atPhase('fee_settlement');
      readers.push([
        'finalize',
        /binds one bond proof hash to participants 2 and 3/,
        () => withBorrowedBond(state),
        () => reduceCourtConfirmationMachine(withBorrowedBond(state), {
          type: 'finalize',
          now: clock.now(),
        }),
      ]);
    }

    for (const [name, expected, , fn] of readers) {
      const message = barrierRefuses(fn);
      expect(`${name}: ${message}`).toMatch(expected);
    }

    // The entries that do NOT read the pool are refused/accepted on their own
    // terms — stated, not faked: `close_ladder_round` reads only the mass-vote
    // ledger, `concede` reads nothing, `flag_clawback` reads the flags. Each of
    // them is followed by a pool-reading barrier before any value is locked in
    // (resolve_round / finalize), so the pool can never be laundered through one.
    expect(
      barrierRefuses(() =>
        assertValidConfirmationLedger(withBorrowedBond(atPhase('ladder_vote_closed').state)),
      ),
    ).toMatch(/binds one bond proof hash/);
  });

  it('no over-correction: a LEGAL round_resolved snapshot still escalates', () => {
    const { state, clock } = resolvedRoundOne();
    const next = reduceCourtConfirmationMachine(
      state,
      challengerEscalationEvent(state, clock.now(), {
        challengerPubkey: PUBKEY,
        requestHash: REQUEST,
        challengerIdx: 2,
      }),
    );
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog).toHaveLength(1);
  });

  it('one hash, one owner at the reducer too (r38-1 re-pinned at this layer)', () => {
    const clock = makeClock();
    let s = confirmAndOpenChallenge(false, false, 4, clock);
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 2,
      bondTxid: BOND_TXID_2,
      bondProofHash: MEMBERSHIP_2,
      eventId: padHexId('e2'),
      now: clock.now(),
    });
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'accept_challenge',
        idx: 3,
        bondTxid: BOND_TXID_2,
        bondProofHash: MEMBERSHIP_2,
        eventId: padHexId('e3'),
        now: clock.now(),
      }),
    );
    expect(message).toMatch(/one bond witness buys one challenger's standing/);
    // Its own bond is admitted, so the rule is uniqueness, not a freeze.
    const ok = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: BOND_TXID_3,
      bondProofHash: MEMBERSHIP_3,
      eventId: padHexId('e3'),
      now: clock.now(),
    });
    expect(ok.challenges).toHaveLength(2);
    expect(new Set(ok.challenges.map((c) => c.bondProofHash)).size).toBe(2);
  });

  it('(registered r40-3) the hash is unique but NOT OWNED: a non-owner registers a derivable witness first', () => {
    const clock = makeClock();
    let s = confirmAndOpenChallenge(false, false, 4, clock);
    // The attacker owns no bond. It can DERIVE this witness (the documented
    // collision shape: `hash(bondTxid)`, public the moment the bond is on
    // chain) and register it under its own index BEFORE the payer's event.
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: BOND_TXID_2,
      bondProofHash: MEMBERSHIP_2,
      eventId: padHexId('e3'),
      now: clock.now(),
    });
    expect(s.challenges[0].idx).toBe(3);
    // The juror that actually posted the bond is now locked out of the case.
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'accept_challenge',
        idx: 2,
        bondTxid: BOND_TXID_2,
        bondProofHash: MEMBERSHIP_2,
        eventId: padHexId('e2'),
        now: clock.now(),
      }),
    );
    expect(message).toMatch(/already bound to participant 3/);
    // Disposition: the HOST's bond verifier must bind the witness to the event
    // author (v0.13's shipped `formatOnlyBondVerifier` cannot), and the v0.14
    // idx→pubkey binding (r38-3) makes it re-derivable. The machine cannot see
    // who sent an event.
  });

  it('cross-case reuse is ACCEPTED by design — the uniqueness pool is per case', () => {
    const first = resolvedRoundOne().state;
    const secondCase = resolvedRoundOne().state;
    // Two independent cases may hold the same hash: the machine's registry is
    // `state.challenges`, scoped to one case (r33-3). The host closes it with a
    // globally unique bond witness.
    expect(first.challenges[0].bondProofHash).toBe(secondCase.challenges[0].bondProofHash);
    expect(() => assertValidConfirmationLedger(first)).not.toThrow();
    expect(() => assertValidConfirmationLedger(secondCase)).not.toThrow();
  });

  it('the collision shape (hash(bondTxid) over a batch) is refused, not silently merged', () => {
    const { state } = resolvedRoundOne();
    // Same hash, DIFFERENT bond txids (a batch payout shares one txid, and a
    // host deriving `hash(bondTxid)` gives every payee the same witness).
    const tampered = restore(state);
    (tampered.challenges as unknown as unknown[]).push({
      idx: 3,
      bondTxid: BOND_TXID_3,
      bondProofHash: MEMBERSHIP_2,
      eventId: padHexId('e7'),
    });
    expect(barrierRefuses(() => assertValidConfirmationLedger(tampered))).toMatch(
      /binds one bond proof hash/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the complete-ledger rule: attack it, then hunt for legal states it refuses
// ─────────────────────────────────────────────────────────────────────────────
describe('T2 — complete ledger and the rung-spend barrier', () => {
  it('(r40-2) a strict log EMPTIED at ladder_pending is refused at open_ladder_round', () => {
    const { state, clock } = ladderPending(true);
    const tampered = withLog(state, []);
    // Before the fix: the rung opened, the round bond was un-consumed, and the
    // case could only brick later, at resolve_round, after the panel was seated.
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(tampered, {
        type: 'open_ladder_round',
        round: 2,
        voteDeadline: clock.now() + 100,
        now: clock.now(),
      }),
    );
    expect(message).toMatch(/escalation log is incomplete/);
  });

  it('(r37-1 re-pinned) a LEGAL ladder_pending snapshot passes every barrier', () => {
    const { state } = ladderPending(true);
    expect(() => assertValidEscalationLog(state)).not.toThrow();
    expect(() => assertValidConfirmationLedger(state)).not.toThrow();
  });

  it('a dropped LAST record at round_resolved is refused at escalate (r33-5 re-pinned)', () => {
    const { state, clock } = ladderPending(true);
    const opened = reduceCourtConfirmationMachine(state, {
      type: 'open_ladder_round',
      round: 2,
      voteDeadline: clock.now() + 100,
      now: clock.now(),
    });
    let resolved = opened;
    for (const idx of ROSTER) {
      resolved = reduceCourtConfirmationMachine(resolved, {
        type: 'accept_mass_vote',
        idx,
        outcome: 'NO',
        eventId: padHexId(`2b${idx}`),
        now: clock.now(),
      });
    }
    resolved = reduceCourtConfirmationMachine(resolved, {
      type: 'close_ladder_round',
      now: clock.now() + 100,
    });
    resolved = reduceCourtConfirmationMachine(resolved, { type: 'resolve_round', now: clock.now() + 200 });
    expect(resolved.phase).toBe('round_resolved');
    const tampered = withLog(resolved, []);
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(
        tampered,
        challengerEscalationEvent(tampered, clock.now() + 300, {
          challengerPubkey: PUBKEY,
          requestHash: REQUEST,
          challengerIdx: 2,
          roundBondProofHash: roundBond(3),
        }),
      ),
    );
    expect(message).toMatch(/escalation log is incomplete/);
  });

  it('a legacy log emptied at ladder_pending keeps the documented residual (r33-5)', () => {
    const { state, clock } = ladderPending(false);
    const tampered = withLog(state, []);
    // `(registered r33-5)` — a legacy case (requireRoundBond false) is
    // indistinguishable from a pre-0.12 snapshot, so the barrier accepts it.
    const opened = reduceCourtConfirmationMachine(tampered, {
      type: 'open_ladder_round',
      round: 2,
      voteDeadline: clock.now() + 100,
      now: clock.now(),
    });
    expect(opened.phase).toBe('ladder_vote_open');
    expect(opened.escalationLog).toHaveLength(0);
  });

  it('the no-challenge path finalizes under EVERY policy (empty log, ladderRound 0)', () => {
    for (const maxRounds of [1, 2, 3, 4, 5]) {
      for (const strict of [false, true]) {
        for (const host of [false, true]) {
          const clock = makeClock();
          let s = confirmAndOpenChallenge(strict, host, maxRounds, clock);
          s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: clock.jumpTo(20) });
          expect(s.phase).toBe('fee_settlement');
          expect(s.escalationLog).toHaveLength(0);
          expect(s.ladderRound).toBe(0);
          expect(() => assertValidEscalationLog(s)).not.toThrow();
          const final = reduceCourtConfirmationMachine(s, { type: 'finalize', now: clock.now() });
          expect(final.phase).toBe('final');
          expect(final.verdict?.upheld).toBe(true);
          expect(final.verdict?.supportingEventIds).toHaveLength(ROSTER.length);
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2b — THE LEGAL-STATE HUNT (the r37-1 class, enumerated)
// ─────────────────────────────────────────────────────────────────────────────
describe('T2b — legal-state hunt: every reducer-reachable state passes both barriers', () => {
  /**
   * Walk every legal flow and hammer both restore barriers on every state the
   * reducer produces. The r37-1 class is "the barrier refuses a state the
   * reducer can reach"; this is the enumeration that makes the answer a count
   * instead of an opinion.
   *
   * Axes: maxLadderRounds 1..5 × requireRoundBond × hostEscalation ×
   * challenged/never-challenged × authority (challenger|host) × round-bond shape
   * (absent|fresh) × terminal move (escalate|concede→finalize).
   */
  it('0 of the enumerated legal states are refused, and every phase is visited', () => {
    const refusals: string[] = [];
    const liveRefusals: string[] = [];
    const visited = new Set<string>();
    let checks = 0;

    const check = (label: string, s: CourtConfirmationMachineState): void => {
      visited.add(s.phase);
      checks += 1;
      const logErr = barrierRefuses(() => assertValidEscalationLog(s));
      const ledgerErr = barrierRefuses(() => assertValidConfirmationLedger(s));
      if (logErr || ledgerErr) refusals.push(`${label} @${s.phase}: ${logErr || ledgerErr}`);
    };

    for (const maxRounds of [1, 2, 3, 4, 5]) {
      for (const strict of [false, true]) {
        for (const host of [false, true]) {
          const label = `max${maxRounds}-strict${strict}-host${host}`;

          // never-challenged flow
          {
            const clock = makeClock();
            let s = confirmAndOpenChallenge(strict, host, maxRounds, clock);
            check(`${label} challenge_window`, s);
            s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: clock.jumpTo(20) });
            check(`${label} fee_settlement(no-challenge)`, s);
            const final = reduceCourtConfirmationMachine(s, { type: 'finalize', now: clock.now() });
            check(`${label} final(no-challenge)`, final);
          }

          // challenged flow
          {
            const clock = makeClock();
            let s = confirmAndOpenChallenge(strict, host, maxRounds, clock);
            s = reduceCourtConfirmationMachine(s, {
              type: 'accept_challenge',
              idx: 2,
              bondTxid: BOND_TXID_2,
              bondProofHash: MEMBERSHIP_2,
              eventId: padHexId('e2'),
              now: clock.jumpTo(12),
            });
            check(`${label} challenge_window(challenged)`, s);
            s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: clock.jumpTo(20) });
            check(`${label} ladder_pending(first)`, s);

            for (let round = 1; round <= maxRounds; round += 1) {
              const deadline = clock.now() + 100;
              s = reduceCourtConfirmationMachine(s, {
                type: 'open_ladder_round',
                round,
                voteDeadline: deadline,
                now: clock.now(),
              });
              check(`${label} ladder_vote_open(r${round})`, s);
              for (const idx of ROSTER) {
                s = reduceCourtConfirmationMachine(s, {
                  type: 'accept_mass_vote',
                  idx,
                  outcome: round % 2 === 0 ? 'YES' : 'NO',
                  eventId: padHexId(`${round}b${idx}`),
                  now: clock.now(),
                });
              }
              s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: clock.jumpTo(deadline) });
              check(`${label} ladder_vote_closed(r${round})`, s);
              s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: clock.now() });
              check(`${label} post-resolve(r${round})`, s);

              if (s.phase === 'fee_settlement') {
                const final = reduceCourtConfirmationMachine(s, { type: 'finalize', now: clock.now() });
                check(`${label} final(r${round})`, final);
                break;
              }

              // Every authority × round-bond shape from this exact state.
              let advanced: CourtConfirmationMachineState | null = null;
              for (const authority of ['challenger', 'host'] as const) {
                for (const rb of [roundBond(round), null] as const) {
                  let event;
                  try {
                    event = authority === 'challenger'
                      ? challengerEscalationEvent(s, clock.now(), {
                        challengerPubkey: PUBKEY,
                        requestHash: REQUEST,
                        challengerIdx: 2,
                        ...(rb === null ? {} : { roundBondProofHash: rb }),
                      })
                      : hostEscalationEvent(s, clock.now());
                  } catch {
                    continue;
                  }
                  try {
                    const next = reduceCourtConfirmationMachine(s, event);
                    check(`${label} escalate(r${round},${authority},rb=${rb === null ? 'null' : 'fresh'})`, next);
                    if (!advanced) advanced = next;
                  } catch (e) {
                    liveRefusals.push(
                      `${label} escalate(r${round},${authority},rb=${rb === null ? 'null' : 'fresh'}): ${(e as Error).message}`,
                    );
                  }
                }
              }
              // The concede route, and the finalize it leads to.
              const conceded = reduceCourtConfirmationMachine(s, { type: 'concede', now: clock.now() });
              check(`${label} fee_settlement(concede r${round})`, conceded);
              const final = reduceCourtConfirmationMachine(conceded, { type: 'finalize', now: clock.now() });
              check(`${label} final(concede r${round})`, final);

              if (!advanced) break;
              s = advanced;
            }
          }
        }
      }
    }

    expect(refusals).toEqual([]);
    // 490 states on this tree; a shrunk walk must fail rather than silently
    // cover less than it claims (the count is quoted in docs/REVIEW_ROUND_6.md).
    expect(checks).toBeGreaterThanOrEqual(480);
    // Every rung-spending transition that was refused must be a DOCUMENTED
    // policy refusal — never a barrier refusing a legal state.
    for (const message of liveRefusals) {
      expect(message).toMatch(
        /(host escalation is not permitted|requires a per-round bond witness|must not carry a challenger request witness)/,
      );
    }
    // Sanity: the walk really did cover the whole phase graph.
    expect([...visited].sort()).toEqual([
      'challenge_window',
      'fee_settlement',
      'final',
      'ladder_pending',
      'ladder_vote_closed',
      'ladder_vote_open',
      'round_resolved',
    ]);
  });

  it('the completeness offset matches the lifecycle at every phase (one record per opened round)', () => {
    // Derived from the walk above, restated as a table so a change to the
    // definition (`ladderRound − 1`, or `ladderRound` while `ladder_pending`)
    // fails here instead of in production.
    const { state: pending } = ladderPending(true);
    expect(pending.phase).toBe('ladder_pending');
    expect(pending.ladderRound).toBe(1);
    expect(pending.escalationLog).toHaveLength(1); // ladderRound, not ladderRound − 1

    const { state: resolved, clock } = ladderPending(true);
    const opened = reduceCourtConfirmationMachine(resolved, {
      type: 'open_ladder_round',
      round: 2,
      voteDeadline: clock.now() + 100,
      now: clock.now(),
    });
    expect(opened.ladderRound).toBe(2);
    expect(opened.escalationLog).toHaveLength(1); // ladderRound − 1

    // ±1 record on an otherwise legal snapshot is refused in BOTH directions.
    const plusOne = restore(opened);
    (plusOne.escalationLog as unknown as unknown[]).push({
      round: 3,
      authority: 'challenger',
      challengerIdx: 2,
      challengerPubkey: PUBKEY,
      requestHash: REQUEST,
      bondProofHash: MEMBERSHIP_2,
      roundBondProofHash: roundBond(3),
      at: clock.now(),
    });
    expect(barrierRefuses(() => assertValidEscalationLog(plusOne))).toMatch(/incomplete|consecutive/);

    const minusOne = withLog(opened, []);
    expect(barrierRefuses(() => assertValidEscalationLog(minusOne))).toMatch(/incomplete/);
  });

  it('the pending rung is inside the log bound (r37-1) and the bound is redundant with completeness', () => {
    const { state } = ladderPending(true); // ladderRound 1, one record for round 2
    // Before r37-1 the bound compared the record's round with `ladderRound`
    // only, so this LEGAL state was refused. It is a record for the PENDING rung.
    expect(() => assertValidEscalationLog(state)).not.toThrow();

    // A record one round further than the case ever opened is refused — the
    // consecutive rule fires first, which is why the bound check can only ever
    // be a belt: a consecutive `2..k` log has length k−1, and completeness
    // already pins the length to the opened count.
    const tooFar = restore(state);
    (tooFar.escalationLog as unknown as unknown[])[0] = {
      ...(tooFar.escalationLog[0] as object),
      round: 3,
    } as never;
    expect(barrierRefuses(() => assertValidEscalationLog(tooFar))).toMatch(/consecutive 2\.\.k/);

    // Lengthening the log to make it consecutive ALSO makes it incomplete.
    const lengthened = restore(state);
    (lengthened.escalationLog as unknown as unknown[]).push({
      ...(lengthened.escalationLog[0] as object),
      round: 3,
    } as never);
    expect(barrierRefuses(() => assertValidEscalationLog(lengthened)))
      .toMatch(/incomplete|never opened/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the derived cap and its consumers
// ─────────────────────────────────────────────────────────────────────────────
describe('T3 — deriveMaxLadderRounds / deriveLadderFlipRound consumers', () => {
  it('the package has NO a_f default: every derivation demands an explicit accuracy', () => {
    for (const fn of [deriveMaxLadderRounds, deriveLadderFlipRound, ladderSignBoundary]) {
      expect(() => fn(undefined as never)).toThrow(/a_f must be a finite accuracy/);
      expect(() => fn({ rho: 0.03, beta: 0.03 } as never)).toThrow(/a_f must be a finite accuracy/);
    }
    // A host that assumes 0.85 is declaring it (bao.markets R39); the package
    // never invents one, so the two cannot silently disagree.
    expect(deriveMaxLadderRounds({ a_f: 0.85, rho: 0.03, beta: 0.03 })).toBe(4);
    expect(deriveLadderFlipRound({ a_f: 0.85, rho: 0.03, beta: 0.03 })).toBe(5);
  });

  it('for the host\'s rho = beta, an EXACT-integer boundary is unreachable (probe)', () => {
    // The host gate composes `cap <= derivedCap` while this package's verdict is
    // sign-based (`cap < flipRound`). The two agree iff `flipRound = derivedCap+1`
    // — i.e. unless the boundary is an exact integer. Scan 2 000 ULPs either
    // side of every `0.5^(1/k)` (k = 2..7) at rho = beta: none is integral.
    const nextUp = (x: number): number => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, x);
      view.setBigUint64(0, view.getBigUint64(0) + 1n);
      return view.getFloat64(0);
    };
    const nextDown = (x: number): number => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, x);
      view.setBigUint64(0, view.getBigUint64(0) - 1n);
      return view.getFloat64(0);
    };
    let exact = 0;
    for (let k = 2; k <= 7; k += 1) {
      const seed = 0.5 ** (1 / k);
      let up = seed;
      let down = seed;
      for (let i = 0; i < 2000; i += 1) {
        for (const candidate of [up, down]) {
          const boundary = ladderSignBoundary({ a_f: candidate, rho: 0.03, beta: 0.03 });
          if (Number.isInteger(boundary) && boundary >= 2) exact += 1;
        }
        up = nextUp(up);
        down = nextDown(down);
      }
    }
    expect(exact).toBe(0);
  });

  it('(registered r40-4) a consumer that composes the integers diverges once beta != rho', () => {
    // beta = 3*rho makes the sign boundary exactly 2 (ln 0.25 / ln 0.5), which
    // is the case the host gate's own docstring says "the two coincide".
    const params = { a_f: 0.5, rho: 0.03, beta: 0.09 };
    expect(ladderSignBoundary(params)).toBe(2);
    expect(deriveMaxLadderRounds(params)).toBe(2);
    expect(deriveLadderFlipRound(params)).toBe(2);
    const verdict = ladderCapWithinBound({ ...params, maxLadderRounds: 2 });
    // The package is right: cap 2 is EXACTLY break-even, so it is not inside a
    // strictly-negative bound.
    expect(verdict.ok).toBe(false);
    expect(escalationOptionEv({ ...params, rounds: 2 })).toBe(0);
    // A host composing the two integers would bless it.
    expect(verdict.derivedCap >= 1 && 2 <= verdict.derivedCap).toBe(true);
    // Disposition: the host must call `ladderCapWithinBound` (one import) the
    // moment beta stops being rho; today beta = rho = 0.03 makes it unreachable.
  });

  it('derivedCap = 0 refuses every legal depth, and no blessed depth is profitable', () => {
    for (const a_f of [0.3, 0.4, 0.45, 0.5]) {
      const params = { a_f, rho: 0.03, beta: 0.03 };
      expect(deriveMaxLadderRounds(params)).toBe(0);
      for (let cap = 1; cap <= MAX_LADDER_ROUNDS; cap += 1) {
        const verdict = ladderCapWithinBound({ ...params, maxLadderRounds: cap });
        expect(verdict.ok).toBe(false);
        if (verdict.ok) expect(escalationOptionEv({ ...params, rounds: cap })).toBeLessThan(0);
      }
    }
    // The contract that matters, at the only accuracy that has margin.
    const params = { a_f: 0.85, rho: 0.03, beta: 0.03 };
    for (let cap = 1; cap <= MAX_LADDER_ROUNDS; cap += 1) {
      const verdict = ladderCapWithinBound({ ...params, maxLadderRounds: cap });
      if (verdict.ok) expect(escalationOptionEv({ ...params, rounds: cap })).toBeLessThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the round-5 docs, turned into pins
// ─────────────────────────────────────────────────────────────────────────────
describe('T4 — the documented claims', () => {
  it('PER_ROUND_BOND\'s "escalate AND open_ladder_round re-run the barrier" is true', () => {
    // The doc now says the log barrier runs at finalize, escalate AND
    // open_ladder_round. Pin the third one, which r40-2 added: a restored
    // `ladder_pending` snapshot whose record relabels the membership bond as the
    // per-round bond (the r33-1 rule) used to open the round.
    const { state, clock } = ladderPending(true);
    const tampered = restore(state);
    (tampered.escalationLog as unknown as unknown[])[0] = {
      ...(tampered.escalationLog[0] as object),
      roundBondProofHash: MEMBERSHIP_2,
    } as never;
    expect(barrierRefuses(() =>
      reduceCourtConfirmationMachine(tampered, {
        type: 'open_ladder_round',
        round: 2,
        voteDeadline: clock.now() + 100,
        now: clock.now(),
      }),
    )).toMatch(/round bond must be distinct from the membership|accepted challenge \(membership\) bond/);
  });

  it('REVIEW_ROUND_5\'s r38-1 claim holds on a restore at every downstream entry', () => {
    const { state } = resolvedRoundOne();
    const tampered = withBorrowedBond(state);
    // The three entries round 5 named (resolve_round, finalize) plus the two
    // this round added (escalate, open_ladder_round) all re-derive it.
    expect(barrierRefuses(() => assertValidConfirmationLedger(tampered))).toMatch(/r|binds/);
  });
});
