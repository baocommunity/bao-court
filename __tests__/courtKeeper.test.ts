// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  CourtKeeperError,
  assertKeeperCommitmentForDesignation,
  assertKeeperDesignation,
  commitKeeperSecret,
  designateKeepers,
  encodeKeeperCommitment,
  encodeKeeperDesignation,
  hashKeeperCommitment,
  hashKeeperDesignation,
  hashKeeperSecret,
  keeperCandidateOrder,
  verifyKeeperReveal,
  type CourtKeeperCommitment,
  type CourtKeeperDesignation,
  type DesignateKeepersParams,
} from '../courtKeeper';

const pk = (byte: string): string => byte.repeat(32);

const ROSTER = ['0a', '1b', '2c', '3d', '4e', '5f'].map(pk);
const PARTICIPANTS = [pk('aa'), pk('bb')] as const;
const RECEIVERS = { yes: pk('cc'), no: pk('dd') } as const;

const SEED = '10'.repeat(32);
const OTHER_SEED = '20'.repeat(32);
const MANIFEST = '22'.repeat(32);
const CONTRACT_ID = 'contract-1';

const SECRET_YES = 'a1'.repeat(32);
const SECRET_NO = 'b2'.repeat(32);

function baseParams(overrides: Partial<DesignateKeepersParams> = {}): DesignateKeepersParams {
  return {
    seed: SEED,
    manifestHash: MANIFEST,
    contractId: CONTRACT_ID,
    roster: ROSTER,
    contractParticipants: PARTICIPANTS,
    branchReceivers: RECEIVERS,
    exposedPubkeys: [],
    ...overrides,
  };
}

function baseExclusions(overrides: Partial<DesignateKeepersParams> = {}) {
  const params = baseParams(overrides);
  return {
    contractParticipants: params.contractParticipants,
    branchReceivers: params.branchReceivers,
    exposedPubkeys: params.exposedPubkeys,
  };
}

function baseDesignation(overrides: Partial<CourtKeeperDesignation> = {}): CourtKeeperDesignation {
  const { keeperYes, keeperNo } = designateKeepers(baseParams());
  return {
    seed: SEED,
    manifestHash: MANIFEST,
    contractId: CONTRACT_ID,
    keeperYes,
    keeperNo,
    yesCommitment: hashKeeperSecret(SECRET_YES),
    noCommitment: hashKeeperSecret(SECRET_NO),
    ...overrides,
  };
}

function expectKeeperError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtKeeperError);
    expect((error as CourtKeeperError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtKeeperError with code ${code}`);
}

describe('keeper designation', () => {
  it('is deterministic for the same seed and params', () => {
    const first = designateKeepers(baseParams());
    const second = designateKeepers(baseParams());
    expect(first).toEqual(second);
    expect(ROSTER).toContain(first.keeperYes);
    expect(ROSTER).toContain(first.keeperNo);
    expect(first.keeperYes).not.toBe(first.keeperNo);
  });

  it('derives distinct keepers from distinct seeds', () => {
    const a = designateKeepers(baseParams());
    const b = designateKeepers(baseParams({ seed: OTHER_SEED }));
    // Not a strict protocol rule, but an avalanche sanity check on the stream.
    expect(a).not.toEqual(b);
  });

  it('designates the first stream candidates eligible for each branch', () => {
    const order = keeperCandidateOrder(baseParams());
    const pair = designateKeepers(baseParams());
    expect(pair.keeperYes).toBe(order[0]);
    expect(pair.keeperNo).toBe(order[1]);
  });

  it('skips contract participants during the draw', () => {
    const order = keeperCandidateOrder(baseParams());
    const pair = designateKeepers(baseParams({ contractParticipants: [order[0]!, pk('aa')] }));
    expect(pair.keeperYes).toBe(order[1]);
    expect(pair.keeperNo).toBe(order[2]);
    expect([pair.keeperYes, pair.keeperNo]).not.toContain(order[0]);
  });

  it('skips the receiver of the funds locked to the kept secret', () => {
    const order = keeperCandidateOrder(baseParams());
    const pair = designateKeepers(
      baseParams({ branchReceivers: { yes: order[0]!, no: pk('dd') } }),
    );
    // order[0] receives the yes funds, so it cannot keep the yes secret but
    // remains a valid keeper for the no branch.
    expect(pair.keeperYes).toBe(order[1]);
    expect(pair.keeperNo).toBe(order[0]);

    const mirrored = designateKeepers(
      baseParams({ branchReceivers: { yes: pk('cc'), no: order[0]! } }),
    );
    expect(mirrored.keeperYes).toBe(order[0]);
    expect(mirrored.keeperNo).toBe(order[1]);
  });

  it('skips jurors with economic exposure', () => {
    const order = keeperCandidateOrder(baseParams());
    const pair = designateKeepers(baseParams({ exposedPubkeys: [order[0]!] }));
    expect(pair.keeperYes).toBe(order[1]);
    expect(pair.keeperNo).toBe(order[2]);
  });

  it('never designates the same juror for both branches', () => {
    const roster = [pk('0a'), pk('1b')];
    const pair = designateKeepers(baseParams({ roster }));
    expect(pair.keeperYes).not.toBe(pair.keeperNo);
  });

  it('throws roster_exhausted when fewer than two eligible jurors remain', () => {
    const roster = [pk('0a'), pk('1b')];
    expectKeeperError(
      () => designateKeepers(baseParams({ roster, contractParticipants: [pk('0a'), pk('aa')] })),
      'roster_exhausted',
    );
    expectKeeperError(
      () => designateKeepers(baseParams({ roster, exposedPubkeys: [pk('0a')] })),
      'roster_exhausted',
    );
    // One juror excluded as both-branch receiver leaves a single eligible keeper.
    expectKeeperError(
      () =>
        designateKeepers(
          baseParams({ roster, branchReceivers: { yes: pk('0a'), no: pk('0a') } }),
        ),
      'roster_exhausted',
    );
    expectKeeperError(() => designateKeepers(baseParams({ roster: [] })), 'roster_exhausted');
  });

  it('rejects malformed designation params', () => {
    expectKeeperError(() => designateKeepers(baseParams({ seed: 'zz' })), 'invalid_params');
    expectKeeperError(
      () => designateKeepers(baseParams({ manifestHash: 'AB'.repeat(32) })),
      'invalid_params',
    );
    expectKeeperError(() => designateKeepers(baseParams({ contractId: '' })), 'invalid_params');
    expectKeeperError(
      () => designateKeepers(baseParams({ contractId: ' padded ' })),
      'invalid_params',
    );
    expectKeeperError(
      () => designateKeepers(baseParams({ roster: [ROSTER[1]!, ROSTER[0]!] })),
      'invalid_params',
    );
    expectKeeperError(
      () => designateKeepers(baseParams({ roster: [ROSTER[0]!, ROSTER[0]!] })),
      'invalid_params',
    );
    expectKeeperError(
      () => designateKeepers(baseParams({ contractParticipants: [pk('aa')] })),
      'invalid_params',
    );
    expectKeeperError(
      () => designateKeepers(baseParams({ contractParticipants: [pk('aa'), pk('aa')] })),
      'invalid_params',
    );
  });
});

describe('keeper designation records', () => {
  it('hashes deterministically and commits to every field', () => {
    const designation = baseDesignation();
    const hash = hashKeeperDesignation(designation);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKeeperDesignation(baseDesignation())).toBe(hash);

    const flips: Array<Partial<CourtKeeperDesignation>> = [
      { seed: OTHER_SEED },
      { manifestHash: '33'.repeat(32) },
      { contractId: 'contract-2' },
      { keeperYes: designation.keeperNo },
      { keeperNo: designation.keeperYes },
      { yesCommitment: hashKeeperSecret(SECRET_NO) },
      { noCommitment: hashKeeperSecret(SECRET_YES) },
    ];
    for (const flip of flips) {
      expect(hashKeeperDesignation(baseDesignation(flip))).not.toBe(hash);
    }
  });

  it('encodes canonically', () => {
    const designation = baseDesignation();
    expect(encodeKeeperDesignation(designation)).toEqual(encodeKeeperDesignation(designation));
  });

  it('accepts a valid designation under assertKeeperDesignation', () => {
    expect(() => assertKeeperDesignation(baseDesignation(), baseExclusions(), ROSTER)).not.toThrow();
  });

  it('rejects designations violating each exclusion class', () => {
    const designation = baseDesignation();
    expectKeeperError(
      () =>
        assertKeeperDesignation(
          designation,
          baseExclusions({ contractParticipants: [designation.keeperYes, pk('aa')] }),
          ROSTER,
        ),
      'keeper_not_designated',
    );
    expectKeeperError(
      () =>
        assertKeeperDesignation(
          designation,
          baseExclusions({ branchReceivers: { yes: designation.keeperYes, no: pk('dd') } }),
          ROSTER,
        ),
      'keeper_not_designated',
    );
    expectKeeperError(
      () =>
        assertKeeperDesignation(
          designation,
          baseExclusions({ branchReceivers: { yes: pk('cc'), no: designation.keeperNo } }),
          ROSTER,
        ),
      'keeper_not_designated',
    );
    expectKeeperError(
      () => assertKeeperDesignation(designation, baseExclusions({ exposedPubkeys: [designation.keeperNo] }), ROSTER),
      'keeper_not_designated',
    );
    expectKeeperError(
      () =>
        assertKeeperDesignation(
          { ...designation, keeperNo: designation.keeperYes },
          baseExclusions(),
          ROSTER,
        ),
      'keeper_not_designated',
    );
  });

  it('rejects malformed designation records', () => {
    expectKeeperError(
      () => hashKeeperDesignation(baseDesignation({ keeperYes: 'zz' })),
      'invalid_params',
    );
    expectKeeperError(
      () => assertKeeperDesignation({ ...baseDesignation(), extra: 1 }, baseExclusions(), ROSTER),
      'invalid_params',
    );
  });

  it('rejects forged designations naming eligible but non-drawn keepers', () => {
    const drawn = designateKeepers(baseParams());
    const forgedSwap = baseDesignation({ keeperYes: drawn.keeperNo, keeperNo: drawn.keeperYes });
    expectKeeperError(
      () => assertKeeperDesignation(forgedSwap, baseExclusions(), ROSTER),
      'keeper_not_designated',
    );

    // An arbitrary eligible juror who was not drawn is still a forgery.
    const order = keeperCandidateOrder(baseParams());
    const eligibleNotDrawn = order.find(
      (candidate) =>
        candidate !== drawn.keeperYes &&
        candidate !== drawn.keeperNo &&
        !PARTICIPANTS.includes(candidate) &&
        candidate !== RECEIVERS.yes,
    );
    expect(eligibleNotDrawn).toBeDefined();
    const forgedOther = baseDesignation({ keeperYes: eligibleNotDrawn! });
    expectKeeperError(
      () => assertKeeperDesignation(forgedOther, baseExclusions(), ROSTER),
      'keeper_not_designated',
    );
  });

  it('rejects a designation validated against the wrong roster', () => {
    const designation = baseDesignation();
    // Drop the drawn keeper_yes: the draw over this roster must differ.
    const wrongRoster = ROSTER.filter((pubkey) => pubkey !== designation.keeperYes);
    expectKeeperError(
      () => assertKeeperDesignation(designation, baseExclusions(), wrongRoster),
      'keeper_not_designated',
    );
  });
});

describe('keeper commitments and reveals', () => {
  function baseCommitment(overrides: Partial<CourtKeeperCommitment> = {}): CourtKeeperCommitment {
    return commitKeeperSecret({
      designationHash: hashKeeperDesignation(baseDesignation()),
      branch: 'yes',
      secretHash: hashKeeperSecret(SECRET_YES),
      ...overrides,
    });
  }

  it('verifies a reveal against its commitment', () => {
    const commitment = baseCommitment();
    expect(verifyKeeperReveal({ commitment, secret: SECRET_YES, branch: 'yes' })).toBe(true);
  });

  it('rejects reveals for the wrong branch', () => {
    const commitment = baseCommitment();
    expectKeeperError(
      () => verifyKeeperReveal({ commitment, secret: SECRET_YES, branch: 'no' }),
      'wrong_branch',
    );
  });

  it('rejects reveals whose secret does not match the commitment', () => {
    const commitment = baseCommitment();
    expectKeeperError(
      () => verifyKeeperReveal({ commitment, secret: SECRET_NO, branch: 'yes' }),
      'reveal_mismatch',
    );
  });

  it('rejects malformed secrets and commitments', () => {
    const commitment = baseCommitment();
    expectKeeperError(
      () => verifyKeeperReveal({ commitment, secret: 'abcd', branch: 'yes' }),
      'invalid_params',
    );
    expectKeeperError(
      () => verifyKeeperReveal({ commitment: { ...commitment, branch: 'maybe' as never }, secret: SECRET_YES, branch: 'yes' }),
      'invalid_params',
    );
    expectKeeperError(
      () => commitKeeperSecret({ designationHash: 'zz', branch: 'yes', secretHash: hashKeeperSecret(SECRET_YES) }),
      'invalid_params',
    );
  });

  it('hashes commitments canonically and deterministically', () => {
    const commitment = baseCommitment();
    expect(hashKeeperCommitment(commitment)).toMatch(/^[0-9a-f]{64}$/);
    expect(encodeKeeperCommitment(commitment)).toEqual(encodeKeeperCommitment(commitment));
    expect(hashKeeperCommitment(baseCommitment({ branch: 'no' }))).not.toBe(
      hashKeeperCommitment(commitment),
    );
  });

  it('binds commitments to their designation', () => {
    const designation = baseDesignation();
    const commitment = baseCommitment();
    expect(() =>
      assertKeeperCommitmentForDesignation({ designation, commitment }),
    ).not.toThrow();

    const otherDesignation = baseDesignation({ contractId: 'contract-2' });
    expectKeeperError(
      () => assertKeeperCommitmentForDesignation({ designation: otherDesignation, commitment }),
      'commitment_mismatch',
    );
    expectKeeperError(
      () =>
        assertKeeperCommitmentForDesignation({
          designation,
          commitment: { ...commitment, secretHash: hashKeeperSecret(SECRET_NO) },
        }),
      'commitment_mismatch',
    );
  });

  it('computes the secret commitment as SHA-256 of the secret bytes', () => {
    expect(hashKeeperSecret(SECRET_YES)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKeeperSecret(SECRET_YES)).not.toBe(hashKeeperSecret(SECRET_NO));
    expectKeeperError(() => hashKeeperSecret(SECRET_YES.toUpperCase()), 'invalid_params');
  });
});
