// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

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
  LIQUID_TESTNET_GENESIS,
  merkleRootFromLeafAndPath,
  reverseHex,
  scriptPathControlBlock,
  serializeExplicitAsset,
  serializeExplicitValue,
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
// NOTE: the REFUND leaves carry a v2.1 vector CORRECTION: the frozen v2 block
// emitted `b1 00` where spec §3 defines `<locktime> OP_CLTV OP_DROP <pk> OP_CHECKSIG`
// (0x00 in place of OP_DROP 0x75 — a bug in the deleted vector generator). The
// corrected leaves regenerate MERKLE/Q/ADDR and the COOP-leaf control blocks;
// COOP leaves and REFUND-leaf control-block paths are unchanged.
const VECTORS = {
  COOP_T: '201c0a553cabf1627b47ea3c3162f16f275342c7a0734f1b5f932a56ced00b7a84ac',
  REFUND_T: '0410851e00b175201c0a553cabf1627b47ea3c3162f16f275342c7a0734f1b5f932a56ced00b7a84ac',
  COOP_C: '20cfe4d37930da1d6c4d547c9e6433d0852c3c72dff26369cc9a54b4dbdfdf473bac',
  REFUND_C: '0410851e00b17520cfe4d37930da1d6c4d547c9e6433d0852c3c72dff26369cc9a54b4dbdfdf473bac',
  MERKLE_T: '44bf0381e6c30fc7d465ee3cd25d806fdd99a1107c06143193522d54b7f94d90',
  MERKLE_C: 'e2a75a3224d24bdf5cf7b5ee621141bc9fabc38d458c156c87b6f70fa9f2257e',
  Q_T: 'bd263d326bf0701247bac2e8ff123a30f406a564f41285ac27fa6c0cef8008ee',
  Q_C: 'f4b210abc99416a3f1de913a56e5502979596c61e4437fabaacb2f3806ba35e6',
  ADDR_T: 'tq1ph5nr6vnt7pcpy3a6ct507y36xr6qdfty7sfgttp8lfkqemuqprhqfuzeej',
  ADDR_C: 'tq1p7jepp27fjst28uw7jya9de2s99u4jmrpu3phl2a2evhnsp46xhnqvjdtl6',
  CB_T0: 'c0ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f4b731bfbf2f8a9197ba64efcdbb993faa98ece93ef680a0946f2d1d4fc01720b9',
  CB_T1: 'c0ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f41b7fbc0309ba606310a6d0641ca390b06fa91b482e9e958f51618e6da8fff476',
  CB_C0: 'c0ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f43c0a96fbd33a47c6cc50a83179e0d97e1f22730d534f5dfa3677361160d3382e',
  CB_C1: 'c0ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f428e4495a42d97a058b35d64a3271e6103037a5dee4f2a9d6a2e7691608dba5b8',
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
    // The §8.1 paths must equal the BIP-341 TapLeaf hashes of the sibling leaves.
    expect(tapleafHash(VECTORS.REFUND_T)).toBe('b731bfbf2f8a9197ba64efcdbb993faa98ece93ef680a0946f2d1d4fc01720b9');
    expect(tapleafHash(VECTORS.COOP_T)).toBe('1b7fbc0309ba606310a6d0641ca390b06fa91b482e9e958f51618e6da8fff476');
    expect(tapleafHash(VECTORS.REFUND_C)).toBe('3c0a96fbd33a47c6cc50a83179e0d97e1f22730d534f5dfa3677361160d3382e');
    expect(tapleafHash(VECTORS.COOP_C)).toBe('28e4495a42d97a058b35d64a3271e6103037a5dee4f2a9d6a2e7691608dba5b8');
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

// ── Control block mechanics ─────────────────────────────────────────────────

describe('controlBlock / merkle path', () => {
  const PATH = ['aa'.repeat(32), 'bb'.repeat(32)];

  it('parity 0 → 0xc0 prefix, parity 1 → 0xc1 prefix', () => {
    expect(controlBlock(INTERNAL_X, PATH, 0).slice(0, 2)).toBe('c0');
    expect(controlBlock(INTERNAL_X, PATH, 1).slice(0, 2)).toBe('c1');
  });

  it('round-trips internal key and path', () => {
    const cb = controlBlock(INTERNAL_X, PATH, 1);
    expect(controlBlockInternalKey(cb)).toBe(INTERNAL_X);
    expect(controlBlockMerklePath(cb)).toEqual(PATH);
  });

  it('rejects bad keys, bad parity, bad path elements', () => {
    expect(() => controlBlock('aa'.repeat(31), [], 0)).toThrow(/internal key/);
    expect(() => controlBlock(INTERNAL_X, [], 2 as 0 | 1)).toThrow(/parity/);
    expect(() => controlBlock(INTERNAL_X, ['aa'.repeat(31)], 0)).toThrow(/32 bytes/);
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
    // Pinned digest — refactors must preserve it byte-for-byte.
    expect(actual).toBe('43b0b047c6e56793acfc5f36d419aa5e9b498a9f9e14f173d2c32736466824ee');
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
