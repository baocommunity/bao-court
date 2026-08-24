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
 *      `taproot_tree_helper` shape). A wrong-shaped tree fails consensus; the
 *      path here is guaranteed consistent with the pinned vectors.
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

import { locktimeToPush, pushHex, taprootProgram } from './liquidEscrow';

// ── Constants ────────────────────────────────────────────────────────────────

/** BIP-341 tapscript leaf version (all WS-A leaves use 0xc0). */
export const TAPROOT_LEAF_VERSION = 0xc0;
/** First byte of a script-path control block: leaf version | internal-key parity. */
export const TAPROOT_CONTROL_BASE = 0xc0;

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
 * as serialized — reverse of the display hex), used to domain-separate the
 * Elements taproot sighash per chain.
 *
 * Verified against Elements Core `chainparams.cpp` (mainnet assert) and
 * esplora block 0. BAO signet is its own chain — supply its genesis hash
 * explicitly (testnet HRPs do not imply the testnet genesis).
 */
export const LIQUID_MAINNET_GENESIS = '1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003';
export const LIQUID_TESTNET_GENESIS = 'a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1';

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

function branchHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  const [a, b] = [l, r].sort(compareBytes);
  return taggedHash('TapBranch', a, b);
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

// ── Taproot tree: leaf hash, path, control block ────────────────────────────

/** BIP-341 TapLeaf hash: tagged_hash("TapLeaf", 0xc0 || compact_size(len) || script). */
export function tapleafHash(scriptHex: string): string {
  const script = hexToBytes(scriptHex);
  return bytesToHex(taggedHash('TapLeaf', Uint8Array.of(TAPROOT_LEAF_VERSION), compactSize(script.length), script));
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
  return path.map(bytesToHex);
}

/**
 * BIP-341 control block: `[0xc0 | parity] || internal_key_x || path…`.
 * `parity` is the Y-parity of the internal key as lifted for the taproot tweak
 * (the vendored `taprootProgram` lifts even-Y, so WS-A control blocks carry
 * parity 0 → first byte `0xc0`, matching the pinned vectors).
 */
export function controlBlock(internalKeyXOnly: string, merklePath: readonly string[], parity: 0 | 1 = 0): string {
  assertXOnly(internalKeyXOnly, 'internal key');
  if (parity !== 0 && parity !== 1) throw new Error(`taprootSpend: parity must be 0|1, got ${parity}`);
  const parts: string[] = [bytesToHex(Uint8Array.of(TAPROOT_CONTROL_BASE | parity)), internalKeyXOnly];
  for (const p of merklePath) {
    const b = hexToBytes(p);
    if (b.length !== 32) throw new Error(`taprootSpend: path element must be 32 bytes, got ${b.length}`);
    parts.push(p);
  }
  return parts.join('');
}

/** Convenience: control block for a leaf in a tree, computing the path internally. */
export function scriptPathControlBlock(
  internalKeyXOnly: string,
  leaves: readonly string[],
  leafIndex: number,
  parity: 0 | 1 = 0,
): string {
  return controlBlock(internalKeyXOnly, taprootMerklePath(leaves, leafIndex), parity);
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
  /** 64-byte Schnorr signature over the sighash (hex, WITHOUT the sighash byte). */
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
 * before anything is signed.
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
    hashType: params.hashType,
    codesepPos: params.codesepPos,
  });
  const witness = [params.signature, ...(params.stack ?? []), params.leafScript, params.controlBlock];
  return { sighash, witness };
}
