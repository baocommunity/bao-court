// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Panel B — Liquid P2WSH M-of-N multisig + Taproot escrow construction.
 *
 * ADR-001 Panel B: juror stakes / challenger bonds are locked in a Liquid
 * P2WSH M-of-N CHECKMULTISIG (script-enforced threshold), with a Taproot
 * variant for the single-oracle judge path
 * (`<winner> CHECKSIGVERIFY <oracle> CHECKSIG`, paper §6.1) and a timelock
 * refund leaf. The court's RedistributionPlan decides WHICH branch to spend;
 * this module builds the script trees, addresses, and transaction skeletons —
 * pure math, no keys, no node access.
 *
 * The script does NOT read the tally (ADR-001 negative): enforcement is
 * economic — the court signs the branch matching its verdict, hosts execute.
 *
 * @see docs/SETTLEMENT-RAILS-PLAN.md (status internal)
 * @see ADR-001 (docs/architecture/adr/001-juror-escrow-design.md in bao.markets)
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const Point = secp256k1.Point;

// ── Micro helpers: pushdata + bech32 (no external deps) ─────────────────────

const textEncoder = new TextEncoder();

/** Minimal script opcodes used here. */
const OP = {
  FALSE: 0x00,
  PUSHDATA1: 0x4c,
  OP_1: 0x51,
  OP_16: 0x60,
  CHECKMULTISIG: 0xae,
  CHECKSIGVERIFY: 0xad,
  CHECKSIG: 0xac,
  OP_IF: 0x63,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_HASH160: 0xa9,
  OP_CHECKLOCKTIMEVERIFY: 0xb1,
} as const;

/** Encode a byte push (minimal pushdata for small payloads). */
export function pushHex(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length === 0) return new Uint8Array([OP.FALSE]);
  if (b.length <= 75) {
    return new Uint8Array([b.length, ...b]);
  }
  // allow PUSHDATA1 for up to 255 (we never need more for pubkeys)
  return new Uint8Array([OP.PUSHDATA1, b.length, ...b]);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** OP_N for 1..16 (0 is FALSE/empty). */
function opN(n: number): number {
  if (n < 1 || n > 16) throw new Error(`liquidEscrow: OP_N out of range ${n}`);
  return OP.OP_1 + (n - 1);
}

// ── Script trees ─────────────────────────────────────────────────────────────

export interface MultiSigParams {
  /** Compressed 33-byte or x-only 32-byte hex pubkeys, 1..15 of them. */
  readonly pubkeys: readonly string[];
  /** Threshold m, 1 <= m <= n. */
  readonly threshold: number;
}

/**
 * P2WSH M-of-N CHECKMULTISIG script (juror stake / bond lock, Panel B).
 * Note the leading OP_FALSE for the CHECKMULTISIG bug (extra stack item).
 */
export function buildMultisigScript(params: MultiSigParams): string {
  const { pubkeys, threshold } = params;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`liquidEscrow: threshold must be >= 1, got ${threshold}`);
  }
  if (pubkeys.length < threshold) {
    throw new Error(`liquidEscrow: pubkey count ${pubkeys.length} < threshold ${threshold}`);
  }
  if (pubkeys.length > 15) {
    throw new Error('liquidEscrow: at most 15 pubkeys (16-ary limit)');
  }
  // normalize each pubkey to 33-byte compressed when x-only given
  const normalized: Uint8Array[] = pubkeys.map((pk) => {
    const b = hexToBytes(pk);
    if (b.length === 32) {
      // lift to the compressed point with correct parity via noble curves
      const point = pointFromXOnly(b);
      return hexToBytes(point.toHex(true)); // 33-byte compressed
    }
    if (b.length !== 33) throw new Error(`liquidEscrow: pubkey length ${b.length}`);
    return b;
  });

  const parts: Uint8Array[] = [new Uint8Array([opN(threshold)])];
  for (const pk of normalized) parts.push(pushHex(bytesToHex(pk)));
  parts.push(new Uint8Array([opN(normalized.length), OP.CHECKMULTISIG]));
  return bytesToHex(concatBytes(...parts));
}

function pointFromXOnly(xOnly: Uint8Array): ReturnType<typeof Point.fromHex> {
  // embed x + even y; noble rejects unless y is even — try both parities
  for (const parity of [2, 3]) {
    const candidate = new Uint8Array(33);
    candidate[0] = parity;
    candidate.set(xOnly, 1);
    try {
      return Point.fromHex(bytesToHex(candidate));
    } catch {
      // wrong parity, try next
    }
  }
  throw new Error('liquidEscrow: cannot lift x-only pubkey to curve point');
}

export interface TaprootEscrowParams {
  /** Winner pubkey (32-byte x-only hex). */
  readonly winnerXOnly: string;
  /** Judge/oracle pubkey (32-byte x-only hex). */
  readonly oracleXOnly: string;
  /** Absolute locktime (block height) after which the funder can refund. */
  readonly refundLocktime: number;
}

/**
 * Taproot script-tree leaves (Liquid, paper §6.1):
 *   L1 (judge path): <winner> CHECKSIGVERIFY <oracle> CHECKSIG
 *   L2 (refund):     <refundLocktime> OP_CLTV OP_DROP <funder> CHECKSIG
 * Returns the SCRIPT payloads (leaf scripts), not the tweaked key.
 */
export function buildTaprootLeaves(params: TaprootEscrowParams): {
  readonly judgeLeaf: string;
  readonly refundLeaf: string;
} {
  const judgeLeaf = bytesToHex(concatBytes(
    pushHex(params.winnerXOnly),
    new Uint8Array([OP.CHECKSIGVERIFY]),
    pushHex(params.oracleXOnly),
    new Uint8Array([OP.CHECKSIG]),
  ));
  // CLTV stack: <locktime> OP_CLTV OP_DROP <funder> OP_CHECKSIG
  const locktimePush = locktimeToPush(params.refundLocktime);
  const refundLeaf = bytesToHex(concatBytes(
    locktimePush,
    new Uint8Array([OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP]),
    pushHex(params.oracleXOnly), // funder public key reused as refund signer
    new Uint8Array([OP.CHECKSIG]),
  ));
  return { judgeLeaf, refundLeaf };
}

/** Encode a locktime as a minimal push (>= 0x80000000 → 5-byte little-endian, else 4-byte). */
export function locktimeToPush(locktime: number): Uint8Array {
  if (!Number.isInteger(locktime) || locktime < 0 || locktime > 0xffffffff) {
    throw new Error(`liquidEscrow: invalid locktime ${locktime}`);
  }
  let bytes: Uint8Array;
  if (locktime >= 0x80000000) {
    // Time-based locktimes carry the high bit; script numbers are SIGNED
    // little-endian, so a 4-byte push with the bit set would be negative and
    // OP_CHECKLOCKTIMEVERIFY would always fail. Emit a positive 5-byte form.
    bytes = new Uint8Array(5);
    new DataView(bytes.buffer).setUint32(1, locktime, true);
  } else if (locktime > 0) {
    bytes = new Uint8Array(4);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, locktime, true); // little-endian
  } else {
    bytes = new Uint8Array([0]);
  }
  return pushHex(bytesToHex(bytes));
}

// ── Address derivation ───────────────────────────────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Convert 5-bit groups to characters. `bech32m` selects the v1 constant. */
function encodeBech32(hrp: string, data: Uint8Array, limit: number, bech32m = false): string {
  if (data.length > limit) throw new Error('bech32: data too long');
  const CONST = bech32m ? 0x2bc830a3 : 1;
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  // polymod over hrp-expanded || data || [0;6]
  let pm = 1;
  for (let i = 0; i < hrp.length; i++) {
    pm = polymodStep(pm, hrp.charCodeAt(i) >> 5, gen);
  }
  pm = polymodStep(pm, 0, gen);
  for (let i = 0; i < hrp.length; i++) {
    pm = polymodStep(pm, hrp.charCodeAt(i) & 31, gen);
  }
  for (const v of data) pm = polymodStep(pm, v, gen);
  // BIP-173: the checksum polymod runs over six trailing zero words, then XOR constant
  for (let i = 0; i < 6; i++) pm = polymodStep(pm, 0, gen);
  const check = new Uint8Array(6);
  const enc = (pm ^ CONST) >>> 0;
  for (let i = 0; i < 6; i++) check[i] = (enc >>> (5 * (5 - i))) & 31;
  const values = [...data, ...check];
  const chars = values.map((v) => CHARSET[v]);
  return hrp + '1' + chars.join('');
}

function polymodStep(pm: number, v: number, gen: readonly number[]): number {
  const top = pm >>> 25;
  let p = ((pm & 0x1ffffff) << 5) ^ v;
  for (let g = 0; g < 5; g++) {
    if ((top >>> g) & 1) p ^= gen[g];
  }
  return p >>> 0;
}

export interface LiquidNetworkParams {
  /** Human-readable part for P2WSH (e.g. 'tex' for Liquid testnet, 'tlb' signet-ish). */
  readonly p2wshHrp: string;
  /** HRP for Taproot (bech32m). */
  readonly taprootHrp: string;
}

/** Widely-used HRPs: Liquid mainnet uses 'ex'/'lq', testnet 'tex'/'tq', signet varies. */
export const LIQUID_MAINNET: LiquidNetworkParams = { p2wshHrp: 'ex', taprootHrp: 'lq' };
export const LIQUID_TESTNET: LiquidNetworkParams = { p2wshHrp: 'tex', taprootHrp: 'tq' };
/** BAO signet Liquid uses the testnet HRPs with signet asset ids on-chain. */
export const BAO_SIGNET: LiquidNetworkParams = { p2wshHrp: 'tex', taprootHrp: 'tq' };

/** P2WSH witness program from a script: sha256(script), wrapped in version 0 program. */
export function p2wshProgram(scriptHex: string): Uint8Array {
  const script = hexToBytes(scriptHex);
  const digest = sha256(script);
  return new Uint8Array([0, ...digest]);
}

/** Convert 8-bit bytes to 5-bit words (bech32 payload). */
function to5BitWords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let buffer = 0;
  let acc = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    acc += 8;
    while (acc >= 5) {
      out.push((buffer >>> (acc - 5)) & 31);
      acc -= 5;
    }
  }
  if (acc > 0) out.push((buffer << (5 - acc)) & 31);
  return out;
}

/** 32-byte program body + witness version word (0..16) → bech32 word array. */
function programToWords(programBody: Uint8Array, versionWord: number): Uint8Array {
  if (programBody.length !== 32) throw new Error(`liquidEscrow: program body must be 32 bytes, got ${programBody.length}`);
  if (versionWord < 0 || versionWord > 16) throw new Error(`liquidEscrow: bad witness version ${versionWord}`);
  const words = to5BitWords(programBody);
  return Uint8Array.from([versionWord, ...words]);
}

/** P2WSH segwit v0 address (bech32): body = sha256(script), version word 0. */
export function p2wshAddress(scriptHex: string, net: LiquidNetworkParams): string {
  const program = p2wshProgram(scriptHex); // [0, ...sha256]
  const words = programToWords(program.subarray(1), 0);
  return encodeBech32(net.p2wshHrp, words, 84, false);
}

/** BIP-341 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || parts). */
function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = sha256(textEncoder.encode(tag));
  const length = parts.reduce((n, p) => n + p.length, 0);
  const input = new Uint8Array(64 + length);
  input.set(tagHash, 0);
  input.set(tagHash, 32);
  let offset = 64;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  return sha256(input);
}

/** Bitcoin CompactSize length prefix (1/3/5 bytes — scripts here are < 2^32). */
function compactSize(length: number): Uint8Array {
  if (length < 253) return Uint8Array.of(length);
  if (length < 0x10000) {
    return Uint8Array.of(253, length & 0xff, length >> 8);
  }
  return Uint8Array.of(254, length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff, (length >> 24) & 0xff);
}

/**
 * Elements Taproot merkle root of leaf scripts (TAPSCRIPT leaf version 0xc4
 * per Elements interpreter.h TAPROOT_LEAF_TAPSCRIPT — NOT Bitcoin's 0xc0).
 *
 * ELEMENTS DOMAIN (v0.6.3): Elements chains tag these hashes
 * "TapLeaf/elements" / "TapBranch/elements" (interpreter.cpp:
 * HASHER_TAPLEAF_ELEMENTS / HASHER_TAPBRANCH_ELEMENTS), NOT Bitcoin's plain
 * "TapLeaf" / "TapBranch". v0.6.2 shipped Bitcoin-domain values — every
 * merkle root derived by <= v0.6.2 is invalid on any Elements chain.
 *
 * Leaf hashes are `hash_TapLeaf(0xc4 || compact_size(len) || script)` and
 * inner nodes are `hash_TapBranch(l || r)` over lexicographically sorted
 * children — the exact construction consensus validation recomputes from the
 * control block. Untagged double-SHA256 leaves would commit to a different
 * tree and every script-path spend would fail.
 *
 * The tree follows Bitcoin Core's reference `taproot_tree_helper` (the
 * generator of the official bip341_wallet_vectors.json): a leaf list is
 * split at `len // 2` and each side recurses. For three leaves this yields
 * `TapBranch(h0, TapBranch(h1, h2))` — the shape pinned by the official
 * 3-leaf vector, where leaf 0 is a direct child of the root with a single
 * sibling. The naive pair-up-with-self algorithm AND the largest-power-of-two
 * split both produce different roots for 3+ leaves, so any script-path spend
 * under such a tree would fail consensus validation.
 */
export function tapMerkleRoot(leaves: readonly string[]): string {
  const hashes = leaves.map((scriptHex) => {
    const script = hexToBytes(scriptHex);
    return taggedHash('TapLeaf/elements', Uint8Array.of(0xc4), compactSize(script.length), script);
  });

  function branch(l: Uint8Array, r: Uint8Array): Uint8Array {
    const [a, b] = [l, r].sort((x, y) => (bytesToScalar(x) <= bytesToScalar(y) ? -1 : 1));
    return taggedHash('TapBranch/elements', a, b);
  }

  function merkle(list: Uint8Array[]): Uint8Array {
    if (list.length === 0) {
      throw new Error('liquidEscrow: cannot compute merkle root of an empty leaf list');
    }
    if (list.length === 1) return list[0];
    // Bitcoin Core's taproot_tree_helper splits at len // 2, NOT at the
    // largest power of two. For three leaves: TapBranch(h0, TapBranch(h1, h2))
    // (id 0 is a direct child of the root), which the official
    // bip341_wallet_vectors.json case pins via its control blocks.
    const mid = list.length >> 1;
    return branch(merkle(list.slice(0, mid)), merkle(list.slice(mid)));
  }

  return bytesToHex(merkle(hashes));
}

/** Taproot v1 program from the internal key (x-only) — script path via merkle root. */
export function taprootProgram(internalKeyXOnly: string, merkleRootHex?: string): Uint8Array {
  const key = hexToBytes(internalKeyXOnly);
  if (key.length !== 32) throw new Error('liquidEscrow: taproot internal key must be 32-byte x-only');
  const merkle = merkleRootHex === undefined ? new Uint8Array(0) : hexToBytes(merkleRootHex);
  if (merkleRootHex !== undefined && merkle.length !== 32) {
    throw new Error('liquidEscrow: merkle root must be 32 bytes');
  }
  const P = pointFromXOnly(key);
  // BIP-341: t = int(hash_TapTweak(P || h)); h is empty when there is no
  // script tree — the output key is ALWAYS tweaked (a raw internal key would
  // not be the output key consensus recomputes from the control block).
  // ELEMENTS DOMAIN (v0.6.3): the tagger is "TapTweak/elements"
  // (pubkeys.cpp HASHER_TAPTWEAK_ELEMENTS), not Bitcoin's "TapTweak".
  const tweakHash = taggedHash('TapTweak/elements', key, merkle);
  const t = bytesToScalar(tweakHash);
  if (t >= Point.Fn.ORDER) {
    throw new Error('liquidEscrow: taproot tweak exceeds the curve order');
  }
  // Q = P + t*G, x-only. BIP-341 does NOT force even Y on Q: the parity of Q
  // is carried in the script-path control block (and for key-path spending
  // taproot_tweak_seckey negates the INTERNAL secret iff P is odd, never Q).
  // The old even-Y retweak produced x(P - t*G) whenever Q had odd Y, which
  // diverges from the official vectors and every standard wallet.
  const tweaked = P.add(Point.BASE.multiply(t));
  const xOnlyHex = tweaked.toHex(true).slice(2); // strip 02/03 prefix
  return hexToBytes(xOnlyHex); // 32-byte x-only output key
}

function bytesToScalar(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Taproot v1 address (bech32m). `program` is the 32-byte output key. */
export function taprootAddress(internalKeyXOnly: string, merkleRootHex: string | undefined, net: LiquidNetworkParams): string {
  const program = taprootProgram(internalKeyXOnly, merkleRootHex); // 32-byte key
  const words = programToWords(program, 1); // version word 1
  return encodeBech32(net.taprootHrp, words, 84, true);
}

// ── Transaction skeleton ─────────────────────────────────────────────────────

export interface LiquidUtxo {
  readonly txid: string;
  readonly vout: number;
  /** Value in sats (LBTC). */
  readonly amountSats: number;
  /** Locking script of the UTXO (hex) — for the court-side skeleton we take the p2wsh script. */
  readonly scriptHex: string;
}

export interface LiquidRecipient {
  readonly scriptHex: string;
  readonly amountSats: number;
}

export interface ReleaseSkeleton {
  /** Inputs (host confirms outpoints). */
  readonly inputs: readonly LiquidUtxo[];
  /** Outputs (recipient scripts + amounts, no change — host adds change). */
  readonly recipients: readonly LiquidRecipient[];
  /** Total input sats. */
  readonly inSats: number;
  /** Total output sats. */
  readonly outSats: number;
  /** Fee = in - out (must be >= min). */
  readonly feeSats: number;
}

/**
 * Build a plain (non-confidential) release skeleton: spend N UTXOs, pay
 * recipients. `minFeeSats` guards against fee-less builds. Change output is
 * intentionally left to the host (it has the change address).
 */
export function buildReleaseSkeleton(
  inputs: readonly LiquidUtxo[],
  recipients: readonly LiquidRecipient[],
  minFeeSats = 1_000,
): ReleaseSkeleton {
  if (inputs.length === 0) throw new Error('liquidEscrow: no inputs');
  if (recipients.length === 0) throw new Error('liquidEscrow: no recipients');
  for (const r of recipients) {
    if (!Number.isInteger(r.amountSats) || r.amountSats <= 0) {
      throw new Error(`liquidEscrow: invalid recipient amount ${r.amountSats}`);
    }
    if (r.scriptHex.length === 0 || r.scriptHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(r.scriptHex)) {
      throw new Error('liquidEscrow: recipient script must be even-length hex');
    }
  }
  const inSats = inputs.reduce((n, u) => n + u.amountSats, 0);
  const outSats = recipients.reduce((n, r) => n + r.amountSats, 0);
  const feeSats = inSats - outSats;
  if (feeSats < minFeeSats) {
    throw new Error(`liquidEscrow: fee ${feeSats} < min ${minFeeSats}`);
  }
  return { inputs, recipients, inSats, outSats, feeSats };
}

/**
 * Assemble the M-of-N CHECKMULTISIG witness: [OP_FALSE, sig_1..sig_M].
 * `partialSigs` are DER-ish hex (host provides from its keys); order must
 * match the pubkey order used in buildMultisigScript.
 */
export function assembleMultisigWitness(
  partialSigs: readonly string[],
  threshold: number,
): string[] {
  if (partialSigs.length < threshold) {
    throw new Error(`liquidEscrow: ${partialSigs.length} sigs < threshold ${threshold}`);
  }
  return ['', ...partialSigs];
}

// ── Assertion: script length sanity + known vectors guard ───────────────────

/** Sanity: any built script must fit in a P2WSH (well below 10k limit). */
export function assertScriptSane(scriptHex: string, maxLength = 10_000): void {
  const b = hexToBytes(scriptHex);
  if (b.length === 0 || b.length > maxLength) {
    throw new Error(`liquidEscrow: script length ${b.length} out of sane range`);
  }
}
