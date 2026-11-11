// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * REVIEW ROUND 5 — attacking the ROUND-4 FIXES (v0.13.1).
 *
 * Round 4 attacked the v0.13.0 surface and shipped six closures. This round
 * attacks those closures the way they attack everything else: as an adversary
 * holding the reducer (or the pure helper), looking for the premise a guard
 * assumes, the symmetric path it forgot, and the input it reads as valid.
 *
 * Targets, as briefed:
 *   T1 refuse-any-accepted-bond (r33-1)   → §1, one EXPLOITABLE (fixed here)
 *   T2 complete ledger + onEscalate barrier (r33-5) → §2
 *   T3 sign-based bound / derivedCap = 0 (r33-6)    → §3
 *   T4 the Infinity guard (r33-9)                   → §4
 *
 * Every test is a CLOSURE (red before the fix in this PR), a PIN of a guard
 * that holds (named after the property, so a regression is visible), or a PIN
 * of a residual named `(registered …)` — a future fix is supposed to turn
 * those red on purpose. See `docs/REVIEW_ROUND_5.md` for the dispositions.
 */

import { describe, expect, it } from 'vitest';

import {
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
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
  escalationBondMultiple,
  escalationOptionEv,
  ladderCapWithinBound,
  ladderSignBoundary,
} from '../ladderEconomics';
import { agePenalties, pairedJurorWeight } from '../penaltyAging';
import { quadraticPriority, weightedPriority } from '../selection';
import { selectJury } from '../selection';
import { hexId, padHexId, repeatHexId } from './helpers/ids';

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

/** A challenged case parked at `round_resolved` after round 1. */
function resolvedRoundOne(opts: {
  readonly maxLadderRounds?: number;
  readonly requireRoundBond?: boolean;
  readonly hostEscalation?: boolean;
  /** Accept juror 3's challenge too, with an optional bond hash of its own. */
  readonly thirdChallengerHash?: string;
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
    bondTxid: hexId('d'),
    bondProofHash: MEMBERSHIP_2,
    eventId: padHexId('e2'),
    now: 1300,
  });
  if (opts.thirdChallengerHash !== undefined) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: hexId('f'),
      bondProofHash: opts.thirdChallengerHash,
      eventId: padHexId('e3'),
      now: 1400,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  s = openRound(s, 1, 3000, 2100, 'NO');
  return closeAndResolve(s, 3000, 3100);
}

function escalateEvent(
  s: CourtConfirmationMachineState,
  now: number,
  roundBondProofHash: string | null,
  challengerIdx?: number,
  challengerPubkey = PUBKEY,
) {
  return challengerEscalationEvent(s, now, {
    challengerPubkey,
    requestHash: REQUEST,
    ...(challengerIdx === undefined ? {} : { challengerIdx }),
    ...(roundBondProofHash === null ? {} : { roundBondProofHash }),
  });
}

/** Deep clone a state, so a test can act as a host restoring a tampered snapshot. */
function restore(state: CourtConfirmationMachineState): CourtConfirmationMachineState {
  return JSON.parse(JSON.stringify(state)) as CourtConfirmationMachineState;
}

/** A challenged case at `challenge_window` with juror 2 already bonded. */
function challengedWindow(): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: 4,
    requireRoundBond: true,
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
  return reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: hexId('d'),
    bondProofHash: MEMBERSHIP_2,
    eventId: padHexId('e2'),
    now: 1300,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — refuse-any-accepted-bond (r33-1), attacked
// ─────────────────────────────────────────────────────────────────────────────

describe('T1 / the r33-1 refusal assumes a challenge bond has ONE owner', () => {
  it('one bond witness cannot buy TWO challengers\' standing (r38-1, EXPLOITABLE)', () => {
    // The two-step bypass of r29-1: `accept_challenge` deduped by `idx` only, so
    // juror 3 (unbonded) minted an "accepted challenge" carrying juror 2's
    // `bondProofHash`, and the `(idx, bondProofHash)` escalation test then
    // matched for BOTH jurors. One payment, two escalation rights — and the
    // r33-1 guard enumerates `state.challenges`, i.e. a pool that itself was not
    // unique.
    const s = challengedWindow();
    expect(() => reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: hexId('f'),
      bondProofHash: MEMBERSHIP_2,
      eventId: padHexId('e3'),
      now: 1400,
    })).toThrow(/already bound to participant 2/);
    // Juror 3's OWN bond is still accepted (no over-correction), and the two
    // hashes then have distinct owners.
    const ok = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: hexId('f'),
      bondProofHash: MEMBERSHIP_3,
      eventId: padHexId('e3'),
      now: 1400,
    });
    expect(ok.challenges.map((c) => c.idx)).toEqual([2, 3]);
    expect(new Set(ok.challenges.map((c) => c.bondProofHash)).size).toBe(2);
  });

  it('the borrow it enabled is a FREE membership: unbonded juror escalates on it (r38-1)', () => {
    // Same attack end to end, with the pre-fix ledger reconstructed by hand (a
    // restored snapshot is the honest way to show the pre-fix state): the log
    // then names juror 3 as the payer of a bond juror 2 owns, and juror 3 paid
    // nothing to acquire standing.
    const s = resolvedRoundOne({ requireRoundBond: true });
    const borrowed: CourtConfirmationMachineState = {
      ...restore(s),
      phase: 'round_resolved',
      challenges: [
        ...restore(s).challenges,
        { idx: 3, bondTxid: hexId('f'), bondProofHash: MEMBERSHIP_2, eventId: padHexId('e3') },
      ],
    } as unknown as CourtConfirmationMachineState;
    // The barrier refuses the borrowed ledger outright — the ledger is the guard.
    expect(() => assertValidConfirmationLedger(borrowed)).toThrow(
      /binds one bond proof hash to participants 2 and 3/,
    );
  });

  it('the restore barrier refuses a duplicated bond hash (r38-1, finalize path)', () => {
    let s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 4 });
    s = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, roundBond(1)));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 4200 });
    expect(s.phase).toBe('fee_settlement');
    const tampered = restore(s);
    const duplicated = {
      ...tampered,
      challenges: [
        ...tampered.challenges,
        { idx: 3, bondTxid: hexId('f'), bondProofHash: MEMBERSHIP_2, eventId: padHexId('e3') },
      ],
    } as unknown as CourtConfirmationMachineState;
    // resolve_round's ledger barrier runs before an outcome locks in…
    expect(() => assertValidConfirmationLedger(duplicated)).toThrow(/one bond proof hash/);
  });

  it('a round bond may not be ANY of three accepted challenge bonds (not just its own)', () => {
    // The r33-1 rule, swept over the whole membership pool rather than the
    // escalating juror's own bond: two bonded rivals, either bond refused.
    const s = resolvedRoundOne({ requireRoundBond: true, thirdChallengerHash: MEMBERSHIP_3 });
    expect(s.challenges).toHaveLength(2);
    for (const borrowed of [MEMBERSHIP_2, MEMBERSHIP_3]) {
      // Juror 2's own bond trips the "distinct from the membership bond" rule;
      // juror 3's bond trips the "any accepted challenge bond" rule. Both are
      // refusals of the same relabelling, so both match the membership bond text.
      expect(() => reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, borrowed, 2)))
        .toThrow(/membership.*bond/);
    }
    expect(s.escalationLog).toHaveLength(0);
  });

  it('the consumed set for a round bond IS the union of the log and every challenge bond', () => {
    // The question the brief asks: is the consumption set the union? Yes for the
    // round bond (log hashes ∪ all challenge hashes). Probe the four cells.
    const s = resolvedRoundOne({ requireRoundBond: true, thirdChallengerHash: MEMBERSHIP_3 });
    // (a) a challenge bond → refused as a round bond
    expect(() => reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, MEMBERSHIP_3, 2)))
      .toThrow(/membership\) bond/);
    // (b) a genuinely fresh hash → accepted and recorded
    const paid = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, roundBond(1), 2));
    expect(paid.escalationLog[0].roundBondProofHash).toBe(roundBond(1));
    // (c) the same hash again in the same case → refused (consumed by round 2)
    let next = openRound(paid, 2, 4000, 3300, 'YES');
    next = closeAndResolve(next, 4000, 4100);
    expect(() => reduceCourtConfirmationMachine(next, escalateEvent(next, 4200, roundBond(1), 3)))
      .toThrow(/already consumed by round 2/);
    // (d) a later, INDEPENDENT case has no memory of it (r33-3, registered).
    const other = resolvedRoundOne({ requireRoundBond: true });
    expect(reduceCourtConfirmationMachine(other, escalateEvent(other, 3200, roundBond(1))).phase)
      .toBe('ladder_pending');
  });

  it('a round bond cannot become a membership bond inside the SAME case (phase + barrier)', () => {
    // The symmetric direction of r33-1. Live path: challenges are accepted only
    // in `challenge_window`, which is finished before any rung exists, so the
    // double role is unreachable. Restored path: the log barrier refuses a record
    // whose round bond is also an accepted challenge bond of the case.
    const s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 4 });
    const paid = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, roundBond(1)));
    expect(() => reduceCourtConfirmationMachine(paid, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: hexId('f'),
      bondProofHash: roundBond(1),
      eventId: padHexId('e9'),
      now: 3250,
    })).toThrow(/cannot accept challenges during ladder_pending/);
    // Restored: rung 2's witness is now also a challenge bond of juror 3.
    const tampered = {
      ...restore(paid),
      phase: 'round_resolved',
      ladderRound: 2,
      challenges: [
        ...restore(paid).challenges,
        { idx: 3, bondTxid: hexId('f'), bondProofHash: roundBond(1), eventId: padHexId('e9') },
      ],
    } as unknown as CourtConfirmationMachineState;
    expect(() => assertValidEscalationLog(tampered))
      .toThrow(/accepted challenge \(membership\) bond/);
  });

  it('(registered r38-2) hostEscalation:true makes requireRoundBond inert for challengers', () => {
    // Documented as a compatibility decision (perRoundBond.test.ts › 'a break-glass
    // case stays compatible'), and this round records its cost plainly: on a case
    // that sets BOTH flags, a challenger opens a rung with NO per-round bond, so
    // the strict policy prices nothing — the flag pair silently disables it. The
    // alternative (drop the exemption) contradicts a pinned decision, so the
    // disposition is an owner call: never compose the two flags, or tighten in
    // v0.14. See docs/REVIEW_ROUND_5.md §1.6.
    const s = resolvedRoundOne({ requireRoundBond: true, hostEscalation: true });
    const free = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, null));
    expect(free.phase).toBe('ladder_pending');
    expect(free.escalationLog[0].roundBondProofHash).toBeNull();
    // Without the break-glass flag the same escalation is refused.
    const strict = resolvedRoundOne({ requireRoundBond: true });
    expect(() => reduceCourtConfirmationMachine(strict, escalateEvent(strict, 3200, null)))
      .toThrow(/requires a per-round bond witness/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the complete ledger and the onEscalate barrier, attacked
// ─────────────────────────────────────────────────────────────────────────────

describe('T2 / the escalation ledger is complete, ordered, and bound to the challenge ledger', () => {
  /** A case at `fee_settlement` with `ladderRound` rounds opened and a forged log. */
  function forged(records: readonly unknown[], ladderRound: number, strict = true) {
    let s = resolvedRoundOne({ requireRoundBond: strict, maxLadderRounds: 5 });
    s = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, roundBond(1)));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, escalateEvent(s, 4200, roundBond(2)));
    s = openRound(s, 3, 5000, 4300, 'NO');
    s = closeAndResolve(s, 5000, 5100);
    return {
      ...restore(s),
      phase: 'fee_settlement',
      ladderRound,
      escalationLog: records,
    } as unknown as CourtConfirmationMachineState;
  }

  const record = (round: number, idx = 2, at = 3300) => ({
    round,
    authority: 'challenger' as const,
    challengerIdx: idx,
    challengerPubkey: PUBKEY,
    requestHash: REQUEST,
    bondProofHash: MEMBERSHIP_2,
    roundBondProofHash: roundBond(round),
    at,
  });

  it('records out of round order are refused', () => {
    expect(() => assertValidEscalationLog(forged([record(3), record(2)], 3)))
      .toThrow(/consecutive 2\.\.k sequence/);
  });

  it('the SAME round recorded twice is refused (a rung cannot be opened twice)', () => {
    expect(() => assertValidEscalationLog(forged([record(2), record(2)], 3)))
      .toThrow(/consecutive 2\.\.k sequence/);
  });

  it('a skipped round is refused (no gap, so no un-consumed rung)', () => {
    expect(() => assertValidEscalationLog(forged([record(2), record(4)], 3)))
      .toThrow(/consecutive 2\.\.k sequence/);
  });

  it('a record whose challenger does not match the challenge ledger is refused', () => {
    // idx 3 never posted a bond; idx 2 did. Naming idx 3 with idx 2's hash (the
    // shape r29-1 closed) is refused, and so is an out-of-roster index.
    expect(() => assertValidEscalationLog(forged([record(2, 3)], 2)))
      .toThrow(/not bound to that challenger's accepted bond/);
    expect(() => assertValidEscalationLog(forged([record(2, 9)], 2)))
      .toThrow(/not a case-roster participant/);
  });

  it('the no-challenge path never escalates, and finalize still runs the barrier', () => {
    // The brief's bypass question. Two probes: (a) a never-challenged case has
    // ladderRound 0, so ANY record is refused at finalize; (b) `escalate` needs
    // `round_resolved`, which a no-challenge case never reaches.
    let s = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [...ROSTER],
      confirmDeadline: 1000,
      challengeDeadline: 2000,
      requireRoundBond: true,
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
    // A hand-injected challenge cannot be escalated from without paying: the log
    // is empty AND complete for zero opened rounds, so it is the strict policy
    // that refuses the free rung — which is why the no-challenge path costs
    // nothing to the honest case and everything to the adversary.
    const revived = {
      ...restore(s),
      phase: 'round_resolved' as const,
      challenges: [{ idx: 2, bondTxid: hexId('d'), bondProofHash: MEMBERSHIP_2, eventId: padHexId('e2') }],
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(revived, escalateEvent(revived, 2100, null)))
      .toThrow(/requires a per-round bond witness/);
    expect(() => assertValidEscalationLog(revived)).not.toThrow();
    // (b) the clean no-challenge case finalizes with an empty ledger.
    const finalized = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 2100 });
    expect(finalized.phase).toBe('final');
    expect(finalized.verdict?.upheld).toBe(true);
    // (c) a hand-injected record on that same state is refused at finalize.
    const forgedNoChallenge = {
      ...restore(s),
      escalationLog: [{ ...record(2), roundBondProofHash: null }],
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(forgedNoChallenge, { type: 'finalize', now: 2100 }))
      .toThrow(/escalation log is incomplete/);
  });

  it('a duplicate ledger is refused at ESCALATE time, not only at finalize (r33-5 barrier)', () => {
    // onEscalate re-runs the barrier before seating a panel: the tampered
    // snapshot is refused with no round opened and no seat spent.
    let s = resolvedRoundOne({ requireRoundBond: true, maxLadderRounds: 5 });
    s = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, roundBond(1)));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    const doubled = {
      ...restore(s),
      escalationLog: [restore(s).escalationLog[0], restore(s).escalationLog[0]],
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(doubled, escalateEvent(doubled, 4200, roundBond(2))))
      .toThrow(/escalation log is incomplete/);
    expect(doubled.phase).toBe('round_resolved');
    expect(doubled.ladderRound).toBe(2);
  });

  it('(registered r38-3) the log\'s challengerPubkey is unverifiable by the machine', () => {
    // The binding that IS enforced is `(challengerIdx, bondProofHash)`; the
    // x-only pubkey is free text because the state carries no idx→pubkey map and
    // `accept_challenge` never records one. A challenger can therefore name an
    // unrelated key in the audit trail. Fix shape: v0.14 `accept_challenge`
    // carries the pubkey, making the pair a state binding.
    const s = resolvedRoundOne();
    const mislabelled = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, null, 2, hexId('f')));
    expect(mislabelled.phase).toBe('ladder_pending');
    expect(mislabelled.escalationLog[0].challengerPubkey).toBe(hexId('f'));
    expect(mislabelled.escalationLog[0].challengerIdx).toBe(2);
    // There is no participant key material in the state to check it against.
    expect(Object.keys(mislabelled).filter((k) => /pubkey/i.test(k))).toEqual([]);
  });

  it('(registered r33-5 residual) a LEGACY case can still be emptied; a strict one cannot', () => {
    // The deletion residual is scoped to `requireRoundBond === false` on purpose
    // (a pre-0.12 snapshot has no log). Re-pinned here at ladderRound 3 so the
    // scope of the exemption is explicit rather than inferred.
    const strict = forged([], 3, true);
    expect(() => assertValidEscalationLog(strict)).toThrow(/escalation log is incomplete/);
    const legacy = { ...forged([], 3, false), requireRoundBond: false } as CourtConfirmationMachineState;
    expect(() => assertValidEscalationLog(legacy)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the sign-based bound and derivedCap = 0
// ─────────────────────────────────────────────────────────────────────────────

describe('T3 / the derived bound fails closed and 0 is never a legal cap', () => {
  const SPEC = { rho: 0.03, beta: 0.03 } as const;

  it('adversarial parameters throw a typed error rather than returning garbage', () => {
    const bad: Array<readonly [string, Parameters<typeof deriveMaxLadderRounds>[0]]> = [
      ['a_f = 0', { a_f: 0, ...SPEC }],
      ['a_f < 0', { a_f: -0.5, ...SPEC }],
      ['a_f = NaN', { a_f: Number.NaN, ...SPEC }],
      ['a_f = Infinity', { a_f: Number.POSITIVE_INFINITY, ...SPEC }],
      ['a_f > 1', { a_f: 1.0001, ...SPEC }],
      ['a_f as a string', { a_f: '0.9' as unknown as number, ...SPEC }],
      ['rho = 0', { a_f: 0.9, rho: 0, beta: 0.03 }],
      ['rho < 0', { a_f: 0.9, rho: -1, beta: 0.03 }],
      ['rho = NaN', { a_f: 0.9, rho: Number.NaN, beta: 0.03 }],
      ['beta = 0', { a_f: 0.9, rho: 0.03, beta: 0 }],
      ['beta < 0', { a_f: 0.9, rho: 0.03, beta: -1 }],
      ['beta = Infinity', { a_f: 0.9, rho: 0.03, beta: Number.POSITIVE_INFINITY }],
    ];
    for (const [label, params] of bad) {
      expect(() => deriveMaxLadderRounds(params), label).toThrow();
      expect(() => deriveLadderFlipRound(params), label).toThrow();
      expect(() => ladderSignBoundary(params), label).toThrow();
      expect(() => escalationOptionEv({ ...params, rounds: 2 }), label).toThrow();
    }
    // A whole `params` object of the wrong shape throws too (no silent zeros).
    expect(() => deriveMaxLadderRounds(undefined as unknown as { a_f: number; rho: number; beta: number }))
      .toThrow(/a_f must be a finite accuracy/);
  });

  it('a perfect jury is unbounded, and a very bad one has NO safe depth (0, not 1)', () => {
    expect(deriveMaxLadderRounds({ a_f: 1, ...SPEC })).toBe(5);
    expect(deriveLadderFlipRound({ a_f: 1, ...SPEC })).toBe(Number.POSITIVE_INFINITY);
    expect(ladderCapWithinBound({ a_f: 1, ...SPEC, maxLadderRounds: 5 }).ok).toBe(true);
    // Break-even at round 1 (a_f = rho/(rho+beta)) is NOT safe: 0, flip 1.
    const atBreakEven = deriveMaxLadderRounds({ a_f: 0.5, ...SPEC });
    expect(atBreakEven).toBe(0);
    expect(ladderSignBoundary({ a_f: 0.5, ...SPEC })).toBe(1);
    expect(deriveLadderFlipRound({ a_f: 0.5, ...SPEC })).toBe(1);
  });

  it('derivedCap = 0 refuses EVERY legal cap — no cap can be blessed', () => {
    // The propagation question in the brief: a host that reads `ok` is safe at
    // every depth; a host that reads only `derivedCap` must read 0 as "no ladder".
    for (const a_f of [0.3, 0.4, 0.45, 0.5]) {
      const derivedCap = deriveMaxLadderRounds({ a_f, ...SPEC });
      expect(derivedCap, `a_f=${a_f}`).toBe(0);
      for (let cap = 1; cap <= 5; cap += 1) {
        const gate = ladderCapWithinBound({ a_f, ...SPEC, maxLadderRounds: cap });
        expect(gate.ok, `a_f=${a_f} cap=${cap}`).toBe(false);
        expect(gate.derivedCap).toBe(0);
        expect(gate.flipRound).toBe(1);
      }
      // …and the round it refuses is never negative: profitable below break-even,
      // exactly zero AT it (a_f = 0.5 with beta = rho), which is still "not safe".
      const ev1 = escalationOptionEv({ a_f, ...SPEC, rounds: 1 });
      expect(ev1).toBeGreaterThanOrEqual(0);
      if (a_f < 0.5) expect(ev1, `a_f=${a_f}`).toBeGreaterThan(0);
    }
    // One step above break-even the cap becomes 1 — and that round really is
    // strictly negative, so the sign boundary sits exactly at 0, with no epsilon
    // either way (an epsilon-loose comparison would bless the break-even round).
    const justAbove = ladderCapWithinBound({ a_f: 0.51, ...SPEC, maxLadderRounds: 1 });
    expect(justAbove.derivedCap).toBe(1);
    expect(justAbove.flipRound).toBe(2);
    expect(justAbove.ok).toBe(true);
    expect(escalationOptionEv({ a_f: 0.51, ...SPEC, rounds: 1 })).toBeLessThan(0);
  });

  it('ok is never true for a cap whose expected profit is non-negative (whole grid)', () => {
    const rows: Array<readonly [number, number, number]> = [
      [0.5001, 0.03, 0.03], [0.55, 0.03, 0.03], [0.6, 0.03, 0.03], [0.7, 0.03, 0.03],
      [0.75, 0.03, 0.03], [0.8, 0.03, 0.03], [0.85, 0.03, 0.03], [0.9, 0.03, 0.03],
      [0.95, 0.03, 0.03], [0.99, 0.03, 0.03], [1, 0.03, 0.03],
      [0.9, 0.03, 0.1], [0.9, 0.1, 0.03], [0.75, 1, 1e-9], [0.6, 1e-9, 1],
    ];
    for (const [a_f, rho, beta] of rows) {
      for (let cap = 1; cap <= 5; cap += 1) {
        const gate = ladderCapWithinBound({ a_f, rho, beta, maxLadderRounds: cap });
        if (gate.ok) {
          expect(escalationOptionEv({ a_f, rho, beta, rounds: cap }), `a_f=${a_f} cap=${cap}`)
            .toBeLessThan(0);
        }
        // Every R at or below the derived cap is strictly negative as well —
        // the contract that was false before r33-6.
        for (let r = 1; r <= gate.derivedCap; r += 1) {
          expect(escalationOptionEv({ a_f, rho, beta, rounds: r }), `a_f=${a_f} R=${r}`)
            .toBeLessThan(0);
        }
      }
    }
  });

  it('the cap is monotone: never deeper for a worse jury, never shallower for a bigger bond', () => {
    let previous = -1;
    for (const a_f of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 1]) {
      const cap = deriveMaxLadderRounds({ a_f, ...SPEC });
      expect(cap, `a_f=${a_f}`).toBeGreaterThanOrEqual(previous);
      previous = cap;
    }
    let floor = -1;
    for (const beta of [1e-6, 1e-3, 0.01, 0.03, 0.1, 1, 1e3, 1e300]) {
      const cap = deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta });
      expect(cap, `beta=${beta}`).toBeGreaterThanOrEqual(floor);
      floor = cap;
    }
    // Representability edges land on the SAFE side, never on a blessed cap:
    // rho/beta cancellation makes the ratio 1 (boundary 0 → no safe depth),
    // which is the correct verdict for a bond that is negligible next to V.
    expect(deriveMaxLadderRounds({ a_f: 0.9, rho: 1e308, beta: 1e-300 })).toBe(0);
    expect(ladderCapWithinBound({ a_f: 0.9, rho: 1e308, beta: 1e-300, maxLadderRounds: 1 }).ok)
      .toBe(false);
  });

  it('(registered r33-7) the machine runs a ladder the economics forbids', () => {
    // End-to-end consequence of the missing creation gate: `a_f = 0.6` has NO safe
    // depth (every cap refused above), yet the machine is constructed with a
    // frozen depth of 3 and plays three rounds. The machine has no `a_f` and must
    // not invent one, so the fix is the host creation/boot gate (disposition in
    // docs/REVIEW_ROUND_5.md §3.4, including the vendored-copy finding).
    expect(ladderCapWithinBound({ a_f: 0.6, ...SPEC, maxLadderRounds: 3 }).ok).toBe(false);
    let s = resolvedRoundOne({ maxLadderRounds: 3 });
    s = reduceCourtConfirmationMachine(s, escalateEvent(s, 3200, null));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, escalateEvent(s, 4200, null));
    s = openRound(s, 3, 5000, 4300, 'NO');
    s = closeAndResolve(s, 5000, 5100);
    expect(s.ladderRound).toBe(3);
    expect(s.phase).toBe('fee_settlement');
  });

  it('ladderCapWithinBound refuses an out-of-range cap instead of guessing', () => {
    for (const cap of [0, -1, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ladderCapWithinBound({ a_f: 0.9, ...SPEC, maxLadderRounds: cap }), String(cap))
        .toThrow(/maxLadderRounds must be a safe integer/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the Infinity guard, and the arithmetic around it
// ─────────────────────────────────────────────────────────────────────────────

describe('T4 / the weight arithmetic fails closed everywhere, not only at the guard', () => {
  it('the overflow guard covers every product it can reach', () => {
    expect(() => pairedJurorWeight({ w0: 1e308, bonusMultiplier: 10 }))
      .toThrow(/must stay finite/);
    expect(() => pairedJurorWeight({ w0: Number.MAX_VALUE, bonusMultiplier: Number.MAX_VALUE }))
      .toThrow(/must stay finite/);
    expect(() => pairedJurorWeight({ w0: 1e300, bonusMultiplier: 1e10 }))
      .toThrow(/must stay finite/);
    // Large but representable stays accepted (no over-correction).
    expect(pairedJurorWeight({ w0: 1e308, bonusMultiplier: 1.0000001 })).toBeCloseTo(1.0000001e308, -290);
    expect(Number.isFinite(pairedJurorWeight({ w0: 1e308, idleEpochs: 1e308 }))).toBe(true);
    expect(Number.isFinite(pairedJurorWeight({ w0: 1e308 }))).toBe(true);
  });

  it('no reachable path returns NaN or Infinity: underflow, zero bonus, huge idle', () => {
    const probes: Array<[string, number]> = [
      ['bonus 0', pairedJurorWeight({ w0: 100, bonusMultiplier: 0 })],
      ['100k penalties', pairedJurorWeight({ w0: 100, penalties: Array.from({ length: 100_000 }, () => ({ factor: 1e-300 })) })],
      ['subnormal factor', pairedJurorWeight({ w0: 100, penalties: [{ factor: 5e-324 }] })],
      ['huge idle', pairedJurorWeight({ w0: 100, idleEpochs: 9.007e15 })],
      ['huge age', pairedJurorWeight({ w0: 100, penalties: [{ factor: 0.5, ageEpochs: 1e308 }] })],
      ['tiny w0', pairedJurorWeight({ w0: 5e-324, minWeightFactor: 0.5 })],
      ['multiplicative underflow', agePenalties(Array.from({ length: 5000 }, () => ({ factor: 0.1 })), 0)],
    ];
    for (const [label, value] of probes) {
      expect(Number.isFinite(value), label).toBe(true);
      expect(Number.isNaN(value), label).toBe(false);
    }
    // A zero bonus cannot exceed the floor, and a penalty can never exceed w0.
    expect(pairedJurorWeight({ w0: 100, bonusMultiplier: 0 })).toBe(50);
    expect(pairedJurorWeight({ w0: 100, penalties: [{ factor: 1e-300 }], minWeightFactor: 0.5 }))
      .toBeGreaterThanOrEqual(50);
  });

  it('the selection layer refuses a non-finite weight (the downstream backstop)', () => {
    // Even a weight that escaped the reputation math cannot poison the draw: the
    // lottery input is validated where it is USED, which is the property r33-9
    // protects from the other end.
    expect(() => weightedPriority(0.5, Number.POSITIVE_INFINITY)).toThrow(/Invalid juror weight/);
    expect(() => weightedPriority(0.5, Number.NaN)).toThrow(/Invalid juror weight/);
    expect(() => weightedPriority(0.5, 0)).toThrow(/Invalid juror weight/);
    expect(() => weightedPriority(0.5, -1)).toThrow(/Invalid juror weight/);
    expect(weightedPriority(0.5, 1e300)).toBeLessThan(Number.MAX_VALUE);
    expect(Number.isFinite(quadraticPriority(0.5, Number.MAX_VALUE))).toBe(true);
    const pool = [1, 2, 3, 4, 5].map((n) => ({
      nostrPubkey: repeatHexId(`0${n}`),
      stakeCapacitySats: 1_000_000,
      stakeCommitment: {
        amountSats: 1_000_000,
        bondAddress: repeatHexId(`b${n}`),
        status: 'confirmed' as const,
      },
      wotScore: 100,
      categories: ['sports'],
      registeredAt: 0,
    }));
    expect(() => selectJury(pool, {
      disputeEventId: hexId('9'),
      blockHash: hexId('8'),
      marketCategory: 'sports',
      marketVolumeSats: 1_000_000,
      jurySize: 3,
      weightFn: () => Number.POSITIVE_INFINITY,
    })).toThrow(/Invalid juror weight/);
  });

  it('the per-round schedule stays exact and bounded inside the ladder', () => {
    // The schedule is defined up to the protocol ceiling + 1 (round 0 is the
    // case's own challenge bond), which is where the bounds must bite.
    for (let r = 0; r <= MAX_LADDER_ROUNDS + 1; r += 1) {
      const multiple = escalationBondMultiple(r);
      expect(Number.isFinite(multiple)).toBe(true);
      expect(multiple).toBe(3 ** r);
    }
    expect(() => escalationBondMultiple(MAX_LADDER_ROUNDS + 2)).toThrow(/within the ladder/);
    expect(() => escalationBondMultiple(-1)).toThrow(/non-negative safe integer/);
  });

  it('(registered r38-5) a penalty expires OUTRIGHT at ~156 participating epochs', () => {
    // A doc-precision item, not a defence: `agePenalties` is "asymptotic to 1 (a
    // penalty never expires outright)", but in double precision the deviation
    // underflows and the multiplier becomes exactly 1 after ~156 participating
    // epochs for a 0.8 factor — a forgiveness cliff in the *forgiving* direction
    // (weight never exceeds w0, and it is monotone either way). Pinned so the
    // asymmetry is stated, not discovered.
    expect(agePenalties([{ factor: 0.8 }], 155)).toBeLessThan(1);
    expect(agePenalties([{ factor: 0.8 }], 156)).toBe(1);
    expect(pairedJurorWeight({ w0: 100, penalties: [{ factor: 0.8, ageEpochs: 156 }] })).toBe(100);
    // The direction is safe: no age ever gives MORE than w0.
    for (const age of [0, 50, 156, 1e6]) {
      expect(pairedJurorWeight({ w0: 100, penalties: [{ factor: 0.8, ageEpochs: age }] }))
        .toBeLessThanOrEqual(100);
    }
  });
});
