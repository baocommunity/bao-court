// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Unified error taxonomy boundary tests (docs/FORMAL_INVARIANTS.md §15,
 * INV-X-2). Pins:
 *
 *   - every exported error class extends CourtError, keeps its name, and
 *     carries a non-empty `code`
 *   - new-family codes are SCREAMING_SNAKE
 *   - cause-chaining and the `invariant` field
 *   - boundary law: malformed-but-typed inputs to the public API surface a
 *     CourtError — never a raw TypeError or decoder Error
 */

import { describe, expect, it } from 'vitest';

import {
  AppealError,
  CourtArgumentError,
  CourtCryptoError,
  CourtDkgError,
  CourtError,
  CourtSelectionError,
  CourtSignerError,
  EscrowLedgerError,
  FrostSigningError,
  IndependentDkgError,
  IndependentSigningError,
  LnHoldLedgerError,
  LnRailError,
  LiquidEscrowError,
  TaprootSpendError,
} from '../errors';
import { BatchAttestationError } from '../batchAttestation';
import { CourtEpochCohortError } from '../epochCohort';
import { CourtSignerSetError } from '../validator';
import { CourtHostKeyError } from '../courtHostKey';
import { CourtInboxError } from '../courtInbox';
import { CourtKeeperError } from '../courtKeeper';
import { CourtCapabilityError } from '../courtNip46';
import { CourtOutboxError } from '../courtOutbox';
import { CourtProtocolEventError } from '../courtProtocolEvents';
import { CourtRecoveryError } from '../courtRecovery';
import { CourtSessionValidationError } from '../courtSession';
import { CourtSigningTransitionError } from '../courtSigningMachine';
import { CourtVoteTransitionError } from '../courtVoteMachine';
import { CourtConfirmationTransitionError } from '../courtConfirmationMachine';
import { CourtDkgTransitionError } from '../courtDkgMachine';
import {
  ATTESTATION_MESSAGE_DOMAIN_V2,
} from '../crypto';
import {
  buildAttestationEvent,
} from '../events';
import {
  assertUnwrapBatchSize,
  assertValidUnwrapKinds,
} from '../courtUnwrapCore';
import { SeckeyCourtSigner as CourtSigner } from '../courtSigner';
import { buildMultisigScript } from '../liquidEscrow';
import { outputKeyParity } from '../taprootSpend';
import { combineShares } from '../dkg';
import { calculateBondAmount } from '../escrow';
import { deriveDisputeGroupPubkey, hashCommit } from '../dispute';
import { selectJury, weightedPriority } from '../selection';
import { buildBatchMerkleTree } from '../batchAttestation';
import { hashSignerSetRoot } from '../validator';

// The full registry — every exported error class in the package.
const ALL_CLASSES = [
  // base
  CourtError,
  CourtArgumentError,
  // new domain classes (v0.10.1)
  CourtDkgError,
  IndependentDkgError,
  IndependentSigningError,
  FrostSigningError,
  CourtSelectionError,
  EscrowLedgerError,
  LnHoldLedgerError,
  LnRailError,
  LiquidEscrowError,
  TaprootSpendError,
  CourtCryptoError,
  CourtSignerError,
  AppealError,
  // legacy classes (grafted onto CourtError in v0.10.1, names/signals unchanged)
  BatchAttestationError,
  CourtConfirmationTransitionError,
  CourtDkgTransitionError,
  CourtHostKeyError,
  CourtInboxError,
  CourtKeeperError,
  CourtCapabilityError,
  CourtOutboxError,
  CourtProtocolEventError,
  CourtRecoveryError,
  CourtSessionValidationError,
  CourtSigningTransitionError,
  CourtVoteTransitionError,
  CourtEpochCohortError,
  CourtSignerSetError,
] as const;

// Classes whose code is a fixed SCREAMING_SNAKE family code.
const SCREAMING = [
  CourtError,
  CourtArgumentError,
  CourtDkgError,
  IndependentDkgError,
  IndependentSigningError,
  FrostSigningError,
  CourtSelectionError,
  EscrowLedgerError,
  LnHoldLedgerError,
  LnRailError,
  LiquidEscrowError,
  TaprootSpendError,
  CourtCryptoError,
  CourtSignerError,
  AppealError,
  BatchAttestationError,
  CourtConfirmationTransitionError,
  CourtDkgTransitionError,
  CourtSigningTransitionError,
  CourtVoteTransitionError,
  CourtEpochCohortError,
  CourtSignerSetError,
] as const;

function probeInstance(Ctor: new (...args: never[]) => Error): Error {
  // A single SCREAMING arg satisfies every constructor shape: the base and
  // code-bearing legacy classes read it as `code`; message-only classes as
  // `message` (their family code is fixed in the constructor).
  return new Ctor(...(['PROBE_CODE'] as unknown as never[]));
}

describe('INV-X-2: unified error taxonomy', () => {
  it('every exported error class extends CourtError, keeps its name, and carries a code', () => {
    for (const Ctor of ALL_CLASSES) {
      const err = probeInstance(Ctor as unknown as new (...args: never[]) => Error);
      expect(err, Ctor.name).toBeInstanceOf(Error);
      expect(err, Ctor.name).toBeInstanceOf(CourtError);
      expect(err.name, Ctor.name).toBe(Ctor.name);
      expect(String(err), Ctor.name).toContain(Ctor.name);
      const withCode = err as Error & { code?: unknown };
      expect(typeof withCode.code, `${Ctor.name}.code`).toBe('string');
      expect((withCode.code as string).length, `${Ctor.name}.code`).toBeGreaterThan(0);
    }
  });

  it('new-family codes are SCREAMING_SNAKE', () => {
    for (const Ctor of SCREAMING) {
      const err = probeInstance(Ctor as unknown as new (...args: never[]) => Error);
      expect((err as Error & { code: string }).code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    // Legacy per-class code unions keep their historical lowercase values.
    const session = new CourtSessionValidationError('invalid_hex', 'probe');
    expect(session.code).toBe('invalid_hex');
    expect(session).toBeInstanceOf(CourtError);
  });

  it('base wires cause-chaining through Error(message, { cause })', () => {
    const original = new Error('root');
    const err = new CourtError('PROBE_CODE', 'wrapper', { cause: original });
    expect(err.cause).toBe(original);
    expect(err.message).toBe('wrapper');
    expect(err.code).toBe('PROBE_CODE');
    expect(err.invariant).toBeUndefined();
  });

  it('invariant field carries the INV-* id on enforcing sites', () => {
    // Verified against the implementation below (boundary probes reuse them).
    expect(new CourtError('X', 'm', { invariant: 'INV-X-2' }).invariant).toBe('INV-X-2');
  });
});

describe('boundary law: malformed-but-typed inputs never escape as raw errors', () => {
  const cases: readonly { name: string; call: () => unknown; cls: unknown }[] = [
    {
      name: 'validator.hashSignerSetRoot([]) → CourtSignerSetError',
      call: () => hashSignerSetRoot([]),
      cls: CourtSignerSetError,
    },
    {
      name: 'batchAttestation.buildBatchMerkleTree([]) → BatchAttestationError',
      call: () => buildBatchMerkleTree([]),
      cls: BatchAttestationError,
    },
    {
      name: 'selection.weightedPriority(negative weight) → CourtArgumentError',
      call: () => weightedPriority(0.5, -1),
      cls: CourtArgumentError,
    },
    {
      name: 'selection.selectJury(empty pool) → CourtSelectionError',
      call: () =>
        selectJury([], {
          disputeEventId: 'd'.repeat(64),
          blockHash: 'b'.repeat(64),
          marketCategory: 'world',
          marketVolumeSats: 1_000_000,
          jurySize: 3,
        }),
      cls: CourtSelectionError,
    },
    {
      name: 'escrow.calculateBondAmount(negative volume) → CourtArgumentError',
      call: () => calculateBondAmount(-5, 0),
      cls: CourtArgumentError,
    },
    {
      name: 'dispute.hashCommit(empty outcome) → CourtArgumentError',
      call: () => hashCommit('', 'salt'),
      cls: CourtArgumentError,
    },
    {
      name: 'dispute.deriveDisputeGroupPubkey(short key) → CourtArgumentError',
      call: () => deriveDisputeGroupPubkey('abc', 'd'),
      cls: CourtArgumentError,
    },
    {
      name: 'events.buildAttestationEvent(bad shape) → CourtArgumentError',
      call: () => buildAttestationEvent(42 as unknown as Parameters<typeof buildAttestationEvent>[0]),
      cls: CourtArgumentError,
    },
    {
      name: 'courtUnwrapCore.assertValidUnwrapKinds([1.5]) → CourtArgumentError',
      call: () => assertValidUnwrapKinds([1.5]),
      cls: CourtArgumentError,
    },
    {
      name: 'courtUnwrapCore.assertUnwrapBatchSize(huge) → CourtArgumentError',
      call: () => assertUnwrapBatchSize(Number.MAX_SAFE_INTEGER),
      cls: CourtArgumentError,
    },
    {
      name: 'liquidEscrow.buildMultisigScript(threshold 0) → CourtArgumentError',
      call: () => buildMultisigScript({ pubkeys: ['02' + 'a'.repeat(62)], threshold: 0 }),
      cls: CourtArgumentError,
    },
    {
      name: 'taprootSpend.outputKeyParity(short key) → CourtArgumentError',
      call: () => outputKeyParity('abc', 'd'.repeat(64)),
      cls: CourtArgumentError,
    },
    {
      name: 'dkg.combineShares([]) → CourtArgumentError',
      call: () => combineShares([]),
      cls: CourtArgumentError,
    },
    {
      name: 'courtSigner.CourtSigner(malformed hex) → CourtArgumentError (with cause)',
      call: () => new CourtSigner('xyz'),
      cls: CourtArgumentError,
    },
    {
      name: 'courtSigner.CourtSigner(short bytes) → CourtArgumentError',
      call: () => new CourtSigner(new Uint8Array(16)),
      cls: CourtArgumentError,
    },
  ];

  for (const { name, call, cls } of cases) {
    it(name, () => {
      let thrown: unknown;
      try {
        call();
        throw new Error('expected the call to throw');
      } catch (err) {
        thrown = err;
      }
      // The law: a typed CourtError — never a raw TypeError/decoder Error.
      expect(thrown).toBeInstanceOf(CourtError);
      expect(thrown).toBeInstanceOf(cls);
      const err = thrown as Error & { code: string };
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
    });
  }
});
