// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 9 — verdict FINALITY chains (challenge windows + escalations).
 *
 * The confirmation machine's finality is a PATH property, not a state property:
 * a verdict is final only after the case has (a) crossed a challenge window,
 * (b) resolved its ladder rounds — each further round entered ONLY through a
 * witness-bound escalation — and (c) minted the verdict at `final`. This
 * campaign drives whole chains through the real reducer and then runs the
 * FINALITY surface on the result: verdict recomputation, ledger provenance,
 * batch-attestation finality (a real Schnorr manifest signature), case
 * membership proofs, and terminal immutability (a terminal phase must refuse
 * even a PERFECT escalation witness).
 *
 * Chain shapes (rotated; counts land in the artifact):
 *
 *   escalate-to-cap   challenge window → round 1 … round N, each further round
 *                     opened by a witness-bound escalation (challenger, or the
 *                     break-glass host authority) → final round settles →
 *                     fee ledger → `final`;
 *   concede-early     challenge window → round 1 resolved → host concedes →
 *                     `final` with round 1's outcome;
 *   abort-window      challenge window aborted by the host → `aborted`;
 *   expire-window     the challenge window ticks out → `expired`.
 *
 * Invariants asserted per chain (F1–F6):
 *
 *   F1  terminal coherence: `final` carries a minted verdict whose verdictHash
 *       RECOMPUTES from (sessionHash, outcome, supportingEventIds);
 *       `aborted`/`expired` carry a failure record and NO minted verdict;
 *   F2  ledger provenance: the supporting ids are exactly the winning ledger
 *       the finality rule names (the confirmation ledger when never challenged
 *       and upheld; the last resolved round's winning votes otherwise) — sorted,
 *       non-empty, and drawn from THAT ledger;
 *   F3  `upheld === (outcome === proposedOutcome)`, and an overturned proposal
 *       flags every confirming juror (`overturned_confirmation`);
 *   F4  `outcomeHistory` is the consecutive 1..k append-only round sequence, and
 *       every flip-flop flags the previous round's majority (`round_flip`);
 *   F5  the escalation witness log records every escalation this chain played,
 *       in order, with consecutive rounds from 2, each record matching the
 *       witness it came from, and never exceeding the ladder cap;
 *   F6  FINALITY SHAPES: the verdict's batch attestation verifies under its own
 *       epoch/cohort pins, a wrong epoch pin and a tampered proof are refused,
 *       the case verifies through `verifyCaseInBatch`, and the terminal phase
 *       refuses any further event — including a perfect escalation witness.
 *
 * Unit of the corpus: one chain. Failure labels carry the chain index and kind.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';

import {
  CourtConfirmationTransitionError,
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  hostEscalationEvent,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../../courtConfirmationMachine';
import { hashCourtVerdict } from '../../courtVoteMachine';
import {
  buildBatchAttestationEvent,
  buildBatchMerkleProof,
  buildBatchMerkleTree,
  hashBatchManifest,
  validateBatchAttestationEvent,
  verifyCaseInBatch,
} from '../../batchAttestation';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, timingMetrics, type CampaignResult } from './corpus';

const OUTCOMES = ['YES', 'NO'] as const;
const TERMINAL = new Set(['final', 'expired', 'aborted']);
const CHAIN_KINDS = ['escalate-to-cap', 'concede-early', 'abort-window', 'expire-window'] as const;
type ChainKind = (typeof CHAIN_KINDS)[number];

/** Deterministic 32-byte hex id for (seed, label). */
function hexId(seed: number, label: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`BAO-Court/finality/${seed}/${label}`)));
}

/** Deterministic cohort keypair for (seed, chain): real Schnorr keys, no CSPRNG. */
function cohortKey(seed: number): { sec: Uint8Array; pub: string } {
  const sec = sha256(new TextEncoder().encode(`BAO-Court/finality-cohort/${seed}`));
  return { sec, pub: getPublicKey(sec) };
}

interface ChainResult {
  readonly kind: ChainKind;
  readonly state: CourtConfirmationMachineState;
  /** Escalations actually played, in order (the witnesses the host sent). */
  readonly escalations: readonly CourtConfirmationMachineEvent[];
  readonly roundsResolved: number;
  readonly sessionHash: string;
  readonly challengesFiled: number;
}

/**
 * Drive one full case lifecycle. Every transition goes through the reducer; the
 * chain never hand-builds a state.
 */
function driveChain(seed: number, kind: ChainKind, opts: {
  readonly rosterSize: number;
  readonly quorum: number;
  readonly maxLadderRounds: number;
  readonly challengers: number;
  readonly hostEscalation: boolean;
}): ChainResult {
  const sessionHash = hexId(seed, 'session');
  const proposalHash = hexId(seed, 'proposal');
  const roster = Array.from({ length: opts.rosterSize }, (_, i) => i + 1);
  const base = 1_700_000_000;
  const confirmDeadline = base + 1_000;
  const challengeDeadline = base + 2_000;
  let state = createCourtConfirmationMachine({
    sessionHash,
    proposalHash,
    proposedOutcome: 'YES',
    allowedOutcomes: [...OUTCOMES],
    participantIndices: roster,
    confirmQuorum: opts.quorum,
    confirmDeadline,
    challengeDeadline,
    maxLadderRounds: opts.maxLadderRounds,
    ...(opts.hostEscalation ? { hostEscalation: true } : {}),
  });
  const reduce = (event: CourtConfirmationMachineEvent): void => {
    state = reduceCourtConfirmationMachine(state, event);
  };

  roster.forEach((idx, offset) => {
    reduce({
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash, proposalHash, idx }),
      eventId: hexId(seed, `confirmation-${idx}`),
      now: base + 1 + offset,
    });
  });
  reduce({ type: 'close_confirmations', now: confirmDeadline });
  reduce({ type: 'open_challenge_window', now: confirmDeadline + 10 });

  if (kind === 'abort-window') {
    reduce({ type: 'abort', reason: 'host-abort-during-window' });
    return { kind, state, escalations: [], roundsResolved: 0, sessionHash, challengesFiled: 0 };
  }

  let challengesFiled = 0;
  for (let c = 0; c < opts.challengers; c += 1) {
    const idx = roster[c % roster.length]!;
    reduce({
      type: 'accept_challenge',
      idx,
      bondTxid: hexId(seed, `bond-txid-${c}`),
      bondProofHash: hexId(seed, `bond-proof-${c}`),
      eventId: hexId(seed, `challenge-${c}`),
      now: confirmDeadline + 100 + c,
    });
    challengesFiled += 1;
  }

  if (kind === 'expire-window') {
    reduce({ type: 'tick', now: challengeDeadline });
    return { kind, state, escalations: [], roundsResolved: 0, sessionHash, challengesFiled };
  }

  reduce({ type: 'close_challenge_window', now: challengeDeadline });

  const escalations: CourtConfirmationMachineEvent[] = [];
  let clock = challengeDeadline + 100;
  let round = 1;
  let roundsResolved = 0;
  const lastRound = kind === 'concede-early' ? 1 : opts.maxLadderRounds;
  for (;;) {
    const voteDeadline = clock + 1_000;
    reduce({ type: 'open_ladder_round', round, voteDeadline, now: clock });
    // Alternating majorities so consecutive rounds flip when the ladder is
    // longer than two rounds (the flip-flop clawback path).
    const winner = round % 2 === 1 ? 'NO' : 'YES';
    roster.forEach((idx, offset) => {
      reduce({
        type: 'accept_mass_vote',
        idx,
        outcome: winner,
        eventId: hexId(seed, `vote-${round}-${idx}`),
        now: clock + 1 + offset,
      });
    });
    reduce({ type: 'close_ladder_round', now: voteDeadline });
    reduce({ type: 'resolve_round', now: voteDeadline + 1 });
    roundsResolved += 1;
    clock = voteDeadline + 2;

    if (kind === 'concede-early' || round >= lastRound) break;
    const escalation = opts.hostEscalation && round % 2 === 0
      ? hostEscalationEvent(state, clock)
      : challengerEscalationEvent(state, clock, {
        challengerPubkey: hexId(seed, `escalation-pubkey-${round}`),
        requestHash: hexId(seed, `escalation-request-${round}`),
      });
    reduce(escalation);
    escalations.push(escalation);
    clock += 1;
    round += 1;
  }

  if (kind === 'concede-early') {
    reduce({ type: 'concede', now: clock });
  }
  if (state.phase === 'fee_settlement') {
    reduce({ type: 'record_fee', feeEventId: hexId(seed, 'fee'), now: clock });
    reduce({ type: 'finalize', now: clock + 1 });
  }
  return { kind, state, escalations, roundsResolved, sessionHash, challengesFiled };
}

interface FinalityStats {
  chains: number;
  finalChains: number;
  abortedChains: number;
  expiredChains: number;
  escalations: number;
  hostEscalations: number;
  challengeWindows: number;
  multiRoundChains: number;
  verdictRecomputations: number;
  provenanceChecks: number;
  batchVerifications: number;
  epochPinRejections: number;
  tamperRejections: number;
  caseProofs: number;
  terminalWitnessRejections: number;
  overturns: number;
  flipFlops: number;
  perChainMs: number[];
}

/** The finality surface, applied to one finished chain. */
function checkFinality(
  reporter: CampaignReporter,
  label: string,
  chain: ChainResult,
  seed: number,
  stats: FinalityStats,
): void {
  const { state } = chain;

  // ── F5: the witness log records exactly the escalations this chain played. ──
  reporter.equals(label, state.escalationLog.length, chain.escalations.length, 'F5: one log record per escalation played');
  reporter.ok(
    label,
    state.escalationLog.length <= Math.min(state.maxLadderRounds, 5),
    'F5: escalationLog must never exceed the ladder cap',
  );
  chain.escalations.forEach((event, offset) => {
    const witness = event as unknown as Record<string, unknown>;
    const record = state.escalationLog[offset];
    if (record === undefined) {
      reporter.fail(label, `F5: escalation ${offset} has no log record`);
      return;
    }
    reporter.equals(label, record.round, offset + 2, 'F5: escalation rounds are consecutive from 2');
    reporter.equals(label, record.authority, witness.authority, 'F5: record authority = the witness played');
    reporter.equals(label, record.challengerPubkey, witness.challengerPubkey ?? null, 'F5: record pubkey = the witness played');
    reporter.equals(label, record.requestHash, witness.requestHash ?? null, 'F5: record request = the witness played');
    reporter.equals(label, record.bondProofHash, witness.bondProofHash ?? null, 'F5: record bond = the witness played');
    if (record.authority === 'host') stats.hostEscalations += 1;
  });
  stats.escalations += chain.escalations.length;
  if (chain.roundsResolved > 1) stats.multiRoundChains += 1;
  if (chain.challengesFiled > 0) stats.challengeWindows += 1;

  // ── F1: terminal coherence. ──
  reporter.ok(label, TERMINAL.has(state.phase), `F1: chain ended in a terminal phase (${state.phase})`);
  if (state.phase === 'aborted' || state.phase === 'expired') {
    reporter.ok(label, state.failure !== undefined, 'F1: aborted/expired carry a failure record');
    reporter.ok(label, state.verdict === undefined || state.verdict.verdictHash === '', 'F1: no minted verdict before final');
    if (state.phase === 'aborted') stats.abortedChains += 1; else stats.expiredChains += 1;
  }
  if (state.phase === 'final') {
    stats.finalChains += 1;
    const verdict = state.verdict;
    if (verdict === undefined) {
      reporter.fail(label, 'F1: final phase without a verdict');
      return;
    }
    const expectedHash = hashCourtVerdict({
      sessionHash: chain.sessionHash,
      outcome: verdict.outcome,
      supportingEventIds: verdict.supportingEventIds,
    });
    reporter.equals(label, verdict.verdictHash, expectedHash, 'F1: verdictHash must recompute from public inputs');
    stats.verdictRecomputations += 1;

    // ── F2: ledger provenance. ──
    const sorted = [...verdict.supportingEventIds].sort();
    reporter.equalStrings(label, [...verdict.supportingEventIds], sorted, 'F2: supporting ids are sorted');
    reporter.ok(label, verdict.supportingEventIds.length >= 1, 'F2: a verdict carries ≥ 1 supporting id');
    const neverChallenged = state.challenges.length === 0 && verdict.upheld;
    const source = neverChallenged
      ? state.confirmations.map((record) => record.eventId)
      : (state.ladder?.votes ?? []).filter((vote) => vote.outcome === verdict.outcome).map((vote) => vote.eventId);
    reporter.equalStrings(label, [...verdict.supportingEventIds], [...source].sort(), 'F2: supporting ids = the finality ledger');
    stats.provenanceChecks += 1;

    // ── F3: upheld flag + overturn clawbacks. ──
    reporter.equals(label, verdict.upheld, verdict.outcome === state.proposedOutcome, 'F3: upheld = (outcome === proposedOutcome)');
    if (!verdict.upheld) {
      stats.overturns += 1;
      for (const record of state.confirmations) {
        reporter.ok(
          label,
          state.clawbackFlags.some((flag) => flag.idx === record.idx && flag.reason === 'overturned_confirmation'),
          `F3: overturned proposal must flag confirming juror ${record.idx}`,
        );
      }
    }

    // ── F4: outcome history + flip-flop clawbacks. ──
    const history = state.outcomeHistory ?? [];
    history.forEach((record, offset) => {
      reporter.equals(label, record.round, offset + 1, 'F4: outcomeHistory rounds are consecutive 1..k');
      if (offset > 0 && history[offset - 1]!.outcome !== record.outcome) {
        stats.flipFlops += 1;
        for (const idx of history[offset - 1]!.winnerIndices) {
          reporter.ok(
            label,
            state.clawbackFlags.some((flag) => flag.idx === idx && flag.reason === 'round_flip' && flag.round === history[offset - 1]!.round),
            `F4: flip-flop must flag juror ${idx} of round ${history[offset - 1]!.round}`,
          );
        }
      }
    });
    reporter.equals(label, history[history.length - 1]?.outcome, verdict.outcome, 'F4: the last resolved round decides the verdict');

    // ── F6: batch finality shapes. ──
    const siblings = [hexId(seed, 'sibling-0'), hexId(seed, 'sibling-1')];
    const batchHashes = [verdict.verdictHash, ...siblings].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const tree = buildBatchMerkleTree(batchHashes);
    const { sec, pub } = cohortKey(seed);
    const epoch = 1 + Math.floor(seed % 7);
    const finalizedAtSec = 1_700_000_000 + (seed % 1_000);
    const manifest = hashBatchManifest({ epoch, cohortPubkey: pub, batchIndex: 0, count: batchHashes.length, root: tree.root, finalizedAtSec });
    const event: NostrEvent = buildBatchAttestationEvent({
      epoch,
      cohortPubkey: pub,
      batchIndex: 0,
      count: batchHashes.length,
      root: tree.root,
      finalizedAtSec,
      signature: bytesToHex(schnorr.sign(hexToBytes(manifest), sec)),
      createdAt: finalizedAtSec,
    });
    const own = validateBatchAttestationEvent(event, { expectedGroupPubkey: pub, expectedEpoch: epoch, expectedCohort: pub });
    reporter.ok(label, own.valid, `F6: the verdict's batch attestation must verify: ${own.reason ?? ''}`);
    if (own.valid) stats.batchVerifications += 1;
    const wrongEpoch = validateBatchAttestationEvent(event, { expectedGroupPubkey: pub, expectedEpoch: epoch + 1 });
    reporter.ok(label, !wrongEpoch.valid, 'F6: a wrong epoch pin must refuse the batch');
    if (!wrongEpoch.valid) stats.epochPinRejections += 1;

    // Case membership through the production verifier (index in SORTED order).
    const index = batchHashes.indexOf(verdict.verdictHash);
    const proof = buildBatchMerkleProof(tree.leaves, index);
    const caseCheck = verifyCaseInBatch(event, {
      sessionHash: chain.sessionHash,
      outcome: verdict.outcome,
      supportingEventIds: verdict.supportingEventIds,
      proof,
    }, { expectedGroupPubkey: pub, expectedEpoch: epoch });
    reporter.ok(label, caseCheck.valid, `F6: verifyCaseInBatch must accept the finalized verdict: ${caseCheck.reason ?? ''}`);
    if (caseCheck.valid) stats.caseProofs += 1;

    // Tampered proof: flip one sibling / truncate the path.
    const tamperedProof = { ...proof, path: proof.path.slice(1) };
    const tampered = verifyCaseInBatch(event, {
      sessionHash: chain.sessionHash,
      outcome: verdict.outcome,
      supportingEventIds: verdict.supportingEventIds,
      proof: tamperedProof,
    }, { expectedGroupPubkey: pub });
    reporter.ok(label, !tampered.valid, 'F6: a truncated proof path must be refused');
    if (!tampered.valid) stats.tamperRejections += 1;
    // Tampered verdict inputs: the same proof for a DIFFERENT outcome.
    const forged = verifyCaseInBatch(event, {
      sessionHash: chain.sessionHash,
      outcome: verdict.outcome === 'YES' ? 'NO' : 'YES',
      supportingEventIds: verdict.supportingEventIds,
      proof,
    }, { expectedGroupPubkey: pub });
    reporter.ok(label, !forged.valid, 'F6: forged verdict inputs must be refused');
    if (!forged.valid) stats.tamperRejections += 1;
  }

  // ── F6 (terminal immutability): a terminal refuses ANY further event, and a
  // PERFECT escalation witness in particular (the v0.12.0 guarantee). ──
  const perfectWitness = {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: state.challenges[0]?.idx ?? 1,
    challengerPubkey: hexId(seed, 'terminal-pubkey'),
    requestHash: hexId(seed, 'terminal-request'),
    bondProofHash: state.challenges[0]?.bondProofHash ?? hexId(seed, 'terminal-bond'),
    roundIndex: state.ladderRound + 1,
    now: state.latestTimestamp,
  };
  let witnessThrown: unknown;
  try {
    reduceCourtConfirmationMachine(state, perfectWitness as CourtConfirmationMachineEvent);
  } catch (err) {
    witnessThrown = err;
  }
  reporter.ok(
    label,
    witnessThrown instanceof CourtConfirmationTransitionError,
    'F6: a terminal phase must refuse a PERFECT escalation witness',
  );
  if (witnessThrown instanceof CourtConfirmationTransitionError) stats.terminalWitnessRejections += 1;
  // A tick at a terminal is an ACCEPTED clock-only no-op (the machine's
  // tick-exempt terminal rule), so the assertion is that nothing but the clock
  // ledger can move: same phase, same verdict, same ledgers.
  const ticked = reduceCourtConfirmationMachine(state, { type: 'tick', now: state.latestTimestamp + 1 });
  reporter.equals(label, ticked.phase, state.phase, 'F6: a terminal tick must not change the phase');
  reporter.equals(label, ticked.verdict?.verdictHash ?? '', state.verdict?.verdictHash ?? '', 'F6: a terminal tick must not touch the verdict');
  reporter.equals(label, ticked.escalationLog.length, state.escalationLog.length, 'F6: a terminal tick must not touch the witness log');
  reporter.equals(label, ticked.confirmations.length, state.confirmations.length, 'F6: a terminal tick must not touch the confirmation ledger');
  reporter.equals(label, ticked.clawbackFlags.length, state.clawbackFlags.length, 'F6: a terminal tick must not touch the clawback ledger');
}

/** Run one chain unit. */
function runChainUnit(reporter: CampaignReporter, unitSeed: number, stats: FinalityStats): void {
  const r = childRng(unitSeed, 'finality-chain');
  const kind = CHAIN_KINDS[(unitSeed - 1) % CHAIN_KINDS.length]!;
  const rosterSize = int(r, 3, 6);
  const quorum = int(r, 1, rosterSize);
  const maxLadderRounds = int(r, 2, 3);
  const challengers = int(r, 1, 2);
  const hostEscalation = r() < 0.35;
  const label = `chain#${unitSeed} [${kind}]`;
  const started = nowMs();

  let chain: ChainResult;
  try {
    chain = driveChain(unitSeed, kind, { rosterSize, quorum, maxLadderRounds, challengers, hostEscalation });
  } catch (err) {
    reporter.fail(label, `F0: a legal chain was refused by the reducer: ${describe(err)}`);
    return;
  }
  stats.chains += 1;
  checkFinality(reporter, label, chain, unitSeed, stats);
  stats.perChainMs.push(Math.round((nowMs() - started) * 1000) / 1000);
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Run the campaign: `size` finality chains, chain seed = base seed + index. */
export function runFinalityCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('finality', 'chains', opts.size, seed);
  const stats: FinalityStats = {
    chains: 0,
    finalChains: 0,
    abortedChains: 0,
    expiredChains: 0,
    escalations: 0,
    hostEscalations: 0,
    challengeWindows: 0,
    multiRoundChains: 0,
    verdictRecomputations: 0,
    provenanceChecks: 0,
    batchVerifications: 0,
    epochPinRejections: 0,
    tamperRejections: 0,
    caseProofs: 0,
    terminalWitnessRejections: 0,
    overturns: 0,
    flipFlops: 0,
    perChainMs: [],
  };

  for (let index = 1; index <= opts.size; index += 1) runChainUnit(reporter, seed + index, stats);

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      chains: stats.chains,
      finalChains: stats.finalChains,
      abortedChains: stats.abortedChains,
      expiredChains: stats.expiredChains,
      escalations: stats.escalations,
      hostEscalations: stats.hostEscalations,
      challengeWindows: stats.challengeWindows,
      multiRoundChains: stats.multiRoundChains,
      verdictRecomputations: stats.verdictRecomputations,
      provenanceChecks: stats.provenanceChecks,
      batchVerifications: stats.batchVerifications,
      epochPinRejections: stats.epochPinRejections,
      tamperRejections: stats.tamperRejections,
      caseProofs: stats.caseProofs,
      terminalWitnessRejections: stats.terminalWitnessRejections,
      overturns: stats.overturns,
      flipFlops: stats.flipFlops,
      ...timingMetrics(stats.perChainMs),
    },
    [
      `chain kinds: ${CHAIN_KINDS.join(', ')} (rotated by index)`,
      'every chain is driven end to end through the reducer: confirmations → challenge window → ladder rounds (escalations) → fee ledger → final',
      'finality shapes: verdict recomputation, ledger provenance, real Schnorr batch manifest, case membership proof, epoch-pin and tamper refusals',
      'terminal immutability: every terminal phase is asserted to refuse a PERFECT escalation witness and a tick',
    ],
  );
}
