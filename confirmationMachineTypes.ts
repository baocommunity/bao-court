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
   * Maximum ladder rounds permitted for this case (1..5, default 2). When
   * round `maxLadderRounds` resolves, the case proceeds to fee_settlement;
   * earlier resolutions park in `round_resolved` for the host's explicit
   * escalate/concede decision.
   */
  readonly maxLadderRounds: number;
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
      /** Host-driven escalation: next ladder round becomes pending. */
      readonly type: 'escalate';
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
