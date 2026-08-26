// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  buildMultisigScript,
  buildTaprootLeaves,
  p2wshProgram,
  p2wshAddress,
  taprootAddress,
  tapMerkleRoot,
  buildReleaseSkeleton,
  assembleMultisigWitness,
  assertScriptSane,
  BAO_SIGNET,
  pushHex,
} from '../liquidEscrow';

const PK_A = `02${'aa'.repeat(32)}`;
const PK_B = `02${'bb'.repeat(32)}`;
const PK_C = `03${'cc'.repeat(32)}`;
const X_A = 'aa'.repeat(32);
const X_B = 'bb'.repeat(32);

// ── Script construction ─────────────────────────────────────────────────────

describe('buildMultisigScript', () => {
  it('builds a 1-of-1 script (OP_1 <pk> OP_1 CHECKMULTISIG)', () => {
    const script = buildMultisigScript({ pubkeys: [PK_A], threshold: 1 });
    // OP_1 = 0x51, push33 (0x21) + 33-byte compressed pubkey (incl. parity), OP_1, OP_CHECKMULTISIG
    const expected = `5121${PK_A}51ae`;
    expect(script).toBe(expected);
  });

  it('builds a 2-of-3 script with correct opcodes', () => {
    const script = buildMultisigScript({ pubkeys: [PK_A, PK_B, PK_C], threshold: 2 });
    expect(script.startsWith('52')).toBe(true); // OP_2
    expect(script).toContain('21' + PK_A); // push 33 + full pk (incl. parity prefix)
    expect(script).toContain('21' + PK_B);
    expect(script).toContain('21' + PK_C);
    expect(script.endsWith('53ae')).toBe(true); // OP_3 CHECKMULTISIG
  });

  it('lifts x-only pubkeys to compressed 33-byte with parity', () => {
    // x-only 32-byte A (even-y assumed via 02 prefix in the fixture)
    const script = buildMultisigScript({ pubkeys: [X_A], threshold: 1 });
    expect(script.startsWith('5121')).toBe(true);
    expect(script).toHaveLength(2 + 2 + 66 + 2 + 2); // OP_1, push, 33B, OP_1, OP_CS
  });

  it('rejects threshold 0, pubkeys < threshold, and > 15 keys', () => {
    expect(() => buildMultisigScript({ pubkeys: [PK_A], threshold: 0 })).toThrow(/threshold/);
    expect(() => buildMultisigScript({ pubkeys: [PK_A], threshold: 2 })).toThrow(/pubkey count/);
    const many = Array.from({ length: 16 }, (_, i) => `02${i.toString(16).repeat(64)}`);
    expect(() => buildMultisigScript({ pubkeys: many, threshold: 8 })).toThrow(/at most 15/);
    expect(() => buildMultisigScript({ pubkeys: ['zz'], threshold: 1 })).toThrow();
  });
});

describe('buildTaprootLeaves', () => {
  it('builds judge + refund leaves with expected structure', () => {
    const { judgeLeaf, refundLeaf } = buildTaprootLeaves({
      winnerXOnly: X_A,
      oracleXOnly: X_B,
      refundLocktime: 1_234_567,
    });
    // judge: push32 winner CHECKSIGVERIFY push32 oracle CHECKSIG
    expect(judgeLeaf.startsWith('20' + X_A + 'ad')).toBe(true);
    expect(judgeLeaf.endsWith('ac')).toBe(true);
    expect(bytesToHex(pushHex(X_B))).toBe(`20${X_B}`);
    // refund: locktime push (CLTV) drop + oracle checksig
    expect(refundLeaf).toContain('b175'); // OP_CLTV OP_DROP
    expect(refundLeaf.endsWith('ac')).toBe(true);
  });
});

// ── Independent known-answer: P2WSH address (BIP-141 math, done by hand) ────

describe('p2wshProgram / p2wshAddress (known vector)', () => {
  it('matches the BIP-141 example: script 0x51 → program 0x0020<sha256(0x51)>', () => {
    // script = OP_1 (single byte)
    const program = p2wshProgram('51');
    expect(program[0]).toBe(0); // witness version 0
    const digest = sha256(new Uint8Array([0x51]));
    expect(bytesToHex(program.subarray(1))).toBe(bytesToHex(digest));
    expect(program.length).toBe(1 + 32);
  });

  it('produces a bech32 address in the signet HRP with correct length', () => {
    const script = buildMultisigScript({ pubkeys: [PK_A, PK_B], threshold: 2 });
    const addr = p2wshAddress(script, BAO_SIGNET);
    expect(addr.startsWith('tex1')).toBe(true); // Liquid testnet-ish P2WSH
    // 33-byte program → 53 five-bit words → hrp(3) + '1' + 53 + 6 checksum
    expect(addr.length).toBe(3 + 1 + 53 + 6);
  });
});

describe('taproot helpers (merkle root + address)', () => {
  it('computes a deterministic merkle root', () => {
    const { judgeLeaf, refundLeaf } = buildTaprootLeaves({
      winnerXOnly: X_A, oracleXOnly: X_B, refundLocktime: 1_000_000,
    });
    const root1 = tapMerkleRoot([judgeLeaf, refundLeaf]);
    const root2 = tapMerkleRoot([judgeLeaf, refundLeaf]);
    expect(root1).toBe(root2);
    expect(root1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a bech32m taproot address with correct HRP and length', () => {
    const addr = taprootAddress(X_A, undefined, BAO_SIGNET);
    expect(addr.startsWith('tq1')).toBe(true);
    // 33-byte program (v1 + 32) → 53 words → hrp(2) + '1' + 53 + 6
    expect(addr.length).toBe(2 + 1 + 53 + 6);
  });

  it('matches the official BIP-341 3-leaf vector (bitcoin-core split-at-mid)', () => {
    // Tree shape from bip341_wallet_vectors.json — internalPubkey e0dfe2…,
    // scriptTree [id0, [id1, id2]]. This pins the SHAPE: Bitcoin Core's
    // taproot_tree_helper splits at len // 2, so the root is
    // TapBranch(h0, TapBranch(h1, h2)) — leaf 0 is a direct child of the
    // root (its control block carries one sibling). A largest-power-of-two
    // split produces TapBranch(TapBranch(h0, h1), h2) — a different root
    // whose script-path spends would fail consensus validation.
    //
    // v0.6.3: expected root REGENERATED under the Elements tagged-hash
    // domains AND the Elements Tapscript leaf version 0xc4
    // ("TapLeaf/elements" / "TapBranch/elements", TAPROOT_LEAF_TAPSCRIPT).
    // The Bitcoin-domain value was ccbd66c6f7e8fdab47b3a486f59d28262be857f30
    // d4773f2d5ea47f7761ce0e2 — kept here for provenance only.
    const leaf0 = '2072ea6adcf1d371dea8fba1035a09f3d24ed5a059799bae114084130ee5898e69ac';
    const leaf1 = '202352d137f2f3ab38d1eaa976758873377fa5ebb817372c71e2c542313d4abda8ac';
    const leaf2 = '207337c0dd4253cb86f2c43a2351aadd82cccb12a172cd120452b9bb8324f2186aac';
    expect(tapMerkleRoot([leaf0, leaf1, leaf2])).toBe(
      'ab5da4169a19f41846713d39317efb2507248fd7f78e49ee9bfef9d20c191e60',
    );
  });
});

// ── Release skeleton ────────────────────────────────────────────────────────

describe('buildReleaseSkeleton', () => {
  it('computes fee = in - out and enforces a minimum', () => {
    const skel = buildReleaseSkeleton(
      [
        { txid: '11'.repeat(32), vout: 0, amountSats: 100_000, scriptHex: '76a914' },
        { txid: '22'.repeat(32), vout: 1, amountSats: 50_000, scriptHex: '76a914' },
      ],
      [{ scriptHex: '0014' + 'aa'.repeat(20), amountSats: 140_000 }],
      1_000,
    );
    expect(skel.inSats).toBe(150_000);
    expect(skel.outSats).toBe(140_000);
    expect(skel.feeSats).toBe(10_000);
  });

  it('rejects a below-minimum fee', () => {
    expect(() => buildReleaseSkeleton(
      [{ txid: '11'.repeat(32), vout: 0, amountSats: 10_000, scriptHex: '76a914' }],
      [{ scriptHex: '0014' + 'aa'.repeat(20), amountSats: 9_500 }],
      1_000,
    )).toThrow(/fee 500 < min 1000/);
  });

  it('rejects no inputs, no recipients, bad amount, bad script', () => {
    expect(() => buildReleaseSkeleton([], [{ scriptHex: '00', amountSats: 1 }], 1)).toThrow(/no inputs/);
    expect(() => buildReleaseSkeleton([{ txid: '11'.repeat(32), vout: 0, amountSats: 1, scriptHex: '00' }], [], 1)).toThrow(/no recipients/);
    expect(() => buildReleaseSkeleton([{ txid: '11'.repeat(32), vout: 0, amountSats: 1, scriptHex: '00' }], [{ scriptHex: '00', amountSats: 0 }], 1)).toThrow(/invalid recipient amount/);
    expect(() => buildReleaseSkeleton([{ txid: '11'.repeat(32), vout: 0, amountSats: 1, scriptHex: '00' }], [{ scriptHex: 'zz', amountSats: 1 }], 1)).toThrow(/script/);
  });
});

describe('assembleMultisigWitness', () => {
  it('prepends OP_FALSE for the CHECKMULTISIG bug and enforces threshold', () => {
    const sigs = ['aa', 'bb'];
    const witness = assembleMultisigWitness(sigs, 2);
    expect(witness.length).toBe(3);
    expect(witness[0]).toBe(''); // OP_FALSE
    expect(witness.slice(1)).toEqual(sigs);
    expect(() => assembleMultisigWitness(['aa'], 2)).toThrow(/threshold/);
  });
});

describe('assertScriptSane', () => {
  it('accepts a sane multisig script and rejects empty/oversized', () => {
    const script = buildMultisigScript({ pubkeys: [PK_A, PK_B, PK_C], threshold: 2 });
    expect(() => assertScriptSane(script)).not.toThrow();
    expect(() => assertScriptSane('')).toThrow(/sane/);
    expect(() => assertScriptSane('00'.repeat(10_001))).toThrow(/sane/);
  });
});

// ── Locktime push encoding ──────────────────────────────────────────────────

describe('locktime push encoding', () => {
  it('encodes time-based locktimes (>= 0x80000000) as a positive 5-byte push', () => {
    // Script numbers are SIGNED little-endian: a 4-byte push of 0x80000001
    // would be negative and OP_CHECKLOCKTIMEVERIFY would always fail. The
    // 5-byte form (leading 0x00) keeps the 32-bit value positive.
    const { refundLeaf } = buildTaprootLeaves({
      winnerXOnly: X_A,
      oracleXOnly: X_B,
      refundLocktime: 0x80000001,
    });
    // 0x05 <5-byte LE 00 01 00 00 80> OP_CLTV OP_DROP ...
    expect(refundLeaf.slice(0, 16)).toBe('050001000080b175');
  });

  it('keeps 4-byte encoding for block-height locktimes', () => {
    const { refundLeaf } = buildTaprootLeaves({
      winnerXOnly: X_A,
      oracleXOnly: X_B,
      refundLocktime: 1_000_000,
    });
    // 0x04 <4-byte LE 40 42 0f 00> OP_CLTV OP_DROP ...
    expect(refundLeaf.slice(0, 14)).toBe('0440420f00b175');
  });
});
