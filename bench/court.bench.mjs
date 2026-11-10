#!/usr/bin/env tsx
// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
//
// BAO Court benchmark harness (symposium performance track).
//
// Measures the Court's CPU-bound core paths with a deterministic, offline,
// fixed-clock methodology:
//
//   1. Canonical hashing   — CanonicalWriter encode+hash at 10/100/1k field
//                            groups; hashCourtVoteCommit / hashCourtVerdict /
//                            hashDisputeVerdict; buildAttestationMessageV2
//                            with 0 and 6 extensions.
//   2. Merkle batching     — buildBatchMerkleTree + authentication proofs +
//                            verifyCaseInBatch at n = 10/100/1k/10k leaves.
//   3. Validator           — validateAttestationEvent (v1, kind-39007) and
//                            validateAttestationEventV2 on realistic,
//                            correctly-signed fixtures (real Schnorr keys,
//                            generated once at bench start).
//   4. State machines      — 10k legal transitions each of the vote and
//                            confirmation machines (pre-generated sequences).
//   5. Jury selection      — selectJury over rosters of 50/201/1k/10k.
//
// Methodology: every benchmark runs warmup iterations, then >= 5 timed
// samples on process.hrtime.bigint() (no Date.now anywhere), and reports
// median, p95 (nearest-rank over samples), and ops/sec. Machine-readable
// output for CI regression budgets: `npx tsx bench/court.bench.mjs --json out.json`.
//
// Determinism: no network, no wall-clock inputs to measured code paths, all
// fixtures derived from SHA-256 counters and fixed keys. Reruns vary only by
// machine noise.

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import { CanonicalWriter, hashCourtSessionParameters } from '../courtSession.ts';
import { hashCourtVoteCommit, hashCourtVerdict, hashDisputeVerdict, createCourtVoteMachine, reduceCourtVoteMachine } from '../courtVoteMachine.ts';
import { createCourtConfirmationMachine, hashCourtConfirmation, reduceCourtConfirmationMachine } from '../courtConfirmationMachine.ts';
import {
  buildBatchMerkleTree,
  buildBatchMerkleProof,
  verifyCaseInBatch,
  buildBatchAttestationEvent,
  hashBatchManifest,
} from '../batchAttestation.ts';
import { buildAttestationMessage, buildAttestationMessageV2 } from '../crypto.ts';
import { hashSignerSetRoot, validateAttestationEvent, validateAttestationEventV2 } from '../validator.ts';
import { BAO_COURT_ATTESTATION_KIND } from '../events.ts';
import { selectJury } from '../selection.ts';

// ─── harness ────────────────────────────────────────────────────────────────

const NS_PER_MS = 1e6;
const SAMPLES = 9; // >= 5 timed samples per the methodology contract
const WARMUP_SAMPLES = 3;

/** Nearest-rank p95 over an array of sample values. */
function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.ceil(0.95 * sorted.length)) - 1];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Run one benchmark. `fn()` executes the measured workload once; `iters` is
 * how many workload executions compose one timed sample (tuned per bench so
 * a sample lasts long enough to be meaningful), and `opsPerRun` is how many
 * logical operations one fn() execution contains (for batched workloads).
 * Returns a result record.
 */
function bench(name, params, fn, { iters = 1, opsPerRun = 1, memory = false } = {}) {
  // Warmup: let JIT/GC state settle; not recorded.
  for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
    for (let k = 0; k < iters; k += 1) fn();
  }

  const samples = [];
  let memBefore = 0;
  let memAfter = 0;
  if (memory) memBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < SAMPLES; i += 1) {
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < iters; k += 1) fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / NS_PER_MS / (iters * opsPerRun));
  }
  if (memory) memAfter = process.memoryUsage().heapUsed;

  const medianMs = median(samples);
  const record = {
    name,
    params,
    itersPerSample: iters,
    opsPerRun,
    samplesMsPerOp: samples.map((s) => round(s, 9)),
    medianMsPerOp: round(medianMs, 9),
    p95MsPerOp: round(p95(samples), 9),
    // Noise-floor estimator: the fastest observed sample. Under transient
    // machine load the median inflates but the minimum stays near the true
    // cost — CI budgets (Track B) should budget against min, alert on median.
    minMsPerOp: round(Math.min(...samples), 9),
    medianUsPerOp: round(medianMs * 1000, 3),
    p95UsPerOp: round(p95(samples) * 1000, 3),
    minUsPerOp: round(Math.min(...samples) * 1000, 3),
    opsPerSec: medianMs > 0 ? Math.round(1000 / medianMs) : null,
  };
  if (memory) {
    record.heapRetainedDeltaBytes = Math.max(0, memAfter - memBefore);
  }
  const perOpLabel = medianMs < 0.5 ? `${round(medianMs * 1000, 3)} us` : `${round(medianMs, 4)} ms`;
  const p95Label = medianMs < 0.5 ? `${round(p95(samples) * 1000, 3)} us` : `${round(p95(samples), 4)} ms`;
  console.log(`${name.padEnd(36)} ${String(params).padEnd(60)} median ${perOpLabel.padStart(12)}  p95 ${p95Label.padStart(12)}  ops/sec ${record.opsPerSec ?? '—'}${memory ? `  heapΔ ${(record.heapRetainedDeltaBytes / 1e6).toFixed(1)}MB` : ''}`);
  return record;
}

function round(value, digits = 6) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// ─── deterministic fixture helpers ──────────────────────────────────────────

/** Deterministic 32-byte lowercase hex id from a label. */
function hexId(label) {
  return bytesToHex(sha256(new TextEncoder().encode(label)));
}

/** Real 33-byte compressed secp256k1 pubkey (hex), deterministically derived. */
function compressedPubkeyHex(label) {
  const sec = sha256(new TextEncoder().encode(`bench-key/${label}`));
  return bytesToHex(secp256k1.getPublicKey(sec, true));
}

function keypair(seedLabel) {
  const sec = sha256(new TextEncoder().encode(`bench-key/${seedLabel}`));
  return { sec, pub: bytesToHex(schnorr.getPublicKey(sec)) };
}

const OUTCOMES = ['NO', 'YES'];

// ─── 1. canonical hashing ───────────────────────────────────────────────────

const results = [];
console.log('\n== canonical hashing ==\n');

function canonicalEncodeHash(fieldGroups, hexFields, textFields) {
  const writer = new CanonicalWriter();
  for (let i = 0; i < fieldGroups; i += 1) {
    writer.u8(i & 0xff);
    writer.u32(i);
    writer.hex(hexFields[i]);
    writer.text(textFields[i]);
    writer.u64(i * 1000);
  }
  return bytesToHex(sha256(writer.finish()));
}

// Fixture strings precomputed outside the timed region — the bench measures
// the writer + hash, not fixture generation.
const CANONICAL_HEX = Array.from({ length: 1000 }, (_, i) => hexId(`f-${i}`));
const CANONICAL_TEXT = Array.from({ length: 1000 }, (_, i) => `field-value-${i}`);

for (const groups of [10, 100, 1000]) {
  results.push(bench(
    'canonicalWriter.encodeHash',
    `fieldGroups=${groups}`,
    () => canonicalEncodeHash(groups, CANONICAL_HEX, CANONICAL_TEXT),
    { iters: 100_000 / groups },
  ));
}

// Session-parameter hash: the Court's own end-to-end CanonicalWriter consumer
// (assertion + encoding + domain-prefixed SHA-256 over a 5-juror session).
const sessionParams = {
  version: 1,
  environment: 'signet',
  cryptoSuite: 'chilldkg-0.3+bip445-draft',
  disputeEventId: hexId('dispute-event'),
  disputeId: 'bench-dispute-0001',
  marketId: 'bench-market-0001',
  marketEventId: hexId('market-event'),
  selectionEventId: hexId('selection-event'),
  blockHash: hexId('block-hash'),
  blockHeight: 900_000,
  participants: Array.from({ length: 5 }, (_, i) => ({
    idx: i + 1,
    nostrPubkey: hexId(`juror-nostr-${i}`),
    hostPubkey: compressedPubkeyHex(`juror-host-${i}`),
    bondRef: `bond:${i}`,
    role: i === 0 ? 'juror-coordinator' : 'juror',
  })),
  threshold: 3,
  allowedOutcomes: OUTCOMES,
  attempt: 1,
  createdAt: 1_700_000_000,
  deadline: 1_700_100_000,
};
results.push(bench('hashCourtSessionParameters', 'participants=5', () => hashCourtSessionParameters(sessionParams), { iters: 20_000 }));

const SESSION = hexId('bench-session');
const SUPPORT_IDS = Array.from({ length: 6 }, (_, i) => hexId(`support-${i}`));

results.push(bench('hashCourtVoteCommit', 'session+outcome+salt', () => hashCourtVoteCommit({ sessionHash: SESSION, outcome: 'YES', salt: hexId('salt') }), { iters: 100_000 }));
results.push(bench('hashCourtVerdict', 'supporting=6', () => hashCourtVerdict({ sessionHash: SESSION, outcome: 'YES', supportingEventIds: SUPPORT_IDS }), { iters: 50_000 }));
results.push(bench('hashDisputeVerdict', 'supporting=6', () => hashDisputeVerdict({ disputeId: SESSION, outcome: 'YES', supportingEventIds: SUPPORT_IDS }), { iters: 50_000 }));

results.push(bench(
  'buildAttestationMessageV2',
  'extensions=0',
  () => buildAttestationMessageV2({ marketId: 'bench-market', outcome: 'YES', round: 1 }),
  { iters: 100_000 },
));
const v2Full = {
  marketId: 'bench-market',
  outcome: 'YES',
  round: 1,
  disputeEventId: hexId('dispute-event'),
  verdictHash: hexId('verdict'),
  epochId: 14,
  tier: 2,
  threshold: 3,
  signerSetRoot: hexId('signer-set'),
  attempt: 1,
  batchMerkleRoot: hexId('batch-root'),
};
results.push(bench('buildAttestationMessageV2', 'extensions=6', () => buildAttestationMessageV2(v2Full), { iters: 100_000 }));

// ─── 2. merkle batching ─────────────────────────────────────────────────────

console.log('\n== merkle batching ==\n');

/**
 * Build a deterministic batch of n verdict hashes plus the case inputs that
 * recompute each one, pre-sorted bytewise so proof index i maps to
 * caseInputs[i] (buildBatchMerkleTree sorts leaves internally; feeding a
 * sorted array keeps the mapping identity).
 */
function makeBatch(n) {
  const cases = Array.from({ length: n }, (_, i) => ({
    sessionHash: hexId(`batch-session-${i}`),
    outcome: 'YES',
    supportingEventIds: [hexId(`batch-support-${i}`)],
  }));
  const casesWithHash = cases.map((c) => ({ ...c, verdictHash: hashCourtVerdict(c) }));
  casesWithHash.sort((a, b) => (a.verdictHash < b.verdictHash ? -1 : a.verdictHash > b.verdictHash ? 1 : 0));
  return { cases: casesWithHash, verdictHashes: casesWithHash.map((c) => c.verdictHash) };
}

function buildBatchEvent(n, root, cohort) {
  const manifest = hashBatchManifest({
    epoch: 1,
    cohortPubkey: cohort.pub,
    batchIndex: 0,
    count: n,
    root,
    finalizedAtSec: 100,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(manifest), cohort.sec));
  return buildBatchAttestationEvent({
    epoch: 1,
    cohortPubkey: cohort.pub,
    batchIndex: 0,
    count: n,
    root,
    finalizedAtSec: 100,
    signature,
    createdAt: 100,
  });
}

/** Number of proofs measured per sample at each n (full set is O(n^2)). */
const PROOF_SAMPLE = { 10: 10, 100: 100, 1000: 200, 10000: 32 };
/** Case verifications per sample. */
const VERIFY_SAMPLE = { 10: 10, 100: 100, 1000: 100, 10000: 100 };

for (const n of [10, 100, 1000, 10_000]) {
  const cohort = keypair(`cohort-${n}`);
  const { cases, verdictHashes } = makeBatch(n);
  const isCap = n === 10_000;
  // The max-cap case records memory across the WHOLE pipeline (tree + proofs
  // + verification fixtures) via process.memoryUsage deltas.
  const memAtBlockStart = isCap ? process.memoryUsage().heapUsed : 0;
  const { root, leaves } = buildBatchMerkleTree(verdictHashes);
  const event = buildBatchEvent(n, root, cohort);
  const ctx = { expectedGroupPubkey: cohort.pub };

  results.push(bench(
    'buildBatchMerkleTree',
    `leaves=${n}`,
    () => buildBatchMerkleTree(verdictHashes),
    { iters: n <= 100 ? 200 : n <= 1000 ? 3 : 1, memory: n === 10_000 },
  ));

  const proofCount = Math.min(PROOF_SAMPLE[n], n);
  const proofIndices = Array.from({ length: proofCount }, (_, i) => Math.floor((i * n) / proofCount));
  results.push(bench(
    'buildBatchMerkleProof',
    `leaves=${n} proofsPerSample=${proofCount}${proofCount < n ? ' (sampled; full set is O(n^2))' : ' (full set)'}`,
    () => proofIndices.map((i) => buildBatchMerkleProof(leaves, i)),
    { iters: n <= 100 ? 20 : 1, opsPerRun: proofCount },
  ));

  const proofs = proofIndices.map((i) => buildBatchMerkleProof(leaves, i));
  const verifyIndices = Array.from({ length: VERIFY_SAMPLE[n] }, (_, i) => proofIndices[i % proofCount]);
  const verifyProofs = verifyIndices.map((i) => buildBatchMerkleProof(leaves, i));
  const verifyCases = verifyIndices.map((i) => cases[i]);
  let verified = 0;
  results.push(bench(
    'verifyCaseInBatch',
    `leaves=${n} verificationsPerSample=${VERIFY_SAMPLE[n]}`,
    () => {
      verified = 0;
      for (let i = 0; i < verifyIndices.length; i += 1) {
        const res = verifyCaseInBatch(event, { ...verifyCases[i], proof: verifyProofs[i] }, ctx);
        if (res.valid) verified += 1;
      }
      return verified;
    },
    { iters: 1, opsPerRun: VERIFY_SAMPLE[n] },
  ));
  if (verified !== verifyIndices.length) {
    throw new Error(`bench fixture broken: verifyCaseInBatch valid ${verified}/${verifyIndices.length} at n=${n}`);
  }

  if (isCap) {
    const heapDelta = Math.max(0, process.memoryUsage().heapUsed - memAtBlockStart);
    results.push({
      name: 'merkleBatchPipeline',
      params: `leaves=${n} (full pipeline: tree + sampled proofs + verifications)`,
      itersPerSample: 1,
      opsPerRun: 1,
      samplesMsPerOp: [],
      medianMsPerOp: null,
      p95MsPerOp: null,
      minMsPerOp: null,
      medianUsPerOp: null,
      p95UsPerOp: null,
      minUsPerOp: null,
      opsPerSec: null,
      heapRetainedDeltaBytes: heapDelta,
    });
    console.log(`merkleBatchPipeline leaves=${n} heapΔ ${(heapDelta / 1e6).toFixed(1)}MB (retained by tree + proofs + cases)`);
  }
}

// ─── 3. validator ───────────────────────────────────────────────────────────

console.log('\n== validator ==\n');

const signer = keypair('attestation-signer');
const publisherSecret = generateSecretKey(); // real schnorr key, generated once
const DISPUTE_ID = hexId('bench-dispute');
const VERDICT_HASH = hashDisputeVerdict({ disputeId: DISPUTE_ID, outcome: 'YES', supportingEventIds: SUPPORT_IDS });

/** Hand-built, correctly-signed kind-39007 v1 attestation (validator fixture). */
function buildV1Event() {
  const message = buildAttestationMessage('bench-market', 'YES', 1, DISPUTE_ID, VERDICT_HASH);
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signer.sec));
  return finalizeEvent({
    kind: BAO_COURT_ATTESTATION_KIND,
    created_at: 1,
    tags: [
      ['e', hexId('market-event'), '', 'root'],
      ['m', 'bench-market'],
      ['p', signer.pub],
      ['outcome', 'YES'],
      ['round', '1'],
      ['nonce', signature.slice(0, 64)],
      ['sig', signature],
      ['ver', 'FROST-BIP340-v1'],
      ['dispute', DISPUTE_ID],
      ['verdict', VERDICT_HASH],
      ...SUPPORT_IDS.map((id) => ['e', id, '', 'mention']),
    ],
    content: JSON.stringify({
      marketId: 'bench-market',
      outcome: 'YES',
      round: '1',
      message,
      disputeEventId: DISPUTE_ID,
      verdictHash: VERDICT_HASH,
    }),
  }, publisherSecret);
}

const signerSetRoot = hashSignerSetRoot([1, 2, 3]);
/** Hand-built, correctly-signed v2 attestation with all 6 extension fields. */
function buildV2Event() {
  const fields = {
    marketId: 'bench-market',
    outcome: 'YES',
    round: 1,
    disputeEventId: DISPUTE_ID,
    verdictHash: VERDICT_HASH,
    epochId: 14,
    tier: 2,
    threshold: 3,
    signerSetRoot,
    attempt: 1,
    batchMerkleRoot: hexId('batch-root'),
  };
  const message = buildAttestationMessageV2(fields);
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signer.sec));
  return finalizeEvent({
    kind: 89,
    created_at: 1,
    tags: [
      ['e', hexId('market-event'), '', 'root'],
      ['m', 'bench-market'],
      ['p', signer.pub],
      ['outcome', 'YES'],
      ['round', '1'],
      ['nonce', signature.slice(0, 64)],
      ['sig', signature],
      ['epoch', '14'],
      ['tier', '2'],
      ['threshold', '3'],
      ['signers', signerSetRoot],
      ['dispute', DISPUTE_ID],
      ['verdict', VERDICT_HASH],
      ['attempt', '1'],
      ['batch', hexId('batch-root')],
      ...SUPPORT_IDS.map((id) => ['e', id, '', 'mention']),
    ],
    content: JSON.stringify({
      marketId: 'bench-market',
      outcome: 'YES',
      round: '1',
      message,
      disputeEventId: DISPUTE_ID,
      verdictHash: VERDICT_HASH,
      epoch: '14',
      tier: '2',
      threshold: '3',
      signerSetRoot,
      attempt: '1',
      batchMerkleRoot: hexId('batch-root'),
    }),
  }, publisherSecret);
}

const v1Event = buildV1Event();
const v2Event = buildV2Event();
{
  const check = validateAttestationEvent(v1Event, { expectedGroupPubkey: signer.pub });
  const check2 = validateAttestationEventV2(v2Event, { expectedGroupPubkey: signer.pub, expectedEpoch: 14 });
  if (!check.valid) throw new Error(`v1 bench fixture invalid: ${check.error}`);
  if (!check2.valid) throw new Error(`v2 bench fixture invalid: ${check2.error}`);
}

results.push(bench('validateAttestationEvent', 'kind-39007 supporting=6', () => validateAttestationEvent(v1Event), { iters: 200 }));
results.push(bench('validateAttestationEventV2', 'kind-89 ext=6 supporting=6', () => validateAttestationEventV2(v2Event, { expectedEpoch: 14 }), { iters: 200 }));

// ─── 4. state machines ──────────────────────────────────────────────────────

console.log('\n== state machines ==\n');

/**
 * Pre-generate a legal event sequence for the vote machine: full commit/reveal
 * lifecycles over a 21-juror roster until `total` events exist. Every event is
 * legal in sequence (commit -> close -> open -> reveal -> close -> finalize).
 */
function generateVoteSequence(total) {
  const roster = 21;
  const events = [];
  let lifecycle = 0;
  while (events.length < total) {
    const sessionHash = hexId(`vote-session-${lifecycle}`);
    const commits = [];
    const reveals = [];
    for (let idx = 1; idx <= roster; idx += 1) {
      const outcome = idx % 2 === 0 ? 'YES' : 'NO';
      const salt = hexId(`salt-${lifecycle}-${idx}`);
      commits.push({
        type: 'accept_commit',
        idx,
        commitHash: hashCourtVoteCommit({ sessionHash, outcome, salt }),
        eventId: hexId(`commit-${lifecycle}-${idx}`),
        now: 100 + idx,
      });
      reveals.push({
        type: 'accept_reveal',
        idx,
        outcome,
        salt,
        eventId: hexId(`reveal-${lifecycle}-${idx}`),
        now: 300 + idx,
      });
    }
    const control = [
      { type: 'close_commits', now: 200 },
      { type: 'open_reveals', now: 201 },
    ];
    const tail = [
      { type: 'close_reveals', now: 400 },
      { type: 'finalize_tally', now: 401 },
    ];
    events.push(...commits, ...control, ...reveals, ...tail);
    lifecycle += 1;
  }
  return events.slice(0, total);
}

const voteSequence = generateVoteSequence(10_000);
{
  // Legality preflight outside the timed region: exactly one full lifecycle.
  const EVENTS_PER_LIFECYCLE = 2 * 21 + 4;
  let s = createCourtVoteMachine({
    sessionHash: hexId('vote-session-0'),
    participantIndices: Array.from({ length: 21 }, (_, i) => i + 1),
    allowedOutcomes: OUTCOMES,
    commitDeadline: 200,
    revealDeadline: 400,
  });
  for (const event of voteSequence.slice(0, EVENTS_PER_LIFECYCLE)) s = reduceCourtVoteMachine(s, event);
}
results.push(bench(
  'reduceCourtVoteMachine',
  `transitions=${voteSequence.length} roster=21`,
  () => {
    let lifecycle = 0;
    let s = createCourtVoteMachine({
      sessionHash: hexId('vote-session-0'),
      participantIndices: Array.from({ length: 21 }, (_, i) => i + 1),
      allowedOutcomes: OUTCOMES,
      commitDeadline: 200,
      revealDeadline: 400,
    });
    for (const event of voteSequence) {
      s = reduceCourtVoteMachine(s, event);
      if (s.phase === 'tally_final') {
        lifecycle += 1;
        s = createCourtVoteMachine({
          sessionHash: hexId(`vote-session-${lifecycle}`),
          participantIndices: Array.from({ length: 21 }, (_, i) => i + 1),
          allowedOutcomes: OUTCOMES,
          commitDeadline: 200,
          revealDeadline: 400,
        });
      }
    }
    return lifecycle;
  },
  { iters: 1, opsPerRun: voteSequence.length },
));

/**
 * Pre-generate a legal event sequence for the confirmation machine: roster 3,
 * quorum 3, alternating no-challenge and challenged (ladder) lifecycles.
 */
function generateConfirmationSequence(total) {
  const roster = [1, 2, 3];
  const events = [];
  let lifecycle = 0;
  while (events.length < total) {
    const sessionHash = hexId(`conf-session-${lifecycle}`);
    const proposalHash = hexId(`proposal-${lifecycle}`);
    const lifecycleEvents = [];
    for (const idx of roster) {
      lifecycleEvents.push({
        type: 'accept_confirmation',
        idx,
        confirmHash: hashCourtConfirmation({ sessionHash, proposalHash, idx }),
        eventId: hexId(`confirm-${lifecycle}-${idx}`),
        now: 1000 + idx,
      });
    }
    lifecycleEvents.push({ type: 'close_confirmations', now: 2000 });
    if (lifecycle % 2 === 0) {
      // No-challenge path -> fee_settlement -> final.
      lifecycleEvents.push(
        { type: 'open_challenge_window', now: 2100 },
        { type: 'close_challenge_window', now: 3000 },
        { type: 'finalize', now: 3100 },
      );
    } else {
      // Challenged path: ladder round resolves, host concedes, fees settle.
      lifecycleEvents.push({ type: 'open_challenge_window', now: 2100 });
      lifecycleEvents.push({
        type: 'accept_challenge',
        idx: 2,
        bondTxid: hexId(`bond-${lifecycle}`),
        bondProofHash: hexId(`bondproof-${lifecycle}`),
        eventId: hexId(`challenge-${lifecycle}`),
        now: 2500,
      });
      lifecycleEvents.push({ type: 'close_challenge_window', now: 3000 });
      lifecycleEvents.push({ type: 'open_ladder_round', round: 1, voteDeadline: 4000, now: 3100 });
      for (const idx of roster) {
        lifecycleEvents.push({
          type: 'accept_mass_vote',
          idx,
          outcome: 'YES',
          eventId: hexId(`massvote-${lifecycle}-${idx}`),
          now: 3200 + idx,
        });
      }
      lifecycleEvents.push(
        { type: 'close_ladder_round', now: 4000 },
        { type: 'resolve_round', now: 4100 },
        { type: 'concede', now: 4150 },
        { type: 'finalize', now: 4200 },
      );
    }
    events.push(...lifecycleEvents);
    lifecycle += 1;
  }
  return events.slice(0, total);
}

const confirmationSequence = generateConfirmationSequence(10_000);
results.push(bench(
  'reduceCourtConfirmationMachine',
  `transitions=${confirmationSequence.length} roster=3`,
  () => {
    let lifecycle = 0;
    let s = createCourtConfirmationMachine({
      sessionHash: hexId('conf-session-0'),
      proposalHash: hexId('proposal-0'),
      proposedOutcome: 'YES',
      allowedOutcomes: OUTCOMES,
      participantIndices: [1, 2, 3],
      confirmQuorum: 3,
      confirmDeadline: 2000,
      challengeDeadline: 3000,
    });
    for (const event of confirmationSequence) {
      s = reduceCourtConfirmationMachine(s, event);
      if (s.phase === 'final') {
        lifecycle += 1;
        s = createCourtConfirmationMachine({
          sessionHash: hexId(`conf-session-${lifecycle}`),
          proposalHash: hexId(`proposal-${lifecycle}`),
          proposedOutcome: 'YES',
          allowedOutcomes: OUTCOMES,
          participantIndices: [1, 2, 3],
          confirmQuorum: 3,
          confirmDeadline: 2000,
          challengeDeadline: 3000,
        });
      }
    }
    return lifecycle;
  },
  { iters: 1, opsPerRun: confirmationSequence.length },
));

// ─── 5. jury selection ──────────────────────────────────────────────────────

console.log('\n== jury selection ==\n');

function makeRoster(n) {
  return Array.from({ length: n }, (_, i) => ({
    nostrPubkey: hexId(`roster-${i}`),
    stakeCapacitySats: 50_000 + i,
    stakeCommitment: {
      amountSats: 50_000,
      bondAddress: 'bc1qbench',
      status: 'confirmed',
      committedAt: 1_700_000_000,
    },
    wotScore: 80 + (i % 20),
    categories: ['bench'],
    registeredAt: 1_700_000_000,
  }));
}

for (const n of [50, 201, 1000, 10_000]) {
  const roster = makeRoster(n);
  const params = {
    disputeEventId: hexId('selection-dispute'),
    blockHash: hexId('selection-block'),
    marketCategory: 'bench',
    marketVolumeSats: 1_000_000,
    jurySize: 5,
    backupCount: 2,
    referenceTimeSec: 1_800_000_000,
  };
  const selected = selectJury(roster, params);
  if (selected.length !== 5) throw new Error(`selection fixture broken at n=${n}`);
  results.push(bench(
    'selectJury',
    `roster=${n} jurySize=5`,
    () => selectJury(roster, params),
    { iters: n <= 201 ? 500 : n <= 1000 ? 100 : 10 },
  ));
}

// ─── output ─────────────────────────────────────────────────────────────────

const jsonArg = process.argv.indexOf('--json');
if (jsonArg !== -1 && process.argv[jsonArg + 1]) {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // bench run outside a git checkout — sha stays "unknown"
  }
  const payload = {
    meta: {
      generatedAt: new Date().toISOString(), // reporting metadata only — never used in measurement
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      loadAvg1m: round(os.loadavg()[0], 2),
      commit,
      clock: 'process.hrtime.bigint',
      samples: SAMPLES,
      warmupSamples: WARMUP_SAMPLES,
    },
    benchmarks: results,
  };
  writeFileSync(process.argv[jsonArg + 1], `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nJSON written to ${process.argv[jsonArg + 1]}`);
}
