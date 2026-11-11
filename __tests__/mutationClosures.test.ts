// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * MUTATION-CLOSURE PINS (symposium round 21).
 *
 * Each test in this file closes a SURVIVOR found by
 * `scripts/mutation/run-mutants.mjs`: a single semantic mutation that the
 * whole spec — invariants, proofs, and 1474 tests — did not notice. A
 * surviving mutant is a spec hole, and a hole is closed by a test that fails
 * when the mutation is re-applied (verified by re-running the sweep with this
 * file in place). Method and full results: `docs/MUTATION_TESTING.md`.
 *
 * The mapping is the artifact, keep it accurate:
 *
 *   C1  M30  validator v2: signerSet.length must equal the declared threshold
 *   C2  M31  signing machine: restored finalizedSignerSet must match commitments
 *   C3  M15  resolve_round: the confirmation ledger is re-verified before clawbacks
 *   C4  M37  round_flip clawback flags are idempotent against a restored ledger
 *   C5  M07  jury selection: exact-priority ties rank by pubkey ASCENDING
 *   C6  M24  quadraticPriority clamps r = 1 (no zero-priority juror)
 *   C7  M35  batch cap: exactly MAX_BATCH_VERDICTS is legal, MAX + 1 is not
 *   C8  M47  session encoder: uppercase hex is not canonical
 *   C9  M52  batch proof index bound is index < count
 *
 * These are pins, not scenario tests: each asserts the ONE boundary the mutant
 * moved, with the smallest state that reaches it.
 */

import { describe, expect, it } from 'vitest';

import {
  hashSignerSetRoot,
  validateAttestationEventV2,
} from '../validator';
import {
  createCourtSigningMachine,
  reduceCourtSigningMachine,
  type CourtSigningMachineState,
} from '../courtSigningMachine';
import {
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { buildBatchMerkleTree, verifyCaseInBatch } from '../batchAttestation';
import { assertCourtSessionParameters } from '../courtSession';
import { hashCourtVerdict } from '../courtVoteMachine';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { quadraticPriority, deriveSelectionSeed, jurorRandomValue, selectJury } from '../selection';
import type { JurorProfile } from '../types';
import { hexId, padHexId } from './helpers/ids';
import { hostPubkey, nostrPubkey, schnorrKeypair } from './helpers/keys';
import { buildV2AttestationEvent, type V2Fields } from './helpers/fixtures';

// ─── C1 (M30): signer-set length must equal the declared threshold ─────────

describe('mutation closure C1 (M30) — v2 finality: |signerSet| must equal threshold', () => {
  const SIGNERS = [1, 2];
  // A signer set whose root IS the tag (so the root check passes) but whose
  // size (2) contradicts the declared threshold (3). Only the length check
  // can reject this event — before M30's closure nothing did.
  const fields: V2Fields = {
    marketId: 'mutation-closure-market',
    outcome: 'YES',
    round: '0',
    epochId: 21,
    tier: 0,
    threshold: 3,
    signerSetRoot: hashSignerSetRoot(SIGNERS),
  };

  it('rejects a correctly-rooted signer set that is smaller than the threshold', () => {
    const event = buildV2AttestationEvent(fields, schnorrKeypair());
    // Control: the root pin alone is satisfied by this signer set.
    expect(validateAttestationEventV2(event, { expectedSignerSetRoot: hashSignerSetRoot(SIGNERS) }).valid).toBe(true);
    const result = validateAttestationEventV2(event, { signerSet: SIGNERS });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signer set size 2 does not match threshold 3/);
  });

  it('rejects a correctly-rooted signer set that is LARGER than the threshold', () => {
    const larger = [1, 2, 3, 4];
    const event = buildV2AttestationEvent(
      { ...fields, signerSetRoot: hashSignerSetRoot(larger) },
      schnorrKeypair(),
    );
    const result = validateAttestationEventV2(event, { signerSet: larger });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signer set size 4 does not match threshold 3/);
  });
});

// ─── C2 (M31): a restored signing state re-verifies its frozen signer set ──

describe('mutation closure C2 (M31) — signing restore barrier: finalizedSignerSet ⊆ commitments', () => {
  const base = { sessionHash: '11'.repeat(32), verdictHash: '22'.repeat(32), outcome: 'YES' };

  function commitmentsFrozen(): CourtSigningMachineState {
    let state = createCourtSigningMachine({
      ...base,
      participantIndices: [1, 2, 3],
      threshold: 2,
      attempt: 1,
      deadline: 500,
    });
    state = reduceCourtSigningMachine(state, { type: 'start', now: 10 });
    state = reduceCourtSigningMachine(state, {
      type: 'accept_commitment', idx: 1, binderPn: nostrPubkey(1), hiddenPn: nostrPubkey(2), now: 20,
    });
    state = reduceCourtSigningMachine(state, {
      type: 'accept_commitment', idx: 2, binderPn: nostrPubkey(3), hiddenPn: nostrPubkey(4), now: 21,
    });
    return reduceCourtSigningMachine(state, { type: 'close_commitments', now: 30 });
  }

  it('rejects a restored signer set that is a PREFIX of the committed set', () => {
    const frozen = commitmentsFrozen();
    expect(frozen.finalizedSignerSet).toEqual([1, 2]);
    // Hand-restored snapshot: signer 2's commitment is dropped from the frozen
    // set. Every index still matches at its offset, so only the LENGTH check
    // can catch it (the mutant removed exactly that check).
    const tampered = { ...frozen, finalizedSignerSet: [1] } as CourtSigningMachineState;
    expect(() => reduceCourtSigningMachine(tampered, { type: 'tick', now: 40 })).toThrow(
      /finalized signer set does not match stored commitments/,
    );
  });

  it('rejects a restored signer set with an extra signer', () => {
    const frozen = commitmentsFrozen();
    const tampered = { ...frozen, finalizedSignerSet: [1, 2, 3] } as CourtSigningMachineState;
    expect(() => reduceCourtSigningMachine(tampered, { type: 'tick', now: 40 })).toThrow(
      /finalized signer set does not match stored commitments/,
    );
  });
});

// ─── C3 (M15) + C4 (M37): confirmation-machine ledger barriers ─────────────

const CASE = { sessionHash: '11'.repeat(32), proposalHash: '33'.repeat(32) } as const;

function confirmAt(idx: number, now: number) {
  return {
    type: 'accept_confirmation' as const,
    idx,
    confirmHash: hashCourtConfirmation({ ...CASE, idx }),
    eventId: padHexId(`c${idx}0`),
    now,
  };
}

/** Drive a challenged case to `ladder_vote_closed` for round `round`. */
function ladderCase(opts: { maxLadderRounds: number }): CourtConfirmationMachineState {
  let state = createCourtConfirmationMachine({
    ...CASE,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [1, 2, 3],
    confirmQuorum: 1,
    confirmDeadline: 100,
    challengeDeadline: 200,
    maxLadderRounds: opts.maxLadderRounds,
  });
  state = reduceCourtConfirmationMachine(state, confirmAt(1, 10));
  state = reduceCourtConfirmationMachine(state, { type: 'close_confirmations', now: 100 });
  state = reduceCourtConfirmationMachine(state, { type: 'open_challenge_window', now: 101 });
  state = reduceCourtConfirmationMachine(state, {
    type: 'accept_challenge', idx: 2, bondTxid: '55'.repeat(32), bondProofHash: '66'.repeat(32), eventId: hexId('d'), now: 150,
  });
  state = reduceCourtConfirmationMachine(state, { type: 'close_challenge_window', now: 200 });
  return reduceCourtConfirmationMachine(state, {
    type: 'open_ladder_round', round: 1, voteDeadline: 400, now: 201,
  });
}

describe('mutation closure C3 (M15) — resolve_round re-verifies the confirmation ledger', () => {
  it('refuses to resolve on a confirmation ledger whose hashes were never accepted', () => {
    let state = ladderCase({ maxLadderRounds: 1 });
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: padHexId('f30'), now: 250,
    });
    state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 400 });
    // Hand-restored snapshot: a well-formed hash that was never accepted
    // through accept_confirmation. Clawbacks derive from this ledger, so the
    // barrier must fire before resolve_round writes them.
    const tampered = {
      ...state,
      confirmations: [{ ...state.confirmations[0]!, confirmHash: 'ff'.repeat(32) }],
    } as CourtConfirmationMachineState;
    expect(() => reduceCourtConfirmationMachine(tampered, { type: 'resolve_round', now: 401 })).toThrow(
      /confirmation record for participant 1 does not match the canonical confirmation hash/,
    );
  });
});

describe('mutation closure C4 (M37) — round_flip flags stay idempotent', () => {
  it('does not duplicate a round_flip flag already present for that round', () => {
    let state = ladderCase({ maxLadderRounds: 2 });
    // Round 1: NO wins (proposal YES overturned).
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: padHexId('f31'), now: 250,
    });
    state = reduceCourtConfirmationMachine(state, {
      type: 'accept_mass_vote', idx: 2, outcome: 'NO', eventId: padHexId('f32'), now: 251,
    });
    state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 400 });
    state = reduceCourtConfirmationMachine(state, { type: 'resolve_round', now: 401 });
    expect(state.outcomeHistory[0]).toMatchObject({ round: 1, outcome: 'NO', winnerIndices: [1, 2] });
    // Round 2: YES wins (the proposal is restored) → round-1 voters flip.
    state = reduceCourtConfirmationMachine(state, { type: 'escalate', now: 401 });
    state = reduceCourtConfirmationMachine(state, {
      type: 'open_ladder_round', round: 2, voteDeadline: 600, now: 402,
    });
    for (const idx of [1, 2, 3]) {
      state = reduceCourtConfirmationMachine(state, {
        type: 'accept_mass_vote', idx, outcome: 'YES', eventId: padHexId(`f4${idx}`), now: 500 + idx,
      });
    }
    state = reduceCourtConfirmationMachine(state, { type: 'close_ladder_round', now: 600 });
    // Hand-restored snapshot carrying a round_flip flag for round 1 / idx 1 —
    // exactly the record a replay or a restored backup can contain. Idempotence
    // is per (idx, reason, round): idx 1 must NOT be flagged twice.
    const restored = {
      ...state,
      clawbackFlags: [...state.clawbackFlags, { idx: 1, reason: 'round_flip', round: 1 }],
    } as CourtConfirmationMachineState;
    const resolved = reduceCourtConfirmationMachine(restored, { type: 'resolve_round', now: 601 });
    const flipFlags = resolved.clawbackFlags.filter((f) => f.reason === 'round_flip' && f.round === 1);
    expect(flipFlags.map((f) => f.idx)).toEqual([1, 2]); // idx 1 once (restored), idx 2 added
    expect(flipFlags.filter((f) => f.idx === 1)).toHaveLength(1);
  });
});

// ─── C5 (M07): exact-priority ties rank by pubkey ASCENDING ────────────────

describe('mutation closure C5 (M07) — jury draw tie-break is pubkey-ascending', () => {
  function juror(pubkey: string): JurorProfile {
    return {
      nostrPubkey: pubkey,
      stakeCapacitySats: 100_000,
      stakeCommitment: {
        amountSats: 100_000,
        bondAddress: 'bc1q...',
        status: 'confirmed',
        committedAt: 1_700_000_000,
      },
      wotScore: 100,
      categories: ['world'],
      registeredAt: 1_600_000_000,
    };
  }

  it('orders exactly-tied jurors by ascending pubkey bytes (not descending)', () => {
    const disputeEventId = 'd'.repeat(64);
    const blockHash = 'b'.repeat(64);
    const seed = deriveSelectionSeed(disputeEventId, blockHash);
    const pool = [juror('aa'.repeat(32)), juror('bb'.repeat(32))];
    // Force an EXACT priority tie without touching the draw: give every juror
    // the weight -ln(r_j), so priority = -ln(r_j) / -ln(r_j) = 1.0 exactly.
    const weightFn = (j: JurorProfile) => -Math.log(jurorRandomValue(seed, j.nostrPubkey));
    const selected = selectJury(pool, {
      disputeEventId,
      blockHash,
      marketCategory: 'world',
      marketVolumeSats: 1_000_000,
      jurySize: 2,
      backupCount: 0,
      minWotScore: 0,
      minAccountAgeDays: 0,
      minStakeSats: 0,
      referenceTimeSec: 1_700_000_000,
      zeroStakeAllowed: true,
      weightFn,
    });
    expect(selected).toHaveLength(2);
    // The tie is real (both priorities are exactly 1) …
    expect(selected[0]!.priority).toBe(selected[1]!.priority);
    expect(selected[0]!.priority).toBe(1);
    // … so the order is decided by the tie-break alone: ascending pubkey.
    expect(selected.map((s) => s.nostrPubkey)).toEqual([pool[0]!.nostrPubkey, pool[1]!.nostrPubkey]);
  });
});

// ─── C6 (M24): the r = 1 clamp keeps a juror's priority finite/positive ────

describe('mutation closure C6 (M24) — quadraticPriority clamps r = 1', () => {
  it('clamps r = 1 to 1 - EPS (a positive priority, never 0)', () => {
    const clamped = quadraticPriority(1, 100);
    expect(clamped).toBeGreaterThan(0);
    expect(clamped).toBe(-Math.log(1 - Number.EPSILON) / 10);
    // r = 1 must NOT become the winning (zero) priority: it would let one
    // juror win every draw deterministically.
    expect(clamped).not.toBe(0);
  });

  it('keeps r = 0 on the other clamp branch', () => {
    expect(quadraticPriority(0, 100)).toBe(-Math.log(Number.MIN_VALUE) / 10);
  });
});

// ─── C7 (M35): the batch cap boundary is inclusive ─────────────────────────

describe('mutation closure C7 (M35) — batch size cap is inclusive at MAX', () => {
  const leaf = (i: number) => i.toString(16).padStart(64, '0');
  const MAX = 10_000;

  it('accepts exactly MAX_BATCH_VERDICTS leaves', () => {
    const hashes = Array.from({ length: MAX }, (_, i) => leaf(i + 1));
    const tree = buildBatchMerkleTree(hashes);
    expect(tree.leaves).toHaveLength(MAX);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects MAX + 1 leaves', () => {
    const hashes = Array.from({ length: MAX + 1 }, (_, i) => leaf(i + 1));
    expect(() => buildBatchMerkleTree(hashes)).toThrow(/exceeds maximum of 10000/);
  });
});

// ─── C8 (M47): the session encoder accepts lowercase hex only ──────────────

describe('mutation closure C8 (M47) — canonical session params reject uppercase hex', () => {
  function sessionParameters() {
    return {
      version: 1,
      environment: 'signet',
      cryptoSuite: 'pedpop-v1-experimental',
      disputeEventId: '11'.repeat(32),
      disputeId: 'dispute:mutation-closure',
      marketId: 'market-mutation-closure',
      marketEventId: '22'.repeat(32),
      selectionEventId: '33'.repeat(32),
      blockHash: 'ab'.repeat(32),
      blockHeight: 250_777,
      threshold: 2,
      allowedOutcomes: ['YES', 'NO'],
      attempt: 0,
      createdAt: 1_700_000_000,
      deadline: 1_700_003_600,
      participants: [
        { idx: 1, nostrPubkey: nostrPubkey(1), hostPubkey: hostPubkey(11), bondRef: 'signet:bond:one', role: 'juror-coordinator' as const },
        { idx: 2, nostrPubkey: nostrPubkey(2), hostPubkey: hostPubkey(12), bondRef: 'signet:bond:two', role: 'juror' as const },
        { idx: 3, nostrPubkey: nostrPubkey(3), hostPubkey: hostPubkey(13), bondRef: 'signet:bond:three', role: 'juror' as const },
      ],
    };
  }

  it('accepts the lowercase form', () => {
    expect(() => assertCourtSessionParameters(sessionParameters())).not.toThrow();
  });

  it('rejects an UPPERCASE block hash (one value, two spellings)', () => {
    const params = { ...sessionParameters(), blockHash: 'AB'.repeat(32) };
    expect(() => assertCourtSessionParameters(params)).toThrow(/lowercase hex/);
  });
});

// ─── C9 (M52): a proof index equal to the declared count is outside ────────

describe('mutation closure C9 (M52) — proof index bound is index < count', () => {
  function batchEvent(count: number, root: string, cohort: string) {
    return {
      kind: 39018,
      tags: [
        ['p', cohort],
        ['cohort', cohort],
        ['count', String(count)],
        ['root', root],
        ['sig', '11'.repeat(64)],
        ['nonce', '11'.repeat(32)],
        ['epoch', '0'],
        ['batch', '0'],
      ],
      content: JSON.stringify({ root, count, epoch: 0, batch: 0 }),
      pubkey: cohort,
      id: '22'.repeat(32),
      sig: '33'.repeat(64),
      created_at: 0,
    };
  }

  function leafOf(verdictHash: string): string {
    const pre = new Uint8Array([
      ...new TextEncoder().encode('BAO-Court/BatchLeaf/v1'),
      0x00,
      0x00, 0x00, 0x00, 0x20,
      ...hexToBytes(verdictHash),
    ]);
    return bytesToHex(sha256(pre));
  }

  it('rejects index === count before recomputing the root', () => {
    const caseInput = { sessionHash: '44'.repeat(32), outcome: 'YES', supportingEventIds: ['55'.repeat(32)] };
    const leaf = leafOf(hashCourtVerdict(caseInput));
    const result = verifyCaseInBatch(batchEvent(1, '66'.repeat(32), '77'.repeat(32)), {
      ...caseInput,
      proof: { index: 1, verdictHash: leaf, path: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/outside the declared batch count/);
  });
});
