// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Review round 3 — adversarial probes against the surface the round-2 fixes
 * CREATED (docs/REVIEW_ROUND_3.md).
 *
 * The round-2 audit (`REVIEW_ROUND_2.md` (d)/N3) asked for a machine-level
 * authority witness on `escalate`; v0.12.0 shipped one. These tests attack the
 * witness rather than re-reading it:
 *
 *   - can a non-bonded juror escalate on another juror's accepted bond hash?
 *   - can a witness be replayed across rounds, or on to a case that never held
 *     the bond?
 *   - can the append-only log be inflated, or forged on a restored snapshot?
 *   - does the witness make a pre-0.12 snapshot un-restorable (or unfinalizable)?
 *   - does a finalize with an escalation in the log cite the round that decided?
 *   - can a witness be added after `final`?
 *
 * Target 2 (the derived economic cap) is host-side — the probes for it live in
 * `docs/REVIEW_ROUND_3.md` §2 with file:line evidence against `bao.markets`.
 * Target 3 (the deterministic budget) is pinned here because the helper is in
 * this repository.
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
import { MAX_LADDER_ROUNDS } from '../confirmationMachineCore';
import { budgetMs, DEFAULT_BUDGET_MS } from './helpers/budget';
import { hexId, padHexId } from './helpers/ids';

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;
const BOND_TXID = hexId('d');
const BOND_PROOF = hexId('e');
const PUBKEY = hexId('7');
const REQUEST = hexId('8');

interface CaseOpts {
  readonly maxLadderRounds?: number;
  readonly hostEscalation?: boolean;
}

/**
 * A challenged case parked at `round_resolved` after round 1 (juror 2 posted
 * the only bond; the verdict of round 1 is NO).
 */
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

/** Open the next ladder round and have every roster member vote `outcome`. */
function openRound(
  s: CourtConfirmationMachineState,
  round: number,
  voteDeadline: number,
  now: number,
  outcome: string,
): CourtConfirmationMachineState {
  let next = reduceCourtConfirmationMachine(s, {
    type: 'open_ladder_round', round, voteDeadline, now,
  });
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
  let next = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: closeAt });
  next = reduceCourtConfirmationMachine(next, { type: 'resolve_round', now: resolveAt });
  return next;
}

/** The one legal challenger escalation for this state. */
function escalate(
  s: CourtConfirmationMachineState,
  now: number,
  overrides: Record<string, unknown> = {},
): CourtConfirmationMachineEvent {
  return {
    ...challengerEscalationEvent(s, now, { challengerPubkey: PUBKEY, requestHash: REQUEST }),
    ...overrides,
  } as CourtConfirmationMachineEvent;
}

/** A crafted challenger witness — the shape a hostile host would send. */
function craftedWitness(
  s: CourtConfirmationMachineState,
  fields: { idx: number; bondProofHash: string; now?: number; roundIndex?: number },
): CourtConfirmationMachineEvent {
  return {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: fields.idx,
    challengerPubkey: PUBKEY,
    requestHash: REQUEST,
    bondProofHash: fields.bondProofHash,
    roundIndex: fields.roundIndex ?? s.ladderRound + 1,
    now: fields.now ?? 3200,
  } as CourtConfirmationMachineEvent;
}

/**
 * Drive a default case to `fee_settlement` with a real escalation in the log:
 * round 1 resolved → escalate (log [2]) → round 2 resolved → concede.
 */
function settledWithEscalation(): CourtConfirmationMachineState {
  let s = resolvedRoundOne();
  s = reduceCourtConfirmationMachine(s, escalate(s, 3200));
  s = openRound(s, 2, 4000, 3300, 'YES');
  s = closeAndResolve(s, 4000, 4100);
  expect(s.phase).toBe('round_resolved');
  expect(s.escalationLog.map((r) => r.round)).toEqual([2]);
  s = reduceCourtConfirmationMachine(s, { type: 'concede', now: 4200 });
  expect(s.phase).toBe('fee_settlement');
  return s;
}

describe('T1 the escalate witness — attacked, not re-read', () => {
  it('a juror with NO bond cannot escalate on another juror\'s accepted bond hash', () => {
    const resolved = resolvedRoundOne();
    // Juror 1 never posted a challenge; juror 2's bond IS accepted by the case.
    // A hostile host speaks the reducer directly and reuses juror 2's hash.
    const spoof = craftedWitness(resolved, { idx: 1, bondProofHash: BOND_PROOF });
    expect(() => reduceCourtConfirmationMachine(resolved, spoof)).toThrow(
      /does not match an accepted challenge bond of this challenger/,
    );
    expect(resolved.phase).toBe('round_resolved');
    expect(resolved.escalationLog).toHaveLength(0);
    // The same witness naming the bond's actual owner still works.
    const owner = craftedWitness(resolved, { idx: 2, bondProofHash: BOND_PROOF });
    expect(reduceCourtConfirmationMachine(resolved, owner).phase).toBe('ladder_pending');
  });

  it('the bonded challenger\'s own witness is still accepted (no over-correction)', () => {
    const resolved = resolvedRoundOne();
    const next = reduceCourtConfirmationMachine(resolved, escalate(resolved, 3200));
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog[0]).toMatchObject({
      round: 2, authority: 'challenger', challengerIdx: 2, bondProofHash: BOND_PROOF,
    });
  });

  it('a witness minted for round r cannot be replayed on to round r+1', () => {
    let s = resolvedRoundOne();
    const roundTwoWitness = escalate(s, 3200); // roundIndex 2
    s = reduceCourtConfirmationMachine(s, roundTwoWitness);
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    expect(s.phase).toBe('round_resolved');
    // Replaying the SAME witness: the phase guard fires first (it is not
    // round_resolved any more at the time it was consumed), and once the case
    // is parked again the roundIndex guard refuses it.
    expect(() => reduceCourtConfirmationMachine(s, { ...roundTwoWitness, now: 4200 } as CourtConfirmationMachineEvent))
      .toThrow(/does not open the next ladder round 3/);
    expect(s.escalationLog).toHaveLength(1);
  });

  it('the log cannot be inflated past the ladder bound (spam is structurally capped)', () => {
    let s = resolvedRoundOne({ maxLadderRounds: MAX_LADDER_ROUNDS });
    let at = 3200;
    for (let round = 2; round <= MAX_LADDER_ROUNDS; round += 1) {
      s = reduceCourtConfirmationMachine(s, escalate(s, at));
      expect(s.escalationLog).toHaveLength(round - 1);
      s = openRound(s, round, at + 1000, at + 100, 'YES');
      s = closeAndResolve(s, at + 1000, at + 1100);
      at += 2000;
    }
    // Round 5 == maxLadderRounds is the adjudicating round: the case settles,
    // it does not park awaiting a sixth escalation.
    expect(s.phase).toBe('fee_settlement');
    expect(s.escalationLog.map((r) => r.round)).toEqual([2, 3, 4, 5]);
    // A hand-restored log already at the structural bound is refused even if
    // the state is parked at round_resolved with cap headroom.
    const forged = {
      ...resolvedRoundOne({ maxLadderRounds: MAX_LADDER_ROUNDS }),
      escalationLog: Array.from({ length: MAX_LADDER_ROUNDS }, (_, i) => ({
        round: i + 2, authority: 'host', challengerIdx: null, challengerPubkey: null,
        requestHash: null, bondProofHash: null, at: 1000 + i,
      })),
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(forged, escalate(forged, 9000)))
      .toThrow(/escalation log exceeds/);
  });

  it('one accepted bond can fund every round of the same case (registered residual)', () => {
    // Documented, not fixed: escalation has no per-round cost, so a challenger
    // who posted ONE bond can force up to maxLadderRounds-1 additional panels
    // (3x seats each). Bounded structurally at 5 rounds; the economic answer
    // (a fresh bond per round) is a design decision, see REVIEW_ROUND_3 §1.4.
    let s = resolvedRoundOne({ maxLadderRounds: 4 });
    s = reduceCourtConfirmationMachine(s, escalate(s, 3200));
    s = openRound(s, 2, 4000, 3300, 'YES');
    s = closeAndResolve(s, 4000, 4100);
    s = reduceCourtConfirmationMachine(s, escalate(s, 4200));
    expect(s.escalationLog.map((r) => r.bondProofHash)).toEqual([BOND_PROOF, BOND_PROOF]);
  });

  it('a pre-0.12 snapshot (no escalationLog) still finalizes — legacy restore is not broken', () => {
    // `onFinalize` re-verifies the confirmation ledger and the outcome history;
    // the escalation log is normalised to [] by the reducer preamble, so a
    // legacy snapshot is not made un-restorable by the new field.
    const settled = settledWithEscalation();
    const legacy = JSON.parse(JSON.stringify(settled)) as Record<string, unknown>;
    delete legacy.escalationLog;
    const restored = legacy as unknown as CourtConfirmationMachineState;
    const finalized = reduceCourtConfirmationMachine(restored, { type: 'finalize', now: 4300 });
    expect(finalized.phase).toBe('final');
    expect(finalized.verdict?.verdictHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a forged escalation record on a restored snapshot is refused at finalize', () => {
    const settled = settledWithEscalation();
    const forged = {
      ...settled,
      escalationLog: [
        ...settled.escalationLog,
        {
          round: 3, // no round 3 was ever opened
          authority: 'challenger',
          challengerIdx: 1,
          challengerPubkey: PUBKEY,
          requestHash: REQUEST,
          bondProofHash: BOND_PROOF, // juror 1 never posted it
          at: 4200,
        },
      ],
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(forged, { type: 'finalize', now: 4300 }))
      .toThrow(CourtConfirmationTransitionError);
  });

  it('a host-authority record cannot appear on a case that never allowed it', () => {
    const settled = settledWithEscalation();
    const forged = {
      ...settled,
      escalationLog: [{
        round: 2, authority: 'host', challengerIdx: null, challengerPubkey: null,
        requestHash: null, bondProofHash: null, at: 3200,
      }],
    } as unknown as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(forged, { type: 'finalize', now: 4300 }))
      .toThrow(/host escalation/i);
  });

  it('host escalation stays break-glass: default false is frozen with the case', () => {
    const strict = resolvedRoundOne();
    expect(strict.hostEscalation).toBe(false);
    expect(() => reduceCourtConfirmationMachine(strict, hostEscalationEvent(strict, 3200)))
      .toThrow(/host escalation is not permitted/);
    // ...and the policy is only as trustworthy as the snapshot: a hand-restored
    // flip to `true` IS honoured (registered residual, REVIEW_ROUND_3 §1.5).
    const flipped = { ...strict, hostEscalation: true } as CourtConfirmationMachineState;
    expect(reduceCourtConfirmationMachine(flipped, hostEscalationEvent(flipped, 3200)).phase)
      .toBe('ladder_pending');
  });
});

describe('T4 witness × finality', () => {
  it('finalize after an escalation cites the LAST resolved round and the right votes', () => {
    const settled = settledWithEscalation();
    const finalized = reduceCourtConfirmationMachine(settled, { type: 'finalize', now: 4300 });
    expect(finalized.phase).toBe('final');
    // Round 2 decided (YES). Round 1's NO votes must not appear.
    const roundTwoWinners = ROSTER.map((idx) => padHexId(`2b${idx}`)).sort();
    expect(finalized.verdict?.outcome).toBe('YES');
    expect(finalized.verdict?.supportingEventIds).toEqual(roundTwoWinners);
    // The witness log is preserved verbatim into the final state.
    expect(finalized.escalationLog).toEqual(settled.escalationLog);
  });

  it('no witness can be added after final (terminal-phase guard)', () => {
    const settled = settledWithEscalation();
    const finalized = reduceCourtConfirmationMachine(settled, { type: 'finalize', now: 4300 });
    const before = finalized.escalationLog;
    expect(() => reduceCourtConfirmationMachine(finalized, escalate(settled, 4400) as CourtConfirmationMachineEvent))
      .toThrow(/cannot process escalate after final/);
    expect(finalized.escalationLog).toBe(before);
    expect(finalized.phase).toBe('final');
  });

  it('a refused escalation cannot abort or move the case (no griefing transition)', () => {
    const resolved = resolvedRoundOne();
    const probes: CourtConfirmationMachineEvent[] = [
      craftedWitness(resolved, { idx: 1, bondProofHash: BOND_PROOF }), // non-bonded
      escalate(resolved, 3200, { bondProofHash: hexId('9') }), // foreign bond
      escalate(resolved, 3200, { requestHash: 'not-hex' }), // malformed
    ];
    for (const probe of probes) {
      expect(() => reduceCourtConfirmationMachine(resolved, probe)).toThrow(CourtConfirmationTransitionError);
      expect(resolved.phase).toBe('round_resolved');
      expect(resolved.failure).toBeUndefined();
      expect(resolved.escalationLog).toHaveLength(0);
    }
    // The host still has a liveness exit: concede (and abort) remain reachable.
    expect(reduceCourtConfirmationMachine(resolved, { type: 'concede', now: 3200 }).phase)
      .toBe('fee_settlement');
  });
});

describe('T3 the deterministic budget helper is pinned, not trusted', () => {
  const envKey = 'REVIEW_R29_BUDGET_MS';

  const withEnv = (value: string | undefined, fn: () => void): void => {
    const previous = process.env[envKey];
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  };

  it('defaults to a FINITE 30 s ceiling when the variable is absent or junk', () => {
    // A mutation that returned Infinity (or ignored junk) would make every
    // ceiling assertion vacuous while the rest of the suite stayed green.
    withEnv(undefined, () => expect(budgetMs(envKey)).toBe(DEFAULT_BUDGET_MS));
    withEnv(undefined, () => expect(Number.isFinite(budgetMs(envKey))).toBe(true));
    expect(DEFAULT_BUDGET_MS).toBe(30_000);
    for (const junk of ['', ' ', 'abc', '0', '-1', 'NaN', 'Infinity']) {
      withEnv(junk, () => expect(budgetMs(envKey), `junk ${JSON.stringify(junk)}`).toBe(DEFAULT_BUDGET_MS));
    }
  });

  it('honours an explicit positive override (slow boxes raise it without a code edit)', () => {
    withEnv('2500', () => expect(budgetMs(envKey)).toBe(2500));
    withEnv('120000', () => expect(budgetMs(envKey)).toBe(120_000));
    // An explicit default still wins when the variable is absent.
    withEnv(undefined, () => expect(budgetMs(envKey, 7)).toBe(7));
  });

  it('the ceiling is live: the shipped budgets are generous but finite', () => {
    // Both budgeted tests (simulateCourt, adversarialNostr) assert deterministic
    // behaviour BEFORE the ceiling, so nothing passes *because* of the budget.
    // Pin the ordering property that makes them non-vacuous: 30 s is ~25x the
    // 1.2 s baseline and far below the 60 s vitest timeout, so a real 100x
    // regression trips an ASSERTION, not a timeout.
    expect(DEFAULT_BUDGET_MS).toBeGreaterThan(5_000);
    expect(DEFAULT_BUDGET_MS).toBeLessThan(60_000);
  });
});
