// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeRequiredBond, createBaoMempoolVerifier, verifyBond, type BondVerifier } from '../bondVerification';

describe('bondVerification', () => {
  it('computes required bond with default 1% rate and 1M sats minimum', () => {
    expect(computeRequiredBond(100_000_000)).toBe(1_000_000);
    expect(computeRequiredBond(500_000_000)).toBe(5_000_000);
    expect(computeRequiredBond(50_000_000)).toBe(1_000_000);
  });

  it('computes required bond with custom rate and minimum', () => {
    expect(computeRequiredBond(100_000_000, 0.05, 2_000_000)).toBe(5_000_000);
    expect(computeRequiredBond(10_000_000, 0.05, 2_000_000)).toBe(2_000_000);
  });

  it('verifies a valid bond UTXO', async () => {
    const verifier: BondVerifier = {
      async getUtxo(txid, vout) {
        return {
          txid,
          vout,
          amountSats: 1_000_000,
          scriptPubKey: 'script',
          confirmations: 6,
          status: 'confirmed',
        };
      },
    };

    const result = await verifyBond({
      commitment: {
        amountSats: 1_000_000,
        bondAddress: 'bc1q',
        bondTxid: 'txid',
        bondVout: 0,
        status: 'confirmed',
      },
      expectedScriptPubKey: 'script',
      minAmountSats: 1_000_000,
      minConfirmations: 6,
      verifier,
    });

    expect(result.valid).toBe(true);
    expect(result.utxo?.amountSats).toBe(1_000_000);
  });

  it('rejects a missing UTXO', async () => {
    const verifier: BondVerifier = {
      async getUtxo() {
        return null;
      },
    };

    const result = await verifyBond({
      commitment: {
        amountSats: 1_000_000,
        bondAddress: 'bc1q',
        bondTxid: 'txid',
        bondVout: 0,
        status: 'confirmed',
      },
      verifier,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Bond UTXO not found');
  });

  it('rejects insufficient confirmations and amount', async () => {
    const verifier: BondVerifier = {
      async getUtxo() {
        return {
          txid: 'txid',
          vout: 0,
          amountSats: 500_000,
          scriptPubKey: 'script',
          confirmations: 1,
          status: 'confirmed',
        };
      },
    };

    const result = await verifyBond({
      commitment: {
        amountSats: 1_000_000,
        bondAddress: 'bc1q',
        bondTxid: 'txid',
        bondVout: 0,
        status: 'confirmed',
      },
      minAmountSats: 1_000_000,
      minConfirmations: 6,
      verifier,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('confirmations');
  });
});


describe('createBaoMempoolVerifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Esplora-compatible backends return `value` in satoshis and the tx status
  // carries `block_height`, not a confirmation count.
  const txJson = {
    status: { confirmed: true, block_height: 100 },
    vout: [{ value: 1_000_000, scriptpubkey: 'aabbcc' }],
  };

  it('returns UTXO info from a BAO Markets Mempool backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ spent: false }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => txJson })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => 105 }),
    );

    const verifier = createBaoMempoolVerifier('https://example.com/api');
    const utxo = await verifier.getUtxo('txid', 0);

    expect(utxo).not.toBeNull();
    expect(utxo?.amountSats).toBe(1_000_000);
    expect(utxo?.scriptPubKey).toBe('aabbcc');
    expect(utxo?.status).toBe('confirmed');
    // tip 105 - block 100 + 1 = 6 confirmations.
    expect(utxo?.confirmations).toBe(6);
  });

  it('falls back to 1 confirmation when the tip height is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ spent: false }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => txJson })
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }),
    );

    const verifier = createBaoMempoolVerifier('https://example.com/api');
    const utxo = await verifier.getUtxo('txid', 0);

    expect(utxo).not.toBeNull();
    expect(utxo?.confirmations).toBe(1);
  });

  it('returns null when the output is already spent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ spent: true }) }),
    );

    const verifier = createBaoMempoolVerifier('https://example.com/api');
    const utxo = await verifier.getUtxo('txid', 0);

    expect(utxo).toBeNull();
  });

  it('falls back to the /outspends array when /outspend/:vout 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ spent: false }] })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => txJson })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => 105 }),
    );

    const verifier = createBaoMempoolVerifier('https://mempool.example.com/api');
    const utxo = await verifier.getUtxo('txid', 0);

    expect(utxo).not.toBeNull();
    expect(utxo?.amountSats).toBe(1_000_000);
    expect(utxo?.confirmations).toBe(6);
  });
});
