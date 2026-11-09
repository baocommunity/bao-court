// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round-3 property-sweep findings — regression locks (v0.9.1).
 *
 * One test per fixed finding; the fuller scenario coverage lives in the
 * property/adversarial suites whose pinned assertions this round updated:
 *
 *   r3-1  finalize over a restored EMPTY confirmation ledger escaped the
 *         vote machine's FOREIGN CourtVoteTransitionError (empty
 *         supportingEventIds reach hashCourtVerdict) — now a fail-closed,
 *         typed CourtConfirmationTransitionError at finalize.
 *   r3-2  verifyCaseInBatch escaped a raw TypeError on a tags-less event
 *         once the proof leaf matched — event shape is now validated BEFORE
 *         leaf work, answering the module's typed { valid, reason }.
 *   r3-3  validateCourtAttestation dereferenced event.tags unguarded in the
 *         shape dispatch — now a typed { valid, error } invalid result.
 *   r3-6  challenged cases on a 2-member case roster could never resolve
 *         (round-panel default = case roster; ledger barrier demands ≥ 3) —
 *         now fail-closed at CREATION (roster ≥ 3 always).
 *   r3-5  hashSignerSetRoot threw plain Error — now the typed
 *         CourtSignerSetError (messages unchanged).
 *   r3-4  (observation, docstring-only in validator.ts — no runtime change,
 *         therefore no test here).
 */

import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CanonicalWriter } from '../courtSession';
import { hashCourtVerdict } from '../courtVoteMachine';
import {
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  CourtConfirmationTransitionError,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { verifyCaseInBatch, BATCH_LEAF_DOMAIN } from '../batchAttestation';
import { validateCourtAttestation, hashSignerSetRoot, CourtSignerSetError } from '../validator';
import type { Event as NostrEvent } from 'nostr-tools/pure';

// ─── helpers ────────────────────────────────────────────────────────────────

const HEX_DIGITS = '0123456789abcdef';
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const hex32 = (r: () => number): string =>
  Array.from({ length: 64 }, () => HEX_DIGITS[Math.floor(r() * 16)]).join('');

const BASE = 1_750_000_000;

function confirmedCase(r: () => number, roster: readonly number[]): CourtConfirmationMachineState {
  let state = createCourtConfirmationMachine({
    sessionHash: hex32(r),
    proposalHash: hex32(r),
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...roster],
    confirmQuorum: 1,
    confirmDeadline: BASE + 100,
    challengeDeadline: BASE + 200,
  });
  const idx = roster[0]!;
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_confirmation',
    idx,
    confirmHash: hashCourtConfirmation({ sessionHash: state.sessionHash, proposalHash: state.proposalHash, idx }),
    eventId: hex32(r),
    now: BASE,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: BASE + 100 });
  state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: BASE + 100 });
  return reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: BASE + 200 });
}

// ─── the regressions ────────────────────────────────────────────────────────

describe('round-3 findings (v0.9.1) — regression locks', () => {
  it('r3-1: finalize over a restored EMPTY confirmation ledger throws the CONFIRMATION machine\'s typed error, not a foreign CourtVoteTransitionError', () => {
    const r = mulberry32(301);
    // Live paths cannot reach this state (close_confirmations enforces the
    // quorum); a hand-restored snapshot can — the restore path is guarded
    // fail-closed at finalize.
    const feeSettlement = confirmedCase(r, [1, 2, 3]);
    expect(feeSettlement.phase).toBe('fee_settlement');
    const restored = { ...feeSettlement, confirmations: [] } as CourtConfirmationMachineState;
    let thrown: unknown;
    try {
      reduceCourtConfirmationMachine(restored, { type: 'finalize', now: BASE + 200 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CourtConfirmationTransitionError);
    expect((thrown as Error).message).toMatch(/zero supporting event ids/);
    // And a healthy finalize right after still works (the failed finalize
    // left the pre-finalize snapshot untouched).
    const healthy = reduceCourtConfirmationMachine(feeSettlement, { type: 'finalize', now: BASE + 200 });
    expect(healthy.phase).toBe('final');
    expect(healthy.verdict?.supportingEventIds.length).toBe(1);
  });

  it('r3-2: verifyCaseInBatch validates the event shape BEFORE leaf work — a tags-less event with a matching leaf answers { valid:false, reason } (no TypeError)', () => {
    const caseInput = { sessionHash: 'aa'.repeat(32), outcome: 'x', supportingEventIds: ['bb'.repeat(32)] };
    const verdictHash = hashCourtVerdict(caseInput);
    const writer = new CanonicalWriter();
    writer.u8(0x00);
    writer.hex(verdictHash);
    const prefix = new TextEncoder().encode(BATCH_LEAF_DOMAIN);
    const body = writer.finish();
    const input = new Uint8Array(prefix.length + body.length);
    input.set(prefix, 0);
    input.set(body, prefix.length);
    const leaf = bytesToHex(sha256(input));
    // The leaf matches, so the OLD code proceeded to uniqueTag() and crashed.
    const result = verifyCaseInBatch(
      { kind: 39018 } as unknown as NostrEvent,
      { ...caseInput, proof: { index: 0, verdictHash: leaf, path: [] } },
    );
    expect(result).toEqual({ valid: false, reason: 'malformed event' });
  });

  it('r3-3: validateCourtAttestation guards event.tags in the shape dispatch — a tags-less event is a typed invalid, not a raw TypeError', () => {
    const result = validateCourtAttestation({ kind: 89 } as unknown as NostrEvent);
    expect(result).toEqual({ valid: false, pubkey: '', error: 'Malformed event: tags must be an array' });
  });

  it('r3-6: createCourtConfirmationMachine rejects a participant roster smaller than 3 (typed error, fail-closed at creation)', () => {
    const r = mulberry32(306);
    for (const roster of [[], [1], [1, 2]]) {
      expect(() =>
        createCourtConfirmationMachine({
          sessionHash: hex32(r),
          proposalHash: hex32(r),
          proposedOutcome: 'YES',
          allowedOutcomes: ['YES', 'NO'],
          participantIndices: roster,
          confirmQuorum: 1,
          confirmDeadline: BASE + 100,
          challengeDeadline: BASE + 200,
        }),
      ).toThrow(CourtConfirmationTransitionError);
    }
    // Exactly 3 members is the minimum the challenge path can resolve.
    expect(() =>
      createCourtConfirmationMachine({
        sessionHash: hex32(r),
        proposalHash: hex32(r),
        proposedOutcome: 'YES',
        allowedOutcomes: ['YES', 'NO'],
        participantIndices: [1, 2, 3],
        confirmQuorum: 1,
        confirmDeadline: BASE + 100,
        challengeDeadline: BASE + 200,
      }),
    ).not.toThrow();
  });

  it('r3-5: hashSignerSetRoot throws the typed CourtSignerSetError (messages unchanged)', () => {
    expect(() => hashSignerSetRoot([])).toThrow(CourtSignerSetError);
    expect(() => hashSignerSetRoot([])).toThrow(/signer set must contain 1\.\.10000 indices/);
    expect(() => hashSignerSetRoot([0])).toThrow(CourtSignerSetError);
    expect(() => hashSignerSetRoot([0])).toThrow(/signer indices must be positive safe integers/);
    expect(() => hashSignerSetRoot([1.5])).toThrow(CourtSignerSetError);
    expect(() => hashSignerSetRoot([1, 1, 2])).toThrow(CourtSignerSetError);
    expect(() => hashSignerSetRoot([1, 1, 2])).toThrow(/signer set must not contain duplicate indices/);
    expect(new CourtSignerSetError('probe').name).toBe('CourtSignerSetError');
    // Well-formed input still hashes (unchanged output).
    expect(hashSignerSetRoot([3, 1, 2])).toBe(hashSignerSetRoot([1, 2, 3]));
  });
});
