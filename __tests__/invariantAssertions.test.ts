// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Executable cross-machine invariant assertions (docs/FORMAL_INVARIANTS.md).
 *
 * These are the cheap GLOBAL invariants that deserve always-on assertions —
 * properties that span every machine and module rather than any single
 * transition. Each test cites the invariant IDs it pins:
 *
 *   - INV-X-1  hash-domain family: BAO-Court/* domains pairwise distinct
 *   - INV-X-2  typed error family: every exported error class extends Error
 *              with its own name
 *   - INV-X-3  terminal-state closure: every terminal phase absorbs (behavioural)
 *   - INV-X-4  freeze discipline: every create/reduce result deeply frozen
 *   - INV-X-5  universal deadline precedence + universal monotonic ledger
 *              clock (F-12 closed in v0.9.2 — all four machines)
 *   - INV-X-6  roster closure on every machine
 *   - INV-X-7  quorum/threshold ∈ [1, panel] at creation
 *   - INV-X-8  CanonicalWriter totality + prefix-freeness
 *   - INV-X-9  compareOutcomeUtf8 = unsigned UTF-8 byte order
 *   - INV-X-10 shared Verdict/v1 domain between vote + confirmation machines
 *   - INV-CORE-8  HEX_32 language edges
 *   - INV-VOTE-9  commit version bit set on derivation, legacy format rejected
 *   - INV-VOTE-16 tie-break agrees with the UTF-8 byte oracle
 *   - INV-BATCH-5 RFC-6962 split point, oracle-checked via proof shapes
 *   - INV-DKG-8   certified is tick-exempt (backed_up always reachable)
 */

import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  CourtDkgTransitionError,
  createCourtDkgMachine,
  reduceCourtDkgMachine,
  type CourtDkgMachineState,
} from '../courtDkgMachine';
import {
  COURT_SIGNING_SESSION_DOMAIN,
  CourtSigningTransitionError,
  createCourtSigningMachine,
  reduceCourtSigningMachine,
  type CourtSigningMachineState,
} from '../courtSigningMachine';
import {
  COURT_DISPUTE_VERDICT_DOMAIN,
  COURT_VERDICT_DOMAIN,
  COURT_VOTE_COMMIT_DOMAIN,
  CourtVoteTransitionError,
  compareOutcomeUtf8,
  createCourtVoteMachine,
  hashCourtVerdict,
  hashCourtVoteCommit,
  reduceCourtVoteMachine,
  type CourtVoteMachineState,
} from '../courtVoteMachine';
import {
  COURT_CONFIRMATION_DOMAIN,
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  ATTESTATION_MESSAGE_DOMAIN,
  ATTESTATION_MESSAGE_DOMAIN_V2,
} from '../crypto';
import {
  BATCH_LEAF_DOMAIN,
  BATCH_MANIFEST_DOMAIN,
  BATCH_NODE_DOMAIN,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
} from '../batchAttestation';
import { COURT_SIGNER_SET_DOMAIN } from '../validator';
import {
  COURT_SESSION_DOMAIN,
  CanonicalWriter,
  CourtSessionValidationError,
  assertCourtSessionParameters,
} from '../courtSession';
import {
  COURT_EPOCH_COHORT_DOMAIN,
  COURT_EPOCH_HANDOFF_DOMAIN,
} from '../epochCohort';
import {
  COURT_KEEPER_COMMITMENT_DOMAIN,
  COURT_KEEPER_DESIGNATION_DOMAIN,
  COURT_KEEPER_STREAM_DOMAIN,
} from '../courtKeeper';
import {
  COURT_HOST_KEY_ATTESTATION_DOMAIN,
  COURT_HOST_KEY_BACKUP_DOMAIN,
  COURT_HOST_KEY_BACKUP_ENVELOPE_DOMAIN,
  COURT_HOST_KEY_SUPERSESSION_DOMAIN,
} from '../courtHostKey';
import { COURT_OUTBOX_MESSAGE_DOMAIN } from '../courtOutbox';
import { COURT_RECOVERY_ENVELOPE_DOMAIN } from '../courtRecovery';
import { COURT_SIGNER_CAPABILITY_DOMAIN } from '../courtNip46';
import { BOND_OWNERSHIP_DOMAIN } from '../escrow';
import { LN_AUDIT_DOMAIN, LN_PREIMAGE_DOMAIN } from '../lnSettlement';
import { HEX_32 } from '../courtCeremonyCore';
import { CourtError } from '../errors';
import { SIGNING_JOURNAL_DOMAIN } from '../attribution';
import {
  voteMachine as sharedVoteMachine,
  confirmationMachine as sharedConfirmationMachine,
  signingMachine as sharedSigningMachine,
  dkgMachine as sharedDkgMachine,
} from './helpers/machines';

// ─── fixtures ────────────────────────────────────────────────────────────────

const SESSION = '11'.repeat(32);
const PROPOSAL = '22'.repeat(32);
const hex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const EVENT = (idx: number): string => hex(0xb0 + idx);
const SALT = (idx: number): string => hex(0xc0 + idx);
const POINT = (n: number): string =>
  secp256k1.Point.BASE.multiply(BigInt(n)).toHex(true);

function voteMachine(): CourtVoteMachineState {
  return sharedVoteMachine({ allowedOutcomes: ['NO', 'YES'] });
}

function confirmationMachine(): CourtConfirmationMachineState {
  return sharedConfirmationMachine({
    proposalHash: PROPOSAL,
    allowedOutcomes: ['NO', 'YES'],
    confirmQuorum: 2,
    confirmDeadline: 100,
    challengeDeadline: 300,
  });
}

function signingMachine(): CourtSigningMachineState {
  return sharedSigningMachine({ verdictHash: PROPOSAL, outcome: 'YES' });
}

function dkgMachine(): CourtDkgMachineState {
  return sharedDkgMachine({ participantIndices: [1, 2, 3], deadline: 500 });
}

/** Drive the vote machine to `tally_final` (INV-X-3 fixture). */
function voteFinalized(): CourtVoteMachineState {
  let s = voteMachine();
  for (const idx of [1, 2, 3]) {
    s = reduceCourtVoteMachine(s, {
      type: 'accept_commit',
      idx,
      commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'YES', salt: SALT(idx) }),
      eventId: EVENT(idx),
      now: 50,
    });
  }
  s = reduceCourtVoteMachine(s, { type: 'close_commits', now: 100 });
  s = reduceCourtVoteMachine(s, { type: 'open_reveals', now: 110 });
  for (const idx of [1, 2]) {
    s = reduceCourtVoteMachine(s, {
      type: 'accept_reveal', idx, outcome: 'YES', salt: SALT(idx), eventId: EVENT(idx), now: 120,
    });
  }
  s = reduceCourtVoteMachine(s, { type: 'close_reveals', now: 200 });
  return reduceCourtVoteMachine(s, { type: 'finalize_tally', now: 210 });
}

/** Drive the confirmation machine to `final` (never-challenged path). */
function confirmationFinal(): CourtConfirmationMachineState {
  let s = confirmationMachine();
  for (const idx of [1, 2]) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: EVENT(idx),
      now: 50,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 100 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 110 });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 300 });
  return reduceCourtConfirmationMachine(s, { type: 'finalize', now: 310 });
}

/** Drive the signing machine to `attestation_published`. */
function signingPublished(): CourtSigningMachineState {
  let s = reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 });
  for (const [idx, tag] of [[1, 11], [2, 12], [3, 13]] as const) {
    s = reduceCourtSigningMachine(s, {
      type: 'accept_commitment', idx, binderPn: POINT(tag), hiddenPn: POINT(tag + 100), now: 60,
    });
  }
  s = reduceCourtSigningMachine(s, { type: 'close_commitments', now: 100 });
  s = reduceCourtSigningMachine(s, { type: 'accept_partial', idx: 1, psig: hex(0xd1), now: 110 });
  s = reduceCourtSigningMachine(s, { type: 'accept_partial', idx: 2, psig: hex(0xd2), now: 120 });
  s = reduceCourtSigningMachine(s, { type: 'aggregate', signature: 'ab'.repeat(64), now: 130 });
  return reduceCourtSigningMachine(s, { type: 'publish', attestationEventId: hex(0x99), now: 140 });
}

const TRANSCRIPT = hex(0x77);
/** Compressed (02-prefixed) curve point — matches the DKG machine's GROUP_KEY language. */
const GROUP_KEY = POINT(2);

/** Drive the DKG machine to `certified` (unanimous transcript certification). */
function dkgCertified(): CourtDkgMachineState {
  let s = reduceCourtDkgMachine(dkgMachine(), { type: 'start', now: 10 });
  for (const idx of [1, 2, 3]) s = reduceCourtDkgMachine(s, { type: 'accept_round_1', idx, now: 20 + idx });
  for (const idx of [1, 2, 3]) s = reduceCourtDkgMachine(s, { type: 'accept_round_2', idx, now: 30 + idx });
  s = reduceCourtDkgMachine(s, {
    type: 'finalize_transcript', transcriptHash: TRANSCRIPT, candidateGroupPubkey: GROUP_KEY, now: 40,
  });
  for (const idx of [1, 2, 3]) {
    s = reduceCourtDkgMachine(s, { type: 'accept_certification', idx, transcriptHash: TRANSCRIPT, now: 50 + idx });
  }
  return s;
}

// ─── INV-X-1: hash-domain family ─────────────────────────────────────────────

const ALL_DOMAINS: readonly string[] = [
  COURT_SESSION_DOMAIN,
  ATTESTATION_MESSAGE_DOMAIN,
  ATTESTATION_MESSAGE_DOMAIN_V2,
  BATCH_LEAF_DOMAIN,
  BATCH_NODE_DOMAIN,
  BATCH_MANIFEST_DOMAIN,
  COURT_VOTE_COMMIT_DOMAIN,
  COURT_VERDICT_DOMAIN,
  COURT_DISPUTE_VERDICT_DOMAIN,
  COURT_CONFIRMATION_DOMAIN,
  COURT_SIGNING_SESSION_DOMAIN,
  COURT_SIGNER_SET_DOMAIN,
  COURT_EPOCH_COHORT_DOMAIN,
  COURT_EPOCH_HANDOFF_DOMAIN,
  COURT_KEEPER_DESIGNATION_DOMAIN,
  COURT_KEEPER_COMMITMENT_DOMAIN,
  COURT_KEEPER_STREAM_DOMAIN,
  COURT_HOST_KEY_BACKUP_DOMAIN,
  COURT_HOST_KEY_BACKUP_ENVELOPE_DOMAIN,
  COURT_HOST_KEY_ATTESTATION_DOMAIN,
  COURT_HOST_KEY_SUPERSESSION_DOMAIN,
  COURT_OUTBOX_MESSAGE_DOMAIN,
  COURT_RECOVERY_ENVELOPE_DOMAIN,
  COURT_SIGNER_CAPABILITY_DOMAIN,
  BOND_OWNERSHIP_DOMAIN,
  LN_PREIMAGE_DOMAIN,
  LN_AUDIT_DOMAIN,
  SIGNING_JOURNAL_DOMAIN,
];

describe('INV-X-1: the BAO-Court hash domains form a pairwise-disjoint family', () => {
  it('every exported domain constant is a distinct BAO-Court/<Name>/v<n> string', () => {
    expect(ALL_DOMAINS.length).toBeGreaterThanOrEqual(27);
    expect(new Set(ALL_DOMAINS).size).toBe(ALL_DOMAINS.length); // pairwise distinct
    for (const domain of ALL_DOMAINS) {
      expect(domain.startsWith('BAO-Court/')).toBe(true);
      expect(domain).toMatch(/^BAO-Court\/[A-Za-z]+\/v\d+$/);
    }
  });

  it('distinct domains derive distinct digests for identical payloads (domain separation)', () => {
    const payload = new CanonicalWriter();
    payload.hex(SESSION);
    const encoded = payload.finish();
    const digestOf = (domain: string): string => {
      const prefix = new TextEncoder().encode(domain);
      const input = new Uint8Array(prefix.length + encoded.length);
      input.set(prefix, 0);
      input.set(encoded, prefix.length);
      return bytesToHex(sha256(input));
    };
    const digests = new Set(ALL_DOMAINS.map(digestOf));
    expect(digests.size).toBe(ALL_DOMAINS.length);
  });
});

// ─── INV-X-2: typed error family ─────────────────────────────────────────────

describe('INV-X-2: every exported machine error class extends Error with the right name', () => {
  const ERRORS = [
    CourtVoteTransitionError,
    CourtConfirmationTransitionError,
    CourtSigningTransitionError,
    CourtDkgTransitionError,
  ];
  it('each class is an Error subclass, sets its own name, and preserves the message', () => {
    for (const Ctor of ERRORS) {
      const err = new Ctor('probe message');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CourtError);
      expect(err.name).toBe(Ctor.name);
      expect(String(err)).toContain(Ctor.name);
      expect((err as Error & { code: string }).code.length).toBeGreaterThan(0);
    }
    // CourtSessionValidationError uniquely carries a machine-readable code.
    const sessionErr = new CourtSessionValidationError('invalid_hex', 'probe message');
    expect(sessionErr).toBeInstanceOf(Error);
    expect(sessionErr.name).toBe('CourtSessionValidationError');
    expect(sessionErr.code).toBe('invalid_hex');
    expect(sessionErr.message).toBe('probe message');
  });

  it('rejections on every machine surface the machine’s OWN typed class (fail-closed law)', () => {
    expect(() => reduceCourtVoteMachine(voteMachine(), { type: 'close_commits', now: 1 }))
      .toThrow(CourtVoteTransitionError);
    expect(() =>
      reduceCourtConfirmationMachine(confirmationMachine(), { type: 'close_confirmations', now: 100 }),
    ).toThrow(CourtConfirmationTransitionError);
    expect(() =>
      reduceCourtSigningMachine(signingMachine(), { type: 'aggregate', signature: 'ab'.repeat(64), now: 50 }),
    ).toThrow(CourtSigningTransitionError);
    expect(() =>
      reduceCourtDkgMachine(dkgMachine(), { type: 'accept_round_1', idx: 1, now: 20 }),
    ).toThrow(CourtDkgTransitionError);
    expect(() => new CanonicalWriter().u32(-1)).toThrow(CourtSessionValidationError);
  });
});

// ─── INV-X-3: terminal-state closure (behavioural) ───────────────────────────

describe('INV-X-3: every terminal state is absorbing (tick no-ops, other events throw typed)', () => {
  it('vote machine: tally_final, expired, and aborted each absorb', () => {
    const terminals = [
      voteFinalized(),
      reduceCourtVoteMachine(voteMachine(), { type: 'tick', now: 999 }),
      reduceCourtVoteMachine(voteMachine(), { type: 'abort', reason: 'host decision' }),
    ];
    for (const terminal of terminals) {
      expect(['tally_final', 'expired', 'aborted']).toContain(terminal.phase);
      // tick is a phase no-op on a terminal state: it may still advance the
      // clock ledger (latestTimestamp), so compare the protocol fields.
      const ticked = reduceCourtVoteMachine(terminal, { type: 'tick', now: 1000 });
      expect(ticked.phase).toBe(terminal.phase);
      expect(ticked.verdict).toEqual(terminal.verdict);
      expect(ticked.failure).toEqual(terminal.failure);
      // every non-tick event throws the machine's typed error
      expect(() =>
        reduceCourtVoteMachine(terminal, { type: 'accept_commit', idx: 1, commitHash: SESSION, eventId: SESSION, now: 1000 }),
      ).toThrow(CourtVoteTransitionError);
      expect(() => reduceCourtVoteMachine(terminal, { type: 'finalize_tally', now: 1000 }))
        .toThrow(CourtVoteTransitionError);
      expect(() => reduceCourtVoteMachine(terminal, { type: 'abort', reason: 'x' }))
        .toThrow(CourtVoteTransitionError);
      expect(() => reduceCourtVoteMachine(terminal, { type: 'nonsense' } as never))
        .toThrow(CourtVoteTransitionError);
    }
  });

  it('confirmation machine: final, expired, and aborted each absorb', () => {
    const terminals = [
      confirmationFinal(),
      reduceCourtConfirmationMachine(confirmationMachine(), { type: 'tick', now: 999 }),
      reduceCourtConfirmationMachine(confirmationMachine(), { type: 'abort', reason: 'host decision' }),
    ];
    for (const terminal of terminals) {
      expect(['final', 'expired', 'aborted']).toContain(terminal.phase);
      const ticked = reduceCourtConfirmationMachine(terminal, { type: 'tick', now: 1000 });
      expect(ticked.phase).toBe(terminal.phase);
      expect(ticked.verdict).toEqual(terminal.verdict);
      expect(ticked.failure).toEqual(terminal.failure);
      expect(() => reduceCourtConfirmationMachine(terminal, { type: 'finalize', now: 1000 }))
        .toThrow(CourtConfirmationTransitionError);
      expect(() =>
        reduceCourtConfirmationMachine(terminal, {
          type: 'accept_confirmation', idx: 1,
          confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 }),
          eventId: EVENT(1), now: 1000,
        }),
      ).toThrow(CourtConfirmationTransitionError);
      expect(() => reduceCourtConfirmationMachine(terminal, { type: 'nonsense' } as never))
        .toThrow(CourtConfirmationTransitionError);
    }
  });

  it('signing machine: attestation_published, expired, and aborted_peer each absorb', () => {
    const terminals = [
      signingPublished(),
      reduceCourtSigningMachine(signingMachine(), { type: 'tick', now: 999 }),
      reduceCourtSigningMachine(signingMachine(), {
        type: 'abort', phase: 'aborted_peer', reason: 'peer fault',
      }),
    ];
    for (const terminal of terminals) {
      expect(['attestation_published', 'expired', 'aborted_peer']).toContain(terminal.phase);
      expect(() => reduceCourtSigningMachine(terminal, { type: 'aggregate', signature: 'ab'.repeat(64), now: 1000 }))
        .toThrow(CourtSigningTransitionError);
      expect(() => reduceCourtSigningMachine(terminal, { type: 'publish', attestationEventId: SESSION, now: 1000 }))
        .toThrow(CourtSigningTransitionError);
      expect(() => reduceCourtSigningMachine(terminal, { type: 'nonsense' } as never))
        .toThrow(CourtSigningTransitionError);
    }
  });

  it('DKG machine: backed_up, expired, and aborted_peer each absorb; certified is tick-exempt (INV-DKG-8)', () => {
    const certified = dkgCertified();
    expect(certified.phase).toBe('certified');
    expect(certified.certifiedGroupPubkey).toBe(GROUP_KEY);
    // INV-DKG-8: a certified machine never expires — the local backup
    // confirmation remains reachable at any time.
    const ticked = reduceCourtDkgMachine(certified, { type: 'tick', now: 999 });
    expect(ticked.phase).toBe('certified');
    const backedUp = reduceCourtDkgMachine(certified, { type: 'confirm_backup', now: 10_000 });
    expect(backedUp.phase).toBe('backed_up');
    expect(backedUp.backupVerified).toBe(true);

    const terminals = [
      backedUp,
      reduceCourtDkgMachine(dkgMachine(), { type: 'tick', now: 999 }),
      reduceCourtDkgMachine(dkgMachine(), {
        type: 'abort', phase: 'aborted_peer', reason: 'peer fault',
      }),
    ];
    for (const terminal of terminals) {
      expect(['backed_up', 'expired', 'aborted_peer']).toContain(terminal.phase);
      expect(() => reduceCourtDkgMachine(terminal, { type: 'start', now: 1000 }))
        .toThrow(CourtDkgTransitionError);
      expect(() =>
        reduceCourtDkgMachine(terminal, { type: 'accept_round_1', idx: 1, now: 1000 }),
      ).toThrow(CourtDkgTransitionError);
      expect(() => reduceCourtDkgMachine(terminal, { type: 'nonsense' } as never))
        .toThrow(CourtDkgTransitionError);
    }
  });
});

// ─── INV-X-4: freeze discipline ──────────────────────────────────────────────

describe('INV-X-4: freeze discipline holds on every exported state shape', () => {
  it('every create/reduce result is deeply frozen on all four machines', () => {
    const frozen = (s: unknown): boolean => Object.isFrozen(s);
    const frozenAll = (xs: readonly unknown[] | undefined): boolean =>
      xs === undefined || (Object.isFrozen(xs) && xs.every((x) => Object.isFrozen(x)));

    // vote machine: creation + final state incl. verdict shapes
    const v = voteMachine();
    expect(frozen(v)).toBe(true);
    expect(frozenAll(v.participantIndices)).toBe(true);
    expect(frozenAll(v.allowedOutcomes)).toBe(true);
    expect(frozenAll(v.commits)).toBe(true);
    expect(frozenAll(v.reveals)).toBe(true);
    const final = voteFinalized();
    expect(frozen(final)).toBe(true);
    expect(frozenAll(final.commits)).toBe(true);
    expect(frozenAll(final.reveals)).toBe(true);
    expect(frozenAll(final.verdict?.supportingEventIds)).toBe(true);
    expect(frozen(final.verdict)).toBe(true);

    // confirmation machine: creation + ledgers + history + flags
    const c = confirmationMachine();
    expect(frozen(c)).toBe(true);
    for (const field of ['participantIndices', 'allowedOutcomes', 'evidenceIds', 'confirmations', 'challenges', 'outcomeHistory', 'clawbackFlags', 'fees'] as const) {
      expect(frozenAll(c[field] as readonly unknown[])).toBe(true);
    }
    const cFinal = confirmationFinal();
    expect(frozen(cFinal)).toBe(true);
    expect(frozen(cFinal.verdict)).toBe(true);
    expect(frozenAll(cFinal.verdict?.supportingEventIds)).toBe(true);

    // signing machine: creation + commitment/partial ledgers + signer set
    const g = signingMachine();
    expect(frozen(g)).toBe(true);
    expect(frozenAll(g.participantIndices)).toBe(true);
    expect(frozenAll(g.commitments)).toBe(true);
    expect(frozenAll(g.partials)).toBe(true);
    const published = signingPublished();
    expect(frozen(published)).toBe(true);
    expect(frozenAll(published.finalizedSignerSet)).toBe(true);
    expect(frozenAll(published.commitments)).toBe(true);
    expect(frozenAll(published.partials)).toBe(true);

    // DKG machine: creation + participant ledgers
    const d = dkgMachine();
    expect(frozen(d)).toBe(true);
    for (const field of ['participantIndices', 'round1Participants', 'round2Participants', 'transcriptCertifiers'] as const) {
      expect(frozenAll(d[field])).toBe(true);
    }
    const certified = dkgCertified();
    expect(frozen(certified)).toBe(true);
    expect(frozenAll(certified.transcriptCertifiers)).toBe(true);
  });

  it('frozen states reject in-place mutation attempts (vote machine exemplar)', () => {
    const final = voteFinalized();
    expect(() => {
      (final as { phase?: string }).phase = 'commit_open';
    }).toThrow(TypeError);
    expect(final.phase).toBe('tally_final');
  });
});

// ─── INV-X-5 / INV-X-6: deadline precedence + roster closure ─────────────────

describe('INV-X-5: universal deadline precedence + universal monotonic ledger clock (F-12 closed)', () => {
  it('a rolled-back clock is rejected on the machines that keep a monotonic ledger clock', () => {
    // vote machine (latestTimestamp ledger)
    const v = reduceCourtVoteMachine(voteMachine(), { type: 'close_commits', now: 100 });
    expect(() => reduceCourtVoteMachine(v, { type: 'open_reveals', now: 99 }))
      .toThrow(/must not precede a previously observed timestamp/);
    // confirmation machine (latestTimestamp ledger): advance the clock with a
    // successful confirmation first (close_confirmations would throw on the
    // empty-ledger quorum gate before touching the clock).
    const c = reduceCourtConfirmationMachine(confirmationMachine(), {
      type: 'accept_confirmation', idx: 1,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 }),
      eventId: EVENT(1), now: 99,
    });
    expect(() => reduceCourtConfirmationMachine(c, { type: 'tick', now: 98 }))
      .toThrow(/must not precede a previously observed timestamp/);
  });

  it('F-12 (CLOSED in v0.9.2): signing/DKG keep the monotonic ledger clock too', () => {
    // The signing and DKG machines now keep the same monotonic clock ledger
    // as the vote/confirmation machines (finding F-12, fixed in v0.9.2): an
    // event whose timestamp precedes an earlier-observed one is rejected
    // with the machine's typed error, on all four machines.
    const g = reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 });
    expect(() =>
      reduceCourtSigningMachine(g, {
        type: 'accept_commitment', idx: 1, binderPn: POINT(11), hiddenPn: POINT(111), now: 40,
      }),
    ).toThrow(/must not precede a previously observed timestamp/);

    const d = reduceCourtDkgMachine(dkgMachine(), { type: 'start', now: 10 });
    expect(() =>
      reduceCourtDkgMachine(d, { type: 'accept_round_1', idx: 1, now: 5 }),
    ).toThrow(/must not precede a previously observed timestamp/);

    // …and the deadline itself still binds everywhere (strict precedence).
    expect(() =>
      reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 500 }),
    ).toThrow(CourtSigningTransitionError);
    expect(() =>
      reduceCourtDkgMachine(dkgMachine(), { type: 'start', now: 500 }),
    ).toThrow(CourtDkgTransitionError);
  });
});

describe('INV-X-6: roster closure on every machine', () => {
  it('an off-roster index is rejected with the machine’s own typed error, everywhere', () => {
    const OFF = 9; // roster is [1, 2, 3]
    expect(() =>
      reduceCourtVoteMachine(voteMachine(), {
        type: 'accept_commit', idx: OFF,
        commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'YES', salt: SALT(1) }),
        eventId: EVENT(1), now: 50,
      }),
    ).toThrow(/outside the certified roster/);
    expect(() =>
      reduceCourtConfirmationMachine(confirmationMachine(), {
        type: 'accept_confirmation', idx: OFF,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: OFF }),
        eventId: EVENT(1), now: 50,
      }),
    ).toThrow(/outside the certified roster/);
    const g = reduceCourtSigningMachine(signingMachine(), { type: 'start', now: 50 });
    expect(() =>
      reduceCourtSigningMachine(g, { type: 'accept_commitment', idx: OFF, binderPn: POINT(11), hiddenPn: POINT(111), now: 60 }),
    ).toThrow(/outside the certified roster/);
    const d = reduceCourtDkgMachine(dkgMachine(), { type: 'start', now: 10 });
    expect(() => reduceCourtDkgMachine(d, { type: 'accept_round_1', idx: OFF, now: 20 }))
      .toThrow(/outside the certified roster/);
  });
});

// ─── INV-X-7: quorum / threshold ≤ panel ─────────────────────────────────────

describe('INV-X-7: quorum and threshold are bounded to the panel at creation', () => {
  it('confirmation: confirmQuorum outside [1, roster] is rejected', () => {
    const base = {
      sessionHash: SESSION, proposalHash: PROPOSAL, proposedOutcome: 'YES',
      allowedOutcomes: ['NO', 'YES'], participantIndices: [1, 2, 3],
      confirmDeadline: 100, challengeDeadline: 300,
    };
    expect(() => createCourtConfirmationMachine({ ...base, confirmQuorum: 0 }))
      .toThrow(CourtConfirmationTransitionError);
    expect(() => createCourtConfirmationMachine({ ...base, confirmQuorum: 4 }))
      .toThrow(CourtConfirmationTransitionError);
    expect(() => createCourtConfirmationMachine({ ...base, confirmQuorum: 1.5 }))
      .toThrow(CourtConfirmationTransitionError);
  });

  it('signing: threshold outside [1, roster] is rejected', () => {
    const base = {
      sessionHash: SESSION, verdictHash: PROPOSAL, outcome: 'YES',
      participantIndices: [1, 2, 3], attempt: 0, deadline: 500,
    };
    expect(() => createCourtSigningMachine({ ...base, threshold: 0 }))
      .toThrow(CourtSigningTransitionError);
    expect(() => createCourtSigningMachine({ ...base, threshold: 4 }))
      .toThrow(CourtSigningTransitionError);
  });

  it('session: threshold cannot exceed the participant count', () => {
    const valid = {
      version: 1 as const,
      environment: 'demo' as const,
      cryptoSuite: 'pedpop-v1-experimental' as const,
      disputeEventId: SESSION,
      disputeId: 'dispute-1',
      marketId: 'market-1',
      marketEventId: SESSION,
      selectionEventId: SESSION,
      blockHash: SESSION,
      blockHeight: 5,
      participants: [1, 2, 3].map((idx) => ({
        idx,
        nostrPubkey: hex(idx),
        hostPubkey: POINT(idx + 20),
        bondRef: `bond-${idx}`,
        role: 'juror' as const,
      })).map((p, i) => (i === 0 ? { ...p, role: 'juror-coordinator' as const } : p)),
      threshold: 3,
      allowedOutcomes: ['NO', 'YES'],
      attempt: 0,
      createdAt: 10,
      deadline: 20,
    };
    expect(() => assertCourtSessionParameters(valid)).not.toThrow();
    expect(() => assertCourtSessionParameters({ ...valid, threshold: 4 })).toThrow(
      CourtSessionValidationError,
    );
  });
});

// ─── INV-X-8: CanonicalWriter totality + prefix-freeness ─────────────────────

describe('INV-X-8: CanonicalWriter is total, typed, and prefix-free', () => {
  it('rejects out-of-range integers with CourtSessionValidationError (never silent wrap)', () => {
    expect(() => new CanonicalWriter().u8(256)).toThrow(CourtSessionValidationError);
    expect(() => new CanonicalWriter().u8(-1)).toThrow(CourtSessionValidationError);
    expect(() => new CanonicalWriter().u8(1.5)).toThrow(CourtSessionValidationError);
    expect(() => new CanonicalWriter().u32(2 ** 32)).toThrow(CourtSessionValidationError);
    expect(() => new CanonicalWriter().u64(2 ** 53)).toThrow(CourtSessionValidationError);
    expect(() => new CanonicalWriter().u64(-1)).toThrow(CourtSessionValidationError);
  });

  it('u32 is big-endian; length prefixes make field tuples injective (no delimiter ambiguity)', () => {
    const w = new CanonicalWriter();
    w.u32(0x01020304);
    expect(Array.from(w.finish())).toEqual([1, 2, 3, 4]);

    const tupleA = new CanonicalWriter(); // ('a', 'bc')
    tupleA.text('a');
    tupleA.text('bc');
    const tupleB = new CanonicalWriter(); // ('a|bc',) — the delimiter alias
    tupleB.text('a|bc');
    const tupleC = new CanonicalWriter(); // ('a|', 'bc')
    tupleC.text('a|');
    tupleC.text('bc');
    const encodings = [tupleA.finish(), tupleB.finish(), tupleC.finish()];
    expect(new Set(encodings.map((e) => Array.from(e).join(','))).size).toBe(3);
  });

  it('finish() is deterministic', () => {
    const build = (): Uint8Array => {
      const w = new CanonicalWriter();
      w.u8(1);
      w.text('YES');
      w.hex(SESSION);
      return w.finish();
    };
    expect(Array.from(build())).toEqual(Array.from(build()));
  });
});

// ─── INV-X-9: comparator oracle ──────────────────────────────────────────────

describe('INV-X-9: compareOutcomeUtf8 is unsigned UTF-8 byte order (not UTF-16 code units)', () => {
  const SAMPLE = ['YES', 'NO', 'a', 'a\u{10000}', 'a\uFFFD', '\u{10FFFF}', 'z', 'A', 'é', '€'];

  it('agrees with the Buffer.compare UTF-8 oracle on all pairs (incl. supplementary plane)', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        const expected = Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
        expect(Math.sign(compareOutcomeUtf8(a, b))).toBe(Math.sign(expected));
      }
    }
  });

  it('is a total order: antisymmetric and transitive on the sample space', () => {
    for (const a of SAMPLE) expect(compareOutcomeUtf8(a, a)).toBe(0);
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        const forward = Math.sign(compareOutcomeUtf8(a, b));
        const backward = Math.sign(compareOutcomeUtf8(b, a));
        expect(Math.abs(forward + backward)).toBe(0); // antisymmetric (±0-safe)
      }
    }
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        for (const c of SAMPLE) {
          if (compareOutcomeUtf8(a, b) < 0 && compareOutcomeUtf8(b, c) < 0) {
            expect(compareOutcomeUtf8(a, c)).toBeLessThan(0);
          }
        }
      }
    }
    const sorted = [...SAMPLE].sort(compareOutcomeUtf8);
    const oracleSorted = [...SAMPLE].sort((a, b) =>
      Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
    );
    expect(sorted).toEqual(oracleSorted);
  });

  it('diverges from UTF-16 code-unit order exactly where the spec says (supplementary plane)', () => {
    // '\u{10000}' (UTF-8: F0 90 80 80) vs '\uFFFD' (UTF-8: EF BF BD): UTF-8 byte
    // order puts \uFFFD first; JS's default `<` (UTF-16 code units) disagrees.
    expect(compareOutcomeUtf8('\uFFFD', '\u{10000}')).toBeLessThan(0);
    expect('\uFFFD' < '\u{10000}').toBe(false);
  });
});

// ─── INV-X-10 + INV-VOTE-9: shared verdict domain + commit version bit ───────

describe('INV-X-10/INV-VOTE-9: verdict domain sharing and the commit version bit', () => {
  it('the confirmation machine mints its verdict hash with the vote machine’s Verdict/v1 function', () => {
    const final = confirmationFinal();
    expect(final.verdict).toBeDefined();
    // Recompute via the exported vote-machine helper over the FINAL verdict's
    // own supporting ids: identical by construction (shared domain).
    expect(final.verdict!.verdictHash).toBe(
      hashCourtVerdict({
        sessionHash: SESSION,
        outcome: final.verdict!.outcome,
        supportingEventIds: final.verdict!.supportingEventIds,
      }),
    );
  });

  it('every derived vote-commit hash carries the 0x8 version bit; legacy format is rejected', () => {
    const commitHash = hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'YES', salt: SALT(1) });
    expect(HEX_32.test(commitHash)).toBe(true);
    expect((Number.parseInt(commitHash[0]!, 16) & 0x8) !== 0).toBe(true);

    // Strip the version bit → a legacy sessionless commitment: the machine
    // must refuse it (INV-VOTE-9).
    const legacy = commitHash.replace(/^./, (c) =>
      (Number.parseInt(c, 16) & 0x7).toString(16),
    );
    expect((Number.parseInt(legacy[0]!, 16) & 0x8) === 0).toBe(true);
    expect(() =>
      reduceCourtVoteMachine(voteMachine(), {
        type: 'accept_commit', idx: 1, commitHash: legacy, eventId: EVENT(1), now: 50,
      }),
    ).toThrow(/legacy sessionless format/);
  });
});

// ─── INV-CORE-8: HEX_32 language edges ───────────────────────────────────────

describe('INV-CORE-8: HEX_32 is exactly the 64-char lowercase-hex language', () => {
  it('accepts only 64 lowercase hex chars', () => {
    expect(HEX_32.test(SESSION)).toBe(true);
    expect(HEX_32.test('A'.repeat(64))).toBe(false); // uppercase
    expect(HEX_32.test('a'.repeat(63))).toBe(false);
    expect(HEX_32.test('a'.repeat(65))).toBe(false);
    expect(HEX_32.test('g'.repeat(64))).toBe(false);
    expect(HEX_32.test('')).toBe(false);
  });
});

// ─── INV-BATCH-5: RFC-6962 split point, oracle-checked via proof shapes ──────

describe('INV-BATCH-5: the RFC-6962 split point 2^floor(log2(n-1)) governs proof shapes', () => {
  it('every index of n = 2..32 plus 63/64/65/100/127/128 has the oracle path length', () => {
    // Independent oracle for the path length implied by the RFC-6962 split.
    const oraclePathLength = (n: number, index: number): number => {
      let length = 0;
      let size = n;
      let i = index;
      while (size > 1) {
        const k = 2 ** Math.floor(Math.log2(size - 1));
        if (i < k) {
          size = k;
        } else {
          i -= k;
          size -= k;
        }
        length += 1;
      }
      return length;
    };
    const sizes = [...Array.from({ length: 31 }, (_, i) => i + 2), 63, 64, 65, 100, 127, 128];
    for (const n of sizes) {
      const hashes: string[] = [];
      for (let i = 0; i < n; i += 1) hashes.push(i.toString(16).padStart(2, '0').repeat(32));
      const { leaves } = buildBatchMerkleTree(hashes);
      for (let index = 0; index < n; index += 1) {
        const proof = buildBatchMerkleProof(leaves, index);
        expect(proof.path.length).toBe(oraclePathLength(n, index));
      }
    }
  });

  it('the tree root is order-independent and duplicate-free (INV-BATCH-2/3 spot check)', () => {
    const hashes = [2, 1, 3, 5, 4, 8, 6, 7].map((i) => hex(i));
    const a = buildBatchMerkleTree(hashes).root;
    const b = buildBatchMerkleTree([...hashes].reverse()).root;
    expect(a).toBe(b);
    expect(() => buildBatchMerkleTree([hex(1), hex(1)])).toThrow();
  });
});
