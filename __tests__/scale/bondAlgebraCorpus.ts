// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 12 — per-round BOND-CONSUMPTION algebra (R31 / R33, the machine half
 * of `ΔC_R = 3^R · b₀`).
 *
 * The ladder's pricing theorem (`docs/proofs/economics/02-ladder.tex.md`
 * Theorem 2) says escalation round `R` costs `ΔC_R = 3^R b₀` on top of the
 * case's challenge bond, so reaching round `R` costs `(3^(R+1) − 1)/2 · b₀`
 * — 4/13/40/121/364× at R = 1..5. The AMOUNTS are the host's; the machine owns
 * the CONSUMPTION: one fresh bond witness per round, never reused, never a
 * relabelled membership bond. This campaign asserts the two halves agree.
 *
 * Every corpus unit is one LEGAL escalation sequence: drive a real case (7-seat
 * roster) from confirmations to `round_resolved`, then climb the ladder with
 * witnessed escalations until round `R` (R drawn 1..5), probing the illegal
 * presses at every rung.
 *
 * WHAT IT ASSERTS (A1–A6):
 *
 *   A1  ONE HASH, ONE INDEX — a `bondProofHash` buys exactly one challenger's
 *       standing: presenting the same witness for a second juror is a typed
 *       refusal and the challenge ledger keeps one owner of the hash.
 *   A2  NO RE-CONSUMPTION — replaying an already-consumed per-round bond
 *       witness, quoting a membership bond as "this round's payment", or
 *       skipping/rewinding the round index are all typed refusals, and a
 *       refused press never grows the witness log.
 *   A3  STRICTLY INCREASING ROUNDS — the accepted witness log is exactly
 *       `2..R` consecutive, one record per escalation, and `ladderRound`
 *       advances by exactly one per accepted press.
 *   A4  THE ΔC SCHEDULE — the marginal multiple for the e-th escalation is
 *       `3^e` and the cumulative multiple to reach ladder round `L` is
 *       `1 + Σ_{e=1..L−1} 3^e = (3^L − 1)/2`, which is what
 *       `cumulativeLadderBondMultiple(L − 1)` must return. The package's own
 *       schedule table is thereby checked against the geometric series rather
 *       than against itself.
 *   A5  CONSUMPTION COUNT PARITY — reaching ladder round `L` consumed exactly
 *       `L − 1` distinct witnesses, none of which is any membership bond and
 *       none of which repeats (the machine-level image of "pay for the rung").
 *   A6  every refusal is the machine's OWN typed error — never a raw throw.
 *
 * Unit of the corpus: one legal escalation sequence. A failure label carries the
 * unit seed, so the exact sequence is reproducible from the artifact.
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
import { cumulativeLadderBondMultiple, escalationBondMultiple } from '../../ladderEconomics';
import { childRng, int, pick } from '../helpers/rng';
import { CampaignReporter, nowMs, timingMetrics, type CampaignResult } from './corpus';

const SESSION = '5e'.repeat(32);
const PROPOSAL = '6f'.repeat(32);
const OUTCOMES = ['YES', 'NO'] as const;
const BASE_CLOCK = 1_900_000_000;
const ROSTER_SIZE = 7;

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

/** One accepted challenge bond in a sequence. */
interface BondRecord {
  readonly idx: number;
  readonly bondTxid: string;
  readonly bondProofHash: string;
}

interface SequenceStats {
  sequences: number;
  escalations: number;
  probes: number;
  typedRefusals: number;
  rawErrors: number;
  consumptionChecks: number;
  scheduleChecks: number;
  collisionProbes: number;
  membershipBondProbes: number;
  reuseProbes: number;
  roundRewindProbes: number;
  hostPolicyProbes: number;
  maxRoundsReached: number;
  roundsHistogram: Record<string, number>;
  perUnitMs: number[];
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Fisher–Yates from a seeded stream (deterministic, no CSPRNG). */
function shuffled<T>(r: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    const swap = out[i]!;
    out[i] = out[j]!;
    out[j] = swap;
  }
  return out;
}

/**
 * Run ONE legal escalation sequence and assert the algebra along the way.
 * `targetRound` is the ladder round the sequence climbs to (1..5).
 */
function runBondSequence(
  reporter: CampaignReporter,
  unitSeed: number,
  stats: SequenceStats,
): void {
  const r = childRng(unitSeed, 'bond-algebra');
  const targetRound = int(r, 1, MAX_LADDER_ROUNDS);
  const requireRoundBond = r() < 0.7; // the strict policy is the shipped default
  const hostEscalation = r() < 0.2;
  const roster = Array.from({ length: ROSTER_SIZE }, (_, i) => i + 1);
  const label = `bond#${unitSeed} [R=${targetRound}${requireRoundBond ? '/strict' : '/legacy'}`
    + `${hostEscalation ? '/host' : ''}]`;
  const started = nowMs();
  stats.sequences += 1;
  stats.roundsHistogram[String(targetRound)] = (stats.roundsHistogram[String(targetRound)] ?? 0) + 1;
  if (targetRound > stats.maxRoundsReached) stats.maxRoundsReached = targetRound;

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
    maxLadderRounds: targetRound,
    ...(requireRoundBond ? { requireRoundBond: true } : {}),
    ...(hostEscalation ? { hostEscalation: true } : {}),
  });
  const reduce = (event: CourtConfirmationMachineEvent): CourtConfirmationMachineState => {
    state = reduceCourtConfirmationMachine(state, event);
    return state;
  };

  roster.forEach((idx, offset) => {
    reduce({
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: id(unitSeed, `conf-${idx}`),
      now: BASE_CLOCK + 1 + offset,
    });
  });
  reduce({ type: 'close_confirmations', now: confirmDeadline });
  reduce({ type: 'open_challenge_window', now: confirmDeadline + 10 });

  // ── A1: one hash, one index — with DELIBERATE collisions in the pool ──────
  const challengerCount = int(r, 2, 5);
  const challengers = shuffled(r, roster).slice(0, challengerCount);
  const bonds: BondRecord[] = [];
  for (let c = 0; c < challengerCount; c += 1) {
    const idx = challengers[c]!;
    const bond: BondRecord = {
      idx,
      // The pool deliberately collides: every third bond reuses an earlier
      // txid, and the witness is mixed with the juror index (the documented
      // host fix for a colliding derivation).
      bondTxid: id(unitSeed, `bond-txid-${Math.floor(c / 3)}`),
      bondProofHash: id(unitSeed, `bond-proof-${idx}`),
    };
    bonds.push(bond);
    const accepted = attempt(() => reduce({
      type: 'accept_challenge',
      idx: bond.idx,
      bondTxid: bond.bondTxid,
      bondProofHash: bond.bondProofHash,
      eventId: id(unitSeed, `challenge-${idx}`),
      now: confirmDeadline + 100 + c,
    }));
    if (!accepted.ok) {
      reporter.fail(label, `A1: a legal challenge for juror ${idx} was refused: ${describe(accepted.error)}`);
      return;
    }
  }
  // The duplicate-owner press: juror `victim` claims the FIRST bond's witness.
  const victim = shuffled(r, roster).find((idx) => !challengers.includes(idx)) ?? roster[ROSTER_SIZE - 1]!;
  const claimed = bonds[0]!;
  const duplicate = attempt(() => reduceCourtConfirmationMachine(state, {
    type: 'accept_challenge',
    idx: victim,
    bondTxid: id(unitSeed, 'victim-txid'),
    bondProofHash: claimed.bondProofHash,
    eventId: id(unitSeed, 'victim-event'),
    now: confirmDeadline + 900,
  }));
  stats.collisionProbes += 1;
  stats.probes += 1;
  if (duplicate.ok) {
    reporter.fail(
      label,
      `A1: the SAME bond witness bought a second challenger's standing (juror ${victim} claimed juror ${claimed.idx}'s bond)`,
    );
  } else if (!(duplicate.error instanceof CourtConfirmationTransitionError)) {
    stats.rawErrors += 1;
    reporter.fail(label, `A6: the duplicate-owner refusal was UNTYPED: ${describe(duplicate.error)}`);
  } else {
    stats.typedRefusals += 1;
    reporter.check();
  }
  reporter.equals(
    label,
    state.challenges.filter((record) => record.bondProofHash === claimed.bondProofHash).length,
    1,
    'A1: one bond proof hash must stay bound to exactly one roster index',
  );
  stats.consumptionChecks += 1;

  reduce({ type: 'close_challenge_window', now: challengeDeadline });

  // ── the ladder ───────────────────────────────────────────────────────────
  let clock = challengeDeadline + 100;
  let round = 1;
  const consumed: string[] = [];
  const membershipBonds = new Set(state.challenges.map((record) => record.bondProofHash));

  const playRound = (roundIndex: number): void => {
    const voteDeadline = clock + 1_000;
    reduce({ type: 'open_ladder_round', round: roundIndex, voteDeadline, now: clock });
    roster.forEach((idx, offset) => {
      reduce({
        type: 'accept_mass_vote',
        idx,
        // Majority NO so every round overturns the YES proposal.
        outcome: 'NO',
        eventId: id(unitSeed, `vote-${roundIndex}-${idx}`),
        now: clock + 1 + offset,
      });
    });
    reduce({ type: 'close_ladder_round', now: voteDeadline });
    reduce({ type: 'resolve_round', now: voteDeadline + 1 });
    clock = voteDeadline + 2;
  };

  playRound(round);

  while (round < targetRound) {
    if (state.phase !== 'round_resolved') {
      reporter.fail(label, `SETUP: expected round_resolved at round ${round}, got ${state.phase}`);
      return;
    }
    reporter.equals(label, state.ladderRound, round, 'A3: ladderRound equals the round being resolved');
    // The e-th escalation opens ladder round e+1.
    const e = round;
    const roundBond = id(unitSeed, `round-bond-${e}`);
    const logBefore = state.escalationLog.length;

    // ── A2 (re-consumption) ───────────────────────────────────────────────
    if (consumed.length > 0) {
      const replay = attempt(() => reduceCourtConfirmationMachine(
        state,
        challengerEscalationEvent(state, clock, {
          challengerIdx: pick(r, bonds).idx,
          challengerPubkey: id(unitSeed, `esc-pk-${e}`),
          requestHash: id(unitSeed, `esc-request-replay-${e}`),
          roundBondProofHash: pick(r, consumed),
        }),
      ));
      stats.reuseProbes += 1;
      stats.probes += 1;
      if (replay.ok) {
        reporter.fail(label, `A2: an ALREADY-CONSUMED round bond was accepted again at round ${e + 1}`);
      } else if (!(replay.error instanceof CourtConfirmationTransitionError)) {
        stats.rawErrors += 1;
        reporter.fail(label, `A6: the re-consumption refusal was UNTYPED: ${describe(replay.error)}`);
      } else {
        stats.typedRefusals += 1;
        reporter.check();
      }
      reporter.equals(
        label,
        state.escalationLog.length,
        logBefore,
        'A2: a refused re-consumption must not grow the witness log',
      );
    }

    // ── A2 (membership bond relabelled as the round's payment) ────────────
    const relabel = attempt(() => reduceCourtConfirmationMachine(
      state,
      challengerEscalationEvent(state, clock, {
        challengerIdx: pick(r, bonds).idx,
        challengerPubkey: id(unitSeed, `esc-pk-relabel-${e}`),
        requestHash: id(unitSeed, `esc-request-relabel-${e}`),
        roundBondProofHash: pick(r, [...membershipBonds]),
      }),
    ));
    stats.membershipBondProbes += 1;
    stats.probes += 1;
    if (relabel.ok) {
      reporter.fail(label, `A2: a MEMBERSHIP bond was accepted as round ${e + 1}'s per-round payment`);
    } else if (!(relabel.error instanceof CourtConfirmationTransitionError)) {
      stats.rawErrors += 1;
      reporter.fail(label, `A6: the membership-bond refusal was UNTYPED: ${describe(relabel.error)}`);
    } else {
      stats.typedRefusals += 1;
      reporter.check();
    }

    // ── A3 (round rewind: press for the round ALREADY open) ───────────────
    const rewind = attempt(() => reduceCourtConfirmationMachine(state, {
      type: 'escalate',
      authority: 'challenger',
      challengerIdx: bonds[0]!.idx,
      challengerPubkey: id(unitSeed, `esc-pk-rewind-${e}`),
      requestHash: id(unitSeed, `esc-request-rewind-${e}`),
      bondProofHash: bonds[0]!.bondProofHash,
      roundBondProofHash: id(unitSeed, `rewind-round-bond-${e}`),
      roundIndex: round,
      now: clock,
    }));
    stats.roundRewindProbes += 1;
    stats.probes += 1;
    if (rewind.ok) {
      reporter.fail(label, `A3: a replayed roundIndex (${round}) opened a rung instead of the next one`);
    } else if (!(rewind.error instanceof CourtConfirmationTransitionError)) {
      stats.rawErrors += 1;
      reporter.fail(label, `A6: the round-rewind refusal was UNTYPED: ${describe(rewind.error)}`);
    } else {
      stats.typedRefusals += 1;
      reporter.check();
    }

    // ── A2 (host authority without the frozen break-glass policy) ─────────
    if (!hostEscalation) {
      const hostPress = attempt(() => reduceCourtConfirmationMachine(state, {
        type: 'escalate',
        authority: 'host',
        challengerIdx: null,
        challengerPubkey: null,
        requestHash: null,
        bondProofHash: null,
        roundIndex: round + 1,
        now: clock,
      }));
      stats.hostPolicyProbes += 1;
      stats.probes += 1;
      if (hostPress.ok) {
        reporter.fail(label, 'A2: a HOST escalation was accepted on a case without the break-glass policy');
      } else if (!(hostPress.error instanceof CourtConfirmationTransitionError)) {
        stats.rawErrors += 1;
        reporter.fail(label, `A6: the host-policy refusal was UNTYPED: ${describe(hostPress.error)}`);
      } else {
        stats.typedRefusals += 1;
        reporter.check();
      }
    }

    // ── the LEGAL press ───────────────────────────────────────────────────
    const witness = hostEscalation && r() < 0.5
      ? hostEscalationEvent(state, clock)
      : challengerEscalationEvent(state, clock, {
        challengerIdx: pick(r, bonds).idx,
        challengerPubkey: id(unitSeed, `esc-pk-${e}-ok`),
        requestHash: id(unitSeed, `esc-request-${e}-ok`),
        roundBondProofHash: roundBond,
      });
    const pressed = attempt(() => reduce(witness));
    stats.escalations += 1;
    if (!pressed.ok) {
      reporter.fail(label, `A3: a LEGAL escalation at round ${round} was refused: ${describe(pressed.error)}`);
      return;
    }
    const after = pressed.value;
    if (after.phase !== 'ladder_pending') {
      reporter.fail(label, `A3: an accepted escalation must park in ladder_pending, got ${after.phase}`);
      return;
    }
    reporter.equals(label, after.escalationLog.length, logBefore + 1, 'A3: one witness record per escalation');
    const record = after.escalationLog[after.escalationLog.length - 1]!;
    const paidWith = (witness as { readonly roundBondProofHash?: string | null }).roundBondProofHash ?? null;
    reporter.equals(label, record.round, e + 1, 'A3: the record opens round e+1');
    reporter.equals(
      label,
      record.roundBondProofHash ?? null,
      paidWith,
      'A2: the record carries the witness the challenger paid with',
    );
    if (paidWith === null) {
      // Only a break-glass HOST press may omit the per-round witness.
      reporter.equals(label, witness.authority, 'host', 'A2: only a host press omits the per-round witness');
    } else {
      reporter.ok(label, !membershipBonds.has(paidWith), 'A5: a per-round witness is never a membership bond');
      reporter.ok(
        label,
        !consumed.includes(paidWith),
        'A2: every accepted per-round witness is fresh (never re-used within a sequence)',
      );
      consumed.push(paidWith);
    }

    // ── A4: the ΔC schedule against the geometric series ──────────────────
    const marginal = escalationBondMultiple(e);
    reporter.equals(label, marginal, 3 ** e, `A4: ΔC_${e} / b₀ must be 3^${e}`);
    const cumulative = cumulativeLadderBondMultiple(e);
    const geometric = 1 + Array.from({ length: e }, (_, k) => 3 ** (k + 1)).reduce((a, b) => a + b, 0);
    reporter.equals(
      label,
      cumulative,
      geometric,
      `A4: the cumulative multiple to reach ladder round ${e + 1} must be 1 + Σ 3^k`,
    );
    stats.scheduleChecks += 2;
    reporter.equals(
      label,
      cumulativeLadderBondMultiple(e),
      (3 ** (e + 1) - 1) / 2,
      'A4: the cumulative multiple must be (3^(e+1) − 1)/2',
    );
    stats.scheduleChecks += 1;
    stats.consumptionChecks += 5;

    round = e + 1;
    clock += 1;
    playRound(round);
  }

  // ── A5: consumption-count parity at the top of the sequence ─────────────
  const log = state.escalationLog;
  reporter.equals(label, log.length, targetRound - 1, 'A3: reaching round L recorded exactly L-1 escalations');
  reporter.equalStrings(
    label,
    log.map((record) => String(record.round)),
    Array.from({ length: Math.max(0, targetRound - 1) }, (_, k) => String(k + 2)),
    'A3: the accepted log must be exactly the consecutive sequence 2..L',
  );
  const consumedFromLog = log
    .map((record) => record.roundBondProofHash)
    .filter((value): value is string => typeof value === 'string');
  reporter.equals(
    label,
    new Set(consumedFromLog).size,
    consumedFromLog.length,
    'A2: no per-round witness may appear in two accepted records',
  );
  reporter.ok(
    label,
    consumedFromLog.every((value) => !membershipBonds.has(value)),
    'A5: no accepted per-round witness is a membership bond of the case',
  );
  reporter.equals(
    label,
    state.ladderRound,
    targetRound,
    'A3: the ladder ends at exactly the target round (strictly increasing, no skips)',
  );
  reporter.equals(
    label,
    state.phase,
    'fee_settlement',
    'A3: resolving the last permitted round settles fees',
  );
  stats.consumptionChecks += 5;
  stats.perUnitMs.push(round3(nowMs() - started));
}

/**
 * Run the campaign: `size` legal escalation sequences. The unit seed is
 * `seed + index`, so a failure label reproduces the exact sequence.
 */
export function runBondAlgebraCampaign(opts: {
  readonly size: number;
  readonly seed?: number;
}): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('bondAlgebra', 'sequences', opts.size, seed);
  const stats: SequenceStats = {
    sequences: 0,
    escalations: 0,
    probes: 0,
    typedRefusals: 0,
    rawErrors: 0,
    consumptionChecks: 0,
    scheduleChecks: 0,
    collisionProbes: 0,
    membershipBondProbes: 0,
    reuseProbes: 0,
    roundRewindProbes: 0,
    hostPolicyProbes: 0,
    maxRoundsReached: 0,
    roundsHistogram: {},
    perUnitMs: [],
  };

  for (let index = 1; index <= opts.size; index += 1) runBondSequence(reporter, seed + index, stats);

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      sequences: stats.sequences,
      legalEscalations: stats.escalations,
      illegalProbes: stats.probes,
      typedRefusals: stats.typedRefusals,
      rawErrors: stats.rawErrors,
      collisionProbes: stats.collisionProbes,
      reuseProbes: stats.reuseProbes,
      membershipBondProbes: stats.membershipBondProbes,
      roundRewindProbes: stats.roundRewindProbes,
      hostPolicyProbes: stats.hostPolicyProbes,
      consumptionChecks: stats.consumptionChecks,
      scheduleChecks: stats.scheduleChecks,
      maxRoundsReached: stats.maxRoundsReached,
      distinctRounds: Object.keys(stats.roundsHistogram).length,
      ...Object.fromEntries(Object.entries(stats.roundsHistogram).map(([round, count]) => [`rounds_${round}`, count])),
      ...timingMetrics(stats.perUnitMs),
    },
    [
      `target rounds 1..${MAX_LADDER_ROUNDS} (${Object.keys(stats.roundsHistogram).sort().join(', ')} all exercised)`,
      'rosters are 7 seats; challengers are drawn 2..5 with DELIBERATE bond-pool collisions (repeated txids)',
      'the ΔC schedule is checked against the geometric series 3^e, not against the package\'s own table',
      'A1 one-hash-one-index, A2 no re-consumption, A3 strictly increasing rounds, A4 3^e growth, A5 consumption parity, A6 typed refusals only',
    ],
  );
}
