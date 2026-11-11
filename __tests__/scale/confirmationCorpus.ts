// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 1 — confirmation-machine legal-sequence sweep at scale.
 *
 * Drives the universal-confirmation reducer through seeded-RANDOM LEGAL event
 * sequences (rosters 3..25, outcome sets 2..5, quorum 1..roster,
 * `maxLadderRounds` 1..3, with challenge / ladder / escalate / concede /
 * fee / clawback / tick / abort interleavings) and checks, after EVERY
 * transition:
 *
 *   C1  the reducer never throws on a legal event (an exception is a finding);
 *   C2  the phase stays in the declared union and terminals are only
 *       { final, expired, aborted }, and the R25 quorum-policy flag is derived
 *       (`quorumBelowSupermajority === confirmQuorum < ⌈2N/3⌉`) on every state;
 *   C3  `latestTimestamp` is the greatest accepted timestamp — monotone
 *       non-decreasing, exactly `event.now` for every time-bearing event and
 *       unchanged by `abort` (INV-CONF monotonicity);
 *   C4  the state graph is frozen (state + every ledger + every record; the
 *       full depth-first audit runs on a 1-in-17 sample, the shallow check on
 *       every step);
 *   C5  on `final` the verdict RECOMPUTES from public inputs: verdictHash ===
 *       hashCourtVerdict(sessionHash, outcome, supportingEventIds), the
 *       supporting ids are non-empty/sorted/drawn from the correct ledger,
 *       `upheld === (outcome === proposedOutcome)`, an overturned proposal
 *       flags every confirming juror, and `outcomeHistory` is a consecutive
 *       append-only 1..k sequence whose flip-flops flag the previous round's
 *       majority;
 *   C6  every REJECTED event throws the machine's OWN typed error
 *       (`CourtConfirmationTransitionError`) — a raw TypeError, RangeError, or
 *       a foreign module's error class escaping the reducer is a finding. Each
 *       sequence dispatches deliberately ILLEGAL events (out-of-phase,
 *       duplicate, clock-regressing, unknown-type) at every step with
 *       probability 0.35, and the full hostile probe set every 11th step.
 *
 * Unit of the corpus: one sequence. A sequence is a fresh machine plus up to
 * `maxSteps` accepted transitions; the campaign records per-sequence wall time
 * so the cost distribution (not just the total) lands in the artifact.
 */

import {
  CourtConfirmationTransitionError,
  confirmSupermajority,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
  type CourtConfirmationPhase,
} from '../../courtConfirmationMachine';
import { hashCourtVerdict } from '../../courtVoteMachine';
import { childRng, int, pick } from '../helpers/rng';
import { escalateEvent } from '../helpers/machines';
import {
  CampaignReporter,
  firstUnfrozen,
  nowMs,
  timingMetrics,
  type CampaignResult,
} from './corpus';

const TERMINAL_PHASES = new Set<CourtConfirmationPhase>(['final', 'expired', 'aborted']);
const ALL_PHASES: readonly CourtConfirmationPhase[] = [
  'confirm_open', 'confirm_closed', 'challenge_window', 'ladder_pending',
  'ladder_vote_open', 'ladder_vote_closed', 'round_resolved', 'fee_settlement',
  'final', 'expired', 'aborted',
];

/** Outcome labels for the campaign ballot (one unicode + one boundary-length label included). */
const OUTCOME_LABELS = ['outcome-0', 'outcome-1', 'outcome-2', 'outcome-3', 'YES', 'NO', 'é😀', 'Ä'] as const;

/** Metrics collected per sequence (all integers, summed into the artifact). */
interface SequenceStats {
  steps: number;
  terminal: 'final' | 'expired' | 'aborted' | 'open';
  ladderReached: number;
  multiRound: number;
  escalated: number;
  conceded: number;
  overturned: number;
  expandedPanel: number;
  illegalProbes: number;
  typedRejections: number;
  deepFreezeAudits: number;
  wallMs: number;
}

/** Per-sequence generator context (one labeled RNG stream per sequence). */
interface SequenceContext {
  readonly r: () => number;
  clock: number;
  readonly roster: readonly number[];
  readonly outcomes: readonly string[];
  readonly eventId: (n: number) => string;
}

/**
 * Run one seeded sequence. `seed` fully determines the machine configuration
 * and every event drawn; a failure message carries the seed so the case is
 * reproducible from the artifact alone.
 */
function runSequence(reporter: CampaignReporter, seed: number, maxSteps = 90): SequenceStats {
  const label = `sequence#${seed}`;
  const r = childRng(seed, 'confirmation-sequence');
  const rosterSize = int(r, 3, 25);
  const roster = Array.from({ length: rosterSize }, (_, i) => i + 1);
  const outcomeCount = int(r, 2, 5);
  const outcomes = Array.from({ length: outcomeCount }, (_, i) => OUTCOME_LABELS[i]!);
  const proposedOutcome = pick(r, outcomes);
  const confirmQuorum = int(r, 1, rosterSize);
  const maxLadderRounds = int(r, 1, 3);
  const base = int(r, 1_700_000_000, 1_800_000_000);
  const confirmDeadline = base + int(r, 1, 2_000);
  const challengeDeadline = confirmDeadline + int(r, 1, 5_000);
  // Counter-derived ids: 32-byte lowercase hex, unique by construction and
  // far cheaper than 64 random hex chars per event at this corpus size.
  const idPrefix = 'ab'.repeat(20) + seed.toString(16).padStart(8, '0').padStart(24, '0').slice(-24);
  const ctx: SequenceContext = {
    r,
    clock: base,
    roster,
    outcomes,
    eventId: (n: number) => `${idPrefix}${n.toString(16).padStart(16, '0')}`.slice(-64),
  };

  let state: CourtConfirmationMachineState;
  try {
    state = createCourtConfirmationMachine({
      sessionHash: '11'.repeat(32),
      proposalHash: '33'.repeat(32),
      proposedOutcome,
      allowedOutcomes: outcomes,
      evidenceIds: Array.from({ length: int(r, 0, 3) }, (_, i) => ctx.eventId(1_000_000 + i)),
      participantIndices: roster,
      confirmQuorum,
      confirmDeadline,
      challengeDeadline,
      maxLadderRounds,
    });
  } catch (err) {
    reporter.fail(label, `creation with a legal roster 3..25 threw ${describe(err)}`);
    return emptyStats(0);
  }

  const stats = emptyStats(0);
  const log: string[] = [];
  let prevLatest = state.latestTimestamp;
  let idCounter = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (TERMINAL_PHASES.has(state.phase)) break;

    const event = nextLegalEvent(state, ctx, () => {
      idCounter += 1;
      return ctx.eventId(idCounter);
    }, confirmDeadline, challengeDeadline, label, reporter);
    if (event === null) break;
    log.push(`${state.phase} <- ${event.type}`);

    // C1 — a legal event must never throw.
    let next: CourtConfirmationMachineState;
    try {
      next = reduceCourtConfirmationMachine(state, event);
    } catch (err) {
      reporter.fail(
        label,
        `C1: legal ${event.type} in phase ${state.phase} threw ${describe(err)}\n  trace: ${log.slice(-10).join(' | ')}`,
      );
      break;
    }

    // C3 — monotonic clock ledger.
    if (event.type === 'abort') {
      reporter.equals(label, next.latestTimestamp, prevLatest, 'C3: abort must not move the clock');
    } else {
      reporter.equals(label, next.latestTimestamp, event.now, `C3: latestTimestamp after ${event.type} must equal event.now`);
      if (event.now < prevLatest) {
        reporter.fail(label, `C3: event.now ${event.now} regressed below ${prevLatest} (${event.type})`);
      }
      ctx.clock = event.now;
      prevLatest = next.latestTimestamp;
    }

    // C2 — phase discipline.
    reporter.ok(label, ALL_PHASES.includes(next.phase), `C2: phase ${String(next.phase)} outside the declared union`);
    if (TERMINAL_PHASES.has(next.phase)) {
      reporter.ok(
        label,
        next.phase === 'final' || next.phase === 'expired' || next.phase === 'aborted',
        `C2: terminal set violation (${next.phase})`,
      );
      stats.terminal = next.phase as SequenceStats['terminal'];
    }
    // C2b — the R25 quorum-policy flag is DERIVED, never caller-supplied: it
    // must track the frozen quorum against the roster supermajority ⌈2N/3⌉.
    reporter.equals(
      label,
      next.quorumBelowSupermajority,
      next.confirmQuorum < confirmSupermajority(next.participantIndices.length),
      'C2b: quorumBelowSupermajority must equal confirmQuorum < ceil(2N/3)',
    );

    // C4 — freeze discipline: shallow every step, deep on a 1-in-17 sample.
    reporter.ok(label, Object.isFrozen(next), 'C4: exported state must be frozen');
    reporter.ok(label, Object.isFrozen(next.confirmations) && Object.isFrozen(next.challenges), 'C4: ledgers must be frozen');
    reporter.ok(label, Object.isFrozen(next.clawbackFlags) && Object.isFrozen(next.fees), 'C4: fee/clawback ledgers must be frozen');
    if (step % 17 === 0) {
      const unfrozen = firstUnfrozen(next);
      reporter.ok(label, unfrozen === null, `C4: non-frozen object reachable at ${unfrozen ?? '?'}`);
      stats.deepFreezeAudits += 1;
    }

    // C5 — a final verdict must recompute from public inputs.
    if (next.phase === 'final') checkFinalVerdict(reporter, label, next, stats);

    // Coverage counters (not assertions — they feed the artifact's metrics).
    if (next.ladder !== undefined) stats.ladderReached = 1;
    if (next.ladderRound >= 2) stats.multiRound = 1;
    if (next.ladder?.roundRoster !== undefined) stats.expandedPanel = 1;
    if (event.type === 'escalate') stats.escalated = 1;
    if (event.type === 'concede') stats.conceded = 1;

    // C6 — typed rejections: one deliberately illegal event per step (p=0.35)
    // plus the full hostile probe set every 11th step.
    if (!TERMINAL_PHASES.has(next.phase) && r() < 0.35) {
      const illegal = illegalEvent(next, r, ctx.eventId(9_000_000 + step));
      stats.illegalProbes += 1;
      if (expectTypedRejection(reporter, label, next, illegal, 'C6 illegal-event')) stats.typedRejections += 1;
    }
    if (!TERMINAL_PHASES.has(next.phase) && step % 11 === 0) {
      for (const probe of hostileProbes(next)) {
        stats.illegalProbes += 1;
        if (expectTypedRejection(reporter, label, probe.state, probe.event, `C6 ${probe.name}`)) stats.typedRejections += 1;
      }
    }

    state = next;
    stats.steps += 1;
  }

  return stats;
}

/** C5 — the final verdict's full recomputation. */
function checkFinalVerdict(
  reporter: CampaignReporter,
  label: string,
  state: CourtConfirmationMachineState,
  stats: SequenceStats,
): void {
  const verdict = state.verdict;
  if (!verdict) {
    reporter.fail(label, 'C5: final phase without a verdict');
    return;
  }
  const where = `${label} final(${verdict.outcome})`;
  const expectedHash = hashCourtVerdict({
    sessionHash: state.sessionHash,
    outcome: verdict.outcome,
    supportingEventIds: verdict.supportingEventIds,
  });
  reporter.equals(where, verdict.verdictHash, expectedHash, 'C5: verdictHash must recompute');
  reporter.ok(where, verdict.supportingEventIds.length >= 1, 'C5: verdict needs at least one supporting event id');
  reporter.equals(where, verdict.upheld, verdict.outcome === state.proposedOutcome, 'C5: upheld must equal (outcome === proposedOutcome)');

  // Sorted supporting ids (compared with the array's own sorted copy).
  const sorted = [...verdict.supportingEventIds].sort();
  reporter.equalStrings(where, [...verdict.supportingEventIds], sorted, 'C5: supporting event ids must be sorted');

  // Supporting ids come from the ledger the finality rule names.
  const neverChallengedUpheld = state.challenges.length === 0 && verdict.upheld;
  const source = neverChallengedUpheld
    ? state.confirmations.map((record) => record.eventId)
    : (state.ladder?.votes ?? []).filter((vote) => vote.outcome === verdict.outcome).map((vote) => vote.eventId);
  for (const id of verdict.supportingEventIds) {
    reporter.ok(where, source.includes(id), `C5: supporting id ${id.slice(0, 8)}… is not in the expected ledger`);
  }

  // Outcome history: consecutive, append-only, last entry decides a challenged verdict.
  const history = state.outcomeHistory ?? [];
  for (let offset = 0; offset < history.length; offset += 1) {
    const record = history[offset]!;
    reporter.equals(where, record.round, offset + 1, 'C5: outcomeHistory rounds must be consecutive 1..k');
    reporter.ok(where, record.winnerIndices.length >= 1 && record.winnerEventIds.length >= 1, 'C5: history record needs winners');
    if (offset > 0 && history[offset - 1]!.outcome !== record.outcome) {
      for (const idx of history[offset - 1]!.winnerIndices) {
        reporter.ok(
          where,
          state.clawbackFlags.some((flag) => flag.idx === idx && flag.reason === 'round_flip' && flag.round === history[offset - 1]!.round),
          `C5: round-flip clawback missing for participant ${idx} of round ${history[offset - 1]!.round}`,
        );
      }
    }
  }
  if (state.challenges.length > 0) {
    reporter.equals(where, history[history.length - 1]?.outcome, verdict.outcome, 'C5: the last resolved round decides the verdict');
  }
  if (!verdict.upheld) {
    stats.overturned = 1;
    for (const record of state.confirmations) {
      reporter.ok(
        where,
        state.clawbackFlags.some((flag) => flag.idx === record.idx && flag.reason === 'overturned_confirmation'),
        `C5: overturned proposal must flag confirming participant ${record.idx}`,
      );
    }
  }
}

/** C6 — a rejected event must throw the machine's own typed error. */
function expectTypedRejection(
  reporter: CampaignReporter,
  label: string,
  state: CourtConfirmationMachineState,
  event: unknown,
  name: string,
): boolean {
  let thrown: unknown;
  let didThrow = false;
  try {
    reduceCourtConfirmationMachine(state, event as CourtConfirmationMachineEvent);
  } catch (err) {
    didThrow = true;
    thrown = err;
  }
  if (!didThrow) {
    reporter.fail(label, `C6: ${name} was ACCEPTED in phase ${state.phase} (must fail closed)`);
    return false;
  }
  if (!(thrown instanceof CourtConfirmationTransitionError)) {
    reporter.fail(
      label,
      `C6: ${name} threw an UNTYPED error in phase ${state.phase}: ${describe(thrown)} (expected CourtConfirmationTransitionError)`,
    );
    return false;
  }
  reporter.check();
  return true;
}

/** One hostile probe: the state it targets and the event it dispatches. */
interface HostileProbe {
  readonly name: string;
  readonly state: CourtConfirmationMachineState;
  readonly event: unknown;
}

/**
 * The full hostile probe set (used on the 1-in-11 sample): clock regression,
 * a null event, an unknown event type, a hand-tampered ledger, a wrong
 * canonical confirmation hash, and — outside `fee_settlement` — finalize out
 * of phase. Every one of them must fail closed with the machine's own typed
 * error.
 */
function hostileProbes(state: CourtConfirmationMachineState): HostileProbe[] {
  const now = state.latestTimestamp;
  const rosterIdx = state.participantIndices[0]!;
  const probes: HostileProbe[] = [
    { name: 'clock-regression', state, event: { type: 'tick', now: now - 1 } },
    { name: 'null-event', state, event: null },
    { name: 'unknown-type', state, event: { type: 'definitely_not_an_event', now } },
    {
      name: 'tampered-ledger',
      state: { ...state, confirmations: 'tampered' } as unknown as CourtConfirmationMachineState,
      event: { type: 'tick', now },
    },
    {
      name: 'wrong-confirm-hash',
      state,
      event: { type: 'accept_confirmation', idx: rosterIdx, confirmHash: '00'.repeat(32), eventId: 'ff'.repeat(32), now },
    },
  ];
  if (state.phase !== 'fee_settlement') {
    probes.push({ name: 'finalize-out-of-phase', state, event: { type: 'finalize', now } });
  }
  return probes;
}

/** A deliberately ILLEGAL event for the current phase (never state-legal). */
function illegalEvent(
  state: CourtConfirmationMachineState,
  r: () => number,
  freshId: string,
): unknown {
  const now = state.latestTimestamp;
  const rosterIdx = state.participantIndices[0]!;
  const candidates: unknown[] = [
    // A confirmation whose canonical hash was never derived for this binding.
    { type: 'accept_confirmation', idx: rosterIdx, confirmHash: '00'.repeat(32), eventId: freshId, now },
    // A challenge with a malformed bond witness.
    { type: 'accept_challenge', idx: rosterIdx, bondTxid: 'zz', bondProofHash: '00'.repeat(32), eventId: freshId, now },
    // An out-of-allowlist mass vote.
    { type: 'accept_mass_vote', idx: rosterIdx, outcome: '__not_an_outcome__', eventId: freshId, now },
    // An out-of-phase close (only exact phases accept these).
    { type: 'open_ladder_round', round: 99, voteDeadline: now, now },
    // A clock that regresses below the ledger.
    { type: 'tick', now: now - 1 },
  ];
  return pick(r, candidates);
}

/**
 * Choose one legal next event for the current phase, weighted toward
 * productive transitions. Returns `null` only when the generator finds no
 * legal option (which cannot happen for a legal state — recorded as a failure).
 */
function nextLegalEvent(
  state: CourtConfirmationMachineState,
  ctx: SequenceContext,
  newEventId: () => string,
  confirmDeadline: number,
  challengeDeadline: number,
  label: string,
  reporter: CampaignReporter,
): CourtConfirmationMachineEvent | null {
  const { r, clock } = ctx;
  const now = clock;
  type Weighted = { weight: number; make: () => CourtConfirmationMachineEvent };
  const options: Weighted[] = [];
  const add = (weight: number, make: () => CourtConfirmationMachineEvent): void => {
    options.push({ weight, make });
  };
  const maybeAbort = (): void => {
    if (r() < 0.15) add(0.4, () => ({ type: 'abort', reason: 'host-abort' }));
  };
  const recordFee = (): void => add(0.7, () => ({ type: 'record_fee', feeEventId: newEventId(), now }));
  const tickBefore = (deadline: number): void => {
    const slack = deadline - 1 - clock;
    if (slack >= 1) add(1.5, () => ({ type: 'tick', now: clock + int(r, 1, Math.min(50, slack)) }));
  };
  const tickPast = (deadline: number): void =>
    add(0.8, () => ({ type: 'tick', now: Math.max(clock, deadline) + int(r, 0, 100) }));

  switch (state.phase) {
    case 'confirm_open': {
      const unconfirmed = ctx.roster.filter((idx) => !state.confirmations.some((c) => c.idx === idx));
      recordFee();
      if (clock < confirmDeadline && unconfirmed.length > 0) {
        add(6, () => {
          const idx = pick(r, unconfirmed);
          return {
            type: 'accept_confirmation',
            idx,
            confirmHash: hashCourtConfirmation({ sessionHash: state.sessionHash, proposalHash: state.proposalHash, idx }),
            eventId: newEventId(),
            now,
          };
        });
        if (state.confirmations.length > 0) {
          // Idempotent re-send of an existing confirmation (accepted, no-op record).
          add(0.7, () => {
            const record = pick(r, state.confirmations);
            return { type: 'accept_confirmation', idx: record.idx, confirmHash: record.confirmHash, eventId: record.eventId, now };
          });
        }
        tickBefore(confirmDeadline);
      }
      if (state.confirmations.length >= state.confirmQuorum) {
        add(6, () => ({ type: 'close_confirmations', now: Math.max(clock, confirmDeadline) }));
      }
      tickPast(confirmDeadline);
      maybeAbort();
      break;
    }
    case 'confirm_closed': {
      recordFee();
      if (clock < challengeDeadline) add(6, () => ({ type: 'open_challenge_window', now }));
      tickPast(challengeDeadline);
      maybeAbort();
      break;
    }
    case 'challenge_window': {
      const unchallenged = ctx.roster.filter((idx) => !state.challenges.some((c) => c.idx === idx));
      recordFee();
      if (clock < challengeDeadline) {
        if (unchallenged.length > 0) {
          add(5, () => ({
            type: 'accept_challenge',
            idx: pick(r, unchallenged),
            bondTxid: newEventId(),
            bondProofHash: newEventId(),
            eventId: newEventId(),
            now,
          }));
        }
        tickBefore(challengeDeadline);
      }
      add(6, () => ({ type: 'close_challenge_window', now: Math.max(clock, challengeDeadline) }));
      tickPast(challengeDeadline);
      maybeAbort();
      break;
    }
    case 'ladder_pending': {
      recordFee();
      add(6, () => {
        // Half the rounds reconstitute the panel (host policy §4.2).
        const expand = r() < 0.5;
        const panelSize = expand ? int(r, 3, Math.max(3, ctx.roster.length)) : ctx.roster.length;
        return {
          type: 'open_ladder_round',
          round: state.ladderRound + 1,
          voteDeadline: clock + int(r, 1, 3_000),
          ...(expand ? { roundRoster: Array.from({ length: panelSize }, (_, i) => i + 1) } : {}),
          now,
        } as CourtConfirmationMachineEvent;
      });
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) }));
      maybeAbort();
      break;
    }
    case 'ladder_vote_open': {
      const deadline = state.ladder!.voteDeadline;
      const panel = state.ladder!.roundRoster ?? ctx.roster;
      const nonVoted = panel.filter((idx) => !state.ladder!.votes.some((vote) => vote.idx === idx));
      recordFee();
      if (clock < deadline) {
        if (nonVoted.length > 0) {
          add(6, () => ({
            type: 'accept_mass_vote',
            idx: pick(r, nonVoted),
            outcome: pick(r, ctx.outcomes),
            eventId: newEventId(),
            now,
          }));
        }
        if (state.ladder!.votes.length > 0) {
          add(0.7, () => {
            const vote = pick(r, state.ladder!.votes);
            return { type: 'accept_mass_vote', idx: vote.idx, outcome: vote.outcome, eventId: vote.eventId, now };
          });
        }
        tickBefore(deadline);
      }
      if (state.ladder!.votes.length > 0 && panel.length >= 3) {
        add(6, () => ({ type: 'close_ladder_round', now: Math.max(clock, deadline) }));
      }
      tickPast(deadline);
      maybeAbort();
      break;
    }
    case 'ladder_vote_closed': {
      add(7, () => ({ type: 'resolve_round', now }));
      recordFee();
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) }));
      maybeAbort();
      break;
    }
    case 'round_resolved': {
      // Host-driven: the machine never auto-escalates and never auto-concedes.
      add(4, () => escalateEvent(state, now));
      add(4, () => ({ type: 'concede', now }));
      recordFee();
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) }));
      maybeAbort();
      break;
    }
    case 'fee_settlement': {
      recordFee();
      add(2, () => ({
        type: 'flag_clawback',
        idx: pick(r, ctx.roster),
        reason: pick(r, ['manual_flag', 'host_adjustment', 'overturned_confirmation']),
        now,
      }));
      add(6, () => ({ type: 'finalize', now }));
      add(0.7, () => ({ type: 'tick', now: clock + int(r, 1, 100) }));
      maybeAbort();
      break;
    }
    default: {
      reporter.fail(label, `generator reached unexpected phase ${String(state.phase)}`);
      return null;
    }
  }

  if (options.length === 0) {
    reporter.fail(label, `no legal event available in phase ${state.phase}`);
    return null;
  }
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = r() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.make();
  }
  return options[options.length - 1]!.make();
}

function emptyStats(wallMs: number): SequenceStats {
  return {
    steps: 0, terminal: 'open', ladderReached: 0, multiRound: 0, escalated: 0,
    conceded: 0, overturned: 0, expandedPanel: 0, illegalProbes: 0,
    typedRejections: 0, deepFreezeAudits: 0, wallMs,
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Run the campaign: `size` seeded sequences with sequence seed === index, so
 * every failure label is directly reproducible from the artifact alone.
 */
export function runConfirmationCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('confirmation', 'sequences', opts.size, seed);

  const perSequenceMs: number[] = [];
  const totals = {
    steps: 0,
    final: 0,
    expired: 0,
    aborted: 0,
    open: 0,
    ladderReached: 0,
    multiRound: 0,
    escalated: 0,
    conceded: 0,
    overturned: 0,
    expandedPanel: 0,
    illegalProbes: 0,
    typedRejections: 0,
    deepFreezeAudits: 0,
  };

  for (let index = 1; index <= opts.size; index += 1) {
    const sequenceStart = nowMs();
    const stats = runSequence(reporter, index);
    perSequenceMs.push(Math.round((nowMs() - sequenceStart) * 1000) / 1000);
    totals.steps += stats.steps;
    totals[stats.terminal] += 1;
    totals.ladderReached += stats.ladderReached;
    totals.multiRound += stats.multiRound;
    totals.escalated += stats.escalated;
    totals.conceded += stats.conceded;
    totals.overturned += stats.overturned;
    totals.expandedPanel += stats.expandedPanel;
    totals.illegalProbes += stats.illegalProbes;
    totals.typedRejections += stats.typedRejections;
    totals.deepFreezeAudits += stats.deepFreezeAudits;
  }

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      steps: totals.steps,
      meanStepsPerSequence: Math.round((totals.steps / Math.max(1, opts.size)) * 100) / 100,
      terminalFinal: totals.final,
      terminalExpired: totals.expired,
      terminalAborted: totals.aborted,
      terminalOpen: totals.open,
      ladderReached: totals.ladderReached,
      multiRound: totals.multiRound,
      escalated: totals.escalated,
      conceded: totals.conceded,
      overturned: totals.overturned,
      expandedPanel: totals.expandedPanel,
      illegalProbes: totals.illegalProbes,
      typedRejections: totals.typedRejections,
      deepFreezeAudits: totals.deepFreezeAudits,
      ...timingMetrics(perSequenceMs),
      sequenceWallMs: perSequenceMs,
    },
    [
      'per-sequence wall time is recorded in metrics.sequenceWallMs (index = sequence seed)',
      'hostile probes: 1 illegal event per step at p=0.35 + the full probe set every 11th step',
      'deep freeze audit: every step shallow, depth-first on a 1-in-17 sample',
    ],
  );
}
