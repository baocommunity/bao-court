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
const ladder = await import(`${root}ladderEconomics.ts`);
const aging = await import(`${root}penaltyAging.ts`);
const quorum = await import(`${root}quorumEconomics.ts`);
const escalation = await import(`${root}courtEscalationRequest.ts`);

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

// ══════════════════════════════════════════════════════════════════════════
// v0.13 surface probes (S19–S32). Round 37's campaign asks whether the
// per-round bond (R31), the complete escalation ledger (r33-5), the
// sign-based ladder bound (r33-6), the paired decay (r30-4a/b) and the
// quorum economics are pinned by the REPOSITORY, or only by the round that
// introduced them. Each probe below restates one published invariant —
// `docs/FORMAL_INVARIANTS.md` INV-ESC-*, `docs/proofs/economics/02-ladder`
// Thm 2, `05-review-gapfills` §1.3, `06-expert-verify` §1.5/§4/§3 — and
// imports nothing from `__tests__/`.
// ══════════════════════════════════════════════════════════════════════════

const HEX = (c) => c.repeat(64);
const PAD = (s) => s.padEnd(64, '0');

/** Round `r`'s fresh per-round bond witness. */
const roundBondWitness = (r) => PAD(`a${r}`);

/** A case advanced to `round_resolved` after round 1 (juror 2 challenged). */
function challengedCase(opts = {}) {
  const participants = opts.participants ?? [1, 2, 3];
  let s = confirmationMachine.createCourtConfirmationMachine({
    sessionHash: HEX('1'),
    proposalHash: HEX('2'),
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: participants,
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: opts.maxLadderRounds ?? 3,
    ...(opts.requireRoundBond === undefined ? {} : { requireRoundBond: opts.requireRoundBond }),
    ...(opts.hostEscalation === undefined ? {} : { hostEscalation: opts.hostEscalation }),
  });
  for (const idx of participants) {
    s = reduce(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: confirmationMachine.hashCourtConfirmation({
        sessionHash: s.sessionHash,
        proposalHash: s.proposalHash,
        idx,
      }),
      eventId: PAD(`c${idx}`),
      now: 100 + idx,
    });
  }
  s = reduce(s, { type: 'close_confirmations', now: 1000 });
  s = reduce(s, { type: 'open_challenge_window', now: 1100 });
  let at = 1200;
  for (const idx of opts.challengers ?? [2]) {
    s = reduce(s, {
      type: 'accept_challenge',
      idx,
      bondTxid: PAD(`d${idx}`),
      bondProofHash: PAD(`e${idx}`),
      eventId: PAD(`f${idx}`),
      now: at,
    });
    at += 10;
  }
  s = reduce(s, { type: 'close_challenge_window', now: 2000 });
  s = openRound(s, 1, 3000, 2100, 'NO');
  s = reduce(s, { type: 'close_ladder_round', now: 3000 });
  return reduce(s, { type: 'resolve_round', now: 3100 });
}

function openRound(s, round, voteDeadline, now, outcome) {
  let next = reduce(s, { type: 'open_ladder_round', round, voteDeadline, now });
  for (const idx of s.participantIndices) {
    next = reduce(next, {
      type: 'accept_mass_vote',
      idx,
      outcome,
      eventId: PAD(`${round}b${idx}`),
      now: now + 10 + idx,
    });
  }
  return next;
}

function escalateEvent(s, now, witness = {}) {
  return confirmationMachine.challengerEscalationEvent(s, now, {
    challengerPubkey: HEX('7'),
    requestHash: HEX('8'),
    ...witness,
  });
}

/** Escalate with round bond `bondR`, then drive round `round` to `round_resolved`. */
function advance(s, round, at, bondR) {
  let next = reduce(s, escalateEvent(s, at, bondR === undefined ? {} : { roundBondProofHash: bondR }));
  next = openRound(next, round, at + 1000, at + 100, 'YES');
  next = reduce(next, { type: 'close_ladder_round', now: at + 1000 });
  return reduce(next, { type: 'resolve_round', now: at + 1100 });
}

// ── S19 a consumed round bond cannot fund another rung (R31) ──────────────
probe('S19', 'a per-round bond already consumed by round 2 is refused for round 3', () => {
  let s = challengedCase({ requireRoundBond: true });
  s = advance(s, 2, 3200, roundBondWitness(2));
  expectThrow(
    () => reduce(s, escalateEvent(s, 4400, { roundBondProofHash: roundBondWitness(2) })),
    'one paid bond funded a second rung (ΔC = 0 reopened)',
  );
});

// ── S20 the membership bond cannot be relabelled as the round bond ────────
probe('S20', 'the challenger\'s own membership bond cannot be relabelled as this round\'s payment', () => {
  const s = challengedCase();
  expectThrow(
    () => reduce(s, escalateEvent(s, 3200, { roundBondProofHash: s.challenges[0].bondProofHash })),
    'the membership bond was accepted as a per-round bond',
  );
});

// ── S21 no accepted bond of ANY juror may be relabelled (r33-1) ───────────
probe('S21', 'ANOTHER juror\'s accepted membership bond is refused as this round\'s payment (r33-1)', () => {
  const s = challengedCase({ challengers: [2, 3] });
  expectThrow(
    () => reduce(s, escalateEvent(s, 3200, { roundBondProofHash: PAD('e3') })),
    'juror 3\'s membership bond paid juror 2\'s escalation',
  );
});

// ── S22 a strict case refuses an escalation with no round bond ────────────
probe('S22', 'requireRoundBond refuses a witness that carries no per-round bond', () => {
  const s = challengedCase({ requireRoundBond: true });
  expectThrow(
    () => reduce(s, escalateEvent(s, 3200)),
    'a strict case accepted the legacy free option',
  );
});

// ── S23 a snapshot that dropped an escalation record is refused ───────────
probe('S23', 'a restored snapshot with every escalation record deleted cannot re-open the free rung (r33-5)', () => {
  let s = challengedCase({ requireRoundBond: true });
  s = advance(s, 2, 3200, roundBondWitness(2));
  assert(s.escalationLog.length === 1, `expected 1 escalation record, got ${s.escalationLog.length}`);
  const stripped = { ...s, escalationLog: [] };
  expectThrow(
    () => reduce(stripped, escalateEvent(stripped, 4400, { roundBondProofHash: roundBondWitness(2) })),
    'a stripped ledger opened a rung paid by an already-consumed bond',
  );
});

// ── S24 the ledger barrier binds records to rounds and to a strict policy ─
probe('S24', 'the escalation ledger re-verifies its own records (round binding, strict-policy bond)', () => {
  let s = challengedCase({ requireRoundBond: true });
  s = advance(s, 2, 3200, roundBondWitness(2));
  const forged = {
    ...s,
    escalationLog: s.escalationLog.map((record) => ({ ...record, round: 9 })),
  };
  expectThrow(
    () => confirmation.assertValidEscalationLog(forged),
    'a ledger naming a round the case never opened passed the barrier',
  );
  const bondless = {
    ...s,
    escalationLog: s.escalationLog.map((record) => ({ ...record, roundBondProofHash: null })),
  };
  expectThrow(
    () => confirmation.assertValidEscalationLog(bondless),
    'a strict case finalized on a record with no per-round bond',
  );
});

// ── S25 "no safe depth" is 0, and the gate refuses every cap ──────────────
probe('S25', 'a_f at or below ρ/(ρ+β) derives 0 safe rounds and refuses every cap (r33-6)', () => {
  const params = { a_f: 0.45, rho: 0.03, beta: 0.03 };
  assert(ladder.deriveMaxLadderRounds(params) === 0, 'derived cap is not 0 where no depth is safe');
  for (const cap of [1, 2, 3, 4, 5]) {
    assert(ladder.ladderCapWithinBound({ ...params, maxLadderRounds: cap }).ok === false, `cap ${cap} approved above the bound`);
  }
});

// ── S26 the cap IS the sign predicate, at an exact integer boundary too ───
probe('S26', 'an EXACT integer boundary: the cap stops below break-even and the flip round is refused', () => {
  // a_f = 0.5, ρ = 1, β = 3 ⇒ ln(0.25)/ln(0.5) = 2 exactly: round 2 breaks even.
  const params = { a_f: 0.5, rho: 1, beta: 3 };
  assert(ladder.deriveMaxLadderRounds(params) === 1, 'the cap named the break-even round instead of stopping below it');
  assert(ladder.deriveLadderFlipRound(params) === 2, 'the flip round is not the break-even round');
  assert(ladder.ladderCapWithinBound({ ...params, maxLadderRounds: 1 }).ok === true, 'the safe cap 1 was refused');
  assert(
    ladder.ladderCapWithinBound({ ...params, maxLadderRounds: 2 }).ok === false,
    'a cap at the zero-EV round was approved (derivedCap comparison, not the sign)',
  );
});

// ── S27 the flip round is the first UNSAFE round ──────────────────────────
probe('S27', 'E[π] < 0 through the safe cap and > 0 from the flip round (published rows)', () => {
  for (const a_f of [0.9, 0.85, 0.75, 0.7]) {
    const params = { a_f, rho: 0.03, beta: 0.03 };
    const cap = ladder.deriveMaxLadderRounds(params);
    const flip = ladder.deriveLadderFlipRound(params);
    assert(flip > cap, `a_f=${a_f}: flip ${flip} is not above the safe cap ${cap}`);
    if (cap >= 1) {
      assert(ladder.escalationOptionEv({ ...params, rounds: cap }) < 0, `a_f=${a_f}: E[π] at the cap is not negative`);
    }
    assert(ladder.escalationOptionEv({ ...params, rounds: flip }) > 0, `a_f=${a_f}: E[π] at the flip round is not positive`);
  }
});

// ── S28 penalties age on the participating clock, half-life 3 ─────────────
probe('S28', 'a penalty ages at λ = ln2/3 on the PARTICIPATING clock (0.8 → 0.9 → 0.975)', () => {
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  assert(close(aging.agePenalties([{ factor: 0.8 }], 0), 0.8), 'the un-aged multiplier is not the factor itself');
  assert(close(aging.agePenalties([{ factor: 0.8 }], 3), 0.9), 'one half-life did not halve the deviation');
  assert(close(aging.agePenalties([{ factor: 0.8 }], 9), 0.975), 'three half-lives are not 0.975');
  assert(
    aging.agePenalties([{ factor: 0.8, ageEpochs: 3 }], 0) === aging.agePenalties([{ factor: 0.8 }], 3),
    'served age and new epochs are not one timeline',
  );
  let previous = 0;
  for (let epochs = 0; epochs <= 12; epochs += 1) {
    const value = aging.agePenalties([{ factor: 0.8 }], epochs);
    assert(value >= previous, `aging is not monotone at ${epochs} epochs`);
    previous = value;
  }
});

// ── S29 the paired weight anchors at the floor, never at w0 (r30-4a) ──────
probe('S29', 'a penalised juror is anchored at the floor: idleness never hands weight back', () => {
  const w0 = 1;
  const penalties = [{ factor: 0.8 }];
  let previous = Infinity;
  for (const idleEpochs of [0, 1, 3, 6, 20, 100]) {
    const weight = aging.pairedJurorWeight({ w0, penalties, idleEpochs });
    assert(weight <= previous + 1e-15, `weight rose from idling at ${idleEpochs}`);
    assert(weight <= 0.8 + 1e-12, `penalised weight ${weight} rose above the earned 0.8 (anchor is w0)`);
    assert(weight >= 0.5 - 1e-12, `penalised weight ${weight} fell below the 0.5 floor`);
    previous = weight;
  }
  assert(aging.pairedJurorWeight({ w0, penalties: [] }) === 1, 'an unpenalised juror is not w0');
  assert(
    aging.pairedJurorWeight({ w0, penalties, idleEpochs: 0, minWeightFactor: 0.25 }) >= 0.25,
    'the documented floor is not enforced',
  );
});

// ── S30 the R25 policy flag records exactly the weak-quorum cases ─────────
probe('S30', 'quorumBelowSupermajority === (confirmQuorum < ⌈2N/3⌉) (INV-CONF-4)', () => {
  const cases = [
    { n: 3, q: 2, weak: false },
    { n: 5, q: 3, weak: true },
    { n: 5, q: 4, weak: false },
    { n: 15, q: 9, weak: true },
    { n: 15, q: 10, weak: false },
  ];
  for (const { n, q, weak } of cases) {
    const roster = Array.from({ length: n }, (_, i) => i + 1);
    const s = confirmationMachine.createCourtConfirmationMachine({
      sessionHash: HEX('1'),
      proposalHash: HEX('2'),
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: roster,
      confirmQuorum: q,
      confirmDeadline: 100,
      challengeDeadline: 200,
      maxLadderRounds: 1,
    });
    assert(s.confirmQuorum === q, `n=${n}: quorum ${s.confirmQuorum} != ${q}`);
    assert(s.quorumBelowSupermajority === weak, `n=${n} q=${q}: flag ${s.quorumBelowSupermajority} != ${weak}`);
  }
});

// ── S31 the per-round bond schedule is 3^R and 4/13/40/121/364× ───────────
probe('S31', 'the escalation bond schedule is 3^R marginal and 4/13/40/121/364× cumulative (Thm 2)', () => {
  for (const [r, multiple] of [[0, 1], [1, 3], [2, 9], [3, 27], [4, 81], [5, 243]]) {
    assert(ladder.escalationBondMultiple(r) === multiple, `ΔC_${r} is not ${multiple}× b₀`);
  }
  for (const [r, cumulative] of [[0, 1], [1, 4], [2, 13], [3, 40], [4, 121], [5, 364]]) {
    assert(ladder.cumulativeLadderBondMultiple(r) === cumulative, `C_${r} is not ${cumulative}× b₀`);
  }
});

// ── S32 κ is measured against the ⌈2N/3⌉ baseline ─────────────────────────
probe('S32', 'κ = 1 at ⌈2N/3⌉, > 1 for a weaker quorum, < 1 for a stronger one (05 §1.3)', () => {
  const share = { numerator: 1, denominator: 3 };
  assert(
    Math.abs(quorum.quorumCapCorrection({ panelSize: 5, quorum: 4, adversaryWeight: share }) - 1) < 1e-12,
    'κ at the shipped supermajority is not 1',
  );
  assert(quorum.quorumCapCorrection({ panelSize: 5, quorum: 3, adversaryWeight: share }) > 1, 'κ at 3-of-5 is not > 1');
  assert(quorum.quorumCapCorrection({ panelSize: 5, quorum: 5, adversaryWeight: share }) < 1, 'κ at 5-of-5 is not < 1');
  assert(
    Math.abs(quorum.quorumCapCorrection({ panelSize: 5, quorum: 3, adversaryWeight: share }) - 51 / 11) < 1e-12,
    'κ at 3-of-5 at ρ = ⅓ is not the published 51/11',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// v0.14.0 escalation-transport probes (S33–S48). Round 47's campaign asks
// whether the TRANSPORT — `courtEscalationRequest.ts`, the wire codec the
// round-7 finding H-6 created and round 8 hardened — is pinned by the
// repository, or only by the review round that wrote it. Each probe restates
// one claim the module PUBLISHES (its header doc + `docs/PER_ROUND_BOND.md` +
// `docs/REVIEW_ROUND_8.md`), and imports nothing from `__tests__/`.
// ══════════════════════════════════════════════════════════════════════════

const TRANSPORT_CASE = 'court:market-r47-probe:1';
const TRANSPORT_PUBKEY = HEX('7');
const TRANSPORT_BINDING = { caseId: TRANSPORT_CASE, authenticatedPubkey: TRANSPORT_PUBKEY };

/** The challenger's half of a request against `challengedCase()`'s juror-2 bond. */
function transportRequest(overrides = {}) {
  return escalation.buildCourtEscalationRequest({
    caseId: TRANSPORT_CASE,
    round: 1,
    challengerPubkey: TRANSPORT_PUBKEY,
    bondTxid: PAD('d2'),
    bondProofHash: PAD('e2'),
    roundBondProofHash: roundBondWitness(2),
    eventId: HEX('8'),
    signedAtSec: 1_790_000_000,
    ...overrides,
  });
}

const wireOfTransport = (req) => JSON.parse(escalation.serializeCourtEscalationRequest(req));

// ── S33 an accepted caseId is returned UNCHANGED (validate, do not fold) ──
probe('S33', 'the codec validates a caseId EXACTLY: whitespace is refused, accepted ids are not rewritten (r8-1, r9-1)', () => {
  // A FOLD is a lossy map: `"court:1"`, `"court:1 "` and `"court:1\u{3000}"`
  // would become one id with ONE digest, and `build` would return an id the
  // caller never supplied.
  for (const id of [' court:1', 'court:1 ', 'court:1\t', 'court:1\u{3000}', 'court:1\n']) {
    expectThrow(
      () => escalation.buildCourtEscalationRequest({ ...transportRequest(), caseId: id }),
      `an id with surrounding whitespace (${JSON.stringify(id)}) was accepted or folded`,
    );
  }
  const accepted = ['court:1', 'court: a b:1', 'a"b\\c{}[],:', '-', 'caf\u00e9', 'cafe\u0301', '\u{1F600}'];
  for (const id of accepted) {
    const built = escalation.buildCourtEscalationRequest({ ...transportRequest(), caseId: id });
    assert(
      built.caseId === id,
      `accepted id ${JSON.stringify(id)} came back as ${JSON.stringify(built.caseId)} — the codec rewrote a value it validated`,
    );
  }
  // …and an unpaired surrogate is REFUSED rather than collapsed to U+FFFD.
  expectThrow(
    () => escalation.buildCourtEscalationRequest({ ...transportRequest(), caseId: 'court:1\ud800' }),
    'an unpaired surrogate was accepted into the hash preimage (r8-1)',
  );
});

// ── S34 distinct wire requests never share a digest ────────────────────────
probe('S34', 'distinct case ids produce distinct request digests (injectivity, H-6)', () => {
  const ids = ['court:1', 'court:2', 'court:1\uFFFD', 'caf\u00e9', 'cafe\u0301', 'court:1\ud800x'];
  const digests = new Map();
  for (const id of ids) {
    let built;
    try {
      built = escalation.buildCourtEscalationRequest({ ...transportRequest(), caseId: id });
    } catch {
      continue; // refused ids are a different guard's subject (S33)
    }
    const digest = escalation.hashCourtEscalationRequest(built);
    const previous = digests.get(digest);
    assert(previous === undefined, `case ids ${JSON.stringify(previous)} and ${JSON.stringify(id)} share one digest`);
    digests.set(digest, id);
  }
  assert(digests.size >= 4, `only ${digests.size} ids were accepted — the corpus stopped testing injectivity`);
});

// ── S35 NUL-free and byte-bounded ──────────────────────────────────────────
probe('S35', 'a NUL cannot enter the preimage and the id is byte-bounded at 256', () => {
  expectThrow(
    () => escalation.buildCourtEscalationRequest({ ...transportRequest(), caseId: 'a\u0000b' }),
    'a U+0000 in caseId was accepted (it separates preimage fields)',
  );
  expectThrow(
    () => escalation.buildCourtEscalationRequest({
      ...transportRequest(), caseId: 'a'.repeat(escalation.MAX_ESCALATION_CASE_ID_BYTES + 1),
    }),
    'a 257-byte caseId was accepted',
  );
  assert(
    escalation.buildCourtEscalationRequest({
      ...transportRequest(), caseId: 'a'.repeat(escalation.MAX_ESCALATION_CASE_ID_BYTES),
    }).caseId.length === escalation.MAX_ESCALATION_CASE_ID_BYTES,
    'a 256-byte caseId (the legal maximum) was refused',
  );
});

// ── S36 absent ≠ present in the witness slot ───────────────────────────────
probe('S36', 'a request without a per-round bond hashes differently from one with it (the "-" slot)', () => {
  const withWitness = escalation.hashCourtEscalationRequest(transportRequest());
  const without = escalation.hashCourtEscalationRequest(transportRequest({ roundBondProofHash: null }));
  assert(withWitness !== without, 'the absent witness slot collides with a present one');
  const preimage = escalation.courtEscalationRequestPreimage(transportRequest({ roundBondProofHash: null }));
  assert(
    preimage.split('\u0000').includes('-'),
    `the absent slot is not the "-" sentinel: ${JSON.stringify(preimage)}`,
  );
  expectThrow(
    () => escalation.buildCourtEscalationRequest({ ...transportRequest(), roundBondProofHash: '-' }),
    'a literal "-" was accepted as a witness (it is the absent sentinel)',
  );
});

// ── S37 the digest is the DOCUMENTED construction, recomputed ──────────────
probe('S37', 'the request hash is sha256(domain ‖ 0x00 ‖ the documented preimage)', () => {
  const req = transportRequest();
  const enc = new TextEncoder();
  const preimage = [
    req.caseId,
    String(req.round),
    req.challengerPubkey,
    req.bondTxid,
    req.bondProofHash,
    req.roundBondProofHash,
    req.eventId,
    String(req.signedAtSec),
    req.concession ? '1' : '0',
  ].join('\u0000');
  const domain = enc.encode(escalation.COURT_ESCALATION_REQUEST_DOMAIN);
  const body = enc.encode(preimage);
  const input = new Uint8Array(domain.length + 1 + body.length);
  input.set(domain, 0);
  input[domain.length] = 0x00;
  input.set(body, domain.length + 1);
  const expected = bytesToHex(sha256(input));
  assert(
    escalation.hashCourtEscalationRequest(req) === expected,
    `digest ${escalation.hashCourtEscalationRequest(req)} != sha256(domain‖0x00‖preimage) ${expected}`,
  );
  assert(escalation.COURT_ESCALATION_REQUEST_DOMAIN === 'BAO-Court/Escalation/Request/v2', 'the hash domain is not v2');
});

// ── S38 unknown fields are refused, on BOTH input paths ────────────────────
probe('S38', 'an unknown wire field is refused whether the body arrives as JSON text or as an object', () => {
  const wire = { ...wireOfTransport(transportRequest()), round_bond_proof_hash: roundBondWitness(2) };
  expectThrow(() => escalation.parseCourtEscalationRequest(JSON.stringify(wire)), 'unknown field accepted (JSON text)');
  expectThrow(() => escalation.parseCourtEscalationRequest(wire), 'unknown field accepted (parsed object)');
});

// ── S39 a repeated field is refused, escapes included ──────────────────────
probe('S39', 'a repeated field is refused, including one spelled with a JSON escape (r8-4)', () => {
  const body = escalation.serializeCourtEscalationRequest(transportRequest());
  const plainDup = body.replace('"roundBondProofHash":', '"roundBondProofHash":null,"roundBondProofHash":');
  expectThrow(() => escalation.parseCourtEscalationRequest(plainDup), 'a repeated roundBondProofHash was resolved last-wins');
  const escapeDup = body.replace('"caseId":', '"c\\u0061seId":"court:other:1","caseId":');
  expectThrow(() => escalation.parseCourtEscalationRequest(escapeDup), 'an escaped duplicate key was not seen as a duplicate');
});

// ── S40 a wire field is never coerced ──────────────────────────────────────
probe('S40', 'parse shape-checks its fields instead of coercing them (no stringly round, no numeric id)', () => {
  const wire = wireOfTransport(transportRequest());
  for (const round of ['2', true, [2], null]) {
    expectThrow(
      () => escalation.parseCourtEscalationRequest({ ...wire, round }),
      `round ${JSON.stringify(round)} was coerced to an integer`,
    );
  }
  expectThrow(() => escalation.parseCourtEscalationRequest({ ...wire, caseId: 42 }), 'a numeric caseId was coerced');
  expectThrow(() => escalation.parseCourtEscalationRequest({ ...wire, caseId: undefined }), 'a missing caseId was accepted');
});

// ── S41 the round is an integer inside the ladder ceiling ──────────────────
probe('S41', 'a request round must be an integer in 1..5', () => {
  for (const round of [0, 6, 1.5, -1, Number.NaN]) {
    expectThrow(
      () => escalation.buildCourtEscalationRequest({ ...transportRequest(), round }),
      `round ${round} was accepted`,
    );
  }
  for (const round of [1, 2, 5]) {
    assert(
      escalation.buildCourtEscalationRequest({ ...transportRequest(), round }).round === round,
      `legal round ${round} was refused`,
    );
  }
});

// ── S42 the mapping binds identity, index and case ────────────────────────
probe('S42', 'an escalation cannot name a pubkey, an index or a case the host did not verify (r8-2)', () => {
  const state = challengedCase();
  // (a) the wire pubkey is not the authenticated one — the r29-2 attribution harm.
  expectThrow(
    () => escalation.escalationRequestToMachineEvent(state, transportRequest({ challengerPubkey: HEX('9') }), 3200, TRANSPORT_BINDING),
    'an unverified challengerPubkey minted an escalation',
  );
  // (b) the roster index is the BOND OWNER's (juror 2), not the roster head.
  const event = escalation.escalationRequestToMachineEvent(state, transportRequest(), 3200, TRANSPORT_BINDING);
  assert(event.challengerIdx === 2, `challengerIdx ${event.challengerIdx} is not the bond owner (2)`);
  // (c) a request cannot cross cases.
  expectThrow(
    () => escalation.escalationRequestToMachineEvent(
      state, transportRequest({ caseId: 'court:someone-else:9' }), 3200, TRANSPORT_BINDING,
    ),
    'a request crossed cases',
  );
  // (d) an unbound call is a refusal, not a silent mint.
  expectThrow(
    () => escalation.escalationRequestToMachineEvent(state, transportRequest(), 3200),
    'an unbound mapping minted an escalation',
  );
});

// ── S43 one bond, one owner: ambiguity is refused ─────────────────────────
probe('S43', 'a ledger that binds one bond hash to two owners is refused, not resolved (r38-1)', () => {
  const state = challengedCase();
  const ambiguous = {
    ...state,
    challenges: [...state.challenges, { ...state.challenges[0], idx: 3, eventId: PAD('aa') }],
  };
  expectThrow(
    () => escalation.escalationRequestToMachineEvent(ambiguous, transportRequest(), 3200, TRANSPORT_BINDING),
    'an ambiguous bond ledger was resolved to the first owner',
  );
});

// ── S44 the signed round is the case's round ─────────────────────────────
probe('S44', 'a request signed for round 1 cannot open a rung on a case resolving round 3', () => {
  const state = challengedCase();
  const later = { ...state, ladderRound: 3 };
  expectThrow(
    () => escalation.escalationRequestToMachineEvent(later, transportRequest({ round: 1 }), 3200, TRANSPORT_BINDING),
    'a stale request opened a later rung',
  );
  // …while the same request on the round it names is accepted (over-strictness control).
  assert(
    escalation.escalationRequestToMachineEvent(state, transportRequest({ round: 1 }), 3200, TRANSPORT_BINDING).roundIndex === 2,
    'the honest request did not map',
  );
});

// ── S45 the host clock is the host's ──────────────────────────────────────
probe('S45', '`now` is the caller\'s clock, never the request\'s, and a bad clock is refused (no fail-open)', () => {
  const state = challengedCase();
  const farFuture = transportRequest({ signedAtSec: 9_999_999_999 });
  assert(
    escalation.escalationRequestToMachineEvent(state, farFuture, 3200, TRANSPORT_BINDING).now === 3200,
    'the request steered `now`',
  );
  for (const now of [Number.NaN, -1, 1.5]) {
    expectThrow(
      () => escalation.escalationRequestToMachineEvent(state, transportRequest(), now, TRANSPORT_BINDING),
      `a bad host clock (${now}) was accepted or replaced by the wire clock`,
    );
  }
});

// ── S46 build reads every field ONCE (r8-5) ───────────────────────────────
probe('S46', 'a field read by build is validated and RETURNED from the same read (no getter double-fetch)', () => {
  let reads = 0;
  const shifty = {
    get caseId() {
      reads += 1;
      return 'court:shifted:1';
    },
    round: 1,
    challengerPubkey: TRANSPORT_PUBKEY,
    bondTxid: PAD('d2'),
    bondProofHash: PAD('e2'),
    roundBondProofHash: null,
    eventId: HEX('8'),
    signedAtSec: 1,
  };
  const built = escalation.buildCourtEscalationRequest(shifty);
  assert(reads === 1, `caseId was read ${reads} times — a getter can return a different value per read`);
  assert(built.caseId === 'court:shifted:1', `build returned ${JSON.stringify(built.caseId)}`);
});

// ── S47 a signed flag is a boolean, not truthiness (r8-3) ─────────────────
probe('S47', 'a non-boolean `concession` is refused instead of coerced to false (r8-3)', () => {
  const wire = wireOfTransport(transportRequest());
  for (const value of ['true', 1, 0, 'yes', {}, [], null]) {
    expectThrow(
      () => escalation.parseCourtEscalationRequest({ ...wire, concession: value }),
      `concession ${JSON.stringify(value)} was coerced`,
    );
  }
  assert(
    escalation.parseCourtEscalationRequest({ ...wire, concession: true }).concession === true,
    'a legal `true` concession was lost',
  );
});

// ── S48 the digest covers the RE-VALIDATED request ───────────────────────
probe('S48', 'hashCourtEscalationRequest re-validates its argument (a hand-built request cannot skip the codec)', () => {
  const req = transportRequest();
  expectThrow(
    () => escalation.hashCourtEscalationRequest({ ...req, caseId: 'a\u0000b' }),
    'a hand-built request with a NUL caseId was hashed without re-validation',
  );
  expectThrow(
    () => escalation.hashCourtEscalationRequest({ ...req, bondProofHash: 'deadbeef' }),
    'a hand-built request with malformed hex was hashed without re-validation',
  );
  // …and r9-1 applies here too: a foldable id is refused, never trimmed on the way in.
  expectThrow(
    () => escalation.hashCourtEscalationRequest({ ...req, caseId: ` ${TRANSPORT_CASE} ` }),
    'a hand-built request with a foldable id was hashed without the r9-1 refusal',
  );
});

const failed = probes.filter((p) => !p.ok);
process.stdout.write(`${JSON.stringify({ probes, failed: failed.length })}\n`);
process.exit(failed.length === 0 ? 0 : 1);