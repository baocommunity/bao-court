// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * The bond-gated soak's ASSERTIONS.
 *
 * A scenario that "expects PASS" and is never checked is a scenario that cannot
 * fail — which is the same as no scenario at all. These tests pin the two
 * directions that matter:
 *
 *   - a CORRECT honest artifact and a CORRECT negative artifact both assert
 *     clean (so a real run is not failed by a typo in the expectations);
 *   - every way an artifact could LIE about a bond-gated run — a signature on a
 *     negative run, a key on a refused roster, a missing `bondVerified:true`, a
 *     re-ordered/rewritten bond reference, a missing typed code — is caught.
 *
 * Plus the per-mode bond plan (which bond goes to which seat, including the
 * wrong-seat and legacy-lock presentations) and the cleanup contract.
 */

import { describe, expect, it } from 'vitest';
import {
  assertBondRun,
  assertCleanup,
  bondsForMode,
  formatBondRef,
  seatIndices,
  type BondPlan,
  type RunArtifact,
} from '../scripts/court/soakBondAssertions';

const PLAN: BondPlan = {
  bondSats: 100000,
  jurorKeysDir: '/home/deploy/.bao-court/jurors',
  boxes: ['bao8gb', 'vps16gb', 'bao-testnet'],
  liquid: {
    network: 'testnet',
    courtGroupPubkey: 'ccabb21044676d058dc44c8241941c69f0663f449bb148889d5c68326198dc51',
    asset: '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
  },
  onchain: {
    network: 'testnet',
    courtPubkey: '7245899da3af4aee68a9237fef38c4bf08ce5b572bb99f2cc53cc9383dae84f3',
    bitcoindSsh: 'bao8gb',
  },
  legacyLiquid: { proofRef: 'c2f115659cb4c5e715ba6d1ad8303c5cab4c59a71ca17e63b483c6a3fd9a6b10:0' },
  seats: [
    {
      seat: 1,
      box: 'bao8gb',
      jurorPubkey: '83afd76d1cc2a52933b35112ff3c61bead1f4e9b3db7b025bf0f512f1052d493',
      liquid: '63342daaba79074f0062990ddbd1d3c61f7888114096355bf1df39c19c1a73f2:0',
      onchain: 'd4967edf70e57835891902830da7b6e558a8a5e10a62fba8484e99c1b9dcb267:1',
    },
    {
      seat: 2,
      box: 'vps16gb',
      jurorPubkey: '94532943fe5c0d16d75ee5dbe03521d7e670ac013c002e79c6ed61183421d615',
      liquid: 'be0daf8513c79ea5dcd2001f03e48a37ef938dd58f71a5a11164097d5548c7bb:0',
      onchain: '14f88077e6f2344e9343fe942883f08636529f1b6ab94c33ee81f89528b36100:1',
    },
    {
      seat: 3,
      box: 'bao-testnet',
      jurorPubkey: '8fdb1e222e4460ebc77fc13147797d38eea66243bf07573a2f43a597f2bf84b0',
      liquid: '0bb85a03f412609be677963e1e14d4521732e9e78ffbb868e1ace146baa3bd4b:0',
      onchain: '9d9269efade40d19c8498822a02ee8645a752a68f4215cc875c8ef1d6cf9a22d:1',
    },
  ],
  expectedCodes: {
    liquid: [],
    onchain: [],
    wrongseat: ['BOND_JUROR_MISMATCH', 'BOND_SCRIPT_MISMATCH'],
    unbound: ['BOND_JUROR_UNBOUND'],
    timeout: ['BOND_CHECK_TIMEOUT'],
  },
};

/** A correct HONEST artifact (shape: the driver's `runs[0]`). */
function honestArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    signatureVerified: true,
    groupKey: 'd823cd2aea92344e48d82b62fe09a7ddaa553863c2800c4375aa63d587f2f301',
    signatures: ['8d3b9a1d…33b6'],
    bondGate: {
      enforced: true,
      requireBonds: true,
      admitted: [1, 2, 3],
      excluded: [],
      classification: null,
      verdicts: PLAN.seats.map((seat) => ({
        idx: seat.seat,
        ok: true,
        code: 'BOND_RAIL_PROVEN',
        proofRef: seat.liquid,
      })),
    },
    identities: PLAN.seats.map((seat) => ({
      seat: seat.seat,
      idx: seat.seat,
      box: seat.box,
      pubkey: seat.jurorPubkey,
      bondRef: formatBondRef({ rail: 'liquid', network: 'testnet', proofRef: seat.liquid }),
      bondVerified: true,
      bondCode: 'BOND_RAIL_PROVEN',
    })),
    ...overrides,
  };
}

/** A correct NEGATIVE artifact for `expectation`: seat 1 refused, 2 and 3 admitted. */
function negativeArtifact(
  code: string,
  expectation: ReturnType<typeof bondsForMode>,
  overrides: Partial<RunArtifact> = {},
): RunArtifact {
  return {
    signatureVerified: false,
    groupKey: null,
    signatures: [],
    classification: 'ROSTER_BELOW_THRESHOLD',
    bondGate: {
      enforced: true,
      requireBonds: true,
      admitted: [2, 3],
      excluded: [1],
      classification: 'ROSTER_BELOW_THRESHOLD',
      verdicts: expectation.bonds.map((bond, i) => ({
        idx: i + 1,
        ok: i !== 0,
        code: i === 0 ? code : 'BOND_RAIL_PROVEN',
        proofRef: bond.proofRef,
      })),
    },
    identities: expectation.bonds.map((bond, i) => ({
      idx: i + 1,
      box: PLAN.boxes[i],
      bondRef: formatBondRef(bond),
      bondVerified: i !== 0,
      admitted: i !== 0,
      bondCode: i === 0 ? code : 'BOND_RAIL_PROVEN',
    })),
    ...overrides,
  };
}

describe('the bond plan — which bond backs which seat', () => {
  it('formats a reference the way the roster and the wire carry it', () => {
    expect(formatBondRef({ rail: 'liquid', network: 'testnet', proofRef: 'ab:0' })).toBe('liquid/testnet:ab:0');
  });

  it('liquid: every seat claims its OWN juror-bound Liquid bond, all admitted', () => {
    const expectation = bondsForMode(PLAN, 'liquid');
    expect(expectation.bonds.map((b) => b.rail)).toEqual(['liquid', 'liquid', 'liquid']);
    expect(expectation.bonds.map((b) => b.proofRef)).toEqual(PLAN.seats.map((s) => s.liquid));
    expect(expectation.admittedSeats).toEqual([1, 2, 3]);
    expect(expectation.excludedSeats).toEqual([]);
    expect(expectation.expectSignature).toBe(true);
  });

  it('onchain: every seat claims its OWN 2-of-2 testnet4 bond, all admitted', () => {
    const expectation = bondsForMode(PLAN, 'onchain');
    expect(expectation.bonds.map((b) => b.rail)).toEqual(['onchain', 'onchain', 'onchain']);
    expect(expectation.bonds.map((b) => b.proofRef)).toEqual(PLAN.seats.map((s) => s.onchain));
    expect(expectation.admittedSeats).toEqual([1, 2, 3]);
  });

  it('wrongseat: TWO wrong-seat claims on TWO rails in one run, and the rail order rotates', () => {
    const liquidLead = bondsForMode(PLAN, 'wrongseat', 'liquid');
    // Seat 1 claims seat 2's Liquid bond; seat 2 claims seat 1's testnet4 bond.
    expect(liquidLead.bonds[0]).toEqual({ rail: 'liquid', network: 'testnet', proofRef: PLAN.seats[1].liquid });
    expect(liquidLead.bonds[1]).toEqual({ rail: 'onchain', network: 'testnet', proofRef: PLAN.seats[0].onchain });
    // Seat 3 keeps its own bond, so the stop is the THRESHOLD (not a wipe-out).
    expect(liquidLead.bonds[2].proofRef).toBe(PLAN.seats[2].liquid);
    expect(liquidLead.excludedSeats).toEqual([1, 2]);
    expect(liquidLead.admittedSeats).toEqual([3]);
    expect(liquidLead.codes).toEqual(['BOND_JUROR_MISMATCH', 'BOND_SCRIPT_MISMATCH']);

    const onchainLead = bondsForMode(PLAN, 'wrongseat', 'onchain');
    expect(onchainLead.bonds[0]).toEqual({ rail: 'onchain', network: 'testnet', proofRef: PLAN.seats[1].onchain });
    expect(onchainLead.bonds[1]).toEqual({ rail: 'liquid', network: 'testnet', proofRef: PLAN.seats[0].liquid });
    // Both rails are presented either way: only the ORDER changes.
    expect(new Set(onchainLead.bonds.slice(0, 2).map((b) => b.rail))).toEqual(new Set(['liquid', 'onchain']));
  });

  it('unbound: seat 1 claims the legacy court-only lock, which commits no juror', () => {
    const expectation = bondsForMode(PLAN, 'unbound');
    expect(expectation.bonds[0].proofRef).toBe(PLAN.legacyLiquid.proofRef);
    expect(expectation.excludedSeats).toEqual([1]);
    expect(expectation.admittedSeats).toEqual([2, 3]);
    expect(expectation.codes).toEqual(['BOND_JUROR_UNBOUND']);
  });

  it('timeout: the REAL bonds, claimed honestly — the check is what fails', () => {
    const expectation = bondsForMode(PLAN, 'timeout');
    expect(expectation.bonds.map((b) => b.proofRef)).toEqual(PLAN.seats.map((s) => s.liquid));
    expect(expectation.excludedSeats).toEqual([1, 2, 3]);
    expect(expectation.admittedSeats).toEqual([]);
    expect(expectation.codes).toEqual(['BOND_CHECK_TIMEOUT']);
  });

  it('refuses a plan whose seats do not match its boxes', () => {
    expect(() => bondsForMode({ ...PLAN, boxes: ['a', 'b'] }, 'liquid')).toThrow(/every box needs exactly one bond/);
  });
});

describe('assertBondRun — an honest bond-gated run', () => {
  const expectation = bondsForMode(PLAN, 'liquid');

  it('passes a correct artifact', () => {
    expect(assertBondRun(honestArtifact(), expectation)).toEqual([]);
  });

  it('fails when no signature was verified', () => {
    const failures = assertBondRun(honestArtifact({ signatureVerified: false }), expectation);
    expect(failures.join(' ')).toMatch(/signatureVerified is not true/);
  });

  it('fails when more than one aggregate signature reached the relay', () => {
    const failures = assertBondRun(honestArtifact({ signatures: ['a', 'b'] }), expectation);
    expect(failures.join(' ')).toMatch(/exactly one aggregate signature, got 2/);
  });

  it('fails when the group key is missing', () => {
    expect(assertBondRun(honestArtifact({ groupKey: null }), expectation).join(' ')).toMatch(/groupKey is null/);
  });

  it('fails when a seated juror does not carry bondVerified:true', () => {
    const artifact = honestArtifact();
    const identities = (artifact.identities ?? []).map((i) => (i.seat === 2 ? { ...i, bondVerified: false } : i));
    expect(assertBondRun({ ...artifact, identities }, expectation).join(' ')).toMatch(/seat 2 does not carry bondVerified:true/);
  });

  it('fails when the gate did not run at all', () => {
    const failures = assertBondRun(honestArtifact({ bondGate: { enforced: false } }), expectation);
    expect(failures.join(' ')).toMatch(/bondGate\.enforced is not true/);
  });

  it('fails when a bond reference is not recorded verbatim', () => {
    const artifact = honestArtifact();
    const identities = (artifact.identities ?? []).map((i) => (i.seat === 3
      ? { ...i, bondRef: 'liquid/testnet:0bb85a03…:0' }
      : i));
    expect(assertBondRun({ ...artifact, identities }, expectation).join(' '))
      .toMatch(/seat 3 recorded bond liquid\/testnet:0bb85a03…:0 instead of liquid\/testnet:0bb85a03f412609be677963e1e14d4521732e9e78ffbb868e1ace146baa3bd4b:0/);
  });

  it('fails when a seat was checked against a different outpoint', () => {
    const artifact = honestArtifact({
      bondGate: {
        enforced: true,
        admitted: [1, 2, 3],
        excluded: [],
        verdicts: [{ idx: 1, ok: true, code: 'BOND_RAIL_PROVEN', proofRef: PLAN.seats[1].liquid }],
      },
    });
    expect(assertBondRun(artifact, expectation).join(' ')).toMatch(/seat 1 was checked against/);
  });

  it('fails when a seat has no verdict at all (the check silently never ran)', () => {
    expect(assertBondRun(honestArtifact({ bondGate: { enforced: true, admitted: [1, 2, 3], verdicts: [] } }), expectation)
      .join(' ')).toMatch(/has no bond-check verdict/);
  });
});

describe('assertBondRun — a negative bond-gated run', () => {
  const expectation = bondsForMode(PLAN, 'unbound');

  it('passes a correct refusal artifact', () => {
    expect(assertBondRun(negativeArtifact('BOND_JUROR_UNBOUND', expectation), expectation)).toEqual([]);
  });

  it('fails when a negative run emitted a signature', () => {
    expect(assertBondRun(negativeArtifact('BOND_JUROR_UNBOUND', expectation, { signatureVerified: true }), expectation).join(' '))
      .toMatch(/signatureVerified is not false/);
  });

  it('fails when a negative run emitted signature bytes', () => {
    expect(assertBondRun(negativeArtifact('BOND_JUROR_UNBOUND', expectation, { signatures: ['deadbeef'] }), expectation).join(' '))
      .toMatch(/emitted 1 signature/);
  });

  it('fails when a negative run published a group key', () => {
    expect(assertBondRun(negativeArtifact('BOND_JUROR_UNBOUND', expectation, { groupKey: 'ab'.repeat(32) }), expectation).join(' '))
      .toMatch(/groupKey is not null/);
  });

  it('fails when the EXPECTED typed code is absent', () => {
    expect(assertBondRun(negativeArtifact('BOND_CHECK_REFUSED', expectation), expectation).join(' '))
      .toMatch(/expected typed code BOND_JUROR_UNBOUND is not in the artifact/);
  });

  it('fails when the ceremony did not stop typed', () => {
    const artifact = negativeArtifact('BOND_JUROR_UNBOUND', expectation);
    // Both places the driver records the stop are cleared: either one is
    // authoritative, so a run that stopped without either is not typed at all.
    const bondGate = { ...artifact.bondGate, classification: null, admitted: [2, 3], excluded: [1] };
    expect(assertBondRun({ ...artifact, bondGate, classification: null }, expectation).join(' '))
      .toMatch(/expected the typed stop ROSTER_BELOW_THRESHOLD/);
  });

  it('fails when the wrong seat was excluded', () => {
    const artifact = negativeArtifact('BOND_JUROR_UNBOUND', expectation);
    const bondGate = { ...artifact.bondGate, excluded: [3], admitted: [1, 2] };
    expect(assertBondRun({ ...artifact, bondGate }, expectation).join(' '))
      .toMatch(/seat 1 was expected to be EXCLUDED/);
  });
});

describe('assertBondRun — the wrong-seat run must carry BOTH bindings', () => {
  const expectation = bondsForMode(PLAN, 'wrongseat', 'liquid');

  it('passes when both typed codes are in the artifact', () => {
    const artifact: RunArtifact = {
      signatureVerified: false,
      groupKey: null,
      signatures: [],
      bondGate: {
        enforced: true,
        admitted: [3],
        excluded: [1, 2],
        classification: 'ROSTER_BELOW_THRESHOLD',
        verdicts: [
          { idx: 1, ok: false, code: 'BOND_JUROR_MISMATCH', proofRef: PLAN.seats[1].liquid },
          { idx: 2, ok: false, code: 'BOND_SCRIPT_MISMATCH', proofRef: PLAN.seats[0].onchain },
          { idx: 3, ok: true, code: 'BOND_RAIL_PROVEN', proofRef: PLAN.seats[2].liquid },
        ],
      },
      identities: [
        { idx: 1, bondRef: formatBondRef(expectation.bonds[0]), bondVerified: false, bondCode: 'BOND_JUROR_MISMATCH' },
        { idx: 2, bondRef: formatBondRef(expectation.bonds[1]), bondVerified: false, bondCode: 'BOND_SCRIPT_MISMATCH' },
        { idx: 3, bondRef: formatBondRef(expectation.bonds[2]), bondVerified: true, bondCode: 'BOND_RAIL_PROVEN' },
      ],
    };
    expect(assertBondRun(artifact, expectation)).toEqual([]);
  });

  it('fails when only ONE of the two bindings was exercised', () => {
    const artifact: RunArtifact = {
      signatureVerified: false,
      groupKey: null,
      signatures: [],
      bondGate: {
        enforced: true,
        admitted: [3],
        excluded: [1, 2],
        classification: 'ROSTER_BELOW_THRESHOLD',
        verdicts: [
          { idx: 1, ok: false, code: 'BOND_JUROR_MISMATCH', proofRef: PLAN.seats[1].liquid },
          { idx: 2, ok: false, code: 'BOND_JUROR_MISMATCH', proofRef: PLAN.seats[0].onchain },
          { idx: 3, ok: true, code: 'BOND_RAIL_PROVEN', proofRef: PLAN.seats[2].liquid },
        ],
      },
      identities: [
        { idx: 1, bondRef: formatBondRef(expectation.bonds[0]), bondVerified: false, bondCode: 'BOND_JUROR_MISMATCH' },
        { idx: 2, bondRef: formatBondRef(expectation.bonds[1]), bondVerified: false, bondCode: 'BOND_JUROR_MISMATCH' },
        { idx: 3, bondRef: formatBondRef(expectation.bonds[2]), bondVerified: true, bondCode: 'BOND_RAIL_PROVEN' },
      ],
    };
    expect(assertBondRun(artifact, expectation).join(' ')).toMatch(/BOND_SCRIPT_MISMATCH is not in the artifact/);
  });
});

describe('the stopped-run artifact shape (verdict objects, not indices)', () => {
  const expectation = bondsForMode(PLAN, 'unbound');

  it('normalises admitted/excluded that the driver wrote as verdict objects', () => {
    expect(seatIndices([{ idx: 2 }, 3, { idx: undefined }])).toEqual([2, 3]);
    expect(seatIndices(undefined)).toEqual([]);
  });

  it('still passes when the stopped artifact carries objects instead of indices', () => {
    const artifact = negativeArtifact('BOND_JUROR_UNBOUND', expectation);
    const bondGate = {
      ...artifact.bondGate,
      admitted: [{ idx: 2 }, { idx: 3 }],
      excluded: [{ idx: 1 }],
    };
    expect(assertBondRun({ ...artifact, bondGate }, expectation)).toEqual([]);
  });
});

describe('assertCleanup — zero strays, zero listeners, zero held HTLCs', () => {
  const clean = {
    boxes: [
      { box: 'bao8gb', left: 0, listen: 0 },
      { box: 'vps16gb', left: 0, listen: 0 },
      { box: 'bao-testnet', left: 0, listen: 0 },
    ],
    coordinatorListening: false,
    heldHtlcs: 0,
  };

  it('passes a clean teardown', () => {
    expect(assertCleanup(clean)).toEqual([]);
  });

  it('accepts an unknown HTLC count but never a non-zero one', () => {
    expect(assertCleanup({ ...clean, heldHtlcs: null })).toEqual([]);
    expect(assertCleanup({ ...clean, heldHtlcs: 1 }).join(' ')).toMatch(/1 HTLC\(s\) still held/);
  });

  it('fails on a stray process', () => {
    const boxes = clean.boxes.map((b) => (b.box === 'vps16gb' ? { ...b, left: 2 } : b));
    expect(assertCleanup({ ...clean, boxes }).join(' ')).toMatch(/vps16gb: 2 stray process\(es\)/);
  });

  it('fails on a listener that outlived the run', () => {
    expect(assertCleanup({ ...clean, coordinatorListening: true }).join(' ')).toMatch(/coordinator still has the relay port open/);
  });

  it('fails when the cleanup probe could not answer', () => {
    const boxes = clean.boxes.map((b) => (b.box === 'bao-testnet' ? { box: b.box, left: null, listen: null } : b));
    expect(assertCleanup({ ...clean, boxes }).join(' ')).toMatch(/bao-testnet: the cleanup probe did not answer/);
  });
});
