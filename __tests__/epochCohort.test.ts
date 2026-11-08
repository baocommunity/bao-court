// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import {
  COURT_EPOCH_COHORT_DOMAIN,
  CourtEpochCohortError,
  assertEpochRotationOrdering,
  createCourtEpochCohort,
  hashCourtEpochCohort,
  hashCourtEpochHandoff,
  type CourtEpochCohort,
} from '../epochCohort';
import { CanonicalWriter } from '../courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const hex = (c: string): string => c.repeat(64);

function cohort(overrides: Partial<CourtEpochCohort> = {}): CourtEpochCohort {
  return createCourtEpochCohort({
    epochId: 1,
    cohortIndex: 0,
    cohortPubkey: hex('a'),
    threshold: 135,
    participantCount: 201,
    startsAtSec: 1_000,
    endsAtSec: 1_000 + 14 * 86_400,
    suite: 'pedpop-v1-experimental',
    ...overrides,
  });
}

describe('createCourtEpochCohort', () => {
  it('accepts a valid cohort and freezes it', () => {
    const c = cohort();
    expect(Object.isFrozen(c)).toBe(true);
    expect(c.threshold).toBe(135);
  });

  it('rejects malformed fields fail-closed', () => {
    expect(() => cohort({ cohortPubkey: 'zz' })).toThrow(/32-byte lowercase hex/);
    expect(() => cohort({ threshold: 0 })).toThrow(/at least 1/);
    expect(() => cohort({ threshold: 202 })).toThrow(/must not exceed participantCount/);
    expect(() => cohort({ participantCount: 0 })).toThrow(/\[1, 300\]/);
    expect(() => cohort({ participantCount: 301 })).toThrow(/unanimous-DKG cap/);
    expect(() => cohort({ endsAtSec: 1_000 })).toThrow(/later than startsAtSec/);
    expect(() => cohort({ suite: '' })).toThrow(/non-empty bounded string/);
    expect(() => cohort({ epochId: -1 })).toThrow(/epochId/);
    expect(() => cohort({ epochId: 2 ** 32 })).toThrow(/epochId/);
    expect(() => cohort({ startsAtSec: -5 })).toThrow(/startsAtSec/);
  });
});

describe('hashCourtEpochCohort', () => {
  it('matches an independent canonical recomputation', () => {
    const c = cohort();
    const writer = new CanonicalWriter();
    writer.u8(1);
    writer.u32(c.epochId);
    writer.u32(c.cohortIndex);
    writer.hex(c.cohortPubkey);
    writer.u32(c.threshold);
    writer.u32(c.participantCount);
    writer.u64(c.startsAtSec);
    writer.u64(c.endsAtSec);
    writer.text(c.suite);
    const prefix = new TextEncoder().encode(COURT_EPOCH_COHORT_DOMAIN);
    const encoded = writer.finish();
    const input = new Uint8Array(prefix.length + encoded.length);
    input.set(prefix, 0);
    input.set(encoded, prefix.length);
    expect(hashCourtEpochCohort(c)).toBe(bytesToHex(sha256(input)));
  });

  it('binds every field — changing any one changes the hash', () => {
    const base = hashCourtEpochCohort(cohort());
    expect(hashCourtEpochCohort(cohort({ epochId: 2 }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ cohortIndex: 1 }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ cohortPubkey: hex('b') }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ threshold: 134 }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ participantCount: 200 }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ startsAtSec: 1_001 }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ endsAtSec: 1_000 + 14 * 86_400 + 1 }))).not.toBe(base);
    expect(hashCourtEpochCohort(cohort({ suite: 'chilldkg-0.3+bip445-draft' }))).not.toBe(base);
  });

  it('is deterministic', () => {
    expect(hashCourtEpochCohort(cohort())).toBe(hashCourtEpochCohort(cohort()));
  });
});

describe('epoch rotation ordering', () => {
  const old = cohort({ epochId: 7, cohortPubkey: hex('a'), startsAtSec: 10_000 });

  it('accepts a correct rotation and returns the previous cohort hash', () => {
    const next = cohort({ epochId: 8, cohortPubkey: hex('b'), startsAtSec: 10_000 + 86_400 });
    expect(assertEpochRotationOrdering(old, next)).toBe(hashCourtEpochCohort(old));
  });

  it('rejects non-sequential epoch ids', () => {
    const next = cohort({ epochId: 9, cohortPubkey: hex('b'), startsAtSec: 20_000 });
    expect(() => assertEpochRotationOrdering(old, next)).toThrow(/exactly one/);
  });

  it('rejects same-key rotation — it is a no-op, never an epoch', () => {
    const next = cohort({ epochId: 8, cohortPubkey: hex('a'), startsAtSec: 20_000 });
    expect(() => assertEpochRotationOrdering(old, next)).toThrow(/never an epoch/);
  });

  it('rejects time going backwards', () => {
    const next = cohort({ epochId: 8, cohortPubkey: hex('b'), startsAtSec: 9_000 });
    expect(() => assertEpochRotationOrdering(old, next)).toThrow(/move forward/);
  });
});

describe('hashCourtEpochHandoff', () => {
  it('binds both cohorts and the activation time', () => {
    const h = hashCourtEpochHandoff({
      previousCohortHash: hex('a'),
      nextCohortHash: hex('b'),
      activatedAtSec: 20_000,
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      hashCourtEpochHandoff({ previousCohortHash: hex('a'), nextCohortHash: hex('b'), activatedAtSec: 20_001 }),
    ).not.toBe(h);
    expect(
      hashCourtEpochHandoff({ previousCohortHash: hex('b'), nextCohortHash: hex('a'), activatedAtSec: 20_000 }),
    ).not.toBe(h);
  });

  it('rejects malformed hashes and times', () => {
    expect(() => hashCourtEpochHandoff({ previousCohortHash: 'zz', nextCohortHash: hex('b'), activatedAtSec: 1 })).toThrow();
    expect(() => hashCourtEpochHandoff({ previousCohortHash: hex('a'), nextCohortHash: 'zz', activatedAtSec: 1 })).toThrow();
    expect(() => hashCourtEpochHandoff({ previousCohortHash: hex('a'), nextCohortHash: hex('b'), activatedAtSec: -1 })).toThrow();
  });
});
