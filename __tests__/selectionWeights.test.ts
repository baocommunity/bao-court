// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  filterEligibleJurors,
  jurorRandomValue,
  quadraticPriority,
  selectJury,
  selectJuryWithBackups,
  verifyJurySelection,
  weightedPriority,
} from '../selection';
import { deriveSelectionSeed } from '../selection';
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

const BASE_PARAMS = {
  disputeEventId: 'd'.repeat(64),
  blockHash: 'b'.repeat(64),
  marketCategory: 'world',
  marketVolumeSats: 1_000_000,
  jurySize: 3,
};

/** Distinct 32-byte hex dispute id per trial, so each trial is a fresh seed. */
function trialDisputeId(i: number): string {
  return i.toString(16).padStart(64, '0');
}

describe('weightFn mode — default path unchanged', () => {
  it('without weightFn the panel matches the quadraticPriority expectations exactly', () => {
    const pool = [
      { ...makeJuror('1'), stakeCapacitySats: 10_000 },
      { ...makeJuror('2'), stakeCapacitySats: 400_000 },
      { ...makeJuror('3'), stakeCapacitySats: 90_000 },
      { ...makeJuror('4'), stakeCapacitySats: 1_000_000 },
      { ...makeJuror('5'), stakeCapacitySats: 50_000 },
    ];
    const seed = deriveSelectionSeed(BASE_PARAMS.disputeEventId, BASE_PARAMS.blockHash);
    const expected = pool
      .map((j) => ({
        pubkey: j.nostrPubkey,
        priority: quadraticPriority(jurorRandomValue(seed, j.nostrPubkey), j.stakeCapacitySats),
      }))
      .sort((a, b) => a.priority - b.priority || (a.pubkey < b.pubkey ? -1 : 1))
      .slice(0, 3);

    const selected = selectJury(pool, BASE_PARAMS);
    expect(selected.map((j) => j.nostrPubkey)).toEqual(expected.map((e) => e.pubkey));
    expect(selected.map((j) => j.priority)).toEqual(expected.map((e) => e.priority));
    expect(verifyJurySelection(pool, selected, BASE_PARAMS)).toBe(true);
  });
});

describe('weightFn mode — determinism and weighting', () => {
  it('same seed + same weightFn → same roster (deterministic)', () => {
    const pool = [makeJuror('1'), makeJuror('2'), makeJuror('3'), makeJuror('4')];
    const weightFn = (j: JurorProfile) => (j.nostrPubkey.endsWith('1') ? 10 : 1);
    const params = { ...BASE_PARAMS, weightFn };
    const a = selectJury(pool, params);
    const b = selectJury(pool, params);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
  });

  it('a 4× weight is drawn ~4× as often over many seeds (statistical, tolerance)', () => {
    const strong = makeJuror('a');
    const weak = makeJuror('b');
    const weightFn = (j: JurorProfile) => (j.nostrPubkey === strong.nostrPubkey ? 4 : 1);
    const params = { ...BASE_PARAMS, jurySize: 1, weightFn };
    const trials = 3000;
    let strongWins = 0;
    for (let i = 0; i < trials; i++) {
      const [winner] = selectJury([strong, weak], {
        ...params,
        disputeEventId: trialDisputeId(i + 1),
      });
      if (winner!.nostrPubkey === strong.nostrPubkey) strongWins++;
    }
    // observed odds ratio vs the exact 4:1 expectation; 25% tolerance on
    // 3000 trials is far wider than the binomial noise (~±1.8% at 3σ on p).
    const ratio = strongWins / (trials - strongWins);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
  });

  it('a zero-weight juror is never drawn', () => {
    const heavy = makeJuror('1');
    const zero = makeJuror('2');
    const weightFn = (j: JurorProfile) => (j.nostrPubkey === zero.nostrPubkey ? 0 : 5);
    const params = { ...BASE_PARAMS, jurySize: 1, weightFn };
    for (let i = 0; i < 500; i++) {
      const [winner] = selectJury([heavy, zero], {
        ...params,
        disputeEventId: trialDisputeId(i + 1),
      });
      expect(winner!.nostrPubkey).toBe(heavy.nostrPubkey);
    }
    // And the filter reports the zero-weight juror as ineligible outright.
    const eligible = filterEligibleJurors([heavy, zero], {
      ...BASE_PARAMS,
      backupCount: 2,
      minWotScore: 80,
      minAccountAgeDays: 7,
      minStakeSats: 10_000,
      excludedPubkeys: [],
      referenceTimeSec: 1_700_000_000,
      weightFn,
    });
    expect(eligible.map((j) => j.nostrPubkey)).toEqual([heavy.nostrPubkey]);
  });

  it('selectJuryWithBackups honours weights and stays deterministic', () => {
    const pool = [makeJuror('1'), makeJuror('2'), makeJuror('3'), makeJuror('4'), makeJuror('5')];
    const weightFn = (j: JurorProfile) => (j.nostrPubkey.endsWith('1') ? 100 : 1);
    const params = { ...BASE_PARAMS, jurySize: 2, backupCount: 2, weightFn };
    const a = selectJuryWithBackups(pool, params);
    const b = selectJuryWithBackups(pool, params);
    expect(a).toEqual(b);
    expect(a.selected[0]!.nostrPubkey).toBe(pool[0]!.nostrPubkey);
  });
});

describe('zeroStakeAllowed — phase-0 zero-stake pools', () => {
  // Zero-stake juror: passes minStakeSats only because the caller lowers it
  // (zeroStakeAllowed waives ONLY the 1%-volume gate).
  const zeroStake: JurorProfile = {
    ...makeJuror('9'),
    stakeCapacitySats: 0,
    stakeCommitment: { ...makeJuror('9').stakeCommitment, amountSats: 0 },
  };
  const resolved = {
    ...BASE_PARAMS,
    backupCount: 2,
    minWotScore: 80,
    minAccountAgeDays: 7,
    minStakeSats: 0,
    excludedPubkeys: [],
    referenceTimeSec: 1_700_000_000,
  };

  it('zero-stake juror is ineligible without the flag (1%-volume gate holds)', () => {
    const weightFn = () => 1;
    expect(
      filterEligibleJurors([makeJuror('1'), zeroStake], resolved).map((j) => j.nostrPubkey),
    ).toEqual([makeJuror('1').nostrPubkey]);
    expect(() =>
      selectJury([makeJuror('1'), zeroStake], { ...BASE_PARAMS, minStakeSats: 0, weightFn }),
    ).toThrow('Insufficient eligible jurors');
  });

  it('zero-stake juror is eligible with the flag, gate waived only in that mode', () => {
    const weightFn = () => 1;
    const flagged = { ...resolved, zeroStakeAllowed: true };
    const eligible = filterEligibleJurors([makeJuror('1'), zeroStake], flagged);
    expect(eligible.map((j) => j.nostrPubkey)).toEqual([
      makeJuror('1').nostrPubkey,
      zeroStake.nostrPubkey,
    ]);
    // Selection + verification round-trip in the zero-stake pool.
    const zeroOnlyParams = {
      ...BASE_PARAMS,
      jurySize: 1,
      minStakeSats: 0,
      zeroStakeAllowed: true,
      weightFn: (j: JurorProfile) => (j.nostrPubkey === zeroStake.nostrPubkey ? 3 : 1),
    };
    const selected = selectJury([makeJuror('1'), zeroStake], zeroOnlyParams);
    expect(selected).toHaveLength(1);
    expect(verifyJurySelection([makeJuror('1'), zeroStake], selected, zeroOnlyParams)).toBe(true);
  });

  it('the 1%-volume gate still applies with the flag off even in weightFn mode', () => {
    // A small-stake (but not zero) juror below 1% of market volume.
    const small = { ...makeJuror('8'), stakeCapacitySats: 5_000 };
    const weightFn = () => 10;
    expect(
      filterEligibleJurors([makeJuror('1'), small], { ...resolved, weightFn }).map(
        (j) => j.nostrPubkey,
      ),
    ).toEqual([makeJuror('1').nostrPubkey]);
    expect(
      filterEligibleJurors([makeJuror('1'), small], {
        ...resolved,
        weightFn,
        zeroStakeAllowed: true,
      }).map((j) => j.nostrPubkey),
    ).toEqual([makeJuror('1').nostrPubkey, small.nostrPubkey]);
  });
});

describe('weightFn validation — fail-closed', () => {
  const pool = [makeJuror('1'), makeJuror('2')];

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -0.5],
  ])('%s weight throws at selection time', (_name, bad) => {
    expect(() =>
      selectJury(pool, { ...BASE_PARAMS, weightFn: () => bad as number }),
    ).toThrow('Invalid juror weight');
  });

  it('weightedPriority itself fail-closes on bad weights', () => {
    expect(() => weightedPriority(0.5, Number.NaN)).toThrow('Invalid juror weight');
    expect(() => weightedPriority(0.5, -1)).toThrow('Invalid juror weight');
    expect(() => weightedPriority(0.5, 0)).toThrow('Invalid juror weight');
  });
});

describe('verifyJurySelection round-trips in BOTH modes', () => {
  const pool = [makeJuror('1'), makeJuror('2'), makeJuror('3'), makeJuror('4')];

  it('default mode round-trips', () => {
    const selected = selectJury(pool, BASE_PARAMS);
    expect(verifyJurySelection(pool, selected, BASE_PARAMS)).toBe(true);
  });

  it('weightFn mode round-trips when the verifier passes the same params', () => {
    const weightFn = (j: JurorProfile) =>
      1 + (Number.parseInt(j.nostrPubkey.slice(-1), 16) % 5);
    const params = { ...BASE_PARAMS, weightFn, zeroStakeAllowed: false };
    const selected = selectJury(pool, params);
    expect(verifyJurySelection(pool, selected, params)).toBe(true);
    // A verifier WITHOUT the weightFn cannot reproduce the weighted roster.
    expect(verifyJurySelection(pool, selected, BASE_PARAMS)).toBe(false);
  });
});
