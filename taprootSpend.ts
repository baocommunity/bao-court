// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * WS-A — Taproot script-path spend finalization for Liquid/Elements.
 *
 * Builds on the vendored tree math in `liquidEscrow.ts` (`tapMerkleRoot`,
 * `taprootProgram`, `taprootAddress`) and adds the two pieces liquidjs-lib
 * does not provide for the Elements variant of BIP-341:
 *
 *   1. **Control-block construction** — `controlBlock()` /
 *      `scriptPathControlBlock()`, with the merkle path derived from the same
 *      split-at-half tree `tapMerkleRoot` commits (Bitcoin Core
 *      `taproot_tree_helper` shape) and the control block's parity bit
 *      computed from the OUTPUT key Q = lift_x(P) + t·G per BIP-341 (never
 *      assumed). A wrong-shaped tree or wrong parity fails consensus; both
 *      are guaranteed consistent with the pinned vectors.
 *
 *   2. **The Elements taproot signature hash** — `taprootSighashElements()`,
 *      a faithful port of Elements Core's `SignatureHashSchnorr` (TAPSCRIPT
 *      variant, no annex). This is NOT plain BIP-341: Elements uses the tag
 *      `"TapSighash/elements"` and prepends the chain's genesis block hash
 *      (twice) to the digest preimage; the tx-level commitments hash the
 *      confidential-field serializations (asset/value/nonce), outpoint flags,
 *      issuances and issuance rangeproofs, and output witness (rangeproof /
 *      surjection-proof) data on top of the BIP-341 fields. There is **no**
 *      explicit fee field in the taproot sighash — the fee is implied by the
 *      committed spent-amounts and outputs.
 *
 *   3. **Witness assembly** — `finalizeTaproot()` produces the sighash and
 *      the final `[sig, ...stack, leafScript, controlBlock]` witness, with an
 *      optional self-check that the leaf + control block commit to the
 *      expected output key (the strongest check possible without a signet
 *      broadcast — see the spec §8 item 6 for why unit vectors alone cannot
 *      prove consensus validity).
 *
 * WS-A leaf scripts (`buildWsACoopLeaf` / `buildWsARefundLeaf`) embed ONLY the
 * owner's user-held x-only pubkey (D1-no): no court aggregate key, no oracle
 * key, no BAO-mnemonic-derived key appears in any leaf.
 *
 * @see docs/proposals/WS-A-TAPROOT-ESCROW-SPEC.md (bao.markets) — §4, §6, §8
 * @see Elements Core: src/script/interpreter.cpp (SignatureHashSchnorr,
 *      Get*SHA256 helpers), src/primitives/confidential.h, transaction.h
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { locktimeToPush, pushHex, taprootProgram } from './liquidEscrow';

const Point = secp256k1.Point;

// ── Constants ────────────────────────────────────────────────────────────────

/** Elements tapscript leaf version (interpreter.h TAPROOT_LEAF_TAPSCRIPT).
 *  ELEMENTS uses 0xc4 — Bitcoin's BIP-342 value is 0xc0, which elementsd
 *  treats as an upgradable leaf version and rejects with "Taproot version
 *  reserved for soft-fork upgrades". (v0.6.3 fix; v0.6.2 shipped 0xc0.) */
export const TAPROOT_LEAF_VERSION = 0xc4;
/** First byte of a script-path control block: leaf version | OUTPUT-key Y-parity. */
export const TAPROOT_CONTROL_BASE = 0xc4;

/** BIP-341 / Elements sighash types (the taproot digest commits the raw byte). */
export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;
export const SIGHASH_OUTPUT_MASK = 0x03;
export const SIGHASH_INPUT_MASK = 0x80;

/** Outpoint-flag bits (Elements COutPoint OUTPOINT_*_FLAG >> 24). 0 for WS-A inputs. */
export const OUTPOINT_ISSUANCE_FLAG = 0x80;
export const OUTPOINT_PEGIN_FLAG = 0x40;

/** Default codeseparator position (no OP_CODESEPARATOR in the leaf). */
export const CODESEP_POS_NONE = 0xffffffff;

/**
 * Chain genesis block hashes, uint256 **internal byte order** (the raw bytes
 * as serialized — reverse of the RPC/explorer display hex), used to
 * domain-separate the Elements taproot sighash per chain.
 *
 * Elements Core seeds the sighash hasher with the genesis uint256 TWICE
 * (`interpreter.cpp`: `HashWriter(HASHER_TAPSIGHASH_ELEMENTS) <<
 * hash_genesis_block << hash_genesis_block`), and `HashWriter` serializes a
 * uint256 as its raw internal bytes (`uint256.h`: `s << Span(m_data)`;
 * `GetHex()` display is the REVERSE of those bytes). The constants are
 * therefore derived from their display forms (pinned by Elements Core
 * `kernel/chainparams.cpp` mainnet `GetHex()` assert and the Liquid /
 * liquidtestnet Esplora APIs, block height 0) so the two orders cannot be
 * mixed up again — v0.6.0 shipped the display hex verbatim, which fed the
 * reversed bytes into every sighash preimage (fixed in v0.6.2).
 *
 * BAO signet is its own chain — supply its genesis hash explicitly, in
 * internal byte order (see `reverseHex`); testnet HRPs do not imply the
 * testnet genesis.
 */
const LIQUID_MAINNET_GENESIS_DISPLAY = '1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003';
const LIQUID_TESTNET_GENESIS_DISPLAY = 'a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1';
export const LIQUID_MAINNET_GENESIS = reverseHex(LIQUID_MAINNET_GENESIS_DISPLAY);
export const LIQUID_TESTNET_GENESIS = reverseHex(LIQUID_TESTNET_GENESIS_DISPLAY);

const textEncoder = new TextEncoder();

// ── Micro helpers ────────────────────────────────────────────────────────────

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

/** Bitcoin CompactSize prefix (scripts/witnesses here are < 2^32). */
function compactSize(length: number): Uint8Array {
  if (length < 253) return Uint8Array.of(length);
  if (length < 0x10000) {
    return Uint8Array.of(253, length & 0xff, length >> 8);
  }
  return Uint8Array.of(254, length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff, (length >> 24) & 0xff);
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function i32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n | 0, true);
  return b;
}

/** Single SHA256 over the concatenation of `parts` (Elements' HashWriter GetSHA256). */
function sha256Concat(parts: readonly Uint8Array[]): Uint8Array {
  return sha256(concatBytes(...parts));
}

/** Lexicographic byte compare (BIP-341 branch ordering == vendored bytesToScalar order). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Elements TapBranch hash over lexicographically sorted children (HASHER_TAPBRANCH_ELEMENTS). */
function branchHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  const [a, b] = [l, r].sort(compareBytes);
  return taggedHash('TapBranch/elements', a, b);
}

function serializeVector(bytes: Uint8Array): Uint8Array {
  return concatBytes(compactSize(bytes.length), bytes);
}

function serializeScript(scriptHex: string): Uint8Array {
  return serializeVector(hexToBytes(scriptHex));
}

// ── WS-A leaf scripts (spec §3) ─────────────────────────────────────────────

function assertXOnly(hex: string, what: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== 32) throw new Error(`taprootSpend: ${what} must be 32-byte x-only, got ${b.length}`);
  return b;
}

/**
 * WS-A cooperative leaf: `<pk_P> OP_CHECKSIG` (immediate, owner signs).
 * Hex shape: `20 <pk_P> ac`.
 */
export function buildWsACoopLeaf(pkXOnly: string): string {
  assertXOnly(pkXOnly, 'coop leaf pubkey');
  return bytesToHex(concatBytes(pushHex(pkXOnly), Uint8Array.of(0xac)));
}

/**
 * WS-A self-refund leaf: `<close+Δ> OP_CLTV OP_DROP <pk_P> OP_CHECKSIG`.
 * `refundLocktime` is the absolute Liquid block height (minimal script-number
 * push via `liquidEscrow.ts::locktimeToPush`, so OP_CLTV never sees a negative
 * script number).
 */
export function buildWsARefundLeaf(pkXOnly: string, refundLocktime: number): string {
  assertXOnly(pkXOnly, 'refund leaf pubkey');
  return bytesToHex(concatBytes(
    locktimeToPush(refundLocktime),
    Uint8Array.of(0xb1, 0x75), // OP_CHECKLOCKTIMEVERIFY OP_DROP
    pushHex(pkXOnly),
    Uint8Array.of(0xac), // OP_CHECKSIG
  ));
}

/**
 * M3 (SMJ-MATCHING-ENGINE-PLAN.md §M3) — pairwise user-vs-user tree leaves.
 *
 * Both users are matched counterparts on the SAME market. The coop leaf must
 * therefore require BOTH signatures (winner-take-all mutual close) and the
 * refund leaves must let each user pull back their OWN side after close+Δ —
 * unlike the single-depositor WS-A tree (one trader vs platform).
 */

/**
 * Strict 2-of-2 cooperative leaf: `<pk_A> OP_CHECKSIG <pk_B> OP_CHECKSIGADD
 * OP_2 OP_EQUAL` — succeeds IFF both signatures are valid.
 * Hex shape: `20 <pk_A> ac 20 <pk_B> ba 52 87`.
 *
 * ⚠️ Deliberate divergence from WS-E `buildCoopStakeLeaf` (bao.markets
 * TournamentStakeService, #1055): that leaf is `… CHECKSIGADD` WITHOUT the
 * `OP_2 OP_EQUAL` tail, which tapscript evaluates as 1-of-2 (CHECKSIGADD sums
 * valid-sig counts; any one valid sig leaves a non-zero top-of-stack). WS-E
 * can afford 1-of-2 because the operator is server-controlled and enforces
 * the sponsor signature before finalizing. For user-vs-user pairs that is a
 * theft vector — the refusing loser would unilaterally claim BOTH UTXOs — so
 * the pairwise leaf pins the strict 2-of-2 form (see the §M3 design note:
 * "COOP leaf requiring both sigs ONLY for mutual close").
 *
 * Witness stack order (top-down consumption): `[sigB, sigA, leaf, control]`
 * — the same reversed order WS-E assembles (`[operatorSig, sponsorSig, …]`).
 */
export function buildPairwiseCoopLeaf(pkAXOnly: string, pkBXOnly: string): string {
  assertXOnly(pkAXOnly, 'pairwise coop leaf pubkey A');
  assertXOnly(pkBXOnly, 'pairwise coop leaf pubkey B');
  return bytesToHex(concatBytes(
    pushHex(pkAXOnly),
    Uint8Array.of(0xac), // OP_CHECKSIG
    pushHex(pkBXOnly),
    Uint8Array.of(0xba), // OP_CHECKSIGADD
    Uint8Array.of(0x52, 0x87), // OP_2 OP_EQUAL — strict 2-of-2
  ));
}

/**
 * Dual self-refund leaves: both parties can pull their OWN side back after
 * close+Δ — `[refundA, refundB]`:
 *   REFUND-A: `<close+Δ> OP_CLTV OP_DROP <pk_A> OP_CHECKSIG`
 *   REFUND-B: `<close+Δ> OP_CLTV OP_DROP <pk_B> OP_CHECKSIG`
 * Same shape as `buildWsARefundLeaf`, mirrored per participant. Each refund
 * leaf only ever spends its OWNER's deposit, so a refusing loser cannot
 * touch the winner's side — the CLTV is the shared escape valve post-close+Δ.
 */
export function buildDualRefundLeaves(pkAXOnly: string, pkBXOnly: string, refundLocktime: number): [string, string] {
  return [
    buildWsARefundLeaf(pkAXOnly, refundLocktime),
    buildWsARefundLeaf(pkBXOnly, refundLocktime),
  ];
}

// ── Taproot tree: leaf hash, path, control block ────────────────────────────

/** Lift an x-only pubkey to its curve point (tries both Y parities). */
function liftXOnly(xOnly: Uint8Array): ReturnType<typeof Point.fromHex> {
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
  throw new Error('taprootSpend: cannot lift x-only key to curve point');
}

function bytesToScalar(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Y-parity (0 = even, 1 = odd) of the taproot OUTPUT key
 *
 *   Q = lift_x(P) + tagged_hash("TapTweak/elements", P || merkleRoot)·G
 *
 * (Elements domain per pubkeys.cpp HASHER_TAPTWEAK_ELEMENTS; v0.6.2 used the
 * Bitcoin-domain tag — see the v0.6.3 change note.)
 *
 * The script-path control block's low bit MUST equal this value. This is a
 * property of the tweaked key pair, so it can only be computed from the
 * internal key + merkle root — it cannot be defaulted or guessed.
 */
export function outputKeyParity(internalKeyXOnly: string, merkleRootHex: string): 0 | 1 {
  const key = hexToBytes(internalKeyXOnly);
  if (key.length !== 32) throw new Error(`taprootSpend: internal key must be 32-byte x-only, got ${key.length}`);
  const merkle = hexToBytes(merkleRootHex);
  if (merkle.length !== 32) throw new Error(`taprootSpend: merkle root must be 32 bytes, got ${merkle.length}`);
  const tweak = bytesToScalar(taggedHash('TapTweak/elements', key, merkle));
  if (tweak >= Point.Fn.ORDER) {
    throw new Error('taprootSpend: taproot tweak exceeds the curve order');
  }
  const Q = liftXOnly(key).add(Point.BASE.multiply(tweak));
  return Q.toHex(true).startsWith('03') ? 1 : 0;
}

/** Elements TapLeaf hash:
 *  tagged_hash("TapLeaf/elements", 0xc4 || compact_size(len) || script)
 *  (interpreter.cpp HASHER_TAPLEAF_ELEMENTS + TAPROOT_LEAF_TAPSCRIPT=0xc4 —
 *  v0.6.2 used Bitcoin's plain "TapLeaf" tag and 0xc0 version byte). */
export function tapleafHash(scriptHex: string): string {
  const script = hexToBytes(scriptHex);
  return bytesToHex(taggedHash('TapLeaf/elements', Uint8Array.of(TAPROOT_LEAF_VERSION), compactSize(script.length), script));
}

function merkleRootHashes(list: Uint8Array[]): Uint8Array {
  if (list.length === 1) return list[0];
  const mid = list.length >> 1; // Bitcoin Core split-at-half, same as tapMerkleRoot
  return branchHash(merkleRootHashes(list.slice(0, mid)), merkleRootHashes(list.slice(mid)));
}

/**
 * Merkle path for `leafIndex` in the split-at-half tree over `leaves`,
 * ordered leaf→root (each entry is the sibling hash at that level). For a
 * two-leaf tree the path is the single sibling leaf hash — the shape pinned by
 * the §8.1 control-block vectors.
 *
 * M3 FIX (found drafting the pairwise tree): siblings are discovered top-down
 * here, and BIP-341 folds the path in leaf→root order — the emitted path must
 * be reversed or the folded root diverges from tapMerkleRoot for any tree
 * with >2 leaves (2-leaf trees are order-invariant, which is why every
 * shipped WS-A/WS-E control block was correct).
 */
export function taprootMerklePath(leaves: readonly string[], leafIndex: number): string[] {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`taprootSpend: leafIndex ${leafIndex} out of range for ${leaves.length} leaves`);
  }
  let list = leaves.map((l) => hexToBytes(tapleafHash(l)));
  let index = leafIndex;
  const path: Uint8Array[] = [];
  while (list.length > 1) {
    const mid = list.length >> 1;
    const left = list.slice(0, mid);
    const right = list.slice(mid);
    if (index < mid) {
      path.push(merkleRootHashes(right));
      list = left;
    } else {
      path.push(merkleRootHashes(left));
      list = right;
      index -= mid;
    }
  }
  return path.map(bytesToHex).reverse();
}

/**
 * Elements control block: `[0xc4 | parity] || internal_key_x || path…`.
 * `parity` is the Y-parity of the OUTPUT key Q = lift_x(P) + t·G with
 * t = int(tagged_hash("TapTweak/elements", P || merkleRoot)) — never the
 * internal key's. It is derived here from `(internalKeyXOnly, merkleRoot)`
 * so an out-of-parity (consensus-invalid) control block cannot be assembled
 * by accident; v0.6.0 took parity as a parameter defaulting to 0, which is
 * wrong whenever Q has odd Y (~50% of outputs).
 */
export function controlBlock(internalKeyXOnly: string, merklePath: readonly string[], merkleRootHex: string): string {
  const parity = outputKeyParity(internalKeyXOnly, merkleRootHex);
  const parts: string[] = [bytesToHex(Uint8Array.of(TAPROOT_CONTROL_BASE | parity)), internalKeyXOnly];
  for (const p of merklePath) {
    const b = hexToBytes(p);
    if (b.length !== 32) throw new Error(`taprootSpend: path element must be 32 bytes, got ${b.length}`);
    parts.push(p);
  }
  return parts.join('');
}

/** Convenience: control block for a leaf in a tree — path, root and Q-parity all derived internally. */
export function scriptPathControlBlock(
  internalKeyXOnly: string,
  leaves: readonly string[],
  leafIndex: number,
): string {
  const path = taprootMerklePath(leaves, leafIndex); // validates leafIndex / non-empty tree
  const root = bytesToHex(merkleRootHashes(leaves.map((l) => hexToBytes(tapleafHash(l)))));
  return controlBlock(internalKeyXOnly, path, root);
}

/** Internal key (x-only) embedded in a control block. */
export function controlBlockInternalKey(controlBlockHex: string): string {
  const b = hexToBytes(controlBlockHex);
  if (b.length < 33 || b.length % 32 !== 1) {
    throw new Error(`taprootSpend: malformed control block (length ${b.length})`);
  }
  return bytesToHex(b.subarray(1, 33));
}

/** Merkle path embedded in a control block (hex elements, leaf→root order). */
export function controlBlockMerklePath(controlBlockHex: string): string[] {
  const b = hexToBytes(controlBlockHex);
  if (b.length < 33 || b.length % 32 !== 1) {
    throw new Error(`taprootSpend: malformed control block (length ${b.length})`);
  }
  const path: string[] = [];
  for (let i = 33; i < b.length; i += 32) path.push(bytesToHex(b.subarray(i, i + 32)));
  return path;
}

/** Merkle root committed by a leaf hash + path (the consensus recomputation). */
export function merkleRootFromLeafAndPath(leafHash: string, merklePath: readonly string[]): string {
  let acc: Uint8Array = hexToBytes(leafHash);
  if (acc.length !== 32) throw new Error(`taprootSpend: leaf hash must be 32 bytes, got ${acc.length}`);
  for (const p of merklePath) {
    const sib = hexToBytes(p);
    if (sib.length !== 32) throw new Error(`taprootSpend: path element must be 32 bytes, got ${sib.length}`);
    acc = branchHash(acc, sib);
  }
  return bytesToHex(acc);
}

// ── Elements confidential-field serialization (spec §8 / Elements wire) ─────

/**
 * Serialize an explicit (unblinded) value: `0x01 || uint64 BE` (Elements
 * `CConfidentialValue::SetToAmount` uses `WriteBE64` — big-endian).
 */
export function serializeExplicitValue(amountSats: bigint | number): string {
  const amount = typeof amountSats === 'bigint' ? amountSats : BigInt(amountSats);
  if (amount < 0n || amount > 0xffffffffffffffffn) {
    throw new Error(`taprootSpend: explicit value out of range: ${amount}`);
  }
  const out = new Uint8Array(9);
  out[0] = 0x01;
  new DataView(out.buffer).setBigUint64(1, amount, false); // big-endian
  return bytesToHex(out);
}

/**
 * Serialize an explicit (unblinded) asset: `0x01 || 32-byte asset id`
 * (Elements `CConfidentialAsset::SetToAsset`).
 */
export function serializeExplicitAsset(assetIdHex: string): string {
  const id = hexToBytes(assetIdHex);
  if (id.length !== 32) throw new Error(`taprootSpend: asset id must be 32 bytes, got ${id.length}`);
  return `01${assetIdHex}`;
}

/** Reverse a 32-byte hex string (display txid ↔ internal byte order). */
export function reverseHex(hex: string): string {
  const b = hexToBytes(hex);
  b.reverse();
  return bytesToHex(b);
}

// ── Elements taproot sighash (port of SignatureHashSchnorr, TAPSCRIPT) ──────

export interface ElementsIssuance {
  /** 32-byte hex asset blinding nonce. */
  readonly assetBlindingNonce: string;
  /** 32-byte hex asset entropy. */
  readonly assetEntropy: string;
  /** Serialized issuance amount (CConfidentialValue wire form). */
  readonly amount: string;
  /** Serialized issuance inflation-keys (CConfidentialValue wire form). */
  readonly inflationKeys: string;
}

export interface ElementsSighashInput {
  /** Prevout txid in INTERNAL byte order (reverse of display hex — use `reverseHex`). */
  readonly txid: string;
  readonly vout: number;
  readonly sequence: number;
  /** Outpoint flag byte (0 for normal inputs; OUTPOINT_ISSUANCE_FLAG/OUTPOINT_PEGIN_FLAG for those). */
  readonly outpointFlag?: number;
  /** Serialized spent-output asset commitment (e.g. `serializeExplicitAsset`, or a blinded 33-byte commitment). */
  readonly asset: string;
  /** Serialized spent-output value commitment (e.g. `serializeExplicitValue`, or a blinded 33-byte commitment). */
  readonly value: string;
  /** Spent-output locking script (hex). */
  readonly scriptPubKey: string;
  /** Issuance for this input (WS-A inputs have none). */
  readonly issuance?: ElementsIssuance;
  /** Issuance-amount rangeproof (hex, default ''). */
  readonly issuanceAmountRangeproof?: string;
  /** Issuance inflation-keys rangeproof (hex, default ''). */
  readonly issuanceInflationKeysRangeproof?: string;
}

export interface ElementsSighashOutput {
  /** Serialized output asset commitment (wire form). */
  readonly asset: string;
  /** Serialized output value commitment (wire form). */
  readonly value: string;
  /** Serialized output nonce (null/unblinded → '00'). */
  readonly nonce: string;
  /** Output locking script (hex). */
  readonly scriptPubKey: string;
}

export interface ElementsOutputWitness {
  /** Output rangeproof (hex, default ''). */
  readonly rangeproof?: string;
  /** Output surjection proof (hex, default ''). */
  readonly surjectionproof?: string;
}

export interface ElementsTaprootSighashParams {
  /** Chain genesis block hash, INTERNAL byte order (see LIQUID_*_GENESIS). */
  readonly genesisBlockHash: string;
  /** Transaction version (int32). Default 2. */
  readonly version?: number;
  /** Transaction nLockTime (uint32). Default 0. */
  readonly lockTime?: number;
  readonly inputs: readonly ElementsSighashInput[];
  readonly outputs: readonly ElementsSighashOutput[];
  /** Output witnesses (vtxoutwit). Empty for all-unblinded txs — mirrors CTxWitness. */
  readonly outputWitnesses?: readonly ElementsOutputWitness[];
  readonly inputIndex: number;
  /** BIP-341 TapLeaf hash of the leaf being spent (script-path spend). */
  readonly tapleafHash: string;
  /** Sighash type byte (SIGHASH_DEFAULT 0x00 for WS-A cooperative settlement). */
  readonly hashType?: number;
  /** OP_CODESEPARATOR position. Default 0xffffffff. */
  readonly codesepPos?: number;
}

function serializeIssuance(iss: ElementsIssuance | undefined): Uint8Array {
  if (!iss) return Uint8Array.of(0); // null issuance → single 0x00 byte
  return concatBytes(
    hexToBytes(iss.assetBlindingNonce),
    hexToBytes(iss.assetEntropy),
    hexToBytes(iss.amount),
    hexToBytes(iss.inflationKeys),
  );
}

function serializeTxOut(o: ElementsSighashOutput): Uint8Array {
  return concatBytes(hexToBytes(o.asset), hexToBytes(o.value), hexToBytes(o.nonce), serializeScript(o.scriptPubKey));
}

function serializeTxOutWitness(w: ElementsOutputWitness): Uint8Array {
  return concatBytes(serializeVector(hexToBytes(w.rangeproof ?? '')), serializeVector(hexToBytes(w.surjectionproof ?? '')));
}

/**
 * Elements taproot signature hash for a **script-path** (TAPSCRIPT) spend —
 * faithful port of Elements Core `SignatureHashSchnorr`:
 *
 *   digest = SHA256( SHA256("TapSighash/elements") || SHA256("TapSighash/elements")
 *                    || genesis || genesis || body )
 *
 * `body` (SIGHASH_DEFAULT/ALL, non-ACP, no annex):
 *   hash_type(1) ‖ version(4) ‖ lockTime(4)
 *   ‖ sha_outpoint_flags ‖ sha_prevouts ‖ sha_spent_assets_amounts
 *   ‖ sha_spent_scripts ‖ sha_sequences ‖ sha_issuances ‖ sha_issuance_rangeproofs
 *   ‖ sha_outputs ‖ sha_output_witnesses
 *   ‖ spend_type(1)=0x02 ‖ inputIndex(4)
 *   ‖ tapleaf_hash(32) ‖ key_version(1)=0 ‖ codesep_pos(4)
 *
 * No annex is supported (WS-A leaves never use one); pass a non-default
 * `hashType` only if you know the Elements semantics (ACP/SINGLE/NONE branches
 * are ported). The fee is NOT a field — it is implied by the committed inputs
 * and outputs.
 */
export function taprootSighashElements(params: ElementsTaprootSighashParams): string {
  const { inputs, outputs, inputIndex } = params;
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= inputs.length) {
    throw new Error(`taprootSpend: inputIndex ${inputIndex} out of range for ${inputs.length} inputs`);
  }
  const hashType = params.hashType ?? SIGHASH_DEFAULT;
  if (!(hashType <= 0x03 || (hashType >= 0x81 && hashType <= 0x83))) {
    throw new Error(`taprootSpend: invalid sighash type 0x${hashType.toString(16)}`);
  }
  const genesis = hexToBytes(params.genesisBlockHash);
  if (genesis.length !== 32) throw new Error(`taprootSpend: genesis block hash must be 32 bytes, got ${genesis.length}`);
  const tapleaf = hexToBytes(params.tapleafHash);
  if (tapleaf.length !== 32) throw new Error(`taprootSpend: tapleaf hash must be 32 bytes, got ${tapleaf.length}`);
  const codesepPos = params.codesepPos ?? CODESEP_POS_NONE;

  const outputType = hashType === SIGHASH_DEFAULT ? SIGHASH_ALL : hashType & SIGHASH_OUTPUT_MASK;
  const anyOneCanPay = (hashType & SIGHASH_INPUT_MASK) === SIGHASH_ANYONECANPAY;

  const body: Uint8Array[] = [Uint8Array.of(hashType), i32le(params.version ?? 2), u32le(params.lockTime ?? 0)];

  if (!anyOneCanPay) {
    body.push(
      sha256Concat(inputs.map((i) => Uint8Array.of(i.outpointFlag ?? 0))),
      sha256Concat(inputs.map((i) => concatBytes(hexToBytes(i.txid), u32le(i.vout)))),
      sha256Concat(inputs.map((i) => concatBytes(hexToBytes(i.asset), hexToBytes(i.value)))),
      sha256Concat(inputs.map((i) => serializeScript(i.scriptPubKey))),
      sha256Concat(inputs.map((i) => u32le(i.sequence))),
      sha256Concat(inputs.map((i) => serializeIssuance(i.issuance))),
      sha256Concat(inputs.map((i) =>
        concatBytes(
          serializeVector(hexToBytes(i.issuanceAmountRangeproof ?? '')),
          serializeVector(hexToBytes(i.issuanceInflationKeysRangeproof ?? '')),
        ))),
    );
  }
  if (outputType === SIGHASH_ALL) {
    body.push(sha256Concat(outputs.map(serializeTxOut)));
    body.push(sha256Concat((params.outputWitnesses ?? []).map(serializeTxOutWitness)));
  }

  body.push(Uint8Array.of(0x02)); // spend_type: TAPSCRIPT (ext_flag=1), no annex

  if (anyOneCanPay) {
    const inp = inputs[inputIndex];
    body.push(
      Uint8Array.of(inp.outpointFlag ?? 0),
      concatBytes(hexToBytes(inp.txid), u32le(inp.vout)),
      hexToBytes(inp.asset),
      hexToBytes(inp.value),
      serializeScript(inp.scriptPubKey),
      u32le(inp.sequence),
    );
    if (inp.issuance) {
      body.push(serializeIssuance(inp.issuance));
      body.push(sha256Concat([
        serializeVector(hexToBytes(inp.issuanceAmountRangeproof ?? '')),
        serializeVector(hexToBytes(inp.issuanceInflationKeysRangeproof ?? '')),
      ]));
    }
  } else {
    body.push(u32le(inputIndex));
  }

  if (outputType === SIGHASH_SINGLE) {
    if (inputIndex >= outputs.length) {
      throw new Error('taprootSpend: SIGHASH_SINGLE requires an output at inputIndex');
    }
    body.push(sha256Concat([serializeTxOut(outputs[inputIndex])]));
    const w = (params.outputWitnesses ?? [])[inputIndex] ?? {};
    body.push(sha256Concat([serializeTxOutWitness(w)]));
  }

  body.push(tapleaf, Uint8Array.of(0), u32le(codesepPos)); // TAPSCRIPT tail

  const tagHash = sha256(textEncoder.encode('TapSighash/elements'));
  const bodyBytes = concatBytes(...body);
  const input = new Uint8Array(64 + 64 + bodyBytes.length);
  input.set(tagHash, 0);
  input.set(tagHash, 32);
  input.set(genesis, 64);
  input.set(genesis, 96);
  input.set(bodyBytes, 128);
  return bytesToHex(sha256(input));
}

// ── Witness finalization ─────────────────────────────────────────────────────

export interface FinalizeTaprootParams {
  /** Chain genesis block hash, internal byte order. */
  readonly genesisBlockHash: string;
  readonly version?: number;
  readonly lockTime?: number;
  readonly inputs: readonly ElementsSighashInput[];
  readonly outputs: readonly ElementsSighashOutput[];
  readonly outputWitnesses?: readonly ElementsOutputWitness[];
  readonly inputIndex: number;
  /** Script-path leaf being spent (hex). */
  readonly leafScript: string;
  /** Control block for this leaf (hex — `scriptPathControlBlock`). */
  readonly controlBlock: string;
  /** 64-byte Schnorr signature over the sighash (hex, WITHOUT the sighash byte —
   *  it is appended automatically when `hashType` ≠ SIGHASH_DEFAULT). */
  readonly signature: string;
  /** Extra stack items pushed BEFORE the signature. Default [] — WS-A COOP/REFUND leaves need only the sig. */
  readonly stack?: readonly string[];
  readonly hashType?: number;
  readonly codesepPos?: number;
  /** When provided, verifies the leaf + control block commit to this output key (x-only hex). */
  readonly expectedOutputKey?: string;
}

/**
 * Finalize a WS-A script-path spend: compute the Elements taproot sighash and
 * assemble the witness `[sig, ...stack, leafScript, controlBlock]`.
 *
 * When `expectedOutputKey` is supplied, the leaf + control block are verified
 * to commit to it (recompute the merkle root from leaf + path, re-tweak the
 * internal key embedded in the control block) — catching a wrong leaf/path
 * before anything is signed. The control block's parity bit is ALWAYS checked
 * against the Y-parity of the recomputed output key (BIP-341), whether or not
 * `expectedOutputKey` is given.
 */
export function finalizeTaproot(params: FinalizeTaprootParams): { sighash: string; witness: readonly string[] } {
  const leafHash = tapleafHash(params.leafScript);
  const path = controlBlockMerklePath(params.controlBlock);
  const recomputedRoot = merkleRootFromLeafAndPath(leafHash, path);
  const internalKey = controlBlockInternalKey(params.controlBlock);
  const outputKey = bytesToHex(taprootProgram(internalKey, recomputedRoot));
  if (params.expectedOutputKey !== undefined && outputKey !== params.expectedOutputKey) {
    throw new Error('finalizeTaproot: leaf/control block do not commit to expectedOutputKey');
  }
  // BIP-341: the control block's low bit must equal the OUTPUT key Q's
  // Y-parity — an x-only comparison above cannot catch a wrong parity.
  const cbParity = (hexToBytes(params.controlBlock)[0] & 0x01) as 0 | 1;
  if (cbParity !== outputKeyParity(internalKey, recomputedRoot)) {
    throw new Error('finalizeTaproot: control block parity does not match the output key');
  }
  const hashType = params.hashType ?? SIGHASH_DEFAULT;
  const signature = hexToBytes(params.signature);
  if (signature.length !== 64) {
    throw new Error(`finalizeTaproot: signature must be 64 bytes, got ${signature.length}`);
  }
  const sighash = taprootSighashElements({
    genesisBlockHash: params.genesisBlockHash,
    version: params.version,
    lockTime: params.lockTime,
    inputs: params.inputs,
    outputs: params.outputs,
    outputWitnesses: params.outputWitnesses,
    inputIndex: params.inputIndex,
    tapleafHash: leafHash,
    hashType,
    codesepPos: params.codesepPos,
  });
  // BIP-341 / Elements (`CheckSchnorrSignature`): a non-default hash_type is
  // appended to the signature (65-byte witness element); SIGHASH_DEFAULT keeps
  // the bare 64-byte form.
  const sigElement = bytesToHex(
    hashType === SIGHASH_DEFAULT ? signature : concatBytes(signature, Uint8Array.of(hashType)),
  );
  const witness = [sigElement, ...(params.stack ?? []), params.leafScript, params.controlBlock];
  return { sighash, witness };
}
