// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Tiny invariant spot-check — the third mutant detector, independent of both
 * the vitest suite and the model explorer.
 *
 * Each probe is a BLACK-BOX restatement of one published invariant
 * (docs/FORMAL_INVARIANTS.md): it builds the machine / encoder the way a
 * consumer does and asserts the property the spec promises. Probes never
 * import the test helpers and never mirror the implementation's own guards —
 * when a guard is deleted the probe must still fail, or the probe is as blind
 * as the spec.
 *
 * Usage (from the repo root of the tree under test):
 *   npx tsx scripts/mutation/spot-check.mjs
 *
 * Output: one JSON object on stdout ({probes:[{id,description,ok,error}]}).
 * Exit 0 = every probe passed, 1 = at least one failed, 2 = harness failure.
 */

import { createHash } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';

const root = new URL('../../', import.meta.url).pathname;

const confirmation = await import(`${root}confirmationMachineCore.ts`);
const confirmationMachine = await import(`${root}courtConfirmationMachine.ts`);
const vote = await import(`${root}courtVoteMachine.ts`);
const signingMachine = await import(`${root}courtSigningMachine.ts`);
const batch = await import(`${root}batchAttestation.ts`);
const session = await import(`${root}courtSession.ts`);
const validator = await import(`${root}validator.ts`);

const hex = (ch) => ch.repeat(64);
const probes = [];

function probe(id, description, fn) {
  try {
    fn();
    probes.push({ id, description, ok: true });
  } catch (err) {
    probes.push({
      id,
      description,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

/** Fresh confirmation case (n=3, quorum 1 unless overridden). */
function confirmationCase(overrides = {}) {
  return confirmationMachine.createCourtConfirmationMachine({
    sessionHash: hex('2'),
    proposalHash: hex('3'),
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO', 'a\u{1F600}', 'a\uE000'],
    participantIndices: [1, 2, 3],
    confirmQuorum: 1,
    confirmDeadline: 100,
    challengeDeadline: 200,
    maxLadderRounds: 1,
    ...overrides,
  });
}

function confirmationEvent(state, idx, now, eventId = hex(String(idx))) {
  return {
    type: 'accept_confirmation',
    idx,
    confirmHash: confirmation.hashCourtConfirmation({
      sessionHash: state.sessionHash,
      proposalHash: state.proposalHash,
      idx,
    }),
    eventId,
    now,
  };
}

function reduce(state, event) {
  return confirmationMachine.reduceCourtConfirmationMachine(state, event);
}

// ── S01 strictly-before deadline (exactly-at is rejected) ──────────────────
probe('S01', 'a confirmation arriving exactly AT confirmDeadline is rejected', () => {
  const s = confirmationCase();
  expectThrow(() => reduce(s, confirmationEvent(s, 1, 100)), 'event at exactly the deadline was accepted');
});

// ── S02 a tick at exactly the deadline expires the phase ───────────────────
probe('S02', 'a tick at exactly confirmDeadline expires the case', () => {
  const s = confirmationCase();
  const next = reduce(s, { type: 'tick', now: 100 });
  assert(next.phase === 'expired', `expected expired, got ${next.phase}`);
});

// ── S03 quorum is enforced at close_confirmations ──────────────────────────
probe('S03', 'close_confirmations refuses an under-quorum ledger', () => {
  let s = confirmationCase({ confirmQuorum: 3 });
  s = reduce(s, confirmationEvent(s, 1, 10));
  s = reduce(s, confirmationEvent(s, 2, 11));
  expectThrow(() => reduce(s, { type: 'close_confirmations', now: 100 }), 'closed below quorum');
});

// ── S04 duplicate seat / conflicting record is rejected ────────────────────
probe('S04', 'a second, different confirmation from one seat is rejected', () => {
  let s = confirmationCase();
  s = reduce(s, confirmationEvent(s, 1, 10));
  expectThrow(() => reduce(s, confirmationEvent(s, 1, 11, hex('9'))), 'conflicting confirmation accepted');
});

// ── S05 terminal phases reject unguarded events ────────────────────────────
probe('S05', 'record_fee after a terminal phase is rejected', () => {
  let s = confirmationCase();
  s = reduce(s, { type: 'abort', reason: 'operator cancel' });
  assert(s.phase === 'aborted', `expected aborted, got ${s.phase}`);
  expectThrow(() => reduce(s, { type: 'record_fee', feeEventId: hex('a'), now: 10 }), 'record_fee mutated a terminal case');
});

// ── S06 monotonic clock ───────────────────────────────────────────────────
probe('S06', 'a clock rollback is rejected', () => {
  let s = confirmationCase();
  s = reduce(s, confirmationEvent(s, 1, 50));
  expectThrow(() => reduce(s, { type: 'tick', now: 40 }), 'clock rollback accepted');
});

// ── S07 ladder-round tie-break is UTF-8 byte order ─────────────────────────
probe('S07', 'a 1-1 ladder tie resolves to the UTF-8-smaller outcome (astral vs BMP)', () => {
  let s = confirmationCase({ maxLadderRounds: 1 });
  s = reduce(s, confirmationEvent(s, 1, 10));
  s = reduce(s, { type: 'close_confirmations', now: 100 });
  s = reduce(s, { type: 'open_challenge_window', now: 100 });
  s = reduce(s, { type: 'accept_challenge', idx: 1, bondTxid: hex('b'), bondProofHash: hex('c'), eventId: hex('d'), now: 110 });
  s = reduce(s, { type: 'close_challenge_window', now: 200 });
  s = reduce(s, { type: 'open_ladder_round', round: 1, voteDeadline: 300, now: 200 });
  s = reduce(s, { type: 'accept_mass_vote', idx: 1, outcome: 'a\u{1F600}', eventId: hex('e'), now: 210 });
  s = reduce(s, { type: 'accept_mass_vote', idx: 2, outcome: 'a\uE000', eventId: hex('f'), now: 211 });
  s = reduce(s, { type: 'close_ladder_round', now: 300 });
  s = reduce(s, { type: 'resolve_round', now: 300 });
  assert(s.verdict, 'no verdict after resolve_round');
  assert(
    s.verdict.outcome === 'a\uE000',
    `tie-break picked ${JSON.stringify(s.verdict.outcome)} — UTF-8 order requires a+U+E000`,
  );
});

// ── S08 compareOutcomeUtf8 is byte order, not UTF-16 order ────────────────
probe('S08', 'compareOutcomeUtf8 orders U+E000 before U+1F600 (UTF-8 bytes, not UTF-16 units)', () => {
  assert(vote.compareOutcomeUtf8('a\uE000', 'a\u{1F600}') < 0, 'UTF-8 order violated');
  assert(vote.compareOutcomeUtf8('a\u{1F600}', 'a\uE000') > 0, 'UTF-8 order violated (reverse)');
});

// ── S09 Merkle leaf/node preimages are independently derivable ────────────
probe('S09', 'BatchLeaf/BatchNode preimages match the documented encoding (tags 0x00/0x01, u32 length prefix)', () => {
  const verdictHash = hex('7');
  const leafOf = (h) => {
    const pre = Buffer.concat([
      Buffer.from('BAO-Court/BatchLeaf/v1', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(h, 'hex'),
    ]);
    return createHash('sha256').update(pre).digest('hex');
  };
  const nodeOf = (l, r) => {
    const pre = Buffer.concat([
      Buffer.from('BAO-Court/BatchNode/v1', 'utf8'),
      Buffer.from([0x01]),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(l, 'hex'),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(r, 'hex'),
    ]);
    return createHash('sha256').update(pre).digest('hex');
  };
  const single = batch.buildBatchMerkleTree([verdictHash]);
  assert(single.root === leafOf(verdictHash), 'single-leaf root is not BatchLeaf(verdictHash)');
  const two = batch.buildBatchMerkleTree([verdictHash, hex('8')]);
  const [l0, l1] = two.leaves;
  assert(two.root === nodeOf(l0, l1), 'two-leaf root is not BatchNode(leaf0, leaf1)');
});

// ── S10 RFC-6962 split for a non-power-of-two tree (n = 5, 9) ─────────────
probe('S10', 'batch roots follow the RFC-6962 split for n = 5 and n = 9', () => {
  const hashes = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(64, '0'));
  const leafOf = (h) => {
    const pre = Buffer.concat([
      Buffer.from('BAO-Court/BatchLeaf/v1', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(h, 'hex'),
    ]);
    return createHash('sha256').update(pre).digest('hex');
  };
  const nodeOf = (l, r) => {
    const pre = Buffer.concat([
      Buffer.from('BAO-Court/BatchNode/v1', 'utf8'),
      Buffer.from([0x01]),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(l, 'hex'),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(r, 'hex'),
    ]);
    return createHash('sha256').update(pre).digest('hex');
  };
  const mth = (leaves, lo, hi) => {
    if (hi - lo === 1) return leafOf(leaves[lo]);
    let k = 1;
    while (k * 2 < hi - lo) k *= 2; // RFC-6962: largest power of two < n
    return nodeOf(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
  };
  for (const n of [5, 9]) {
    const subset = hashes.slice(0, n);
    const built = batch.buildBatchMerkleTree(subset);
    const expected = mth([...subset].sort(), 0, n);
    assert(built.root === expected, `n=${n}: root ${built.root} != RFC-6962 ${expected}`);
  }
});

// ── S11 CanonicalWriter length prefix + big-endian u32 ────────────────────
probe('S11', 'CanonicalWriter prefixes every byte field with a big-endian u32 length', () => {
  const writer = new session.CanonicalWriter();
  writer.u8(0xaa);
  writer.hex(hex('5'));
  const bytes = writer.finish();
  assert(bytes.length === 1 + 4 + 32, `expected 37 bytes, got ${bytes.length}`);
  assert(
    bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 && bytes[4] === 32,
    `length prefix is not big-endian 32 (got ${[...bytes.slice(1, 5)].join(',')})`,
  );
  assert(bytes[5] === 0x55, 'payload byte misplaced');
});

// ── S12 canonical hex is lowercase-only ───────────────────────────────────
probe('S12', 'uppercase hex is not canonical (machine creation and batch leaves reject it)', () => {
  expectThrow(
    () => confirmationCase({ sessionHash: hex('a').toUpperCase() }),
    'uppercase sessionHash accepted by the confirmation machine',
  );
  expectThrow(() => batch.buildBatchMerkleTree([hex('a').toUpperCase()]), 'uppercase leaf hash accepted');
});

// ── S13/S14 empty-string pins fail closed (F-2) ───────────────────────────
probe('S13', 'v1 validator treats an empty expectedGroupPubkey pin as a misconfiguration, not "no pin"', () => {
  const result = validator.validateAttestationEvent({ kind: 89, tags: [], content: '', pubkey: '', id: '', sig: '', created_at: 0 }, { expectedGroupPubkey: '' });
  assert(result.valid === false, 'empty pin validated');
  assert(/pin must be a non-empty/i.test(result.error ?? ''), `expected the F-2 pin error, got: ${result.error}`);
});

probe('S14', 'batch validator treats an empty cohort pin as a misconfiguration (F-2)', () => {
  const result = batch.validateBatchAttestationEvent({ kind: batch.BAO_COURT_BATCH_ATTESTATION_KIND, tags: [], content: '{}', pubkey: '', id: '', sig: '', created_at: 0 }, { expectedGroupPubkey: '' });
  assert(result.valid === false, 'empty pin validated');
  assert(/pin must be a non-empty/i.test(result.reason ?? ''), `expected the F-2 pin error, got: ${result.reason}`);
});

// ── S15 batch rejects duplicate verdict hashes (proof-index ambiguity) ─────
probe('S15', 'a batch with a duplicate verdict hash is rejected', () => {
  expectThrow(() => batch.buildBatchMerkleTree([hex('a'), hex('a')]), 'duplicate verdict hash batched');
});

// ── S16 signing threshold: t-1 commitments cannot freeze the signer set ───
probe('S16', 'close_commitments refuses t-1 distinct signers', () => {
  const point = (i) => bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(i)));
  let s = signingMachine.createCourtSigningMachine({
    sessionHash: hex('1'),
    verdictHash: hex('2'),
    outcome: 'YES',
    participantIndices: [1, 2, 3],
    threshold: 2,
    attempt: 1,
    deadline: 100,
  });
  s = signingMachine.reduceCourtSigningMachine(s, { type: 'start', now: 10 });
  s = signingMachine.reduceCourtSigningMachine(s, { type: 'accept_commitment', idx: 1, binderPn: point(3), hiddenPn: point(4), now: 20 });
  expectThrow(
    () => signingMachine.reduceCourtSigningMachine(s, { type: 'close_commitments', now: 30 }),
    'commitment set froze below threshold',
  );
});

// ── S17 proof index bound is < count ──────────────────────────────────────
probe('S17', 'verifyCaseInBatch rejects a proof index equal to the declared count', () => {
  const caseInput = { sessionHash: hex('6'), outcome: 'YES', supportingEventIds: [hex('7')] };
  const verdictHash = vote.hashCourtVerdict(caseInput);
  const leaf = (() => {
    const pre = Buffer.concat([
      Buffer.from('BAO-Court/BatchLeaf/v1', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from([0, 0, 0, 32]),
      Buffer.from(verdictHash, 'hex'),
    ]);
    return createHash('sha256').update(pre).digest('hex');
  })();
  const event = {
    kind: batch.BAO_COURT_BATCH_ATTESTATION_KIND,
    tags: [['p', hex('1')], ['cohort', hex('1')], ['count', '1'], ['root', hex('2')], ['sig', hex('3')], ['nonce', hex('3')]],
    content: JSON.stringify({ root: hex('2'), count: 1, epoch: 0, batch: 0 }),
    pubkey: hex('1'),
    id: hex('4'),
    sig: hex('5'),
    created_at: 0,
  };
  const result = batch.verifyCaseInBatch(event, {
    ...caseInput,
    proof: { index: 1, verdictHash: leaf, path: [] },
  });
  assert(result.valid === false, 'index === count was accepted');
  assert(/outside the declared batch count/i.test(result.reason ?? ''), `unexpected reason: ${result.reason}`);
});

// ── S18 Merkle root commits to leaves (order-independent, content-bound) ──
probe('S18', 'batch roots depend on leaf CONTENT and are submission-order independent', () => {
  const a = batch.buildBatchMerkleTree([hex('1'), hex('2'), hex('3')]);
  const b = batch.buildBatchMerkleTree([hex('3'), hex('1'), hex('2')]);
  const c = batch.buildBatchMerkleTree([hex('1'), hex('2'), hex('4')]);
  assert(a.root === b.root, 'root depends on submission order');
  assert(a.root !== c.root, 'root ignores leaf content');
  assert(bytesToHex(hexToBytes(a.root)) === a.root, 'root is not 32-byte hex');
});

const failed = probes.filter((p) => !p.ok);
process.stdout.write(`${JSON.stringify({ probes, failed: failed.length })}\n`);
process.exit(failed.length === 0 ? 0 : 1);
