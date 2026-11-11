// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

// Per-event transition handlers for the universal-confirmation machine
// (extracted from `courtConfirmationMachine.ts`). One named handler per
// event type, named after the event it applies: `onAcceptConfirmation`
// applies `accept_confirmation`, and so on. Each handler receives the
// clock-advanced state (the reducer's preamble guarantees monotonic time)
// and returns the next deep-frozen state. Pure: no I/O, no wall clock.

import { compareOutcomeUtf8, hashCourtVerdict } from './courtVoteMachine';
import { assertPositiveDeadline } from './courtCeremonyCore';
import {
  CourtClawbackFlag,
  CourtConfirmationMachineEvent,
  CourtConfirmationMachineState,
  CourtConfirmationTransitionError,
  CourtEscalationRecord,
  CourtRoundOutcomeRecord,
} from './confirmationMachineTypes';
import {
  MAX_CHALLENGES,
  MAX_CLAWBACK_FLAGS,
  MAX_CONFIRMATIONS,
  MAX_FEES,
  MAX_LADDER_ROUNDS,
  MAX_MASS_VOTES,
  MAX_REASON_BYTES,
  TERMINAL_PHASES,
  TICK_DEADLINES,
  assertBeforeDeadline,
  assertHex32,
  assertParticipant,
  assertRoundParticipant,
  assertValidConfirmationLedger,
  assertValidEscalationLog,
  assertValidMassVoteLedger,
  assertValidOutcomeHistory,
  freezeState,
  hashCourtConfirmation,
  normalizeRoundRoster,
  textEncoder,
} from './confirmationMachineCore';

type ConfirmEvent = CourtConfirmationMachineEvent;

/** Apply a `tick`: expire the current phase when its deadline has passed. */
export function onTick(state: CourtConfirmationMachineState, event: Extract<ConfirmEvent, { type: 'tick' }>): CourtConfirmationMachineState {
  // `ladder_vote_closed`, `round_resolved` and `fee_settlement` are one
  // step from (or at) a mandatory explicit transition — a tick must not
  // expire them (mirrors the vote machine's `reveal_closed` exemption).
  // `round_resolved` waits on the host's appeal decision (`escalate` /
  // `concede`); the appeal window itself is host policy, not a deadline
  // this machine tracks.
  if (TERMINAL_PHASES.has(state.phase) || state.phase === 'ladder_vote_closed' || state.phase === 'round_resolved' || state.phase === 'fee_settlement' || state.phase === 'ladder_pending') {
    return freezeState(state);
  }
  const deadline = TICK_DEADLINES[state.phase]?.(state);
  if (deadline === undefined || event.now < deadline) {
    return freezeState(state);
  }
  return freezeState({
    ...state,
    phase: 'expired',
    failure: { phase: 'expired', reason: `The ${state.phase} deadline passed before resolution.` },
  });
}

/** Apply an `abort`: operator cancel from any non-terminal phase. */
export function onAbort(state: CourtConfirmationMachineState, event: Extract<ConfirmEvent, { type: 'abort' }>): CourtConfirmationMachineState {
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtConfirmationTransitionError(`cannot abort confirmation from ${state.phase}`);
  }
  return freezeState({
    ...state,
    phase: 'aborted',
    failure: { phase: 'aborted', reason: event.reason },
  });
}

/** Apply an `accept_confirmation`: bind a juror's canonical endorsement hash. */
export function onAcceptConfirmation(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'accept_confirmation' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'confirm_open') {
    throw new CourtConfirmationTransitionError(
      `cannot accept confirmations during ${state.phase}`,
    );
  }
  assertBeforeDeadline(event.now, state.confirmDeadline, 'confirmation arrived at or after the confirm deadline');
  assertParticipant(state, event.idx);
  assertHex32(event.confirmHash, 'confirmation hash must be 32-byte lowercase hex');
  assertHex32(event.eventId, 'confirmation event id must be 32-byte lowercase hex');
  const expected = hashCourtConfirmation({
    sessionHash: state.sessionHash,
    proposalHash: state.proposalHash,
    idx: event.idx,
  });
  if (expected !== event.confirmHash) {
    throw new CourtConfirmationTransitionError(
      `confirmation from participant ${event.idx} does not match the canonical confirmation hash`,
    );
  }
  if (state.confirmations.length >= MAX_CONFIRMATIONS) {
    throw new CourtConfirmationTransitionError(
      `confirmation ledger exceeds maximum of ${MAX_CONFIRMATIONS} entries`,
    );
  }
  const existing = state.confirmations.find((c) => c.idx === event.idx);
  if (existing) {
    if (existing.confirmHash === event.confirmHash && existing.eventId === event.eventId) {
      return freezeState(state);
    }
    throw new CourtConfirmationTransitionError(
      `participant ${event.idx} published a conflicting confirmation`,
    );
  }
  return freezeState({
    ...state,
    confirmations: [
      ...state.confirmations,
      { idx: event.idx, confirmHash: event.confirmHash, eventId: event.eventId },
    ],
  });
}

/** Apply a `close_confirmations`: close the window once the quorum is met. */
export function onCloseConfirmations(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'close_confirmations' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'confirm_open') {
    throw new CourtConfirmationTransitionError(`cannot close confirmations during ${state.phase}`);
  }
  if (event.now < state.confirmDeadline) {
    throw new CourtConfirmationTransitionError(
      'cannot close confirmations before the confirm deadline',
    );
  }
  // Fail closed: a quorum that never formed must be expired by a tick (or
  // aborted by the host), never silently closed.
  if (state.confirmations.length < state.confirmQuorum) {
    throw new CourtConfirmationTransitionError(
      `confirm quorum not met: ${state.confirmations.length}/${state.confirmQuorum}`,
    );
  }
  return freezeState({ ...state, phase: 'confirm_closed' });
}

/** Apply an `open_challenge_window`. */
export function onOpenChallengeWindow(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'open_challenge_window' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'confirm_closed') {
    throw new CourtConfirmationTransitionError(
      `cannot open the challenge window during ${state.phase}`,
    );
  }
  assertBeforeDeadline(event.now, state.challengeDeadline, 'cannot open the challenge window at or after the challenge deadline');
  return freezeState({ ...state, phase: 'challenge_window' });
}

/** Apply an `accept_challenge`: bind a verified bond witness to a challenge. */
export function onAcceptChallenge(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'accept_challenge' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'challenge_window') {
    throw new CourtConfirmationTransitionError(
      `cannot accept challenges during ${state.phase}`,
    );
  }
  assertBeforeDeadline(event.now, state.challengeDeadline, 'challenge arrived at or after the challenge deadline');
  assertParticipant(state, event.idx);
  assertHex32(event.bondTxid, 'challenge bond txid must be 32-byte lowercase hex');
  assertHex32(event.bondProofHash, 'challenge bond proof hash must be 32-byte lowercase hex');
  assertHex32(event.eventId, 'challenge event id must be 32-byte lowercase hex');
  if (state.challenges.length >= MAX_CHALLENGES) {
    throw new CourtConfirmationTransitionError(
      `challenge ledger exceeds maximum of ${MAX_CHALLENGES} entries`,
    );
  }
  const existing = state.challenges.find((c) => c.idx === event.idx);
  if (existing) {
    if (
      existing.bondTxid === event.bondTxid &&
      existing.bondProofHash === event.bondProofHash &&
      existing.eventId === event.eventId
    ) {
      return freezeState(state);
    }
    throw new CourtConfirmationTransitionError(
      `participant ${event.idx} published a conflicting challenge`,
    );
  }
  return freezeState({
    ...state,
    challenges: [
      ...state.challenges,
      { idx: event.idx, bondTxid: event.bondTxid, bondProofHash: event.bondProofHash, eventId: event.eventId },
    ],
  });
}

/** Apply a `close_challenge_window`: with no challenge the proposal stands. */
export function onCloseChallengeWindow(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'close_challenge_window' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'challenge_window') {
    throw new CourtConfirmationTransitionError(
      `cannot close the challenge window during ${state.phase}`,
    );
  }
  if (event.now < state.challengeDeadline) {
    throw new CourtConfirmationTransitionError(
      'cannot close the challenge window before the challenge deadline',
    );
  }
  return freezeState({
    ...state,
    phase: state.challenges.length > 0 ? 'ladder_pending' : 'fee_settlement',
    // The no-challenge path resolves immediately: the proposal stands and
    // finalize computes the canonical verdict from the confirmation ledger.
    verdict:
      state.challenges.length > 0
        ? state.verdict
        : { outcome: state.proposedOutcome, supportingEventIds: [], verdictHash: '', upheld: true },
  });
}

/** Apply an `open_ladder_round`: open round N's mass vote. */
export function onOpenLadderRound(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'open_ladder_round' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'ladder_pending') {
    throw new CourtConfirmationTransitionError(
      `cannot open a ladder round during ${state.phase}`,
    );
  }
  if (
    !Number.isSafeInteger(event.round)
    || event.round !== state.ladderRound + 1
  ) {
    throw new CourtConfirmationTransitionError(
      `ladder rounds must be consecutive: expected ${state.ladderRound + 1}`,
    );
  }
  // Defense in depth: a hand-restored `ladder_pending` snapshot cannot
  // open a round beyond the case's frozen ladder cap (the legal path —
  // `escalate` — already refuses to exceed it).
  if (event.round > state.maxLadderRounds) {
    throw new CourtConfirmationTransitionError(
      `ladder round ${event.round} exceeds maxLadderRounds ${state.maxLadderRounds}`,
    );
  }
  assertPositiveDeadline(event.voteDeadline, 'voteDeadline', CourtConfirmationTransitionError);
  assertBeforeDeadline(event.now, event.voteDeadline, 'cannot open a ladder round with a past vote deadline');
  const roundRoster = event.roundRoster === undefined
    ? state.participantIndices
    : normalizeRoundRoster(event.roundRoster);
  return freezeState({
    ...state,
    phase: 'ladder_vote_open',
    ladderRound: event.round,
    ladder: { round: event.round, voteDeadline: event.voteDeadline, votes: [], roundRoster },
  });
}

/** Apply an `accept_mass_vote`: record one round-panel vote. */
export function onAcceptMassVote(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'accept_mass_vote' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'ladder_vote_open' || !state.ladder) {
    throw new CourtConfirmationTransitionError(`cannot accept mass votes during ${state.phase}`);
  }
  assertBeforeDeadline(event.now, state.ladder.voteDeadline, 'mass vote arrived at or after the round deadline');
  assertRoundParticipant(state, event.idx);
  if (typeof event.outcome !== 'string' || !state.allowedOutcomes.includes(event.outcome)) {
    throw new CourtConfirmationTransitionError(
      'mass vote names an outcome outside the frozen allowlist',
    );
  }
  assertHex32(event.eventId, 'mass vote event id must be 32-byte lowercase hex');
  if (state.ladder.votes.length >= MAX_MASS_VOTES) {
    throw new CourtConfirmationTransitionError(
      `mass vote ledger exceeds maximum of ${MAX_MASS_VOTES} entries`,
    );
  }
  const existing = state.ladder.votes.find((v) => v.idx === event.idx);
  if (existing) {
    if (existing.outcome === event.outcome && existing.eventId === event.eventId) {
      return freezeState(state);
    }
    throw new CourtConfirmationTransitionError(
      `participant ${event.idx} published a conflicting mass vote`,
    );
  }
  return freezeState({
    ...state,
    ladder: {
      ...state.ladder,
      votes: [...state.ladder.votes, { idx: event.idx, outcome: event.outcome, eventId: event.eventId }],
    },
  });
}

/** Apply a `close_ladder_round`: close the round's vote window. */
export function onCloseLadderRound(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'close_ladder_round' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'ladder_vote_open' || !state.ladder) {
    throw new CourtConfirmationTransitionError(`cannot close the ladder round during ${state.phase}`);
  }
  if (event.now < state.ladder.voteDeadline) {
    throw new CourtConfirmationTransitionError(
      'cannot close the ladder round before the round deadline',
    );
  }
  assertValidMassVoteLedger(state);
  return freezeState({ ...state, phase: 'ladder_vote_closed' });
}

/** Apply a `resolve_round`: tally the round, flag clawbacks, record history. */
export function onResolveRound(
  state: CourtConfirmationMachineState,
  _event: Extract<ConfirmEvent, { type: 'resolve_round' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'ladder_vote_closed' || !state.ladder) {
    throw new CourtConfirmationTransitionError(`cannot resolve a round during ${state.phase}`);
  }
  assertValidMassVoteLedger(state);
  assertValidConfirmationLedger(state);
  // Outcome-history barrier (finding F-3): the flip-flop rule below steers
  // `round_flip` clawbacks from `previous.winnerIndices` — a hand-restored
  // (forged) history must be re-verified before it directs clawbacks.
  assertValidOutcomeHistory(state);
  if (state.ladder.votes.length === 0) {
    throw new CourtConfirmationTransitionError('cannot resolve a round without any valid mass vote');
  }
  const { winner, upheld } = tallyRoundVotes(state);
  const round = state.ladder.round;
  const outcomeHistory = appendRoundOutcome(state, round, winner);
  const clawbackFlags = applyRoundClawbacks(state, round, winner, upheld);
  // Compatibility rule: the final permitted round settles fees directly
  // (the v0.8.5 single-round flow with maxLadderRounds = 1, or the last
  // round of a longer ladder); any earlier resolution parks in
  // `round_resolved` where the host plays `escalate` or `concede` — the
  // machine never auto-escalates and never auto-concedes.
  const isFinalRound = round >= state.maxLadderRounds;
  return freezeState({
    ...state,
    phase: isFinalRound ? 'fee_settlement' : 'round_resolved',
    clawbackFlags,
    outcomeHistory,
    verdict: {
      outcome: winner,
      supportingEventIds: [],
      verdictHash: '',
      upheld,
    },
  });
}

/**
 * Majority outcome of the current ladder round; ties break deterministically
 * exactly as the vote machine's tally (lexicographic unsigned UTF-8 byte
 * order).
 */
function tallyRoundVotes(state: CourtConfirmationMachineState): { winner: string; upheld: boolean } {
  const counts = new Map<string, string[]>();
  for (const vote of state.ladder!.votes) {
    const list = counts.get(vote.outcome) ?? [];
    list.push(vote.eventId);
    counts.set(vote.outcome, list);
  }
  let winner = '';
  let winnerCount = -1;
  for (const [outcome, eventIds] of counts.entries()) {
    if (
      eventIds.length > winnerCount ||
      (eventIds.length === winnerCount && compareOutcomeUtf8(outcome, winner) < 0)
    ) {
      winner = outcome;
      winnerCount = eventIds.length;
    }
  }
  return { winner, upheld: winner === state.proposedOutcome };
}

/** Append this round's outcome record (append-only history, §4.2). */
function appendRoundOutcome(
  state: CourtConfirmationMachineState,
  round: number,
  winner: string,
): readonly CourtRoundOutcomeRecord[] {
  const winnerEventIds = state.ladder!.votes
    .filter((v) => v.outcome === winner)
    .map((v) => v.eventId)
    .map((e) => e.toLowerCase())
    .sort();
  const winnerIndices = state.ladder!.votes
    .filter((v) => v.outcome === winner)
    .map((v) => v.idx);
  return [
    ...state.outcomeHistory,
    { round, outcome: winner, winnerEventIds, winnerIndices },
  ];
}

/**
 * Clawback flags produced by this resolution: `overturned_confirmation` when
 * the proposal was overturned (every confirming juror, once) and `round_flip`
 * when round r's winner differs from round r-1's winner (r-1's majority
 * followed an outcome the next panel rejected). Flagging is a state
 * transition, never a side effect, and idempotent per (idx, reason[, round]).
 */
function applyRoundClawbacks(
  state: CourtConfirmationMachineState,
  round: number,
  winner: string,
  upheld: boolean,
): readonly CourtClawbackFlag[] {
  let clawbackFlags = state.clawbackFlags;
  if (!upheld) {
    // The proposal was overturned: every confirming juror is flagged for
    // fee clawback. Flagging is a state transition, never a side effect,
    // and idempotent per (idx, reason): later rounds that also reject the
    // proposal must not duplicate the original confirmers' flags.
    const alreadyFlagged = new Set(
      clawbackFlags.filter((f) => f.reason === 'overturned_confirmation').map((f) => f.idx),
    );
    const flags = state.confirmations
      .filter((c) => !alreadyFlagged.has(c.idx))
      .map((c) => ({ idx: c.idx, reason: 'overturned_confirmation', round }));
    if (flags.length > 0) {
      clawbackFlags = [...clawbackFlags, ...flags];
    }
  }
  // Flip-flop rule (§4.2): when round r's winner differs from round r-1's
  // winner, round r-1's majority voters followed an outcome the next panel
  // rejected — flag them for clawback with reason `round_flip`, idempotent
  // per (idx, reason, round).
  const previous = state.outcomeHistory[state.outcomeHistory.length - 1];
  if (previous && previous.outcome !== winner) {
    const alreadyFlipped = new Set(
      clawbackFlags
        .filter((f) => f.reason === 'round_flip' && f.round === previous.round)
        .map((f) => f.idx),
    );
    const flipFlags = previous.winnerIndices
      .filter((idx) => !alreadyFlipped.has(idx))
      .map((idx) => ({ idx, reason: 'round_flip', round: previous.round }));
    if (flipFlags.length > 0) {
      clawbackFlags = [...clawbackFlags, ...flipFlags];
    }
  }
  return clawbackFlags;
}

/**
 * Apply an `escalate`: open the next ladder round under a validated authority
 * witness (SPEC §9.2, INV-ESC-1…6).
 *
 * The machine — not the host API — decides whether the move is authorised:
 *
 *  - the phase must allow it (`round_resolved`) and the ladder cap must not be
 *    reached (fail closed on a hand-restored snapshot);
 *  - `roundIndex` must open exactly the NEXT round (`ladderRound + 1`), so a
 *    witness minted for another round cannot be replayed;
 *  - `authority: "challenger"` requires a case-roster participant, a 32-byte
 *    x-only pubkey, a 32-byte request hash, and the bond-proof hash of a
 *    challenge the machine has ALREADY accepted (the witness is bound to
 *    state, not merely well-formed);
 *  - the per-round bond witness (`roundBondProofHash`, R31) must be distinct
 *    from that membership bond and never reused: when the case sets
 *    `requireRoundBond` it is mandatory (break-glass host cases aside, where the
 *    host escalates free anyway), so one bond can no longer fund every round;
 *  - `authority: "host"` requires the frozen `hostEscalation` policy (default
 *    false) and must not carry a challenger request.
 *
 * The validated witness is appended to `escalationLog` (append-only), so an
 * observer can re-derive who escalated, for which round, against which request
 * and bond. A host that bypasses its own API cannot skip this check: the event
 * is the only way into the next round, and an unwitnessed event is a typed
 * error.
 */
export function onEscalate(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'escalate' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'round_resolved') {
    throw new CourtConfirmationTransitionError(
      `cannot escalate during ${state.phase}`,
    );
  }
  // Fail closed: a hand-restored snapshot parked at round_resolved with
  // the cap already reached must not re-open the ladder.
  if (state.ladderRound >= state.maxLadderRounds) {
    throw new CourtConfirmationTransitionError(
      `maxLadderRounds ${state.maxLadderRounds} already reached at round ${state.ladderRound}`,
    );
  }
  const log = state.escalationLog ?? [];
  if (log.length >= MAX_LADDER_ROUNDS) {
    throw new CourtConfirmationTransitionError(
      `escalation log exceeds the ${MAX_LADDER_ROUNDS}-round ladder bound`,
    );
  }
  const expectedRound = state.ladderRound + 1;
  const authority = event.authority;
  if (authority !== 'challenger' && authority !== 'host') {
    throw new CourtConfirmationTransitionError(
      'escalation requires an authority witness: authority must be "challenger" or "host"',
    );
  }
  if (event.roundIndex !== expectedRound) {
    throw new CourtConfirmationTransitionError(
      `escalation roundIndex ${String(event.roundIndex)} does not open the next ladder round ${expectedRound}`,
    );
  }
  let record: CourtEscalationRecord;
  const roundBondProofHash = event.roundBondProofHash ?? null;
  if (roundBondProofHash !== null) {
    assertHex32(
      roundBondProofHash,
      'escalation round bond proof hash must be 32-byte lowercase hex',
    );
  }
  if (authority === 'challenger') {
    const idx = event.challengerIdx;
    if (!Number.isSafeInteger(idx)) {
      throw new CourtConfirmationTransitionError(
        'challenger escalation requires a safe-integer challengerIdx',
      );
    }
    assertParticipant(state, idx as number);
    assertHex32(
      event.challengerPubkey as string,
      'escalation challenger pubkey must be 32-byte lowercase hex',
    );
    assertHex32(
      event.requestHash as string,
      'escalation request hash must be 32-byte lowercase hex',
    );
    assertHex32(
      event.bondProofHash as string,
      'escalation bond proof hash must be 32-byte lowercase hex',
    );
    // Bind the witness to a bond THIS challenger posted: a well-formed hash for
    // a bond the case never saw proves nothing, and a bond some OTHER juror
    // posted proves nothing either. Without the `idx` half (round-3 finding
    // r29-1) a juror who posted no bond could escalate by quoting a bonded
    // juror's hash, and the witness log would name the wrong challenger.
    if (!state.challenges.some(
      (c) => c.idx === (idx as number) && c.bondProofHash === event.bondProofHash,
    )) {
      throw new CourtConfirmationTransitionError(
        'escalation bond proof hash does not match an accepted challenge bond of this challenger',
      );
    }
    // Per-round bond (R31, r30-1): the challenge bond proves MEMBERSHIP — it is
    // posted once and funds every round, which made escalation free at the
    // margin. A round bond proves the challenger PAID for this rung: it must be
    // a DIFFERENT witness (relabelling the membership bond is not a payment)
    // and it must never have been consumed by an earlier escalation.
    if (roundBondProofHash === null) {
      // Compatibility matrix: a witness without a round bond stays legal on the
      // default policy (`requireRoundBond` false — every v0.12 case) and for a
      // break-glass case, where the host may already open rounds on its own
      // authority, so demanding one from the challenger prices nothing.
      if (state.requireRoundBond === true && state.hostEscalation !== true) {
        throw new CourtConfirmationTransitionError(
          'escalation requires a per-round bond witness: this case sets requireRoundBond',
        );
      }
    } else {
      if (roundBondProofHash === (event.bondProofHash as string)) {
        throw new CourtConfirmationTransitionError(
          'escalation round bond proof hash must be distinct from the membership (challenge) bond',
        );
      }
      const consumed = log.find((r) => r.roundBondProofHash === roundBondProofHash);
      if (consumed) {
        throw new CourtConfirmationTransitionError(
          `escalation round bond proof hash was already consumed by round ${consumed.round}`,
        );
      }
    }
    record = {
      round: expectedRound,
      authority,
      challengerIdx: idx as number,
      challengerPubkey: event.challengerPubkey as string,
      requestHash: event.requestHash as string,
      bondProofHash: event.bondProofHash as string,
      roundBondProofHash,
      at: event.now,
    };
  } else {
    if (state.hostEscalation !== true) {
      throw new CourtConfirmationTransitionError(
        'host escalation is not permitted: the case policy does not set hostEscalation',
      );
    }
    if (
      event.challengerIdx != null
      || event.challengerPubkey != null
      || event.requestHash != null
      || event.bondProofHash != null
      || roundBondProofHash !== null
    ) {
      throw new CourtConfirmationTransitionError(
        'a host escalation must not carry a challenger request witness',
      );
    }
    record = {
      round: expectedRound,
      authority,
      challengerIdx: null,
      challengerPubkey: null,
      requestHash: null,
      bondProofHash: null,
      roundBondProofHash: null,
      at: event.now,
    };
  }
  return freezeState({
    ...state,
    phase: 'ladder_pending',
    escalationLog: [...log, record],
  });
}

/** Apply a `concede`: the current round's outcome becomes final. */
export function onConcede(
  state: CourtConfirmationMachineState,
  _event: Extract<ConfirmEvent, { type: 'concede' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'round_resolved') {
    throw new CourtConfirmationTransitionError(
      `cannot concede during ${state.phase}`,
    );
  }
  // The pending verdict (the current round's outcome) becomes final; the
  // host settles fees and finalize mints the verdict from the last
  // resolved round's winning votes.
  return freezeState({ ...state, phase: 'fee_settlement' });
}

/** Apply a `record_fee`: append a fee-ledger event id (idempotent). */
export function onRecordFee(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'record_fee' }>,
): CourtConfirmationMachineState {
  assertHex32(event.feeEventId, 'fee event id must be 32-byte lowercase hex');
  if (state.fees.includes(event.feeEventId)) {
    return freezeState(state);
  }
  if (state.fees.length >= MAX_FEES) {
    throw new CourtConfirmationTransitionError(
      `fee ledger exceeds maximum of ${MAX_FEES} entries`,
    );
  }
  return freezeState({ ...state, fees: [...state.fees, event.feeEventId] });
}

/** Apply a `flag_clawback`: append an operator clawback flag (idempotent). */
export function onFlagClawback(
  state: CourtConfirmationMachineState,
  event: Extract<ConfirmEvent, { type: 'flag_clawback' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'fee_settlement') {
    throw new CourtConfirmationTransitionError(
      `cannot flag clawbacks during ${state.phase}`,
    );
  }
  assertParticipant(state, event.idx);
  if (
    typeof event.reason !== 'string'
    || event.reason.length === 0
    || textEncoder.encode(event.reason).length > MAX_REASON_BYTES
  ) {
    throw new CourtConfirmationTransitionError('clawback reason must be a non-empty bounded string');
  }
  if (
    state.clawbackFlags.some((f) => f.idx === event.idx && f.reason === event.reason)
  ) {
    return freezeState(state);
  }
  if (state.clawbackFlags.length >= MAX_CLAWBACK_FLAGS) {
    throw new CourtConfirmationTransitionError(
      `clawback ledger exceeds maximum of ${MAX_CLAWBACK_FLAGS} entries`,
    );
  }
  return freezeState({
    ...state,
    clawbackFlags: [
      ...state.clawbackFlags,
      { idx: event.idx, reason: event.reason, round: state.ladderRound },
    ],
  });
}

/** Apply a `finalize`: mint the canonical verdict hash and reach `final`. */
export function onFinalize(
  state: CourtConfirmationMachineState,
  _event: Extract<ConfirmEvent, { type: 'finalize' }>,
): CourtConfirmationMachineState {
  if (state.phase !== 'fee_settlement') {
    throw new CourtConfirmationTransitionError(`cannot finalize during ${state.phase}`);
  }
  // Ledger barrier (cross-module round 2, SEQUENCE-4): the confirmation
  // ledger becomes the verdict's supporting event ids, so a restored or
  // hand-tampered snapshot is re-verified against the canonical
  // confirmation bindings before any verdict hash is minted. The verdict
  // is a pure function of the verified ledgers: clawback-flag history is
  // deliberately NOT an input, so replaying the same pre-finalize
  // snapshot with a different flag history yields the identical
  // verdictHash (deterministic double-finalize protection).
  assertValidConfirmationLedger(state);
  // Outcome-history barrier (finding F-3): the restored history must
  // re-verify (consecutive rounds, ballot closure, well-formed winners)
  // before the machine reaches `final` on top of it.
  assertValidOutcomeHistory(state);
  // Witness-log barrier (round-3 finding r29-2, INV-ESC-8): the escalation
  // log is an audit input hosts use to attribute misconduct and price fees,
  // so a restored snapshot must not be able to ADD a record naming a juror
  // who never escalated, a round never opened, or a bond never posted.
  assertValidEscalationLog(state);
  const pending = state.verdict;
  if (!pending) {
    throw new CourtConfirmationTransitionError('cannot finalize without a resolved round');
  }
  // Finality (multi-round ladder §4.2): the verdict is the LAST resolved
  // round's winner. A challenged case is backed by that round's
  // winning-vote event ids; an never-challenged case by the confirmation
  // ledger. (v0.8.5 backed an upheld challenged round with confirmations;
  // the ladder spec pins the evidence to the round that decided.)
  const supportingEventIds = finalSupportingEventIds(state, pending);
  // Fail closed (round-3 finding r3-1): a final verdict needs at least one
  // supporting event. On live paths this is unreachable —
  // close_confirmations enforces the quorum (so the never-challenged path
  // always has ≥ confirmQuorum ≥ 1 confirmation events) and resolve_round
  // refuses an empty vote ledger (so the winner has ≥ 1 event id) — but a
  // hand-restored snapshot with an emptied confirmation ledger used to
  // reach hashCourtVerdict with zero ids, escaping the VOTE machine's
  // foreign CourtVoteTransitionError out of THIS machine. Throw the
  // confirmation machine's own typed error instead.
  if (supportingEventIds.length === 0) {
    throw new CourtConfirmationTransitionError(
      'cannot finalize a verdict with zero supporting event ids — an upheld confirmation needs a quorum of confirmations, a resolved round needs winning votes',
    );
  }
  const verdictHash = hashCourtVerdict({
    sessionHash: state.sessionHash,
    outcome: pending.outcome,
    supportingEventIds,
  });
  return freezeState({
    ...state,
    phase: 'final',
    verdict: {
      outcome: pending.outcome,
      supportingEventIds,
      verdictHash,
      upheld: pending.upheld,
    },
  });
}

function finalSupportingEventIds(
  state: CourtConfirmationMachineState,
  pending: NonNullable<CourtConfirmationMachineState['verdict']>,
): string[] {
  return state.challenges.length === 0 && pending.upheld
    ? state.confirmations.map((c) => c.eventId.toLowerCase()).sort()
    : (state.ladder?.votes ?? [])
        .filter((v) => v.outcome === pending.outcome)
        .map((v) => v.eventId.toLowerCase())
        .sort();
}
