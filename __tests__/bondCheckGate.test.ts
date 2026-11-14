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
  BOND_CHECK_MAX_OUTPUT_BYTES,
  bondIdentity,
  buildBondCheckArgs,
  gateRosterOnBonds,
  normaliseBondProofRef,
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

/**
 * THREE DISTINCT bonds. Since v0.17.1 one bond identity admits one seat, so a
 * roster fixture that shares a single outpoint across seats is no longer a
 * "everyone is proven" roster — it is the duplicate-seat case (see the ONE BOND,
 * ONE SEAT block below).
 */
const BOND_A = LIQUID_BOND;
const BOND_B = parseCourtBondRef({
  rail: 'liquid',
  network: 'testnet',
  proofRef: 'cce0c1b4b7f2b1c0a5b0d1e2f3a4b5c6d7e8f9012345678abcdef0123456789:1',
});
const BOND_C = parseCourtBondRef({
  rail: 'onchain',
  network: 'testnet',
  proofRef: '9a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef:2',
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
    claim(1, PUBKEY_A, BOND_A),
    claim(2, PUBKEY_B, BOND_B),
    claim(3, PUBKEY_C, BOND_C),
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
        [1, proven(BOND_A.proofRef!)],
        [2, proven(BOND_B.proofRef!)],
        [3, proven(BOND_C.proofRef!)],
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
        [1, proven(BOND_A.proofRef!)],
        [2, { ok: false, code: 'BOND_SPENT', detail: 'spent', proofRef: null, sources: [] }],
        [3, proven(BOND_C.proofRef!)],
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
        [1, proven(BOND_A.proofRef!)],
        [2, { ok: false, code: 'BOND_ASSET_MISMATCH', detail: 'wrong asset', proofRef: null, sources: [] }],
        [3, proven(BOND_C.proofRef!)],
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

// ---------------------------------------------------------------------------
// ONE BOND, ONE SEAT — review-round-13's gap
//
// The gate used to judge each juror's bond in isolation, so ONE bond presented
// by TWO jurors was admitted twice: a single coin bought two seats. The rule is
// now "one canonical bond identity admits at most one seat per run", decided in
// `gateRosterOnBonds` (see the JSDoc there and
// `docs/MULTI_PROCESS_CEREMONY.md` §"One bond, one seat").
// ---------------------------------------------------------------------------

// `BOND_A` / `BOND_B` / `BOND_C` (three distinct bonds) are declared with the
// roster fixtures at the top of this file.

describe('bond gate — ONE BOND, ONE SEAT (v0.17.1)', () => {
  it('(a) refuses the SECOND claimant of one bond: the first keeps the seat, the roster drops below k, no key and no signature', () => {
    // Both jurors present the SAME outpoint and the checker proves it twice —
    // the chain genuinely cannot tell them apart. Only the gate can.
    const gate = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, BOND_A), claim(3, PUBKEY_C, BOND_C)],
      threshold: 3,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven(BOND_A.proofRef!)],
        [2, proven(BOND_A.proofRef!)],
        [3, proven(BOND_C.proofRef!)],
      ]),
    });
    // FIRST claimant (roster = box/seat order) keeps the seat — deterministically.
    expect(gate.admitted.map((v) => v.idx)).toEqual([1, 3]);
    const second = gate.excluded[0];
    expect(second).toMatchObject({
      idx: 2,
      admitted: false,
      bondVerified: false,
      refusal: 'BOND_REUSED_ACROSS_SEATS',
      duplicateOf: 1,
      code: null,
    });
    expect(second.detail).toContain('already backs seat 1');
    // ...and the duplicate costs the ceremony its quorum: the typed stop the
    // runner acts on by writing no roster, launching no juror and signing
    // nothing (`ROSTER_BELOW_THRESHOLD`, asserted end-to-end by the ceremony
    // matrix's negative runs).
    expect(gate.ok).toBe(false);
    expect(gate.classification).toBe('ROSTER_BELOW_THRESHOLD');
    expect(gate.admitted).toHaveLength(2);
    expect(gate.threshold).toBe(3);
  });

  it('(b) seats BOTH jurors when they present DIFFERENT bonds', () => {
    const gate = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, BOND_B)],
      threshold: 2,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven(BOND_A.proofRef!)],
        [2, proven(BOND_B.proofRef!)],
      ]),
    });
    expect(gate.ok).toBe(true);
    expect(gate.admitted.map((v) => v.idx)).toEqual([1, 2]);
    expect(gate.admitted.map((v) => v.bondVerified)).toEqual([true, true]);
    expect(gate.excluded).toHaveLength(0);
  });

  it('(c) keeps the dedupe PER RUN: the same bonds pass in two consecutive ceremonies, and a refusal does not poison the next run', () => {
    const run = () =>
      gateRosterOnBonds({
        jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, BOND_B)],
        threshold: 2,
        enforced: true,
        requireBonds: true,
        verdicts: new Map([
          [1, proven(BOND_A.proofRef!)],
          [2, proven(BOND_B.proofRef!)],
        ]),
      });
    // The soak re-presents the SAME funded outpoints every cycle: that is legal.
    expect(run().ok).toBe(true);
    expect(run().ok).toBe(true);
    expect(run().admitted).toHaveLength(2);

    // A run that refused a duplicate leaves nothing behind: the very same bond
    // is a fresh, valid claim in the next run.
    const dup = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, BOND_A)],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven(BOND_A.proofRef!)],
        [2, proven(BOND_A.proofRef!)],
      ]),
    });
    expect(dup.admitted.map((v) => v.idx)).toEqual([1]);
    expect(dup.excluded[0].refusal).toBe('BOND_REUSED_ACROSS_SEATS');
    const next = gateRosterOnBonds({
      jurors: [claim(2, PUBKEY_B, BOND_A)],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([[2, proven(BOND_A.proofRef!)]]),
    });
    expect(next.ok).toBe(true);
    expect(next.admitted[0].bondVerified).toBe(true);
  });

  it('(d) normalises the bond identity: upper-case hex and a trailing space are the SAME bond, a different outpoint is not', () => {
    // The canonical form itself.
    expect(normaliseBondProofRef('  0F11AB:0  ')).toBe('0f11ab:0');
    const upper = parseCourtBondRef({
      rail: 'liquid',
      network: 'testnet',
      proofRef: '0F1186FABB1FBEB1862F67EDADEDB291F0A41A0BC0CA5936C3F1028577465D2A:0 ',
    });
    expect(bondIdentity(upper)).toBe(bondIdentity(BOND_A));
    // Rail and network are part of the identity: the same outpoint string on
    // another rail is a different bond (and is refused by the check anyway).
    expect(bondIdentity({ ...BOND_A, rail: 'onchain' })).not.toBe(bondIdentity(BOND_A));
    expect(bondIdentity({ ...BOND_A, network: 'signet-public' })).not.toBe(bondIdentity(BOND_A));

    // ...and the gate treats them as one bond: the re-typed claim is refused.
    const same = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, upper)],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven(BOND_A.proofRef!)],
        [2, proven(BOND_A.proofRef!)],
      ]),
    });
    expect(same.admitted.map((v) => v.idx)).toEqual([1]);
    expect(same.excluded[0]).toMatchObject({ idx: 2, refusal: 'BOND_REUSED_ACROSS_SEATS', duplicateOf: 1 });

    // A genuinely different outpoint (one digit) is a different bond.
    const neighbour = parseCourtBondRef({
      rail: 'liquid',
      network: 'testnet',
      proofRef: '0f1186fabb1fbeb1862f67edadedb291f0a41a0bc0ca5936c3f1028577465d2b:0',
    });
    const distinct = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, neighbour)],
      threshold: 2,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([
        [1, proven(BOND_A.proofRef!)],
        [2, proven(neighbour.proofRef!)],
      ]),
    });
    expect(distinct.ok).toBe(true);
    expect(distinct.admitted).toHaveLength(2);
  });

  it('does NOT dedupe an INERT gate, and does not let a refused claim reserve a bond', () => {
    // Inert gate = no enforcement = no seat ledger (pre-bond behaviour).
    const inert = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, BOND_A)],
      threshold: 2,
      enforced: false,
      requireBonds: false,
      verdicts: new Map(),
    });
    expect(inert.ok).toBe(true);
    expect(inert.admitted).toHaveLength(2);

    // Seat 1's check REFUSED, so it never held the bond; seat 2 may still use it.
    const rescued = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A), claim(2, PUBKEY_B, BOND_A)],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map<number, BondCheckVerdict>([
        [1, { ok: false, code: 'BOND_SPENT', detail: 'spent', proofRef: null, sources: [] }],
        [2, proven(BOND_A.proofRef!)],
      ]),
    });
    expect(rescued.admitted.map((v) => v.idx)).toEqual([2]);
    expect(rescued.excluded[0].refusal).toBe('BOND_CHECK_REFUSED');
    expect(rescued.ok).toBe(true);
  });
});

describe('bond gate — the gate refuses a bad answer itself (contract hardening)', () => {
  const request = {
    rail: 'liquid' as const,
    network: 'testnet' as const,
    proofRef: 'abc:0',
    bondSats: 4140,
    jurorPubkey: PUBKEY_A,
  };

  it('refuses an answer that proves a DIFFERENT bond than the one requested', () => {
    const verdict = parseBondCheckOutput(
      JSON.stringify({ ok: true, proofRef: 'def:0', sources: ['blockstream'] }),
      request,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('BOND_PROOF_MISMATCH');
    expect(verdict.detail).toContain('def:0');
    // ...and the roster decision maps that to the typed refusal, so a caller
    // that forgot to compare still cannot seat the juror.
    const gate = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, parseCourtBondRef({ rail: 'liquid', network: 'testnet', proofRef: 'abc:0' }))],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([[1, verdict]]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.excluded[0].refusal).toBe('BOND_PROOF_MISMATCH');
  });

  it('accepts the SAME bond written in another case, but refuses an answer for another rail/network', () => {
    const echoed = parseBondCheckOutput(
      JSON.stringify({ ok: true, proofRef: 'ABC:0', sources: ['blockstream'], rail: 'liquid', network: 'testnet' }),
      request,
    );
    expect(echoed.ok).toBe(true);

    const wrongRail = parseBondCheckOutput(
      JSON.stringify({ ok: true, proofRef: 'abc:0', sources: ['blockstream'], rail: 'onchain' }),
      request,
    );
    expect(wrongRail.ok).toBe(false);
    expect(wrongRail.code).toBe('BOND_RAIL_MISMATCH');
  });

  it('the gate itself refuses a proof mismatch even when the caller passes no expectation', () => {
    const gate = gateRosterOnBonds({
      jurors: [claim(1, PUBKEY_A, BOND_A)],
      threshold: 1,
      enforced: true,
      requireBonds: true,
      verdicts: new Map([[1, proven('someothertxid:0')]]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.excluded[0].refusal).toBe('BOND_PROOF_MISMATCH');
    expect(gate.excluded[0].detail).toContain('was requested');
  });

  it('bounds the checker output and refuses anything that is not ONE JSON object', () => {
    // Byte ceiling, mirroring the runner's 8 MiB spawn cap. Byte-counted, not
    // char-counted: these euro signs are 3 bytes each.
    const overBytes = '€'.repeat(Math.ceil(BOND_CHECK_MAX_OUTPUT_BYTES / 3) + 2);
    expect(overBytes.length).toBeLessThan(BOND_CHECK_MAX_OUTPUT_BYTES);
    expect(parseBondCheckOutput(overBytes).code).toBe('BOND_CHECK_MALFORMED');
    expect(parseBondCheckOutput(overBytes).detail).toMatch(/ceiling/);

    const good = '{"ok":true,"proofRef":"abc:0","sources":["a"]}';
    expect(parseBondCheckOutput(good).ok).toBe(true);
    for (const junk of [
      `${good} trailing`,
      `${good}${good}`,
      `[${good}]`,
      `"${good}"`,
      '{"ok":true,"proofRef":"abc:0","sources":["a"]', // unbalanced
      '{"ok":true,"proofRef":"abc:0 ","sources":["a"]}', // whitespace in the proven ref
      `{"ok":true,"proofRef":"${'a'.repeat(513)}","sources":["a"]}`, // over-long ref
    ]) {
      expect(parseBondCheckOutput(junk).code).toBe('BOND_CHECK_MALFORMED');
    }
  });
});

