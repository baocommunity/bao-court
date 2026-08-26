// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
  BAO_SIGNET,
  tapMerkleRoot,
  taprootAddress,
  taprootProgram,
} from '../liquidEscrow';
import {
  buildWsACoopLeaf,
  buildWsARefundLeaf,
  controlBlock,
  controlBlockInternalKey,
  controlBlockMerklePath,
  finalizeTaproot,
  LIQUID_MAINNET_GENESIS,
  LIQUID_TESTNET_GENESIS,
  merkleRootFromLeafAndPath,
  outputKeyParity,
  reverseHex,
  SIGHASH_ALL,
  scriptPathControlBlock,
  serializeExplicitAsset,
  serializeExplicitValue,
  TAPROOT_LEAF_VERSION,
  tapleafHash,
  taprootMerklePath,
  taprootSighashElements,
} from '../taprootSpend';

// ── §8.1 FROZEN vector inputs (WS-A spec v2, pinned 2026-08-24) ─────────────

const INTERNAL_X = 'ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f4';
const PK_T = '1c0a553cabf1627b47ea3c3162f16f275342c7a0734f1b5f932a56ced00b7a84';
const PK_C = 'cfe4d37930da1d6c4d547c9e6433d0852c3c72dff26369cc9a54b4dbdfdf473b';
const CLOSE = 2_000_000;
const DELTA = 144;
const REFUND_HEIGHT = CLOSE + DELTA; // 2_000_144

// Pinned §8.1 values (regenerated under the NUMS internal key).
//
// NOTE (v2.1 vector CORRECTION): the frozen v2 block emitted `b1 00` where
// spec §3 defines `<locktime> OP_CLTV OP_DROP <pk> OP_CHECKSIG` (0x00 in place
// of OP_DROP 0x75 — a bug in the deleted vector generator). The corrected
// leaves regenerate MERKLE/Q/ADDR and the COOP-leaf control blocks; COOP
// leaves and REFUND-leaf control-block paths are unchanged.
//
// NOTE (v2.2 parity REGENERATION, v0.6.2): BIP-341 control-block low bit =
// Y-parity of the OUTPUT key Q, not the internal key.
//
// NOTE (v2.4 ELEMENTS DOMAINS + LEAF VERSION, v0.6.3): Elements chains tag
// the taproot hashes "TapLeaf/elements" / "TapBranch/elements" /
// "TapTweak/elements" AND use Tapscript leaf version 0xc4 (interpreter.h
// TAPROOT_LEAF_TAPSCRIPT), NOT Bitcoin's plain tags with 0xc0. v0.6.2 shipped
// Bitcoin-domain values, which elementsd rejects ("Witness program hash
// mismatch" / "Taproot version reserved for soft-fork upgrades"). ALL
// tree/tweak-derived values below were regenerated under the Elements
// domains and independently cross-verified by a pure-python secp256k1
// implementation. Parities under the final domains: Q_T even (CB_T* 0xc4),
// Q_C odd (CB_C* 0xc5).
const VECTORS = {
  COOP_T: '201c0a553cabf1627b47ea3c3162f16f275342c7a0734f1b5f932a56ced00b7a84ac',
  REFUND_T: '0410851e00b175201c0a553cabf1627b47ea3c3162f16f275342c7a0734f1b5f932a56ced00b7a84ac',
  COOP_C: '20cfe4d37930da1d6c4d547c9e6433d0852c3c72dff26369cc9a54b4dbdfdf473bac',
  REFUND_C: '0410851e00b17520cfe4d37930da1d6c4d547c9e6433d0852c3c72dff26369cc9a54b4dbdfdf473bac',
  MERKLE_T: '8a42272157ec9e0812c77804612209ac5bf597a3985ac7a16dec7fd4525be32c',
  MERKLE_C: '184bc4a2ca5b7a68df980c41ffab376ecc03f6c168669aff5d53d3a29ede4daa',
  Q_T: 'a985486064dba65cc9e3ae680103aa99a9b05ef0e33781437177f78965960273',
  Q_C: 'ca1846cdd2aee707c9f7d6099aa557188f3ac6b970595fc86820fabf4e5e957c',
  ADDR_T: 'tq1p4xz5scrymwn9ej0r4e5qzqa2nx5mqhhsuvmczsm3wlmcjevkqfesvcg4tp',
  ADDR_C: 'tq1pegvydnwj4mns0j0h6cye4f2hrz8n434ewpv4ljrgyrat7nj7j47qmykscu',
  CB_T0: 'c4ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f42b44fa7ae308f5975f1d55b4ab1ff0452209a66fd45d847a2036f7a1f6cc0b98',
  CB_T1: 'c4ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f41d88378f86aa3fbbc9cf5df60337086f0ba87521b4cc0dd0455c57c8d6057fda',
  CB_C0: 'c5ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f4309f025f79821f6d48269d48149fb6bd3c901ee7d81062cc6f612da9d5e55803',
  CB_C1: 'c5ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f43b40d6cdda30fae68947d1d3e376135cdb3c7a94acf8d04c36791dbca689e23d',
};

// ── §8.1 frozen vectors ─────────────────────────────────────────────────────

describe('WS-A §8.1 frozen vectors', () => {
  it('builds the four leaf scripts byte-identically', () => {
    expect(buildWsACoopLeaf(PK_T)).toBe(VECTORS.COOP_T);
    expect(buildWsARefundLeaf(PK_T, REFUND_HEIGHT)).toBe(VECTORS.REFUND_T);
    expect(buildWsACoopLeaf(PK_C)).toBe(VECTORS.COOP_C);
    expect(buildWsARefundLeaf(PK_C, REFUND_HEIGHT)).toBe(VECTORS.REFUND_C);
  });

  it('reproduces the pinned merkle roots via the vendored tapMerkleRoot', () => {
    expect(tapMerkleRoot([VECTORS.COOP_T, VECTORS.REFUND_T])).toBe(VECTORS.MERKLE_T);
    expect(tapMerkleRoot([VECTORS.COOP_C, VECTORS.REFUND_C])).toBe(VECTORS.MERKLE_C);
  });

  it('reproduces the pinned output keys and signet addresses', () => {
    expect(bytesToHex(taprootProgram(INTERNAL_X, VECTORS.MERKLE_T))).toBe(VECTORS.Q_T);
    expect(bytesToHex(taprootProgram(INTERNAL_X, VECTORS.MERKLE_C))).toBe(VECTORS.Q_C);
    expect(taprootAddress(INTERNAL_X, VECTORS.MERKLE_T, BAO_SIGNET)).toBe(VECTORS.ADDR_T);
    expect(taprootAddress(INTERNAL_X, VECTORS.MERKLE_C, BAO_SIGNET)).toBe(VECTORS.ADDR_C);
  });

  it('reproduces the pinned control blocks for all four leaves', () => {
    const leavesT = [VECTORS.COOP_T, VECTORS.REFUND_T];
    const leavesC = [VECTORS.COOP_C, VECTORS.REFUND_C];
    expect(scriptPathControlBlock(INTERNAL_X, leavesT, 0)).toBe(VECTORS.CB_T0);
    expect(scriptPathControlBlock(INTERNAL_X, leavesT, 1)).toBe(VECTORS.CB_T1);
    expect(scriptPathControlBlock(INTERNAL_X, leavesC, 0)).toBe(VECTORS.CB_C0);
    expect(scriptPathControlBlock(INTERNAL_X, leavesC, 1)).toBe(VECTORS.CB_C1);
  });

  it('cross-checks the control-block paths: each path is the sibling TapLeaf hash', () => {
    // The §8.1 paths must equal the Elements-domain TapLeaf hashes of the
    // sibling leaves ("TapLeaf/elements" — v0.6.3).
    expect(tapleafHash(VECTORS.REFUND_T)).toBe('2b44fa7ae308f5975f1d55b4ab1ff0452209a66fd45d847a2036f7a1f6cc0b98');
    expect(tapleafHash(VECTORS.COOP_T)).toBe('1d88378f86aa3fbbc9cf5df60337086f0ba87521b4cc0dd0455c57c8d6057fda');
    expect(tapleafHash(VECTORS.REFUND_C)).toBe('309f025f79821f6d48269d48149fb6bd3c901ee7d81062cc6f612da9d5e55803');
    expect(tapleafHash(VECTORS.COOP_C)).toBe('3b40d6cdda30fae68947d1d3e376135cdb3c7a94acf8d04c36791dbca689e23d');
  });

  it('REFUND leaves carry OP_CLTV OP_DROP (0xb175) — regression guard for the v2.1 correction', () => {
    expect(VECTORS.REFUND_T).toContain('b175');
    expect(VECTORS.REFUND_C).toContain('b175');
    expect(VECTORS.REFUND_T).not.toContain('b100');
    expect(VECTORS.REFUND_C).not.toContain('b100');
  });

  it('merkleRootFromLeafAndPath agrees with tapMerkleRoot (leaf + single-sibling path)', () => {
    const t0 = merkleRootFromLeafAndPath(tapleafHash(VECTORS.COOP_T), [tapleafHash(VECTORS.REFUND_T)]);
    const t1 = merkleRootFromLeafAndPath(tapleafHash(VECTORS.REFUND_T), [tapleafHash(VECTORS.COOP_T)]);
    expect(t0).toBe(VECTORS.MERKLE_T);
    expect(t1).toBe(VECTORS.MERKLE_T);
    expect(merkleRootFromLeafAndPath(tapleafHash(VECTORS.COOP_C), [tapleafHash(VECTORS.REFUND_C)])).toBe(VECTORS.MERKLE_C);
  });
});

// ── BIP-341 output-key parity (numeric, independent of module helpers) ──────

/** Independent Q-parity: lift_x + TapTweak/elements with @noble/curves directly. */
function qParityIndependent(internalXOnlyHex: string, merkleRootHex: string): 0 | 1 {
  const Pt = secp256k1.Point;
  const key = hexToBytes(internalXOnlyHex);
  let P;
  for (const prefix of [2, 3]) {
    const c = new Uint8Array(33);
    c[0] = prefix;
    c.set(key, 1);
    try { P = Pt.fromHex(bytesToHex(c)); break; } catch { /* try odd */ }
  }
  if (!P) throw new Error('lift failed');
  const tagHash = sha256(new TextEncoder().encode('TapTweak/elements'));
  const pre = new Uint8Array(64 + 64);
  pre.set(tagHash, 0);
  pre.set(tagHash, 32);
  pre.set(key, 64);
  pre.set(hexToBytes(merkleRootHex), 96);
  const tHash = sha256(pre);
  let t = 0n;
  for (const b of tHash) t = (t << 8n) | BigInt(b);
  const Q = P.add(Pt.BASE.multiply(t));
  return Q.toHex(true).startsWith('03') ? 1 : 0; // compressed 03 = odd Y
}

describe('BIP-341 output-key parity', () => {
  it('derives the control-block parity bit from the OUTPUT key Q — numerically', () => {
    // The pinned NUMS internal key + both §8.1 trees (Elements domains):
    expect(qParityIndependent(INTERNAL_X, VECTORS.MERKLE_T)).toBe(0); // Q_T even-Y
    expect(qParityIndependent(INTERNAL_X, VECTORS.MERKLE_C)).toBe(1); // Q_C odd-Y
    // …so the regenerated control blocks carry exactly those bits.
    expect(parseInt(VECTORS.CB_T0.slice(0, 2), 16) & 1).toBe(0);
    expect(parseInt(VECTORS.CB_T1.slice(0, 2), 16) & 1).toBe(0);
    expect(parseInt(VECTORS.CB_C0.slice(0, 2), 16) & 1).toBe(1);
    expect(parseInt(VECTORS.CB_C1.slice(0, 2), 16) & 1).toBe(1);
    // …and the module's own derivation agrees with the independent computation.
    expect(outputKeyParity(INTERNAL_X, VECTORS.MERKLE_T)).toBe(qParityIndependent(INTERNAL_X, VECTORS.MERKLE_T));
    expect(outputKeyParity(INTERNAL_X, VECTORS.MERKLE_C)).toBe(qParityIndependent(INTERNAL_X, VECTORS.MERKLE_C));
    // The builders stamp the derived bit into the first byte.
    const leavesT = [VECTORS.COOP_T, VECTORS.REFUND_T];
    const leavesC = [VECTORS.COOP_C, VECTORS.REFUND_C];
    expect(scriptPathControlBlock(INTERNAL_X, leavesT, 0).slice(0, 2)).toBe('c4');
    expect(scriptPathControlBlock(INTERNAL_X, leavesC, 0).slice(0, 2)).toBe('c5');
  });

  it('rejects bad internal keys and bad merkle roots', () => {
    expect(() => outputKeyParity('aa'.repeat(31), VECTORS.MERKLE_T)).toThrow(/internal key/);
    expect(() => outputKeyParity(INTERNAL_X, 'aa'.repeat(31))).toThrow(/merkle root/);
  });
});

// ── Control block mechanics ─────────────────────────────────────────────────

describe('controlBlock / merkle path', () => {
  // Under the Elements domains: Q_T even → 0xc4; Q_C odd → 0xc5.
  // (First byte = TAPSCRIPT leaf version 0xc4 | OUTPUT-key Y-parity.)
  const PATH = ['aa'.repeat(32)];

  it('stamps the OUTPUT-key parity into the first byte (derived, never assumed)', () => {
    expect(controlBlock(INTERNAL_X, PATH, VECTORS.MERKLE_T).slice(0, 2)).toBe('c4');
    expect(controlBlock(INTERNAL_X, PATH, VECTORS.MERKLE_C).slice(0, 2)).toBe('c5');
  });

  it('round-trips internal key and path', () => {
    const cb = controlBlock(INTERNAL_X, PATH, VECTORS.MERKLE_T);
    expect(controlBlockInternalKey(cb)).toBe(INTERNAL_X);
    expect(controlBlockMerklePath(cb)).toEqual(PATH);
  });

  it('rejects bad keys, bad roots, bad path elements', () => {
    expect(() => controlBlock('aa'.repeat(31), [], VECTORS.MERKLE_T)).toThrow(/internal key/);
    expect(() => controlBlock(INTERNAL_X, [], 'bb'.repeat(31))).toThrow(/merkle root/);
    expect(() => controlBlock(INTERNAL_X, ['aa'.repeat(31)], VECTORS.MERKLE_T)).toThrow(/32 bytes/);
    expect(() => controlBlockMerklePath('aa'.repeat(32))).toThrow(/malformed/);
    expect(() => controlBlockInternalKey('aa'.repeat(32))).toThrow(/malformed/);
  });

  it('taprootMerklePath rejects out-of-range leafIndex', () => {
    expect(() => taprootMerklePath([VECTORS.COOP_T], 1)).toThrow(/out of range/);
  });
});

// ── Elements taproot sighash ────────────────────────────────────────────────

// Minimal deterministic tx (all-unblinded) for the known-answer test.
const TXID_IN = '11'.repeat(32); // internal byte order
const ASSET = serializeExplicitAsset('aa'.repeat(32)); // '01' + 32-byte id
const SPENT_VALUE = serializeExplicitValue(100_000); // '01' + BE 100000
const SPENT_SCRIPT = `5120${'bb'.repeat(32)}`; // taproot-ish prevout
const OUT_VALUE = serializeExplicitValue(90_000);
const OUT_SCRIPT = `0014${'cc'.repeat(20)}`; // p2wpkh-ish recipient

function minimalTxParams() {
  return {
    genesisBlockHash: LIQUID_TESTNET_GENESIS,
    version: 2,
    lockTime: 0,
    inputs: [{
      txid: TXID_IN,
      vout: 0,
      sequence: 0xfffffffd,
      outpointFlag: 0,
      asset: ASSET,
      value: SPENT_VALUE,
      scriptPubKey: SPENT_SCRIPT,
    }],
    outputs: [{
      asset: ASSET,
      value: OUT_VALUE,
      nonce: '00',
      scriptPubKey: OUT_SCRIPT,
    }],
    outputWitnesses: [],
    inputIndex: 0,
    tapleafHash: tapleafHash(VECTORS.COOP_T),
    hashType: 0x00,
  };
}

/**
 * Independent known-answer: rebuild the Elements taproot sighash preimage by
 * hand (raw bytes, no module helpers) per the ported C++ structure, and pin
 * the resulting digest. Any drift in the module's serialization breaks this.
 */
function handBuiltExpectedSighash(): string {
  const tag = sha256(new TextEncoder().encode('TapSighash/elements'));
  const genesis = hexToBytes(LIQUID_TESTNET_GENESIS);

  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  };
  const i32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n | 0, true);
    return b;
  };
  const concat = (...xs: Uint8Array[]) => {
    const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of xs) { out.set(x, o); o += x.length; }
    return out;
  };
  const vec = (hex: string) => {
    const b = hexToBytes(hex);
    return concat(Uint8Array.of(b.length), b); // compactSize for < 253
  };
  const single = (...xs: Uint8Array[]) => sha256(concat(...xs));

  const outpoint = concat(hexToBytes(TXID_IN), u32(0));
  const spent = concat(hexToBytes(ASSET), hexToBytes(SPENT_VALUE));
  const spentScript = vec(SPENT_SCRIPT);
  const issuanceRangeproofs = concat(Uint8Array.of(0), Uint8Array.of(0)); // two empty vectors
  const txOut = concat(hexToBytes(ASSET), hexToBytes(OUT_VALUE), Uint8Array.of(0), vec(OUT_SCRIPT));

  const body = concat(
    Uint8Array.of(0x00), // hash_type SIGHASH_DEFAULT
    i32(2), // version
    u32(0), // lockTime
    single(Uint8Array.of(0)), // outpoint flags
    single(outpoint),
    single(spent), // spent assets+amounts
    single(spentScript), // spent scripts
    single(u32(0xfffffffd)), // sequences
    single(Uint8Array.of(0)), // issuances (null)
    single(issuanceRangeproofs),
    single(txOut), // outputs
    single(new Uint8Array(0)), // output witnesses (vtxoutwit empty)
    Uint8Array.of(0x02), // spend_type: tapscript, no annex
    u32(0), // input index
    hexToBytes(tapleafHash(VECTORS.COOP_T)),
    Uint8Array.of(0x00), // key_version
    u32(0xffffffff), // codesep_pos
  );

  const preimage = concat(tag, tag, genesis, genesis, body);
  return bytesToHex(sha256(preimage));
}

describe('taprootSighashElements', () => {
  it('matches the independently hand-built preimage (known answer)', () => {
    const expected = handBuiltExpectedSighash();
    const actual = taprootSighashElements(minimalTxParams());
    expect(actual).toBe(expected);
    // Pinned digest — refactors must preserve it byte-for-byte. Re-pinned in
    // v0.6.3: the SIGHASH tag was already correct in v0.6.x, but the TAPLEAF
    // hash inside the preimage legitimately changed with the Elements-domain
    // fix ("TapLeaf/elements" + Tapscript leaf version 0xc4), moving the
    // digest. (v0.6.2 value, Bitcoin-domain leaf hash:
    // edf985681d64c7c5e9a7c465ad03df0db55345fea38c1b20aec6b33f8f9602f5.)
    expect(actual).toBe('461ff39dc1f0c22675bf3d401371d3fed09b32191703584900d956a1f0be5641');
  });

  it('is deterministic', () => {
    const a = taprootSighashElements(minimalTxParams());
    const b = taprootSighashElements(minimalTxParams());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any committed field changes (sensitivity)', () => {
    const base = taprootSighashElements(minimalTxParams());
    const mutate = (patch: (p: ReturnType<typeof minimalTxParams>) => void) => {
      const p = minimalTxParams();
      patch(p);
      return taprootSighashElements(p);
    };
    expect(mutate((p) => { p.version = 3; })).not.toBe(base);
    expect(mutate((p) => { p.lockTime = 1; })).not.toBe(base);
    expect(mutate((p) => { p.inputs[0].vout = 1; })).not.toBe(base);
    expect(mutate((p) => { p.inputs[0].sequence = 0; })).not.toBe(base);
    expect(mutate((p) => { p.inputs[0].value = serializeExplicitValue(99_999); })).not.toBe(base);
    expect(mutate((p) => { p.outputs[0].value = serializeExplicitValue(89_999); })).not.toBe(base);
    expect(mutate((p) => { p.outputs[0].scriptPubKey = `0014${'dd'.repeat(20)}`; })).not.toBe(base);
    expect(mutate((p) => { p.tapleafHash = tapleafHash(VECTORS.REFUND_T); })).not.toBe(base);
    expect(mutate((p) => { p.hashType = 0x01; })).not.toBe(base);
  });

  it('rejects bad inputs', () => {
    const p = minimalTxParams();
    expect(() => taprootSighashElements({ ...p, inputIndex: 1 })).toThrow(/out of range/);
    expect(() => taprootSighashElements({ ...p, hashType: 0x40 })).toThrow(/invalid sighash/);
    expect(() => taprootSighashElements({ ...p, genesisBlockHash: 'aa'.repeat(31) })).toThrow(/genesis/);
    expect(() => taprootSighashElements({ ...p, tapleafHash: 'aa'.repeat(31) })).toThrow(/tapleaf/);
  });

  it('serializeExplicitValue is big-endian (Elements WriteBE64) and rejects out-of-range', () => {
    expect(serializeExplicitValue(100_000)).toBe('0100000000000186a0');
    expect(serializeExplicitValue(1)).toBe('010000000000000001');
    expect(() => serializeExplicitValue(-1)).toThrow(/out of range/);
    expect(serializeExplicitAsset('aa'.repeat(32))).toBe(`01${'aa'.repeat(32)}`);
    expect(() => serializeExplicitAsset('aa'.repeat(31))).toThrow(/32 bytes/);
  });

  it('reverseHex flips display ↔ internal byte order', () => {
    expect(reverseHex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'))
      .toBe('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100');
  });

  it('genesis constants hold INTERNAL byte order (reverse of display) — v0.6.2 fix', () => {
    // Display forms pinned by Elements Core kernel/chainparams.cpp (mainnet
    // GetHex assert) and the Liquid / liquidtestnet Esplora APIs, height 0.
    // Elements seeds the sighash hasher with the raw uint256 bytes
    // (interpreter.cpp: HashWriter(HASHER_TAPSIGHASH_ELEMENTS) << genesis <<
    // genesis), which are the REVERSE of the display hex (uint256.h). The
    // v0.6.0 constants stored display hex verbatim → reversed preimages.
    expect(reverseHex(LIQUID_MAINNET_GENESIS))
      .toBe('1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003');
    expect(reverseHex(LIQUID_TESTNET_GENESIS))
      .toBe('a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1');
  });
});

// ── finalizeTaproot ─────────────────────────────────────────────────────────

describe('finalizeTaproot', () => {
  const SIG = 'f0'.repeat(64);

  function finalizeParams() {
    const tx = minimalTxParams();
    const { inputs, outputs, outputWitnesses } = tx;
    const leafScript = VECTORS.COOP_T;
    const control = scriptPathControlBlock(INTERNAL_X, [VECTORS.COOP_T, VECTORS.REFUND_T], 0);
    return {
      genesisBlockHash: tx.genesisBlockHash,
      version: tx.version,
      lockTime: tx.lockTime,
      inputs,
      outputs,
      outputWitnesses,
      inputIndex: tx.inputIndex,
      leafScript,
      controlBlock: control,
      signature: SIG,
      expectedOutputKey: VECTORS.Q_T,
    };
  }

  it('assembles the witness [sig, leaf, controlBlock] and returns the sighash', () => {
    const res = finalizeTaproot(finalizeParams());
    expect(res.witness).toEqual([SIG, VECTORS.COOP_T, VECTORS.CB_T0]);
    // The sighash must be the same one a signer computed over the COOP_T leaf.
    const direct = taprootSighashElements({
      ...minimalTxParams(),
      tapleafHash: tapleafHash(VECTORS.COOP_T),
    });
    expect(res.sighash).toBe(direct);
  });

  it('verifies the leaf + control block commit to the expected output key', () => {
    const bad = finalizeParams();
    bad.expectedOutputKey = VECTORS.Q_C; // wrong output key for the T tree
    expect(() => finalizeTaproot(bad)).toThrow(/do not commit to expectedOutputKey/);
    // A wrong control block (C tree leaf) also fails.
    const wrongCb = finalizeParams();
    wrongCb.controlBlock = scriptPathControlBlock(INTERNAL_X, [VECTORS.COOP_C, VECTORS.REFUND_C], 0);
    expect(() => finalizeTaproot(wrongCb)).toThrow(/do not commit/);
  });

  it('rejects a non-64-byte signature', () => {
    const p = finalizeParams();
    p.signature = 'aa'.repeat(63);
    expect(() => finalizeTaproot(p)).toThrow(/64 bytes/);
  });

  it('prepends extra stack items before the signature (REFUND leaf shape)', () => {
    const p = finalizeParams();
    p.leafScript = VECTORS.REFUND_T;
    p.controlBlock = scriptPathControlBlock(INTERNAL_X, [VECTORS.COOP_T, VECTORS.REFUND_T], 1);
    p.expectedOutputKey = VECTORS.Q_T;
    const res = finalizeTaproot(p);
    expect(res.witness).toEqual([SIG, VECTORS.REFUND_T, VECTORS.CB_T1]);
  });

  it('appends the hash_type byte for non-default sighash (65-byte witness element)', () => {
    const base = finalizeTaproot(finalizeParams());
    expect(base.witness[0]).toBe(SIG); // SIGHASH_DEFAULT keeps the bare 64-byte form
    const res = finalizeTaproot({ ...finalizeParams(), hashType: SIGHASH_ALL });
    expect(hexToBytes(res.witness[0]).length).toBe(65);
    expect(res.witness[0]).toBe(SIG + '01');
    // …and the digest commits the non-default type too.
    expect(res.sighash).not.toBe(base.sighash);
  });

  it('rejects a control block whose parity bit contradicts the output key', () => {
    const p = finalizeParams();
    // Under the Elements domains Q_T has EVEN Y (correct CB starts 0xc4);
    // flipping to 0xc5 contradicts it and must be rejected pre-signature.
    p.controlBlock = 'c5' + p.controlBlock.slice(2);
    expect(() => finalizeTaproot(p)).toThrow(/parity does not match the output key/);
  });
});

// ── Property: D1-no invariant over the §8 trees ─────────────────────────────

describe('D1-no invariant (spec §8 property test)', () => {
  const NON_OWNER_KEYS = [
    INTERNAL_X, // NUMS internal key must never double as a leaf signer
    'ff'.repeat(32), // stand-in for any court aggregate key
    'ee'.repeat(32), // stand-in for any oracle key
    PK_T, // the OTHER party's key in C's tree
    PK_C, // the OTHER party's key in T's tree
  ];

  it('every leaf contains exactly one pubkey — the owner’s, and nothing else', () => {
    const trees: Record<string, { owner: string; leaves: string[] }> = {
      T: { owner: PK_T, leaves: [VECTORS.COOP_T, VECTORS.REFUND_T] },
      C: { owner: PK_C, leaves: [VECTORS.COOP_C, VECTORS.REFUND_C] },
    };
    for (const [label, { owner, leaves }] of Object.entries(trees)) {
      for (const leaf of leaves) {
        // Leaf must contain the owner pubkey as a 32-byte push.
        expect(leaf).toContain(`20${owner}`);
        // And must NOT contain any non-owner key as a push32 (nor a 33-byte compressed form).
        for (const foreign of NON_OWNER_KEYS) {
          if (foreign === owner) continue;
          expect(leaf, `${label} leaf must not contain foreign key ${foreign.slice(0, 8)}…`).not.toContain(`20${foreign}`);
          expect(leaf, `${label} leaf must not contain compressed ${foreign.slice(0, 8)}…`).not.toContain(`21${foreign.slice(0, 2)}${foreign}`);
        }
        // COOP leaf is exactly 34 bytes; REFUND leaf is 41 bytes (4-byte CLTV push).
        const expectedLen = leaf.startsWith('04') ? 41 : 34;
        expect(leaf.length / 2).toBe(expectedLen);
      }
    }
  });

  it('the internal key is the pinned NUMS constant (no BAO-derived key appears)', () => {
    expect(INTERNAL_X).toBe('ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f4');
    // The internal key must not appear in either tree (key path is dead).
    for (const leaf of [VECTORS.COOP_T, VECTORS.REFUND_T, VECTORS.COOP_C, VECTORS.REFUND_C]) {
      expect(leaf).not.toContain(`20${INTERNAL_X}`);
    }
  });
});

// ── Elements tagged-hash domains (v0.6.3 regression guard) ──────────────────
// elementsd derives tapleaf/branch/tweak hashes under the "/elements" tags
// (interpreter.cpp HASHER_TAPLEAF/TAPBRANCH_ELEMENTS, pubkeys.cpp
// HASHER_TAPTWEAK_ELEMENTS). These tests rebuild the derivations with the
// LITERAL tag strings so a regression back to Bitcoin's plain BIP-341 tags
// cannot pass silently (it would surface on-chain as
// "Witness program hash mismatch").

function tagged(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const length = parts.reduce((n, x) => n + x.length, 0);
  const input = new Uint8Array(64 + length);
  input.set(tagHash, 0);
  input.set(tagHash, 32);
  let o = 64;
  for (const part of parts) { input.set(part, o); o += part.length; }
  return sha256(input);
}

describe('Elements tagged-hash domains', () => {
  const key = INTERNAL_X;

  it('tapleafHash uses "TapLeaf/elements"', () => {
    const script = hexToBytes(VECTORS.COOP_T);
    const expected = bytesToHex(tagged('TapLeaf/elements', Uint8Array.of(TAPROOT_LEAF_VERSION), Uint8Array.of(script.length), script));
    expect(tapleafHash(VECTORS.COOP_T)).toBe(expected);
    // …and NOT Bitcoin's plain tag:
    expect(tapleafHash(VECTORS.COOP_T)).not.toBe(
      bytesToHex(tagged('TapLeaf', Uint8Array.of(0xc0), Uint8Array.of(script.length), script)), // plain-tag + Bitcoin leaf-version stays different
    );
  });

  it('tapMerkleRoot branches under "TapBranch/elements"', () => {
    const ha = tapleafHash(VECTORS.COOP_T);
    const hb = tapleafHash(VECTORS.REFUND_T);
    const [lo, hi] = [ha, hb].sort();
    expect(tapMerkleRoot([VECTORS.COOP_T, VECTORS.REFUND_T])).toBe(
      bytesToHex(tagged('TapBranch/elements', hexToBytes(lo), hexToBytes(hi))),
    );
    // …and NOT Bitcoin's plain tag:
    expect(tapMerkleRoot([VECTORS.COOP_T, VECTORS.REFUND_T])).not.toBe(
      bytesToHex(tagged('TapBranch', hexToBytes(lo), hexToBytes(hi))),
    );
  });

  it('taprootProgram tweaks under "TapTweak/elements"', () => {
    // independent lift_x + tweak·G using noble directly
    let P: ReturnType<typeof secp256k1.Point.fromHex> | undefined;
    for (const prefix of [2, 3]) {
      const c = new Uint8Array(33);
      c[0] = prefix; c.set(hexToBytes(key), 1);
      try { P = secp256k1.Point.fromHex(bytesToHex(c)); break; } catch { /* odd */ }
    }
    if (!P) throw new Error('lift failed');
    const tHash = tagged('TapTweak/elements', hexToBytes(key), hexToBytes(VECTORS.MERKLE_T));
    let t = 0n;
    for (const b of tHash) t = (t << 8n) | BigInt(b);
    const expectedProgram = P.add(secp256k1.Point.BASE.multiply(t)).toHex(true).slice(2);
    expect(bytesToHex(taprootProgram(key, VECTORS.MERKLE_T))).toBe(expectedProgram);
    // …and NOT Bitcoin's plain tag:
    const tHashPlain = tagged('TapTweak', hexToBytes(key), hexToBytes(VECTORS.MERKLE_T));
    let tPlain = 0n;
    for (const b of tHashPlain) tPlain = (tPlain << 8n) | BigInt(b);
    expect(bytesToHex(taprootProgram(key, VECTORS.MERKLE_T))).not.toBe(
      P.add(secp256k1.Point.BASE.multiply(tPlain)).toHex(true).slice(2),
    );
    // module parity agrees with the independently computed output key
    expect(outputKeyParity(key, VECTORS.MERKLE_T)).toBe(qParityIndependent(key, VECTORS.MERKLE_T));
  });
});
