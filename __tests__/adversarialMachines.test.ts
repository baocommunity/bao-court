// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Adversarial-input fuzz for the pure ceremony state machines (security
 * round 1): hostile event fields, tampered/forged state objects, illegal
 * event sequences, and determinism.
 *
 * Contract under attack: every rejection is a TYPED transition error from
 * the machine's own error class — an uncaught TypeError, an wrongly accepted
 * hostile event, or an order-dependent verdict is a bug.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';

import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  CourtDkgTransitionError,
  createCourtDkgMachine,
  reduceCourtDkgMachine,
  type CourtDkgMachineEvent,
  type CourtDkgMachineState,
} from '../courtDkgMachine';
import {
  CourtSigningTransitionError,
  createCourtSigningMachine,
  reduceCourtSigningMachine,
  type CourtSigningMachineEvent,
  type CourtSigningMachineState,
} from '../courtSigningMachine';
import {
  CourtVoteTransitionError,
  createCourtVoteMachine,
  hashCourtVoteCommit,
  hashCourtVerdict,
  hashDisputeVerdict,
  reduceCourtVoteMachine,
  type CourtVoteMachineEvent,
  type CourtVoteMachineState,
} from '../courtVoteMachine';

const SESSION = '11'.repeat(32);
const OTHER_SESSION = '22'.repeat(32);
const PROPOSAL = '33'.repeat(32);
const SALT = 'aa'.repeat(32);
const DEADLINE = 500;

const hexId = (prefix: string): string => prefix.padEnd(64, '0');

/** Dispatch a sequence, returning the final state (first throw propagates). */
function run<S, E>(
  state: S,
  events: readonly E[],
  reduce: (state: S, event: E) => S,
): S {
  let current = state;
  for (const event of events) current = reduce(current, event);
  return current;
}

/** Expect a typed transition error (or no throw); never an untyped crash. */
function expectTypedOrOk(fn: () => unknown, ErrorCtor: new (m: string) => Error): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ErrorCtor);
  }
}

// ---------------------------------------------------------------------------
// Vote machine helpers
// ---------------------------------------------------------------------------

function voteMachine(allowedOutcomes: string[] = ['YES', 'NO'], roster: number[] = [1, 2, 3]) {
  return createCourtVoteMachine({
    sessionHash: SESSION,
    participantIndices: roster,
    allowedOutcomes,
    commitDeadline: 100,
    revealDeadline: 200,
  });
}

const voteCommit = (idx: number, outcome: string, salt = SALT) => ({
  type: 'accept_commit' as const,
  idx,
  commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome, salt }),
  eventId: hexId(`c${idx}0`),
  now: 10 + idx,
});

const voteReveal = (idx: number, outcome: string, salt = SALT) => ({
  type: 'accept_reveal' as const,
  idx,
  outcome,
  salt,
  eventId: hexId(`a${idx}0`),
  now: 150 + idx,
});

function voteClosedReveals(outcomes: string[]): CourtVoteMachineState {
  let state = voteMachine(['YES', 'NO', ...outcomes.filter((o) => o !== 'YES' && o !== 'NO')]);
  outcomes.forEach((outcome, offset) => {
    state = reduceCourtVoteMachine(state, voteCommit(offset + 1, outcome));
  });
  state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 100 });
  state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 101 });
  outcomes.forEach((outcome, offset) => {
    state = reduceCourtVoteMachine(state, voteReveal(offset + 1, outcome));
  });
  state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: 200 });
  return state;
}

// ---------------------------------------------------------------------------
// Signing machine helpers
// ---------------------------------------------------------------------------

const BINDER = (tag: string) =>
  secp256k1.Point.BASE.multiply(BigInt(`0x${tag}${'0'.repeat(62)}`)).toHex(true);
const HIDDEN = (tag: string) =>
  secp256k1.Point.BASE.multiply(BigInt(`0x${tag}${'0'.repeat(62)}`) + 100n).toHex(true);
const PSIG = (tag: string) => tag.repeat(32);

function signingMachine() {
  return createCourtSigningMachine({
    sessionHash: SESSION,
    verdictHash: PROPOSAL,
    outcome: 'yes',
    participantIndices: [1, 2, 3],
    threshold: 2,
    attempt: 0,
    deadline: DEADLINE,
  });
}

const signCommit = (idx: number, tag: string) => ({
  type: 'accept_commitment' as const,
  idx,
  binderPn: BINDER(tag),
  hiddenPn: HIDDEN(tag),
  now: 100 + idx,
});

function signingFinalized(): CourtSigningMachineState {
  let state = reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 });
  state = reduceCourtSigningMachine(state, signCommit(1, 'a1'));
  state = reduceCourtSigningMachine(state, signCommit(2, 'a2'));
  state = reduceCourtSigningMachine(state, signCommit(3, 'a3'));
  return reduceCourtSigningMachine(state, { type: 'close_commitments', now: 120 });
}

// ---------------------------------------------------------------------------
// DKG machine helpers
// ---------------------------------------------------------------------------

function dkgMachine() {
  return createCourtDkgMachine({
    sessionHash: SESSION,
    participantIndices: [1, 2],
    deadline: 1000,
  });
}

function dkgAt(phase: CourtDkgMachineState['phase']): CourtDkgMachineState {
  let state = dkgMachine();
  if (phase === 'parameters_confirmed') return state;
  state = reduceCourtDkgMachine(state, { type: 'start', now: 50 });
  if (phase === 'dkg_round_1') return state;
  state = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx: 1, now: 60 });
  state = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx: 2, now: 61 });
  if (phase === 'dkg_round_2') return state;
  state = reduceCourtDkgMachine(state, { type: 'accept_round_2', idx: 1, now: 70 });
  state = reduceCourtDkgMachine(state, { type: 'accept_round_2', idx: 2, now: 71 });
  state = reduceCourtDkgMachine(state, {
    type: 'finalize_transcript',
    transcriptHash: '44'.repeat(32),
    candidateGroupPubkey: 'ab'.repeat(32),
    now: 80,
  });
  if (phase === 'transcript_signing') return state;
  state = reduceCourtDkgMachine(state, { type: 'accept_certification', idx: 1, transcriptHash: '44'.repeat(32), now: 90 });
  state = reduceCourtDkgMachine(state, { type: 'accept_certification', idx: 2, transcriptHash: '44'.repeat(32), now: 91 });
  if (phase === 'certified') return state;
  state = reduceCourtDkgMachine(state, { type: 'confirm_backup', now: 95 });
  return state; // backed_up
}

// ---------------------------------------------------------------------------
// Confirmation machine helpers
// ---------------------------------------------------------------------------

function confirmationMachine(allowedOutcomes: string[] = ['YES', 'NO']) {
  return createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes,
    participantIndices: [1, 2, 3],
    confirmQuorum: 1,
    confirmDeadline: 100,
    challengeDeadline: 200,
  });
}

const confirmHash = (idx: number) =>
  hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx });

function confirmationAt(phase: CourtConfirmationMachineState['phase']): CourtConfirmationMachineState {
  let state = confirmationMachine();
  if (phase === 'confirm_open') return state;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_confirmation', idx: 1, confirmHash: confirmHash(1), eventId: hexId('f10'), now: 10,
  });
  if (phase === 'confirm_closed') {
    return reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 100 });
  }
  state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 100 });
  state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: 101 });
  if (phase === 'challenge_window') return state;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_challenge', idx: 2, bondTxid: '55'.repeat(32), bondProofHash: '66'.repeat(32), eventId: hexId('f20'), now: 150,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 200 });
  if (phase === 'ladder_pending') return state;
  state = reduceCourtConfirmationMachine(state, { type: 'open_ladder_round', round: 1, voteDeadline: 400, now: 201 });
  if (phase === 'ladder_vote_open') return state;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: hexId('f30'), now: 250,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 400 });
  if (phase === 'ladder_vote_closed') return state;
  state = reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: 401 });
  if (phase === 'fee_settlement') return state;
  return reduceCourtConfirmationMachine(state, { type: 'finalize', now: 402 }); // final
}

// ===========================================================================
// 1. Malformed event fields
// ===========================================================================

describe('adversarial: malformed event fields (vote machine)', () => {
  const hostileIdx = ['1', { valueOf: () => 1 }, [1], null, undefined, NaN, Infinity, -Infinity, 1.5, 2 ** 53];
  for (const idx of hostileIdx) {
    it(`rejects hostile idx ${String(idx === undefined ? 'undefined' : JSON.stringify(idx) ?? String(idx))} with a typed error`, () => {
      expect(() =>
        reduceCourtVoteMachine(voteMachine(), {
          ...voteCommit(2, 'YES'),
          idx: idx as never,
        }),
      ).toThrow(CourtVoteTransitionError);
    });
  }

  const hostileNow = [NaN, Infinity, -Infinity, -1, 1.5, '100', null, undefined, {}];
  for (const now of hostileNow) {
    it(`rejects hostile now ${String(now)} with a typed error`, () => {
      expect(() =>
        reduceCourtVoteMachine(voteMachine(), { type: 'close_commits', now: now as never }),
      ).toThrow(CourtVoteTransitionError);
    });
  }

  it('accepts negative-zero now for a legal transition (a valid non-negative safe integer)', () => {
    const state = reduceCourtVoteMachine(voteMachine(), {
      ...voteCommit(1, "YES"),
      now: -0,
    });
    expect(state.phase).toBe('commit_open');
    expect(state.commits).toHaveLength(1);
  });

  it('rejects negative-zero idx (aliases only 0, which is never on a 1..n roster)', () => {
    expect(() =>
      reduceCourtVoteMachine(voteMachine(), {
        ...voteCommit(1, "YES"),
        idx: -0 as never,
      }),
    ).toThrow(CourtVoteTransitionError);
  });

  const hostileHex = ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'zz'.repeat(32), 0, { hex: 'aa' }, ['aa'], null, ''];
  for (const bad of hostileHex) {
    it(`rejects hostile hex field ${String(typeof bad === 'string' ? `${bad.length}-char ${bad.slice(0, 3)}…` : JSON.stringify(bad) ?? String(bad))}`, () => {
      expect(() =>
        reduceCourtVoteMachine(voteMachine(), {
          ...voteCommit(1, 'YES'),
          commitHash: bad as never,
        }),
      ).toThrow(CourtVoteTransitionError);
      expect(() =>
        reduceCourtVoteMachine(voteMachine(), {
          ...voteCommit(1, 'YES'),
          eventId: bad as never,
        }),
      ).toThrow(CourtVoteTransitionError);
    });
  }

  it('rejects hostile salt and outcome types on reveal', () => {
    const base = voteReveal(1, 'YES');
    for (const [field, value] of [
      ['salt', 123], ['salt', 'zz'.repeat(32)], ['salt', 'aa'.repeat(63)], ['salt', null],
      ['outcome', 1], ['outcome', { o: 'YES' }], ['outcome', ['YES']], ['outcome', ''],
    ] as const) {
      expect(() =>
        reduceCourtVoteMachine(
          run(voteMachine(), [voteCommit(1, 'YES'), { type: 'close_commits', now: 100 }, { type: 'open_reveals', now: 101 }], reduceCourtVoteMachine),
          { ...base, [field]: value } as never,
        ),
      ).toThrow(CourtVoteTransitionError);
    }
  });

  it('accepts distinct unicode outcomes: zero-width, RTL override, combining, supplementary plane', () => {
    const state = voteMachine(['YES', 'NO', 'Y\u200bES', 'Y\u202EES', 'e\u0301', '\u{1F4A9}']);
    expect(state.allowedOutcomes).toHaveLength(6);
  });

  it('enforces the 256-byte outcome bound at exactly MAX and MAX+1 (multi-byte)', () => {
    expect(() => voteMachine(['YES', 'NO', '\u00e9'.repeat(128)])).not.toThrow();
    expect(() => voteMachine(['YES', 'NO', '\u00e9'.repeat(129)])).toThrow(CourtVoteTransitionError);
    expect(() => voteMachine(['YES', 'NO', 'x'.repeat(256)])).not.toThrow();
    expect(() => voteMachine(['YES', 'NO', 'x'.repeat(257)])).toThrow(CourtVoteTransitionError);
  });
});

describe('adversarial: canonical UTF-8 outcome encoding (lone surrogates)', () => {
  // Encoding replaces lone surrogates with U+FFFD: two DISTINCT strings would
  // share one canonical byte form — hash collision across distinct outcomes
  // and an order-dependent tally. They must be rejected at every boundary.
  const LONE = 'A\uD800';
  const CANON = 'A\uFFFD';

  it('rejects a lone-surrogate outcome in the vote allowlist', () => {
    expect(() => voteMachine(['YES', 'NO', LONE])).toThrow(CourtVoteTransitionError);
    expect(() => voteMachine(['YES', 'NO', CANON])).not.toThrow();
  });

  it('rejects lone-surrogate outcomes in the exported hash helpers', () => {
    expect(() => hashCourtVoteCommit({ sessionHash: SESSION, outcome: LONE, salt: SALT })).toThrow(CourtVoteTransitionError);
    expect(() => hashCourtVerdict({ sessionHash: SESSION, outcome: LONE, supportingEventIds: [hexId('e1')] })).toThrow(CourtVoteTransitionError);
    expect(() => hashDisputeVerdict({ disputeId: SESSION, outcome: LONE, supportingEventIds: [hexId('e1')] })).toThrow(CourtVoteTransitionError);
    expect(() => hashCourtVoteCommit({ sessionHash: SESSION, outcome: CANON, salt: SALT })).not.toThrow();
  });

  it('rejects a lone-surrogate outcome in the confirmation allowlist and proposed outcome', () => {
    expect(() =>
      createCourtConfirmationMachine({
        sessionHash: SESSION,
        proposalHash: PROPOSAL,
        proposedOutcome: 'YES',
        allowedOutcomes: ['YES', 'NO', LONE],
        participantIndices: [1, 2, 3],
        confirmDeadline: 100,
        challengeDeadline: 200,
      }),
    ).toThrow(CourtConfirmationTransitionError);
    expect(() =>
      createCourtConfirmationMachine({
        sessionHash: SESSION,
        proposalHash: PROPOSAL,
        proposedOutcome: `${LONE}` as never,
        allowedOutcomes: ['YES', 'NO', LONE as never],
        participantIndices: [1, 2, 3],
        confirmDeadline: 100,
        challengeDeadline: 200,
      }),
    ).toThrow(CourtConfirmationTransitionError);
  });

  it('rejects a lone-surrogate outcome in the signing machine', () => {
    expect(() =>
      createCourtSigningMachine({
        sessionHash: SESSION,
        verdictHash: PROPOSAL,
        outcome: LONE,
        participantIndices: [1, 2, 3],
        threshold: 2,
        attempt: 0,
        deadline: DEADLINE,
      }),
    ).toThrow(CourtSigningTransitionError);
  });

  it('commits and reveals a canonical (round-tripping) outcome consistently end-to-end', () => {
    let state = voteMachine(['YES', 'NO', CANON]);
    state = reduceCourtVoteMachine(state, voteCommit(1, CANON));
    state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 100 });
    state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 101 });
    state = reduceCourtVoteMachine(state, voteReveal(1, CANON));
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: 200 });
    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: 201 });
    expect(state.verdict?.outcome).toBe(CANON);
  });
});

describe('adversarial: ledger MAX boundaries (confirmation machine)', () => {
  it('accepts exactly MAX_FEES fee entries, rejects MAX+1, stays idempotent at the cap', () => {
    let state = confirmationMachine();
    for (let i = 0; i < 256; i += 1) {
      state = reduceCourtConfirmationMachine(state, {
        type: 'record_fee', feeEventId: hexId(i.toString(16).padStart(2, '0')), now: 10,
      });
    }
    expect(state.fees).toHaveLength(256);
    // Idempotent duplicate at the cap is still accepted:
    const again = reduceCourtConfirmationMachine(state, {
      type: 'record_fee', feeEventId: hexId('00'), now: 11,
    });
    expect(again.fees).toHaveLength(256);
    expect(() =>
      reduceCourtConfirmationMachine(again, { type: 'record_fee', feeEventId: hexId('abc'), now: 12 }),
    ).toThrow(/fee ledger exceeds maximum/);
  });
});

// ===========================================================================
// 2. State-object tampering
// ===========================================================================

describe('adversarial: state-object tampering (vote machine)', () => {
  function assertDeeplyFrozen(value: unknown, path: string): void {
    if (value === null || typeof value !== 'object') return;
    expect(Object.isFrozen(value), `${path} must be frozen`).toBe(true);
    for (const [key, child] of Object.entries(value)) assertDeeplyFrozen(child, `${path}.${key}`);
  }

  it('deep-freezes every returned state (configuration, ledgers, verdict, failure)', () => {
    let state = voteMachine();
    state = reduceCourtVoteMachine(state, voteCommit(1, 'YES'));
    state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 100 });
    state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 101 });
    state = reduceCourtVoteMachine(state, voteReveal(1, 'YES'));
    state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: 200 });
    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: 201 });
    assertDeeplyFrozen(state, 'state');
    const expired = reduceCourtVoteMachine(state, { type: 'tick', now: 500 });
    assertDeeplyFrozen(expired, 'expired');
    const aborted = reduceCourtVoteMachine(voteMachine(), { type: 'abort', reason: 'x' });
    assertDeeplyFrozen(aborted, 'aborted');
  });

  it('freezes survive a JSON round-trip; machine states reject in-place mutation', () => {
    let state = voteClosedReveals(['YES', 'NO']);
    state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: 201 });
    // The machine-returned snapshot is deeply frozen — mutation throws:
    expect(() => {
      (state as { phase: string }).phase = 'commit_open';
    }).toThrow();
    // A JSON round-trip yields an unfrozen plain object, but the reducer
    // re-freezes every state it returns (snapshot-friendly discipline):
    const restored: CourtVoteMachineState = JSON.parse(JSON.stringify(state));
    expect(Object.isFrozen(restored)).toBe(false);
    const reanimated = reduceCourtVoteMachine(restored, { type: 'tick', now: 202 });
    expect(Object.isFrozen(reanimated)).toBe(true);
    expect(reanimated.phase).toBe('tally_final');
  });

  it('tolerates __proto__ own-properties from JSON-parsed state without prototype pollution', () => {
    const state = voteClosedReveals(['YES', 'NO']);
    // Top-level own "__proto__" (JSON.parse defines it as an own property):
    const poisonedState = JSON.parse(
      JSON.stringify(state).replace(/\}$/, ',"__proto__":{"polluted":1}}'),
    ) as CourtVoteMachineState;
    expect(Object.hasOwn(poisonedState, '__proto__')).toBe(true);
    const next = reduceCourtVoteMachine(poisonedState, { type: 'finalize_tally', now: 201 });
    expect(next.verdict?.outcome).toBe('NO');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Reveal-level own "__proto__" is ignored by the ledger barrier, which
    // reads only the canonical fields:
    const poisonedReveal: unknown = JSON.parse(
      JSON.stringify(state.reveals[0]).replace(/\}$/, ',"__proto__":{"polluted":1}}'),
    );
    const tampered = {
      ...state,
      reveals: [poisonedReveal as CourtVoteMachineState['reveals'][number], ...state.reveals.slice(1)],
    };
    const final = reduceCourtVoteMachine(tampered, { type: 'finalize_tally', now: 202 });
    expect(final.verdict?.outcome).toBe('NO');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a spread-revived ABORTED machine re-validates its ledger at the barriers', () => {
    const aborted = reduceCourtVoteMachine(
      run(voteMachine(), [voteCommit(1, 'YES'), { type: 'close_commits', now: 100 }, { type: 'open_reveals', now: 101 }, voteReveal(1, 'YES')], reduceCourtVoteMachine),
      { type: 'abort', reason: 'host abort' },
    );
    expect(aborted.phase).toBe('aborted');
    // Consistent ledger revived into reveal_open: the barrier re-verifies and
    // finalization succeeds deterministically.
    const revived = { ...aborted, phase: 'reveal_open' as const };
    const closed = reduceCourtVoteMachine(revived, { type: 'close_reveals', now: 200 });
    const final = reduceCourtVoteMachine(closed, { type: 'finalize_tally', now: 201 });
    expect(final.verdict?.outcome).toBe('YES');
    // Tampered revival (reveal swapped for an outcome its commit never
    // covered) must be caught by the ledger barrier, not tallied:
    const swapped = reduceCourtVoteMachine(
      run(voteMachine(), [voteCommit(1, 'YES'), voteCommit(2, 'NO'), { type: 'close_commits', now: 100 }, { type: 'open_reveals', now: 101 }, voteReveal(1, 'YES')], reduceCourtVoteMachine),
      { type: 'abort', reason: 'host abort' },
    );
    const tampered = {
      ...swapped,
      phase: 'reveal_open' as const,
      reveals: [{ ...swapped.reveals[0], outcome: 'NO' }],
    };
    expect(() => reduceCourtVoteMachine(tampered, { type: 'close_reveals', now: 200 })).toThrow(
      /does not match its commit/,
    );
    // Extra injected reveal with a VALID commit but duplicate idx:
    const dup = {
      ...swapped,
      phase: 'reveal_open' as const,
      reveals: [
        ...swapped.reveals,
        { idx: 1, outcome: 'YES', salt: SALT, eventId: hexId('a90') },
      ],
    };
    expect(() => reduceCourtVoteMachine(dup, { type: 'close_reveals', now: 200 })).toThrow(
      /duplicate vote reveals/,
    );
  });

  it('commits swapped between identical-shape sessions fail closed (session-bound hashes)', () => {
    const sessionA = run(voteMachine(), [voteCommit(1, 'YES'), voteCommit(2, 'NO')], reduceCourtVoteMachine);
    // Session B builds its own legitimately session-bound commit:
    let sessionB = createCourtVoteMachine({
      sessionHash: OTHER_SESSION,
      participantIndices: [1, 2, 3],
      allowedOutcomes: ['YES', 'NO'],
      commitDeadline: 100,
      revealDeadline: 200,
    });
    sessionB = reduceCourtVoteMachine(sessionB, {
      type: 'accept_commit',
      idx: 1,
      commitHash: hashCourtVoteCommit({ sessionHash: OTHER_SESSION, outcome: 'YES', salt: SALT }),
      eventId: hexId('cb10'),
      now: 10,
    });
    // Swap session A's commits into session B (identical ledger shape) after
    // B has opened its reveal window:
    const openedB = run(sessionB, [
      { type: 'close_commits', now: 100 },
      { type: 'open_reveals', now: 101 },
    ], reduceCourtVoteMachine);
    const swapped = { ...openedB, commits: sessionA.commits };
    // A reveal consistent with session B's OWN commit no longer verifies —
    // the stored commit hash is bound to the other session:
    expect(() =>
      reduceCourtVoteMachine(swapped, voteReveal(1, 'YES')),
    ).toThrow(/does not match its commit/);
    // And the ledger barrier catches the swap when a reveal (valid for
    // session B's own commit) is tallied against the transplanted ledger:
    const swappedWithReveal = {
      ...openedB,
      commits: sessionA.commits,
      reveals: [{ idx: 1, outcome: 'YES', salt: SALT, eventId: hexId('ab1') }],
    };
    expect(() =>
      reduceCourtVoteMachine(swappedWithReveal, { type: 'close_reveals', now: 200 }),
    ).toThrow(/does not match its commit/);
  });

  it('reveals reordered (and commits reordered) produce the identical verdict', () => {
    const tally = (order: number[]) => {
      let s = voteMachine();
      order.forEach((idx, offset) => {
        s = reduceCourtVoteMachine(s, { ...voteCommit(idx, idx === 1 ? 'YES' : 'NO'), now: 10 + offset });
      });
      s = reduceCourtVoteMachine(s, { type: 'close_commits', now: 100 });
      s = reduceCourtVoteMachine(s, { type: 'open_reveals', now: 101 });
      order.forEach((idx, offset) => {
        s = reduceCourtVoteMachine(s, { ...voteReveal(idx, idx === 1 ? 'YES' : 'NO'), now: 150 + offset });
      });
      s = reduceCourtVoteMachine(s, { type: 'close_reveals', now: 200 });
      return reduceCourtVoteMachine(s, { type: 'finalize_tally', now: 201 });
    };
    const forward = tally([1, 2, 3]);
    const backward = tally([3, 2, 1]);
    expect(forward.verdict?.outcome).toBe(backward.verdict?.outcome);
    expect(forward.verdict?.verdictHash).toBe(backward.verdict?.verdictHash);
    expect([...forward.verdict?.supportingEventIds ?? []]).toEqual([...backward.verdict?.supportingEventIds ?? []]);
    expect(forward.verdict?.verdictHash).toBe(hashCourtVerdict({
      sessionHash: SESSION,
      outcome: 'NO',
      supportingEventIds: [hexId('a20'), hexId('a30')],
    }));
  });

  it('a STRING allowlist cannot admit substring outcomes ("YES".includes("Y"))', () => {
    let state = voteMachine();
    // The juror's commit is honestly computed for 'Y' — accept_commit does not
    // (and cannot) know the ballot shape — so the only barrier is the
    // allowlist check. A tampered string allowlist used to admit 'Y'.
    const yCommit = hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'Y', salt: SALT });
    state = reduceCourtVoteMachine(state, { ...voteCommit(1, 'YES'), commitHash: yCommit });
    state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 100 });
    state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 101 });
    const tampered = { ...state, allowedOutcomes: 'YES' as never };
    expect(() =>
      reduceCourtVoteMachine(tampered, { ...voteReveal(1, 'YES'), outcome: 'Y' } as never),
    ).toThrow(CourtVoteTransitionError);
  });

  it('tampered non-array configuration fails closed instead of crashing untyped', () => {
    const state = voteClosedReveals(['YES', 'NO']);
    for (const field of ['participantIndices', 'allowedOutcomes', 'commits', 'reveals'] as const) {
      expect(() =>
        reduceCourtVoteMachine({ ...state, [field]: null } as never, { type: 'tick', now: 201 }),
      ).toThrow(CourtVoteTransitionError);
      expect(() =>
        reduceCourtVoteMachine({ ...state, [field]: 'YES' } as never, { type: 'tick', now: 201 }),
      ).toThrow(CourtVoteTransitionError);
    }
  });

  it('null/undefined/non-object EVENTS fail closed instead of crashing untyped', () => {
    for (const event of [null, undefined, 'tick', 42]) {
      expect(() =>
        reduceCourtVoteMachine(voteMachine(), event as never),
      ).toThrow(CourtVoteTransitionError);
    }
  });

  it('unknown event types fail closed instead of returning an unfrozen state', () => {
    expect(() =>
      reduceCourtVoteMachine(voteMachine(), { type: 'strike', now: 5 } as never),
    ).toThrow(/unknown vote event type/);
    // And no state escapes the reducer at all on an unknown type:
    let escaped: unknown = 'returned';
    try {
      escaped = reduceCourtVoteMachine(voteMachine(), { type: 'strike', now: 5 } as never);
    } catch {
      escaped = 'threw';
    }
    expect(escaped).toBe('threw');
  });
});

describe('adversarial: state-object tampering (confirmation machine)', () => {
  it('deep-freezes every returned state', () => {
    const state = confirmationAt('final');
    expect(Object.isFrozen(state)).toBe(true);
    for (const array of [state.confirmations, state.challenges, state.fees, state.clawbackFlags, state.allowedOutcomes, state.participantIndices]) {
      expect(Object.isFrozen(array)).toBe(true);
    }
    expect(Object.isFrozen(state.verdict)).toBe(true);
    expect(Object.isFrozen(state.verdict?.supportingEventIds)).toBe(true);
    expect(Object.isFrozen(state.ladder)).toBe(true);
    expect(Object.isFrozen(state.ladder?.votes)).toBe(true);
  });

  it('tampered non-array configuration or ledgers fail closed instead of crashing untyped', () => {
    for (const field of ['participantIndices', 'allowedOutcomes', 'confirmations', 'challenges', 'fees', 'clawbackFlags'] as const) {
      expect(() =>
        reduceCourtConfirmationMachine(
          { ...confirmationAt('confirm_open'), [field]: null } as never,
          { type: 'tick', now: 50 },
        ),
      ).toThrow(CourtConfirmationTransitionError);
    }
    // Tampered ladder shapes (string ladder, non-array votes):
    expect(() =>
      reduceCourtConfirmationMachine(
        { ...confirmationAt('ladder_vote_open'), ladder: 'x' } as never,
        { type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: hexId('f30'), now: 250 },
      ),
    ).toThrow(CourtConfirmationTransitionError);
    expect(() =>
      reduceCourtConfirmationMachine(
        { ...confirmationAt('ladder_vote_open'), ladder: { round: 1, voteDeadline: 400, votes: 'x' } } as never,
        { type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: hexId('f30'), now: 250 },
      ),
    ).toThrow(CourtConfirmationTransitionError);
  });

  it('an ABORTED machine spread-revived into ladder phases hits the ledger barrier', () => {
    const aborted = reduceCourtConfirmationMachine(confirmationAt('ladder_vote_open'), {
      type: 'abort', reason: 'host abort',
    });
    expect(aborted.phase).toBe('aborted');
    // Inject a mass vote for an idx that already voted (duplicate):
    const dup = {
      ...aborted,
      phase: 'ladder_vote_open' as const,
      ladder: {
        round: 1,
        voteDeadline: 400,
        votes: [
          { idx: 1, outcome: 'NO', eventId: hexId('f30') },
          { idx: 1, outcome: 'NO', eventId: hexId('f31') },
        ],
      },
    };
    expect(() => reduceCourtConfirmationMachine(dup, { type: 'close_ladder_round', now: 400 })).toThrow(
      /duplicate mass votes/,
    );
    // Inject a vote naming an outcome outside the frozen allowlist:
    const rogue = {
      ...aborted,
      phase: 'ladder_vote_open' as const,
      ladder: { round: 1, voteDeadline: 400, votes: [{ idx: 1, outcome: 'MAYBE', eventId: hexId('f30') }] },
    };
    expect(() => reduceCourtConfirmationMachine(rogue, { type: 'close_ladder_round', now: 400 })).toThrow(
      /outside the frozen allowlist/,
    );
    // Inject a vote from a non-roster index:
    const outsider = {
      ...aborted,
      phase: 'ladder_vote_open' as const,
      ladder: { round: 1, voteDeadline: 400, votes: [{ idx: 9, outcome: 'NO', eventId: hexId('f30') }] },
    };
    expect(() => reduceCourtConfirmationMachine(outsider, { type: 'close_ladder_round', now: 400 })).toThrow(
      /outside the certified roster/,
    );
    // A consistent injected ledger (roster member, allowlisted, unique) is
    // indistinguishable from a real vote — public votes, no commit binding:
    const extra = {
      ...aborted,
      phase: 'ladder_vote_open' as const,
      ladder: {
        round: 1,
        voteDeadline: 400,
        votes: [
          { idx: 1, outcome: 'NO', eventId: hexId('f30') },
          { idx: 3, outcome: 'NO', eventId: hexId('f32') },
        ],
      },
    };
    const resolved = reduceCourtConfirmationMachine(extra, { type: 'close_ladder_round', now: 400 });
    expect(resolved.phase).toBe('ladder_vote_closed');
  });

  it('rejects a lone-surrogate outcome everywhere in the confirmation surface', () => {
    expect(() =>
      reduceCourtConfirmationMachine(
        confirmationAt('ladder_vote_open'),
        { type: 'accept_mass_vote', idx: 1, outcome: 'A\uD800', eventId: hexId('f30'), now: 250 },
      ),
    ).toThrow(CourtConfirmationTransitionError);
  });

  it('unknown event types and non-object events fail closed', () => {
    expect(() =>
      reduceCourtConfirmationMachine(confirmationMachine(), { type: 'strike', now: 5 } as never),
    ).toThrow(/unknown confirmation event type/);
    expect(() => reduceCourtConfirmationMachine(confirmationMachine(), null as never)).toThrow(
      CourtConfirmationTransitionError,
    );
  });
});

describe('adversarial: state-object tampering (signing machine)', () => {
  it('deep-freezes every returned state', () => {
    const state = signingFinalized();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.commitments)).toBe(true);
    expect(Object.isFrozen(state.commitments[0])).toBe(true);
    expect(Object.isFrozen(state.participantIndices)).toBe(true);
    expect(Object.isFrozen(state.finalizedSignerSet)).toBe(true);
    const published = reduceCourtSigningMachine(
      reduceCourtSigningMachine(
        reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
        { type: 'accept_partial', idx: 2, psig: PSIG('c2'), now: 210 },
      ),
      { type: 'aggregate', signature: 'ab'.repeat(64), now: 230 },
    );
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.failure)).toBe(true);
  });

  it('re-derives the signing session hash: tampered binding fields fail closed', () => {
    const state = signingFinalized();
    expect(() =>
      reduceCourtSigningMachine({ ...state, signingSessionHash: 'ff'.repeat(32) }, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
    ).toThrow(/does not match its signing session hash/);
    // Lowering the threshold post-hoc must not let a below-threshold aggregate:
    expect(() =>
      reduceCourtSigningMachine({ ...state, threshold: 1 } as never, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
    ).toThrow(/does not match its signing session hash/);
    // Rewriting the outcome post-hoc must not re-bind the attempt:
    expect(() =>
      reduceCourtSigningMachine({ ...state, outcome: 'no' } as never, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
    ).toThrow(/does not match its signing session hash/);
  });

  it('tampered non-array ledgers or roster fail closed (existing barrier)', () => {
    const state = signingFinalized();
    for (const field of ['commitments', 'partials', 'participantIndices'] as const) {
      expect(() =>
        reduceCourtSigningMachine({ ...state, [field]: null } as never, { type: 'tick', now: 130 }),
      ).toThrow(CourtSigningTransitionError);
    }
  });

  it('malformed core fields fail closed instead of crashing untyped', () => {
    const state = signingFinalized();
    for (const [field, value] of [
      ['sessionHash', 42], ['verdictHash', null], ['outcome', { o: 1 }], ['threshold', '2'], ['attempt', NaN],
    ] as const) {
      expect(() =>
        reduceCourtSigningMachine({ ...state, [field]: value } as never, { type: 'tick', now: 130 }),
      ).toThrow(CourtSigningTransitionError);
    }
  });

  it('non-object events and unknown event types fail closed', () => {
    const state = signingFinalized();
    expect(() => reduceCourtSigningMachine(state, null as never)).toThrow(CourtSigningTransitionError);
    expect(() => reduceCourtSigningMachine(state, { type: 'strike' } as never)).toThrow(/unknown signing event type/);
  });

  it('accepts exactly-threshold partials and rejects threshold-1', () => {
    let state = signingFinalized();
    state = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 });
    expect(() =>
      reduceCourtSigningMachine(state, { type: 'aggregate', signature: 'ab'.repeat(64), now: 210 }),
    ).toThrow(/below threshold/);
    state = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 2, psig: PSIG('c2'), now: 210 });
    expect(() =>
      reduceCourtSigningMachine(state, { type: 'aggregate', signature: 'ab'.repeat(64), now: 220 }),
    ).not.toThrow();
  });

  it('rejects hostile psig / signature / attestationEventId encodings', () => {
    let state = signingFinalized();
    state = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 });
    for (const psig of ['c'.repeat(63), 'c'.repeat(65), 'C'.repeat(64), 'zz'.repeat(32), 12, null]) {
      expect(() =>
        reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 2, psig: psig as never, now: 210 }),
      ).toThrow(CourtSigningTransitionError);
    }
    expect(() =>
      reduceCourtSigningMachine(state, { type: 'aggregate', signature: 'ab'.repeat(63), now: 210 }),
    ).toThrow(CourtSigningTransitionError);
    expect(() =>
      reduceCourtSigningMachine(state, { type: 'aggregate', signature: 'AB'.repeat(64), now: 210 }),
    ).toThrow(CourtSigningTransitionError);
  });

  it('rejects forged peer-blame on abort (non-roster or non-positive blamedIdx)', () => {
    const state = reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 });
    for (const blamedIdx of [99, 0, -1, -0, 1.5, NaN]) {
      expect(() =>
        reduceCourtSigningMachine(state, { type: 'abort', phase: 'aborted_peer', reason: 'x', blamedIdx: blamedIdx as never }),
      ).toThrow(CourtSigningTransitionError);
    }
  });
});

describe('adversarial: state-object tampering (DKG machine)', () => {
  it('deep-freezes every returned state', () => {
    for (const phase of ['parameters_confirmed', 'dkg_round_1', 'dkg_round_2', 'transcript_signing', 'certified', 'backed_up'] as const) {
      const state = dkgAt(phase);
      expect(Object.isFrozen(state), phase).toBe(true);
      expect(Object.isFrozen(state.participantIndices)).toBe(true);
      expect(Object.isFrozen(state.round1Participants)).toBe(true);
      expect(Object.isFrozen(state.transcriptCertifiers)).toBe(true);
    }
    const aborted = reduceCourtDkgMachine(dkgMachine(), { type: 'abort', phase: 'aborted_network', reason: 'x' });
    expect(Object.isFrozen(aborted)).toBe(true);
    expect(Object.isFrozen(aborted.failure)).toBe(true);
  });

  it('tampered non-array roster or ledgers fail closed instead of crashing untyped', () => {
    for (const field of ['participantIndices', 'round1Participants', 'round2Participants', 'transcriptCertifiers'] as const) {
      for (const value of [null, 'x', 42]) {
        expect(() =>
          reduceCourtDkgMachine({ ...dkgAt('dkg_round_1'), [field]: value } as never, { type: 'tick', now: 60 }),
        ).toThrow(CourtDkgTransitionError);
      }
    }
    // A string round1 ledger must not silently "accept" participants via
    // String.prototype.includes:
    const stringLedger = { ...dkgAt('dkg_round_1'), round1Participants: '12' as never };
    expect(() =>
      reduceCourtDkgMachine(stringLedger, { type: 'accept_round_1', idx: 1, now: 62 }),
    ).toThrow(CourtDkgTransitionError);
  });

  it('non-object events and unknown event types fail closed', () => {
    expect(() => reduceCourtDkgMachine(dkgMachine(), null as never)).toThrow(CourtDkgTransitionError);
    expect(() => reduceCourtDkgMachine(dkgMachine(), { type: 'strike' } as never)).toThrow(/unknown DKG event type/);
  });

  it('non-iterable roster fails closed at creation', () => {
    expect(() => createCourtDkgMachine({ sessionHash: SESSION, participantIndices: 5 as never, deadline: 1000 })).toThrow(
      CourtDkgTransitionError,
    );
    expect(() => createCourtVoteMachine({ sessionHash: SESSION, participantIndices: 5 as never, allowedOutcomes: ['A', 'B'], commitDeadline: 100, revealDeadline: 200 })).toThrow(
      CourtVoteTransitionError,
    );
  });
});

// ===========================================================================
// 3. Sequence legality matrix
// ===========================================================================

describe('adversarial: legality matrix — every event at every phase, typed failures only', () => {
  const VOTE_EVENTS: readonly CourtVoteMachineEvent[] = [
    { type: 'accept_commit', idx: 2, commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'NO', salt: SALT }), eventId: hexId('cc2'), now: 60 },
    { type: 'close_commits', now: 100 },
    { type: 'open_reveals', now: 110 },
    { type: 'accept_reveal', idx: 1, outcome: 'YES', salt: SALT, eventId: hexId('ab1'), now: 120 },
    { type: 'close_reveals', now: 200 },
    { type: 'finalize_tally', now: 210 },
    { type: 'tick', now: 250 },
    { type: 'abort', reason: 'fuzz' },
  ];

  const votePhases: Array<[string, CourtVoteMachineState]> = [
    ['commit_open', voteMachine()],
    ['commit_closed', run(voteMachine(), [voteCommit(1, 'YES'), { type: 'close_commits', now: 100 }], reduceCourtVoteMachine)],
    ['reveal_open', run(voteMachine(), [voteCommit(1, 'YES'), { type: 'close_commits', now: 100 }, { type: 'open_reveals', now: 101 }], reduceCourtVoteMachine)],
    ['reveal_closed', voteClosedReveals(['YES'])],
    ['tally_final', reduceCourtVoteMachine(voteClosedReveals(['YES']), { type: 'finalize_tally', now: 201 })],
    ['expired', reduceCourtVoteMachine(voteMachine(), { type: 'tick', now: 500 })],
    ['aborted', reduceCourtVoteMachine(voteMachine(), { type: 'abort', reason: 'x' })],
  ];

  for (const [phase, state] of votePhases) {
    for (const event of VOTE_EVENTS) {
      it(`vote/${phase} + ${event.type}: typed error or legal transition`, () => {
        expectTypedOrOk(() => reduceCourtVoteMachine(state, event), CourtVoteTransitionError);
      });
    }
  }

  it('vote: close_commits at deadline-1 throws, at exactly the deadline is legal, double-close throws', () => {
    expect(() => reduceCourtVoteMachine(voteMachine(), { type: 'close_commits', now: 99 })).toThrow(
      /before the commit deadline/,
    );
    const closed = reduceCourtVoteMachine(voteMachine(), { type: 'close_commits', now: 100 });
    expect(closed.phase).toBe('commit_closed');
    expect(() => reduceCourtVoteMachine(closed, { type: 'close_commits', now: 101 })).toThrow(
      /cannot close vote commits/,
    );
  });

  it('vote: close_reveals boundary — deadline-1 throws, exactly deadline legal, double-close throws', () => {
    const opened = run(voteMachine(), [voteCommit(1, 'YES'), { type: 'close_commits', now: 100 }, { type: 'open_reveals', now: 101 }], reduceCourtVoteMachine);
    expect(() => reduceCourtVoteMachine(opened, { type: 'close_reveals', now: 199 })).toThrow(
      /before the reveal deadline/,
    );
    const closed = reduceCourtVoteMachine(opened, { type: 'close_reveals', now: 200 });
    expect(() => reduceCourtVoteMachine(closed, { type: 'close_reveals', now: 201 })).toThrow(
      /cannot close vote reveals/,
    );
  });

  it('vote: tick at deadline-1 is a no-op, at the deadline expires; tick on a terminal phase is a frozen no-op', () => {
    const opened = run(voteMachine(), [voteCommit(1, 'YES'), { type: 'close_commits', now: 100 }, { type: 'open_reveals', now: 101 }], reduceCourtVoteMachine);
    expect(reduceCourtVoteMachine(opened, { type: 'tick', now: 199 }).phase).toBe('reveal_open');
    expect(reduceCourtVoteMachine(opened, { type: 'tick', now: 200 }).phase).toBe('expired');
    const aborted = reduceCourtVoteMachine(voteMachine(), { type: 'abort', reason: 'x' });
    const ticked = reduceCourtVoteMachine(aborted, { type: 'tick', now: 10 });
    expect(ticked.phase).toBe('aborted');
    expect(Object.isFrozen(ticked)).toBe(true);
  });

  it('vote: every non-tick event after abort/expired/tally_final is rejected', () => {
    for (const terminal of [
      reduceCourtVoteMachine(voteMachine(), { type: 'abort', reason: 'x' }),
      reduceCourtVoteMachine(voteMachine(), { type: 'tick', now: 500 }),
      reduceCourtVoteMachine(voteClosedReveals(['YES']), { type: 'finalize_tally', now: 201 }),
    ]) {
      for (const event of VOTE_EVENTS.filter((e) => e.type !== 'tick')) {
        expect(() => reduceCourtVoteMachine(terminal, event)).toThrow(CourtVoteTransitionError);
      }
    }
  });

  const DKG_EVENTS: readonly CourtDkgMachineEvent[] = [
    { type: 'start', now: 500 },
    { type: 'accept_round_1', idx: 1, now: 500 },
    { type: 'accept_round_2', idx: 1, now: 500 },
    { type: 'finalize_transcript', transcriptHash: '44'.repeat(32), candidateGroupPubkey: 'ab'.repeat(32), now: 500 },
    { type: 'accept_certification', idx: 1, transcriptHash: '44'.repeat(32), now: 500 },
    { type: 'confirm_backup', now: 500 },
    { type: 'tick', now: 500 },
    { type: 'abort', phase: 'aborted_peer', reason: 'fuzz' },
  ];

  const dkgPhases: Array<[string, CourtDkgMachineState]> = [
    ['parameters_confirmed', dkgMachine()],
    ['dkg_round_1', dkgAt('dkg_round_1')],
    ['dkg_round_2', dkgAt('dkg_round_2')],
    ['transcript_signing', dkgAt('transcript_signing')],
    ['certified', dkgAt('certified')],
    ['backed_up', dkgAt('backed_up')],
    ['expired', reduceCourtDkgMachine(dkgMachine(), { type: 'tick', now: 1500 })],
    ['aborted_peer', reduceCourtDkgMachine(dkgMachine(), { type: 'abort', phase: 'aborted_peer', reason: 'x' })],
  ];

  for (const [phase, state] of dkgPhases) {
    for (const event of DKG_EVENTS) {
      it(`dkg/${phase} + ${event.type}: typed error or legal transition`, () => {
        expectTypedOrOk(() => reduceCourtDkgMachine(state, event), CourtDkgTransitionError);
      });
    }
  }

  it('dkg: finalize_transcript at deadline-1 legal, at deadline throws; certified is tick-exempt', () => {
    // Complete round 2 (all participants) but do not finalize yet:
    let ready = dkgAt('dkg_round_2');
    ready = reduceCourtDkgMachine(ready, { type: 'accept_round_2', idx: 1, now: 70 });
    ready = reduceCourtDkgMachine(ready, { type: 'accept_round_2', idx: 2, now: 71 });
    expect(() =>
      reduceCourtDkgMachine(ready, { type: 'finalize_transcript', transcriptHash: '44'.repeat(32), candidateGroupPubkey: 'ab'.repeat(32), now: 999 }),
    ).not.toThrow();
    let ready2 = dkgAt('dkg_round_2');
    ready2 = reduceCourtDkgMachine(ready2, { type: 'accept_round_2', idx: 1, now: 70 });
    ready2 = reduceCourtDkgMachine(ready2, { type: 'accept_round_2', idx: 2, now: 71 });
    expect(() =>
      reduceCourtDkgMachine(ready2, { type: 'finalize_transcript', transcriptHash: '44'.repeat(32), candidateGroupPubkey: 'ab'.repeat(32), now: 1000 }),
    ).toThrow(/DKG message arrived at or after the ceremony deadline/);
    const certified = dkgAt('certified');
    expect(reduceCourtDkgMachine(certified, { type: 'tick', now: 1500 }).phase).toBe('certified');
    // A certified machine is never stranded: confirm_backup ignores the clock.
    expect(reduceCourtDkgMachine(certified, { type: 'confirm_backup', now: 1500 }).phase).toBe('backed_up');
    expect(() => reduceCourtDkgMachine(dkgAt('backed_up'), { type: 'confirm_backup', now: 1501 })).toThrow(
      /cannot process confirm_backup/,
    );
  });

  it('dkg: abort is legal in every non-terminal phase, double-abort throws, invalid abort phases rejected', () => {
    for (const phase of ['parameters_confirmed', 'dkg_round_1', 'dkg_round_2', 'transcript_signing'] as const) {
      const aborted = reduceCourtDkgMachine(dkgAt(phase), { type: 'abort', phase: 'aborted_network', reason: 'x' });
      expect(aborted.phase).toBe('aborted_network');
      expect(() =>
        reduceCourtDkgMachine(aborted, { type: 'abort', phase: 'aborted_network', reason: 'x' }),
      ).toThrow(/cannot abort DKG/);
    }
    for (const bogus of ['certified', 'dkg_round_1', 'backed_up', 'nope'] as never[]) {
      expect(() =>
        reduceCourtDkgMachine(dkgMachine(), { type: 'abort', phase: bogus, reason: 'x' }),
      ).toThrow(/invalid DKG abort phase/);
    }
  });

  const SIGNING_EVENTS: readonly CourtSigningMachineEvent[] = [
    { type: 'start', now: 300 },
    { type: 'accept_commitment', idx: 3, binderPn: BINDER('b3'), hiddenPn: HIDDEN('b3'), now: 300 },
    { type: 'close_commitments', now: 300 },
    { type: 'accept_partial', idx: 3, psig: PSIG('c3'), now: 300 },
    { type: 'aggregate', signature: 'ab'.repeat(64), now: 300 },
    { type: 'publish', attestationEventId: '99'.repeat(32), now: 300 },
    { type: 'tick', now: 300 },
    { type: 'abort', phase: 'aborted_coordinator', reason: 'fuzz' },
  ];

  const signingPhases: Array<[string, CourtSigningMachineState]> = [
    ['intent', signingMachine()],
    ['nonce_commit', reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 })],
    ['commitment_set_final', signingFinalized()],
    [
      'partial_sign',
      reduceCourtSigningMachine(signingFinalized(), { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
    ],
    [
      'aggregate',
      reduceCourtSigningMachine(
        reduceCourtSigningMachine(
          reduceCourtSigningMachine(signingFinalized(), { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
          { type: 'accept_partial', idx: 2, psig: PSIG('c2'), now: 210 },
        ),
        { type: 'aggregate', signature: 'ab'.repeat(64), now: 230 },
      ),
    ],
    [
      'attestation_published',
      reduceCourtSigningMachine(
        reduceCourtSigningMachine(
          reduceCourtSigningMachine(
            reduceCourtSigningMachine(signingFinalized(), { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 }),
            { type: 'accept_partial', idx: 2, psig: PSIG('c2'), now: 210 },
          ),
          { type: 'aggregate', signature: 'ab'.repeat(64), now: 230 },
        ),
        { type: 'publish', attestationEventId: '99'.repeat(32), now: 240 },
      ),
    ],
    ['expired', reduceCourtSigningMachine(signingMachine(), { type: 'tick', now: DEADLINE })],
    ['aborted_peer', reduceCourtSigningMachine(signingMachine(), { type: 'abort', phase: 'aborted_peer', reason: 'x' })],
  ];

  for (const [phase, state] of signingPhases) {
    for (const event of SIGNING_EVENTS) {
      it(`signing/${phase} + ${event.type}: typed error or legal transition`, () => {
        expectTypedOrOk(() => reduceCourtSigningMachine(state, event), CourtSigningTransitionError);
      });
    }
  }

  it('signing: tick at deadline-1 no-op, at deadline expires; tick on terminal phases is a no-op', () => {
    const state = reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 });
    expect(reduceCourtSigningMachine(state, { type: 'tick', now: DEADLINE - 1 }).phase).toBe('nonce_commit');
    expect(reduceCourtSigningMachine(state, { type: 'tick', now: DEADLINE }).phase).toBe('expired');
    const aborted = reduceCourtSigningMachine(state, { type: 'abort', phase: 'aborted_peer', reason: 'x' });
    expect(reduceCourtSigningMachine(aborted, { type: 'tick', now: 60 }).phase).toBe('aborted_peer');
    expect(() =>
      reduceCourtSigningMachine(aborted, { type: 'abort', phase: 'aborted_peer', reason: 'x' }),
    ).toThrow(/cannot abort signing/);
  });

  const CONFIRMATION_EVENTS: readonly CourtConfirmationMachineEvent[] = [
    { type: 'accept_confirmation', idx: 2, confirmHash: confirmHash(2), eventId: hexId('f12'), now: 50 },
    { type: 'close_confirmations', now: 100 },
    { type: 'open_challenge_window', now: 110 },
    { type: 'accept_challenge', idx: 2, bondTxid: '55'.repeat(32), bondProofHash: '66'.repeat(32), eventId: hexId('f22'), now: 150 },
    { type: 'close_challenge_window', now: 200 },
    { type: 'open_ladder_round', round: 1, voteDeadline: 400, now: 210 },
    { type: 'accept_mass_vote', idx: 2, outcome: 'NO', eventId: hexId('f32'), now: 250 },
    { type: 'close_ladder_round', now: 400 },
    { type: 'resolve_round', now: 410 },
    { type: 'record_fee', feeEventId: hexId('fe1'), now: 420 },
    { type: 'flag_clawback', idx: 1, reason: 'fuzz', now: 430 },
    { type: 'finalize', now: 440 },
    { type: 'tick', now: 450 },
    { type: 'abort', reason: 'fuzz' },
  ];

  const confirmationPhases: Array<[string, CourtConfirmationMachineState]> = [
    ['confirm_open', confirmationMachine()],
    ['confirm_closed', confirmationAt('confirm_closed')],
    ['challenge_window', confirmationAt('challenge_window')],
    ['ladder_pending', confirmationAt('ladder_pending')],
    ['ladder_vote_open', confirmationAt('ladder_vote_open')],
    ['ladder_vote_closed', confirmationAt('ladder_vote_closed')],
    ['fee_settlement', confirmationAt('fee_settlement')],
    ['final', confirmationAt('final')],
    ['expired', reduceCourtConfirmationMachine(confirmationMachine(), { type: 'tick', now: 500 })],
    ['aborted', reduceCourtConfirmationMachine(confirmationMachine(), { type: 'abort', reason: 'x' })],
  ];

  for (const [phase, state] of confirmationPhases) {
    for (const event of CONFIRMATION_EVENTS) {
      it(`confirmation/${phase} + ${event.type}: typed error or legal transition`, () => {
        expectTypedOrOk(() => reduceCourtConfirmationMachine(state, event), CourtConfirmationTransitionError);
      });
    }
  }

  it('confirmation: no-challenge path settles immediately; quorum shortfall fails closed', () => {
    let state = confirmationMachine();
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_confirmation', idx: 1, confirmHash: confirmHash(1), eventId: hexId('f10'), now: 10,
    });
    state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 100 });
    state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: 101 });
    state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 200 });
    expect(state.phase).toBe('fee_settlement');
    expect(state.verdict).toMatchObject({ outcome: 'YES', upheld: true });
    const final = reduceCourtConfirmationMachine(state, { type: 'finalize', now: 201 });
    expect(final.phase).toBe('final');
    expect(final.verdict?.supportingEventIds).toEqual([hexId('f10')]);

    // Quorum 2 with 1 confirmation: close is refused, tick expires.
    const shortQuorum = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [1, 2],
      confirmQuorum: 2,
      confirmDeadline: 100,
      challengeDeadline: 200,
    });
    const one = reduceCourtConfirmationMachine(shortQuorum, {
      type: 'accept_confirmation', idx: 1, confirmHash: confirmHash(1), eventId: hexId('f10'), now: 10,
    });
    expect(() => reduceCourtConfirmationMachine(one, { type: 'close_confirmations', now: 100 })).toThrow(
      /confirm quorum not met/,
    );
    expect(reduceCourtConfirmationMachine(one, { type: 'tick', now: 100 }).phase).toBe('expired');
  });

  it('confirmation: close_challenge_window boundary — deadline-1 throws, exactly deadline legal', () => {
    let state = confirmationAt('challenge_window');
    // Challenge first so the close lands in ladder_pending:
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_challenge', idx: 2, bondTxid: '55'.repeat(32), bondProofHash: '66'.repeat(32), eventId: hexId('f20'), now: 150,
    });
    expect(() => reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 199 })).toThrow(
      /before the challenge deadline/,
    );
    state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 200 });
    expect(state.phase).toBe('ladder_pending');
  });

  it('confirmation: close_ladder_round boundary — deadline-1 throws, exactly deadline legal, double-close throws', () => {
    const opened = confirmationAt('ladder_vote_open');
    const voted = reduceCourtConfirmationMachine(opened, {
      type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: hexId('f30'), now: 250,
    });
    expect(() => reduceCourtConfirmationMachine(voted, { type: 'close_ladder_round', now: 399 })).toThrow(
      /before the round deadline/,
    );
    const closed = reduceCourtConfirmationMachine(voted, { type: 'close_ladder_round', now: 400 });
    expect(() => reduceCourtConfirmationMachine(closed, { type: 'close_ladder_round', now: 401 })).toThrow(
      /cannot close the ladder round/,
    );
  });

  it('tick/abort interleave: tick on aborted is a frozen no-op, tick(no-op) then abort legal, double abort throws', () => {
    const aborted = reduceCourtConfirmationMachine(confirmationMachine(), { type: 'abort', reason: 'x' });
    const tickedAborted = reduceCourtConfirmationMachine(aborted, { type: 'tick', now: 50 });
    expect(tickedAborted.phase).toBe('aborted');
    expect(Object.isFrozen(tickedAborted)).toBe(true);
    const opened = confirmationAt('ladder_vote_open');
    const ticked = reduceCourtConfirmationMachine(opened, { type: 'tick', now: 260 });
    expect(ticked.phase).toBe('ladder_vote_open');
    const lateAborted = reduceCourtConfirmationMachine(ticked, { type: 'abort', reason: 'x' });
    expect(lateAborted.phase).toBe('aborted');
    expect(() => reduceCourtConfirmationMachine(lateAborted, { type: 'abort', reason: 'x' })).toThrow(
      /cannot abort confirmation/,
    );
  });
});

// ===========================================================================
// 4. Determinism
// ===========================================================================

describe('adversarial: determinism', () => {
  it('the same event sequence twice produces byte-identical states', () => {
    const sequence = (): CourtVoteMachineEvent[] => [
      voteCommit(1, 'YES'),
      voteCommit(2, 'NO'),
      voteCommit(3, 'NO'),
      { type: 'close_commits', now: 100 },
      { type: 'open_reveals', now: 101 },
      voteReveal(1, 'YES'),
      voteReveal(2, 'NO'),
      voteReveal(3, 'NO'),
      { type: 'close_reveals', now: 200 },
      { type: 'finalize_tally', now: 201 },
    ];
    const first = run(voteMachine(), sequence(), reduceCourtVoteMachine);
    const second = run(voteMachine(), sequence(), reduceCourtVoteMachine);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reveal orders that should not matter produce the same verdict (tie-break is a total order)', () => {
    const tie = (order: number[], outcomes: string[]) => {
      let state = voteMachine(outcomes);
      order.forEach((idx, offset) => {
        state = reduceCourtVoteMachine(state, { ...voteCommit(idx, offset === 0 ? outcomes[0] : outcomes[1]), now: 10 + offset });
      });
      state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 100 });
      state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 101 });
      order.forEach((idx, offset) => {
        state = reduceCourtVoteMachine(state, { ...voteReveal(idx, offset === 0 ? outcomes[0] : outcomes[1]), now: 150 + offset });
      });
      state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: 200 });
      return reduceCourtVoteMachine(state, { type: 'finalize_tally', now: 201 });
    };
    // ASCII tie:
    expect(tie([1, 2], ['B', 'A']).verdict?.outcome).toBe('A');
    expect(tie([2, 1], ['B', 'A']).verdict?.outcome).toBe('A');
    // Supplementary-plane tie where UTF-16 order differs from UTF-8 order:
    expect(tie([1, 2], ['\u{1F4A9}', '\uE000']).verdict?.outcome).toBe('\uE000');
    expect(tie([2, 1], ['\u{1F4A9}', '\uE000']).verdict?.outcome).toBe('\uE000');
  });

  it('confirmation ladder: reordered mass votes resolve to the same verdict', () => {
    const ladder = (order: number[]) => {
      let state = confirmationAt('ladder_vote_open');
      order.forEach((idx, offset) => {
        state = reduceCourtConfirmationMachine(state, {
          type: 'accept_mass_vote', idx, outcome: idx === 1 ? 'YES' : 'NO', eventId: hexId(`b${idx}0`), now: 250 + offset,
        });
      });
      state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 400 });
      return reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: 401 });
    };
    const forward = ladder([1, 2, 3]);
    const backward = ladder([3, 2, 1]);
    // The ledgers record insertion order (part of the snapshot), but the
    // resolved verdict must be identical either way:
    expect(JSON.stringify(backward.verdict)).toBe(JSON.stringify(forward.verdict));
    expect(JSON.stringify(backward.clawbackFlags)).toBe(JSON.stringify(forward.clawbackFlags));
    expect(forward.verdict?.outcome).toBe('NO');
    expect(forward.verdict?.upheld).toBe(false);
    expect(forward.clawbackFlags).toEqual([{ idx: 1, reason: 'overturned_confirmation', round: 1 }]);
  });
});
