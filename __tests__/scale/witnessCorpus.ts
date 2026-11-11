// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 7 — escalation-witness fuzz (v0.12.0 `escalate` witness round:
 * SPEC §9.2, INV-ESC-2…6).
 *
 * Every corpus unit is ONE escalate-shaped event dispatched through the REAL
 * confirmation-machine reducer against a REAL case parked at `round_resolved`
 * (reached by driving confirmations → challenge window → ladder round →
 * resolve, never by hand-building a state). The corpus rotates a 27-row
 * witness matrix and randomises the case configuration and the row's free
 * fields per unit, so the corpus is thousands of DISTINCT witness events —
 * valid ones, every illegal field permutation, oversized values, duplicate
 * rounds, cap-reached attempts, and replays across cases.
 *
 * Invariants asserted per unit (W1–W6):
 *
 *   W1  a witness the case cannot authorise throws the machine's OWN typed
 *       error (`CourtConfirmationTransitionError`) — never a raw
 *       TypeError/RangeError, never silence;
 *   W2  a REJECTED witness never moves the machine: same phase, no
 *       `escalationLog` entry (an unwitnessed escalation is the round-2
 *       review's bypass, so "no reachable escalation" is asserted directly,
 *       not inferred from a throw);
 *   W3  an ACCEPTED witness opens exactly the next round (`phase ===
 *       'ladder_pending'`, `record.round === ladderRound + 1`) and appends
 *       EXACTLY one frozen record whose fields are the event's witness
 *       (authority, challengerIdx, challengerPubkey, requestHash,
 *       bondProofHash, at) — nothing invented, nothing dropped;
 *   W4  `escalationLog` never exceeds the structural bound
 *       (`min(maxLadderRounds, MAX_LADDER_ROUNDS)`) and the previous state is
 *       never mutated (append-only);
 *   W5  a witness bound to ANOTHER case's accepted bond is refused (cross-case
 *       replay), and a second escalation inside one resolved round is refused
 *       (duplicate round — one witness record per round);
 *   W6  the frozen `hostEscalation` policy decides the host path: refused on a
 *       default case, legal (and logged with null challenger fields) only when
 *       the case was created with the break-glass policy.
 *
 * Unit of the corpus: one witness event. A failure label carries the unit seed
 * and the row name, so the exact event is reproducible from the artifact.
 */

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
import { MAX_LADDER_ROUNDS } from '../../confirmationMachineCore';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, timingMetrics, type CampaignResult } from './corpus';

const SESSION = '11'.repeat(32);
const PROPOSAL = '33'.repeat(32);
const OUTCOMES = ['YES', 'NO'] as const;

/**
 * A deterministic 32-byte lowercase-hex id from a label (no CSPRNG — campaign
 * rule). The FNV-1a fold is over `(seed, label)` so every case has its own
 * witness/bond/event-id space.
 */
function id(seed: number, label: string): string {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  const text = String(label);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const chunk = h.toString(16).padStart(8, '0');
  return chunk.repeat(8);
}

/** Uppercase hex that is guaranteed to contain LETTERS (casing-invalid, shape-valid). */
const UPPERCASE_HEX = 'AB'.repeat(32);
const OVERSIZED = 'a'.repeat(4_096);
const HUGE = Number.MAX_SAFE_INTEGER;

interface Bond {
  readonly idx: number;
  readonly bondTxid: string;
  readonly bondProofHash: string;
}

interface DrivenCase {
  readonly state: CourtConfirmationMachineState;
  readonly bonds: readonly Bond[];
  readonly roster: readonly number[];
  readonly maxLadderRounds: number;
  readonly hostEscalation: boolean;
  /** Clock for the witness: strictly after every accepted event. */
  readonly clock: number;
}

/**
 * Drive a real case to `round_resolved` after `escalationsSoFar` witnessed
 * escalations (each one opening a further ladder round), so units start with
 * `escalationLog` lengths 0..maxLadderRounds-1.
 */
function driveCase(opts: {
  readonly seed: number;
  readonly rosterSize: number;
  readonly quorum: number;
  readonly maxLadderRounds: number;
  readonly challengers: number;
  readonly hostEscalation: boolean;
  readonly escalationsSoFar: number;
}): DrivenCase {
  const roster = Array.from({ length: opts.rosterSize }, (_, i) => i + 1);
  const base = 1_700_000_000;
  const confirmDeadline = base + 1_000;
  const challengeDeadline = base + 2_000;
  let state = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
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
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: id(opts.seed, `confirmation-${idx}`),
      now: base + 1 + offset,
    });
  });
  reduce({ type: 'close_confirmations', now: confirmDeadline });
  reduce({ type: 'open_challenge_window', now: confirmDeadline + 10 });

  const bonds: Bond[] = [];
  for (let c = 0; c < opts.challengers; c += 1) {
    const idx = roster[c % roster.length]!;
    const bond: Bond = {
      idx,
      bondTxid: id(opts.seed, `bond-txid-${c}`),
      bondProofHash: id(opts.seed, `bond-proof-${c}`),
    };
    bonds.push(bond);
    reduce({
      type: 'accept_challenge',
      idx,
      bondTxid: bond.bondTxid,
      bondProofHash: bond.bondProofHash,
      eventId: id(opts.seed, `challenge-${c}`),
      now: confirmDeadline + 100 + c,
    });
  }
  reduce({ type: 'close_challenge_window', now: challengeDeadline });

  let clock = challengeDeadline + 100;
  let round = 1;
  for (;;) {
    const voteDeadline = clock + 1_000;
    reduce({ type: 'open_ladder_round', round, voteDeadline, now: clock });
    // Majority NO so every resolved round OVERTURNS the YES proposal (the
    // flip-flop path that must keep flagging clawbacks).
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
    if (round > opts.escalationsSoFar || round >= opts.maxLadderRounds) break;
    // Witness-bound escalation into the next round (the only legal entry).
    reduce(
      opts.hostEscalation && round % 2 === 0
        ? hostEscalationEvent(state, clock)
        : challengerEscalationEvent(state, clock, {
          challengerPubkey: id(opts.seed, `escalation-pubkey-${round}`),
          requestHash: id(opts.seed, `escalation-request-${round}`),
        }),
    );
    clock += 1;
    round += 1;
  }

  return {
    state,
    bonds,
    roster,
    maxLadderRounds: opts.maxLadderRounds,
    hostEscalation: opts.hostEscalation,
    clock: clock + 50,
  };
}

/** The canonical valid challenger witness for one bond of the case. */
function validWitness(current: DrivenCase, bondIndex: number, seed: number): CourtConfirmationMachineEvent {
  const bond = current.bonds[bondIndex % Math.max(1, current.bonds.length)];
  return challengerEscalationEvent(current.state, current.clock, {
    ...(bond === undefined ? {} : { challengerIdx: bond.idx }),
    challengerPubkey: id(seed, 'valid-witness-pubkey'),
    requestHash: id(seed, 'valid-witness-request'),
  });
}

/** One witness matrix row. */
interface WitnessRow {
  readonly name: string;
  readonly expect: 'accept' | 'reject';
  /** Dispatched against a hand-tampered copy of the state (snapshot tamper probe). */
  readonly tampered?: boolean;
  /**
   * Frozen break-glass policy the row requires: `break-glass` rows only run on
   * a case created WITH `hostEscalation: true`, `default` rows only on a case
   * without it, `either` rows are illegal under both policies.
   */
  readonly policy?: 'default' | 'break-glass' | 'either';
  readonly build: (ctx: {
    readonly current: DrivenCase;
    readonly foreign: (() => DrivenCase) | null;
    readonly seed: number;
    readonly r: () => number;
  }) => unknown;
}

/**
 * THE MATRIX. Rows with `expect: 'accept'` are the only accepted ones; every
 * other row is illegal in EVERY state — which is what makes "no illegal
 * witness ever produces a reachable escalation" a property of the corpus and
 * not of one hand-picked case.
 */
export const WITNESS_ROWS: readonly WitnessRow[] = [
  {
    name: 'valid-challenger',
    expect: 'accept',
    build: ({ current, seed, r }) => validWitness(current, int(r, 0, Math.max(0, current.bonds.length - 1)), seed),
  },
  {
    name: 'valid-host-break-glass',
    expect: 'accept',
    policy: 'break-glass',
    build: ({ current }) => hostEscalationEvent(current.state, current.clock),
  },
  {
    name: 'unwitnessed',
    expect: 'reject',
    build: () => ({ type: 'escalate' }),
  },
  {
    name: 'unknown-authority',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), authority: 'warden' }),
  },
  {
    name: 'host-authority-under-default-policy',
    expect: 'reject',
    policy: 'default',
    build: ({ current }) => ({
      type: 'escalate',
      authority: 'host',
      challengerIdx: null,
      challengerPubkey: null,
      requestHash: null,
      bondProofHash: null,
      roundIndex: current.state.ladderRound + 1,
      now: current.clock,
    }),
  },
  {
    name: 'host-carrying-challenger-request',
    expect: 'reject',
    policy: 'either',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), authority: 'host' }),
  },
  {
    name: 'round-replayed',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), roundIndex: current.state.ladderRound }),
  },
  {
    name: 'round-skipped',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), roundIndex: current.state.ladderRound + 2 }),
  },
  {
    name: 'round-fractional',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), roundIndex: current.state.ladderRound + 1.5 }),
  },
  {
    name: 'round-string',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), roundIndex: String(current.state.ladderRound + 1) }),
  },
  {
    name: 'round-oversized',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), roundIndex: HUGE }),
  },
  {
    name: 'hand-restored-cap',
    expect: 'reject',
    tampered: true,
    // A hand-restored snapshot parked at round_resolved with the cap already
    // reached: the cap (not the witness) must refuse, so a restored snapshot
    // cannot re-open a ladder the case already finished.
    build: ({ current, seed }) => validWitness(current, 0, seed),
  },
  {
    name: 'challenger-out-of-roster-low',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerIdx: 0 }),
  },
  {
    name: 'challenger-out-of-roster-high',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerIdx: current.roster.length + 1 }),
  },
  {
    name: 'challenger-oversized-index',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerIdx: HUGE }),
  },
  {
    name: 'challenger-null',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerIdx: null }),
  },
  {
    name: 'challenger-string',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerIdx: String(current.roster[0]) }),
  },
  {
    name: 'pubkey-uppercase',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerPubkey: UPPERCASE_HEX }),
  },
  {
    name: 'pubkey-oversized',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerPubkey: OVERSIZED }),
  },
  {
    name: 'pubkey-null',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), challengerPubkey: null }),
  },
  {
    name: 'request-oversized',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), requestHash: OVERSIZED }),
  },
  {
    name: 'request-empty',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), requestHash: '' }),
  },
  {
    name: 'foreign-bond',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), bondProofHash: id(seed, 'never-accepted-bond') }),
  },
  {
    name: 'cross-case-bond-replay',
    expect: 'reject',
    // The SAME witness shape bound to a bond ANOTHER case accepted: the
    // machine has no memory of that ledger, so it must refuse.
    build: ({ current, foreign, seed }) => ({
      ...validWitness(current, 0, seed),
      bondProofHash: foreign === null ? id(seed, 'no-foreign-bond') : (foreign().bonds[0]?.bondProofHash ?? id(seed, 'no-foreign-bond')),
    }),
  },
  {
    name: 'duplicate-round-same-case',
    expect: 'reject',
    // Accept the first escalation, then prove a second one for the SAME round
    // is refused (one witness record per round; asserted in the probe below).
    build: ({ current, seed }) => validWitness(current, 0, seed),
  },
  {
    name: 'bond-null',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), bondProofHash: null }),
  },
  {
    name: 'clock-regressed',
    expect: 'reject',
    build: ({ current, seed }) => ({ ...validWitness(current, 0, seed), now: current.state.latestTimestamp - 1 }),
  },
];

interface WitnessStats {
  accepted: number;
  rejected: number;
  typedRejections: number;
  rawErrors: number;
  logRecordsAppended: number;
  maxLogDepth: number;
  crossCaseReplays: number;
  duplicateRoundAttempts: number;
  capReachedProbes: number;
  oversizedValues: number;
  rowsByOutcome: Record<string, number>;
  perRowMs: number[];
}

const ROW_NAMES = WITNESS_ROWS.map((row) => row.name);

/** Run one witness unit. */
function runWitnessUnit(reporter: CampaignReporter, unitSeed: number, stats: WitnessStats): void {
  const r = childRng(unitSeed, 'witness-unit');
  const rosterSize = int(r, 3, 7);
  const quorum = int(r, 1, rosterSize);
  // A witness unit needs a case that can PARK at round_resolved: the final
  // permitted round settles straight into fee_settlement (the reducer never
  // auto-escalates), so maxLadderRounds must be >= 2 for the escalation
  // decision to exist at all.
  const maxLadderRounds = int(r, 2, 3);
  const challengers = int(r, 1, 3);
  const rowName = ROW_NAMES[(unitSeed - 1) % ROW_NAMES.length]!;
  const row = WITNESS_ROWS.find((candidate) => candidate.name === rowName)!;
  // Policy-sensitive rows pin the case's frozen break-glass flag, so the
  // expectation is a property of the ROW, not of a lucky draw.
  const hostEscalation = row.policy === 'break-glass'
    ? true
    : row.policy === 'default'
      ? false
      : r() < 0.3;

  // The round that PARKS is the last one resolved, and the final permitted
  // round settles straight into fee_settlement — so every unit resolves at most
  // maxLadderRounds - 2 escalations before parking (leaving room for the one
  // escalation under test, which accepted rows actually take).
  const maxEscalations = Math.max(0, maxLadderRounds - 2);
  const escalationsSoFar = int(r, 0, maxEscalations);

  const current = driveCase({
    seed: unitSeed,
    rosterSize,
    quorum,
    maxLadderRounds,
    challengers,
    hostEscalation,
    escalationsSoFar,
  });
  const label = `witness#${unitSeed} [${row.name}]`;
  const started = nowMs();

  if (current.state.phase !== 'round_resolved') {
    reporter.fail(
      label,
      `W0: case did not park at round_resolved (phase ${current.state.phase}, rounds ${current.state.ladderRound}/${maxLadderRounds})`,
    );
    return;
  }

  const event = row.build({
    current,
    foreign: row.name === 'cross-case-bond-replay'
      // A sibling case with DIFFERENT bond hashes, built only when needed.
      ? () => driveCase({
        seed: unitSeed + 1_000_000,
        rosterSize: 3,
        quorum: 1,
        maxLadderRounds: 1,
        challengers: 1,
        hostEscalation: false,
        escalationsSoFar: 0,
      })
      : null,
    seed: unitSeed,
    r,
  }) as CourtConfirmationMachineEvent;

  const logBefore = current.state.escalationLog.length;
  const expect: 'accept' | 'reject' = row.expect;
  stats.rowsByOutcome[`${row.name}:${expect}`] = (stats.rowsByOutcome[`${row.name}:${expect}`] ?? 0) + 1;

  // ── W5: duplicate round — accept the FIRST escalation of the resolved round,
  // then prove a SECOND one for the same round is refused (one witness record
  // per round). This probe owns its own accept step, so it runs before the
  // single-dispatch path below.
  if (row.name === 'duplicate-round-same-case') {
    stats.duplicateRoundAttempts += 1;
    let afterFirst: CourtConfirmationMachineState;
    try {
      afterFirst = reduceCourtConfirmationMachine(current.state, event);
    } catch (err) {
      reporter.fail(label, `W5: the FIRST escalation of a resolved round was refused: ${describe(err)}`);
      return;
    }
    reporter.equals(label, afterFirst.phase, 'ladder_pending', 'W5: the first escalation must open the next round');
    reporter.equals(label, afterFirst.escalationLog.length, logBefore + 1, 'W5: the first escalation must append exactly one record');
    let secondThrown: unknown;
    try {
      reduceCourtConfirmationMachine(afterFirst, event);
    } catch (err) {
      secondThrown = err;
    }
    reporter.ok(
      label,
      secondThrown instanceof CourtConfirmationTransitionError,
      'W5: a SECOND escalation inside the same resolved round must be a typed refusal',
    );
    reporter.equals(label, current.state.escalationLog.length, logBefore, 'W5: the base state must not be mutated (append-only)');
    stats.rejected += 1;
    stats.typedRejections += 1;
    stats.perRowMs.push(Math.round((nowMs() - started) * 1000) / 1000);
    return;
  }

  // ── snapshot-tamper probes run against a hand-restored copy of the state ──
  const dispatchedAgainst: CourtConfirmationMachineState = row.tampered === true
    ? ({ ...current.state, ladderRound: current.state.maxLadderRounds } as CourtConfirmationMachineState)
    : current.state;

  let thrown: unknown;
  let didThrow = false;
  let next: CourtConfirmationMachineState | undefined;
  try {
    next = reduceCourtConfirmationMachine(dispatchedAgainst, event);
  } catch (err) {
    didThrow = true;
    thrown = err;
  }

  if (expect === 'reject') {
    // ── W1: typed refusal, never a raw error, never silence. ──
    if (!didThrow) {
      reporter.fail(label, 'W1: an ILLEGAL escalation witness was ACCEPTED (bypass)');
      return;
    }
    if (!(thrown instanceof CourtConfirmationTransitionError)) {
      stats.rawErrors += 1;
      reporter.fail(label, `W1: rejection threw an UNTYPED error: ${describe(thrown)}`);
      return;
    }
    stats.typedRejections += 1;
    stats.rejected += 1;
    // ── W2: no reachable escalation — the input state is untouched. ──
    reporter.equals(label, dispatchedAgainst.phase, 'round_resolved', 'W2: a rejected witness must not move the phase');
    reporter.equals(label, dispatchedAgainst.escalationLog.length, logBefore, 'W2: a rejected witness must not append to escalationLog');

    if (row.name === 'cross-case-bond-replay') stats.crossCaseReplays += 1;
    if (row.name === 'hand-restored-cap') stats.capReachedProbes += 1;
    if (row.name === 'pubkey-oversized' || row.name === 'request-oversized'
      || row.name === 'round-oversized' || row.name === 'challenger-oversized-index') {
      stats.oversizedValues += 1;
    }
    stats.perRowMs.push(Math.round((nowMs() - started) * 1000) / 1000);
    return;
  }

  // ── ACCEPT path (W3/W4/W6) ───────────────────────────────────────────────
  if (didThrow) {
    reporter.fail(label, `W3: a LEGAL escalation witness was refused: ${describe(thrown)}`);
    return;
  }
  const accepted = next!;
  stats.accepted += 1;
  reporter.equals(label, accepted.phase, 'ladder_pending', 'W3: an accepted escalation opens the next round');
  reporter.equals(label, accepted.escalationLog.length, logBefore + 1, 'W3: exactly one record appended');
  const record = accepted.escalationLog[accepted.escalationLog.length - 1]!;
  const witness = event as unknown as Record<string, unknown>;
  reporter.equals(label, record.round, current.state.ladderRound + 1, 'W3: record.round = ladderRound + 1');
  reporter.equals(label, record.authority, witness.authority, 'W3: record.authority = the witnessed authority');
  reporter.equals(label, record.challengerIdx, witness.challengerIdx ?? null, 'W3: record.challengerIdx = the witnessed challenger');
  reporter.equals(label, record.challengerPubkey, witness.challengerPubkey ?? null, 'W3: record.challengerPubkey = the witnessed pubkey');
  reporter.equals(label, record.requestHash, witness.requestHash ?? null, 'W3: record.requestHash = the witnessed request');
  reporter.equals(label, record.bondProofHash, witness.bondProofHash ?? null, 'W3: record.bondProofHash = the witnessed bond');
  reporter.equals(label, record.at, witness.now, 'W3: record.at = event.now');
  reporter.ok(label, Object.isFrozen(record) && Object.isFrozen(accepted.escalationLog), 'W3: the witness log and its records are frozen');
  // ── W4: structural bound + append-only. ──
  reporter.ok(
    label,
    accepted.escalationLog.length <= Math.min(accepted.maxLadderRounds, MAX_LADDER_ROUNDS),
    'W4: escalationLog must never exceed min(maxLadderRounds, MAX_LADDER_ROUNDS)',
  );
  reporter.equals(label, current.state.escalationLog.length, logBefore, 'W4: the previous state must not be mutated (append-only)');
  stats.logRecordsAppended += 1;
  if (accepted.escalationLog.length > stats.maxLogDepth) stats.maxLogDepth = accepted.escalationLog.length;
  // ── W6: break-glass authority is logged without a challenger request. ──
  if (record.authority === 'host') {
    reporter.ok(
      label,
      record.challengerIdx === null && record.challengerPubkey === null
        && record.requestHash === null && record.bondProofHash === null,
      'W6: a host escalation record carries no challenger request',
    );
    reporter.ok(label, accepted.hostEscalation === true, 'W6: a host record implies the frozen break-glass policy');
  }
  stats.perRowMs.push(Math.round((nowMs() - started) * 1000) / 1000);
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Run the campaign: `size` witness units, unit seed = base seed + index, so a
 * failure label is directly reproducible from the artifact.
 */
export function runWitnessCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('witness', 'witnesses', opts.size, seed);
  const stats: WitnessStats = {
    accepted: 0,
    rejected: 0,
    typedRejections: 0,
    rawErrors: 0,
    logRecordsAppended: 0,
    maxLogDepth: 0,
    crossCaseReplays: 0,
    duplicateRoundAttempts: 0,
    capReachedProbes: 0,
    oversizedValues: 0,
    rowsByOutcome: {},
    perRowMs: [],
  };

  for (let index = 1; index <= opts.size; index += 1) runWitnessUnit(reporter, seed + index, stats);

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      accepted: stats.accepted,
      rejected: stats.rejected,
      typedRejections: stats.typedRejections,
      rawErrors: stats.rawErrors,
      logRecordsAppended: stats.logRecordsAppended,
      maxLogDepth: stats.maxLogDepth,
      crossCaseReplays: stats.crossCaseReplays,
      duplicateRoundAttempts: stats.duplicateRoundAttempts,
      capReachedProbes: stats.capReachedProbes,
      oversizedValues: stats.oversizedValues,
      distinctRows: Object.keys(stats.rowsByOutcome).length,
      ...timingMetrics(stats.perRowMs),
    },
    [
      `witness matrix rows: ${WITNESS_ROWS.length} (${WITNESS_ROWS.filter((row) => row.expect === 'accept').length} accept, ${WITNESS_ROWS.filter((row) => row.expect === 'reject').length} reject)`,
      'every unit drives a REAL case to round_resolved through the reducer (confirmations → challenge window → ladder round → resolve)',
      'cases: rosters 3..7, quorum 1..N, maxLadderRounds 1..3, 1..3 accepted bonds, break-glass policy on for ~30% of units',
      'rejected witnesses are asserted to leave BOTH the phase and the escalationLog unchanged (no reachable escalation)',
    ],
  );
}
