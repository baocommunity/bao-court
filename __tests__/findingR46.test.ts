// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * ROUND-46 CORPUS FINDING — r46-1: a signed CONCESSION was minted as an
 * ESCALATION.
 *
 * Found by campaign 10 (`__tests__/scale/escalationTransportCorpus.ts`) while
 * extending the transport fuzz over the v0.14.0 wire. `CourtEscalationRequest`
 * carries `concession: boolean`, documented as "True when the challenger DROPS
 * the appeal (concede, never blocked)", and r8-3 made it a STRICT boolean
 * precisely because a coerced flag "flips a signed field". The flag is in the v2
 * hash preimage, so it is genuinely signed.
 *
 * `escalationRequestToMachineEvent` never read it. Any request — including one
 * the challenger signed as a concession — came back as an `escalate` event, the
 * reducer accepted it, the next rung opened, a per-round bond witness was spent
 * in the challenger's name, and the challenger was written into the append-only
 * `escalationLog` as the escalator. That is the r8-2 attribution harm (a
 * non-escalator recorded as having escalated) reproduced one signed flag over,
 * and it turned the one press a concession must never produce into the only
 * thing the transport could produce from it.
 *
 * FIX (minimal, fail-closed): the mapper REFUSES a concession-bearing request.
 * The concession itself is not blocked — the host ends the ladder with the
 * machine's own `concede` event, the documented path while SPEC §9.2
 * ESC-RIGHT-3 (a *witnessed* concede) stays open.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCourtEscalationRequest,
  escalationRequestToMachineEvent,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
  type CourtEscalationRequest,
} from '../courtEscalationRequest';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';

const SESSION = '5e'.repeat(32);
const PROPOSAL = '6f'.repeat(32);
const ROSTER = [1, 2, 3, 4, 5];
const CASE_ID = 'case-r46-1';
const CHALLENGER = 'ab'.repeat(32);
const MEMBERSHIP_BOND = 'cd'.repeat(32);
const BOND_TXID = 'bc'.repeat(32);
const ROUND_BOND = 'ef'.repeat(32);
const BINDING = { caseId: CASE_ID, authenticatedPubkey: CHALLENGER } as const;

/** A 32-byte lowercase-hex id from a small integer (deterministic fixtures). */
function hid(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32);
}

/** A challenged case parked at `round_resolved` after round 1. */
function resolvedRoundOne(): CourtConfirmationMachineState {
  let state = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1_000,
    challengeDeadline: 2_000,
    maxLadderRounds: 3,
  });
  for (const idx of ROSTER) {
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: hid(idx),
      now: 100 + idx,
    });
  }
  state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 1_000 });
  state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: 1_100 });
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    eventId: hid(10),
    now: 1_500,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 2_000 });
  state = reduceCourtConfirmationMachine(state, {
    type: 'open_ladder_round',
    round: 1,
    voteDeadline: 3_000,
    now: 2_100,
  });
  for (const idx of ROSTER) {
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_mass_vote',
      idx,
      outcome: 'NO',
      eventId: hid(20 + idx),
      now: 2_200 + idx,
    });
  }
  state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 3_000 });
  return reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: 3_001 });
}

function request(concession: boolean): CourtEscalationRequest {
  return buildCourtEscalationRequest({
    caseId: CASE_ID,
    round: 1,
    challengerPubkey: CHALLENGER,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: ROUND_BOND,
    eventId: hid(30),
    signedAtSec: 1_790_000_000,
    concession,
  });
}

describe('r46-1: a signed concession must never be minted as an escalation', () => {
  it('refuses a concession-bearing request (and names the concede path)', () => {
    const state = resolvedRoundOne();
    expect(state.phase).toBe('round_resolved');
    const concession = request(true);
    expect(concession.concession).toBe(true);

    expect(() => escalationRequestToMachineEvent(state, concession, 3_100, BINDING))
      .toThrow(CourtConfirmationTransitionError);
    expect(() => escalationRequestToMachineEvent(state, concession, 3_100, BINDING))
      .toThrow(/CONCESSION/);
    // The refusal must point the host at the documented path, not leave it stuck.
    expect(() => escalationRequestToMachineEvent(state, concession, 3_100, BINDING))
      .toThrow(/concede/);
  });

  it('the signed flag survives the wire, so the refusal cannot be evaded by re-encoding', () => {
    const concession = request(true);
    const wire = serializeCourtEscalationRequest(concession);
    const reparsed = parseCourtEscalationRequest(wire);
    expect(reparsed.concession).toBe(true);
    expect(() => escalationRequestToMachineEvent(resolvedRoundOne(), reparsed, 3_100, BINDING))
      .toThrow(/CONCESSION/);
    // And the hash binds it: a concession and an escalation are different requests.
    expect(reparsed.concession).toBe(request(false).concession === false);
  });

  it('still mints the escalation for a NON-concession request (no regression)', () => {
    const state = resolvedRoundOne();
    const event = escalationRequestToMachineEvent(state, request(false), 3_100, BINDING);
    expect(event.type).toBe('escalate');
    expect(event.authority).toBe('challenger');
    expect(event.roundIndex).toBe(2);
    const next = reduceCourtConfirmationMachine(state, event);
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog).toHaveLength(1);
    expect(next.escalationLog[0]!.challengerIdx).toBe(2);
  });

  it('leaves the concession itself available: the host can still concede', () => {
    const state = resolvedRoundOne();
    // Refusing to mint an escalate does not block the drop (ESPECIALLY not:
    // "a concession is never blocked").
    const conceded = reduceCourtConfirmationMachine(state, { type: 'concede', now: 3_100 });
    expect(conceded.phase).toBe('fee_settlement');
    expect(conceded.escalationLog).toHaveLength(0);
  });
});
