// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Machine-level escalation authority witness (SPEC §9.2, INV-ESC-1…8).
 *
 * Review round 2's sharpest finding: `onEscalate` used to IGNORE its event, so
 * a host that bypassed its own API kept the appeal power — the machine moved
 * to `ladder_pending` on `event.type` alone. These tests pin the opposite
 * property at the reducer boundary, not the API boundary:
 *
 *   - an unwitnessed `escalate` is a TYPED error, in every phase;
 *   - the witness must open the NEXT round, name a case-roster challenger,
 *     carry well-formed hashes, and bind a bond the machine already accepted;
 *   - a host-authority escalation needs the frozen `hostEscalation` policy and
 *     must not fabricate a challenger request;
 *   - the validated witness is recorded append-only in `escalationLog`;
 *   - `ladder_pending` is unreachable except through a witnessed escalation,
 *     so there is no bypass left at the machine level.
 */

import { describe, expect, it } from 'vitest';

import {
  CourtConfirmationTransitionError,
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  hostEscalationEvent,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { assertConfirmationStateFrozen } from './helpers/asserts';
import { hexId, padHexId } from './helpers/ids';
import { escalateEvent, unwitnessedEscalate } from './helpers/machines';

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const OUTCOMES = ['YES', 'NO'] as const;
const ROSTER = [1, 2, 3] as const;
const BOND_TXID = hexId('d');
const BOND_PROOF = hexId('e');
const CHALLENGER_PUBKEY = hexId('7');
const REQUEST_HASH = hexId('8');

interface CaseOpts {
  readonly maxLadderRounds?: number;
  readonly hostEscalation?: boolean;
}

/**
 * Drive a case to `round_resolved` with round 1 resolved: confirm three
 * jurors on YES, accept a bond-witnessed challenge from juror 2, run round 1
 * (NO wins), resolve. Round 1 of a `maxLadderRounds >= 2` case parks in
 * `round_resolved` awaiting the escalation decision.
 */
function resolvedCase(opts: CaseOpts = {}): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: [...OUTCOMES],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: opts.maxLadderRounds ?? 2,
    ...(opts.hostEscalation === undefined ? {} : { hostEscalation: opts.hostEscalation }),
  });
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: padHexId(`c${idx}`),
      now: 100 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 1000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 1100 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: BOND_TXID,
    bondProofHash: BOND_PROOF,
    eventId: padHexId('c2'),
    now: 1500,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 3000, now: 2100 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: padHexId('a1'), now: 2200,
  });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_mass_vote', idx: 2, outcome: 'NO', eventId: padHexId('a2'), now: 2201,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 3000 });
  s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 3100 });
  expect(s.phase).toBe('round_resolved');
  return s;
}

const validWitness = (state: CourtConfirmationMachineState, now = 3200) =>
  challengerEscalationEvent(state, now, {
    challengerPubkey: CHALLENGER_PUBKEY,
    requestHash: REQUEST_HASH,
  });

describe('escalation authority witness: the machine refuses what the host used to decide', () => {
  it('an unwitnessed escalate is a typed error (the bypass the round-2 review found)', () => {
    const resolved = resolvedCase();
    let thrown: unknown;
    try {
      reduceCourtConfirmationMachine(resolved, unwitnessedEscalate(3200));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CourtConfirmationTransitionError);
    expect((thrown as Error).message).toMatch(/requires an authority witness/);
    // The state did not move: no escalation happened.
    expect(resolved.phase).toBe('round_resolved');
    expect(resolved.escalationLog).toEqual([]);
  });

  it('the machine — not the caller — checks the round: only ladderRound + 1 opens', () => {
    const resolved = resolvedCase();
    const stale = escalateEvent(resolved, 3200, { roundIndex: 1 }); // current, not next
    expect(() => reduceCourtConfirmationMachine(resolved, stale)).toThrow(
      /does not open the next ladder round 2/,
    );
    const skip = escalateEvent(resolved, 3200, { roundIndex: 3 }); // skips a round
    expect(() => reduceCourtConfirmationMachine(resolved, skip)).toThrow(
      /does not open the next ladder round 2/,
    );
    const fractional = escalateEvent(resolved, 3200, { roundIndex: 2.5 });
    expect(() => reduceCourtConfirmationMachine(resolved, fractional)).toThrow(/next ladder round 2/);
  });

  it('a challenger outside the case roster cannot escalate', () => {
    const resolved = resolvedCase();
    const outsider = escalateEvent(resolved, 3200, { challengerIdx: 9 });
    expect(() => reduceCourtConfirmationMachine(resolved, outsider)).toThrow(
      /outside the certified roster/,
    );
  });

  it('the bond witness must match a bond the machine already accepted', () => {
    const resolved = resolvedCase();
    // Well-formed, but for a bond this case never saw.
    const foreign = escalateEvent(resolved, 3200, { bondProofHash: hexId('9') });
    expect(() => reduceCourtConfirmationMachine(resolved, foreign)).toThrow(
      /does not match an accepted challenge bond/,
    );
    // …and it must be THIS challenger's bond (R29 r29-1,
    // `reviewRound3.test.ts` › a juror with NO bond cannot escalate).
  });

  it('request hash and pubkey must be well-formed 32-byte lowercase hex', () => {
    const resolved = resolvedCase();
    expect(() => reduceCourtConfirmationMachine(resolved, escalateEvent(resolved, 3200, {
      requestHash: 'nothex',
    }))).toThrow(/request hash must be 32-byte lowercase hex/);
    expect(() => reduceCourtConfirmationMachine(resolved, escalateEvent(resolved, 3200, {
      challengerPubkey: 'AA'.repeat(32),
    }))).toThrow(/challenger pubkey must be 32-byte lowercase hex/);
    expect(() => reduceCourtConfirmationMachine(resolved, escalateEvent(resolved, 3200, {
      requestHash: null,
    }))).toThrow(/request hash must be 32-byte lowercase hex/);
    // …and a challenger witness cannot omit the roster index.
    expect(() => reduceCourtConfirmationMachine(resolved, escalateEvent(resolved, 3200, {
      challengerIdx: null,
    }))).toThrow(/safe-integer challengerIdx/);
  });

  it('a valid challenger witness is recorded append-only and opens the next round', () => {
    const resolved = resolvedCase();
    const next = reduceCourtConfirmationMachine(resolved, validWitness(resolved));
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog).toHaveLength(1);
    expect(next.escalationLog[0]).toEqual({
      round: 2,
      authority: 'challenger',
      challengerIdx: 2,
      challengerPubkey: CHALLENGER_PUBKEY,
      requestHash: REQUEST_HASH,
      bondProofHash: BOND_PROOF,
      at: 3200,
    });
    // The record is a witness an observer can re-verify, and it is frozen.
    assertConfirmationStateFrozen(next);
    expect(Object.isFrozen(next.escalationLog[0])).toBe(true);
    expect(() => {
      (next.escalationLog as unknown as unknown[]).push({});
    }).toThrow();
    // The previous state is untouched (no shared mutation).
    expect(resolved.escalationLog).toEqual([]);
    expect(resolved.phase).toBe('round_resolved');
  });

  it('host authority is break-glass: refused by default, legal only under the frozen policy', () => {
    const strict = resolvedCase();
    expect(() => reduceCourtConfirmationMachine(strict, hostEscalationEvent(strict, 3200))).toThrow(
      /host escalation is not permitted/,
    );

    const breakGlass = resolvedCase({ hostEscalation: true });
    const escalated = reduceCourtConfirmationMachine(breakGlass, hostEscalationEvent(breakGlass, 3200));
    expect(escalated.phase).toBe('ladder_pending');
    expect(escalated.escalationLog[0]).toMatchObject({
      round: 2,
      authority: 'host',
      challengerIdx: null,
      challengerPubkey: null,
      requestHash: null,
      bondProofHash: null,
    });

    // A host escalation must not wear a challenger's request.
    expect(() => reduceCourtConfirmationMachine(breakGlass, escalateEvent(breakGlass, 3200, {
      authority: 'host',
    }))).toThrow(/must not carry a challenger request witness/);
  });

  it('the witness is single-use: replaying it from ladder_pending is refused', () => {
    const resolved = resolvedCase();
    const event = validWitness(resolved);
    const escalated = reduceCourtConfirmationMachine(resolved, event);
    expect(escalated.phase).toBe('ladder_pending');
    expect(() => reduceCourtConfirmationMachine(escalated, event)).toThrow(/during ladder_pending/);
    expect(escalated.escalationLog).toHaveLength(1);
  });

  it('ladder_pending is reachable ONLY through a witnessed escalation', () => {
    const resolved = resolvedCase();
    // Every other event type leaves round_resolved where it is (or throws).
    const probes: CourtConfirmationMachineEvent[] = [
      { type: 'close_confirmations', now: 3200 },
      { type: 'open_challenge_window', now: 3200 },
      { type: 'accept_challenge', idx: 1, bondTxid: BOND_TXID, bondProofHash: BOND_PROOF, eventId: hexId('f'), now: 3200 },
      { type: 'close_challenge_window', now: 3200 },
      { type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: hexId('a'), now: 3200 },
      { type: 'close_ladder_round', now: 3200 },
      { type: 'resolve_round', now: 3200 },
      { type: 'open_ladder_round', round: 2, voteDeadline: 4000, now: 3200 },
      { type: 'record_fee', feeEventId: hexId('b'), now: 3200 },
      { type: 'flag_clawback', idx: 1, reason: 'manual', now: 3200 },
      { type: 'finalize', now: 3200 },
    ];
    for (const probe of probes) {
      let next: CourtConfirmationMachineState | undefined;
      try {
        next = reduceCourtConfirmationMachine(resolved, probe);
      } catch (err) {
        expect(err, `probe ${probe.type} must be a typed error`).toBeInstanceOf(
          CourtConfirmationTransitionError,
        );
      }
      expect(next?.phase === 'ladder_pending', `probe ${probe.type} must not open the ladder`).toBe(false);
    }
    // The witnessed escalate is the one transition that does.
    expect(reduceCourtConfirmationMachine(resolved, validWitness(resolved)).phase).toBe('ladder_pending');
  });

  it('the log grows one entry per escalation, in consecutive rounds', () => {
    let s = resolvedCase({ maxLadderRounds: 3 });
    s = reduceCourtConfirmationMachine(s, validWitness(s, 3200));
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 2, voteDeadline: 4000, now: 3300 });
    for (const idx of ROSTER) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_mass_vote', idx, outcome: 'YES', eventId: padHexId(`2${idx}`), now: 3400 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 4000 });
    s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 4100 });
    expect(s.phase).toBe('round_resolved');
    s = reduceCourtConfirmationMachine(s, challengerEscalationEvent(s, 4200, {
      challengerPubkey: CHALLENGER_PUBKEY,
      requestHash: REQUEST_HASH,
    }));
    expect(s.escalationLog.map((r) => r.round)).toEqual([2, 3]);
    expect(s.escalationLog.every((r) => r.authority === 'challenger')).toBe(true);
  });

  it('pre-0.12 snapshots without an escalation log normalise to an empty ledger', () => {
    const resolved = resolvedCase();
    const legacy = JSON.parse(JSON.stringify(resolved)) as Record<string, unknown>;
    delete legacy.escalationLog;
    const restored = legacy as unknown as CourtConfirmationMachineState;
    const next = reduceCourtConfirmationMachine(restored, validWitness(restored));
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog).toHaveLength(1);
    // A tampered (non-array) log is still refused.
    const tampered = { ...resolved, escalationLog: 'tampered' } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(tampered, validWitness(resolved))).toThrow(
      /escalationLog must be an array/,
    );
  });

  it('a hand-restored snapshot with a fabricated witness entry cannot re-escalate', () => {
    const resolved = resolvedCase();
    // A forged snapshot that claims the ladder cap is already reached (the
    // caps are part of frozen policy, so only a hand-restore can do this)
    // must refuse a PERFECT witness: no witness overrides the cap.
    const rogue: CourtConfirmationMachineState = { ...resolved, maxLadderRounds: 1 };
    expect(() => reduceCourtConfirmationMachine(rogue, validWitness(rogue))).toThrow(/maxLadderRounds/);
  });
});
