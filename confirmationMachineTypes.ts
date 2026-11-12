// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

// Event grammar and state types for the universal-confirmation machine
// (extracted from `courtConfirmationMachine.ts` — see that file for the
// module contract, phase graph, and pipeline role). This module is pure
// data: no hashing, no guards, no transitions.

import { CourtError, CourtErrorOptions } from './errors';

/**
 * Domain string for canonical confirmation hashes (session + juror + case
 * binding for a public confirmation endorsement).
 */
export const COURT_CONFIRMATION_DOMAIN = 'BAO-Court/Confirm/v1';

/**
 * Phases of the universal-confirmation machine: `confirm_open` →
 * `confirm_closed` → `challenge_window` → (`fee_settlement` → `final`) or
 * the ladder path (`ladder_pending` → `ladder_vote_open` →
 * `ladder_vote_closed` → `round_resolved` → escalate/concede, eventually
 * `fee_settlement` → `final`), with terminal-failure phases `expired` and
 * `aborted`.
 */
export type CourtConfirmationPhase =
  | 'confirm_open'
  | 'confirm_closed'
  | 'challenge_window'
  | 'ladder_pending'
  | 'ladder_vote_open'
  | 'ladder_vote_closed'
  | 'round_resolved'
  | 'fee_settlement'
  | 'final'
  | 'expired'
  | 'aborted';

/**
 * Terminal failure of a confirmation case: deadline expiry (`expired`) or
 * operator abort (`aborted`), with a human-readable reason.
 */
export interface CourtConfirmationFailure {
  readonly phase: 'expired' | 'aborted';
  readonly reason: string;
}

/** One accepted public confirmation: roster index, canonical hash, event id. */
export interface CourtConfirmationRecord {
  readonly idx: number;
  readonly confirmHash: string;
  readonly eventId: string;
}

/**
 * One accepted challenge against the proposed outcome, carrying the verified
 * bond witness (txid + bond-ownership proof hash) the host verified BEFORE
 * dispatching the event.
 */
export interface CourtChallengeRecord {
  readonly idx: number;
  /** 32-byte lowercase hex transaction id of the escrowed challenge bond. */
  readonly bondTxid: string;
  /**
   * 32-byte lowercase hex hash of the verified bond-ownership witness. The
   * host verifies the witness against the bond UTXO BEFORE dispatching this
   * event; the reducer binds the hash so observers can re-verify later.
   *
   * Uniqueness is a state invariant (R38, r38-1): one proof hash is bound to at
   * most ONE roster index per case, so a bond buys exactly one challenger's
   * standing. A host whose proof derivation can collide across jurors (e.g. a
   * hash of the funding transaction, which a batch payout shares) must mix the
   * juror index into the witness — otherwise the second challenge is refused.
   *
   * Uniqueness is NOT ownership (R40, r40-3): whichever challenge lands FIRST
   * owns the hash, and a DERIVABLE witness (`hash(bondTxid)` is public the
   * moment the bond is on chain) can be registered by a juror that owns no bond,
   * locking the payer out of the case. The machine cannot tell owner from copier
   * — it holds no idx→pubkey registry (r38-3) — so the host's bond verifier must
   * bind the witness to the event author (bond owner key == submitting juror).
   */
  readonly bondProofHash: string;
  readonly eventId: string;
}

/** One ladder-round mass vote: roster index, outcome, source event id. */
export interface CourtMassVoteRecord {
  readonly idx: number;
  readonly outcome: string;
  readonly eventId: string;
}

/**
 * A juror flagged for stake clawback: `overturned_confirmation` (their
 * confirmation was overturned by the round that challenged it, applied once)
 * or `round_flip` (they voted with a majority the next round rejected).
 */
export interface CourtClawbackFlag {
  readonly idx: number;
  readonly reason: string;
  readonly round: number;
}

/**
 * Who asserts the right to escalate a resolved ladder round on to the next
 * one (SPEC §9.2, ESC-RIGHT-1…5): the bonded `challenger` (the protocol
 * default) or the host under break-glass policy (`hostEscalation`).
 */
export type CourtEscalationAuthority = 'challenger' | 'host';

/**
 * The authority witness a later round may be opened under, recorded
 * append-only in `escalationLog` so an observer can re-derive who escalated
 * and against which request and bond (INV-ESC-6). Every field is part of the
 * machine's own validation, not host policy: `challenger` requires a
 * case-roster participant, an x-only pubkey, a request hash and the hash of a
 * bond the machine has already accepted; `host` requires the frozen
 * `hostEscalation` policy and carries no challenger request.
 */
export interface CourtEscalationRecord {
  /** The ladder round this escalation OPENED (= ladderRound at dispatch + 1). */
  readonly round: number;
  readonly authority: CourtEscalationAuthority;
  /** Case-roster index of the asserting challenger (`null` for `host`). */
  readonly challengerIdx: number | null;
  /** x-only public key (32-byte hex) of the asserting challenger; `null` for `host`. */
  readonly challengerPubkey: string | null;
  /**
   * 32-byte hex hash of the challenger's signed escalation request (`null`
   * for `host`). The host relays the request; it cannot manufacture one for a
   * challenger — the machine records the hash, so a published request with no
   * matching entry is provable misconduct.
   */
  readonly requestHash: string | null;
  /** 32-byte hex bond-proof hash, bound to an accepted challenge bond; `null` for `host`. */
  readonly bondProofHash: string | null;
  /**
   * 32-byte hex proof hash of the bond posted FOR THIS ROUND (R31, r30-1) —
   * `null` on a legacy witness (the v0.12 membership-bond semantics) and for
   * `host`. `bondProofHash` proves the challenger is a member (it posted the
   * case's challenge bond once); THIS hash proves the challenger PAID for the
   * round being opened, and the reducer refuses to reuse one: it must differ
   * from the membership bond and never appear in an earlier record. It is the
   * machine-level half of "ΔC_{r+1} = 3^{r+1} b₀" — the amounts are the host's,
   * the consumption (one fresh witness per round) is the machine's.
   */
  readonly roundBondProofHash: string | null;
  /** Caller-supplied clock at the escalation. */
  readonly at: number;
}

/**
 * Final verdict of a confirmation case: the last resolved round's winner
 * (or the confirmed proposal when never challenged), the sorted supporting
 * event ids, the canonical verdict hash, and whether the proposed outcome
 * survived.
 */
export interface CourtConfirmationVerdict {
  readonly outcome: string;
  /** Supporting event ids, sorted lexicographically for canonical hashing. */
  readonly supportingEventIds: readonly string[];
  readonly verdictHash: string;
  /** True when the proposed outcome survived (the last resolved round's winner equals it). */
  readonly upheld: boolean;
}

/**
 * Append-only record of one resolved ladder round's outcome (multi-round
 * ladder, universal-confirmation proposal §4.2). `winnerEventIds` are the
 * winning voters' event ids (sorted lexicographically); `winnerIndices` the
 * matching roster indices, retained so a later flip-flop can flag the
 * previous round's majority without re-keeping whole vote ledgers.
 */
export interface CourtRoundOutcomeRecord {
  readonly round: number;
  readonly outcome: string;
  readonly winnerEventIds: readonly string[];
  readonly winnerIndices: readonly number[];
}

interface LadderRound {
  readonly round: number;
  readonly voteDeadline: number;
  readonly votes: readonly CourtMassVoteRecord[];
  /**
   * This round's panel. Defaults to the case roster when the host opens the
   * round without an explicit expansion (or on pre-0.9 snapshots). Sequential
   * 1..N, N ≥ 3.
   */
  readonly roundRoster?: readonly number[];
}

/**
 * Declared provenance of a PARTIAL state — a projection of the machine's state
 * that the machine did not produce (v0.15.3, G-4).
 *
 * A host that persists only the escalation LANE of the machine (the fields the
 * lane reads and writes: `phase`, `ladderRound`, the policy flags, the roster,
 * the challenge and escalation ledgers) has a state whose round counter is
 * backed by ITS OWN case row, not by an in-state `ladder` object. The counter is
 * therefore real and integral while `ladder` is legitimately absent, and the
 * machine cannot tell that shape from a forged snapshot by looking at the
 * counter alone — so the host must SAY which one it is.
 *
 * `'lane'` is the only value, and it is deliberately NOT a trust upgrade:
 *
 *  - it does not relax the counter's write domain (a non-negative safe integer,
 *    always) nor the agreement rule when a `ladder` IS present;
 *  - it unlocks exactly ONE entry, `escalate` — the transition whose round
 *    (`ladderRound + 1`) is not yet seated in the state by construction, and
 *    whose own barrier (`assertValidEscalationLog`) sizes the ledger from the
 *    same counter, so the log vouches for the round the host claims;
 *  - every entry that reads the in-state ladder (`open_ladder_round`,
 *    `resolve_round`, `flag_clawback`, `finalize`, the transport mapper) still
 *    requires the FULL state, so a projection can never persist a round in a
 *    clawback record or mint a verdict.
 *
 * Absent on every state the machine produces (`createCourtConfirmationMachine`
 * and the reducer never write it), which is what makes "absent" mean "full".
 */
export type CourtConfirmationStateProjection = 'lane';

/**
 * Immutable state of one universal-confirmation case. Deep-frozen by the
 * factory and reducer; `latestTimestamp` is the monotonic-clock ledger
 * (INV-CONF monotonicity); `outcomeHistory` is append-only.
 */
export interface CourtConfirmationMachineState {
  readonly sessionHash: string;
  readonly proposalHash: string;
  readonly proposedOutcome: string;
  readonly allowedOutcomes: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly participantIndices: readonly number[];
  readonly confirmQuorum: number;
  /**
   * True when the configured quorum is below the roster's supermajority
   * ⌈2N/3⌉. Explicitly an ALLOWED configuration (the shipped 3-of-5 rollout
   * uses it) — recorded so hosts, policies and auditors can see the exposure
   * without re-deriving it from the caller's own config (R25,
   * `docs/proofs/economics/05-review-gapfills.tex.md` §1.3).
   */
  readonly quorumBelowSupermajority: boolean;
  readonly confirmDeadline: number;
  readonly challengeDeadline: number;
  /** Greatest caller-supplied timestamp accepted by the reducer. */
  readonly latestTimestamp: number;
  readonly phase: CourtConfirmationPhase;
  readonly confirmations: readonly CourtConfirmationRecord[];
  readonly challenges: readonly CourtChallengeRecord[];
  /** Current ladder round; undefined until a challenge advances the case. */
  readonly ladder?: LadderRound;
  /** Highest ladder round opened so far (0 = none). */
  readonly ladderRound: number;
  /**
   * Declared provenance of a PARTIAL state (v0.15.3, G-4). Absent on every
   * state this package produces — which is what makes "absent" mean "the FULL
   * machine state". See {@link CourtConfirmationStateProjection} for exactly
   * what `'lane'` does and does not relax.
   */
  readonly projection?: CourtConfirmationStateProjection;
  /**
   * Maximum ladder rounds permitted for this case (1..5, default 2). When
   * round `maxLadderRounds` resolves, the case proceeds to fee_settlement;
   * earlier resolutions park in `round_resolved` for the host's explicit
   * escalate/concede decision.
   */
  readonly maxLadderRounds: number;
  /**
   * Frozen policy: may the HOST play `escalate` on its own authority
   * (break-glass ops recovery)? Default `false` — the protocol default is that
   * only a bonded challenger's relayed request escalates (SPEC §9.2
   * ESC-RIGHT-2). Read fail-closed: an absent value on a hand-restored
   * snapshot is `false`.
   */
  readonly hostEscalation: boolean;
  /**
   * Frozen policy: must a CHALLENGER escalation carry a fresh per-round bond
   * witness (`roundBondProofHash`)? Default `false` — the v0.12 compatibility
   * default, where one accepted challenge bond funds every round (the
   * membership test r30-1 priced). Set `true` on NEW deployments: the ladder
   * then becomes a consumption test — each round consumes one distinct bond
   * witness, so the marginal cost of round r is the host's per-round bond
   * rather than zero. Read fail-closed: an absent value on a hand-restored
   * snapshot is `false` (legacy semantics), never `true`.
   */
  readonly requireRoundBond: boolean;
  /**
   * Append-only witness log of every escalation (INV-ESC-6): one entry per
   * `escalate`, recording who asserted the right and the request/bond hashes
   * the reducer validated. Never rewritten, never truncated.
   */
  readonly escalationLog: readonly CourtEscalationRecord[];
  /**
   * Append-only history of resolved rounds' outcomes (frozen). The final
   * verdict is the last entry; hosts derive reputation scores from the
   * per-round coherence with the final outcome.
   */
  readonly outcomeHistory: readonly CourtRoundOutcomeRecord[];
  readonly clawbackFlags: readonly CourtClawbackFlag[];
  /** Fee-ledger event ids recorded for this case (bonds forfeit, fees paid). */
  readonly fees: readonly string[];
  readonly verdict?: CourtConfirmationVerdict;
  readonly failure?: CourtConfirmationFailure;
}

/**
 * Input events for the confirmation reducer: `accept_confirmation`,
 * `close_confirmations`, `open_challenge_window`, `accept_challenge`,
 * `close_challenge_window`, `open_ladder_round`, `accept_mass_vote`,
 * `close_ladder_round`, `resolve_round`, `escalate`, `concede`,
 * `record_fee`, `flag_clawback`, `finalize`, `tick`, and `abort`. Every
 * time-bearing event carries its own `now` (injected clock); `abort` and
 * `flag_clawback`'s reason carry the operator's justification.
 */
export type CourtConfirmationMachineEvent =
  | {
      readonly type: 'accept_confirmation';
      readonly idx: number;
      readonly confirmHash: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_confirmations'; readonly now: number }
  | { readonly type: 'open_challenge_window'; readonly now: number }
  | {
      readonly type: 'accept_challenge';
      readonly idx: number;
      readonly bondTxid: string;
      readonly bondProofHash: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_challenge_window'; readonly now: number }
  | {
      readonly type: 'open_ladder_round';
      readonly round: number;
      readonly voteDeadline: number;
      /**
       * Optional expanded panel for THIS round (sequential indices 1..N,
       * N ≥ 3, N ≤ 10_000). Superset of the previous round's roster is NOT
       * required; when omitted the case roster is the round panel.
       */
      readonly roundRoster?: readonly number[];
      readonly now: number;
    }
  | {
      readonly type: 'accept_mass_vote';
      readonly idx: number;
      readonly outcome: string;
      readonly eventId: string;
      readonly now: number;
    }
  | { readonly type: 'close_ladder_round'; readonly now: number }
  | { readonly type: 'resolve_round'; readonly now: number }
  | {
      /**
       * Escalation to the next ladder round, witness-bound (SPEC §9.2,
       * INV-ESC-2…5). The reducer — not the host API — decides whether the
       * move is authorised: `challenger` needs a case-roster participant, an
       * x-only pubkey, a request hash and the bond hash of an accepted
       * challenge; `host` needs the frozen `hostEscalation` policy and carries
       * no challenger request. `roundIndex` must open exactly the next round.
       *
       *   `roundBondProofHash` (optional, R31) is the per-round bond witness: a
       *   32-byte hash of the bond posted FOR the round being opened. When the
       *   case was created with `requireRoundBond: true` it is mandatory and
       *   must never have been used before; when it is supplied at all it is
       *   validated and consumed, so a host can tighten a legacy case one
       *   deployment at a time. Omitting it keeps the v0.12 membership
       *   semantics (one accepted challenge bond per case).
       */
      readonly type: 'escalate';
      readonly authority: CourtEscalationAuthority;
      readonly challengerIdx: number | null;
      readonly challengerPubkey: string | null;
      readonly requestHash: string | null;
      readonly bondProofHash: string | null;
      readonly roundBondProofHash?: string | null;
      readonly roundIndex: number;
      readonly now: number;
    }
  | {
      /** Host concedes: the current round's outcome becomes final. */
      readonly type: 'concede';
      readonly now: number;
    }
  | { readonly type: 'record_fee'; readonly feeEventId: string; readonly now: number }
  | { readonly type: 'flag_clawback'; readonly idx: number; readonly reason: string; readonly now: number }
  | { readonly type: 'finalize'; readonly now: number }
  | { readonly type: 'tick'; readonly now: number }
  | { readonly type: 'abort'; readonly reason: string };

/**
 * Error thrown for any illegal confirmation-machine transition or malformed
 * input. Code: `CONFIRMATION_TRANSITION` (docs/FORMAL_INVARIANTS.md §15).
 */
export class CourtConfirmationTransitionError extends CourtError {
  constructor(message: string, options?: CourtErrorOptions) {
    super('CONFIRMATION_TRANSITION', message, options);
  }
}
