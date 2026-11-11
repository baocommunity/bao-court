// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * REVIEW ROUND 7 — attacking v0.13.2 and the R41 host fixes (#2434).
 *
 * The target list, one describe() per target:
 *
 *   T1 the sign-rule predicate ({a_f, ρ, β})        → §1 (probed; 1 host finding)
 *   T2 the legacy depth clamp                       → §2 (host; package pins)
 *   T3 the entry matrix's three NON-readers         → §3 (1 EXPLOITABLE, fixed)
 *   T4 the strict round-bond default / upgrade path → §4 (doc + pins)
 *
 * §3 is the round's closure: `close_ladder_round`, `concede` and `flag_clawback`
 * are recorded in REVIEW_ROUND_6 §1.2 as entries that do NOT read the challenge
 * pool, "followed by a pool-reading barrier before any value is locked in".
 * That is true of the POOL and false of the other ledger `finalize` reads: for a
 * challenged case the verdict's evidence IS the round vote ledger
 * (`state.ladder.votes`), and `onFinalize` never re-derived it. Enter through
 * `concede` (a stated non-reader), forge the vote ledger, and the machine mints
 * a canonical verdict for an outcome the votes never chose.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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
  assertValidEscalationLog,
  assertValidConfirmationLedger,
  assertValidMassVoteLedger,
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
const MEMBERSHIP_2 = hexId('e');
const BOND_TXID_2 = hexId('d');
const roundBond = (r: number): string => padHexId(`a${r}`);

const restore = (s: CourtConfirmationMachineState): CourtConfirmationMachineState =>
  JSON.parse(JSON.stringify(s)) as CourtConfirmationMachineState;

function barrierRefuses(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

function makeClock(): { now: () => number; jumpTo: (t: number) => number } {
  let t = 0;
  return { now: () => (t += 1), jumpTo: (to: number) => (t = Math.max(t, to)) };
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
  return reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: clock.jumpTo(11) });
}

/** A challenged case parked at `round_resolved` after round 1 (votes: NO). */
function resolvedRoundOne(opts: { strict?: boolean; host?: boolean; maxRounds?: number } = {}) {
  const clock = makeClock();
  let s = confirmAndOpenChallenge(opts.strict ?? false, opts.host ?? false, opts.maxRounds ?? 4, clock);
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: BOND_TXID_2,
    bondProofHash: MEMBERSHIP_2,
    eventId: padHexId('e2'),
    now: clock.jumpTo(12),
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: clock.jumpTo(20) });
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

/**
 * A legal CHALLENGED case at `fee_settlement`, reached through `concede` — the
 * stated non-reader of REVIEW_ROUND_6 §1.2 — with round 2 resolving NO on every
 * ballot (the proposal was YES, so the honest verdict is NO / not upheld).
 */
function feeSettlement(strict = true) {
  const { state, clock } = resolvedRoundOne({ strict });
  let s = reduceCourtConfirmationMachine(
    state,
    challengerEscalationEvent(state, clock.now(), {
      challengerPubkey: PUBKEY,
      requestHash: REQUEST,
      challengerIdx: 2,
      roundBondProofHash: roundBond(2),
    }),
  );
  s = reduceCourtConfirmationMachine(s, {
    type: 'open_ladder_round',
    round: 2,
    voteDeadline: clock.now() + 100,
    now: clock.now(),
  });
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
  s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: clock.now() });
  s = reduceCourtConfirmationMachine(s, { type: 'concede', now: clock.now() });
  return { state: s, clock };
}

/** Replace the round vote ledger on a restored snapshot (readonly field). */
function withVotes(
  s: CourtConfirmationMachineState,
  votes: readonly unknown[],
): CourtConfirmationMachineState {
  const tampered = restore(s);
  (tampered.ladder as unknown as { votes: unknown[] }).votes = [...votes];
  return tampered;
}

/** Replace the pending verdict on a restored snapshot (readonly field). */
function withVerdict(
  s: CourtConfirmationMachineState,
  verdict: Record<string, unknown>,
): CourtConfirmationMachineState {
  const tampered = restore(s);
  (tampered as unknown as { verdict: unknown }).verdict = verdict;
  return tampered;
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the sign-rule predicate: {a_f, ρ, β} probed at the edges
// ─────────────────────────────────────────────────────────────────────────────
describe('T1 — the sign-rule predicate takes three parameters, two of them money', () => {
  const P = (a_f: number, rho: number, beta: number) => ({ a_f, rho, beta });

  it('(r41-T1) the verdict depends ONLY on the ratio ρ/(ρ+β): scale invariance', () => {
    const base = ladderSignBoundary(P(0.85, 0.03, 0.03));
    expect(ladderSignBoundary(P(0.85, 3, 3))).toBe(base);
    expect(ladderSignBoundary(P(0.85, 0.003, 0.003))).toBe(base);
    // …and every cap/flip/ok derived from it is therefore scale-free, so a host
    // that passes ρ and β in DIFFERENT units (both `fraction of V`, or both
    // sats) still gets the same verdict — but a host that passes one of each
    // does not. Pinned because #2434's constants are fractions and the host's
    // bond is a sat amount (`DisputeEscrowService` `baseBond`).
    expect(deriveMaxLadderRounds(P(0.85, 3, 3))).toBe(deriveMaxLadderRounds(P(0.85, 0.03, 0.03)));
  });

  it('(r41-T1, R52) β ≠ ρ at an integral boundary: the cap STOPS BELOW break-even (r40-4 regression lock)', () => {
    const p = P(0.5, 0.03, 0.09); // boundary exactly 2: a_f = ρ/(ρ+β)
    expect(ladderSignBoundary(p)).toBe(2);
    // R52: the exported cap is the safe PREDICATE, so the break-even round is
    // excluded from it (pre-R52 this returned 2 — the break-even round itself —
    // while the gate refused cap 2: report-vs-decision mismatch, H-2).
    expect(deriveMaxLadderRounds(p)).toBe(1);
    expect(deriveLadderFlipRound(p)).toBe(2);
    // E[π(2)] = 0 EXACTLY — a free option, not a deterrent.
    expect(escalationOptionEv({ ...p, rounds: 2 })).toBe(0);
    expect(escalationOptionEv({ ...p, rounds: 1 })).toBeLessThan(0);
    expect(ladderCapWithinBound({ ...p, maxLadderRounds: 2 }).ok).toBe(false);
    expect(ladderCapWithinBound({ ...p, maxLadderRounds: 1 }).ok).toBe(true);
    // The retired composition (`cap <= derivedCap`) now agrees with the gate at
    // the boundary: cap 2 is above the derived cap 1, and cap 1 is inside it.
    expect(2 <= deriveMaxLadderRounds(p)).toBe(false);
    expect(1 <= deriveMaxLadderRounds(p)).toBe(true);
    // …and the depth one below the boundary is still safe at every β/ρ ratio
    // probed here, so the refusal is the break-even rung and nothing wider.
    for (const beta of [0.03, 0.05, 0.09, 0.15]) {
      for (const a_f of [0.45, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) {
        const q = P(a_f, 0.03, beta);
        const { ok, derivedCap } = ladderCapWithinBound({ ...q, maxLadderRounds: 1 });
        if (derivedCap >= 1) {
          expect(ok).toBe(true);
          expect(escalationOptionEv({ ...q, rounds: 1 })).toBeLessThan(0);
        }
      }
    }
  });

  it('(r41-T1) ok(cap) is monotone: non-DEcreasing in a_f, non-decreasing in β', () => {
    // The docstring of `deriveMaxLadderRounds` says "Monotone non-increasing in
    // `a_f`" — which is BACKWARDS, and was measured before it was believed: the
    // cap runs 0 → 5 as accuracy rises (a less accurate jury gets a SHALLOWER
    // ladder, i.e. the function is non-decreasing in a_f). The parenthetical in
    // the same sentence has the direction right, so this is a doc bug, not a
    // code bug; corrected in `ladderEconomics.ts` by this round (r41-T1-doc).
    const accuracies = [0.3, 0.4, 0.45, 0.49, 0.5, 0.51, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
    const betas = [0.003, 0.01, 0.02, 0.03, 0.05, 0.09, 0.5];
    let previousCap = -1;
    let previousFlip = -1;
    for (const a_f of accuracies) {
      const p = P(a_f, 0.03, 0.03);
      const cap = deriveMaxLadderRounds(p);
      const flip = deriveLadderFlipRound(p);
      // A more accurate jury must never get a SHALLOWER ladder, and the first
      // profitable round must never move earlier as accuracy rises.
      expect(cap).toBeGreaterThanOrEqual(previousCap);
      expect(flip).toBeGreaterThanOrEqual(previousFlip);
      previousCap = cap;
      previousFlip = flip;
    }
    let previousBetaCap = -1;
    for (const beta of betas) {
      const cap = deriveMaxLadderRounds(P(0.85, 0.03, beta));
      // A BIGGER bond must never shrink the safe depth.
      expect(cap).toBeGreaterThanOrEqual(previousBetaCap);
      previousBetaCap = cap;
    }
    // Monotone in a_f also holds for the boolean verdict at every legal cap.
    for (const cap of [1, 2, 3, 4, 5]) {
      let seenTrue = false;
      for (const a_f of accuracies) {
        const ok = ladderCapWithinBound({ ...P(a_f, 0.03, 0.03), maxLadderRounds: cap }).ok;
        if (ok) seenTrue = true;
        // Once true for some accuracy, it must stay true for every HIGHER one.
        if (seenTrue) expect(ok).toBe(true);
      }
    }
  });

  it('(r41-T1) edge inputs fail closed: ρ = 0, β = 0, a_f = 0, NaN, a_f > 1', () => {
    for (const bad of [
      { a_f: 0.85, rho: 0, beta: 0.03 },
      { a_f: 0.85, rho: 0.03, beta: 0 },
      { a_f: 0.85, rho: -0.03, beta: 0.03 },
      { a_f: 0, rho: 0.03, beta: 0.03 },
      { a_f: Number.NaN, rho: 0.03, beta: 0.03 },
      { a_f: 1.5, rho: 0.03, beta: 0.03 },
      { a_f: 0.85, rho: Number.POSITIVE_INFINITY, beta: 0.03 },
    ]) {
      expect(() => ladderCapWithinBound({ ...bad, maxLadderRounds: 3 })).toThrow();
    }
    // `a_f = 1` is LEGAL in this package (a perfect jury never makes the ladder
    // profitable) and yields an INFINITE bound — i.e. every depth is safe. That
    // is the one input that disables the gate, which is why the host's env
    // resolver (`courtAssumedJurorAccuracy`) refuses `1` and any value ≥ 1 and
    // falls back to 0.85. Pinned so the two layers cannot drift: the package
    // documents the mathematics, the host owns the fail-closed policy.
    expect(deriveMaxLadderRounds({ a_f: 1, rho: 0.03, beta: 0.03 })).toBe(MAX_LADDER_ROUNDS);
    expect(ladderCapWithinBound({ a_f: 1, rho: 0.03, beta: 0.03, maxLadderRounds: 5 }).ok).toBe(true);
  });

  it('(r41-T1, R52) a bond that would overflow ρ+β in floats is still evaluated exactly', () => {
    // Not reachable with fractions of V (ρ+β ≤ 2). Pre-R52 the float sum
    // overflowed to Infinity, which took the `a_f = 1` branch and reported the
    // ceiling; the exact-integer predicate has no such branch, so the verdict is
    // the real one: ratio ρ/(ρ+β) = ½ = a_f ⇒ break-even at round 1 ⇒ no safe
    // depth. `ladderSignBoundary` is still telemetry and still overflows.
    const p = { a_f: 0.5, rho: 1e308, beta: 1e308 };
    expect(ladderSignBoundary(p)).toBe(Number.POSITIVE_INFINITY);
    expect(deriveMaxLadderRounds(p)).toBe(0);
    expect(deriveLadderFlipRound(p)).toBe(1);
    expect(ladderCapWithinBound({ ...p, maxLadderRounds: 1 }).ok).toBe(false);
  });

  it('(r41-T1) `derivedCap = 0` means "refuse every ladder", and no cap 1..5 is blessed', () => {
    for (const a_f of [0.3, 0.4, 0.45, 0.5]) {
      const p = P(a_f, 0.03, 0.03);
      expect(deriveMaxLadderRounds(p)).toBe(0);
      for (let cap = 1; cap <= MAX_LADDER_ROUNDS; cap += 1) {
        expect(ladderCapWithinBound({ ...p, maxLadderRounds: cap }).ok).toBe(false);
        // `a_f = ρ/(ρ+β)` is the exact break-even cell: E[π(R)] = 0 at R = 1 and
        // strictly positive above it — the boundary is where "no depth is safe"
        // begins, and `ok` refuses there too (the sign rule is strict).
        expect(escalationOptionEv({ ...p, rounds: cap })).toBeGreaterThanOrEqual(0);
        if (cap > 1 || a_f < 0.5) expect(escalationOptionEv({ ...p, rounds: cap })).toBeGreaterThan(0);
      }
    }
  });

  it('(r41-T1) host finding H-1: the gate\'s CONSTANT β is the bond at CREATION, not the β the rule needs', () => {
    // The sign rule needs β = bond / V_at_adjudication. #2434 hardcodes
    // ρ = β = 0.03 ("the spec's base"), with the docstring's own caveat that
    // the escrow's real bond is 5 %. Both numbers are conservative AT CREATION
    // (`baseBond = max(0.05·V, 10_000)` ⇒ β ≥ 0.05 > 0.03), and both drift the
    // moment V grows after creation — which the host allows (liquidity adds up
    // to the economic cap). The package's own arithmetic shows the direction:
    const atGate = P(0.85, 0.03, 0.03); // what #2434 assesses
    const atCreation = P(0.85, 0.03, 0.05); // the real bond on a 200k market
    const atGrowth = P(0.85, 0.03, 0.01); // the same 10k bond on a 1M market
    expect(deriveMaxLadderRounds(atGate)).toBe(4);
    expect(deriveMaxLadderRounds(atCreation)).toBe(5); // gate is STRICTER here: safe
    expect(deriveMaxLadderRounds(atGrowth)).toBe(1); // gate is LOOSER here: 3 profitable rungs
    // The drift is not a rounding artefact: it is three whole rungs.
    expect(deriveMaxLadderRounds(atGate) - deriveMaxLadderRounds(atGrowth)).toBe(3);
    // And the sign rule is the one that decides whether a rung is profitable:
    for (let round = 2; round <= deriveMaxLadderRounds(atGate); round += 1) {
      expect(escalationOptionEv({ ...atGrowth, rounds: round })).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the entry matrix's three NON-readers, probed with a forged snapshot
// ─────────────────────────────────────────────────────────────────────────────
describe('T3 — the three stated non-readers are safe only up to the NEXT barrier', () => {
  it('(r41-1) `concede` (a stated non-reader) accepts a forged vote ledger — it reads no ledger at all', () => {
    const { state, clock } = resolvedRoundOne();
    const forged = withVotes(state, [
      { idx: 1, outcome: 'NO', eventId: padHexId('2b1') },
      { idx: 1, outcome: 'NO', eventId: padHexId('2b1') }, // duplicate index + event id
      { idx: 99, outcome: 'NO', eventId: padHexId('2b99') }, // not on the roster
    ]);
    // It parks in fee_settlement regardless: concede's contract is "the current
    // round's outcome becomes final", and it deliberately re-derives nothing.
    const conceded = reduceCourtConfirmationMachine(forged, { type: 'concede', now: clock.now() });
    expect(conceded.phase).toBe('fee_settlement');
    // The barrier that WOULD refuse it is the mass-vote ledger's:
    expect(barrierRefuses(() => assertValidMassVoteLedger(conceded))).toMatch(
      /duplicate mass votes|mass vote participant/,
    );
  });

  it('(r41-1) `finalize` did NOT run that barrier: it minted the verdict from the forged ledger', () => {
    const { state, clock } = feeSettlement();
    // Round 2's honest tally is NO (every ballot NO). Forge ONE vote for YES and
    // point the pending verdict at it: every record below is one the machine
    // could never have produced, and no barrier at finalize looked at any of it.
    const forged = withVerdict(
      withVotes(state, [{ idx: 1, outcome: 'YES', eventId: padHexId('f1') }]),
      { outcome: 'YES', supportingEventIds: [], verdictHash: '', upheld: true },
    );
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(forged, { type: 'finalize', now: clock.now() }),
    );
    expect(message).toMatch(/vote ledger|recorded outcome|tally/i);
  });

  it('(r41-1) …and therefore a LOSING outcome could be minted as the canonical verdict', () => {
    const { state, clock } = feeSettlement();
    const forged = withVerdict(
      withVotes(state, [{ idx: 1, outcome: 'YES', eventId: padHexId('f2') }]),
      { outcome: 'YES', supportingEventIds: [], verdictHash: '', upheld: true },
    );
    // Before the fix this returned `final` with outcome YES, upheld true, and a
    // verdictHash over an evidence set that never existed — the market pays YES
    // on a case every panel voted NO.
    expect(() => reduceCourtConfirmationMachine(forged, { type: 'finalize', now: clock.now() })).toThrow();
    expect(state.verdict?.outcome).toBe('NO');
    expect(state.outcomeHistory.map((r) => r.outcome)).toEqual(['NO', 'NO']);
  });

  it('(r41-1) the vote ledger is now re-derived at finalize: duplicates, outsiders and bad ids refused', () => {
    const { state, clock } = feeSettlement();
    const cases: ReadonlyArray<readonly unknown[]> = [
      // duplicate (idx, eventId) pair
      [
        { idx: 1, outcome: 'NO', eventId: padHexId('2b1') },
        { idx: 1, outcome: 'NO', eventId: padHexId('2b1') },
      ],
      // duplicate event id under two indices (one ballot, two supporters)
      [
        { idx: 1, outcome: 'NO', eventId: padHexId('2b1') },
        { idx: 2, outcome: 'NO', eventId: padHexId('2b1') },
      ],
      // off-roster voter
      [{ idx: 99, outcome: 'NO', eventId: padHexId('2b99') }],
      // outcome outside the frozen ballot
      [{ idx: 1, outcome: 'MAYBE', eventId: padHexId('2b1') }],
      // malformed event id — used to escape as the VOTE machine's error type
      [{ idx: 1, outcome: 'NO', eventId: 'zz' }],
    ];
    for (const votes of cases) {
      const forged = withVotes(state, votes);
      const message = barrierRefuses(() =>
        reduceCourtConfirmationMachine(forged, { type: 'finalize', now: clock.now() }),
      );
      expect(message).not.toBe('');
      // Always THIS machine's typed error, never a foreign one escaping.
      expect(message).not.toMatch(/CourtVoteTransitionError/);
    }
  });

  it('(r41-1) the pending `upheld` flag is re-derived, not trusted (it is not in the verdictHash)', () => {
    const { state, clock } = feeSettlement();
    expect(state.verdict).toMatchObject({ outcome: 'NO', upheld: false });
    const flipped = withVerdict(state, { ...state.verdict, upheld: true });
    const message = barrierRefuses(() =>
      reduceCourtConfirmationMachine(flipped, { type: 'finalize', now: clock.now() }),
    );
    expect(message).toMatch(/upheld/i);
    // The honest snapshot still finalizes, with the SAME hash either way — which
    // is exactly why the flag cannot be left to the caller: the hash covers
    // (session, outcome, supporting event ids) and nothing else.
    const done = reduceCourtConfirmationMachine(state, { type: 'finalize', now: clock.now() });
    expect(done.phase).toBe('final');
    expect(done.verdict).toMatchObject({ outcome: 'NO', upheld: false });
    expect(done.verdict?.verdictHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('(r41-1) positive control: `resolve_round` always refused the same ledger', () => {
    const { state, clock } = resolvedRoundOne();
    let s = reduceCourtConfirmationMachine(
      state,
      challengerEscalationEvent(state, clock.now(), {
        challengerPubkey: PUBKEY,
        requestHash: REQUEST,
        challengerIdx: 2,
        roundBondProofHash: roundBond(2),
      }),
    );
    s = reduceCourtConfirmationMachine(s, {
      type: 'open_ladder_round',
      round: 2,
      voteDeadline: clock.now() + 100,
      now: clock.now(),
    });
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
    const forged = withVotes(s, [{ idx: 1, outcome: 'NO', eventId: padHexId('2b1') }, { idx: 1, outcome: 'NO', eventId: padHexId('2b1') }]);
    // `resolve_round` re-derives it (this is why the live path was safe)…
    expect(barrierRefuses(() => reduceCourtConfirmationMachine(forged, { type: 'resolve_round', now: clock.now() })))
      .toMatch(/duplicate mass votes/);
  });

  it('(r41-1) over-strictness: EVERY legal flow still finalizes with the derived verdict', () => {
    // Both policies × both authorities × depths 1..5 × never-challenged, so a
    // fix that refuses a state the reducer can reach turns this red.
    let finalized = 0;
    for (const strict of [false, true]) {
      for (const host of [false, true]) {
        for (let maxRounds = 1; maxRounds <= MAX_LADDER_ROUNDS; maxRounds += 1) {
          // never challenged
          {
            const clock = makeClock();
            let s = confirmAndOpenChallenge(strict, host, maxRounds, clock);
            s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: clock.jumpTo(20) });
            s = reduceCourtConfirmationMachine(s, { type: 'finalize', now: clock.now() });
            expect(s.phase).toBe('final');
            expect(s.verdict).toMatchObject({ outcome: 'YES', upheld: true });
            finalized += 1;
          }
          // challenged, receding to the cap (legal escalation path)
          {
            const { state, clock } = resolvedRoundOne({ strict, host, maxRounds });
            let s = state;
            while (s.phase === 'round_resolved') {
              const event = host && s.hostEscalation === true && s.requireRoundBond === true
                ? hostEscalationEvent(s, clock.now())
                : challengerEscalationEvent(s, clock.now(), {
                  challengerPubkey: PUBKEY,
                  requestHash: REQUEST,
                  challengerIdx: 2,
                  roundBondProofHash: roundBond(s.ladderRound + 1),
                });
              s = reduceCourtConfirmationMachine(s, event);
              const round = s.ladderRound + 1;
              s = reduceCourtConfirmationMachine(s, {
                type: 'open_ladder_round',
                round,
                voteDeadline: clock.now() + 100,
                now: clock.now(),
              });
              for (const idx of ROSTER) {
                s = reduceCourtConfirmationMachine(s, {
                  type: 'accept_mass_vote',
                  idx,
                  outcome: 'NO',
                  eventId: padHexId(`${round}b${idx}`),
                  now: clock.now(),
                });
              }
              s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: clock.jumpTo(clock.now() + 100) });
              s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: clock.now() });
            }
            expect(s.phase).toBe('fee_settlement');
            const done = reduceCourtConfirmationMachine(s, { type: 'finalize', now: clock.now() });
            expect(done.phase).toBe('final');
            expect(done.verdict).toMatchObject({ outcome: 'NO', upheld: false });
            finalized += 1;
          }
        }
      }
    }
    expect(finalized).toBe(40);
  });

  it('(r41-T3) the other two non-readers: `close_ladder_round` and `flag_clawback` lock nothing in', () => {
    // close_ladder_round: reads the vote ledger but never the challenge pool, so
    // a forged pool passes it — and `resolve_round` refuses straight after, so no
    // verdict is ever minted from it (the case bricks, it does not settle wrong).
    const { state, clock } = feeSettlement();
    const forgedPool = restore(state);
    (forgedPool.challenges as unknown as unknown[]).push({
      idx: 3,
      bondTxid: BOND_TXID_2,
      bondProofHash: MEMBERSHIP_2,
      eventId: padHexId('e3'),
    });
    expect(barrierRefuses(() => assertValidConfirmationLedger(forgedPool))).toMatch(/binds one bond proof hash/);
    // …and finalize (the value-locking entry) is the one that re-checks it:
    expect(barrierRefuses(() =>
      reduceCourtConfirmationMachine(forgedPool, { type: 'finalize', now: clock.now() }),
    )).toMatch(/binds one bond proof hash/);
    // flag_clawback: phase-guarded (fee_settlement only), roster-guarded, and an
    // append-only flag ledger that is deliberately NOT a verdict input — the
    // same state with and without the flag mints an identical verdictHash.
    const flagged = reduceCourtConfirmationMachine(state, {
      type: 'flag_clawback',
      idx: 1,
      reason: 'operator_review',
      now: clock.now(),
    });
    const donePlain = reduceCourtConfirmationMachine(state, { type: 'finalize', now: clock.now() });
    const doneFlagged = reduceCourtConfirmationMachine(flagged, {
      type: 'finalize',
      now: clock.now(),
    });
    expect(doneFlagged.verdict?.verdictHash).toBe(donePlain.verdict?.verdictHash);
    expect(doneFlagged.clawbackFlags.length).toBe(donePlain.clawbackFlags.length + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the strict round-bond default and the upgrade path
// ─────────────────────────────────────────────────────────────────────────────
describe('T4 — strict-by-default is a HOST policy; a LEGACY snapshot must keep working', () => {
  it('(r41-T4) a v0.12 snapshot (requireRoundBond ABSENT) is legacy, not strict', () => {
    const { state, clock } = resolvedRoundOne({ strict: false });
    const restored = restore(state) as unknown as Record<string, unknown>;
    delete restored.requireRoundBond; // pre-0.13 snapshot shape
    const legacy = restored as unknown as CourtConfirmationMachineState;
    expect(legacy.requireRoundBond).toBeUndefined();
    // An escalation without a round bond is legal on it (the documented legacy
    // free option), and the log barrier reads the ABSENT field as `null`.
    const escalated = reduceCourtConfirmationMachine(
      legacy,
      challengerEscalationEvent(legacy, clock.now(), {
        challengerPubkey: PUBKEY,
        requestHash: REQUEST,
        challengerIdx: 2,
      }),
    );
    expect(escalated.phase).toBe('ladder_pending');
    expect(() => assertValidEscalationLog(escalated)).not.toThrow();
    // …and it still reaches a verdict (an upgraded deployment must not brick
    // every pre-0.13 case it restores).
    const legacyNoChallenge = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [...ROSTER],
      confirmDeadline: 10,
      challengeDeadline: 20,
    });
    // The factory default is the legacy policy, which is why the host must opt in.
    expect(legacyNoChallenge.requireRoundBond).toBe(false);
  });

  it('(r41-T4) a STRICT case refuses the witness-less escalation (the policy is real at this layer)', () => {
    const { state, clock } = resolvedRoundOne({ strict: true });
    expect(barrierRefuses(() =>
      reduceCourtConfirmationMachine(
        state,
        challengerEscalationEvent(state, clock.now(), {
          challengerPubkey: PUBKEY,
          requestHash: REQUEST,
          challengerIdx: 2,
        }),
      ),
    )).toMatch(/requires a per-round bond witness/);
    // …and `hostEscalation: true` makes it inert — the r38-2 interaction the
    // host's runbook excludes from production.
    const { state: breakGlass } = resolvedRoundOne({ strict: true, host: true });
    const bent = restore(breakGlass);
    const escalated = reduceCourtConfirmationMachine(
      bent,
      hostEscalationEvent(bent, 999),
    );
    expect(escalated.phase).toBe('ladder_pending');
  });

  it('(r41-T4) the upgrade checklist and the entry-matrix correction are IN the docs', () => {
    const bond = readFileSync(new URL('../docs/PER_ROUND_BOND.md', import.meta.url), 'utf8');
    // The checklist an operator upgrading a legacy deployment needs before
    // arming the strict policy (the transport must carry the witness FIRST).
    expect(bond).toMatch(/Upgrading a deployment to the strict policy/);
    expect(bond).toMatch(/transport must carry the witness BEFORE the policy requires it/);
    expect(bond).toMatch(/strict case cannot be relaxed later/);
    // The r41-1 correction: `finalize` reads the VOTE ledger for a challenged
    // case, so "the three non-readers are followed by a pool-reading barrier"
    // was not the whole story.
    expect(bond).toMatch(/the verdict's evidence is the \*\*round vote ledger\*\*/);
    const invariants = readFileSync(new URL('../docs/FORMAL_INVARIANTS.md', import.meta.url), 'utf8');
    expect(invariants).toMatch(/INV-CONF-32b \(verdict evidence barrier at finalize/);
  });

  it('(r41-T1-doc) the monotonicity sentence points the way the code runs', () => {
    // The docstring said "non-increasing in a_f"; the grid runs 0 → 5 as the
    // accuracy rises, so a reader implementing a host-side check from that
    // sentence would invert the guard. Pinned as text AND as behaviour.
    const source = readFileSync(new URL('../ladderEconomics.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/Monotone \*\*non-decreasing in `a_f`\*\*/);
    expect(source).not.toMatch(/Monotone non-increasing in `a_f`/);
    let previous = -1;
    for (const a_f of [0.3, 0.5, 0.75, 0.85, 0.9]) {
      const cap = deriveMaxLadderRounds({ a_f, rho: 0.03, beta: 0.03 });
      expect(cap).toBeGreaterThanOrEqual(previous);
      previous = cap;
    }
  });
});
