// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * REVIEW ROUND 4 — attacking the v0.13 surface.
 *
 * Round 3 attacked the fixes round 2 asked for. This round attacks the newest
 * layer on top of it, as an adversary holding the reducer (or the pure helper):
 * the per-round escalation bond (R31, r30-1), the derived ladder bound, the
 * penalty-aging pair (R31, r30-4) and the host's churn cap (R31a, r30-2).
 *
 * Every test below is either a CLOSURE (it fails before the fix in this PR) or a
 * PIN of a residual that is registered in `docs/REVIEW_ROUND_4.md` — the pins
 * are named `(registered …)` so a future fix turns them red on purpose.
 */

import { describe, expect, it } from 'vitest';

import {
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  cumulativeLadderBondMultiple,
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  escalationOptionEv,
  ladderCapWithinBound,
} from '../ladderEconomics';
import { agePenalties, pairedJurorWeight } from '../penaltyAging';
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
const roundBond = (r: number): string => padHexId(`a${r}`);

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

/**
 * A challenged case parked at `round_resolved` after round 1. Juror 2 always
 * posts the challenge bond; `secondChallenger` adds juror 3 (a second bonded
 * challenger, the only way to test witness front-running).
 */
function resolvedRoundOne(opts: {
  readonly maxLadderRounds?: number;
  readonly requireRoundBond?: boolean;
  readonly secondChallenger?: boolean;
} = {}): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: opts.maxLadderRounds ?? 4,
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
    bondTxid: hexId('d'),
    bondProofHash: MEMBERSHIP_2,
    eventId: padHexId('e2'),
    now: 1300,
  });
  if (opts.secondChallenger === true) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: hexId('f'),
      bondProofHash: MEMBERSHIP_3,
      eventId: padHexId('e3'),
      now: 1400,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  s = openRound(s, 1, 3000, 2100, 'NO');
  return closeAndResolve(s, 3000, 3100);
}

function escalateWith(
  s: CourtConfirmationMachineState,
  now: number,
  roundBondProofHash: string | null,
  challengerIdx?: number,
): CourtConfirmationMachineEvent {
  return challengerEscalationEvent(s, now, {
    challengerPubkey: PUBKEY,
    requestHash: REQUEST,
    ...(challengerIdx === undefined ? {} : { challengerIdx }),
    ...(roundBondProofHash === null ? {} : { roundBondProofHash }),
  }) as CourtConfirmationMachineEvent;
}

/** Deep clone a state, so a test can act as a host restoring a tampered snapshot. */
function restore(state: CourtConfirmationMachineState): CourtConfirmationMachineState {
  return JSON.parse(JSON.stringify(state)) as CourtConfirmationMachineState;
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the per-round bond
// ─────────────────────────────────────────────────────────────────────────────

describe('T1 / the per-round bond is bound to a PAYMENT, not just to a string', () => {
  it('refuses ANOTHER challenger\'s accepted membership bond as this round\'s payment (r33-1)', () => {
    // Jurors 2 and 3 both bonded (two escalation rights in this case). Juror 3
    // escalates quoting juror 2's membership bond as its per-round bond.
    const s = resolvedRoundOne({ requireRoundBond: true, secondChallenger: true });
    expect(() => reduceCourtConfirmationMachine(s, escalateWith(s, 3200, MEMBERSHIP_2, 3)))
      .toThrow(/membership\) bond/);
    // The state is untouched: a refused witness cannot burn the bond.
    expect(s.escalationLog).toHaveLength(0);
    // The same witness with a genuinely fresh bond is accepted (no over-correction).
    const ok = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, roundBond(1), 3));
    expect(ok.phase).toBe('ladder_pending');
    expect(ok.escalationLog[0].roundBondProofHash).toBe(roundBond(1));
  });

  it('refuses a relabelled membership bond at finalize too (restore barrier parity)', () => {
    let s = resolvedRoundOne({ requireRoundBond: true, secondChallenger: true, maxLadderRounds: 4 });
    s = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, roundBond(1), 3));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 4200 });
    const tampered = restore(s);
    const edited = {
      ...tampered,
      escalationLog: tampered.escalationLog.map((record) => ({
        ...record,
        roundBondProofHash: MEMBERSHIP_2,
      })),
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(edited, { type: 'finalize', now: 4300 }))
      .toThrow(/membership\) bond/);
  });

  it('(registered r33-2) the witness is a UNIQUENESS test, not a payment test', () => {
    // The machine can only see a 32-byte string: a never-paid hash satisfies a
    // strict case. This is the host's verification obligation (like the
    // challenge bond), and it is why `requireRoundBond` alone does not price a
    // rung. Pinned so the doc cannot drift back into claiming otherwise.
    const s = resolvedRoundOne({ requireRoundBond: true });
    const unpaid = hexId('9');
    const next = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, unpaid));
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog[0].roundBondProofHash).toBe(unpaid);
  });

  it('(registered r33-3) one round bond can be spent in two DIFFERENT cases', () => {
    // The consumption ledger is the case's `escalationLog`; the machine cannot
    // see another case. Same class as the challenge-bond reuse of r29-4 — the
    // host must dedupe bond hashes globally (unique index on the proof hash).
    const shared = hexId('9');
    const a = resolvedRoundOne({ requireRoundBond: true });
    const b = resolvedRoundOne({ requireRoundBond: true });
    const a2 = reduceCourtConfirmationMachine(a, escalateWith(a, 3200, shared));
    const b2 = reduceCourtConfirmationMachine(b, escalateWith(b, 3200, shared));
    expect(a2.phase).toBe('ladder_pending');
    expect(b2.phase).toBe('ladder_pending');
  });

  it('(registered r33-4) the shipped default is the LEGACY free option', () => {
    // Measured, not inferred: the factory default is `false`, and with it a
    // challenger escalates every round on the ONE membership bond (the r30-1
    // free option). Safe-by-default would be `true`; the compat matrix in
    // docs/PER_ROUND_BOND.md deliberately chose `false`, so a host must opt in
    // and this test is what fails when the owner flips the default.
    const s = resolvedRoundOne({ maxLadderRounds: 4 });
    expect(s.requireRoundBond).toBe(false);
    let next = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, null));
    expect(next.escalationLog[0].roundBondProofHash).toBeNull();
    next = openRound(next, 2, 4000, 3300, 'YES');
    next = closeAndResolve(next, 4000, 4100);
    // Round 3 on the same membership bond: ΔC = 0, the free option.
    const third = reduceCourtConfirmationMachine(next, escalateWith(next, 4200, null));
    expect(third.escalationLog).toHaveLength(2);
    expect(third.escalationLog.every((r) => r.roundBondProofHash === null)).toBe(true);
  });

  it('(registered r33-2b) a second bonded challenger can burn a paid witness by front-running', () => {
    // Juror 2 verifies a fresh bond for round 2 (hash R). Juror 3, also bonded,
    // acts first with R as its own per-round bond. Juror 2's escalate is then
    // refused: "already consumed". Nothing in the state can tell whose bond R
    // is — closing this needs an accepted-round-bond ledger (v0.14), not a
    // string check. Pinned as a limit, not as a defence.
    const s = resolvedRoundOne({ requireRoundBond: true, secondChallenger: true });
    const victimBond = roundBond(1);
    const grief = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, victimBond, 3));
    expect(grief.escalationLog[0].roundBondProofHash).toBe(victimBond);
    // The rightful payer cannot escalate with the bond it posted, and the case
    // has already moved on (only one escalate per resolved round).
    expect(() => reduceCourtConfirmationMachine(grief, escalateWith(grief, 3250, victimBond, 2)))
      .toThrow(/cannot escalate during ladder_pending/);
    // On a fresh copy of the pre-escalation state the victim's own escalate with
    // the same hash succeeds — so the harm is ordering, not authentication.
    const victim = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, victimBond, 2));
    expect(victim.phase).toBe('ladder_pending');
  });
});

describe('T1 / the escalation log is complete, so a dropped record cannot re-open the free option', () => {
  it('a restored snapshot with EVERY record deleted cannot reuse a consumed bond (r33-5)', () => {
    let s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 4 });
    s = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, roundBond(1)));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    expect(s.ladderRound).toBe(2);
    expect(s.escalationLog).toHaveLength(1);

    const stripped = { ...restore(s), escalationLog: [] } as unknown as CourtConfirmationMachineState;
    // The bond round 2 was paid with is now "unconsumed" — but the ledger is
    // incomplete for the rounds this case opened, so the rung never opens.
    expect(() => reduceCourtConfirmationMachine(stripped, escalateWith(stripped, 4200, roundBond(1))))
      .toThrow(/escalation log is incomplete/);
    // A fresh witness on the same tampered snapshot is refused too: the state is
    // not restorable into a ladder, whatever the bond.
    expect(() => reduceCourtConfirmationMachine(stripped, escalateWith(stripped, 4200, roundBond(2))))
      .toThrow(/escalation log is incomplete/);
  });

  it('deleting only the LAST record is refused as well (no partial ledger)', () => {
    let s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 5 });
    s = reduceCourtConfirmationMachine(s, escalateWith(s, 3200, roundBond(1)));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, escalateWith(s, 4200, roundBond(2)));
    s = openRound(s, 3, 5000, 4300, 'NO');
    s = closeAndResolve(s, 5000, 5100);
    expect(s.ladderRound).toBe(3);
    expect(s.escalationLog).toHaveLength(2);

    const dropped = {
      ...restore(s),
      escalationLog: restore(s).escalationLog.slice(0, 1),
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(dropped, escalateWith(dropped, 5200, roundBond(2))))
      .toThrow(/escalation log is incomplete/);
  });

  it('a legacy (0.11/0.12) case with no log still escalates and finalizes', () => {
    // No over-correction: an absent log on a case that never opted into the
    // per-round bond is the documented legacy shape (deletion is
    // indistinguishable from it, and remains a host-attestation obligation).
    let s = resolvedRoundOne({ maxLadderRounds: 4 });
    const legacy = { ...restore(s), escalationLog: undefined } as unknown as CourtConfirmationMachineState;
    s = reduceCourtConfirmationMachine(legacy, escalateWith(legacy, 3200, null));
    expect(s.phase).toBe('ladder_pending');
    expect(s.escalationLog).toHaveLength(1);
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 4200 });
    const finalized = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 4300 });
    expect(finalized.phase).toBe('final');
  });

  it('a never-challenged strict case finalizes with an empty ledger (the no-challenge path)', () => {
    // The barrier must not demand records for rounds that were never opened —
    // this is the "every finalize path" half of the target.
    let s = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [...ROSTER],
      requireRoundBond: true,
      confirmDeadline: 1000,
      challengeDeadline: 2000,
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
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
    expect(s.phase).toBe('fee_settlement');
    expect(s.ladderRound).toBe(0);
    const finalized = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 2100 });
    expect(finalized.phase).toBe('final');
    expect(finalized.verdict?.upheld).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the derived bound versus the frozen depth
// ─────────────────────────────────────────────────────────────────────────────

describe('T2 / the derived ladder bound', () => {
  it('never approves a cap at or above the flip round (r33-6)', () => {
    // A jury at ≤ ½ accuracy on manufactured disputes makes round 1 profitable;
    // the old clamp (derivedCap = 1) blessed it. `ok` is sign-based now.
    for (const a_f of [0.3, 0.4, 0.45, 0.49, 0.5]) {
      const params = { a_f, rho: 0.03, beta: 0.03 };
      expect(deriveMaxLadderRounds(params), `a_f=${a_f}`).toBe(0);
      expect(ladderCapWithinBound({ ...params, maxLadderRounds: 1 }).ok, `a_f=${a_f}`).toBe(false);
      expect(escalationOptionEv({ ...params, rounds: 1 })).toBeGreaterThanOrEqual(0);
    }
    // And the property that matters, over the whole grid: `ok` implies the
    // challenger's expected profit at that depth is strictly negative.
    for (const a_f of [0.55, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]) {
      for (let cap = 1; cap <= 5; cap += 1) {
        const verdict = ladderCapWithinBound({ a_f, rho: 0.03, beta: 0.03, maxLadderRounds: cap });
        if (verdict.ok) {
          expect(escalationOptionEv({ a_f, rho: 0.03, beta: 0.03, rounds: cap }), `a_f=${a_f} cap=${cap}`)
            .toBeLessThan(0);
        }
        expect(verdict.ok).toBe(cap < verdict.flipRound);
      }
    }
  });

  it('keeps the published rows: 2 at a_f 0.75, 1 at 0.70, 5 (ceiling) at 0.90', () => {
    const SPEC = { rho: 0.03, beta: 0.03 } as const;
    expect(deriveMaxLadderRounds({ a_f: 0.9, ...SPEC })).toBe(5);
    expect(deriveMaxLadderRounds({ a_f: 0.75, ...SPEC })).toBe(2);
    expect(deriveMaxLadderRounds({ a_f: 0.7, ...SPEC })).toBe(1);
    expect(deriveLadderFlipRound({ a_f: 0.9, ...SPEC })).toBe(7);
    expect(ladderCapWithinBound({ a_f: 0.9, ...SPEC, maxLadderRounds: 2 }).ok).toBe(true);
    expect(ladderCapWithinBound({ a_f: 0.75, ...SPEC, maxLadderRounds: 2 }).ok).toBe(true);
    expect(ladderCapWithinBound({ a_f: 0.75, ...SPEC, maxLadderRounds: 3 }).ok).toBe(false);
  });

  it('(registered r33-7) the machine accepts a frozen depth ABOVE the derived bound', () => {
    // The machine has no `a_f` and must not invent one: a case frozen at 5
    // rounds is constructible even when a_f = 0.75 admits 2. The derived bound
    // is a creation-time pre-flight, and bao.markets' creation gate does not
    // call it (no a_f is measured anywhere in the host) — so nothing refuses
    // this config today. Pinned so the host wiring is the thing that changes.
    const overBound = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [...ROSTER],
      confirmDeadline: 1000,
      challengeDeadline: 2000,
      maxLadderRounds: 5,
    });
    expect(overBound.maxLadderRounds).toBe(5);
    expect(ladderCapWithinBound({ a_f: 0.75, rho: 0.03, beta: 0.03, maxLadderRounds: 5 }).ok).toBe(false);
  });

  it('prices the ladder the depth the document charges for (unchanged schedule)', () => {
    expect([1, 2, 3, 4, 5].map(cumulativeLadderBondMultiple)).toEqual([4, 13, 40, 121, 364]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the penalty-aging pair
// ─────────────────────────────────────────────────────────────────────────────

describe('T3 / pairedJurorWeight: idle gaps hand back nothing', () => {
  const W0 = 100;
  const PENALTY_SETS = [
    [{ factor: 0.8 }],
    [{ factor: 0.8 }, { factor: 0.5 }],
    [{ factor: 0.1 }],
    [{ factor: 0.8, ageEpochs: 3 }],
    [],
  ] as const;

  it('is non-increasing in idleEpochs for every penalty record', () => {
    for (const penalties of PENALTY_SETS) {
      let previous = Number.POSITIVE_INFINITY;
      for (let idle = 0; idle <= 12; idle += 1) {
        const w = pairedJurorWeight({ w0: W0, penalties: [...penalties], idleEpochs: idle });
        expect(w, `penalties=${JSON.stringify(penalties)} idle=${idle}`).toBeLessThanOrEqual(previous);
        previous = w;
      }
    }
  });

  it('anchors a floored juror at the FLOOR across deliberate idle gaps — never at w0', () => {
    // The r30-4 exploit: an idle juror's weight was reset back to w0. Under the
    // pair, a juror whose earned weight is at/below the floor stays AT the floor
    // for every idle gap, including a huge one.
    for (const penalties of [[{ factor: 0.1 }], [{ factor: 0.3 }, { factor: 0.6 }]] as const) {
      for (const idle of [0, 1, 3, 6, 13, 1000, Number.MAX_SAFE_INTEGER]) {
        expect(pairedJurorWeight({ w0: W0, penalties: [...penalties], idleEpochs: idle }), `idle=${idle}`)
          .toBe(50);
      }
    }
  });

  it('a bonus fades TOWARD w0 with idleness and never above the earned weight', () => {
    const idle0 = pairedJurorWeight({ w0: W0, bonusMultiplier: 1.2 });
    expect(idle0).toBeCloseTo(120, 10);
    expect(pairedJurorWeight({ w0: W0, bonusMultiplier: 1.2, idleEpochs: 3 })).toBeCloseTo(110, 10);
    expect(pairedJurorWeight({ w0: W0, bonusMultiplier: 1.2, idleEpochs: Number.MAX_SAFE_INTEGER }))
      .toBeCloseTo(100, 10);
  });

  it('the participating clock is the only way up (ageing is monotone and idling-independent)', () => {
    expect(agePenalties([{ factor: 0.8 }], 0)).toBeCloseTo(0.8, 12);
    expect(agePenalties([{ factor: 0.8 }], 3)).toBeCloseTo(0.9, 12);
    expect(agePenalties([{ factor: 0.8 }], 9)).toBeCloseTo(0.975, 12);
    // A stored participating age ages the same record with no idling at all...
    expect(agePenalties([{ factor: 0.8, ageEpochs: 3 }], 0)).toBeCloseTo(0.9, 12);
    expect(pairedJurorWeight({ w0: W0, penalties: [{ factor: 0.8, ageEpochs: 3 }] })).toBeCloseTo(90, 10);
    // ...but idling does not preserve that improvement: the anchor is the floor,
    // so idleness drags the partially-penalised juror back down (55 = 50 + 40·e^{−3λ}),
    // and only participating epochs re-earn the aged 90.
    expect(pairedJurorWeight({ w0: W0, penalties: [{ factor: 0.8, ageEpochs: 3 }], idleEpochs: 9 }))
      .toBeCloseTo(55, 10);
  });

  it('rejects negative / NaN / non-finite inputs (the floor is not reachable by garbage)', () => {
    expect(() => pairedJurorWeight({ w0: W0, idleEpochs: -1 })).toThrow(/idleEpochs/);
    expect(() => pairedJurorWeight({ w0: W0, idleEpochs: Number.NaN })).toThrow(/idleEpochs/);
    expect(() => pairedJurorWeight({ w0: W0, idleEpochs: Number.POSITIVE_INFINITY })).toThrow(/idleEpochs/);
    expect(() => pairedJurorWeight({ w0: -1 })).toThrow(/w0/);
    expect(() => pairedJurorWeight({ w0: W0, penalties: [{ factor: Number.NaN }] })).toThrow(/penalty factor/);
    expect(() => pairedJurorWeight({ w0: W0, penalties: [{ factor: 0 }] })).toThrow(/penalty factor/);
    expect(() => pairedJurorWeight({ w0: W0, penalties: [{ factor: 0.8, ageEpochs: -2 }] })).toThrow(/ageEpochs/);
    expect(() => pairedJurorWeight({ w0: W0, minWeightFactor: Number.NaN })).toThrow(/minWeightFactor/);
  });

  it('refuses an overflowing bonus instead of returning Infinity (r33-9)', () => {
    // Finite inputs, non-finite output: the old code returned `Infinity`, which
    // would dominate any lottery/selection comparison downstream.
    expect(() => pairedJurorWeight({ w0: 1e10, bonusMultiplier: 1e308 })).toThrow(/must stay finite/);
    // A large but representable bonus still works.
    expect(Number.isFinite(pairedJurorWeight({ w0: 1e10, bonusMultiplier: 1e10 }))).toBe(true);
  });

  it('(registered r33-8) `minWeightFactor: 1` disables every penalty', () => {
    // The floor is also the anchor, so a floor at w0 leaves nothing to decay:
    // a 0.1× penalty scores full weight. Pinned as a config hazard (documented
    // in the module); a host wanting "no floor" must use a factor < 1.
    expect(pairedJurorWeight({ w0: W0, penalties: [{ factor: 0.1 }], minWeightFactor: 1 })).toBe(W0);
  });
});
