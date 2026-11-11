// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * MUTATION-CLOSURE PINS (round 37 — the v0.13 campaign).
 *
 * Every test here closes something `scripts/mutation/run-mutants.mjs` found on
 * the v0.13 surface. Method, tables and the honest classification of each
 * survivor: `docs/MUTATION_TESTING_V013.md`; campaign-1 pins (C1–C9):
 * `__tests__/mutationClosures.test.ts`.
 *
 * Round 37 produced ONE survivor (M66, the escalation-log round bound), and
 * investigating it found a real defect rather than a missing assertion:
 *
 *   r37-1  `assertValidEscalationLog` refused a LEGAL `ladder_pending`
 *          snapshot. Its completeness rule accounts for the half-step between
 *          `escalate` (appends the record for `ladderRound + 1`) and
 *          `open_ladder_round` (advances `ladderRound`), but its round-binding
 *          rule compared against `ladderRound` alone — so a state produced by
 *          `escalate` (one record, round 2, ladderRound 1) was refused by the
 *          barrier that is supposed to validate it. The reducer never calls the
 *          barrier in that phase, so nothing shipped broke; a HOST restoring a
 *          mid-escalation snapshot (the documented restore path, INV-ESC-8)
 *          was refused by the barrier itself.
 *
 * M66 remains EQUIVALENT after the fix (the consecutive `2..k` rule and the
 * completeness offset already exclude every record the bound could reject) and
 * is kept in the catalogue as defence in depth — the honest verdict, not a
 * coverage win. The pins below are what the mutation bought.
 */

import { describe, expect, it } from 'vitest';

import { assertValidEscalationLog } from '../confirmationMachineCore';
import {
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { hexId, padHexId } from './helpers/ids';

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;

const reduce = reduceCourtConfirmationMachine;
const roundBond = (r: number): string => padHexId(`a${r}`);

/** A challenged case parked at `round_resolved` after round 1 (juror 2 bonded). */
function resolvedRoundOne(): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: 3,
  });
  for (const idx of ROSTER) {
    s = reduce(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: padHexId(`c${idx}`),
      now: 100 + idx,
    });
  }
  s = reduce(s, { type: 'close_confirmations', now: 1000 });
  s = reduce(s, { type: 'open_challenge_window', now: 1100 });
  s = reduce(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: padHexId('d2'),
    bondProofHash: padHexId('e2'),
    eventId: padHexId('f2'),
    now: 1200,
  });
  s = reduce(s, { type: 'close_challenge_window', now: 2000 });
  s = reduce(s, { type: 'open_ladder_round', round: 1, voteDeadline: 3000, now: 2100 });
  for (const idx of ROSTER) {
    s = reduce(s, {
      type: 'accept_mass_vote',
      idx,
      outcome: 'NO',
      eventId: padHexId(`1b${idx}`),
      now: 2110 + idx,
    });
  }
  s = reduce(s, { type: 'close_ladder_round', now: 3000 });
  s = reduce(s, { type: 'resolve_round', now: 3100 });
  expect(s.phase).toBe('round_resolved');
  return s;
}

function escalate(
  state: CourtConfirmationMachineState,
  now: number,
  witness: { readonly roundBondProofHash?: string } = {},
): CourtConfirmationMachineEvent {
  return challengerEscalationEvent(state, now, {
    challengerPubkey: hexId('7'),
    requestHash: hexId('8'),
    ...witness,
  }) as CourtConfirmationMachineEvent;
}

// ─── C10 (M66 / r37-1): the log's round bound includes the pending rung ────

describe('mutation closure C10 (M66 / r37-1) — the escalation-log round bound', () => {
  it('ACCEPTS a legal `ladder_pending` snapshot (a restored mid-escalation case)', () => {
    const resolved = resolvedRoundOne();
    const pending = reduce(resolved, escalate(resolved, 3200, { roundBondProofHash: roundBond(2) }));
    // The state `escalate` produces: the record names the round it is opening,
    // which is one PAST `ladderRound` until `open_ladder_round` advances it.
    expect(pending.phase).toBe('ladder_pending');
    expect(pending.ladderRound).toBe(1);
    expect(pending.escalationLog.map((record) => record.round)).toEqual([2]);
    expect(() => assertValidEscalationLog(pending)).not.toThrow();
  });

  it('still REFUSES a record naming a round the case never opened', () => {
    const resolved = resolvedRoundOne();
    const pending = reduce(resolved, escalate(resolved, 3200, { roundBondProofHash: roundBond(2) }));
    const forged = {
      ...pending,
      escalationLog: pending.escalationLog.map((record) => ({ ...record, round: 4 })),
    } as unknown as CourtConfirmationMachineState;
    expect(() => assertValidEscalationLog(forged)).toThrow();
  });

  it('refuses a log longer than the rounds the case opened', () => {
    const resolved = resolvedRoundOne();
    const pending = reduce(resolved, escalate(resolved, 3200, { roundBondProofHash: roundBond(2) }));
    const doubled = {
      ...pending,
      escalationLog: [...pending.escalationLog, ...pending.escalationLog],
    } as unknown as CourtConfirmationMachineState;
    expect(() => assertValidEscalationLog(doubled)).toThrow(/consecutive 2\.\.k|incomplete/);
  });
});
