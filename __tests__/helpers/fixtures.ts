// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Committed fixtures for the Court test suite.
 *
 * 1. `loadModelCheckSummary()` — the model-check fixture reader. The full
 *    exhaustive sweep (scripts/model-check.mjs) commits its per-instance
 *    state-space summary to `__fixtures__/model-check-summary.json`; the
 *    vitest side asserts that fixture (presence, all-green, cross-checks).
 *    Read it through this helper — never re-inline `readFileSync` plumbing.
 *
 * 2. `buildV2AttestationEvent` + `V2Fields` — the kind-89 V2 attestation
 *    event builder shared by the validator suites. Signs the canonical V2
 *    message with the given signer and finalizes the Nostr event with a
 *    publisher key, tagging `nonce`/`sig`/`epoch`/`tier`/`threshold`/
 *    `signers` (+ optional `dispute`/`verdict`/`attempt`/`batch`) exactly as
 *    the production validator expects.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';

import { buildAttestationMessageV2 } from '../../crypto';
import type { SelectedJuror } from '../../types';

// ---------------------------------------------------------------------------
// Juror fixture
// ---------------------------------------------------------------------------

/**
 * A deterministic `SelectedJuror` fixture: pubkey derived from `idx`
 * (`'0'.repeat(63) + idx`), 10k-sat confirmed bond, priority = idx. Pass
 * `pubkey` to override the derived Nostr key (disqualification/refresh
 * scenarios). NOT a random-key fixture — see `keys.ts` for those.
 */
export function juror(idx: number, pubkey?: string): SelectedJuror {
  return {
    idx,
    nostrPubkey: pubkey ?? '0'.repeat(63) + String(idx),
    stakeCapacitySats: 10_000,
    stakeCommitment: {
      amountSats: 10_000,
      bondAddress: 'bc1q...',
      status: 'confirmed',
      committedAt: 1_700_000_000,
    },
    wotScore: 80,
    categories: ['world'],
    registeredAt: 1_700_000_000,
    priority: idx,
  };
}

/**
 * `count` jurors with REAL CSPRNG Nostr keypairs (nostr-tools), each paired
 * with its `seckey` for session construction — the independent-DKG/signing
 * fixture. Keys are unique per call (that's the point); for deterministic
 * keys use `juror(idx)` instead.
 */
export function jurorWithKeys(count: number): { juror: SelectedJuror; seckey: Uint8Array; pubkey: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const seckey = generateSecretKey();
    const pubkey = getPublicKey(seckey);
    return {
      juror: {
        idx: i + 1,
        nostrPubkey: pubkey,
        stakeCapacitySats: 10_000,
        stakeCommitment: {
          amountSats: 10_000,
          bondAddress: 'bc1q',
          status: 'confirmed',
          committedAt: 1,
        },
        wotScore: 80,
        categories: ['world'],
        registeredAt: 1,
        priority: i + 1,
      } as SelectedJuror,
      seckey,
      pubkey,
    };
  });
}

// ---------------------------------------------------------------------------
// Model-check fixture
// ---------------------------------------------------------------------------

export interface ModelCheckSummaryInstance {
  readonly name: string;
  readonly states: number;
  readonly abstractStates: number;
  readonly progressEdges: number;
  readonly selfLoops: number;
  readonly applications: number;
  readonly typedThrows: number;
  readonly rawThrows: number;
  readonly illegalChecks: number;
  readonly terminalStates: number;
  readonly parkingStates: number;
  readonly tallyReachableStates: number;
  readonly determinismPathsReplayed: number;
  readonly wallMs: number;
}

export interface ModelCheckSummary {
  readonly mode: 'full' | 'fast';
  readonly totalWallMs: number;
  readonly propertiesChecked: readonly string[];
  readonly totals: {
    readonly rawThrows: number;
    readonly instances: number;
    readonly states: number;
  };
  readonly instances: readonly ModelCheckSummaryInstance[];
}

/** Read the committed model-check summary (`__fixtures__/model-check-summary.json`). */
export function loadModelCheckSummary(): ModelCheckSummary {
  const fixturePath = fileURLToPath(
    new URL('../../__fixtures__/model-check-summary.json', import.meta.url),
  );
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as ModelCheckSummary;
}

// ---------------------------------------------------------------------------
// V2 attestation event builder (shared validator fixture)
// ---------------------------------------------------------------------------

export interface V2Fields {
  marketId: string;
  outcome: string;
  round: string;
  disputeEventId?: string;
  verdictHash?: string;
  epochId: number;
  tier: number;
  threshold: number;
  signerSetRoot: string;
  attempt?: number;
  batchMerkleRoot?: string;
}

/** Build + sign + finalize a kind-89 V2 attestation event from `fields`. */
export function buildV2AttestationEvent(
  fields: V2Fields,
  signer: { sec: Uint8Array; pub: string },
  publisherSecret: Uint8Array = generateSecretKey(),
): NostrEvent {
  const message = buildAttestationMessageV2({
    marketId: fields.marketId,
    outcome: fields.outcome,
    round: Number(fields.round),
    disputeEventId: fields.disputeEventId,
    verdictHash: fields.verdictHash,
    epochId: fields.epochId,
    tier: fields.tier,
    threshold: fields.threshold,
    signerSetRoot: fields.signerSetRoot,
    attempt: fields.attempt,
    batchMerkleRoot: fields.batchMerkleRoot,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signer.sec));
  const tags: string[][] = [
    ['m', fields.marketId],
    ['p', signer.pub],
    ['outcome', fields.outcome],
    ['round', fields.round],
    ['nonce', signature.slice(0, 64)],
    ['sig', signature],
    ['epoch', String(fields.epochId)],
    ['tier', String(fields.tier)],
    ['threshold', String(fields.threshold)],
    ['signers', fields.signerSetRoot],
  ];
  if (fields.disputeEventId) tags.push(['dispute', fields.disputeEventId]);
  if (fields.verdictHash) tags.push(['verdict', fields.verdictHash]);
  if (fields.attempt !== undefined) tags.push(['attempt', String(fields.attempt)]);
  if (fields.batchMerkleRoot) tags.push(['batch', fields.batchMerkleRoot]);
  return finalizeEvent({
    kind: 89,
    created_at: 1,
    tags,
    content: JSON.stringify({
      marketId: fields.marketId,
      outcome: fields.outcome,
      round: fields.round,
      message,
      disputeEventId: fields.disputeEventId,
      verdictHash: fields.verdictHash,
      epoch: String(fields.epochId),
      tier: String(fields.tier),
      threshold: String(fields.threshold),
      signerSetRoot: fields.signerSetRoot,
      attempt: fields.attempt !== undefined ? String(fields.attempt) : undefined,
      batchMerkleRoot: fields.batchMerkleRoot,
    }),
  }, publisherSecret);
}
