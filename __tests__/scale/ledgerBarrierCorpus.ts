// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 11 — restored-snapshot LEDGER/BARRIER sweep (the v0.14 surface's
 * four restore-time barriers).
 *
 * A host persists a confirmation case as plain JSON and restores it on the next
 * boot. Restoring SKIPS every transition, so the machine's own guarantees are
 * not re-derived — the barriers are. Each corpus unit is one
 * `CourtConfirmationMachineState` put through ALL applicable barriers:
 *
 *   `assertValidConfirmationLedger`  (r38-1 / r40-1: the confirmation +
 *                                     challenge ledgers, canonical re-hash)
 *   `assertValidOutcomeHistory`      (F-3: consecutive rounds, ballot closure)
 *   `assertValidEscalationLog`       (r29-2 / r33-5 / r37-1: the witness log,
 *                                     completeness, bond consumption)
 *   `assertValidMassVoteLedger`      (r41-1: the deciding round's ballots)
 *
 * THE TWO DIRECTIONS, both asserted on every unit:
 *
 *   B1  NO FALSE REFUSAL — the state is a real reducer state (reached by
 *       driving the machine) and every applicable barrier ACCEPTS it. A barrier
 *       that refuses a restorable snapshot bricks a live case (round-37 finding
 *       r37-1 was exactly that), so this is the direction that protects users.
 *   B2  NO FALSE ACCEPT — the state is FORGED along a declared grid axis
 *       (phase × log shape × challenge-ledger shape × strict/host flags) and
 *       each barrier's verdict must equal an INDEPENDENT ORACLE written in this
 *       file from the invariant text, not from the product code.
 *
 * The accepted set therefore equals the legal set on the whole enumerated grid,
 * and the campaign reports both counts.
 *
 * Scope of the claim (stated so it cannot be read wider than it is). The
 * barriers are PER-LEDGER: they speak about the four ledgers, not about whether
 * a phase may legally hold them (that is the reducer's phase guard, exercised by
 * campaigns 1 and 9). `assertValidMassVoteLedger` is applicable only when the
 * restored snapshot carries a ladder — the product calls it only for a
 * challenged case, and this campaign mirrors that applicability rather than
 * inventing a stricter contract.
 *
 * Unit of the corpus: one restored state (one reachable + one forged state per
 * unit). A failure label carries the unit seed and the grid cell, so the exact
 * snapshot is reproducible from the artifact.
 */

import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  hostEscalationEvent,
  challengerEscalationEvent,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationPhase,
  type CourtConfirmationMachineState,
} from '../../courtConfirmationMachine';
import {
  MAX_LADDER_ROUNDS,
  assertValidConfirmationLedger,
  assertValidEscalationLog,
  assertValidMassVoteLedger,
  assertValidOutcomeHistory,
} from '../../confirmationMachineCore';
import { MAX_CEREMONY_PARTICIPANTS } from '../../courtCeremonyCore';
import { HEX_32, isRecord } from '../../courtEventParseCore';
import { CampaignReporter, nowMs, timingMetrics, type CampaignResult } from './corpus';

const SESSION = '2b'.repeat(32);
const PROPOSAL = '4d'.repeat(32);
const OUTCOMES = ['YES', 'NO'] as const;
const BASE_CLOCK = 1_800_000_000;
const ROSTER_SIZE = 5;

/**
 * A deterministic 32-byte lowercase-hex id from a label (no CSPRNG — campaign
 * rule). Eight chained FNV-1a folds fill all 64 hex digits.
 */
function id(seed: number, label: string): string {
  const text = `${seed}:${label}`;
  let out = '';
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let word = 0; word < 8; word += 1) {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ Math.imul(word + 1, 0x9e3779b9)) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The independent ORACLE: what each barrier MUST decide, from the invariant
// text, in the same per-ledger terms the barriers use.
// ─────────────────────────────────────────────────────────────────────────────

/** Roster membership test that mirrors `assertRosterMember`. */
function inRoster(roster: readonly number[] | undefined, idx: unknown): boolean {
  return Array.isArray(roster) && (roster as readonly unknown[]).includes(idx);
}

function isHex32(value: unknown): boolean {
  return typeof value === 'string' && HEX_32.test(value);
}

/** `assertValidConfirmationLedger`'s rules, independently. */
export function oracleConfirmationLedger(state: CourtConfirmationMachineState): string | null {
  const confirmations: unknown = state.confirmations;
  if (!Array.isArray(confirmations)) return 'confirmations is not an array';
  const seenIdx = new Set<unknown>();
  const seenEvent = new Set<unknown>();
  for (const record of confirmations) {
    if (!isRecord(record)) return 'confirmation record is malformed';
    if (!inRoster(state.participantIndices, record.idx)) return 'confirmation idx off-roster';
    if (typeof record.confirmHash !== 'string' || !isHex32(record.eventId)) {
      return 'confirmation record is malformed';
    }
    if (record.confirmHash !== hashCourtConfirmation({
      sessionHash: state.sessionHash,
      proposalHash: state.proposalHash,
      idx: record.idx as number,
    })) {
      return 'confirmation hash does not re-derive';
    }
    if (seenIdx.has(record.idx)) return 'duplicate confirmation idx';
    if (seenEvent.has(record.eventId)) return 'duplicate confirmation event id';
    seenIdx.add(record.idx);
    seenEvent.add(record.eventId);
  }
  const challenges: unknown = state.challenges;
  if (!Array.isArray(challenges)) return 'challenges is not an array';
  const seenChallengeIdx = new Set<unknown>();
  const seenChallengeEvent = new Set<unknown>();
  const bondOwners = new Map<string, unknown>();
  for (const record of challenges) {
    if (!isRecord(record)) return 'challenge record is malformed';
    if (!inRoster(state.participantIndices, record.idx)) return 'challenge idx off-roster';
    if (!isHex32(record.bondTxid) || !isHex32(record.bondProofHash) || !isHex32(record.eventId)) {
      return 'challenge record ids are malformed';
    }
    if (seenChallengeIdx.has(record.idx)) return 'duplicate challenge idx';
    if (seenChallengeEvent.has(record.eventId)) return 'duplicate challenge event id';
    if (bondOwners.has(record.bondProofHash as string)) return 'one bond hash, two owners';
    bondOwners.set(record.bondProofHash as string, record.idx);
    seenChallengeIdx.add(record.idx);
    seenChallengeEvent.add(record.eventId);
  }
  return null;
}

/** `assertValidOutcomeHistory`'s rules, independently. */
export function oracleOutcomeHistory(state: CourtConfirmationMachineState): string | null {
  const history: unknown = state.outcomeHistory;
  if (!Array.isArray(history)) return 'outcome history is not an array';
  if (history.length > 0 && (!Array.isArray(state.challenges) || state.challenges.length === 0)) {
    return 'history records exist for an unchallenged case';
  }
  for (let offset = 0; offset < history.length; offset += 1) {
    const record: unknown = history[offset];
    if (!isRecord(record)) return 'history record is malformed';
    if (!Number.isSafeInteger(record.round) || record.round !== offset + 1) {
      return 'history rounds are not a consecutive 1..k sequence';
    }
    if (typeof record.outcome !== 'string' || !state.allowedOutcomes.includes(record.outcome)) {
      return 'history outcome outside the ballot';
    }
    const winnerEventIds: unknown = record.winnerEventIds;
    if (!Array.isArray(winnerEventIds) || winnerEventIds.length === 0) return 'history has no winners';
    const seenEvent = new Set<unknown>();
    for (const eventId of winnerEventIds) {
      if (!isHex32(eventId)) return 'history winner event id malformed';
      if (seenEvent.has(eventId)) return 'duplicate history winner event id';
      seenEvent.add(eventId);
    }
    const winnerIndices: unknown = record.winnerIndices;
    if (!Array.isArray(winnerIndices) || winnerIndices.length === 0) return 'history has no winner indices';
    const seenWinner = new Set<unknown>();
    for (const idx of winnerIndices) {
      if (
        typeof idx !== 'number'
        || !Number.isSafeInteger(idx)
        || idx < 1
        || idx > MAX_CEREMONY_PARTICIPANTS
      ) {
        return 'history winner index outside the participant bound';
      }
      if (seenWinner.has(idx)) return 'duplicate history winner index';
      seenWinner.add(idx);
    }
  }
  return null;
}

/** `assertValidEscalationLog`'s rules, independently. */
export function oracleEscalationLog(state: CourtConfirmationMachineState): string | null {
  const log: unknown = state.escalationLog;
  if (!Array.isArray(log)) return 'escalation log is not an array';
  if (log.length > MAX_LADDER_ROUNDS) return 'escalation log exceeds the ladder bound';
  const expected = Math.max(
    0,
    state.phase === 'ladder_pending' ? state.ladderRound : state.ladderRound - 1,
  );
  if (log.length !== expected && (log.length > 0 || state.requireRoundBond === true)) {
    return 'escalation log is incomplete';
  }
  const challenges: unknown = state.challenges;
  const challengeList = Array.isArray(challenges) ? challenges : [];
  let previousAt = Number.NEGATIVE_INFINITY;
  const seenRoundBonds = new Set<string>();
  for (let offset = 0; offset < log.length; offset += 1) {
    const record: unknown = log[offset];
    if (!isRecord(record)) return 'escalation record is malformed';
    if (!Number.isSafeInteger(record.round) || record.round !== offset + 2) {
      return 'escalation rounds are not a consecutive 2..k sequence';
    }
    const openedRounds = state.phase === 'ladder_pending' ? state.ladderRound + 1 : state.ladderRound;
    if ((record.round as number) > openedRounds) return 'escalation names a round never opened';
    if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at < previousAt) {
      return 'escalation timestamps are not non-decreasing';
    }
    previousAt = record.at;
    const roundBond: unknown = record.roundBondProofHash ?? null;
    if (record.authority === 'challenger') {
      if (!inRoster(state.participantIndices, record.challengerIdx)) return 'challenger off-roster';
      if (!isHex32(record.challengerPubkey) || !isHex32(record.requestHash)
        || !isHex32(record.bondProofHash)) {
        return 'challenger witness ids are malformed';
      }
      const bound = challengeList.some((candidate) => isRecord(candidate)
        && candidate.idx === record.challengerIdx
        && candidate.bondProofHash === record.bondProofHash);
      if (!bound) return 'challenger is not bound to its accepted bond';
      if (roundBond !== null) {
        if (!isHex32(roundBond)) return 'round bond is malformed';
        if (roundBond === record.bondProofHash) return 'round bond relabels the membership bond';
        if (challengeList.some((candidate) => isRecord(candidate)
          && candidate.bondProofHash === roundBond)) {
          return 'round bond is a membership bond of this case';
        }
        if (seenRoundBonds.has(roundBond as string)) return 'round bond reused across rounds';
        seenRoundBonds.add(roundBond as string);
      } else if (state.requireRoundBond === true && state.hostEscalation !== true) {
        return 'strict case records a challenger escalation without a round bond';
      }
    } else if (record.authority === 'host') {
      if (state.hostEscalation !== true) return 'host escalation under a policy that forbids it';
      if (
        record.challengerIdx !== null
        || record.challengerPubkey !== null
        || record.requestHash !== null
        || record.bondProofHash !== null
        || roundBond !== null
      ) {
        return 'host record carries a challenger witness';
      }
    } else {
      return 'unknown escalation authority';
    }
  }
  return null;
}

/** `assertValidMassVoteLedger`'s rules, independently (ladder states only). */
export function oracleMassVoteLedger(state: CourtConfirmationMachineState): string | null {
  const ladder = state.ladder;
  if (ladder === undefined) return null; // not applicable — the product skips it too
  if (!isRecord(ladder) || !Array.isArray(ladder.votes)) return 'ladder state is malformed';
  const roundRoster = ladder.roundRoster ?? state.participantIndices;
  if (ladder.roundRoster !== undefined) {
    if (!Array.isArray(ladder.roundRoster) || ladder.roundRoster.length < 3
      || ladder.roundRoster.length > MAX_CEREMONY_PARTICIPANTS) {
      return 'round roster is malformed';
    }
    const sequential = ladder.roundRoster.every((idx, offset) => idx === offset + 1);
    if (!sequential) return 'round roster is not sequential';
  }
  const seenIdx = new Set<unknown>();
  const seenEvent = new Set<unknown>();
  for (const vote of ladder.votes) {
    if (!isRecord(vote)) return 'mass vote is malformed';
    if (!inRoster(roundRoster, vote.idx)) return 'mass vote off the round panel';
    if (typeof vote.outcome !== 'string' || !state.allowedOutcomes.includes(vote.outcome)) {
      return 'mass vote outside the ballot';
    }
    if (!isHex32(vote.eventId)) return 'mass vote event id malformed';
    if (seenIdx.has(vote.idx)) return 'duplicate mass vote idx';
    if (seenEvent.has(vote.eventId)) return 'duplicate mass vote event id';
    seenIdx.add(vote.idx);
    seenEvent.add(vote.eventId);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK: real reducer states, captured per phase by driving the machine.
// ─────────────────────────────────────────────────────────────────────────────

interface Stock {
  readonly byPhase: Map<CourtConfirmationPhase, CourtConfirmationMachineState[]>;
  readonly total: number;
}

function record(
  byPhase: Map<CourtConfirmationPhase, CourtConfirmationMachineState[]>,
  state: CourtConfirmationMachineState,
): CourtConfirmationMachineState {
  const bucket = byPhase.get(state.phase) ?? [];
  bucket.push(state);
  byPhase.set(state.phase, bucket);
  return state;
}

/** Drive one case along a path, recording EVERY state it passes through. */
function drivePath(
  byPhase: Map<CourtConfirmationPhase, CourtConfirmationMachineState[]>,
  opts: {
    readonly seed: number;
    readonly maxLadderRounds: number;
    readonly escalations: number;
    readonly hostEscalation: boolean;
    readonly requireRoundBond: boolean;
    readonly challenged: boolean;
    readonly expire: boolean;
    readonly abort: boolean;
  },
): void {
  const roster = Array.from({ length: ROSTER_SIZE }, (_, i) => i + 1);
  const confirmDeadline = BASE_CLOCK + 1_000;
  const challengeDeadline = BASE_CLOCK + 2_000;
  let state = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: [...OUTCOMES],
    participantIndices: roster,
    confirmQuorum: 1,
    confirmDeadline,
    challengeDeadline,
    maxLadderRounds: opts.maxLadderRounds,
    ...(opts.hostEscalation ? { hostEscalation: true } : {}),
    ...(opts.requireRoundBond ? { requireRoundBond: true } : {}),
  });
  record(byPhase, state);
  const reduce = (event: CourtConfirmationMachineEvent): void => {
    state = reduceCourtConfirmationMachine(state, event);
    record(byPhase, state);
  };

  if (opts.abort) {
    reduce({ type: 'abort', reason: 'campaign abort path' });
    return;
  }

  roster.forEach((idx, offset) => {
    reduce({
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: id(opts.seed, `conf-${idx}`),
      now: BASE_CLOCK + 1 + offset,
    });
  });
  reduce({ type: 'close_confirmations', now: confirmDeadline });
  if (opts.expire) {
    reduce({ type: 'tick', now: challengeDeadline });
    return;
  }
  reduce({ type: 'open_challenge_window', now: confirmDeadline + 10 });
  if (opts.challenged) {
    for (let c = 0; c < 2; c += 1) {
      reduce({
        type: 'accept_challenge',
        idx: roster[c]!,
        bondTxid: id(opts.seed, `bond-txid-${c}`),
        bondProofHash: id(opts.seed, `bond-proof-${c}`),
        eventId: id(opts.seed, `challenge-${c}`),
        now: confirmDeadline + 100 + c,
      });
    }
  }
  reduce({ type: 'close_challenge_window', now: challengeDeadline });

  let clock = challengeDeadline + 100;
  for (let round = 1; round <= opts.maxLadderRounds; round += 1) {
    if (!opts.challenged) break;
    const voteDeadline = clock + 1_000;
    reduce({ type: 'open_ladder_round', round, voteDeadline, now: clock });
    roster.forEach((idx, offset) => {
      reduce({
        type: 'accept_mass_vote',
        idx,
        outcome: 'NO',
        eventId: id(opts.seed, `vote-${round}-${idx}`),
        now: clock + 1 + offset,
      });
    });
    reduce({ type: 'close_ladder_round', now: voteDeadline });
    reduce({ type: 'resolve_round', now: voteDeadline + 1 });
    clock = voteDeadline + 2;
    if (round > opts.escalations || round >= opts.maxLadderRounds) break;
    reduce(
      opts.hostEscalation
        ? hostEscalationEvent(state, clock)
        : challengerEscalationEvent(state, clock, {
          challengerIdx: roster[0]!,
          challengerPubkey: id(opts.seed, 'esc-pk'),
          requestHash: id(opts.seed, `esc-req-${round}`),
          ...(opts.requireRoundBond ? { roundBondProofHash: id(opts.seed, `round-bond-${round}`) } : {}),
        }),
    );
    clock += 1;
  }
  if (state.phase === 'fee_settlement') {
    reduce({ type: 'record_fee', feeEventId: id(opts.seed, 'fee'), now: clock + 1 });
    reduce({ type: 'finalize', now: clock + 2 });
  }
}

function buildStock(): Stock {
  const byPhase = new Map<CourtConfirmationPhase, CourtConfirmationMachineState[]>();
  let seed = 700_000;
  for (const maxLadderRounds of [2, 3]) {
    for (const escalations of [0, 1, 2]) {
      for (const hostEscalation of [false, true]) {
        for (const requireRoundBond of [false, true]) {
          if (hostEscalation && requireRoundBond && escalations === 0) continue;
          seed += 1;
          drivePath(byPhase, {
            seed,
            maxLadderRounds,
            escalations: Math.min(escalations, maxLadderRounds - 1),
            hostEscalation,
            requireRoundBond,
            challenged: true,
            expire: false,
            abort: false,
          });
        }
      }
    }
  }
  // The unchallenged path (confirmation ledger → fee_settlement → final) and the
  // two terminal-failure paths.
  drivePath(byPhase, {
    seed: 700_901,
    maxLadderRounds: 2,
    escalations: 0,
    hostEscalation: false,
    requireRoundBond: false,
    challenged: false,
    expire: false,
    abort: false,
  });
  drivePath(byPhase, {
    seed: 700_902,
    maxLadderRounds: 2,
    escalations: 0,
    hostEscalation: false,
    requireRoundBond: false,
    challenged: false,
    expire: true,
    abort: false,
  });
  drivePath(byPhase, {
    seed: 700_903,
    maxLadderRounds: 2,
    escalations: 0,
    hostEscalation: false,
    requireRoundBond: false,
    challenged: false,
    expire: false,
    abort: true,
  });
  let total = 0;
  for (const bucket of byPhase.values()) total += bucket.length;
  return { byPhase, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GRID: phase × log shape × challenge-ledger shape × strict/host flags.
// ─────────────────────────────────────────────────────────────────────────────

const PHASES: readonly CourtConfirmationPhase[] = [
  'confirm_open',
  'confirm_closed',
  'challenge_window',
  'ladder_pending',
  'ladder_vote_open',
  'ladder_vote_closed',
  'round_resolved',
  'fee_settlement',
  'final',
  'expired',
  'aborted',
];

const LOG_SHAPES = [
  'as-driven',
  'emptied',
  'short-one',
  'gap',
  'round-shifted',
  'round-reordered',
  'roundbond-reused',
  'roundbond-membership',
  'roundbond-null',
  'clock-regressed',
  'authority-bogus',
  'authority-host',
  'authority-host-with-witness',
  'challenger-off-roster',
  'challenger-foreign-bond',
  'extra-record',
  'overflow',
] as const;

const CHALLENGE_SHAPES = [
  'as-driven',
  'emptied',
  'dup-bond-owner',
  'dup-idx',
  'dup-event-id',
  'bad-txid-case',
  'off-roster',
  'extra-unbacked',
] as const;

type LogShape = (typeof LOG_SHAPES)[number];
type ChallengeShape = (typeof CHALLENGE_SHAPES)[number];

interface GridCell {
  readonly phase: CourtConfirmationPhase;
  readonly logShape: LogShape;
  readonly challengeShape: ChallengeShape;
  readonly requireRoundBond: boolean;
  readonly hostEscalation: boolean;
}

function buildCells(): GridCell[] {
  // PHASE varies fastest so that consecutive units walk all eleven phases: a
  // corpus slice of any size then covers every phase, instead of exhausting the
  // pre-ladder phases first (they have empty ledgers, so their mutations are
  // no-ops and would report a falsely rosy legality rate).
  const cells: GridCell[] = [];
  for (const logShape of LOG_SHAPES) {
    for (const challengeShape of CHALLENGE_SHAPES) {
      for (const requireRoundBond of [false, true]) {
        for (const hostEscalation of [false, true]) {
          for (const phase of PHASES) {
            cells.push({ phase, logShape, challengeShape, requireRoundBond, hostEscalation });
          }
        }
      }
    }
  }
  return cells;
}

export const GRID_CELLS = buildCells();

type MutableState = Record<string, unknown>;

function forgeChallenges(
  state: CourtConfirmationMachineState,
  shape: ChallengeShape,
  seed: number,
): unknown[] {
  const base = (Array.isArray(state.challenges) ? state.challenges : [])
    .map((record) => ({ ...record })) as MutableState[];
  switch (shape) {
    case 'as-driven':
      return base;
    case 'emptied':
      return [];
    case 'dup-bond-owner':
      if (base.length >= 2) base[1]!.bondProofHash = base[0]!.bondProofHash;
      return base;
    case 'dup-idx':
      if (base.length >= 2) base[1]!.idx = base[0]!.idx;
      return base;
    case 'dup-event-id':
      if (base.length >= 2) base[1]!.eventId = base[0]!.eventId;
      return base;
    case 'bad-txid-case':
      if (base.length >= 1) base[0]!.bondTxid = id(seed, 'uppercase-txid').toUpperCase();
      return base;
    case 'off-roster':
      if (base.length >= 1) base[0]!.idx = ROSTER_SIZE + 7;
      return base;
    case 'extra-unbacked':
      base.push({
        idx: ROSTER_SIZE,
        bondTxid: id(seed, 'unbacked-txid'),
        bondProofHash: id(seed, 'unbacked-bond'),
        eventId: id(seed, 'unbacked-event'),
      });
      return base;
    default:
      return base;
  }
}

function forgeLog(
  state: CourtConfirmationMachineState,
  challenges: readonly unknown[],
  shape: LogShape,
  seed: number,
): unknown[] {
  const base = (Array.isArray(state.escalationLog) ? state.escalationLog : [])
    .map((record) => ({ ...record })) as MutableState[];
  const membershipBond = isRecord(challenges[0]) ? challenges[0].bondProofHash : undefined;
  switch (shape) {
    case 'as-driven':
      return base;
    case 'emptied':
      return [];
    case 'short-one':
      if (base.length > 0) base.pop();
      return base;
    case 'gap':
      if (base.length > 1) base.splice(1, 1);
      return base;
    case 'round-shifted':
      if (base.length > 0) base[0]!.round = (base[0]!.round as number) + 1;
      return base;
    case 'round-reordered':
      if (base.length > 1) {
        const first = base[0]!;
        base[0] = base[1]!;
        base[1] = first;
      }
      return base;
    case 'roundbond-reused':
      if (base.length >= 2) {
        base[1]!.roundBondProofHash = base[0]!.roundBondProofHash ?? id(seed, 'reused-round-bond');
      } else if (base.length === 1) {
        base[0]!.roundBondProofHash = id(seed, 'solo-round-bond');
      }
      return base;
    case 'roundbond-membership':
      if (base.length > 0 && typeof membershipBond === 'string') {
        base[0]!.roundBondProofHash = membershipBond;
      }
      return base;
    case 'roundbond-null':
      if (base.length > 0) base[0]!.roundBondProofHash = null;
      return base;
    case 'clock-regressed':
      if (base.length >= 2) {
        base[1]!.at = (base[0]!.at as number) - 1;
      } else if (base.length === 1) {
        base[0]!.at = Number.NaN;
      }
      return base;
    case 'authority-bogus':
      if (base.length > 0) base[0]!.authority = 'warden';
      return base;
    case 'authority-host':
      if (base.length > 0) {
        base[0]!.authority = 'host';
        base[0]!.challengerIdx = null;
        base[0]!.challengerPubkey = null;
        base[0]!.requestHash = null;
        base[0]!.bondProofHash = null;
        base[0]!.roundBondProofHash = null;
      }
      return base;
    case 'authority-host-with-witness':
      if (base.length > 0) base[0]!.authority = 'host';
      return base;
    case 'challenger-off-roster':
      if (base.length > 0) base[0]!.challengerIdx = ROSTER_SIZE + 9;
      return base;
    case 'challenger-foreign-bond':
      if (base.length > 0) base[0]!.bondProofHash = id(seed, 'foreign-bond');
      return base;
    case 'extra-record': {
      const template = base[base.length - 1] ?? {
        authority: 'challenger',
        challengerIdx: 1,
        challengerPubkey: id(seed, 'extra-pk'),
        requestHash: id(seed, 'extra-request'),
        bondProofHash: id(seed, 'extra-bond'),
        roundBondProofHash: id(seed, 'extra-round-bond'),
        at: 0,
      };
      base.push({ ...template, round: base.length + 2 });
      return base;
    }
    case 'overflow': {
      const template = base[base.length - 1] ?? {
        authority: 'host',
        challengerIdx: null,
        challengerPubkey: null,
        requestHash: null,
        bondProofHash: null,
        roundBondProofHash: null,
        at: 0,
      };
      while (base.length <= MAX_LADDER_ROUNDS) {
        base.push({ ...template, round: base.length + 2 });
      }
      return base;
    }
    default:
      return base;
  }
}

/** Apply one grid cell to a reachable state (never mutating the stock). */
function forge(
  base: CourtConfirmationMachineState,
  cell: GridCell,
  seed: number,
): CourtConfirmationMachineState {
  const challenges = forgeChallenges(base, cell.challengeShape, seed);
  const escalationLog = forgeLog(base, challenges, cell.logShape, seed);
  return {
    ...base,
    requireRoundBond: cell.requireRoundBond,
    hostEscalation: cell.hostEscalation,
    challenges,
    escalationLog,
  } as unknown as CourtConfirmationMachineState;
}

// ─────────────────────────────────────────────────────────────────────────────
// BARRIERS
// ─────────────────────────────────────────────────────────────────────────────

interface Barrier {
  readonly name: string;
  readonly run: (state: CourtConfirmationMachineState) => void;
  /** Mirrors the product's applicability (the mass-vote barrier needs a ladder). */
  readonly applies: (state: CourtConfirmationMachineState) => boolean;
  /** The independent oracle for this barrier: `null` = legal. */
  readonly oracle: (state: CourtConfirmationMachineState) => string | null;
}

export const BARRIERS: readonly Barrier[] = [
  {
    name: 'confirmationLedger',
    run: assertValidConfirmationLedger,
    applies: () => true,
    oracle: oracleConfirmationLedger,
  },
  {
    name: 'outcomeHistory',
    run: assertValidOutcomeHistory,
    applies: () => true,
    oracle: oracleOutcomeHistory,
  },
  {
    name: 'escalationLog',
    run: assertValidEscalationLog,
    applies: () => true,
    oracle: oracleEscalationLog,
  },
  {
    name: 'massVoteLedger',
    run: assertValidMassVoteLedger,
    applies: (state) => state.ladder !== undefined,
    oracle: oracleMassVoteLedger,
  },
];

interface BarrierVerdict {
  readonly accepted: boolean;
  readonly error: unknown;
}

function applyBarrier(barrier: Barrier, state: CourtConfirmationMachineState): BarrierVerdict {
  try {
    barrier.run(state);
    return { accepted: true, error: null };
  } catch (error) {
    return { accepted: false, error };
  }
}

interface BarrieredStats {
  reachableStates: number;
  reachableBarrierRuns: number;
  reachableAccepted: number;
  reachableRefused: number;
  forgedStates: number;
  forgedBarrierRuns: number;
  forgedAccepted: number;
  forgedRefused: number;
  oracleLegalRuns: number;
  oracleIllegalRuns: number;
  agreements: number;
  disagreements: number;
  untypedRefusals: number;
  cellsVisited: Set<number>;
  perBarrier: Record<string, number>;
  perUnitMs: number[];
}

/**
 * Run one unit: a REACHABLE state (must be accepted) and a FORGED state (must
 * match the independent oracle, barrier by barrier).
 */
function runBarrierUnit(
  reporter: CampaignReporter,
  stock: Stock,
  cellIndex: number,
  unitSeed: number,
  stats: BarrieredStats,
): void {
  const cell = GRID_CELLS[cellIndex]!;
  const stocks = stock.byPhase.get(cell.phase);
  const label = `ledgerBarrier#${unitSeed} [${cell.phase}/${cell.logShape}/${cell.challengeShape}/`
    + `${cell.requireRoundBond ? 'strict' : 'legacy'}/${cell.hostEscalation ? 'host' : 'default'}]`;
  if (stocks === undefined || stocks.length === 0) {
    reporter.fail(label, 'SETUP: no reachable state was captured for this phase');
    return;
  }
  const started = nowMs();
  const base = stocks[Math.floor(unitSeed / GRID_CELLS.length) % stocks.length]!;
  stats.cellsVisited.add(cellIndex);

  // ── B1: no false refusal on a REAL reducer state ──────────────────────────
  stats.reachableStates += 1;
  for (const barrier of BARRIERS) {
    if (!barrier.applies(base)) continue;
    const verdict = applyBarrier(barrier, base);
    stats.reachableBarrierRuns += 1;
    if (verdict.accepted) {
      stats.reachableAccepted += 1;
      reporter.check();
      continue;
    }
    stats.reachableRefused += 1;
    if (!(verdict.error instanceof CourtConfirmationTransitionError)) {
      stats.untypedRefusals += 1;
    }
    reporter.fail(
      label,
      `B1: barrier '${barrier.name}' REFUSED a reducer-reachable ${base.phase} state — a host that `
      + `restores this snapshot bricks its case: ${describe(verdict.error)}`,
    );
  }

  // ── B2: the forged state must match the independent oracle ────────────────
  const forged = forge(base, cell, unitSeed);
  stats.forgedStates += 1;
  for (const barrier of BARRIERS) {
    if (!barrier.applies(forged)) continue;
    const verdict = applyBarrier(barrier, forged);
    stats.forgedBarrierRuns += 1;
    const reason = barrier.oracle(forged);
    const expected = reason === null;
    if (expected) stats.oracleLegalRuns += 1;
    else stats.oracleIllegalRuns += 1;
    stats.perBarrier[barrier.name] = (stats.perBarrier[barrier.name] ?? 0) + 1;
    if (verdict.accepted) stats.forgedAccepted += 1;
    else {
      stats.forgedRefused += 1;
      if (!(verdict.error instanceof CourtConfirmationTransitionError)) {
        stats.untypedRefusals += 1;
        reporter.fail(
          label,
          `B2: barrier '${barrier.name}' refused with an UNTYPED error: ${describe(verdict.error)}`,
        );
        continue;
      }
    }
    if (verdict.accepted === expected) {
      stats.agreements += 1;
      reporter.check();
      continue;
    }
    stats.disagreements += 1;
    reporter.fail(
      label,
      `B2: barrier '${barrier.name}' said ${verdict.accepted ? 'ACCEPT' : 'REFUSE'} but the oracle says `
      + `${expected ? 'LEGAL' : `ILLEGAL (${String(reason)})`}`,
    );
  }
  stats.perUnitMs.push(round3(nowMs() - started));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Run the campaign: `size` restored-state units. The unit seed is `seed +
 * index`, and the grid cell is `(index - 1) % GRID_CELLS.length`, so a failure
 * label reproduces the exact snapshot from the artifact.
 */
export function runLedgerBarrierCampaign(opts: {
  readonly size: number;
  readonly seed?: number;
}): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('ledgerBarrier', 'states', opts.size, seed);
  const stock = buildStock();
  const missing = PHASES.filter((phase) => (stock.byPhase.get(phase)?.length ?? 0) === 0);
  for (const phase of missing) {
    reporter.fail(`stock:${phase}`, `SETUP: no reachable state captured for phase ${phase}`);
  }
  const stats: BarrieredStats = {
    reachableStates: 0,
    reachableBarrierRuns: 0,
    reachableAccepted: 0,
    reachableRefused: 0,
    forgedStates: 0,
    forgedBarrierRuns: 0,
    forgedAccepted: 0,
    forgedRefused: 0,
    oracleLegalRuns: 0,
    oracleIllegalRuns: 0,
    agreements: 0,
    disagreements: 0,
    untypedRefusals: 0,
    cellsVisited: new Set<number>(),
    perBarrier: {},
    perUnitMs: [],
  };

  for (let index = 1; index <= opts.size; index += 1) {
    runBarrierUnit(reporter, stock, (index - 1) % GRID_CELLS.length, seed + index, stats);
  }

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      reachableStates: stats.reachableStates,
      reachableBarrierRuns: stats.reachableBarrierRuns,
      reachableAccepted: stats.reachableAccepted,
      reachableRefused: stats.reachableRefused,
      forgedStates: stats.forgedStates,
      forgedBarrierRuns: stats.forgedBarrierRuns,
      forgedAccepted: stats.forgedAccepted,
      forgedRefused: stats.forgedRefused,
      oracleLegalRuns: stats.oracleLegalRuns,
      oracleIllegalRuns: stats.oracleIllegalRuns,
      barrierAgreements: stats.agreements,
      barrierDisagreements: stats.disagreements,
      untypedRefusals: stats.untypedRefusals,
      gridCells: GRID_CELLS.length,
      cellsVisited: stats.cellsVisited.size,
      stockStates: stock.total,
      stockPhases: stock.byPhase.size,
      ...Object.fromEntries(Object.entries(stats.perBarrier).map(([name, runs]) => [`barrier_${name}`, runs])),
      ...timingMetrics(stats.perUnitMs),
    },
    [
      `grid: ${GRID_CELLS.length} cells (11 phases × ${LOG_SHAPES.length} log shapes × ${CHALLENGE_SHAPES.length} challenge shapes × strict/legacy × host/default)`,
      `stock: ${stock.total} reducer-reachable states across ${stock.byPhase.size} phases, all captured by driving the real machine`,
      'the oracle is written from the invariant text in this file, not from the product code — a barrier and the oracle agreeing is a real cross-check',
      'B1 protects users (a refused restorable snapshot bricks a live case); B2 protects value (an accepted forged ledger mints a verdict over records the machine never produced)',
      'per-ledger scope: phase legality is the reducer guard (campaigns 1 and 9), and the mass-vote barrier applies only when the snapshot carries a ladder',
    ],
  );
}

/** Exported for the vitest FAST subset: the row tables the campaign indexes. */
export const BARRIER_ROWS = {
  phases: PHASES,
  logShapes: LOG_SHAPES,
  challengeShapes: CHALLENGE_SHAPES,
} as const;
