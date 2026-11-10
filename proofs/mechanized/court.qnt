// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

// Quint model of the BAO Court phase machines — an INDEPENDENT second model of
// `courtVoteMachine.ts` (paper §5) and `courtConfirmationMachine.ts` (paper §6),
// cross-referenced against docs/FORMAL_INVARIANTS.md §4 (INV-VOTE-*) and §5
// (INV-CONF-*). Written for the proofs/mechanized round; the pen-and-paper
// proofs live in docs/proofs/ — this spec MACHINE-CHECKS the state-machine
// subset of those theorems.
//
// Modeling decisions (full rationale in README.md):
//   - Every phase, event, guard clause, and ledger rule of both machines,
//     one-to-one with the TS guard clauses; one record-typed state variable
//     per machine (the TS state record, transcribed).
//   - Hashes are abstract injective functions (H / CH) instead of real
//     SHA-256; the commit version-bit gate (courtVoteMachine.ts:650) is
//     modeled as `h >= 8`. Real-hash binding (INV-VOTE-9/10/18) stays with
//     the TS suite.
//   - Event ids and bond txids are abstracted away (event-id uniqueness is
//     enforced by the TS ledger barriers, not re-modeled).
//   - Ledgers are sets (the TS stores lists; element order only matters for
//     canonical hash sorting, which is abstracted here).
//   - The ballot is fixed at 2 outcomes {A, B}; the lexicographic UTF-8
//     tie-break is encoded as the rank table (lexRank: A < B), faithful to
//     `compareOutcomeUtf8` for this ballot.
//
// Toolchain: Quint 0.33.1. Re-run: see README.md.

// ─────────────────────────────────────────────────────────────────────────────
// Shared abstractions (protocol-level, stateless)
// ─────────────────────────────────────────────────────────────────────────────

module protocolUtil {
  /// Fixed 2-outcome ballot. The TS machines accept 2..256 outcomes; the
  /// abstract model fixes k = 2 (the size used by the TS test instances).
  val OUTCOMES = Set("A", "B")
  /// Abstract salt domain (real: 32-byte hex; only distinctness matters).
  val SALT = Set(1, 2)
  /// Lexicographic unsigned-UTF-8 byte-order rank of an outcome — the
  /// canonical tie-break of `compareOutcomeUtf8` (courtVoteMachine.ts:178).
  /// For the fixed ballot, "A" < "B" byte-wise.
  pure def lexRank(o: str): int = if (o == "A") 0 else 1
  /// Abstract injective stand-in for `hashCourtVoteCommit`: binds
  /// (outcome, salt); the session hash is fixed per machine instance, so H
  /// abstracts the session-bound hash. Injective on OUTCOMES x SALT.
  /// The `+ 8` encodes the commit version bit (high nibble 0x8).
  pure def H(o: str, s: int): int = 8 + 16 * lexRank(o) + s
  /// Possible commit-hash values the environment may publish, including
  /// legacy sessionless hashes (< 8, rejected by the version gate) and
  /// well-formed but non-matching hashes.
  val HASHES = Set(1, 3, 9, 10, 25, 26)
  /// Version gate: commit hashes must carry the 0x8 high-nibble bit
  /// (courtVoteMachine.ts:650, INV-VOTE-9).
  pure def isVersioned(h: int): bool = h >= 8
}

// ─────────────────────────────────────────────────────────────────────────────
// Vote machine — independent re-model of `courtVoteMachine.ts`.
//
// Phases: commit_open → commit_closed → reveal_open → reveal_closed →
// tally_final, plus terminal failure phases expired / aborted.
// Invariants cross-referenced: docs/FORMAL_INVARIANTS.md §4.
// ─────────────────────────────────────────────────────────────────────────────

module voteMachine {
  import protocolUtil.*

  const N: int            // roster size (TS: 1..10_000)
  const COMMIT_D: int     // commit deadline (positive)
  const REVEAL_D: int     // reveal deadline, > COMMIT_D (INV-VOTE-2)

  val ROSTER = 1.to(N)
  val TERMINALS = Set("tally_final", "expired", "aborted")
  val PHASES = Set(
    "commit_open", "commit_closed", "reveal_open", "reveal_closed",
    "tally_final", "expired", "aborted",
  )

  type Commit = { idx: int, hash: int }
  type Reveal = { idx: int, outcome: str, salt: int }
  type Verdict = { outcome: str, support: int }

  type VoteState = {
    phase: str,
    clock: int,              // latestTimestamp clock ledger (INV-VOTE-4)
    commits: Set[Commit],
    reveals: Set[Reveal],
    hasVerdict: bool,
    verdict: Verdict,
    failure: str,
  }

  var st: VoteState

  action init: bool = st' = {
    phase: "commit_open",
    clock: 0,
    commits: Set(),
    reveals: Set(),
    hasVerdict: false,
    verdict: { outcome: "", support: 0 },
    failure: "",
  }

  // ── Guard predicates — one-to-one with the TS guard clauses ──────────────

  def committedBy(i: int): bool = st.commits.exists(c => c.idx == i)
  def committedHashBy(i: int, h: int): bool =
    st.commits.exists(c => c.idx == i and c.hash == h)
  def revealedBy(i: int): bool = st.reveals.exists(r => r.idx == i)
  def revealedAs(i: int, o: str, s: int): bool =
    st.reveals.exists(r => r.idx == i and r.outcome == o and r.salt == s)

  /// accept_commit guard: commit_open phase, before the commit deadline
  /// (INV-VOTE-5), roster member (INV-VOTE-8), version gate (INV-VOTE-9),
  /// and no conflicting prior commit (identical redelivery is idempotent —
  /// courtVoteMachine.ts:655-663).
  def canAcceptCommit(i: int, h: int, t: int): bool = (
    st.phase == "commit_open"
      and t >= st.clock
      and t < COMMIT_D
      and i.in(ROSTER)
      and isVersioned(h)
      and (not(committedBy(i)) or committedHashBy(i, h))
  )

  /// close_commits guard: at/after the commit deadline (INV-VOTE-6).
  def canCloseCommits(t: int): bool = (
    st.phase == "commit_open" and t >= st.clock and t >= COMMIT_D
  )

  /// open_reveals guard: strictly before the reveal deadline
  /// (courtVoteMachine.ts:689).
  def canOpenReveals(t: int): bool = (
    st.phase == "commit_closed" and t >= st.clock and t < REVEAL_D
  )

  /// accept_reveal guard: reveal_open phase, before the reveal deadline,
  /// roster member, ballot closure (INV-VOTE-13), reveal ⊨ commit — the
  /// session-bound commit hash must equal H(outcome, salt) (INV-VOTE-12),
  /// and no conflicting prior reveal (identical redelivery idempotent).
  def canAcceptReveal(i: int, o: str, s: int, t: int): bool = (
    st.phase == "reveal_open"
      and t >= st.clock
      and t < REVEAL_D
      and i.in(ROSTER)
      and o.in(OUTCOMES)
      and s.in(SALT)
      and committedHashBy(i, H(o, s))
      and (not(revealedBy(i)) or revealedAs(i, o, s))
  )

  /// close_reveals guard: at/after the reveal deadline (courtVoteMachine.ts:768).
  def canCloseReveals(t: int): bool = (
    st.phase == "reveal_open" and t >= st.clock and t >= REVEAL_D
  )

  /// finalize_tally guard: reveal_closed phase and at least one reveal
  /// (courtVoteMachine.ts:789-791). The ledger barrier
  /// (assertValidRevealLedger, INV-VOTE-15) holds by construction in the model.
  def canFinalize(t: int): bool = (
    st.phase == "reveal_closed" and t >= st.clock and st.reveals.size() >= 1
  )

  /// tick expiry (INV-VOTE-7): expires iff the phase is neither terminal nor
  /// the exempt reveal_closed (courtVoteMachine.ts:599-616) and now is at/after
  /// the reveal deadline. NOTE: only the REVEAL deadline can expire the
  /// ceremony — the commit deadline never does (conservative expiry).
  def mayExpireVote(t: int): bool = (
    t >= REVEAL_D
      and not(Set("tally_final", "expired", "aborted", "reveal_closed").contains(st.phase))
  )

  /// abort guard: any non-terminal phase (INV-VOTE-22). Carries no clock.
  def canAbortVote: bool = not(TERMINALS.contains(st.phase))

  // ── Tally — plurality with the canonical lexicographic tie-break ─────────

  def countReveals(o: str): int = st.reveals.filter(r => r.outcome == o).size()

  /// INV-VOTE-16: winner = plurality; ties break to the lexicographically
  /// smallest outcome (rank 0 = "A" for this ballot).
  def tallyWinnerReveals: str =
    if (countReveals("A") > countReveals("B")) "A"
    else if (countReveals("B") > countReveals("A")) "B"
    else "A"

  // ── Actions ──────────────────────────────────────────────────────────────

  def nextAcceptCommit(i: int, h: int, t: int): VoteState = (
    if (committedBy(i))
      { clock: t, ...st }
    else
      { clock: t, commits: st.commits.union(Set({ idx: i, hash: h })), ...st }
  )

  action doAcceptCommit(i: int, h: int, t: int): bool = all {
    canAcceptCommit(i, h, t),
    st' = nextAcceptCommit(i, h, t),
  }

  action doCloseCommits(t: int): bool = all {
    canCloseCommits(t),
    st' = { clock: t, phase: "commit_closed", ...st },
  }

  action doOpenReveals(t: int): bool = all {
    canOpenReveals(t),
    st' = { clock: t, phase: "reveal_open", ...st },
  }

  def nextAcceptReveal(i: int, o: str, s: int, t: int): VoteState = (
    if (revealedBy(i))
      { clock: t, ...st }
    else
      { clock: t, reveals: st.reveals.union(Set({ idx: i, outcome: o, salt: s })), ...st }
  )

  action doAcceptReveal(i: int, o: str, s: int, t: int): bool = all {
    canAcceptReveal(i, o, s, t),
    st' = nextAcceptReveal(i, o, s, t),
  }

  action doCloseReveals(t: int): bool = all {
    canCloseReveals(t),
    st' = { clock: t, phase: "reveal_closed", ...st },
  }

  /// INV-VOTE-17/18/20: the verdict is a pure function of the reveal ledger;
  /// support = the winner's reveal count (event ids abstracted).
  action doFinalize(t: int): bool = all {
    canFinalize(t),
    st' = {
      clock: t,
      phase: "tally_final",
      hasVerdict: true,
      verdict: { outcome: tallyWinnerReveals, support: countReveals(tallyWinnerReveals) },
      ...st
    },
  }

  /// tick: the clock advances monotonically even when nothing expires
  /// (reducer preamble, courtVoteMachine.ts:565-571); expiry per mayExpireVote.
  action doTick(t: int): bool = all {
    t >= st.clock,
    st' = (
      if (mayExpireVote(t))
        { clock: t, phase: "expired", failure: "expired", ...st }
      else
        { clock: t, ...st }
    ),
  }

  action doAbort: bool = all {
    canAbortVote,
    st' = { phase: "aborted", failure: "aborted", ...st },
  }

  /// Stuttering step — models the TS no-op returns (idempotent redelivery,
  /// pre-deadline ticks) and keeps the simulator alive in terminal phases.
  action doStutter: bool = st' = st

  // ── Invariants (machine-checked subset of INV-VOTE-1..23) ────────────────

  val invPhase = st.phase.in(PHASES)

  val invClock = st.clock >= 0

  /// INV-VOTE-8/9: commits ⊆ roster, version-gated, unique per idx.
  val invCommits = (
    st.commits.forall(c => c.idx.in(ROSTER) and isVersioned(c.hash))
      and ROSTER.forall(i => st.commits.filter(c => c.idx == i).size() <= 1)
  )

  /// INV-VOTE-11/12/13: reveals ⊆ roster × ballot × salt, reveal ⊨ commit,
  /// unique per idx.
  val invReveals = (
    st.reveals.forall(r =>
        r.idx.in(ROSTER) and r.outcome.in(OUTCOMES) and r.salt.in(SALT)
          and committedHashBy(r.idx, H(r.outcome, r.salt)))
      and ROSTER.forall(i => st.reveals.filter(r => r.idx == i).size() <= 1)
  )

  /// INV-VOTE-14 (ledger capacity): |reveals| ≤ |commits| ≤ |roster| ≤ 10_000.
  val invLedgerBound = st.reveals.size() <= st.commits.size()

  /// INV-VOTE-21 (verdict ⟺ terminal tally_final).
  val invVerdictCoherence = st.hasVerdict.iff(st.phase == "tally_final")

  /// failure ⟺ expired/aborted (INV-VOTE-7/22 coherence).
  val invFailureCoherence = (st.failure != "").iff(st.phase.in(Set("expired", "aborted")))

  /// INV-VOTE-16/20: the verdict at tally_final IS the tally of the ledger.
  val invTally = (
    st.phase != "tally_final" or (
      st.verdict.outcome.in(OUTCOMES)
        and st.verdict.support >= 1
        and st.verdict.outcome == tallyWinnerReveals
        and st.verdict.support == countReveals(st.verdict.outcome))
  )

  val inv = (
    invPhase
    and invClock
    and invCommits
    and invReveals
    and invLedgerBound
    and invVerdictCoherence
    and invFailureCoherence
    and invTally
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal-confirmation machine — independent re-model of
// `courtConfirmationMachine.ts` (+ confirmationMachineTypes/Core/Handlers).
//
// Phases: confirm_open → confirm_closed → challenge_window →
//   (no challenge) fee_settlement → final
//   (challenge)     ladder_pending → ladder_vote_open → ladder_vote_closed →
//                   resolve → (last round) fee_settlement | round_resolved →
//                   escalate / concede.
// Invariants cross-referenced: docs/FORMAL_INVARIANTS.md §5.
// ─────────────────────────────────────────────────────────────────────────────

module confirmationMachine {
  import protocolUtil.*

  const N: int            // case-roster size, >= 3 (INV-CONF-2, r3-6)
  const CONFIRM_Q: int    // confirmation quorum, 1..N (INV-CONF-4)
  const CONFIRM_D: int    // confirm deadline
  const CHALLENGE_D: int  // challenge deadline, > CONFIRM_D (INV-CONF-5)
  const MAXL: int         // maxLadderRounds, 1..5 (INV-CONF-6)
  const PROPOSED: str     // proposedOutcome, member of the ballot (INV-CONF-3)

  val ROSTER = 1.to(N)
  val TERMINALS = Set("final", "expired", "aborted")
  val PHASES = Set(
    "confirm_open", "confirm_closed", "challenge_window", "ladder_pending",
    "ladder_vote_open", "ladder_vote_closed", "round_resolved",
    "fee_settlement", "final", "expired", "aborted",
  )
  /// Manual clawback reasons for the `flag_clawback` event (reason strings
  /// abstracted to two bounded representatives).
  val MANUAL_REASONS = Set("manual_fee", "manual_other")
  val ALL_REASONS = Set("overturned_confirmation", "round_flip", "manual_fee", "manual_other")
  /// Abstract fee-ledger event ids.
  val FEEIDS = Set(1, 2, 3)

  type Confirmation = { idx: int }
  type Challenge = { idx: int }
  type Vote = { idx: int, outcome: str }
  type Flag = { idx: int, reason: str, round: int }
  type RoundOutcome = { round: int, outcome: str, winners: Set[int] }
  type Verdict = { outcome: str, upheld: bool, support: int }

  type ConfState = {
    phase: str,
    clock: int,                    // latestTimestamp ledger (INV-CONF-10)
    confirmations: Set[Confirmation],
    challenges: Set[Challenge],
    ladderRound: int,              // highest ladder round opened (0 = none)
    roundDeadline: int,            // current round's voteDeadline
    ladderVotes: Set[Vote],
    pending: Verdict,              // pending verdict (resolve / no-challenge close)
    history: int -> RoundOutcome,  // outcomeHistory keyed by round, append-only (INV-CONF-26)
    flags: Set[Flag],              // clawbackFlags, append-only idempotent
    fees: Set[int],
    finalized: bool,
    finalVerdict: Verdict,
    failure: str,
  }

  var st: ConfState

  action init: bool = st' = {
    phase: "confirm_open",
    clock: 0,
    confirmations: Set(),
    challenges: Set(),
    ladderRound: 0,
    roundDeadline: 0,
    ladderVotes: Set(),
    pending: { outcome: "", upheld: false, support: 0 },
    history: Map(),
    flags: Set(),
    fees: Set(),
    finalized: false,
    finalVerdict: { outcome: "", upheld: false, support: 0 },
    failure: "",
  }

  // ── Guard predicates — one-to-one with confirmationMachineHandlers.ts ────

  def confirmedBy(i: int): bool = st.confirmations.exists(c => c.idx == i)
  def challengedBy(i: int): bool = st.challenges.exists(c => c.idx == i)
  def votedBy(i: int): bool = st.ladderVotes.exists(v => v.idx == i)
  def votedAs(i: int, o: str): bool =
    st.ladderVotes.exists(v => v.idx == i and v.outcome == o)

  /// Abstract canonical confirmation hash: deterministic per (session,
  /// proposal, idx) — hashCourtConfirmation (confirmationMachineCore.ts:53).
  /// The environment can only publish the canonical value or be rejected.
  pure def CH(i: int): int = 8 + i

  /// accept_confirmation guard (onAcceptConfirmation, INV-CONF-11/12).
  /// Conflicting-confirmation rejection is unmodelable here: with the hash
  /// deterministic per idx and event ids abstracted, every redelivery is
  /// identical (idempotent) — see README divergences.
  def canAcceptConfirmation(i: int, h: int, t: int): bool = (
    st.phase == "confirm_open"
      and t >= st.clock
      and t < CONFIRM_D
      and i.in(ROSTER)
      and h == CH(i)
  )

  /// close_confirmations guard: deadline reached AND quorum met — a quorum
  /// that never formed must be expired by a tick, never silently closed
  /// (onCloseConfirmations, INV-CONF-15).
  def canCloseConfirmations(t: int): bool = (
    st.phase == "confirm_open"
      and t >= st.clock
      and t >= CONFIRM_D
      and st.confirmations.size() >= CONFIRM_Q
  )

  /// open_challenge_window guard: strictly before the challenge deadline.
  def canOpenChallengeWindow(t: int): bool = (
    st.phase == "confirm_closed" and t >= st.clock and t < CHALLENGE_D
  )

  /// accept_challenge guard (onAcceptChallenge, INV-CONF-17): bond witness
  /// well-formedness is abstracted (any challenge carries a verified bond).
  def canAcceptChallenge(i: int, t: int): bool = (
    st.phase == "challenge_window" and t >= st.clock and t < CHALLENGE_D and i.in(ROSTER)
  )

  /// close_challenge_window guard: at/after the challenge deadline.
  def canCloseChallengeWindow(t: int): bool = (
    st.phase == "challenge_window" and t >= st.clock and t >= CHALLENGE_D
  )

  /// open_ladder_round guard (onOpenLadderRound, INV-CONF-19/20): consecutive
  /// rounds only, within the ladder cap, positive vote deadline, and the
  /// round must open strictly before its own vote deadline.
  def canOpenLadderRound(r: int, d: int, t: int): bool = (
    st.phase == "ladder_pending"
      and t >= st.clock
      and r == st.ladderRound + 1
      and r <= MAXL
      and d >= 1
      and t < d
  )

  /// accept_mass_vote guard (onAcceptMassVote, INV-CONF-22): round panel =
  /// the case roster (roundRoster expansion abstracted — see README),
  /// before the round deadline, ballot closure, no conflicting revote.
  def canAcceptMassVote(i: int, o: str, t: int): bool = (
    st.phase == "ladder_vote_open"
      and t >= st.clock
      and t < st.roundDeadline
      and i.in(ROSTER)
      and o.in(OUTCOMES)
      and (not(votedBy(i)) or votedAs(i, o))
  )

  /// close_ladder_round guard: at/after the round deadline
  /// (INV-CONF-23 ledger barrier holds by construction).
  def canCloseLadderRound(t: int): bool = (
    st.phase == "ladder_vote_open" and t >= st.clock and t >= st.roundDeadline
  )

  /// resolve_round guard (onResolveRound, INV-CONF-24): a resolved round
  /// needs at least one mass vote.
  def canResolveRound(t: int): bool = (
    st.phase == "ladder_vote_closed" and t >= st.clock and st.ladderVotes.size() >= 1
  )

  /// escalate guard (onEscalate, INV-CONF-29): only from round_resolved,
  /// never past the frozen ladder cap, monotonic clock.
  def canEscalate(t: int): bool = (
    st.phase == "round_resolved" and st.ladderRound < MAXL and t >= st.clock
  )

  /// concede guard (onConcede): only from round_resolved, monotonic clock.
  def canConcede(t: int): bool = (st.phase == "round_resolved" and t >= st.clock)

  /// record_fee guard (onRecordFee): legal in EVERY non-terminal phase —
  /// the handler has no phase guard by design; the reducer's terminal
  /// barrier is the only restriction.
  def canRecordFee(t: int): bool = (t >= st.clock and not(TERMINALS.contains(st.phase)))

  /// flag_clawback guard (onFlagClawback, INV-CONF-31): only during
  /// fee_settlement, roster member, bounded non-empty reason, idempotent
  /// per (idx, reason).
  def canFlagClawback(i: int, reason: str, t: int): bool = (
    st.phase == "fee_settlement"
      and t >= st.clock
      and i.in(ROSTER)
      and reason.in(MANUAL_REASONS)
      and not(st.flags.exists(f => f.idx == i and f.reason == reason))
  )

  // ── Tally + clawback helpers (mirror tallyRoundVotes / applyRoundClawbacks)

  def countVotes(o: str): int = st.ladderVotes.filter(v => v.outcome == o).size()

  /// INV-CONF-25: round majority with the shared lexicographic tie-break.
  def winnerVotes: str =
    if (countVotes("A") > countVotes("B")) "A"
    else if (countVotes("B") > countVotes("A")) "B"
    else "A"

  /// Overturned-proposal clawbacks: every confirming juror, once — idempotent
  /// per (idx, reason) across rounds (applyRoundClawbacks, INV-CONF-27).
  pure def addOverturnFlags(fs: Set[Flag], confs: Set[Confirmation], r: int): Set[Flag] = (
    confs.fold(fs, (acc, c) =>
      if (acc.exists(f => f.reason == "overturned_confirmation" and f.idx == c.idx)) acc
      else acc.union(Set({ idx: c.idx, reason: "overturned_confirmation", round: r })))
  )

  pure def hasRound(hist: int -> RoundOutcome, r: int): bool =
    r.in(hist.keys())

  pure def roundEntry(hist: int -> RoundOutcome, r: int): RoundOutcome =
    hist.get(r)

  /// Flip-flop clawbacks (§4.2): when round r's winner differs from round
  /// r-1's winner, round r-1's majority voters are flagged — idempotent per
  /// (idx, reason, round). NOTE: reads the PRE-APPEND history, exactly as
  /// applyRoundClawbacks reads state.outcomeHistory before appendRoundOutcome;
  /// the previous round is r-1 (rounds are consecutive — INV-CONF-26).
  pure def addFlipFlags(fs: Set[Flag], hist: int -> RoundOutcome, prevRound: int, w: str): Set[Flag] = (
    if (prevRound < 1 or not(hasRound(hist, prevRound))
          or roundEntry(hist, prevRound).outcome == w) fs
    else roundEntry(hist, prevRound).winners.fold(fs, (acc, i) =>
      if (acc.exists(f => f.reason == "round_flip"
            and f.round == prevRound
            and f.idx == i)) acc
      else acc.union(Set({ idx: i, reason: "round_flip", round: prevRound })))
  )

  /// r3-1 support computation (finalSupportingEventIds, event ids abstracted
  /// to counts): never-challenged + upheld ⇒ the confirmation ledger;
  /// otherwise the last round's winning votes.
  def finalSupportSize: int = (
    if (st.challenges.size() == 0 and st.pending.upheld) st.confirmations.size()
    else st.ladderVotes.filter(v => v.outcome == st.pending.outcome).size()
  )

  // ── Actions ──────────────────────────────────────────────────────────────

  def nextAcceptConfirmation(i: int, t: int): ConfState = (
    if (confirmedBy(i))
      { clock: t, ...st }
    else
      { clock: t, confirmations: st.confirmations.union(Set({ idx: i })), ...st }
  )

  action doAcceptConfirmation(i: int, h: int, t: int): bool = all {
    canAcceptConfirmation(i, h, t),
    st' = nextAcceptConfirmation(i, t),
  }

  action doCloseConfirmations(t: int): bool = all {
    canCloseConfirmations(t),
    st' = { clock: t, phase: "confirm_closed", ...st },
  }

  action doOpenChallengeWindow(t: int): bool = all {
    canOpenChallengeWindow(t),
    st' = { clock: t, phase: "challenge_window", ...st },
  }

  def nextAcceptChallenge(i: int, t: int): ConfState = (
    if (challengedBy(i))
      { clock: t, ...st }
    else
      { clock: t, challenges: st.challenges.union(Set({ idx: i })), ...st }
  )

  action doAcceptChallenge(i: int, t: int): bool = all {
    canAcceptChallenge(i, t),
    st' = nextAcceptChallenge(i, t),
  }

  /// INV-CONF-18 (no-challenge routing): no challenge ⇒ the proposal stands,
  /// straight to fee_settlement with the pending verdict upheld.
  action doCloseChallengeWindow(t: int): bool = all {
    canCloseChallengeWindow(t),
    st' = (
      if (st.challenges.size() > 0)
        { clock: t, phase: "ladder_pending", ...st }
      else {
        clock: t,
        phase: "fee_settlement",
        pending: { outcome: PROPOSED, upheld: true, support: st.confirmations.size() },
        ...st
      }
    ),
  }

  action doOpenLadderRound(r: int, d: int, t: int): bool = all {
    canOpenLadderRound(r, d, t),
    st' = {
      clock: t,
      phase: "ladder_vote_open",
      ladderRound: r,
      roundDeadline: d,
      ladderVotes: Set(),
      ...st
    },
  }

  def nextAcceptMassVote(i: int, o: str, t: int): ConfState = (
    if (votedBy(i))
      { clock: t, ...st }
    else
      { clock: t, ladderVotes: st.ladderVotes.union(Set({ idx: i, outcome: o })), ...st }
  )

  action doAcceptMassVote(i: int, o: str, t: int): bool = all {
    canAcceptMassVote(i, o, t),
    st' = nextAcceptMassVote(i, o, t),
  }

  action doCloseLadderRound(t: int): bool = all {
    canCloseLadderRound(t),
    st' = { clock: t, phase: "ladder_vote_closed", ...st },
  }

  /// Round resolution: tally, append outcome history, apply clawbacks, and
  /// route — the final permitted round settles fees directly (the v0.8.5
  /// single-round flow), earlier rounds park in round_resolved for the
  /// host's explicit escalate/concede (INV-CONF-29). The machine never
  /// auto-escalates and never auto-concedes.
  action doResolveRound(t: int): bool = all {
    canResolveRound(t),
    st' = {
      clock: t,
      phase: (if (st.ladderRound >= MAXL) "fee_settlement" else "round_resolved"),
      pending: { outcome: winnerVotes, upheld: winnerVotes == PROPOSED, support: countVotes(winnerVotes) },
      history: st.history.put(st.ladderRound, {
        round: st.ladderRound,
        outcome: winnerVotes,
        winners: st.ladderVotes.filter(v => v.outcome == winnerVotes).map(v => v.idx),
      }),
      flags: addFlipFlags(
        addOverturnFlags(st.flags, st.confirmations, st.ladderRound),
        st.history,
        st.ladderRound - 1,
        winnerVotes),
      ...st
    },
  }

  action doEscalate(t: int): bool = all {
    canEscalate(t),
    st' = { clock: t, phase: "ladder_pending", ...st },
  }

  action doConcede(t: int): bool = all {
    canConcede(t),
    st' = { clock: t, phase: "fee_settlement", ...st },
  }

  def nextRecordFee(f: int, t: int): ConfState = (
    if (st.fees.exists(x => x == f))
      { clock: t, ...st }
    else
      { clock: t, fees: st.fees.union(Set(f)), ...st }
  )

  action doRecordFee(f: int, t: int): bool = all {
    canRecordFee(t),
    st' = nextRecordFee(f, t),
  }

  action doFlagClawback(i: int, reason: str, t: int): bool = all {
    canFlagClawback(i, reason, t),
    st' = {
      clock: t,
      flags: st.flags.union(Set({ idx: i, reason: reason, round: st.ladderRound })),
      ...st
    },
  }

  /// (debug helper removed — see git history)


  /// INV-CONF-32/34/35: the final verdict is the pending verdict (the LAST
  /// resolved round's winner, or the confirmed proposal); clawback flags are
  /// deliberately NOT verdict inputs. The r3-1 barrier refuses an empty
  /// support (the guard `finalSupportSize >= 1`).
  action doFinalizeConf(t: int): bool = all {
    st.phase == "fee_settlement",
    finalSupportSize >= 1,
    t >= st.clock,
    st' = {
      clock: t,
      phase: "final",
      finalized: true,
      finalVerdict: { outcome: st.pending.outcome, upheld: st.pending.upheld, support: finalSupportSize },
      ...st
    },
  }

  /// tick per the TICK_DEADLINES table (confirmationMachineCore.ts:45):
  /// confirm_open → confirmDeadline; confirm_closed and challenge_window →
  /// challengeDeadline; ladder_vote_open → the round's voteDeadline.
  /// ladder_vote_closed / round_resolved / fee_settlement / ladder_pending
  /// are one step from a mandatory explicit transition and are exempt.
  pure def tickDeadline(ph: str, rdl: int): int = (
    if (ph == "confirm_open") CONFIRM_D
    else if (ph == "confirm_closed") CHALLENGE_D
    else if (ph == "challenge_window") CHALLENGE_D
    else if (ph == "ladder_vote_open") rdl
    else 0
  )

  pure def tickExempt(ph: str): bool = Set(
    "final", "expired", "aborted",
    "ladder_vote_closed", "round_resolved", "fee_settlement", "ladder_pending",
  ).contains(ph)

  def mayExpireConf(t: int): bool = (
    not(tickExempt(st.phase))
      and tickDeadline(st.phase, st.roundDeadline) > 0
      and t >= tickDeadline(st.phase, st.roundDeadline)
  )

  action doTick(t: int): bool = all {
    t >= st.clock,
    st' = (
      if (mayExpireConf(t))
        { clock: t, phase: "expired", failure: "expired", ...st }
      else
        { clock: t, ...st }
    ),
  }

  action doAbort: bool = all {
    not(TERMINALS.contains(st.phase)),
    st' = { phase: "aborted", failure: "aborted", ...st },
  }

  /// Stuttering step — models the TS no-op returns and keeps the simulator
  /// alive in terminal phases.
  action doStutter: bool = st' = st

  // ── Invariants (machine-checked subset of INV-CONF-1..36) ────────────────

  /// Creation-parameter discipline (INV-CONF-2..6), checked on every state.
  val invConfig = (
    N >= 3
    and CONFIRM_Q >= 1 and CONFIRM_Q <= N
    and CONFIRM_D < CHALLENGE_D
    and MAXL >= 1 and MAXL <= 5
    and PROPOSED.in(OUTCOMES)
  )

  val invPhase = st.phase.in(PHASES)

  val invClock = st.clock >= 0

  /// One confirmation per roster idx (INV-CONF-16).
  val invConfirmations = (
    st.confirmations.forall(c => c.idx.in(ROSTER))
      and ROSTER.forall(i => st.confirmations.filter(c => c.idx == i).size() <= 1)
  )

  /// One challenge per roster idx (INV-CONF-17, bond abstracted).
  val invChallenges = (
    st.challenges.forall(c => c.idx.in(ROSTER))
      and ROSTER.forall(i => st.challenges.filter(c => c.idx == i).size() <= 1)
  )

  /// INV-CONF-15 corollary: past the confirm window, the quorum was met.
  val invQuorum = (
    not(Set(
      "confirm_closed", "challenge_window", "ladder_pending",
      "ladder_vote_open", "ladder_vote_closed", "round_resolved",
      "fee_settlement", "final",
    ).contains(st.phase))
      or st.confirmations.size() >= CONFIRM_Q
  )

  /// INV-CONF-19/22: ladder rounds consecutive and capped; votes unique per
  /// idx, ballot-closed; a live round has a positive deadline; ladder_pending
  /// always has headroom below the cap.
  val invLadder = (
    st.ladderRound >= 0 and st.ladderRound <= MAXL
      and (st.phase != "ladder_vote_open" and st.phase != "ladder_vote_closed"
           and st.phase != "round_resolved" or st.ladderRound >= 1)
      and (st.phase != "ladder_pending" or st.ladderRound < MAXL)
      and (st.phase != "ladder_vote_open" and st.phase != "ladder_vote_closed" or st.roundDeadline >= 1)
  )

  val invVotes = (
    st.ladderVotes.forall(v => v.idx.in(ROSTER) and v.outcome.in(OUTCOMES))
      and ROSTER.forall(i => st.ladderVotes.filter(v => v.idx == i).size() <= 1)
  )

  /// INV-CONF-26: outcome history is append-only with consecutive rounds
  /// 1..|history|, all ≤ ladderRound.
  val invHistory = (
    st.history.keys().size() <= st.ladderRound
      and st.history.keys().forall(r => r >= 1 and r <= st.ladderRound)
      and 1.to(st.history.keys().size()).forall(r => r.in(st.history.keys()))
  )

  /// INV-CONF-27/28/31: every flag is justified — overturned flags name
  /// actual confirmers; round_flip flags name actual winners of that round;
  /// manual flags name roster members; overturn flags are unique per idx.
  val invFlags = (
    st.flags.forall(f =>
        f.reason.in(ALL_REASONS)
          and (f.reason != "overturned_confirmation"
               or st.confirmations.exists(c => c.idx == f.idx))
          and (f.reason != "round_flip"
               or (f.round.in(st.history.keys())
                    and st.history.get(f.round).winners.contains(f.idx)))
          and ((f.reason != "manual_fee" and f.reason != "manual_other") or f.idx.in(ROSTER)))
      and ROSTER.forall(i =>
        st.flags.filter(f => f.idx == i and f.reason == "overturned_confirmation").size() <= 1)
  )

  /// INV-CONF-27 economic soundness: a resolution that overturned the
  /// proposal flags EVERY confirming juror.
  val invOverturnSoundness = (
    (st.phase != "round_resolved" and st.phase != "fee_settlement" and st.phase != "final")
      or st.pending.upheld
      or st.confirmations.forall(c =>
        st.flags.exists(f => f.idx == c.idx and f.reason == "overturned_confirmation"))
  )

  /// Pending-verdict coherence: upheld ⟺ the outcome IS the proposal.
  val invPendingCoherence = st.pending.upheld.iff(st.pending.outcome == PROPOSED)

  /// INV-CONF-33 (r3-1): every fee_settlement/final state has non-empty
  /// verdict support — the "unreachable on live paths" claim, machine-checked.
  val invFinalSupport = (
    (st.phase != "fee_settlement" and st.phase != "final") or finalSupportSize >= 1
  )

  /// INV-CONF-32/14: finality coherence.
  val invFinal = (
    st.finalized.iff(st.phase == "final")
      and (st.phase != "final" or (
        st.finalVerdict.outcome.in(OUTCOMES)
          and st.finalVerdict.support >= 1
          and st.finalVerdict.outcome == st.pending.outcome
          and st.finalVerdict.upheld == st.pending.upheld))
  )

  val invFailure = (st.failure != "").iff(st.phase.in(Set("expired", "aborted")))

  val invFees = (
    st.fees.forall(f => f.in(FEEIDS))
      and FEEIDS.forall(f => st.fees.filter(x => x == f).size() <= 1)
  )

  val inv = (
    invConfig
    and invPhase
    and invClock
    and invConfirmations
    and invChallenges
    and invQuorum
    and invLadder
    and invVotes
    and invHistory
    and invFlags
    and invOverturnSoundness
    and invPendingCoherence
    and invFinalSupport
    and invFinal
    and invFailure
    and invFees
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation runners — `quint run` with invariants (seeded, deterministic).
// ─────────────────────────────────────────────────────────────────────────────

module voteSim {
  import voteMachine(N = 3, COMMIT_D = 10, REVEAL_D = 20) as M
  import protocolUtil.*

  // Deadline-aware argument sets: each step draws timestamps from the window
  // where its guard can pass, so random walks drift through the phase graph
  // instead of dying on the first mistimed pick. This is harness input
  // distribution ONLY — the guards still decide enablement, and Apalache
  // checks the step relation exhaustively.
  val T_COMMIT = Set(1, 5, 9)          // < COMMIT_D
  val T_CLOSE = Set(10, 15, 20)        // >= COMMIT_D
  val T_OPEN = Set(11, 15, 19)         // < REVEAL_D
  val T_REVEAL = Set(12, 15, 19)       // < REVEAL_D
  val T_LATE = Set(20, 25, 30)         // >= REVEAL_D
  val T_FINAL = Set(21, 25, 30)
  val T_TICK = Set(5, 10, 15, 20, 25, 30)  // mixed: mostly no-op, sometimes expiry

  action init: bool = M::init

  action stepCommit: bool = {
    nondet i = M::ROSTER.oneOf()
    nondet h = HASHES.oneOf()
    nondet t = T_COMMIT.oneOf()
    M::doAcceptCommit(i, h, t)
  }

  action stepCloseCommits: bool = {
    nondet t = T_CLOSE.oneOf()
    M::doCloseCommits(t)
  }

  action stepOpenReveals: bool = {
    nondet t = T_OPEN.oneOf()
    M::doOpenReveals(t)
  }

  action stepAcceptReveal: bool = {
    nondet i = M::ROSTER.oneOf()
    nondet o = OUTCOMES.oneOf()
    nondet s = SALT.oneOf()
    nondet t = T_REVEAL.oneOf()
    M::doAcceptReveal(i, o, s, t)
  }

  action stepCloseReveals: bool = {
    nondet t = T_LATE.oneOf()
    M::doCloseReveals(t)
  }

  action stepFinalize: bool = {
    nondet t = T_FINAL.oneOf()
    M::doFinalize(t)
  }

  action stepTick: bool = {
    nondet t = T_TICK.oneOf()
    all {
      not(M::TERMINALS.contains(M::st.phase)),   // terminal states end the walk
      M::doTick(t),
    }
  }

  /// Operator abort is rare in practice — gate it to 1-in-4 (harness bias
  /// only; the legal-step relation is unchanged).
  action stepAbort: bool = {
    nondet g = 1.to(4).oneOf()
    all { g == 1, M::doAbort }
  }

  action step: bool = any {
    stepCommit,
    stepCommit,
    stepCloseCommits,
    stepOpenReveals,
    stepAcceptReveal,
    stepAcceptReveal,
    stepCloseReveals,
    stepFinalize,
    stepTick,
    stepAbort,
  }

  val inv = M::inv

  /// Witnesses — reported per-run by `quint run --witnesses` as reachability
  /// coverage evidence for the random walks.
  val wExpired = M::st.phase == "expired"
  val wAborted = M::st.phase == "aborted"
  val wTallyFinal = M::st.phase == "tally_final"
  val wFullLedger = M::st.commits.size() == M::N and M::st.reveals.size() == M::N
}

module confirmSim {
  import confirmationMachine(
    N = 3, CONFIRM_Q = 1, CONFIRM_D = 10, CHALLENGE_D = 20,
    MAXL = 2, PROPOSED = "A",
  ) as M
  import protocolUtil.*

  // Deadline-aware argument sets (see voteSim note): harness input
  // distribution only; guards decide enablement.
  val T_CONFIRM = Set(1, 5, 9)         // < CONFIRM_D
  val T_CLOSE_C = Set(10, 15)          // >= CONFIRM_D
  val T_OPEN_W = Set(11, 15, 19)       // < CHALLENGE_D
  val T_CHALLENGE = Set(12, 15, 19)    // < CHALLENGE_D
  val T_CLOSE_W = Set(20, 25)          // >= CHALLENGE_D
  val T_ROUND_D = Set(25, 30, 35)      // voteDeadline candidates
  val T_ROUND_OPEN = Set(21, 22, 24)   // < voteDeadline
  val T_VOTE = Set(22, 24, 26, 29)
  val T_ROUND_CLOSE = Set(25, 30, 35, 40)
  val T_RESOLVE = Set(26, 30, 41)
  val T_PARK = Set(27, 30)
  val T_ANYTIME = Set(1, 5)
  val T_FLAG = Set(21, 25)
  val T_FINALIZE = Set(21, 30, 42)
  val T_TICK = Set(5, 10, 15, 20, 30, 40)  // mixed: mostly no-op, sometimes expiry
  val ROUNDS = Set(1, 2, 3)

  action init: bool = M::init

  action stepConfirm: bool = {
    nondet i = M::ROSTER.oneOf()
    nondet t = T_CONFIRM.oneOf()
    M::doAcceptConfirmation(i, M::CH(i), t)
  }

  action stepCloseConfirmations: bool = {
    nondet t = T_CLOSE_C.oneOf()
    M::doCloseConfirmations(t)
  }

  action stepOpenChallengeWindow: bool = {
    nondet t = T_OPEN_W.oneOf()
    M::doOpenChallengeWindow(t)
  }

  action stepAcceptChallenge: bool = {
    nondet i = M::ROSTER.oneOf()
    nondet t = T_CHALLENGE.oneOf()
    M::doAcceptChallenge(i, t)
  }

  action stepCloseChallengeWindow: bool = {
    nondet t = T_CLOSE_W.oneOf()
    M::doCloseChallengeWindow(t)
  }

  action stepOpenLadderRound: bool = {
    nondet r = ROUNDS.oneOf()
    nondet d = T_ROUND_D.oneOf()
    nondet t = T_ROUND_OPEN.oneOf()
    M::doOpenLadderRound(r, d, t)
  }

  action stepAcceptMassVote: bool = {
    nondet i = M::ROSTER.oneOf()
    nondet o = OUTCOMES.oneOf()
    nondet t = T_VOTE.oneOf()
    M::doAcceptMassVote(i, o, t)
  }

  action stepCloseLadderRound: bool = {
    nondet t = T_ROUND_CLOSE.oneOf()
    M::doCloseLadderRound(t)
  }

  action stepResolveRound: bool = {
    nondet t = T_RESOLVE.oneOf()
    M::doResolveRound(t)
  }

  action stepEscalate: bool = {
    nondet t = T_PARK.oneOf()
    M::doEscalate(t)
  }

  action stepConcede: bool = {
    nondet t = T_PARK.oneOf()
    M::doConcede(t)
  }

  action stepRecordFee: bool = {
    nondet f = M::FEEIDS.oneOf()
    nondet t = T_ANYTIME.oneOf()
    M::doRecordFee(f, t)
  }

  action stepFlagClawback: bool = {
    nondet i = M::ROSTER.oneOf()
    nondet reason = M::MANUAL_REASONS.oneOf()
    nondet t = T_FLAG.oneOf()
    M::doFlagClawback(i, reason, t)
  }

  action stepFinalize: bool = {
    nondet t = T_FINALIZE.oneOf()
    M::doFinalizeConf(t)
  }

  action stepTick: bool = {
    nondet t = T_TICK.oneOf()
    all {
      not(M::TERMINALS.contains(M::st.phase)),   // terminal states end the walk
      M::doTick(t),
    }
  }

  /// Operator abort is rare in practice — gate it to 1-in-4 so the random
  /// walks sample deeper protocol paths (harness bias only; the legal-step
  /// relation is unchanged and exhaustively checked by Apalache).
  action stepAbort: bool = {
    nondet g = 1.to(4).oneOf()
    all { g == 1, M::doAbort }
  }

  action step: bool = any {
    stepConfirm,
    stepConfirm,
    stepCloseConfirmations,
    stepOpenChallengeWindow,
    stepAcceptChallenge,
    stepAcceptChallenge,
    stepCloseChallengeWindow,
    stepOpenLadderRound,
    stepAcceptMassVote,
    stepAcceptMassVote,
    stepAcceptMassVote,
    stepCloseLadderRound,
    stepResolveRound,
    stepResolveRound,
    stepEscalate,
    stepConcede,
    stepRecordFee,
    stepFlagClawback,
    stepFinalize,
    stepTick,
    stepAbort,
  }

  val inv = M::inv

  /// Witnesses — reachability coverage evidence for the random walks.
  val wExpired = M::st.phase == "expired"
  val wAborted = M::st.phase == "aborted"
  val wFinal = M::st.phase == "final"
  val wOverturned = M::st.flags.exists(f => f.reason == "overturned_confirmation")
  val wFlip = M::st.flags.exists(f => f.reason == "round_flip")
  val wTwoRounds = M::st.history.keys().size() == 2
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite — mirrors the scenario matrix of __tests__/courtVoteMachine.test.ts
// and __tests__/courtConfirmationMachine.test.ts (happy paths, tie-breaks,
// idempotent redelivery, guard rejections, deadline boundaries, tick table,
// clawback economics). NOTE: quint test only executes `run` defs whose name
// ends in `Test` (quint 0.33 discovery rule).
// ─────────────────────────────────────────────────────────────────────────────

module voteTests {
  import voteMachine(N = 2, COMMIT_D = 10, REVEAL_D = 20) as V

  /// Happy path: both jurors commit and reveal "A" → tally_final, A wins 2-0.
  run voteHappyPathTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))       // H("A",1) = 9
    .then(V::doAcceptCommit(2, 10, 2))      // H("A",2) = 10
    .then(V::doCloseCommits(10))            // exactly at the deadline: legal
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "A", 1, 12))
    .then(V::doAcceptReveal(2, "A", 2, 13))
    .then(V::doCloseReveals(20))
    .then(V::doFinalize(21))
    .expect(V::st.phase == "tally_final" and V::st.verdict.outcome == "A" and V::st.verdict.support == 2)

  /// INV-VOTE-16: a 1-1 tie breaks to the lexicographically smallest outcome.
  run voteTieBreaksLexicographicTest = V::init
    .then(V::doAcceptCommit(1, 25, 1))      // H("B",1) = 25
    .then(V::doAcceptCommit(2, 9, 2))       // H("A",1) = 9
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "B", 1, 12))
    .then(V::doAcceptReveal(2, "A", 1, 13))
    .then(V::doCloseReveals(20))
    .then(V::doFinalize(21))
    .expect(V::st.verdict.outcome == "A" and V::st.verdict.support == 1)

  /// INV-VOTE-8: identical commit redelivery is idempotent (state unchanged,
  /// clock ledger still advances).
  run voteIdempotentCommitRedeliveryTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doAcceptCommit(1, 9, 2))
    .expect(V::st.commits.size() == 1 and V::st.clock == 2)

  /// INV-VOTE-8: a conflicting commit from the same participant is rejected.
  run voteConflictingCommitRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doAcceptCommit(1, 25, 2).fail())

  /// INV-VOTE-9: legacy sessionless-format commits (version bit unset) are
  /// rejected at the boundary.
  run voteLegacyCommitRejectedTest = V::init
    .then(V::doAcceptCommit(1, 1, 1).fail())

  /// INV-VOTE-5: a commit at (or after) the commit deadline is rejected.
  run voteCommitAtDeadlineRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 10).fail())

  run voteCommitAfterDeadlineRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 11).fail())

  /// INV-VOTE-8: non-roster commit rejected.
  run voteNonRosterCommitRejectedTest = V::init
    .then(V::doAcceptCommit(5, 9, 1).fail())

  /// INV-VOTE-12: a reveal without a prior commit is rejected.
  run voteRevealWithoutCommitRejectedTest = V::init
    .then(V::doAcceptReveal(1, "A", 1, 1).fail())

  /// INV-VOTE-12: a reveal that does not match the exact session-bound commit
  /// (wrong outcome or wrong salt) is rejected; the exact match is accepted.
  run voteRevealMismatchRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "A", 1, 12))
    .expect(
      V::st.reveals.size() == 1
      and not(V::canAcceptReveal(1, "B", 2, 13))   // H("B",2)=26 != 9
      and not(V::canAcceptReveal(1, "A", 2, 13))   // H("A",2)=10 != 9
    )

  /// INV-VOTE-11: identical reveal redelivery is idempotent.
  run voteIdempotentRevealRedeliveryTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "A", 1, 12))
    .then(V::doAcceptReveal(1, "A", 1, 13))
    .expect(V::st.reveals.size() == 1)

  /// INV-VOTE-11: a conflicting reveal (same idx, different outcome) is rejected.
  run voteConflictingRevealRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "A", 1, 12))
    .then(V::doAcceptReveal(1, "B", 1, 13).fail())

  /// INV-VOTE-13: ballot closure — an outcome outside the frozen allowlist is
  /// rejected even with a matching commit.
  run voteUnknownOutcomeRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "C", 1, 12).fail())

  /// INV-VOTE-7: a tick at the reveal deadline expires the ceremony.
  run voteTickExpiresAtRevealDeadlineTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doTick(20))
    .expect(V::st.phase == "expired" and V::st.failure != "")

  /// A tick before the deadline is a no-op (but advances the clock ledger).
  run voteTickBeforeDeadlineKeepsPhaseTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doTick(5))
    .expect(V::st.phase == "commit_open" and V::st.clock == 5)

  /// INV-VOTE-7 (conservative expiry): reveal_closed is tick-exempt — the
  /// ceremony is one step from finalization and must not expire.
  run voteTickDoesNotExpireRevealClosedTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "A", 1, 12))
    .then(V::doCloseReveals(20))
    .then(V::doTick(25))
    .expect(V::st.phase == "reveal_closed")

  /// INV-VOTE-22: abort from a non-terminal phase; INV-VOTE-21: terminal
  /// absorption — no event (including abort) is accepted afterwards.
  run voteAbortAndTerminalAbsorptionTest = V::init
    .then(V::doAbort)
    .then(V::doTick(30))
    .expect(
      V::st.phase == "aborted"
      and V::st.failure != ""
      and V::st.clock == 30
      and not(V::canAbortVote)                      // terminal: abort refused
      and not(V::canAcceptCommit(1, 9, 31))         // no events after terminal
      and not(V::canFinalize(31))
    )

  /// finalize_tally with an empty reveal ledger is rejected
  /// (courtVoteMachine.ts:789-791).
  run voteFinalizeWithoutRevealsRejectedTest = V::init
    .then(V::doAcceptCommit(1, 9, 1))
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doCloseReveals(20))
    .then(V::doFinalize(21).fail())

  /// Witness: tally_final is reachable from a single-voter ceremony.
  run voteVerdictReachableTest = V::init
    .then(V::doAcceptCommit(1, 10, 1))      // H("A",2) = 10
    .then(V::doCloseCommits(10))
    .then(V::doOpenReveals(11))
    .then(V::doAcceptReveal(1, "A", 2, 12))
    .then(V::doCloseReveals(20))
    .then(V::doFinalize(21))
    .expect(V::st.verdict.outcome == "A")
}

module confirmTests {
  import confirmationMachine(
    N = 3, CONFIRM_Q = 1, CONFIRM_D = 10, CHALLENGE_D = 20,
    MAXL = 2, PROPOSED = "A",
  ) as C

  /// Happy path, never challenged: confirm → close → open window → close
  /// window (no challenge) → fee_settlement → finalize ⇒ the proposal stands
  /// (INV-CONF-18 no-challenge routing, INV-CONF-32 finality).
  run confirmHappyPathNoChallengeTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))   // CH(1) = 9
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doFinalizeConf(21))
    .expect(C::st.phase == "final"
      and C::st.finalVerdict.outcome == "A"
      and C::st.finalVerdict.upheld
      and C::st.finalVerdict.support == 1)

  /// INV-CONF-9: a confirmation hash that is not the canonical binding is
  /// rejected.
  run confirmWrongHashRejectedTest = C::init
    .then(C::doAcceptConfirmation(1, 99, 5).fail())

  /// Non-roster confirmation rejected.
  run confirmNonRosterRejectedTest = C::init
    .then(C::doAcceptConfirmation(7, C::CH(7), 5).fail())

  /// INV-CONF-11: accept_confirmation only during confirm_open.
  run confirmAfterWindowRejectedTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doAcceptConfirmation(2, C::CH(2), 11).fail())

  /// A challenge carries a (verified) bond; duplicate challenge idempotent.
  run confirmChallengeIdempotentTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doAcceptChallenge(2, 13))
    .expect(C::st.challenges.size() == 1)

  /// INV-CONF-27: a round that overturns the proposal flags every confirming
  /// juror (overturned_confirmation, exactly once); finality = the last
  /// resolved round's winner (INV-CONF-32).
  run confirmChallengeOverturnClawbackTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .expect(C::st.phase == "ladder_pending")
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "B", 22))
    .then(C::doAcceptMassVote(2, "B", 23))
    .then(C::doAcceptMassVote(3, "A", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .expect(C::st.phase == "round_resolved"
      and C::st.pending.outcome == "B"
      and not(C::st.pending.upheld)
      and C::st.flags.exists(f => f.reason == "overturned_confirmation" and f.idx == 1)
      and C::st.flags.filter(f => f.reason == "overturned_confirmation").size() == 1)
    .then(C::doConcede(27))
    .then(C::doFinalizeConf(28))
    .expect(C::st.phase == "final"
      and C::st.finalVerdict.outcome == "B"
      and C::st.finalVerdict.support == 2
      and not(C::st.finalVerdict.upheld))

  /// §4.2 flip-flop rule (INV-CONF-28): round 2's winner differing from
  /// round 1's winner flags round 1's majority (round_flip, round 1, once
  /// each); the overturn flag is not duplicated.
  run confirmFlipFlopClawbackTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "B", 22))
    .then(C::doAcceptMassVote(2, "B", 23))
    .then(C::doAcceptMassVote(3, "A", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .then(C::doEscalate(27))
    .then(C::doOpenLadderRound(2, 40, 28))
    .then(C::doAcceptMassVote(1, "A", 29))
    .then(C::doAcceptMassVote(2, "A", 30))
    .then(C::doAcceptMassVote(3, "B", 31))
    .then(C::doCloseLadderRound(40))
    .then(C::doResolveRound(41))
    .expect(C::st.pending.outcome == "A" and C::st.pending.upheld
      and C::st.flags.exists(f => f.reason == "round_flip" and f.round == 1 and f.idx == 1)
      and C::st.flags.exists(f => f.reason == "round_flip" and f.round == 1 and f.idx == 2)
      and not(C::st.flags.exists(f => f.reason == "round_flip" and f.idx == 3))
      and C::st.flags.filter(f => f.reason == "overturned_confirmation").size() == 1)
    .then(C::doFinalizeConf(42))      // round 2 == MAXL: already fee_settlement
    .expect(C::st.phase == "final" and C::st.finalVerdict.outcome == "A" and C::st.finalVerdict.support == 2)

  /// INV-CONF-19: ladder rounds must be consecutive — round 2 cannot open
  /// while ladderRound is still 0.
  run confirmRoundMustBeConsecutiveTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .expect(not(C::canOpenLadderRound(2, 25, 21)))   // must be round 1 first

  /// INV-CONF-19: round 1 opens normally from ladder_pending.
  run confirmFirstRoundOpensTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .expect(C::st.phase == "ladder_vote_open" and C::st.ladderRound == 1)

  /// INV-CONF-19/29: the ladder cap is enforced — with maxLadderRounds = 2,
  /// round 2 (the last) settles fees directly and no round 3 can open.
  run confirmLadderCapEnforcedTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "A", 22))
    .then(C::doAcceptMassVote(2, "A", 23))
    .then(C::doAcceptMassVote(3, "A", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .then(C::doEscalate(27))
    .then(C::doOpenLadderRound(2, 40, 28))
    .then(C::doAcceptMassVote(1, "B", 29))
    .then(C::doAcceptMassVote(2, "B", 30))
    .then(C::doAcceptMassVote(3, "B", 31))
    .then(C::doCloseLadderRound(40))
    .then(C::doResolveRound(41))
    .then(C::doFinalizeConf(51))
    .expect(
      C::st.phase == "final"
      and C::st.finalVerdict.outcome == "B"
      and not(C::canEscalate(52))                    // cap reached
      and not(C::canOpenLadderRound(3, 55, 52))      // no round 3
    )

  /// The tick deadline table (INV-CONF-13): confirm_closed expires at the
  /// CHALLENGE deadline — the host must open the challenge window strictly
  /// before it or the case dies.
  run confirmTickExpiresConfirmClosedTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doTick(20))
    .expect(C::st.phase == "expired" and C::st.failure != "")

  /// Tick exemption (INV-CONF-13): ladder_pending / round_resolved /
  /// fee_settlement wait on mandatory explicit transitions, never expire.
  run confirmTickExemptsWaitingPhasesTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "A", 22))
    .then(C::doAcceptMassVote(2, "A", 23))
    .then(C::doAcceptMassVote(3, "A", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .then(C::doTick(100))
    .expect(C::st.phase == "round_resolved")     // round_resolved: tick-exempt
    .then(C::doConcede(101))
    .then(C::doTick(102))
    .expect(C::st.phase == "fee_settlement")     // fee_settlement: tick-exempt

  /// INV-CONF-30: record_fee is idempotent and legal in every non-terminal
  /// phase (the handler carries no phase guard by design).
  run confirmRecordFeeIdempotentAnywhereTest = C::init
    .then(C::doRecordFee(1, 1))
    .then(C::doRecordFee(1, 2))
    .then(C::doRecordFee(2, 3))
    .expect(C::st.fees.size() == 2 and C::st.clock == 3 and C::st.phase == "confirm_open")

  /// INV-CONF-31: flag_clawback only during fee_settlement; idempotent per
  /// (idx, reason) once there.
  run confirmFlagClawbackDisciplineTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doFlagClawback(1, "manual_fee", 21))
    .then(C::doFlagClawback(2, "manual_other", 22))
    .then(C::doFlagClawback(1, "manual_other", 24))
    .expect(
      C::st.flags.filter(f => f.reason == "manual_fee").size() == 1
      and C::st.flags.filter(f => f.reason == "manual_other").size() == 2
      and not(C::canFlagClawback(1, "manual_fee", 25))      // idempotent per (idx, reason)
      and not(C::canFlagClawback(1, "manual_other", 25))
    )

  /// flag_clawback is refused outside fee_settlement.
  run confirmFlagClawbackOutsideFeeSettlementTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .expect(not(C::canFlagClawback(1, "manual_fee", 6)))

  /// An upheld challenged round is backed by THAT round's winning votes
  /// (not the confirmation ledger) — the v0.8.5 → ladder evidence rule.
  run confirmUpheldRoundBackedByRoundVotesTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "A", 22))
    .then(C::doAcceptMassVote(2, "A", 23))
    .then(C::doAcceptMassVote(3, "B", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .then(C::doConcede(27))
    .then(C::doFinalizeConf(28))
    .expect(C::st.phase == "final"
      and C::st.finalVerdict.outcome == "A"
      and C::st.finalVerdict.upheld
      and C::st.finalVerdict.support == 2)

  /// INV-CONF-14: terminal absorption at `final` — no further event,
  /// including abort, is accepted.
  run confirmTerminalAbsorptionTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doFinalizeConf(21))
    .then(C::doTick(30))
    .expect(
      C::st.phase == "final"
      and C::st.clock == 30
      and not(C::st.phase == "fee_settlement" and C::finalSupportSize >= 1)  // finalize refused
      and not(C::canFlagClawback(1, "manual_fee", 31))
      and C::TERMINALS.contains(C::st.phase)                                 // abort refused
    )

  /// INV-CONF-14: abort from a non-terminal phase.
  run confirmAbortFromNonTerminalTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doAbort)
    .expect(C::st.phase == "aborted" and C::st.failure != "")

  /// Witness: the full challenged → overturned → clawback → final path.
  run confirmLadderOverturnReachableTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "B", 22))
    .then(C::doAcceptMassVote(2, "B", 23))
    .then(C::doAcceptMassVote(3, "A", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .then(C::doConcede(27))
    .then(C::doFinalizeConf(28))
    .expect(C::st.finalVerdict.outcome == "B")
}

/// Quorum gate with a quorum of 2 (INV-CONF-15: fail-closed close).
module confirmQuorumTests {
  import confirmationMachine(
    N = 3, CONFIRM_Q = 2, CONFIRM_D = 10, CHALLENGE_D = 20,
    MAXL = 2, PROPOSED = "A",
  ) as C

  run confirmQuorumNotMetCloseRejectedTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10).fail())

  run confirmQuorumMetCloseAcceptedTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doAcceptConfirmation(2, C::CH(2), 6))
    .then(C::doCloseConfirmations(10))
    .expect(C::st.phase == "confirm_closed" and C::st.confirmations.size() == 2)

  /// A quorum that never formed is expired by a tick, never silently closed
  /// (confirm_open expires at CONFIRM_D via the tick deadline table: a tick
  /// at/after the deadline expires the case).
  run confirmUnformedQuorumExpiresTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doTick(9))
    .expect(C::st.phase == "confirm_open")   // strictly before the deadline
    .then(C::doTick(10))
    .expect(C::st.phase == "expired")
}

/// maxLadderRounds = 1: the v0.8.5 single-round flow — the round settles fees
/// directly, escalate is refused.
module confirmCapOneTests {
  import confirmationMachine(
    N = 3, CONFIRM_Q = 1, CONFIRM_D = 10, CHALLENGE_D = 20,
    MAXL = 1, PROPOSED = "A",
  ) as C

  run confirmSingleRoundSettlesDirectlyTest = C::init
    .then(C::doAcceptConfirmation(1, C::CH(1), 5))
    .then(C::doCloseConfirmations(10))
    .then(C::doOpenChallengeWindow(11))
    .then(C::doAcceptChallenge(2, 12))
    .then(C::doCloseChallengeWindow(20))
    .then(C::doOpenLadderRound(1, 25, 21))
    .then(C::doAcceptMassVote(1, "B", 22))
    .then(C::doAcceptMassVote(2, "B", 23))
    .then(C::doAcceptMassVote(3, "A", 24))
    .then(C::doCloseLadderRound(25))
    .then(C::doResolveRound(26))
    .expect(C::st.phase == "fee_settlement")   // round 1 == MAXL=1: settles directly
    .then(C::doTick(30))
    .expect(not(C::canEscalate(31)))   // cap reached
    .then(C::doFinalizeConf(31))
    .expect(C::st.phase == "final" and C::st.finalVerdict.outcome == "B")
}
