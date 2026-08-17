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
  BAO_SIGNET,
} from '../liquidEscrow';

// ── Independent bech32/bech32m decoding (BIP-173/BIP-350 reference logic) ───

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let g = 0; g < 5; g++) {
      if ((top >>> g) & 1) chk ^= GEN[g];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function decodeBech32(addr: string): { hrp: string; data: number[]; bech32m: boolean; version: number } {
  const lower = addr.toLowerCase(); // bech32 is case-insensitive
  const pos = lower.lastIndexOf('1');
  if (pos < 1) throw new Error('bad address: no separator');
  const hrp = lower.slice(0, pos);
  const data = [...lower.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error('bad address: char outside charset');
    return i;
  });
  // BIP-173: constant 1 => bech32 (v0), 0x2bc830a3 => bech32m (v1+)
  const constValue = polymod(hrpExpand(hrp).concat(data));
  let bech32m: boolean;
  if (constValue === 1) bech32m = false;
  else if (constValue === 0x2bc830a3) bech32m = true;
  else throw new Error('bad address: checksum mismatch');
  return { hrp, data: data.slice(0, -6), bech32m, version: data[0] };
}

describe('independent bech32 cross-check (BIP-173/BIP-350 reference decoder)', () => {
  it('decodes a P2WSH address with HRP tex, version 0 (bech32, not bech32m)', () => {
    const script = buildMultisigScript({ pubkeys: [`02${'aa'.repeat(32)}`, `03${'bb'.repeat(32)}`], threshold: 2 });
    const addr = p2wshAddress(script, BAO_SIGNET);
    const { hrp, data, bech32m, version } = decodeBech32(addr);
    expect(hrp).toBe('tex');
    expect(bech32m).toBe(false); // segwit v0 => bech32 constant
    expect(version).toBe(0);
    // 33-byte witness program (version word + 32-byte digest) => 53 five-bit words
    expect(data.length).toBe(53);
  });

  it('decodes a Taproot address with HRP tq, version 1 (bech32m)', () => {
    const addr = taprootAddress('aa'.repeat(32), undefined, BAO_SIGNET);
    const { hrp, data, bech32m, version } = decodeBech32(addr);
    expect(hrp).toBe('tq');
    expect(bech32m).toBe(true); // segwit v1 => bech32m constant
    expect(version).toBe(1);
    expect(data.length).toBe(53); // 33-byte program
  });

  it('round-trips the P2WSH program from the decoded address', () => {
    const script = buildMultisigScript({ pubkeys: [`02${'aa'.repeat(32)}`, `03${'bb'.repeat(32)}`, `02${'cc'.repeat(32)}`], threshold: 2 });
    const addr = p2wshAddress(script, BAO_SIGNET);
    const program = p2wshProgram(script);
    // decoded words after the version word must equal the 32-byte digest words
    const expectedWords = convertToWords5(program.subarray(1));
    const { data } = decodeBech32(addr);
    expect(data.slice(1)).toEqual(expectedWords); // strip version word
  });
});

// ── Official BIP-350 valid vectors (bech32m) through the reference decoder ──

describe('BIP-350 official valid vectors decode as bech32m/bech32', () => {
  const vectors: ReadonlyArray<{ addr: string; bech32m: boolean; version: number }> = [
    // P2TR valid (bech32m, v1) — BIP-350 valid vector
    { addr: 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', bech32m: true, version: 1 },
    // v2 valid (bech32m) — BIP-350 valid vector
    { addr: 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', bech32m: true, version: 2 },
    // v16 valid (bech32m) — BIP-350 valid vector (uppercase HRP variant)
    { addr: 'BC1SW50QGDZ25J', bech32m: true, version: 16 },
    // P2WPKH valid (bech32, v0) — BIP-173 vector
    { addr: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', bech32m: false, version: 0 },
  ];
  for (const v of vectors) {
    it(`decodes ${v.addr.slice(0, 12)}… as ${v.bech32m ? 'bech32m' : 'bech32'} v${v.version}`, () => {
      const { bech32m, version } = decodeBech32(v.addr);
      expect(bech32m).toBe(v.bech32m);
      expect(version).toBe(v.version);
    });
  }
});

function convertToWords5(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out.push((acc >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

// ── End-to-end: court plan → spend branch → address (integration-style) ─────

import { schnorr } from '@noble/curves/secp256k1.js';

// Real x-only keys via BIP-340 keygen (valid curve points).
const winner = bytesToHex(schnorr.getPublicKey(hexToBytes('11'.repeat(32))));
const oracle = bytesToHex(schnorr.getPublicKey(hexToBytes('22'.repeat(32))));

describe('court → spend branch integration', () => {
  it('builds the judge-path release for a dispute and derives its address', () => {
    const { judgeLeaf, refundLeaf } = buildTaprootLeaves({ winnerXOnly: winner, oracleXOnly: oracle, refundLocktime: 5_000_000 });
    const root = tapMerkleRoot([judgeLeaf, refundLeaf]);
    const addr = taprootAddress(oracle, root, BAO_SIGNET);
    expect(judgeLeaf).toContain(`20${winner}ad20${oracle}ac`);
    expect(refundLeaf).toContain('b175');
    expect(addr.startsWith('tq1')).toBe(true);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('multisig script is stable and addressable (P2WSH)', () => {
    const pubkeys = ['02' + 'aa'.repeat(32), '03' + 'bb'.repeat(32), '02' + 'cc'.repeat(32)];
    const script = buildMultisigScript({ pubkeys, threshold: 2 });
    const addr = p2wshAddress(script, BAO_SIGNET);
    const { version } = decodeBech32(addr);
    expect(version).toBe(0);
    expect(addr).toMatch(/^tex1/);
    // the address deterministic across runs
    expect(p2wshAddress(script, BAO_SIGNET)).toBe(addr);
  });
});

// keep sha256/hexToBytes imports honest (avoid unused warnings)
void sha256; void hexToBytes; void bytesToHex;
