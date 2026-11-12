// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * The ceremony bond gate: a pluggable, host-verified proof per juror.
 *
 * These tests are the CONTRACT — the argv a host command receives, the strict
 * output parser, and the fail-closed roster decision (exclusion before the DKG,
 * `ROSTER_BELOW_THRESHOLD` when the survivors cannot reach the threshold). The
 * gate itself never talks to a chain: that is the host's job, and these tests
 * pin both sides of that boundary.
 */

import { describe, expect, it } from 'vitest';

import {
  BOND_CHECK_ENV,
  buildBondCheckArgs,
  gateRosterOnBonds,
  parseBondCheckOutput,
  type BondCheckVerdict,
  type JurorBondClaim,
} from '../bondCheckGate';
import { parseCourtBondRef } from '../bondVerification';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);

const LIQUID_BOND = parseCourtBondRef({
  rail: 'liquid',
  network: 'testnet',
  proofRef: '0f1186fabb1fbeb1862f67edadedb291f0a41a0bc0ca5936c3f1028577465d2a:0',
});

function claim(idx: number, pubkey: string, bond = LIQUID_BOND): JurorBondClaim {
  return { idx, pubkey, bond };
}

function proven(proofRef: string, sources = ['blockstream', 'liquid-network']): BondCheckVerdict {
  return { ok: true, code: null, detail: null, proofRef, sources };
}

describe('bond gate — the invocation contract', () => {
  it('names the environment variable the host command lives in', () => {
    expect(BOND_CHECK_ENV).toBe('BAO_COURT_BOND_CHECK_CMD');
  });

  it('appends the documented flags, in a fixed order', () => {
    expect(
      buildBondCheckArgs({
        rail: 'liquid',
        network: 'testnet',
        proofRef: 'abc:0',
        bondSats: 4140,
        jurorPubkey: PUBKEY_A,
      }),
    ).toEqual([
      '--rail=liquid',
      '--network=testnet',
      '--proof=abc:0',
      '--bond-sats=4140',
      '--juror-pubkey=' + PUBKEY_A,
    ]);
  });

  it('refuses to build an argv from an unknown rail, network or junk proofRef', () => {
    expect(() =>
      buildBondCheckArgs({
        rail: 'spark' as never,
        network: 'testnet',
        proofRef: 'x',
        bondSats: 1,
        jurorPubkey: PUBKEY_A,
      }),
    ).toThrow(/rail must be one of/);
    expect(() =>
      buildBondCheckArgs({
        rail: 'liquid',
        network: 'mainnet' as never,
        proofRef: 'x',
        bondSats: 1,
        jurorPubkey: PUBKEY_A,
      }),
    ).toThrow(/network must be one of/);
    // A whitespace-bearing proofRef would break out of the `--proof=` token.
    expect(() =>
      buildBondCheckArgs({
        rail: 'liquid',
        network: 'testnet',
        proofRef: 'abc:0 --bond-sats=0',
        bondSats: 1,
        jurorPubkey: PUBKEY_A,
      }),
    ).toThrow(/proofRef/);
    expect(() =>
      buildBondCheckArgs({
        rail: 'liquid',
        network: 'testnet',
        proofRef: 'abc:0',
        bondSats: -1,
        jurorPubkey: PUBKEY_A,
      }),
    ).toThrow(/bondSats/);
    expect(() =>
      buildBondCheckArgs({
        rail: 'liquid',
        network: 'testnet',
        proofRef: 'abc:0',
        bondSats: 1,
        jurorPubkey: 'nothex',
      }),
    ).toThrow(/jurorPubkey/);
  });
});

describe('bond gate — the output contract', () => {
  it('accepts a proven answer with the proof and the agreeing sources', () => {
    const verdict = parseBondCheckOutput(
      JSON.stringify({
        ok: true,
        proofRef: 'abc:0',
        sources: ['bitcoind-first-party', 'mempool.space/testnet4'],
      }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.proofRef).toBe('abc:0');
    expect(verdict.sources).toEqual(['bitcoind-first-party', 'mempool.space/testnet4']);
  });

  it('accepts a typed refusal', () => {
    const verdict = parseBondCheckOutput(
      JSON.stringify({ ok: false, code: 'BOND_SPENT', detail: 'outpoint is spent' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('BOND_SPENT');
    expect(verdict.detail).toBe('outpoint is spent');
  });

  it('is strict — junk, empty output and a missing proof/sources never pass', () => {
    for (const stdout of ['', '   ', 'BLOCKED: no faucet', '[]', 'null', '{"ok":"yes"}']) {
      const verdict = parseBondCheckOutput(stdout);
      expect(verdict.ok).toBe(false);
      expect(verdict.code).toBe('BOND_CHECK_MALFORMED');
    }
    // `ok:true` must name what it proved and who agreed with it.
    expect(parseBondCheckOutput(JSON.stringify({ ok: true, sources: ['a'] })).code).toBe(
      'BOND_CHECK_MALFORMED',
    );
    expect(parseBondCheckOutput(JSON.stringify({ ok: true, proofRef: 'x', sources: [] })).code).toBe(
      'BOND_CHECK_MALFORMED',
    );
  });
});

describe('bond gate — the roster decision', () => {
  const jurors = [
    claim(1, PUBKEY_A),
    claim(2, PUBKEY_B),
    claim(3, PUBKEY_C),
  ];

  it('is INERT when no command is configured (today’s behaviour, unchanged)', () => {
    const gate = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, parseCourtBondRef({ rail: 'none', network: 'testnet', proofRef: null }))],
      threshold: 1,
      enforced: false,
      requireBonds: false,
      verdicts: new Map(),
    });
    expect(gate.ok).toBe(true);
    expect(gate.classification).toBeNull();
    expect(gate.admitted).toHaveLength(1);
    expect(gate.admitted[0].bondVerified).toBe(false);
    expect(gate.admitted[0].bondRef).toBe('none/testnet');
  });

  it('admits a roster whose every juror is proven, recording proof + sources', () => {
    const gate = gateRosterOnBonds({
      jurors,
      threshold: 2,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven(LIQUID_BOND.proofRef!)],
        [2, proven(LIQUID_BOND.proofRef!)],
        [3, proven(LIQUID_BOND.proofRef!)],
      ]),
    });
    expect(gate.ok).toBe(true);
    expect(gate.admitted).toHaveLength(3);
    expect(gate.excluded).toHaveLength(0);
    expect(gate.admitted[0].bondVerified).toBe(true);
    expect(gate.admitted[0].sources).toEqual(['blockstream', 'liquid-network']);
  });

  it('excludes a juror whose check refuses, and still runs if the threshold holds', () => {
    const gate = gateRosterOnBonds({
      jurors,
      threshold: 2,
      enforced: true,
      requireBonds: true,
      verdicts: new Map<number, BondCheckVerdict>([
        [1, proven(LIQUID_BOND.proofRef!)],
        [2, { ok: false, code: 'BOND_SPENT', detail: 'spent', proofRef: null, sources: [] }],
        [3, proven(LIQUID_BOND.proofRef!)],
      ]),
    });
    expect(gate.ok).toBe(true);
    expect(gate.admitted.map((v) => v.idx)).toEqual([1, 3]);
    expect(gate.excluded).toHaveLength(1);
    expect(gate.excluded[0]).toMatchObject({
      idx: 2,
      admitted: false,
      bondVerified: false,
      refusal: 'BOND_CHECK_REFUSED',
      code: 'BOND_SPENT',
    });
  });

  it('fails closed with ROSTER_BELOW_THRESHOLD when exclusions break the threshold', () => {
    const gate = gateRosterOnBonds({
      jurors,
      threshold: 3,
      enforced: true,
      requireBonds: true,
      verdicts: new Map<number, BondCheckVerdict>([
        [1, proven(LIQUID_BOND.proofRef!)],
        [2, { ok: false, code: 'BOND_ASSET_MISMATCH', detail: 'wrong asset', proofRef: null, sources: [] }],
        [3, proven(LIQUID_BOND.proofRef!)],
      ]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.classification).toBe('ROSTER_BELOW_THRESHOLD');
    expect(gate.admitted).toHaveLength(2);
    expect(gate.threshold).toBe(3);
  });

  it('treats a MISSING verdict as a refusal (a check that never ran is not a bond)', () => {
    const gate = gateRosterOnBonds({
      jurors,
      threshold: 2,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([[1, proven(LIQUID_BOND.proofRef!)]]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.classification).toBe('ROSTER_BELOW_THRESHOLD');
    expect(gate.excluded.map((v) => v.refusal)).toEqual(['BOND_CHECK_FAILED', 'BOND_CHECK_FAILED']);
  });

  it('excludes a juror that attests a DIFFERENT proof than the roster claims', () => {
    const gate = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A), claim(2, PUBKEY_B)],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven('someothertxid:0')],
        [2, proven(LIQUID_BOND.proofRef!)],
      ]),
    });
    expect(gate.admitted.map((v) => v.idx)).toEqual([2]);
    expect(gate.excluded[0].refusal).toBe('BOND_PROOF_MISMATCH');
  });

  it('excludes rail:"none" under --require-bonds, and admits it unverified otherwise', () => {
    const unbonded = claim(
      1,
      PUBKEY_A,
      parseCourtBondRef({ rail: 'none', network: 'testnet', proofRef: null }),
    );
    const strict = gateRosterOnBonds({
      jurors: [unbonded],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map(),
    });
    expect(strict.ok).toBe(false);
    expect(strict.classification).toBe('ROSTER_BELOW_THRESHOLD');
    expect(strict.excluded[0].refusal).toBe('BOND_NOT_CLAIMED');

    const relaxed = gateRosterOnBonds({
      jurors: [unbonded],
      threshold: 1,
      enforced: true,
      requireBonds: false,
      verdicts: new Map(),
    });
    expect(relaxed.ok).toBe(true);
    expect(relaxed.admitted[0].bondVerified).toBe(false);
  });

  it('rejects an impossible threshold or an empty roster (caller bug, not a pass)', () => {
    expect(() =>
      gateRosterOnBonds({ jurors: [], threshold: 1, enforced: true, requireBonds: true }),
    ).toThrow(/non-empty/);
    expect(() =>
      gateRosterOnBonds({ jurors, threshold: 4, enforced: true, requireBonds: true }),
    ).toThrow(/threshold/);
    expect(() =>
      gateRosterOnBonds({ jurors, threshold: 0, enforced: true, requireBonds: true }),
    ).toThrow(/threshold/);
  });
});
