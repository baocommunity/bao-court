// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  CourtDkgTransitionError,
  createCourtDkgMachine,
  reduceCourtDkgMachine,
  type CourtDkgMachineState,
} from '../courtDkgMachine';

const SESSION = '11'.repeat(32);
const TRANSCRIPT = '22'.repeat(32);
const GROUP_KEY = `02${'33'.repeat(32)}`;

function initial(): CourtDkgMachineState {
  return createCourtDkgMachine({
    sessionHash: SESSION,
    participantIndices: [1, 2, 3],
    deadline: 200,
  });
}

function throughRound2(): CourtDkgMachineState {
  let state = reduceCourtDkgMachine(initial(), { type: 'start', now: 100 });
  for (const idx of [1, 2, 3]) {
    state = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx, now: 110 });
  }
  for (const idx of [1, 2, 3]) {
    state = reduceCourtDkgMachine(state, { type: 'accept_round_2', idx, now: 120 });
  }
  return state;
}

describe('Court DKG state machine', () => {
  it('requires every selected participant before transcript certification', () => {
    let state = throughRound2();
    expect(state.phase).toBe('dkg_round_2');
    expect(state.certifiedGroupPubkey).toBeUndefined();

    state = reduceCourtDkgMachine(state, {
      type: 'finalize_transcript',
      transcriptHash: TRANSCRIPT,
      candidateGroupPubkey: GROUP_KEY,
      now: 130,
    });
    expect(state.phase).toBe('transcript_signing');
    expect(state.candidateGroupPubkey).toBe(GROUP_KEY);
    expect(state.certifiedGroupPubkey).toBeUndefined();

    for (const idx of [1, 2]) {
      state = reduceCourtDkgMachine(state, {
        type: 'accept_certification', idx, transcriptHash: TRANSCRIPT, now: 140,
      });
      expect(state.certifiedGroupPubkey).toBeUndefined();
    }
    state = reduceCourtDkgMachine(state, {
      type: 'accept_certification', idx: 3, transcriptHash: TRANSCRIPT, now: 140,
    });
    expect(state.phase).toBe('certified');
    expect(state.certifiedGroupPubkey).toBe(GROUP_KEY);

    state = reduceCourtDkgMachine(state, { type: 'confirm_backup', now: 150 });
    expect(state).toMatchObject({ phase: 'backed_up', backupVerified: true });
  });

  it('does not treat a threshold-sized subset as DKG completion', () => {
    let state = reduceCourtDkgMachine(initial(), { type: 'start', now: 100 });
    state = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx: 1, now: 110 });
    state = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx: 2, now: 110 });

    expect(state.phase).toBe('dkg_round_1');
    expect(() => reduceCourtDkgMachine(state, {
      type: 'accept_round_2', idx: 1, now: 120,
    })).toThrow(CourtDkgTransitionError);
  });

  it('is idempotent for identical participant progress', () => {
    let state = reduceCourtDkgMachine(initial(), { type: 'start', now: 100 });
    state = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx: 1, now: 110 });
    const repeated = reduceCourtDkgMachine(state, { type: 'accept_round_1', idx: 1, now: 111 });
    expect(repeated.round1Participants).toEqual([1]);
  });

  it('aborts with blame when a participant certifies another transcript', () => {
    let state = reduceCourtDkgMachine(throughRound2(), {
      type: 'finalize_transcript',
      transcriptHash: TRANSCRIPT,
      candidateGroupPubkey: GROUP_KEY,
      now: 130,
    });
    state = reduceCourtDkgMachine(state, {
      type: 'accept_certification', idx: 2, transcriptHash: 'ff'.repeat(32), now: 140,
    });
    expect(state).toMatchObject({
      phase: 'aborted_peer',
      failure: { phase: 'aborted_peer', blamedIdx: 2 },
    });
    expect(state.certifiedGroupPubkey).toBeUndefined();
  });

  it('expires without exposing a group key', () => {
    const started = reduceCourtDkgMachine(initial(), { type: 'start', now: 100 });
    const expired = reduceCourtDkgMachine(started, { type: 'tick', now: 200 });
    expect(expired.phase).toBe('expired');
    expect(expired.certifiedGroupPubkey).toBeUndefined();
    expect(() => reduceCourtDkgMachine(expired, {
      type: 'accept_round_1', idx: 1, now: 201,
    })).toThrow(CourtDkgTransitionError);
  });

  it('rejects out-of-roster participants and invalid transitions', () => {
    const started = reduceCourtDkgMachine(initial(), { type: 'start', now: 100 });
    expect(() => reduceCourtDkgMachine(started, {
      type: 'accept_round_1', idx: 4, now: 110,
    })).toThrow(/outside the certified roster/);
    expect(() => reduceCourtDkgMachine(started, {
      type: 'finalize_transcript',
      transcriptHash: TRANSCRIPT,
      candidateGroupPubkey: GROUP_KEY,
      now: 120,
    })).toThrow(/every participant/);
    expect(() => reduceCourtDkgMachine(started, {
      type: 'confirm_backup', now: 130,
    })).toThrow(/before DKG certification/);
  });

  // V12 audit: an abort event may only inject reducer-defined failure phases —
  // a caller cannot cast an arbitrary phase into state via a forged event.
  it('rejects abort events with a non-failure phase', () => {
    const started = reduceCourtDkgMachine(initial(), { type: 'start', now: 100 });
    expect(() => reduceCourtDkgMachine(started, {
      type: 'abort', phase: 'certified' as never, reason: 'forged',
    })).toThrow(/invalid DKG abort phase/);
    expect(() => reduceCourtDkgMachine(started, {
      type: 'abort', phase: 'dkg_round_1' as never, reason: 'forged',
    })).toThrow(/invalid DKG abort phase/);
    // Valid failure phases still work.
    expect(reduceCourtDkgMachine(started, {
      type: 'abort', phase: 'aborted_network', reason: 'partition',
    }).phase).toBe('aborted_network');
  });

  // V12 audit: regex validation must not coerce non-primitive values into
  // acceptable session hashes.
  it('rejects coercible non-string session hashes', () => {
    expect(() => createCourtDkgMachine({
      sessionHash: new String(SESSION) as unknown as string,
      participantIndices: [1, 2, 3],
      deadline: 200,
    })).toThrow(CourtDkgTransitionError);
    expect(() => reduceCourtDkgMachine(initial(), {
      type: 'finalize_transcript',
      transcriptHash: new String(TRANSCRIPT) as unknown as string,
      candidateGroupPubkey: GROUP_KEY,
      now: 130,
    })).toThrow(CourtDkgTransitionError);
  });
});
