// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  deriveSelectionSeed,
  jurorRandomValue,
  selectJury,
  selectJuryWithBackups,
  verifyJurySelection,
} from '../selection';
import type { JurorProfile } from '../types';

function makeJuror(pubkeySuffix: string, category = 'world'): JurorProfile {
  return {
    nostrPubkey: '0'.repeat(63) + pubkeySuffix,
    stakeCapacitySats: 100_000,
    stakeCommitment: {
      amountSats: 100_000,
      bondAddress: 'bc1q...',
      status: 'confirmed',
      committedAt: 1_700_000_000,
    },
    wotScore: 80,
    categories: [category],
    registeredAt: 1_600_000_000,
  };
}

describe('jury selection', () => {
  const pool: JurorProfile[] = [
    makeJuror('1'),
    makeJuror('2'),
    makeJuror('3'),
    makeJuror('4'),
    makeJuror('5'),
  ];

  it('deriveSelectionSeed is deterministic', () => {
    const a = deriveSelectionSeed('a'.repeat(64), 'b'.repeat(64));
    const b = deriveSelectionSeed('a'.repeat(64), 'b'.repeat(64));
    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
  });

  it('jurorRandomValue returns a number in [0, 1)', () => {
    const seed = deriveSelectionSeed('a'.repeat(64), 'b'.repeat(64));
    const r = jurorRandomValue(seed, '0'.repeat(64));
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it('selectJury returns a deterministic subset', () => {
    const params = {
      disputeEventId: 'd'.repeat(64),
      blockHash: 'b'.repeat(64),
      marketCategory: 'world',
      marketVolumeSats: 1_000_000,
      jurySize: 3,
    };

    const a = selectJury(pool, params);
    const b = selectJury(pool, params);
    expect(a).toHaveLength(3);
    expect(a).toEqual(b);
    expect(new Set(a.map((j) => j.idx)).size).toBe(3);
  });

  it('selectJuryWithBackups separates selected and backups', () => {
    const result = selectJuryWithBackups(pool, {
      disputeEventId: 'd'.repeat(64),
      blockHash: 'b'.repeat(64),
      marketCategory: 'world',
      marketVolumeSats: 1_000_000,
      jurySize: 3,
      backupCount: 2,
    });

    expect(result.selected).toHaveLength(3);
    expect(result.backups.length).toBeGreaterThan(0);

    const selectedPubkeys = new Set(result.selected.map((j) => j.nostrPubkey));
    expect(result.backups.every((j) => !selectedPubkeys.has(j.nostrPubkey))).toBe(true);
  });

  it('verifyJurySelection confirms a valid selection', () => {
    const params = {
      disputeEventId: 'd'.repeat(64),
      blockHash: 'b'.repeat(64),
      marketCategory: 'world',
      marketVolumeSats: 1_000_000,
      jurySize: 3,
    };
    const selected = selectJury(pool, params);
    expect(verifyJurySelection(pool, selected, params)).toBe(true);
  });

  it('selectJury throws when the pool is too small', () => {
    expect(() =>
      selectJury(pool.slice(0, 2), {
        disputeEventId: 'd'.repeat(64),
        blockHash: 'b'.repeat(64),
        marketCategory: 'world',
        marketVolumeSats: 1_000_000,
        jurySize: 3,
      }),
    ).toThrow('Insufficient eligible jurors');
  });

  it('selectJury excludes jurors with unconfirmed stake commitments', () => {
    const pendingPool: JurorProfile[] = pool.map((j) => ({
      ...j,
      stakeCommitment: { ...j.stakeCommitment, status: 'pending' as const },
    }));
    const params = {
      disputeEventId: 'd'.repeat(64),
      blockHash: 'b'.repeat(64),
      marketCategory: 'world',
      marketVolumeSats: 1_000_000,
      jurySize: 3,
    };
    expect(() => selectJury(pendingPool, params)).toThrow('Insufficient eligible jurors');
  });
});
