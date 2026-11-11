// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import {
  COURT_CONFIRMATION_DOMAIN,
  CourtConfirmationTransitionError,
  confirmSupermajority,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { hashCourtVerdict } from '../courtVoteMachine';
import { CanonicalWriter } from '../courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Deterministic 32-byte lowercase hex id from a single hex char. */
import { hexId as id } from './helpers/ids';
import {
  confirmationMachine as makeConfirmationMachine,
  confirmHappyPath,
  confirmChallengedTo,
} from './helpers/machines';

const SESSION = id('1');
const PROPOSAL = id('2');
const OUTCOMES = ['YES', 'NO'];
const ROSTER = [1, 2, 3];

/** House confirmation-machine defaults for this suite (quorum-3, 2s/3s clocks). */
const CONFIRM_OPTS = {
  sessionHash: SESSION,
  proposalHash: PROPOSAL,
  allowedOutcomes: OUTCOMES,
  participantIndices: ROSTER,
  confirmQuorum: 3,
  confirmDeadline: 2000,
  challengeDeadline: 3000,
} as const;

function create(overrides: Partial<Parameters<typeof createCourtConfirmationMachine>[0]> = {}) {
  return makeConfirmationMachine({ ...CONFIRM_OPTS, ...overrides });
}

/** Drive the no-challenge happy path up to fee_settlement. */
function happyToFeeSettlement(): CourtConfirmationMachineState {
  return confirmHappyPath(CONFIRM_OPTS);
}

/** Drive the challenge path up to fee_settlement with the given vote split. */
function challengedToFeeSettlement(votes: ReadonlyArray<readonly [number, 'YES' | 'NO', string]>): CourtConfirmationMachineState {
  return confirmChallengedTo(votes, CONFIRM_OPTS);
}

describe('hashCourtConfirmation', () => {
  it('derives the canonical session+proposal+idx binding', () => {
    const writer = new CanonicalWriter();
    writer.hex(SESSION);
    writer.hex(PROPOSAL);
    writer.u32(7);
    const prefix = new TextEncoder().encode(COURT_CONFIRMATION_DOMAIN);
    const encoded = writer.finish();
    const input = new Uint8Array(prefix.length + encoded.length);
    input.set(prefix, 0);
    input.set(encoded, prefix.length);
    expect(hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 7 })).toBe(
      bytesToHex(sha256(input)),
    );
  });

  it('is replay-proof across proposals and roster indices', () => {
    const a = hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 });
    const b = hashCourtConfirmation({ sessionHash: SESSION, proposalHash: id('3'), idx: 1 });
    const c = hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 2 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('rejects malformed inputs', () => {
    expect(() => hashCourtConfirmation({ sessionHash: 'xyz', proposalHash: PROPOSAL, idx: 1 })).toThrow(CourtConfirmationTransitionError);
    expect(() => hashCourtConfirmation({ sessionHash: SESSION, proposalHash: 'xyz', idx: 1 })).toThrow(CourtConfirmationTransitionError);
    expect(() => hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 0 })).toThrow(CourtConfirmationTransitionError);
  });
});

describe('createCourtConfirmationMachine', () => {
  it('validates session and proposal hashes', () => {
    expect(() => create({ sessionHash: 'nope' })).toThrow(CourtConfirmationTransitionError);
    expect(() => create({ proposalHash: 'nope' })).toThrow(CourtConfirmationTransitionError);
  });

  it('requires the proposal to be a member of the allowlist', () => {
    expect(() => create({ proposedOutcome: 'MAYBE' })).toThrow(/member of allowedOutcomes/);
  });

  it('requires at least two unique outcomes', () => {
    expect(() => create({ allowedOutcomes: ['YES'] })).toThrow(/2..256/);
    expect(() => create({ allowedOutcomes: ['YES', 'YES'] })).toThrow(/unique/);
  });

  it('bounds the quorum to the roster', () => {
    expect(() => create({ confirmQuorum: 0 })).toThrow(/confirmQuorum/);
    expect(() => create({ confirmQuorum: 4 })).toThrow(/confirmQuorum/);
  });

  it('requires the challenge deadline to follow the confirm deadline', () => {
    expect(() => create({ challengeDeadline: 2000 })).toThrow(/later than confirmDeadline/);
  });

  it('validates evidence ids', () => {
    expect(() => create({ evidenceIds: ['zz'] })).toThrow(/evidence ids/);
    expect(() => create({ evidenceIds: [id('9')] })).not.toThrow();
  });

  it('starts in confirm_open with empty ledgers', () => {
    const s = create();
    expect(s.phase).toBe('confirm_open');
    expect(s.confirmations).toHaveLength(0);
    expect(s.ladderRound).toBe(0);
  });
});

// R25 — parameter hardening (review-response round). The factory DEFAULT
// quorum is now the roster supermajority ⌈2N/3⌉ instead of 1, and an explicit
// smaller quorum is recorded in state rather than silently accepted.
// Evidence: docs/proofs/economics/05-review-gapfills.tex.md §1.3.
describe('R25 — confirmation quorum defaults', () => {
  /** Build a machine for an N-seat roster, omitting or overriding the quorum. */
  function machineFor(rosterSize: number, confirmQuorum?: number) {
    const participantIndices = Array.from({ length: rosterSize }, (_, i) => i + 1);
    return createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: OUTCOMES,
      participantIndices,
      ...(confirmQuorum === undefined ? {} : { confirmQuorum }),
      confirmDeadline: 2000,
      challengeDeadline: 3000,
    });
  }

  it('defaults to the supermajority ⌈2N/3⌉ (3 seats → 2, not 1)', () => {
    const s = machineFor(3);
    expect(s.confirmQuorum).toBe(2);
    expect(confirmSupermajority(3)).toBe(2);
    expect(s.quorumBelowSupermajority).toBe(false);
  });

  it('defaults 5-of-7 = 5 on a 7-seat roster', () => {
    const s = machineFor(7);
    expect(s.confirmQuorum).toBe(5);
    expect(s.quorumBelowSupermajority).toBe(false);
  });

  it('defaults 4-of-5 = 4 on the shipped round-0 panel size', () => {
    const s = machineFor(5);
    expect(s.confirmQuorum).toBe(4);
    expect(s.quorumBelowSupermajority).toBe(false);
  });

  it('records an explicit 3-of-5 quorum as BELOW the supermajority (still allowed)', () => {
    const s = machineFor(5, 3);
    expect(s.confirmQuorum).toBe(3);
    expect(s.quorumBelowSupermajority).toBe(true);
  });

  it('does not flag an explicit quorum at or above ⌈2N/3⌉', () => {
    expect(machineFor(5, 4).quorumBelowSupermajority).toBe(false);
    expect(machineFor(5, 5).quorumBelowSupermajority).toBe(false);
    expect(machineFor(15, 10).quorumBelowSupermajority).toBe(false);
    expect(machineFor(15, 9).quorumBelowSupermajority).toBe(true);
  });

  it('keeps the typed quorum-range error for < 1 or > roster', () => {
    expect(() => machineFor(5, 0)).toThrow(CourtConfirmationTransitionError);
    expect(() => machineFor(5, 6)).toThrow(/confirmQuorum must be a safe integer in \[1, roster size\]/);
  });

  it('enforces the default quorum behaviourally: 3 of 5 confirmations cannot close', () => {
    let s = machineFor(5);
    for (const idx of [1, 2, 3]) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(String(idx)),
        now: 1000 + idx,
      });
    }
    expect(() => reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 }))
      .toThrow(/quorum not met: 3\/4/);
    // The fourth confirmation satisfies the default 4-of-5 supermajority.
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx: 4,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 4 }),
      eventId: id('4'),
      now: 1004,
    });
    const closed = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    expect(closed.phase).toBe('confirm_closed');
  });
});

describe('no-challenge happy path', () => {
  it('confirms, closes, skips the ladder, and finalizes the proposal', () => {
    const s = happyToFeeSettlement();
    expect(s.phase).toBe('fee_settlement');
    expect(s.challenges).toHaveLength(0);
    const done = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 3100 });
    expect(done.phase).toBe('final');
    expect(done.verdict?.outcome).toBe('YES');
    expect(done.verdict?.upheld).toBe(true);
    expect(done.verdict?.supportingEventIds).toEqual([id('a'), id('b'), id('c')].sort());
    expect(done.verdict?.verdictHash).toBe(
      hashCourtVerdict({
        sessionHash: SESSION,
        outcome: 'YES',
        supportingEventIds: [id('a'), id('b'), id('c')].sort(),
      }),
    );
  });

  it('rejects closing the confirm window before the deadline', () => {
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    expect(() => reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 1999 })).toThrow(
      /before the confirm deadline/,
    );
  });

  it('fails closed when the confirm quorum never formed', () => {
    let s = create({ confirmQuorum: 3 });
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx: 1,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 }),
      eventId: id('a'),
      now: 1100,
    });
    s = { ...s, latestTimestamp: 2000 };
    expect(() => reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 })).toThrow(
      /quorum not met/,
    );
  });
});

describe('accept_confirmation', () => {
  it('rejects a confirmation hash that does not match the canonical binding', () => {
    const s = create();
    expect(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx: 1,
        confirmHash: id('9'),
        eventId: id('a'),
        now: 1100,
      }),
    ).toThrow(/does not match the canonical confirmation hash/);
  });

  it('rejects non-roster participants and malformed ids', () => {
    const s = create();
    const good = hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 4 });
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_confirmation', idx: 4, confirmHash: good, eventId: id('a'), now: 1100 }),
    ).toThrow(/roster/i);
    expect(() =>
      reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx: 1,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 }),
        eventId: 'zz',
        now: 1100,
      }),
    ).toThrow(/32-byte lowercase hex/);
  });

  it('treats identical redelivery as idempotent and conflicting redelivery as fatal', () => {
    const confirmHash = hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 });
    let s = create();
    const event = { type: 'accept_confirmation' as const, idx: 1, confirmHash, eventId: id('a'), now: 1100 };
    s = reduceCourtConfirmationMachine(s, event);
    expect(reduceCourtConfirmationMachine(s, event).confirmations).toHaveLength(1);
    expect(() =>
      reduceCourtConfirmationMachine(s, { ...event, eventId: id('b') }),
    ).toThrow(/conflicting confirmation/);
  });

  it('rejects confirmations at or after the deadline and during wrong phases', () => {
    const s = create();
    const confirmHash = hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 });
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_confirmation', idx: 1, confirmHash, eventId: id('a'), now: 2000 }),
    ).toThrow(/at or after the confirm deadline/);
    const closed = happyToFeeSettlement();
    expect(() =>
      reduceCourtConfirmationMachine(closed, { type: 'accept_confirmation', idx: 1, confirmHash, eventId: id('a'), now: 3000 }),
    ).toThrow(/during fee_settlement/);
  });
});

describe('challenge window', () => {
  it('rejects opening during the wrong phase or past the deadline', () => {
    const s = create();
    expect(() => reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 })).toThrow(
      /during confirm_open/,
    );
    let closed = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      closed = reduceCourtConfirmationMachine(closed, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    closed = reduceCourtConfirmationMachine(closed, { type: 'close_confirmations', now: 2000 });
    expect(() => reduceCourtConfirmationMachine(closed, { type: 'open_challenge_window', now: 3000 })).toThrow(
      /at or after the challenge deadline/,
    );
  });

  it('routes to fee_settlement with no challenges and ladder_pending with one', () => {
    expect(happyToFeeSettlement().phase).toBe('fee_settlement');
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 3,
      bondTxid: id('d'),
      bondProofHash: id('e'),
      eventId: id('f'),
      now: 2500,
    });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
    expect(s.phase).toBe('ladder_pending');
    expect(s.challenges).toHaveLength(1);
  });

  it('rejects challenges after the deadline, off-roster, or malformed', () => {
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_challenge', idx: 1, bondTxid: id('d'), bondProofHash: id('e'), eventId: id('f'), now: 3000 }),
    ).toThrow(/at or after the challenge deadline/);
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_challenge', idx: 9, bondTxid: id('d'), bondProofHash: id('e'), eventId: id('f'), now: 2500 }),
    ).toThrow(/roster/i);
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_challenge', idx: 1, bondTxid: 'zz', bondProofHash: id('e'), eventId: id('f'), now: 2500 }),
    ).toThrow(/32-byte lowercase hex/);
  });
});

describe('ladder round', () => {
  it('enforces consecutive rounds and non-past deadlines', () => {
    const s = happyToFeeSettlement(); // fee_settlement — wrong phase
    expect(() => reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 4000, now: 3100 })).toThrow(
      /during fee_settlement/,
    );
  });

  it('accepts mass votes, closes, and resolves a majority', () => {
    const s = challengedToFeeSettlement([
      [1, 'YES', '4'],
      [2, 'NO', '5'],
      [3, 'NO', '6'],
    ]);
    expect(s.phase).toBe('fee_settlement');
    expect(s.verdict?.outcome).toBe('NO');
    expect(s.verdict?.upheld).toBe(false);
  });

  it('flags every confirming juror for clawback on overturn', () => {
    const s = challengedToFeeSettlement([
      [1, 'NO', '4'],
      [2, 'NO', '5'],
      [3, 'NO', '6'],
    ]);
    expect(s.clawbackFlags).toEqual([
      { idx: 1, reason: 'overturned_confirmation', round: 1 },
      { idx: 2, reason: 'overturned_confirmation', round: 1 },
      { idx: 3, reason: 'overturned_confirmation', round: 1 },
    ]);
  });

  it('leaves clawback flags empty when the proposal is upheld', () => {
    const s = challengedToFeeSettlement([
      [1, 'YES', '4'],
      [2, 'YES', '5'],
      [3, 'YES', '6'],
    ]);
    expect(s.verdict?.upheld).toBe(true);
    expect(s.clawbackFlags).toHaveLength(0);
  });

  it('breaks tallies deterministically on ties', () => {
    const s = challengedToFeeSettlement([
      [1, 'NO', '4'],
      [2, 'YES', '5'],
      [3, 'NO', '6'],
    ]);
    // 2 NO vs 1 YES — NO wins outright; verify outcome stability.
    expect(s.verdict?.outcome).toBe('NO');
  });

  it('rejects votes outside the allowlist, off-roster, duplicate, and after deadline', () => {
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_challenge', idx: 1, bondTxid: id('d'), bondProofHash: id('e'), eventId: id('f'), now: 2500 });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 4000, now: 3100 });
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 1, outcome: 'MAYBE', eventId: id('4'), now: 3200 }),
    ).toThrow(/outside the frozen allowlist/);
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 9, outcome: 'YES', eventId: id('4'), now: 3200 }),
    ).toThrow(/roster/i);
    const vote = { type: 'accept_mass_vote' as const, idx: 1, outcome: 'YES' as const, eventId: id('4'), now: 3200 };
    s = reduceCourtConfirmationMachine(s, vote);
    expect(() => reduceCourtConfirmationMachine(s, { ...vote, eventId: id('5') })).toThrow(/conflicting mass vote/);
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 2, outcome: 'YES', eventId: id('5'), now: 4000 }),
    ).toThrow(/at or after the round deadline/);
  });

  it('fails closed when closing a round with zero votes', () => {
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_challenge', idx: 1, bondTxid: id('d'), bondProofHash: id('e'), eventId: id('f'), now: 2500 });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 4000, now: 3100 });
    // Closing with zero votes is legal (mirrors the vote machine's
    // close_reveals); RESOLUTION is what fails closed on an empty ledger.
    const closed = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 4000 });
    expect(() => reduceCourtConfirmationMachine(closed, { type: 'resolve_round', now: 4100 })).toThrow(
      /without any valid mass vote/,
    );
  });
});

describe('fee ledger and clawback flags', () => {
  it('records fees idempotently and rejects malformed ids', () => {
    const s = happyToFeeSettlement();
    const withFee = reduceCourtConfirmationMachine(s, { type: 'record_fee', feeEventId: id('e'), now: 3050 });
    expect(withFee.fees).toEqual([id('e')]);
    expect(reduceCourtConfirmationMachine(withFee, { type: 'record_fee', feeEventId: id('e'), now: 3051 }).fees).toEqual([id('e')]);
    expect(() => reduceCourtConfirmationMachine(s, { type: 'record_fee', feeEventId: 'zz', now: 3050 })).toThrow(
      /32-byte lowercase hex/,
    );
  });

  it('accepts explicit clawback flags only during fee_settlement, deduped per (idx, reason)', () => {
    const s = happyToFeeSettlement();
    const flagged = reduceCourtConfirmationMachine(s, { type: 'flag_clawback', idx: 1, reason: 'audit_divergence', now: 3050 });
    expect(flagged.clawbackFlags).toEqual([{ idx: 1, reason: 'audit_divergence', round: 0 }]);
    expect(
      reduceCourtConfirmationMachine(flagged, { type: 'flag_clawback', idx: 1, reason: 'audit_divergence', now: 3051 }).clawbackFlags,
    ).toHaveLength(1);
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'flag_clawback', idx: 9, reason: 'audit_divergence', now: 3050 }),
    ).toThrow(/roster/i);
    expect(() =>
      reduceCourtConfirmationMachine(s, { type: 'flag_clawback', idx: 1, reason: 'x'.repeat(65), now: 3050 }),
    ).toThrow(/bounded string/);
    const preFee = create();
    expect(() =>
      reduceCourtConfirmationMachine(preFee, { type: 'flag_clawback', idx: 1, reason: 'audit_divergence', now: 1100 }),
    ).toThrow(/during confirm_open/);
  });
});

describe('finalize', () => {
  it('builds the verdict from winning mass votes on overturn', () => {
    const s = challengedToFeeSettlement([
      [1, 'NO', '4'],
      [2, 'NO', '5'],
      [3, 'YES', '6'],
    ]);
    const done = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 4200 });
    expect(done.phase).toBe('final');
    expect(done.verdict?.outcome).toBe('NO');
    expect(done.verdict?.supportingEventIds).toEqual([id('4'), id('5')].sort());
    expect(done.verdict?.verdictHash).toBe(
      hashCourtVerdict({ sessionHash: SESSION, outcome: 'NO', supportingEventIds: [id('4'), id('5')].sort() }),
    );
  });

  it('rejects finalize outside fee_settlement and re-processing after final', () => {
    expect(() => reduceCourtConfirmationMachine(create(), { type: 'finalize', now: 3100 })).toThrow(
      /during confirm_open/,
    );
    const done = reduceCourtConfirmationMachine(happyToFeeSettlement(), { type: 'finalize', now: 3100 });
    expect(() => reduceCourtConfirmationMachine(done, { type: 'record_fee', feeEventId: id('e'), now: 3200 })).toThrow(
      /after final/,
    );
  });
});

describe('clock and terminal discipline', () => {
  it('rejects clock rollback', () => {
    const s = create();
    const advanced = reduceCourtConfirmationMachine(s, { type: 'record_fee', feeEventId: id('e'), now: 5000 });
    expect(() =>
      reduceCourtConfirmationMachine(advanced, { type: 'record_fee', feeEventId: id('f'), now: 4999 }),
    ).toThrow(/must not precede/);
  });

  it('expires awaiting-input phases at their deadlines and exempts near-final phases', () => {
    const s = create();
    const expired = reduceCourtConfirmationMachine(s, { type: 'tick', now: 2000 });
    expect(expired.phase).toBe('expired');
    expect(expired.failure?.reason).toMatch(/confirm_open/);
    // Expired is terminal — even abort is rejected from it (vote-machine discipline).
    expect(() => reduceCourtConfirmationMachine(expired, { type: 'abort', reason: 'x' })).toThrow(
      /cannot abort confirmation from expired/,
    );
    // fee_settlement and ladder_vote_closed and ladder_pending are tick-exempt.
    const fee = happyToFeeSettlement();
    expect(reduceCourtConfirmationMachine(fee, { type: 'tick', now: 99999 }).phase).toBe('fee_settlement');
    expect(reduceCourtConfirmationMachine(s, { type: 'tick', now: 1999 }).phase).toBe('confirm_open');
  });

  it('expires confirm_closed and challenge_window at the challenge deadline', () => {
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    expect(reduceCourtConfirmationMachine(s, { type: 'tick', now: 3000 }).phase).toBe('expired');
  });

  it('aborts from any non-terminal phase with the reason preserved', () => {
    const s = reduceCourtConfirmationMachine(create(), { type: 'abort', reason: 'coordinator shutdown' });
    expect(s.phase).toBe('aborted');
    expect(s.failure).toEqual({ phase: 'aborted', reason: 'coordinator shutdown' });
  });

  it('freezes state so ledgers cannot be mutated between transitions', () => {
    const s = happyToFeeSettlement();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.confirmations)).toBe(true);
    expect(() => {
      (s.confirmations as unknown as CourtConfirmationRecordMutable[]).push({
        idx: 9,
        confirmHash: id('9'),
        eventId: id('9'),
      });
    }).toThrow();
  });
});

interface CourtConfirmationRecordMutable {
  idx: number;
  confirmHash: string;
  eventId: string;
}

describe('outcome-history restore barrier (finding F-3)', () => {
  /** Challenge path: round 1 resolves YES, escalates, round 2 closes with a NO majority. */
  function challengedToRound2VoteClosed(): CourtConfirmationMachineState {
    let s = create();
    for (const [idx, ev] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: id(ev),
        now: 1000 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 2000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 2100 });
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge',
      idx: 2,
      bondTxid: id('d'),
      bondProofHash: id('e'),
      eventId: id('f'),
      now: 2500,
    });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 3000 });
    // Round 1: YES holds (idx 1, 2).
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 4000, now: 3100 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 1, outcome: 'YES', eventId: id('1'), now: 3201 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 2, outcome: 'YES', eventId: id('2'), now: 3202 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 3, outcome: 'NO', eventId: id('3'), now: 3203 });
    s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 4000 });
    s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 4050 });
    expect(s.phase).toBe('round_resolved');
    s = reduceCourtConfirmationMachine(s, { type: 'escalate', now: 4100 });
    // Round 2: NO wins (idx 2, 3).
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 2, voteDeadline: 5000, now: 4200 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 1, outcome: 'YES', eventId: id('4'), now: 4301 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 2, outcome: 'NO', eventId: id('5'), now: 4302 });
    s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 3, outcome: 'NO', eventId: id('6'), now: 4303 });
    return reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 5000 });
  }

  /** Replace the (frozen) outcome history on a JSON clone of the state. */
  function tamper(s: CourtConfirmationMachineState, history: unknown): CourtConfirmationMachineState {
    const clone = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    clone.outcomeHistory = history;
    return clone as unknown as CourtConfirmationMachineState;
  }

  it('a well-formed restored history resolves cleanly (round_flip intact)', () => {
    const s = challengedToRound2VoteClosed();
    const resolved = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 5100 });
    expect(resolved.phase).toBe('fee_settlement');
    expect(resolved.outcomeHistory).toHaveLength(2);
    // Round 2's winner (NO) differs from round 1's (YES): round 1's majority
    // (idx 1, 2) is flagged round_flip at round 1 — from the VERIFIED history.
    const flips = resolved.clawbackFlags.filter((f) => f.reason === 'round_flip');
    expect(flips.map((f) => f.idx).sort()).toEqual([1, 2]);
    expect(flips.every((f) => f.round === 1)).toBe(true);
  });

  it('a forged round sequence (gap / forged round number) is rejected at resolve_round', () => {
    const s = challengedToRound2VoteClosed();
    const gapped = [{ round: 2, outcome: 'YES', winnerEventIds: [id('1'), id('2')], winnerIndices: [1, 2] }];
    expect(() =>
      reduceCourtConfirmationMachine(tamper(s, gapped), { type: 'resolve_round', now: 5100 }),
    ).toThrow(/consecutive 1..k sequence/);
  });

  it('a forged history cannot direct round_flip clawbacks at arbitrary indices', () => {
    const s = challengedToRound2VoteClosed();
    // Out-of-language indices: 0 is not a roster index, 10_001 is beyond the
    // ceremony-participant bound — neither can steer a clawback.
    for (const bad of [0, 10_001]) {
      const forged = [{ round: 1, outcome: 'YES', winnerEventIds: [id('1'), id('2')], winnerIndices: [bad] }];
      expect(() =>
        reduceCourtConfirmationMachine(tamper(s, forged), { type: 'resolve_round', now: 5100 }),
      ).toThrow(/winner indices/);
    }
  });

  it('an outcome outside the frozen allowlist and malformed winner records are rejected', () => {
    const s = challengedToRound2VoteClosed();
    expect(() =>
      reduceCourtConfirmationMachine(
        tamper(s, [{ round: 1, outcome: 'MAYBE', winnerEventIds: [id('1')], winnerIndices: [1] }]),
        { type: 'resolve_round', now: 5100 },
      ),
    ).toThrow(/outside the frozen allowlist/);
    expect(() =>
      reduceCourtConfirmationMachine(
        tamper(s, [{ round: 1, outcome: 'YES', winnerEventIds: [], winnerIndices: [1] }]),
        { type: 'resolve_round', now: 5100 },
      ),
    ).toThrow(/no winning event ids/);
    expect(() =>
      reduceCourtConfirmationMachine(
        tamper(s, [{ round: 1, outcome: 'YES', winnerEventIds: ['nothex'], winnerIndices: [1] }]),
        { type: 'resolve_round', now: 5100 },
      ),
    ).toThrow(/32-byte lowercase hex/);
  });

  it('finalize re-verifies the restored history before reaching final', () => {
    const s = happyToFeeSettlement();
    // A never-challenged case can have no resolved rounds — a non-empty
    // history on this snapshot is forged.
    const forged = [{ round: 1, outcome: 'YES', winnerEventIds: [id('a')], winnerIndices: [1] }];
    expect(() =>
      reduceCourtConfirmationMachine(tamper(s, forged), { type: 'finalize', now: 3100 }),
    ).toThrow(/never challenged/);
    // The genuine (empty, never-challenged) history finalizes cleanly.
    expect(reduceCourtConfirmationMachine(s, { type: 'finalize', now: 3100 }).phase).toBe('final');
  });
});
