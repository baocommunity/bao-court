// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import {
  assertNow,
  assertPositiveDeadline,
  assertStateArrays,
  normalizeCeremonyRoster,
} from './courtCeremonyCore';
import {
  CourtConfirmationMachineEvent,
  CourtConfirmationMachineState,
  CourtConfirmationTransitionError,
} from './confirmationMachineTypes';
import {
  DEFAULT_LADDER_ROUNDS,
  MAX_EVIDENCE_IDS,
  MAX_LADDER_ROUNDS,
  MIN_ROUND_ROSTER,
  TERMINAL_PHASES,
  assertBoundedOutcome,
  assertHex32,
  confirmSupermajority,
  freezeState,
} from './confirmationMachineCore';
import {
  onAbort,
  onAcceptChallenge,
  onAcceptConfirmation,
  onAcceptMassVote,
  onCloseChallengeWindow,
  onCloseConfirmations,
  onCloseLadderRound,
  onConcede,
  onEscalate,
  onFinalize,
  onFlagClawback,
  onOpenChallengeWindow,
  onOpenLadderRound,
  onRecordFee,
  onResolveRound,
  onTick,
} from './confirmationMachineHandlers';

/**
 * Pure fail-closed state machine for one BAO Court universal-confirmation
 * case (v1).
 *
 * Every market outcome — disputed or not — is confirmed by a juror panel:
 *
 *   confirm_open -> confirm_closed -> challenge_window
 *     ├─ (no challenge) -> fee_settlement -> final
 *     └─ (challenge)    -> ladder_pending -> ladder_vote_open ->
 *                          ladder_vote_closed -> resolve_round ─┐
 *           ┌───────────────────────────────────────────────────┤
 *           ├─ (round === maxLadderRounds) -> fee_settlement -> final
 *           └─ (rounds remain)            -> round_resolved
 *                                             ├─ concede  -> fee_settlement -> final
 *                                             └─ escalate -> ladder_pending (next round)
 *
 * Confirmations are public endorsements (no commit/reveal — the confirmation
 * is itself the juror's signed statement). A challenge must carry a verified
 * bond witness (the host verifies the bond BEFORE dispatching the event; the
 * reducer binds the witness hash so any observer can re-verify). A challenged
 * case runs mass-vote ladder rounds: round r's panel votes publicly, the
 * majority outcome against the proposal decides, and a round that overturns
 * the proposal flags every confirming juror for clawback (reason
 * `overturned_confirmation`, once). When round r's winner differs from round
 * r-1's winner, round r-1's majority voters are flagged for clawback with
 * reason `round_flip` (they followed an outcome the next panel rejected).
 *
 * Multi-round ladder (per the universal-confirmation proposal §4.2): round
 * panels grow host-side (reference sizes r1=15, r2=45, r3=135 jurors —
 * FROST-subset selection is host policy; this machine only tracks rounds and
 * votes). `params.maxLadderRounds` (default 2, bounded 1..5) caps the round
 * count. `open_ladder_round` may carry an expanded per-round roster
 * (`roundRoster`); superset-of-previous is NOT required, but indices must be
 * valid (sequential 1..N, N ≤ 10_000) and the effective round roster must
 * have ≥ 3 members. Escalation is explicit and WITNESS-BOUND: after every
 * round resolution with rounds remaining the machine parks in
 * `round_resolved`, where a caller plays `escalate` (next round pending) or
 * `concede` (the current round's outcome becomes final) — the machine never
 * auto-escalates and never auto-concedes. `escalate` carries an authority
 * witness the REDUCER validates (SPEC §9.2, INV-ESC-1…8): the authority
 * (`challenger` | `host`), the challenger's roster index and x-only pubkey,
 * the signed request hash, a bond-proof hash bound to a challenge the machine
 * already accepted, and the round index, which must equal `ladderRound + 1`.
 * A host-authority escalation additionally requires the frozen break-glass
 * policy `hostEscalation` (default false). The accepted witness is appended to
 * the append-only `escalationLog`, so a host that bypasses its own API cannot
 * escalate without proving the right. When the last permitted round
 * resolves, the machine proceeds directly to `fee_settlement`. Finality:
 * the verdict at `finalize` is the LAST resolved round's winner, backed by
 * that round's winning-vote event ids (or the confirmation ids when never
 * challenged); `outcomeHistory` records every round's
 * {round, outcome, winnerEventIds, winnerIndices} append-only for host-side
 * reputation scoring (final-round weight 1.0, earlier rounds 0.5 — scoring
 * itself is host policy).
 *
 * This module performs no network or Nostr signature verification; the event
 * boundary must authenticate authors and roster indices before dispatching
 * events into the reducer. Hosts inject clocks by passing `now`; the machine
 * is deterministic, freeze-safe, and snapshot-friendly (plain JSON state).
 *
 * Pipeline role: stage 3 of the dispute pipeline (paper §6, "Universal
 * confirmation") — every market outcome, disputed or not, passes through
 * this machine; a challenged case descends into the ladder rounds before
 * any attestation is signed.
 *
 * Purity: factory and reducer are pure functions of (state, event) with an
 * injected clock (`now` on each event); no I/O, no randomness, no wall
 * clock. All hash inputs go through `CanonicalWriter`.
 *
 * Invariants: INV-CONF-1 … INV-CONF-36 in docs/FORMAL_INVARIANTS.md §5;
 * verified by exhaustive model checking (`__tests__/modelChecking.test.ts`).
 *
 * Module layout (complexity pass — one coherent seam each):
 *   - `confirmationMachineTypes.ts`   event grammar, state types, error.
 *   - `confirmationMachineCore.ts`    constants, guards, ledger barriers,
 *                                     canonical confirmation hash.
 *   - `confirmationMachineHandlers.ts` one named handler per event type.
 *   - this file                       factory + reducer dispatch + the
 *                                     public surface re-exported unchanged.
 */

export {
  COURT_CONFIRMATION_DOMAIN,
  type CourtConfirmationPhase,
  type CourtConfirmationFailure,
  type CourtConfirmationRecord,
  type CourtChallengeRecord,
  type CourtMassVoteRecord,
  type CourtClawbackFlag,
  type CourtConfirmationVerdict,
  type CourtRoundOutcomeRecord,
  type CourtEscalationAuthority,
  type CourtEscalationRecord,
  type CourtConfirmationMachineState,
  type CourtConfirmationMachineEvent,
  CourtConfirmationTransitionError,
} from './confirmationMachineTypes';

export { hashCourtConfirmation } from './confirmationMachineCore';
export { confirmSupermajority } from './confirmationMachineCore';

/**
 * Create the initial state of a universal-confirmation case (phase
 * `confirm_open`).
 *
 * Validates and freezes the configuration: 32-byte-hex session and proposal
 * hashes, a bounded proposed outcome, 2–256 unique allowed outcomes, a
 * canonical roster of ≥ 3 participants (fail-closed at creation — a smaller
 * panel could never resolve a challenged case), quorum/d deadlines, and
 * ladder bounds (`maxLadderRounds` 1..5, default 2).
 *
 * @returns A deep-frozen initial {@link CourtConfirmationMachineState}.
 * @throws {@link CourtConfirmationTransitionError} on any malformed
 *         parameter.
 */
export function createCourtConfirmationMachine(params: {
  readonly sessionHash: string;
  /** 32-byte lowercase hex commitment to the proposed outcome + evidence. */
  readonly proposalHash: string;
  readonly proposedOutcome: string;
  readonly allowedOutcomes: readonly string[];
  readonly evidenceIds?: readonly string[];
  /**
   * The juror panel: sequential indices 1..N with N ≥ 3 (round-3 finding
   * r3-6, fail-closed at creation). The confirmation quorum semantics and
   * the ladder's round-panel barrier presuppose a panel of at least
   * MIN_ROUND_ROSTER seats — a 2-member case roster could never resolve a
   * challenged case (the default round panel IS the case roster, and the
   * ledger barrier demands ≥ 3 round-panel members), so such a machine is
   * rejected up front instead of dead-ending mid-challenge.
   */
  readonly participantIndices: readonly number[];
  /**
   * Confirmations required before `close_confirmations` may pass.
   *
   * **Default: ⌈2N/3⌉ of the roster** (0.8.0 review-response R25 — it used to
   * be 1, which let a single compromised juror confirm every case: capture
   * probability 0.8683 at ρ=⅓ and 0.9655 at ρ=0.49 on a 5-seat round-0 panel,
   * `docs/proofs/economics/05-review-gapfills.tex.md` §1.3 Finding 1.2).
   *
   * A host MAY pass an explicit smaller quorum (the shipped 3-of-5 rollout is
   * a host policy, and every existing snapshot keeps working), but the
   * factory then RECORDS `quorumBelowSupermajority: true` in the state so
   * policies, hosts and auditors can gate on it instead of discovering the
   * threshold by reading the caller's config.
   */
  readonly confirmQuorum?: number;
  readonly confirmDeadline: number;
  readonly challengeDeadline: number;
  /**
   * Maximum ladder rounds (1..5, default 2). Round r resolving with
   * r === maxLadderRounds settles fees directly; earlier resolutions park in
   * `round_resolved` awaiting an explicit host `escalate`/`concede`.
   */
  readonly maxLadderRounds?: number;
  /**
   * May the host escalate on its own authority (break-glass ops recovery)?
   * Default `false`: the protocol default is that only a bonded challenger's
   * relayed request escalates (SPEC §9.2 ESC-RIGHT-2), and the reducer refuses
   * an `authority: "host"` escalation otherwise. Recorded in the state so the
   * policy is frozen with the case.
   */
  readonly hostEscalation?: boolean;
  /**
   * Must every CHALLENGER escalation carry a fresh per-round bond witness
   * (R31, r30-1)? Default `false` — the v0.12 compatibility default in which
   * one accepted challenge bond funds every round. Set `true` on NEW
   * deployments: the machine then refuses an escalation whose
   * `roundBondProofHash` is missing, equal to the membership bond, or already
   * consumed by an earlier round, so escalation stops being a free option.
   * Compatibility matrix: `docs/PER_ROUND_BOND.md`.
   */
  readonly requireRoundBond?: boolean;
}): CourtConfirmationMachineState {
  assertHex32(params.sessionHash, 'sessionHash must be 32-byte lowercase hex');
  assertHex32(params.proposalHash, 'proposalHash must be 32-byte lowercase hex');
  assertBoundedOutcome(params.proposedOutcome, 'proposedOutcome must be a non-empty bounded string');
  const participants = normalizeCeremonyRoster(
    params.participantIndices,
    'confirmation',
    CourtConfirmationTransitionError,
  );
  // Fail closed at creation (round-3 finding r3-6): the confirmation quorum
  // and the ladder's round-panel barrier (MIN_ROUND_ROSTER) presuppose a
  // panel of ≥ 3 seats — a 2-member case roster could confirm (quorum ≤ 2)
  // but could NEVER resolve a challenged case, because the default round
  // panel is the case roster and close_ladder_round/resolve_round reject a
  // < 3-seat panel. Rejecting here keeps every reachable state resolvable.
  if (participants.length < MIN_ROUND_ROSTER) {
    throw new CourtConfirmationTransitionError(
      `confirmation roster must contain at least ${MIN_ROUND_ROSTER} participants`,
    );
  }
  if (
    !Array.isArray(params.allowedOutcomes)
    || params.allowedOutcomes.length < 2
    || params.allowedOutcomes.length > 256
  ) {
    throw new CourtConfirmationTransitionError('allowedOutcomes must contain 2..256 outcomes');
  }
  const outcomes = [...params.allowedOutcomes];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    assertBoundedOutcome(outcome, 'allowed outcomes must be non-empty bounded strings');
    if (seen.has(outcome)) {
      throw new CourtConfirmationTransitionError('allowed outcomes must be unique');
    }
    seen.add(outcome);
  }
  if (!outcomes.includes(params.proposedOutcome)) {
    throw new CourtConfirmationTransitionError(
      'proposedOutcome must be a member of allowedOutcomes',
    );
  }
  const evidenceIds = params.evidenceIds ?? [];
  if (!Array.isArray(evidenceIds) || evidenceIds.length > MAX_EVIDENCE_IDS) {
    throw new CourtConfirmationTransitionError(
      `evidenceIds must contain at most ${MAX_EVIDENCE_IDS} entries`,
    );
  }
  for (const id of evidenceIds) {
    assertHex32(id, 'evidence ids must be 32-byte lowercase hex');
  }
  const confirmQuorum = params.confirmQuorum ?? confirmSupermajority(participants.length);
  if (
    !Number.isSafeInteger(confirmQuorum)
    || confirmQuorum < 1
    || confirmQuorum > participants.length
  ) {
    throw new CourtConfirmationTransitionError(
      'confirmQuorum must be a safe integer in [1, roster size]',
    );
  }
  // R25: an explicit sub-supermajority quorum stays ALLOWED (the shipped
  // 3-of-5 rollout depends on it) but it is RECORDED, so a host/policy layer
  // can gate on it rather than re-deriving it from its own call site.
  const quorumBelowSupermajority = confirmQuorum < confirmSupermajority(participants.length);
  assertPositiveDeadline(params.confirmDeadline, 'confirmDeadline', CourtConfirmationTransitionError);
  if (
    !Number.isSafeInteger(params.challengeDeadline)
    || params.challengeDeadline <= params.confirmDeadline
  ) {
    throw new CourtConfirmationTransitionError(
      'challengeDeadline must be later than confirmDeadline',
    );
  }
  const maxLadderRounds = params.maxLadderRounds ?? DEFAULT_LADDER_ROUNDS;
  if (
    !Number.isSafeInteger(maxLadderRounds)
    || maxLadderRounds < 1
    || maxLadderRounds > MAX_LADDER_ROUNDS
  ) {
    throw new CourtConfirmationTransitionError(
      `maxLadderRounds must be a safe integer in [1, ${MAX_LADDER_ROUNDS}]`,
    );
  }
  return freezeState({
    sessionHash: params.sessionHash,
    proposalHash: params.proposalHash,
    proposedOutcome: params.proposedOutcome,
    allowedOutcomes: outcomes,
    evidenceIds: [...evidenceIds],
    participantIndices: participants,
    confirmQuorum,
    quorumBelowSupermajority,
    confirmDeadline: params.confirmDeadline,
    challengeDeadline: params.challengeDeadline,
    latestTimestamp: 0,
    phase: 'confirm_open',
    confirmations: [],
    challenges: [],
    ladderRound: 0,
    maxLadderRounds,
    hostEscalation: params.hostEscalation === true,
    requireRoundBond: params.requireRoundBond === true,
    escalationLog: [],
    outcomeHistory: [],
    clawbackFlags: [],
    fees: [],
  });
}

/**
 * Build a well-formed CHALLENGER escalation for the state's next round
 * (SPEC §9.2): derives `roundIndex` (= `ladderRound + 1`) and binds
 * `bondProofHash` to the case's first accepted challenge bond. The caller
 * supplies the identities only it can know — the challenger's x-only pubkey,
 * the hash of its signed request, and (optionally) which accepted challenge is
 * the challenger's. Fails closed when the case has no accepted challenge bond
 * or is not parked at `round_resolved`.
 *
 * `witness.roundBondProofHash` is the PER-ROUND bond witness (R31): the host
 * passes the hash of the bond it verified for THIS round. Omitting it keeps the
 * v0.12 membership semantics; a case created with `requireRoundBond: true`
 * refuses the resulting event, which is the intended fail-closed behaviour.
 *
 * Hosts use this to construct the event they relay; tests use it to construct
 * the legal move. It performs no verification itself — the reducer does.
 */
export function challengerEscalationEvent(
  state: CourtConfirmationMachineState,
  now: number,
  witness: {
    readonly challengerPubkey: string;
    readonly requestHash: string;
    readonly challengerIdx?: number;
    readonly roundBondProofHash?: string | null;
  },
): Extract<CourtConfirmationMachineEvent, { type: 'escalate' }> {
  const bond = witness.challengerIdx === undefined
    ? state.challenges[0]
    : state.challenges.find((c) => c.idx === witness.challengerIdx);
  if (!bond) {
    throw new CourtConfirmationTransitionError(
      'no accepted challenge bond to bind an escalation witness to',
    );
  }
  return {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: bond.idx,
    challengerPubkey: witness.challengerPubkey,
    requestHash: witness.requestHash,
    bondProofHash: bond.bondProofHash,
    ...(witness.roundBondProofHash == null ? {} : { roundBondProofHash: witness.roundBondProofHash }),
    roundIndex: state.ladderRound + 1,
    now,
  };
}

/**
 * Build a break-glass HOST escalation for the state's next round. Legal only
 * when the case was created with `hostEscalation: true`; the reducer refuses
 * it otherwise (INV-ESC-5).
 */
export function hostEscalationEvent(
  state: CourtConfirmationMachineState,
  now: number,
): Extract<CourtConfirmationMachineEvent, { type: 'escalate' }> {
  return {
    type: 'escalate',
    authority: 'host',
    challengerIdx: null,
    challengerPubkey: null,
    requestHash: null,
    bondProofHash: null,
    roundIndex: state.ladderRound + 1,
    now,
  };
}

/**
 * Apply one event to the confirmation-machine state and return the next
 * state.
 *
 * Pure and fail-closed: validates event shape, state array fields (tamper
 * barrier), ladder structural integrity, and the monotonic clock ledger
 * before any transition, then dispatches to the event's named handler in
 * `confirmationMachineHandlers.ts`. Complexity O(ledger size) for
 * acceptance events, O(votes) for round resolution.
 *
 * @returns A new deep-frozen state; the input state is never mutated.
 * @throws {@link CourtConfirmationTransitionError} on any illegal
 *         transition (out-of-phase event, duplicate confirmation, unproven
 *         challenge bond, clock rollback, event after a terminal phase).
 */
export function reduceCourtConfirmationMachine(
  state: CourtConfirmationMachineState,
  event: CourtConfirmationMachineEvent,
): CourtConfirmationMachineState {
  // Fail closed on a non-object event (a null/undefined event would crash
  // with an uncaught TypeError on property access below).
  if (event === null || typeof event !== 'object') {
    throw new CourtConfirmationTransitionError('event must be an object');
  }
  // Fail closed on a tampered or hand-restored state whose configuration or
  // ledger fields were replaced by non-array values (an uncaught TypeError
  // in the guards below, or a string allowlist admitting substring matches
  // outside the frozen ballot). Pre-0.12 snapshots predate the escalation
  // witness log: an ABSENT field is normalised to an empty ledger, a
  // non-array value is still rejected by the assert below.
  if ((state as { readonly escalationLog?: unknown }).escalationLog === undefined) {
    state = { ...state, escalationLog: [] };
  }
  assertStateArrays(
    state as unknown as Record<string, unknown>,
    ['participantIndices', 'allowedOutcomes', 'confirmations', 'challenges', 'fees', 'clawbackFlags', 'outcomeHistory', 'escalationLog'],
    CourtConfirmationTransitionError,
  );
  if (
    state.ladder !== undefined
    && (typeof state.ladder !== 'object' || state.ladder === null || !Array.isArray(state.ladder.votes))
  ) {
    throw new CourtConfirmationTransitionError('ladder state is missing or malformed');
  }
  // Monotonic non-decreasing clock for every time-bearing event; `abort`
  // carries no clock (mirrors the vote machine).
  if (event.type !== 'abort') {
    assertNow(event.now, CourtConfirmationTransitionError);
    if (event.now < state.latestTimestamp) {
      throw new CourtConfirmationTransitionError(
        'now must not precede a previously observed timestamp',
      );
    }
    state = { ...state, latestTimestamp: event.now };
  }

  switch (event.type) {
    case 'tick': return onTick(state, event);
    case 'abort': return onAbort(state, event);
    default: break;
  }
  if (TERMINAL_PHASES.has(state.phase)) {
    throw new CourtConfirmationTransitionError(`cannot process ${event.type} after ${state.phase}`);
  }

  switch (event.type) {
    case 'accept_confirmation': return onAcceptConfirmation(state, event);
    case 'close_confirmations': return onCloseConfirmations(state, event);
    case 'open_challenge_window': return onOpenChallengeWindow(state, event);
    case 'accept_challenge': return onAcceptChallenge(state, event);
    case 'close_challenge_window': return onCloseChallengeWindow(state, event);
    case 'open_ladder_round': return onOpenLadderRound(state, event);
    case 'accept_mass_vote': return onAcceptMassVote(state, event);
    case 'close_ladder_round': return onCloseLadderRound(state, event);
    case 'resolve_round': return onResolveRound(state, event);
    case 'escalate': return onEscalate(state, event);
    case 'concede': return onConcede(state, event);
    case 'record_fee': return onRecordFee(state, event);
    case 'flag_clawback': return onFlagClawback(state, event);
    case 'finalize': return onFinalize(state, event);
    default: break;
  }

  // Unreachable for well-typed events; fail closed instead of silently
  // returning an unfrozen clock-advanced copy for a hostile unknown type.
  const unknownType = (event as { readonly type?: unknown }).type;
  throw new CourtConfirmationTransitionError(`unknown confirmation event type: ${String(unknownType)}`);
}
