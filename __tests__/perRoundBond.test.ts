// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * R31 — the escalation bond must be a CONSUMPTION test, not a membership test
 * (`docs/proofs/economics/06-expert-verify.tex.md` §1, finding r30-1).
 *
 * Before this round the reducer accepted any bond that appeared in the
 * challenger's accepted challenges, and the escalation event carried no amount:
 * one payment bought the whole ladder (`ΔC_{r+1} = 0` for every r), which turns
 * escalation into a free option worth `Σ 3^r b₀` and erodes the challenger's
 * expected burn from −2.40 % to −1.86 % of V at the shipped cap (−0.543 % at the
 * protocol cap).
 *
 * v0.13 binds a bond to a ROUND: the witness carries `roundBondProofHash`, the
 * machine requires it under `requireRoundBond`, and the append-only
 * `escalationLog` is the consumption ledger (one fresh hash per round, never the
 * membership bond, never reused). These probes attack that ledger from every
 * direction the compat matrix allows:
 *
 *   - legacy (`requireRoundBond: false`): the old behaviour is preserved — one
 *     bond may still fund every round, and an OPTIONAL round bond is honoured;
 *   - strict (`requireRoundBond: true`): a witness without a fresh per-round
 *     bond is refused, a relabelled membership bond is refused, and a consumed
 *     hash is refused on the next round;
 *   - restored snapshots: `finalize` re-derives the same property, so a
 *     hand-edited log cannot re-open the option;
 *   - break-glass (`hostEscalation: true`): the host may already escalate free,
 *     so the strict rule does not price anything there and stays compatible.
 */

import { describe, expect, it } from 'vitest';

import {
  CourtConfirmationTransitionError,
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
const BOND_TXID = hexId('d');
const BOND_PROOF = hexId('e'); // the MEMBERSHIP bond (challenge bond, posted once)
const PUBKEY = hexId('7');
const REQUEST = hexId('8');
/** A fresh per-round bond witness for round r (distinct from every other). */
const roundBond = (r: number): string => padHexId(`a${r}`);

interface CaseOpts {
  readonly maxLadderRounds?: number;
  readonly hostEscalation?: boolean;
  readonly requireRoundBond?: boolean;
}

/** A challenged case parked at `round_resolved` after round 1 (juror 2 bonded). */
function resolvedRoundOne(opts: CaseOpts = {}): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: opts.maxLadderRounds ?? 3,
    ...(opts.hostEscalation === undefined ? {} : { hostEscalation: opts.hostEscalation }),
    ...(opts.requireRoundBond === undefined ? {} : { requireRoundBond: opts.requireRoundBond }),
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
  s = openRound(s, 1, 3000, 2100, 'NO');
  s = closeAndResolve(s, 3000, 3100);
  expect(s.phase).toBe('round_resolved');
  return s;
}

function openRound(
  s: CourtConfirmationMachineState,
  round: number,
  voteDeadline: number,
  now: number,
  outcome: string,
): CourtConfirmationMachineState {
  let next = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round, voteDeadline, now });
  for (const idx of ROSTER) {
    next = reduceCourtConfirmationMachine(next, {
      type: 'accept_mass_vote',
      idx,
      outcome,
      eventId: padHexId(`${round}b${idx}`),
      now: now + 10 + idx,
    });
  }
  return next;
}

function closeAndResolve(
  s: CourtConfirmationMachineState,
  closeAt: number,
  resolveAt: number,
): CourtConfirmationMachineState {
  const closed = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: closeAt });
  return reduceCourtConfirmationMachine(closed, { type: 'resolve_round', now: resolveAt });
}

function escalate(
  s: CourtConfirmationMachineState,
  now: number,
  overrides: Record<string, unknown> = {},
  roundBondProofHash?: string,
): CourtConfirmationMachineEvent {
  return {
    ...challengerEscalationEvent(s, now, {
      challengerPubkey: PUBKEY,
      requestHash: REQUEST,
      ...(roundBondProofHash === undefined ? {} : { roundBondProofHash }),
    }),
    ...overrides,
  } as CourtConfirmationMachineEvent;
}

/** Drive an escalated case to the next `round_resolved` (round `round`). */
function advance(
  s: CourtConfirmationMachineState,
  round: number,
  at: number,
): CourtConfirmationMachineState {
  let next = reduceCourtConfirmationMachine(s, escalate(s, at, {}, roundBond(round - 1)));
  next = openRound(next, round, at + 1000, at + 100, 'YES');
  return closeAndResolve(next, at + 1000, at + 1100);
}

describe('R31 / legacy default — the v0.12 membership semantics are preserved', () => {
  it('a case built without requireRoundBond records FALSE and accepts a witness without a round bond', () => {
    const resolved = resolvedRoundOne();
    expect(resolved.requireRoundBond).toBe(false);
    const next = reduceCourtConfirmationMachine(resolved, escalate(resolved, 3200));
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog[0]).toMatchObject({ round: 2, roundBondProofHash: null });
  });

  it('an OPTIONAL round bond is validated and consumed even on a legacy case', () => {
    // A host can tighten a legacy case one deployment at a time: supplying the
    // hash is enough to get the consumption checks, without the strict policy.
    let s = resolvedRoundOne({ maxLadderRounds: 3 });
    s = advance(s, 2, 3200);
    expect(s.escalationLog[0].roundBondProofHash).toBe(roundBond(1));

    // The SAME round bond cannot be spent on round 3.
    expect(() => reduceCourtConfirmationMachine(s, escalate(s, 4400, {}, roundBond(1))))
      .toThrow(/already consumed by round 2/);
    // A fresh one can.
    const fresh = reduceCourtConfirmationMachine(s, escalate(s, 4400, {}, roundBond(2)));
    expect(fresh.escalationLog.map((r) => r.roundBondProofHash)).toEqual([roundBond(1), roundBond(2)]);
  });

  it('the membership bond can never be RELABELLED as a round bond', () => {
    const resolved = resolvedRoundOne();
    expect(() => reduceCourtConfirmationMachine(resolved, escalate(resolved, 3200, {}, BOND_PROOF)))
      .toThrow(/must be distinct from the membership \(challenge\) bond/);
    expect(resolved.escalationLog).toHaveLength(0);
    expect(resolved.phase).toBe('round_resolved');
  });

  it('a malformed round bond hash is a typed error, not a silently ignored field', () => {
    const resolved = resolvedRoundOne();
    for (const bad of ['nothex', '', 'AA'.repeat(32), `${roundBond(1)}00`]) {
      expect(() => reduceCourtConfirmationMachine(resolved, escalate(resolved, 3200, {}, bad)))
        .toThrow(CourtConfirmationTransitionError);
      expect(resolved.escalationLog).toHaveLength(0);
    }
  });
});

describe('R31 / requireRoundBond — escalation becomes a consumption test', () => {
  it('records the frozen policy on the case', () => {
    expect(resolvedRoundOne({ requireRoundBond: true }).requireRoundBond).toBe(true);
  });

  it('REFUSES a witness with no per-round bond (the r30-1 free option is closed)', () => {
    const strict = resolvedRoundOne({ requireRoundBond: true });
    expect(() => reduceCourtConfirmationMachine(strict, escalate(strict, 3200)))
      .toThrow(/requires a per-round bond witness/);
    expect(strict.phase).toBe('round_resolved');
    expect(strict.escalationLog).toHaveLength(0);
  });

  it('accepts a witness that carries a FRESH per-round bond, and logs it', () => {
    const strict = resolvedRoundOne({ requireRoundBond: true });
    const next = reduceCourtConfirmationMachine(strict, escalate(strict, 3200, {}, roundBond(1)));
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog[0]).toMatchObject({
      round: 2,
      authority: 'challenger',
      challengerIdx: 2,
      bondProofHash: BOND_PROOF, // membership (unchanged)
      roundBondProofHash: roundBond(1), // consumption (new)
    });
  });

  it('one bond cannot fund every round: each rung needs its own witness', () => {
    let s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 4 });
    s = advance(s, 2, 3200);
    // Round 3 with no fresh bond → refused (the option is not free any more).
    expect(() => reduceCourtConfirmationMachine(s, escalate(s, 4400)))
      .toThrow(/requires a per-round bond witness/);
    // Round 3 reusing round 2's bond → refused.
    expect(() => reduceCourtConfirmationMachine(s, escalate(s, 4400, {}, roundBond(1))))
      .toThrow(/already consumed/);
    // Round 3 with its own bond → accepted; the ledger shows two purchases.
    s = advance(s, 3, 4600);
    expect(s.escalationLog.map((r) => r.roundBondProofHash)).toEqual([roundBond(1), roundBond(2)]);
    expect(new Set(s.escalationLog.map((r) => r.roundBondProofHash)).size).toBe(2);
  });

  it('a break-glass case stays compatible: the host already escalates free', () => {
    // `hostEscalation: true` lets the HOST open a round with no bond at all, so
    // demanding a fresh bond from the challenger prices nothing. The strict rule
    // therefore does not apply; the ledger still records whatever was supplied.
    const breakGlass = resolvedRoundOne({ requireRoundBond: true, hostEscalation: true });
    const escalated = reduceCourtConfirmationMachine(breakGlass, escalate(breakGlass, 3200));
    expect(escalated.phase).toBe('ladder_pending');
    expect(escalated.escalationLog[0].roundBondProofHash).toBeNull();
  });
});

describe('R31 / the log is a consumption ledger, also after a restore', () => {
  it('finalize refuses a restored record that reuses a per-round bond', () => {
    let s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 4 });
    s = advance(s, 2, 3200);
    s = advance(s, 3, 5000);
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 6200 });
    expect(s.phase).toBe('fee_settlement');
    const cloned = JSON.parse(JSON.stringify(s)) as CourtConfirmationMachineState;

    // Reuse: round 3 "paid" with round 2's bond — the exact free-option shape.
    const reused = {
      ...cloned,
      escalationLog: cloned.escalationLog.map((record, i) => (
        i === 1 ? { ...record, roundBondProofHash: cloned.escalationLog[0].roundBondProofHash } : record
      )),
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(reused, { type: 'finalize', now: 6300 }))
      .toThrow(/reuses a per-round bond witness/);

    // Relabel: round 2 "paid" with the membership bond.
    const relabelled = {
      ...cloned,
      escalationLog: cloned.escalationLog.map((record, i) => (
        i === 0 ? { ...record, roundBondProofHash: BOND_PROOF } : record
      )),
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(relabelled, { type: 'finalize', now: 6300 }))
      .toThrow(/distinct from the membership/);

    // Absent on a strict case: the legacy record shape is not silently legal.
    const stripped = {
      ...cloned,
      escalationLog: cloned.escalationLog.map((record) => {
        const { roundBondProofHash: _drop, ...rest } = record as unknown as Record<string, unknown>;
        return rest;
      }),
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(stripped, { type: 'finalize', now: 6300 }))
      .toThrow(/without the per-round bond this case requires/);

    // The untouched snapshot still finalizes (no over-correction).
    const finalized = reduceCourtConfirmationMachine(cloned, { type: 'finalize', now: 6300 });
    expect(finalized.phase).toBe('final');
    expect(finalized.verdict?.verdictHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a pre-0.13 snapshot (absent policy + absent field) still finalizes', () => {
    // Legacy records predate the field: an ABSENT `roundBondProofHash` reads as
    // null, and an ABSENT `requireRoundBond` reads as false (fail-closed on the
    // permissive default is the documented compat rule, not on liveness).
    let s = resolvedRoundOne({ maxLadderRounds: 4 });
    s = advance(s, 2, 3200);
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 4400 });
    const legacy = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    delete legacy.requireRoundBond;
    legacy.escalationLog = (legacy.escalationLog as Array<Record<string, unknown>>).map((record) => {
      const { roundBondProofHash: _drop, ...rest } = record;
      return rest;
    });
    const restored = legacy as unknown as CourtConfirmationMachineState;
    const finalized = reduceCourtConfirmationMachine(restored, { type: 'finalize', now: 4500 });
    expect(finalized.phase).toBe('final');
  });

  it('a host escalation must not carry a round bond either (no relabelled witness)', () => {
    const breakGlass = resolvedRoundOne({ hostEscalation: true });
    expect(() => reduceCourtConfirmationMachine(breakGlass, {
      type: 'escalate',
      authority: 'host',
      challengerIdx: null,
      challengerPubkey: null,
      requestHash: null,
      bondProofHash: null,
      roundBondProofHash: roundBond(1),
      roundIndex: 2,
      now: 3200,
    } as CourtConfirmationMachineEvent)).toThrow(/must not carry a challenger request witness/);
    expect(breakGlass.escalationLog).toHaveLength(0);
  });
});
