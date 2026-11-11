// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * THE MECHANISED ARTIFACTS, CROSS-CHECKED AGAINST THE CODE THEY MODEL.
 *
 * `proofs/lean4/LadderBound.lean` and `proofs/lean4/EscalationLedger.lean`
 * prove theorems about a MODEL; a proof about a model is only worth what its
 * correspondence to the shipped code is worth. This file is that
 * correspondence, executed: every mechanised headline theorem is instantiated
 * on the real functions, over a parameter grid rather than a single example.
 *
 * What is pinned, theorem by theorem:
 *
 *   LadderBound.lean
 *     1. `safe_depth_bound` — `E[π](d) < 0 ⟺ d < flipRound` for the shipped
 *        `escalationOptionEv` / `deriveLadderFlipRound` pair, over the grid;
 *     2. `break_even_not_safe` — at `d = flipRound` the EV is `>= 0`, never `< 0`
 *        (the gate's contract is strict, r33-6);
 *     3. `safe_depth_bound` AGAIN, in gate form — `ladderCapWithinBound().ok`
 *        is the SIGN of the EV at the cap, which is what the theorem says the
 *        comparison `cap < flipRound` is (r33-6/r40-4);
 *     4. `derivedCap = flipRound - 1` — with the ONE parameter point where the
 *        code's `floor` differs from `flipRound - 1` pinned and explained
 *        (exact-integer boundary `>= 2`; see the KNOWN EDGE note below);
 *     5. `derivedCapZero_no_safe_depth` — `derivedCap = 0` means every legal
 *        round is unprofitable (the r33-6 clamp defect);
 *     6. `flipRound_mono_accuracy` / `flipRound_mono_bond` — the monotonicity
 *        directions r41 measured;
 *     7. `perfect_jury_all_depths_safe` — `a_f = 1` is never profitable.
 *
 *   EscalationLedger.lean
 *     8. `one_hash_one_index` / `one_index_one_hash` (r38-1);
 *     9. `round_bond_consumed_once` + `consumed_not_reused` (INV-ESC-9);
 *    10. `round_bond_not_membership` + `round_bond_not_accepted` (r33-1);
 *    11. `strict_case_has_round_bond` (R42);
 *    12. `rounds_consecutive` / `escalation_opens_next_round` / INV-ESC-8 and
 *        `log_length_bounded`;
 *    13. `reachable_wellFormed` — a LIVE history never trips the barriers
 *        (`assertValidEscalationLog` / `assertValidConfirmationLedger`), which is
 *        what "the entry matrix bites only on tampering" means operationally.
 *
 * The Quint companion (`proofs/mechanized/escalation.qnt`) models the transport;
 * its `invBinding` is instantiated at the bottom of this file.
 *
 * Companion docs: `docs/proofs/07-mechanised-escalation.tex.md` (theorems,
 * correspondence table, and the explicit NOT-mechanised list).
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
import { MAX_LADDER_ROUNDS } from '../confirmationMachineCore';
import {
  buildCourtEscalationRequest,
  escalationRequestToMachineEvent,
} from '../courtEscalationRequest';
import {
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  escalationOptionEv,
  ladderCapWithinBound,
  ladderSignBoundary,
  type LadderParameters,
} from '../ladderEconomics';
import { hexId, padHexId } from './helpers/ids';

// ─────────────────────────────────────────────────────────────────────────────
// §1–7  LadderBound.lean
// ─────────────────────────────────────────────────────────────────────────────

const ACCURACIES = [0.3, 0.45, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 1] as const;
const ECONOMIES: ReadonlyArray<{ rho: number; beta: number }> = [
  { rho: 0.03, beta: 0.03 }, // 06 §1's spec pair
  { rho: 0.03, beta: 0.05 }, // escrow.ts's 5 % bond
  { rho: 0.05, beta: 0.01 }, // reward-heavy
  { rho: 0.01, beta: 0.09 }, // bond-heavy
];
const GRID: ReadonlyArray<LadderParameters> = ACCURACIES.flatMap((a_f) =>
  ECONOMIES.map((e) => ({ a_f, ...e })),
);

const ev = (p: LadderParameters, rounds: number): number =>
  escalationOptionEv({ ...p, rounds });
const label = (p: LadderParameters): string =>
  `a_f=${p.a_f} rho=${p.rho} beta=${p.beta}`;

describe('LadderBound.lean §3 — safe_depth_bound: E[π](d) < 0 ⟺ d < flipRound', () => {
  it('holds on the whole parameter grid, for every ladder depth 0..6', () => {
    for (const p of GRID) {
      const flip = deriveLadderFlipRound(p);
      for (let d = 0; d <= MAX_LADDER_ROUNDS + 1; d += 1) {
        expect(
          { case: label(p), d, safe: ev(p, d) < 0 },
        ).toEqual({ case: label(p), d, safe: d < flip });
      }
    }
  });

  it('break_even_not_safe: at the flip round the EV is >= 0, never < 0', () => {
    for (const p of GRID) {
      const flip = deriveLadderFlipRound(p);
      if (!Number.isFinite(flip) || flip > MAX_LADDER_ROUNDS) continue;
      expect({ case: label(p), ev: ev(p, flip) >= 0 }).toEqual({ case: label(p), ev: true });
    }
  });

  it('a_f = 1 is the perfect jury: unbounded boundary, no profitable depth', () => {
    for (const e of ECONOMIES) {
      const p: LadderParameters = { a_f: 1, ...e };
      expect(ladderSignBoundary(p)).toBe(Number.POSITIVE_INFINITY);
      expect(deriveLadderFlipRound(p)).toBe(Number.POSITIVE_INFINITY);
      expect(deriveMaxLadderRounds(p)).toBe(MAX_LADDER_ROUNDS);
      for (let d = 0; d <= MAX_LADDER_ROUNDS; d += 1) expect(ev(p, d)).toBeLessThan(0);
    }
  });
});

describe('LadderBound.lean §3 — the gate is the SIGN, not the cap comparison', () => {
  it('ladderCapWithinBound().ok ⟺ E[π](cap) < 0, for every cap in 1..MAX', () => {
    for (const p of GRID) {
      for (let cap = 1; cap <= MAX_LADDER_ROUNDS; cap += 1) {
        const verdict = ladderCapWithinBound({ ...p, maxLadderRounds: cap });
        expect({ case: label(p), cap, ok: verdict.ok })
          .toEqual({ case: label(p), cap, ok: ev(p, cap) < 0 });
        // …and that is the same comparison the theorem names.
        expect(verdict.ok).toBe(cap < verdict.flipRound);
      }
    }
  });
});

describe('LadderBound.lean §4 — derivedCap and the "no safe depth" corollary', () => {
  it('derivedCap = flipRound - 1, except at an exact-integer boundary >= 2', () => {
    for (const p of GRID) {
      const flip = deriveLadderFlipRound(p);
      const cap = deriveMaxLadderRounds(p);
      const boundary = ladderSignBoundary(p);
      const exactIntegerEdge = Number.isInteger(boundary) && boundary >= 2;
      if (exactIntegerEdge) continue; // pinned separately below
      expect({ case: label(p), cap }).toEqual({
        case: label(p),
        cap: Math.min(MAX_LADDER_ROUNDS, flip - 1),
      });
    }
  });

  /**
   * KNOWN EDGE (pinned, not hidden; reported to the review round).
   *
   * `deriveMaxLadderRounds` is `floor(boundary)`; `deriveLadderFlipRound` is
   * `ceil(boundary)`. They differ by one everywhere EXCEPT at an exact integer
   * boundary, where `floor = ceil`, so the exported cap names the BREAK-EVEN
   * round — the one round the theorem says is NOT safe. The GATE
   * (`ladderCapWithinBound`) is sign-based and still refuses that cap, so no
   * host that re-derives with the gate is exposed; a host that reads
   * `derivedCap` alone and treats it as "deepest safe round" over-admits by one.
   * The mechanised statement is `derivedCap = flipRound - 1`, so this edge is a
   * code↔model disagreement of exactly one round, at a measure-zero parameter
   * point (a_f = 0.5, β = 3ρ reproduces it with plain floats).
   */
  it('KNOWN EDGE: at an exact-integer boundary >= 2 the cap equals break-even, and the gate refuses it', () => {
    const edges: LadderParameters[] = [
      { a_f: 0.5, rho: 0.03, beta: 0.09 }, // boundary 2
      { a_f: 0.5, rho: 0.03, beta: 0.21 }, // boundary 3
    ];
    for (const p of edges) {
      expect(ladderSignBoundary(p)).toBe(Math.round(ladderSignBoundary(p)));
      const cap = deriveMaxLadderRounds(p);
      expect(cap).toBe(ladderSignBoundary(p));
      // The cap is the break-even round: EV is exactly 0 there, not negative.
      expect(ev(p, cap)).toBeGreaterThanOrEqual(0);
      // The gate the host actually applies still refuses it.
      expect(ladderCapWithinBound({ ...p, maxLadderRounds: cap }).ok).toBe(false);
      // …and the deepest genuinely-safe round is one less.
      expect(Math.min(MAX_LADDER_ROUNDS, deriveLadderFlipRound(p) - 1)).toBe(cap - 1);
    }
  });

  it('derivedCapZero_no_safe_depth: cap 0 ⟹ every legal round is unprofitable', () => {
    const noSafeDepth: LadderParameters[] = [
      { a_f: 0.4, rho: 0.03, beta: 0.03 }, // boundary < 1
      { a_f: 0.5, rho: 0.03, beta: 0.03 }, // boundary exactly 1: break-even at round 1
      { a_f: 0.3, rho: 0.05, beta: 0.01 },
    ];
    for (const p of noSafeDepth) {
      expect({ case: label(p), cap: deriveMaxLadderRounds(p) }).toEqual({ case: label(p), cap: 0 });
      for (let d = 1; d <= MAX_LADDER_ROUNDS; d += 1) {
        expect({ case: label(p), d, safe: ev(p, d) < 0 }).toEqual({ case: label(p), d, safe: false });
      }
      // The old clamp (cap 1) blessed a profitable ladder; the gate refuses it.
      expect(ladderCapWithinBound({ ...p, maxLadderRounds: 1 }).ok).toBe(false);
    }
  });

  it('flipRound_mono_accuracy / _mono_bond: a better jury or a bigger bond may only deepen the cap', () => {
    for (const e of ECONOMIES) {
      const accuracies = ACCURACIES.filter((a) => a < 1);
      for (let i = 1; i < accuracies.length; i += 1) {
        const lo: LadderParameters = { a_f: accuracies[i - 1], ...e };
        const hi: LadderParameters = { a_f: accuracies[i], ...e };
        expect(deriveLadderFlipRound(lo)).toBeLessThanOrEqual(deriveLadderFlipRound(hi));
      }
      for (let i = 1; i < ECONOMIES.length; i += 1) {
        const weak: LadderParameters = { a_f: 0.8, rho: ECONOMIES[i - 1].rho, beta: ECONOMIES[i - 1].beta };
        const strong: LadderParameters = { a_f: 0.8, rho: ECONOMIES[i].rho, beta: ECONOMIES[i].beta };
        if (weak.beta > strong.beta) continue; // only the same-direction pairs
        expect(deriveLadderFlipRound(weak)).toBeLessThanOrEqual(deriveLadderFlipRound(strong));
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8–13  EscalationLedger.lean — the ledger theorems on the real reducer
// ─────────────────────────────────────────────────────────────────────────────

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;
const BOND_TXID = hexId('d');
const BOND_PROOF = hexId('e'); // juror 2's MEMBERSHIP bond
const OTHER_BOND_PROOF = hexId('f'); // juror 3's MEMBERSHIP bond
const PUBKEY = hexId('7');
const REQUEST = hexId('8');
const roundBond = (r: number): string => padHexId(`a${r}`);

/** A challenged case parked at `round_resolved` after round 1. */
function resolvedRoundOne(
  opts: { maxLadderRounds?: number; requireRoundBond?: boolean } = {},
): CourtConfirmationMachineState {
  return resolvedWithChallenges([2], opts);
}

/**
 * The same, but with every juror in `challengers` having an accepted challenge
 * bond — the state r33-1 needs to be probed (a per-round bond must not be ANY
 * accepted challenge bond, not merely the challenger's own).
 */
function resolvedWithChallenges(
  challengers: readonly number[],
  opts: { maxLadderRounds?: number; requireRoundBond?: boolean } = {},
): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: opts.maxLadderRounds ?? 3,
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
  for (const idx of challengers) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx,
      bondTxid: padHexId(`d${idx}`),
      bondProofHash: idx === 2 ? BOND_PROOF : idx === 3 ? OTHER_BOND_PROOF : padHexId(`e${idx}`),
      eventId: padHexId(`c${idx}`),
      now: 1500 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  s = openRound(s, 1, 3000, 2100);
  return reduceCourtConfirmationMachine(
    reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 3000 }),
    { type: 'resolve_round', now: 3100 },
  );
}

function openRound(
  s: CourtConfirmationMachineState,
  round: number,
  voteDeadline: number,
  now: number,
): CourtConfirmationMachineState {
  let next = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round, voteDeadline, now });
  for (const idx of ROSTER) {
    next = reduceCourtConfirmationMachine(next, {
      type: 'accept_mass_vote',
      idx,
      outcome: 'NO',
      eventId: padHexId(`${round}b${idx}`),
      now: now + 10 + idx,
    });
  }
  return next;
}

/** Escalate one rung and drive it back to `round_resolved`. */
function advance(
  s: CourtConfirmationMachineState,
  at: number,
  roundBondProofHash?: string,
): CourtConfirmationMachineState {
  const escalated = reduceCourtConfirmationMachine(s, escalate(s, at, {}, roundBondProofHash));
  const round = escalated.ladderRound + 1;
  return reduceCourtConfirmationMachine(
    reduceCourtConfirmationMachine(
      openRound(escalated, round, at + 1000, at + 10),
      { type: 'close_ladder_round', now: at + 1000 },
    ),
    { type: 'resolve_round', now: at + 1100 },
  );
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

const message = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO THROW';
  } catch (error) {
    return error instanceof CourtConfirmationTransitionError ? error.message : `WRONG TYPE ${String(error)}`;
  }
};

describe('EscalationLedger.lean §7 — one_hash_one_index (r38-1)', () => {
  it('a bond witness is bound to at most one challenger', () => {
    const windowed = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [...ROSTER],
      confirmDeadline: 1000,
      challengeDeadline: 2000,
      maxLadderRounds: 3,
    });
    let w = windowed;
    for (const idx of ROSTER) {
      w = reduceCourtConfirmationMachine(w, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: padHexId(`c${idx}`),
        now: 100 + idx,
      });
    }
    w = reduceCourtConfirmationMachine(w, { type: 'close_confirmations', now: 1000 });
    w = reduceCourtConfirmationMachine(w, { type: 'open_challenge_window', now: 1100 });
    w = reduceCourtConfirmationMachine(w, {
      type: 'accept_challenge',
      idx: 2,
      bondTxid: BOND_TXID,
      bondProofHash: BOND_PROOF,
      eventId: padHexId('c2'),
      now: 1500,
    });
    expect(
      message(() => reduceCourtConfirmationMachine(w, {
        type: 'accept_challenge',
        idx: 3,
        bondTxid: BOND_TXID,
        bondProofHash: BOND_PROOF, // the SAME witness
        eventId: padHexId('c3'),
        now: 1600,
      })),
    ).toMatch(/one bond witness buys one challenger/);
  });

  it('an escalation cannot borrow a bond posted by another juror', () => {
    const s = resolvedRoundOne();
    expect(
      message(() => reduceCourtConfirmationMachine(s, escalate(s, 3200, {
        challengerIdx: 3, // juror 3 never bonded…
        bondProofHash: BOND_PROOF, // …and is quoting juror 2's bond
      }))),
    ).toMatch(/does not match an accepted challenge bond of this challenger/);
  });
});

describe('EscalationLedger.lean §7 — round_bond_consumed_once / consumed_not_reused (INV-ESC-9)', () => {
  it('a consumed per-round bond cannot pay for a later rung', () => {
    const s1 = advance(resolvedRoundOne(), 3200, roundBond(2));
    expect(s1.escalationLog.map((r) => r.roundBondProofHash)).toEqual([roundBond(2)]);
    expect(s1.ladderRound).toBe(2);
    expect(
      message(() => reduceCourtConfirmationMachine(s1, escalate(s1, 4600, {}, roundBond(2)))),
    ).toMatch(/already consumed by round 2/);
  });

  it('a fresh witness is accepted at every rung, and the log is append-only', () => {
    const s = advance(advance(resolvedRoundOne({ maxLadderRounds: 4 }), 3200, roundBond(2)), 4600, roundBond(3));
    expect(s.escalationLog.map((r) => [r.round, r.roundBondProofHash])).toEqual([
      [2, roundBond(2)],
      [3, roundBond(3)],
    ]);
  });

  it('round_bond_not_membership: the challenger\u2019s OWN bond is not a payment', () => {
    const s = resolvedRoundOne();
    expect(
      message(() => reduceCourtConfirmationMachine(s, escalate(s, 3200, {}, BOND_PROOF))),
    ).toMatch(/must be distinct from the membership/);
  });

  it('round_bond_not_accepted: ANOTHER juror\u2019s accepted bond is not a payment either', () => {
    // Two challengers: juror 2 bonded BOND_PROOF, juror 3 bonded OTHER_BOND_PROOF.
    const s = resolvedWithChallenges([2, 3]);
    expect(s.challenges.map((c) => c.bondProofHash).sort()).toEqual(
      [BOND_PROOF, OTHER_BOND_PROOF].sort(),
    );
    expect(
      message(() => reduceCourtConfirmationMachine(s, escalate(s, 3200, {}, OTHER_BOND_PROOF))),
    ).toMatch(/accepted challenge \(membership\) bond|must be distinct from the membership/);
  });
});

describe('EscalationLedger.lean §7 — strict_case_has_round_bond (R42)', () => {
  it('a strict case refuses a legacy witness with no per-round bond', () => {
    const s = resolvedRoundOne({ requireRoundBond: true });
    expect(
      message(() => reduceCourtConfirmationMachine(s, escalate(s, 3200))),
    ).toMatch(/requires a per-round bond witness/);
  });

  it('a legacy case (requireRoundBond false) still accepts one', () => {
    const s = resolvedRoundOne({ requireRoundBond: false });
    const next = reduceCourtConfirmationMachine(s, escalate(s, 3200));
    expect(next.escalationLog).toHaveLength(1);
    expect(next.escalationLog[0].roundBondProofHash).toBeNull();
  });
});

describe('EscalationLedger.lean §7 — rounds_consecutive / escalation_opens_next_round (INV-ESC-8)', () => {
  it('log rounds are a consecutive 2..k sequence, one per escalation', () => {
    let s = resolvedRoundOne({ maxLadderRounds: 5 });
    s = advance(s, 3200, roundBond(2));
    s = advance(s, 4600, roundBond(3));
    s = advance(s, 6000, roundBond(4));
    expect(s.escalationLog.map((r) => r.round)).toEqual([2, 3, 4]);
    expect(s.ladderRound).toBe(4);
    // Every rung was opened by exactly the round the ledger names.
    expect(s.escalationLog.every((r, i) => r.round === i + 2)).toBe(true);
  });

  it('a rung may not be opened out of order', () => {
    const s = resolvedRoundOne();
    // A pending record for round 2 exists, but the round opened must be 2.
    const pending = reduceCourtConfirmationMachine(s, escalate(s, 3200, {}, roundBond(2)));
    expect(pending.phase).toBe('ladder_pending');
    expect(
      message(() => reduceCourtConfirmationMachine(pending, {
        type: 'open_ladder_round', round: 3, voteDeadline: 5000, now: 3300,
      })),
    ).toMatch(/ladder rounds must be consecutive/);
  });

  it('log_length_bounded: the log never exceeds MAX_LADDER_ROUNDS', () => {
    let s = resolvedRoundOne({ maxLadderRounds: MAX_LADDER_ROUNDS });
    let at = 3200;
    for (let r = 2; r <= MAX_LADDER_ROUNDS; r += 1) {
      s = advance(s, at, roundBond(r));
      at += 1400;
    }
    expect(s.escalationLog).toHaveLength(MAX_LADDER_ROUNDS - 1);
    expect(s.ladderRound).toBe(MAX_LADDER_ROUNDS);
    // The final rung settles fees directly, so there is no round left to open.
    expect(s.phase).toBe('fee_settlement');
    expect(
      message(() => reduceCourtConfirmationMachine(s, escalate(s, at, {}, roundBond(9)))),
    ).toMatch(/cannot escalate during fee_settlement|already reached|exceeds the 5-round ladder bound/);
  });
});

describe('EscalationLedger.lean §6 — reachable_wellFormed: live histories never trip a barrier', () => {
  it('a fully driven strict case finalizes without a ledger-barrier refusal', () => {
    let s = resolvedRoundOne({ maxLadderRounds: 2, requireRoundBond: true });
    s = advance(s, 3200, roundBond(2));
    expect(s.phase).toBe('fee_settlement'); // the last rung settles fees directly
    s = reduceCourtConfirmationMachine(s, {
      type: 'record_fee', feeEventId: padHexId('ff'), now: 4800,
    });
    const fin = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 4900 });
    expect(fin.phase).toBe('final');
    expect(fin.escalationLog).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §14  escalation.qnt — invBinding, on the shipped mapper
// ─────────────────────────────────────────────────────────────────────────────

describe('escalation.qnt — invBinding: the recorded claims agree with the HOST binding (r8-2)', () => {
  const CASE = 'court:r46-mechanised:1';
  const binding = { caseId: CASE, authenticatedPubkey: PUBKEY } as const;
  // r9-2: the mapper binds the request's `bondTxid` to the accepted challenge
  // that carries the membership witness — the fixture's challenge is juror 2's,
  // txid `d2…`.
  const challengeTxid = padHexId('d2');
  const request = buildCourtEscalationRequest({
    caseId: CASE,
    round: 1,
    challengerPubkey: PUBKEY,
    bondTxid: challengeTxid,
    bondProofHash: BOND_PROOF,
    roundBondProofHash: roundBond(2),
    eventId: padHexId('9'),
    signedAtSec: 1_790_000_000,
  });

  it('accepts the bound request and derives roundIndex from the CASE', () => {
    const s = resolvedRoundOne();
    const event = escalationRequestToMachineEvent(s, request, 3200, binding);
    expect(event.roundIndex).toBe(s.ladderRound + 1);
    expect(event.challengerIdx).toBe(2); // the bond owner, never the wire
    const next = reduceCourtConfirmationMachine(s, event);
    // The recorded escalation's claims agree with the binding (invBinding).
    expect(next.escalationLog[0].challengerPubkey).toBe(binding.authenticatedPubkey);
    expect(next.escalationLog[0].round).toBe(2);
  });

  it('refuses a request that disagrees with the binding (case, pubkey, round)', () => {
    const s = resolvedRoundOne();
    expect(
      message(() => escalationRequestToMachineEvent(
        s, buildCourtEscalationRequest({ ...request, caseId: 'court:someone-else' }), 3200, binding,
      )),
    ).toMatch(/must not cross cases/);
    expect(
      message(() => escalationRequestToMachineEvent(
        s, buildCourtEscalationRequest({ ...request, challengerPubkey: hexId('3') }), 3200, binding,
      )),
    ).toMatch(/not the pubkey the request authenticated as/);
    expect(
      message(() => escalationRequestToMachineEvent(
        s, buildCourtEscalationRequest({ ...request, round: 2 }), 3200, binding,
      )),
    ).toMatch(/signed to escalate past round/);
    // r9-2 (round 9): the request hash would commit to a bond txid the case
    // never bound, so the mapper refuses it too.
    expect(
      message(() => escalationRequestToMachineEvent(
        s, buildCourtEscalationRequest({ ...request, bondTxid: BOND_TXID }), 3200, binding,
      )),
    ).toMatch(/the request hash would commit to a bond this case never bound/);
    // …and a missing binding is itself a refusal (r8-2).
    expect(
      message(() => escalationRequestToMachineEvent(
        s, request, 3200, undefined as unknown as typeof binding,
      )),
    ).toMatch(/binding is required/);
  });
});
