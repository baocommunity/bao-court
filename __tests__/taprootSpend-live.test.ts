/**
 * WS-A Taproot Spend — REAL script-path spend, confirmed on-chain (§8.6 proof)
 *
 * This is consensus-level validation on a live bao-elements liquidregtest
 * chain. Unlike a wallet-assisted flow, EVERY consensus-relevant byte is
 * produced locally from the library and pushed through `sendrawtransaction`:
 *
 *   1. Fresh trader keypair (`secp256k1.utils.randomSecretKey`), x-only pubkey.
 *      Internal key stays the pinned NUMS point from the spec (ad6d…73f4).
 *   2. The production two-leaf tree (`buildWsACoopLeaf` + `buildWsARefundLeaf`),
 *      merkle root via `tapMerkleRoot`, address via `taprootAddress`.
 *   3. The output is funded by the faucet; the UTXO is located via
 *      `listunspent` filtered to OUR derived scriptPubKey (proving the tree
 *      math / tweak / program match what the chain actually stores). The
 *      address is imported watch-only into a dedicated DESCRIPTOR wallet
 *      (a `taproot_watch` descriptor wallet, created if absent) because legacy
 *      wallets refuse
 *      bech32m imports.
 *   4. The Elements spend transaction is hand-serialized (elements wire
 *      format: version ‖ flags ‖ vin ‖ vout ‖ locktime ‖ witness-at-end,
 *      explicit asset/value commitments, explicit fee output LAST) and the
 *      COOP leaf sighash computed with `taprootSighashElements` over the REAL
 *      chain genesis hash (fetched via `getblockhash 0`, display→internal).
 *   5. Signed with the trader key (64-byte BIP-340 Schnorr, SIGHASH_DEFAULT);
 *      witness `[sig, coopLeafScript, controlBlock]` assembled via
 *      `scriptPathControlBlock` (output-key parity bit included).
 *   6. Broadcast via SSH `sendrawtransaction`, mined, and verified CONFIRMED
 *      while consuming exactly our UTXO. Elements rejects wrong parity /
 *      wrong sighash at consensus — acceptance IS the §8.6 claim.
 *
 * A rejection here surfaces the FULL node error in the failure message; we do
 * not weaken assertions on failure modes.
 *
 * Requirements (env-gated; skipped unless ALL are set):
 *   BAO_LIVE_TAPROOT=true
 *   BAO_ELEMENTS_ESPLORA=http://<host>:5001/liquidregtest/api
 *   BAO_ELEMENTS_SSH="ssh -o StrictHostKeyChecking=no root@<host>"
 * Optional HRPs (defaults fit the standard bao-elements regtest chain):
 *   BAO_ELEMENTS_HRP       (default "ert") plain bech32(m) HRP
 *   BAO_ELEMENTS_CONF_HRP  confidential blech32 HRP ("el"). NOTE: this node
 *     build validates bech32m v1 (taproot) addresses against the PLAIN HRP
 *     only — "el" is reserved for blech32 — so the taproot address uses the
 *     plain HRP unless BAO_ELEMENTS_CONF_HRP is explicitly provided.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { execSync } from 'child_process';

import {
  tapMerkleRoot,
  taprootProgram,
  taprootAddress,
} from '../liquidEscrow.js';

import {
  buildWsACoopLeaf,
  buildWsARefundLeaf,
  tapleafHash,
  scriptPathControlBlock,
  taprootSighashElements,
  finalizeTaproot,
  serializeExplicitAsset,
  serializeExplicitValue,
  reverseHex,
  SIGHASH_DEFAULT,
} from '../taprootSpend.js';

// ---------------------------------------------------------------------------
// Config — live infra is injected via env (public repo: no hosts/IPs in code).
// ---------------------------------------------------------------------------
const ESPLORA = process.env.BAO_ELEMENTS_ESPLORA ?? '';
const VPS_SSH = process.env.BAO_ELEMENTS_SSH ?? '';
const LIVE_ENABLED = process.env.BAO_LIVE_TAPROOT === 'true' && Boolean(ESPLORA) && Boolean(VPS_SSH);

const HRP_PLAIN = process.env.BAO_ELEMENTS_HRP ?? 'ert';
const TAPROOT_HRP = process.env.BAO_ELEMENTS_CONF_HRP !== undefined
  ? (process.env.BAO_ELEMENTS_CONF_HRP as string)
  : HRP_PLAIN; // see header note: bech32m v1 parses under the plain HRP here

/** NUMS internal key pinned by the WS-A spec (no known secret key). */
const NUMS_INTERNAL_KEY = 'ad6d59067a92e28cce1ae55b51b060fc712cf897dc236debd386d692ce6973f4';
const ELEMENTS_CLI = 'docker exec bao-elements elements-cli';
const FAUCET_CLI = `${ELEMENTS_CLI} -rpcwallet=faucet`;
/** Descriptor wallet used for watch-only tracking of the taproot output. */
const WATCH_WALLET_CANDIDATES = ['taproot_watch', 'taproot_watch2'] as const;
let watchWallet = ''; // resolved by ensureWatchWallet()
const FUND_AMOUNT_BTC = 0.001;
const FEE_SATS = 1_000;
const REFUND_LEAF_DELTA_BLOCKS = 1_000_000; // far-future CLTV for the refund leaf
const SSH_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ssh(cmd: string): string {
  return execSync(`${VPS_SSH} '${cmd.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf-8',
    timeout: SSH_TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function cli(args: string): string {
  return ssh(`${FAUCET_CLI} ${args}`);
}

function watchCli(args: string): string {
  return ssh(`${ELEMENTS_CLI} -rpcwallet=${watchWallet} ${args}`);
}

/**
 * Ensure a DESCRIPTOR watch-only wallet exists for tracking the taproot
 * output: legacy wallets refuse bech32m imports outright.
 */
function ensureWatchWallet(): void {
  for (const name of WATCH_WALLET_CANDIDATES) {
    try {
      const info = JSON.parse(ssh(`${ELEMENTS_CLI} -rpcwallet=${name} getwalletinfo`));
      if (info.descriptors === true) {
        watchWallet = name;
        return;
      }
    } catch {
      // not present / not loaded — try next candidate
    }
  }
  watchWallet = WATCH_WALLET_CANDIDATES[0];
  ssh(`${ELEMENTS_CLI} -named createwallet wallet_name=${watchWallet} disable_private_keys=true blank=true descriptors=true`);
}

async function esploraGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${ESPLORA}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`esplora GET ${path}: ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

/** Fresh trader keypair → x-only pubkey (BIP-340). */
function randomKeypair(): { priv: Uint8Array; xOnlyPub: string } {
  const priv = secp256k1.utils.randomSecretKey();
  const pubCompressed = secp256k1.getPublicKey(priv, true);
  return { priv, xOnlyPub: Buffer.from(pubCompressed.slice(1)).toString('hex') };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Hand-serialization helpers (minimalTxParams style — elements wire format)
// Elements-mode CTxIn/CTxOut serialization per primitives/transaction.h +
// txwitness.h: version ‖ flags ‖ vin ‖ vout ‖ nLockTime ‖ [witness].
function u32leHex(n: number): string {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return Buffer.from(b).toString('hex');
}

function compactSizeHex(len: number): string {
  if (len < 0 || !Number.isInteger(len)) throw new Error(`compactSizeHex: bad length ${len}`);
  if (len < 0xfd) return len.toString(16).padStart(2, '0');
  if (len <= 0xffff) return 'fd' + len.toString(16).padStart(4, '0'); // LE uint16
  throw new Error(`compactSizeHex: unsupported length ${len}`);
}

function serVecHex(hex: string): string {
  return compactSizeHex(hex.length / 2) + hex;
}

function concatHex(...parts: readonly string[]): string {
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------
beforeAll(async () => {
  const height = await esploraGet<number>('/blocks/tip/height');
  console.log(`[preflight] Elements regtest height: ${height}`);
  expect(height).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe.skipIf(!LIVE_ENABLED)('WS-A taproot spend — REAL script-path spend on elementsregtest', () => {

  it('funds a NUMS-taproot output, spends it via the COOP leaf script path, and confirms on-chain', async () => {
    // ── 1. Trader keypair + production two-leaf WS-A tree ────────────────
    const tipHeight = await esploraGet<number>('/blocks/tip/height');
    const trader = randomKeypair();
    const farFutureHeight = tipHeight + REFUND_LEAF_DELTA_BLOCKS;

    const coopLeaf = buildWsACoopLeaf(trader.xOnlyPub);
    const refundLeaf = buildWsARefundLeaf(trader.xOnlyPub, farFutureHeight);
    const leaves = [coopLeaf, refundLeaf];
    const merkleRoot = tapMerkleRoot(leaves);

    const outputKeyHex = Buffer.from(taprootProgram(NUMS_INTERNAL_KEY, merkleRoot)).toString('hex');
    const expectedSpk = `5120${outputKeyHex}`; // OP_1 PUSH32 <x-only output key>
    const network = { p2wshHrp: HRP_PLAIN, taprootHrp: TAPROOT_HRP };
    const tapAddr = taprootAddress(NUMS_INTERNAL_KEY, merkleRoot, network);

    console.log(`\n── WS-A taproot output ──`);
    console.log(`  Merkle root:   ${merkleRoot}`);
    console.log(`  Output key:    ${outputKeyHex}`);
    console.log(`  Address:       ${tapAddr}`);

    // ── 2. Fund the taproot address from the faucet (over SSH) ──────────
    const minerAddr = cli(`getnewaddress`);
    ensureWatchWallet();
    const descInfo = JSON.parse(watchCli(`getdescriptorinfo "addr(${tapAddr})"`));
    watchCli(`importdescriptors '[{"desc":"addr(${tapAddr})#${descInfo.checksum}","timestamp":"now"}]'`);
    const fundTxid = cli(`sendtoaddress ${tapAddr} ${FUND_AMOUNT_BTC}`);
    console.log(`  Fund txid:     ${fundTxid}`);
    expect(fundTxid).toMatch(/^[0-9a-f]{64}$/);
    cli(`generatetoaddress 1 ${minerAddr}`);
    await sleep(2000);

    // ── 3. Locate the UTXO via listunspent filtered to OUR scriptPubKey ─
    const unspent = JSON.parse(watchCli(`listunspent 1 9999999 '["${tapAddr}"]'`)) as any[];
    const utxo = unspent.find((u) => u.scriptPubKey?.toLowerCase() === expectedSpk);
    expect({
      foundUtxoForSpk: Boolean(utxo),
      expectedSpk,
      candidates: unspent.map((u) => ({ txid: u.txid, vout: u.vout, spk: u.scriptPubKey })),
    }).toEqual({ foundUtxoForSpk: true, expectedSpk, candidates: expect.any(Array) });
    const valueSats = Math.round(Number(utxo.amount) * 1e8);
    const assetId = String(utxo.asset).toLowerCase(); // L-BTC (policy asset), DISPLAY order
    // Asset ids are uint256s: the WIRE commitment carries INTERNAL byte order
    // (reverse of RPC display), exactly like txids — verified byte-for-byte
    // against this node's own `createrawtransaction … {"fee":…}` output.
    const assetWireHex = reverseHex(assetId);
    const fundVout = Number(utxo.vout);
    expect(valueSats).toBe(Math.round(FUND_AMOUNT_BTC * 1e8));
    expect(assetId).toMatch(/^[0-9a-f]{64}$/);
    console.log(`  UTXO:          ${fundTxid}:${fundVout} (${valueSats} sats, asset ${assetId.slice(0, 12)}…)`);

    // ── 4. Recipient (faucet-owned plain bech32 address) + fee split ────
    const destAddr = cli(`getnewaddress "" bech32`);
    const destInfo = JSON.parse(cli(`getaddressinfo ${destAddr}`));
    const destSpk = String(destInfo.scriptPubKey).toLowerCase();
    expect(destSpk).toMatch(/^[0-9a-f]+$/);
    const paymentSats = valueSats - FEE_SATS;

    // ── 5. Chain genesis hash over SSH → internal byte order ────────────
    const genesisDisplay = cli(`getblockhash 0`);
    const genesisInternal = reverseHex(genesisDisplay.toLowerCase());

    // ── 6. Sighash over the hand-built tx, signed with the trader key ───
    const controlBlockHex = scriptPathControlBlock(NUMS_INTERNAL_KEY, leaves, 0);
    const sighashParams = {
      genesisBlockHash: genesisInternal,
      version: 2 as const,
      lockTime: 0,
      inputs: [{
        txid: reverseHex(fundTxid), // display → INTERNAL byte order
        vout: fundVout,
        sequence: 0xffffffff,
        outpointFlag: 0,
        asset: serializeExplicitAsset(assetWireHex),
        value: serializeExplicitValue(BigInt(valueSats)),
        scriptPubKey: expectedSpk,
      }],
      outputs: [
        { // payment — explicit asset + value, null nonce
          asset: serializeExplicitAsset(assetWireHex),
          value: serializeExplicitValue(BigInt(paymentSats)),
          nonce: '00',
          scriptPubKey: destSpk,
        },
        { // Elements fee output — EXPLICIT policy asset, empty script, LAST
          asset: serializeExplicitAsset(assetWireHex), // fee output carries the policy asset explicitly
          value: serializeExplicitValue(BigInt(FEE_SATS)),
          nonce: '00',
          scriptPubKey: '',
        },
      ],
      outputWitnesses: [{}, {}], // unblinded tx → two empty CTxOutWitness entries
      inputIndex: 0,
      tapleafHash: tapleafHash(coopLeaf),
      hashType: SIGHASH_DEFAULT,
    };
    const sighash = taprootSighashElements(sighashParams);
    const signature = schnorr.sign(Buffer.from(sighash, 'hex'), trader.priv);
    const sigHex = Buffer.from(signature).toString('hex');
    // Local self-check before touching consensus:
    expect(schnorr.verify(
      signature,
      Buffer.from(sighash, 'hex'),
      secp256k1.getPublicKey(trader.priv, true).slice(1),
    )).toBe(true);

    // Witness assembly via the library (recomputes sighash + checks the
    // leaf/control-block commit to the expected output key and its parity):
    const finalized = finalizeTaproot({
      genesisBlockHash: genesisInternal,
      version: 2,
      lockTime: 0,
      inputs: sighashParams.inputs,
      outputs: sighashParams.outputs,
      outputWitnesses: sighashParams.outputWitnesses,
      inputIndex: 0,
      leafScript: coopLeaf,
      controlBlock: controlBlockHex,
      signature: sigHex,
      expectedOutputKey: outputKeyHex,
    });
    expect(finalized.sighash).toBe(sighash);
    expect(finalized.witness).toEqual([sigHex, coopLeaf, controlBlockHex]);
    console.log(`\n── Script-path spend ──`);
    console.log(`  Sighash:       ${sighash}`);
    console.log(`  Control block: ${controlBlockHex.length / 2} bytes`);

    // ── 7. Hand-serialize the elements spend transaction ────────────────
    // Layout (g_con_elementsmode): version ‖ flags(01) ‖ vin ‖ vout ‖
    // nLockTime ‖ vtxinwit ‖ vtxoutwit — witnesses ALL at the end.
    const rawTx = concatHex(
      u32leHex(2),                       // version
      '01',                              // flags: witness present
      // vin (single input)
      '01',
      reverseHex(fundTxid),              // prevout txid, internal order
      u32leHex(fundVout),                // prevout n
      '00',                              // empty scriptSig
      u32leHex(0xffffffff),              // sequence: final
      // vout: payment + fee (fee LAST, per Elements createrawtransaction)
      '02',
      serializeExplicitAsset(assetWireHex),
      serializeExplicitValue(BigInt(paymentSats)),
      '00',                              // null nonce
      serVecHex(destSpk),
      serializeExplicitAsset(assetWireHex),   // fee output carries the policy asset explicitly
      serializeExplicitValue(BigInt(FEE_SATS)),
      '00',                              // null nonce
      '00',                              // empty scriptPubKey
      u32leHex(0),                       // nLockTime
      // vtxinwit[0]: issuance rangeproofs, script stack, pegin stack
      '00',                              // issuanceAmountRangeproof (empty)
      '00',                              // inflationKeysRangeproof (empty)
      '03',                              // scriptWitness.stack size
      serVecHex(sigHex),                 //   [sig,
      serVecHex(coopLeaf),               //    leafScript,
      serVecHex(controlBlockHex),        //    controlBlock]
      '00',                              // pegin witness (empty)
      // vtxoutwit: surjectionproof + rangeproof per output (both empty)
      '00', '00',
      '00', '00',
    );

    // Structural self-check: the node must decode it back to the same tx.
    const decoded = JSON.parse(cli(`decoderawtransaction ${rawTx}`));
    expect(decoded.vin[0].txid).toBe(fundTxid);
    expect(decoded.vin[0].vout).toBe(fundVout);
    expect(decoded.vout.length).toBe(2);
    expect(decoded.vin[0]['txinwitness']).toEqual([sigHex, coopLeaf, controlBlockHex]);

    // ── 8. Broadcast — consensus verdict; surface FULL errors ───────────
    let spendTxid: string;
    try {
      spendTxid = cli(`sendrawtransaction ${rawTx}`);
    } catch (err) {
      // Do NOT weaken the assertion on failure: bubble up the complete node
      // error (parity / sighash / witness problems are consensus rejects).
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`elements REJECTED the hand-built script-path spend:\n${detail}`);
    }
    console.log(`  Spend txid:    ${spendTxid}`);
    expect(spendTxid).toMatch(/^[0-9a-f]{64}$/);

    // ── 9. Confirm ──────────────────────────────────────────────────────
    cli(`generatetoaddress 1 ${minerAddr}`);
    await sleep(3000);

    // ── 10. Verify: CONFIRMED and consumed OUR UTXO via the witness ─────
    const confirmed = JSON.parse(cli(`getrawtransaction ${spendTxid} true`));
    expect(confirmed.confirmations).toBeGreaterThanOrEqual(1);
    expect(confirmed.blockhash).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmed.vin[0].txid).toBe(fundTxid);
    expect(confirmed.vin[0].vout).toBe(fundVout);
    expect(confirmed.vin[0]['txinwitness']).toEqual([sigHex, coopLeaf, controlBlockHex]);
    const status = await esploraGet<{ confirmed: boolean; block_height: number }>(`/tx/${spendTxid}/status`);
    expect(status.confirmed).toBe(true);

    console.log(`\n✅ WS-A SPENT-AND-VERIFIED — REAL script-path spend on elementsregtest`);
    console.log(`   Merkle root:   ${merkleRoot}`);
    console.log(`   Output key:    ${outputKeyHex}`);
    console.log(`   Sighash:       ${sighash}`);
    console.log(`   Spend tx:      ${spendTxid}`);
    console.log(`   Block:         ${status.block_height}`);
    console.log(`   Tree math, tweak/program, control-block parity,`);
    console.log(`   taprootSighashElements, witness composition: CONSENSUS-VALID.`);
    console.log(`   WS-A §8.6:     CONFIRMED`);
  }, 120_000);
});
