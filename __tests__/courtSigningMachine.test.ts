// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';

import {
  CourtSigningTransitionError,
  createCourtSigningMachine,
  hashCourtSigningSession,
  reduceCourtSigningMachine,
  type CourtSigningMachineState,
} from '../courtSigningMachine';

const SESSION = '11'.repeat(32);
const VERDICT = '22'.repeat(32);
const DEADLINE = 500;

// Nonce points must decode to real secp256k1 curve points (the machine now
// validates on-curve membership), so derive distinct compressed points from
// the generator instead of using arbitrary hex.
const BINDER = (n: string) => secp256k1.Point.BASE.multiply(BigInt(`0x${n}`)).toHex(true);
const HIDDEN = (n: string) => secp256k1.Point.BASE.multiply(BigInt(`0x${n}`) + 100n).toHex(true);
const PSIG = (n: string) => n.repeat(32);
const SIGNATURE = 'ab'.repeat(64);
const ATTESTATION_EVENT = '99'.repeat(32);

function create(overrides?: Partial<Parameters<typeof createCourtSigningMachine>[0]>) {
  return createCourtSigningMachine({
    sessionHash: SESSION,
    verdictHash: VERDICT,
    outcome: 'yes',
    participantIndices: [1, 2, 3],
    threshold: 2,
    attempt: 0,
    deadline: DEADLINE,
    ...overrides,
  });
}

function commit(idx: number, tag: string) {
  return {
    type: 'accept_commitment' as const,
    idx,
    binderPn: BINDER(tag),
    hiddenPn: HIDDEN(tag),
    now: 100,
  };
}

function started(): CourtSigningMachineState {
  return reduceCourtSigningMachine(create(), { type: 'start', now: 50 });
}

function finalized(): CourtSigningMachineState {
  let state = started();
  state = reduceCourtSigningMachine(state, commit(1, 'a1'));
  state = reduceCourtSigningMachine(state, commit(2, 'a2'));
  state = reduceCourtSigningMachine(state, commit(3, 'a3'));
  return reduceCourtSigningMachine(state, { type: 'close_commitments', now: 120 });
}

describe('Court signing state machine', () => {
  it('runs the full attempt to a published attestation', () => {
    let state = finalized();
    expect(state.phase).toBe('commitment_set_final');
    expect(state.finalizedSignerSet).toEqual([1, 2, 3]);

    state = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 });
    expect(state.phase).toBe('partial_sign');
    state = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 2, psig: PSIG('c2'), now: 210 });

    expect(() =>
      reduceCourtSigningMachine(state, { type: 'publish', attestationEventId: ATTESTATION_EVENT, now: 220 }),
    ).toThrow(/cannot publish/);

    state = reduceCourtSigningMachine(state, { type: 'aggregate', signature: SIGNATURE, now: 230 });
    expect(state.phase).toBe('aggregate');
    state = reduceCourtSigningMachine(state, { type: 'publish', attestationEventId: ATTESTATION_EVENT, now: 240 });
    expect(state).toMatchObject({ phase: 'attestation_published', attestationEventId: ATTESTATION_EVENT });
  });

  it('allows exactly one nonce commitment per signer and attempt', () => {
    let state = started();
    state = reduceCourtSigningMachine(state, commit(1, 'a1'));

    const repeated = reduceCourtSigningMachine(state, commit(1, 'a1'));
    expect(repeated.commitments).toHaveLength(1);

    const conflicted = reduceCourtSigningMachine(state, commit(1, 'b1'));
    expect(conflicted).toMatchObject({
      phase: 'aborted_peer',
      failure: { phase: 'aborted_peer', blamedIdx: 1 },
    });
  });

  it('accepts partial signatures only from the finalized commitment set', () => {
    let state = started();
    state = reduceCourtSigningMachine(state, commit(1, 'a1'));
    state = reduceCourtSigningMachine(state, commit(2, 'a2'));
    state = reduceCourtSigningMachine(state, { type: 'close_commitments', now: 120 });

    expect(() =>
      reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 3, psig: PSIG('c3'), now: 200 }),
    ).toThrow(/finalized commitment set/);

    expect(() =>
      reduceCourtSigningMachine(state, { type: 'aggregate', signature: SIGNATURE, now: 200 }),
    ).toThrow(/below threshold/);
  });

  it('aborts with blame on conflicting partial signatures', () => {
    let state = finalized();
    state = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 200 });
    const repeated = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('c1'), now: 201 });
    expect(repeated.partials).toHaveLength(1);

    const conflicted = reduceCourtSigningMachine(state, { type: 'accept_partial', idx: 1, psig: PSIG('d1'), now: 202 });
    expect(conflicted).toMatchObject({
      phase: 'aborted_peer',
      failure: { phase: 'aborted_peer', blamedIdx: 1 },
    });
  });

  it('binds the signing session hash to every attempt parameter', () => {
    const base = create();
    expect(base.signingSessionHash).toBe(
      hashCourtSigningSession({
        sessionHash: SESSION,
        verdictHash: VERDICT,
        outcome: 'yes',
        participantIndices: [1, 2, 3],
        threshold: 2,
        attempt: 0,
      }),
    );
    const variants = [
      create({ outcome: 'no' }),
      create({ verdictHash: '33'.repeat(32) }),
      create({ sessionHash: '44'.repeat(32) }),
      create({ attempt: 1 }),
      create({ threshold: 3 }),
      create({ participantIndices: [1, 2, 3, 4], threshold: 2 }),
    ];
    for (const variant of variants) {
      expect(variant.signingSessionHash).not.toBe(base.signingSessionHash);
    }
  });

  it('cannot finalize a commitment set below threshold', () => {
    let state = started();
    state = reduceCourtSigningMachine(state, commit(1, 'a1'));
    expect(() =>
      reduceCourtSigningMachine(state, { type: 'close_commitments', now: 120 }),
    ).toThrow(/below threshold/);
  });

  it('expires without publishing and rejects out-of-roster signers', () => {
    const state = started();
    expect(() => reduceCourtSigningMachine(state, commit(4, 'a4'))).toThrow(/outside the certified roster/);

    const expired = reduceCourtSigningMachine(state, { type: 'tick', now: DEADLINE });
    expect(expired.phase).toBe('expired');
    expect(expired.signature).toBeUndefined();
    expect(() =>
      reduceCourtSigningMachine(expired, { type: 'aggregate', signature: SIGNATURE, now: DEADLINE + 1 }),
    ).toThrow(CourtSigningTransitionError);
  });

  // V12 audit: an abort event may only inject reducer-defined failure phases.
  it('rejects abort events with a non-failure phase', () => {
    const state = started();
    expect(() => reduceCourtSigningMachine(state, {
      type: 'abort', phase: 'aggregate' as never, reason: 'forged',
    })).toThrow(/invalid signing abort phase/);
    expect(() => reduceCourtSigningMachine(state, {
      type: 'abort', phase: 'intent' as never, reason: 'forged',
    })).toThrow(/invalid signing abort phase/);
  });

  // V12 audit: restored or hand-crafted state with duplicate or off-curve
  // commitment records must fail closed instead of inflating the threshold.
  it('rejects restored state with duplicate or malformed commitment records', () => {
    const base = started();
    const duplicated = {
      ...base,
      commitments: [
        { idx: 1, binderPn: BINDER('a1'), hiddenPn: HIDDEN('a1') },
        { idx: 1, binderPn: BINDER('a1'), hiddenPn: HIDDEN('a1') },
      ],
    };
    expect(() => reduceCourtSigningMachine(duplicated, { type: 'tick', now: 60 })).toThrow(
      /duplicate stored nonce commitment/,
    );

    const offCurve = {
      ...base,
      commitments: [{ idx: 1, binderPn: `02${'11'.repeat(32)}`, hiddenPn: HIDDEN('a1') }],
    };
    expect(() => reduceCourtSigningMachine(offCurve, { type: 'tick', now: 60 })).toThrow(
      /malformed nonce commitment/,
    );
  });
});
