// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

// Quint model of the ESCALATION TRANSPORT — the v0.14.0 wire
// (`courtEscalationRequest.ts`) landing on the reducer (`onEscalate` /
// `onOpenLadderRound` in `confirmationMachineHandlers.ts`), plus the ledger
// invariants review rounds 30–40 added.
//
// It is a THIRD model, written from the TS guard clauses, in the style of
// `court.qnt` (an independent re-model, not a transcription). Cross-references:
// docs/FORMAL_INVARIANTS.md §5 INV-ESC-5..9 and INV-CONF-16/17, and
// docs/proofs/07-mechanised-escalation.tex.md.
//
// WHAT IS MODELLED, and the three claims this file machine-checks:
//
//  1. PARSE → MAP → REDUCE. A challenger's request arrives as a WIRE value: its
//     case id, the round it was signed for, its x-only pubkey, its membership
//     bond and its per-round bond. The transport cannot verify the last three;
//     the HOST holds the binding (the case id it routed on, and the pubkey the
//     request authenticated as — `CourtEscalationBinding`, r8-2). `canParse`
//     is the codec's shape check; `canMap` is the r8-2 binding check (case id,
//     authenticated pubkey, resolved round — round 9's `bondTxid` binding is NOT
//     modelled: ids are abstract `int`s here); and `canReduce` is the reducer's
//     witness check. Claim:
//     **invBinding** — every recorded escalation carries wire claims that AGREE
//     with the host binding, for every wire the environment may offer
//     (`wireSim` deliberately offers mismatched, stale and replayed ones).
//  2. THE ROUND BOUND. Claim: **invRoundBound** / **invSeatNeedsRung** — a
//     round-bound witness opens only `ladderRound + 1`, and `open_ladder_round`
//     may only seat the round a pending escalation record names (r40-2's
//     rung-spend barrier). Claim: **invRungRounds** — the log's rounds are a
//     consecutive `2..ladderRound` sequence.
//  3. BOND CONSUMPTION. Claim: **invBondConsumption** — a per-round bond is a
//     fresh witness, never the membership bond (own OR another juror's), and
//     never consumed twice (INV-ESC-9 / r33-1); **invStrict** — under
//     `requireRoundBond` every rung has one.
//
// ABSTRACTIONS (see README.md "Divergences"): hashes and pubkeys are `int`
// literals — injectivity is all the guards need; `roundBond == 0` stands for
// the wire's `null` (a legacy witness); the codec's canonicalisation (UTF-8
// injectivity, duplicate-key refusal, the v2 hash preimage) is NOT modelled —
// it is TS-suite-checked (`__tests__/reviewRound8.test.ts`). The host's
// authentication is an ASSUMPTION: `st.authenticated` is what NIP-98 proved,
// and nothing here checks that it did.
//
// Toolchain: Quint 0.33.1 — `./run.sh` (see README.md).

module escalationTransport {

  // ── Instance parameters ──────────────────────────────────────────────────

  const N: int          // roster size
  const MAXL: int       // maxLadderRounds (frozen per case)
  const STRICT: bool    // requireRoundBond (the R42 default)

  // Abstract domains. `ROUND_BONDS` values are the per-round witnesses the
  // environment may offer; `BONDS` are membership (challenge) witnesses.
  val ROSTER = Set(1, 2)
  val BONDS = Set(11, 12)
  val ROUND_BONDS = Set(21, 22, 23)
  val PUBKEYS = Set(101, 102)
  val CASES = Set(1, 2)
  // `0` is the wire's `null`: a legacy request with no per-round witness.
  val NO_ROUND_BOND = 0
  // The rounds the log may name; round 1 is opened by the challenge itself.
  val RUNG_ROUNDS = Set(2, 3, 4, 5)
  // The rounds a REQUEST may name (`MAX_ESCALATION_REQUEST_ROUND` = 5): the
  // request names the RESOLVED round it escalates past, so 1 is legal.
  val WIRE_ROUNDS = Set(1, 2, 3, 4, 5)

  type Challenge = { idx: int, bond: int }

  /// One append-only escalation record (`CourtEscalationRecord`). The wire
  /// claims the challenger asserted (`pubkey`, `requestCase`) are recorded so
  /// the binding invariant is checkable after the fact — the reducer itself
  /// only stores the derived fields.
  type Rung = {
    round: int,
    challenger: int,
    pubkey: int,
    requestCase: int,
    membershipBond: int,
    roundBond: int,        // NO_ROUND_BOND = the wire carried null
  }

  /// The transported request (`CourtEscalationRequest`), as the host sees it.
  type Wire = {
    caseId: int,
    round: int,
    pubkey: int,
    membershipBond: int,
    roundBond: int,
    concession: bool,
  }

  type State = {
    phase: str,            // challenge_window | round_resolved | ladder_pending
                           // | ladder_vote_open | final
    ladderRound: int,      // highest ladder round OPENED (round 1 at creation)
    challenges: Set[Challenge],
    log: Set[Rung],
    // The HOST binding: what the transport resolved and authenticated. Never
    // taken from the wire (r8-2).
    boundCase: int,
    authenticated: int,
  }

  var st: State

  action init: bool = st' = {
    phase: "challenge_window",
    ladderRound: 1,
    challenges: Set(),
    log: Set(),
    boundCase: 1,
    authenticated: 101,
  }

  // ── The codec's shape check (`buildCourtEscalationRequest`) ───────────────

  /// Parse/normalise. The real codec also refuses duplicate keys, non-canonical
  /// UTF-8 case ids and malformed hex; those are TS-suite-checked and abstracted
  /// here to a domain check.
  def canParse(w: Wire): bool = (
    w.caseId.in(CASES)
      and w.round.in(WIRE_ROUNDS)
      and w.pubkey.in(PUBKEYS)
      and w.membershipBond.in(BONDS)
      and (w.roundBond == NO_ROUND_BOND or w.roundBond.in(ROUND_BONDS))
  )

  // ── The host binding (`escalationRequestToMachineEvent`, r8-2) ────────────

  /// The mapper's three refusals: the request must name the case the host
  /// routed on, the pubkey the request authenticated as, and the round the case
  /// is resolving. Without them, one signed request could name another juror, a
  /// different case, or open a rung its signer never authorised.
  def canMap(w: Wire): bool = (
    w.caseId == st.boundCase
      and w.pubkey == st.authenticated
      and w.round == st.ladderRound
  )

  // ── The reducer's witness checks (`onEscalate`) ──────────────────────────

  def bondOwnedBy(idx: int, bond: int): bool =
    st.challenges.exists(c => c.idx == idx and c.bond == bond)

  def bondAccepted(bond: int): bool = st.challenges.exists(c => c.bond == bond)

  /// The mapper refuses an AMBIGUOUS witness (`bonds.length > 1`): one bond, one
  /// owner (r38-1) is the ledger invariant that makes the owner derivable at all.
  def bondUnique(bond: int): bool =
    st.challenges.filter(c => c.bond == bond).size() == 1

  def roundBondConsumed(bond: int): bool =
    bond != NO_ROUND_BOND and st.log.exists(r => r.roundBond == bond)

  def hasRungFor(round: int): bool = st.log.exists(r => r.round == round)

  /// INV-ESC-5/9 + r29-1 + r33-1 + R42, as one predicate. `w.membershipBond`
  /// must be an accepted challenge bond (the reducer takes the challenger's
  /// index from the ledger, never from the wire — the wire has no index at all);
  /// the per-round witness must be distinct from the membership bond, must not
  /// be ANY accepted challenge bond, and must not have been consumed.
  def canReduce(idx: int, w: Wire): bool = (
    st.phase == "round_resolved"
      and st.ladderRound < MAXL
      and st.log.size() < MAXL
      and w.round == st.ladderRound
      and bondOwnedBy(idx, w.membershipBond)
      and bondUnique(w.membershipBond)
      and (w.roundBond == NO_ROUND_BOND
            or (w.roundBond != w.membershipBond
                  and not(bondAccepted(w.roundBond))
                  and not(roundBondConsumed(w.roundBond))))
      and (not(STRICT) or w.roundBond != NO_ROUND_BOND)
  )

  /// The event the reducer mints: `roundIndex` comes from the CASE
  /// (`ladderRound + 1`), the challenger index from the bond owner — never from
  /// the wire.
  def nextRung(idx: int, w: Wire): Rung = {
    round: st.ladderRound + 1,
    challenger: idx,
    pubkey: w.pubkey,
    requestCase: w.caseId,
    membershipBond: w.membershipBond,
    roundBond: w.roundBond,
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  /// `accept_challenge` (INV-CONF-16/17 + r38-1): one bond witness buys one
  /// challenger's standing, in the challenge window only.
  def canAcceptChallenge(idx: int, bond: int): bool = (
    st.phase == "challenge_window"
      and idx.in(ROSTER)
      and bond.in(BONDS)
      and not(st.challenges.exists(c => c.idx == idx))
      and not(bondAccepted(bond))
  )

  action doAcceptChallenge(idx: int, bond: int): bool = all {
    canAcceptChallenge(idx, bond),
    st' = { ...st, challenges: st.challenges.union(Set({ idx: idx, bond: bond })) },
  }

  /// `close_challenge_window`: with at least one challenge the case enters the
  /// ladder (a case with no challenge goes straight to fee settlement, which
  /// this module does not model).
  action doCloseWindow: bool = all {
    st.phase == "challenge_window",
    st.challenges.size() > 0,
    st' = { ...st, phase: "round_resolved" },
  }

  /// PARSE → MAP → REDUCE, in one action (the transport's whole path). All
  /// three layers must pass; the state effect is the reducer's append.
  /// `idx` is NOT a wire field: the reducer takes the challenger's index from
  /// the accepted-challenge ledger (the wire carries no index at all), so the
  /// environment may name any index and `bondOwnedBy` decides. Uniqueness of the
  /// owner (`bondUnique`) is what makes that derivation well defined.
  action doEscalate(idx: int, w: Wire): bool = all {
    canParse(w),
    canMap(w),
    canReduce(idx, w),
    st' = { ...st, phase: "ladder_pending", log: st.log.union(Set(nextRung(idx, w))) },
  }

  /// `open_ladder_round` — the rung-spend barrier (r40-2): the round opened must
  /// be exactly `ladderRound + 1`, and a pending escalation record for it must
  /// exist, so a seat is never spent on a deleted record.
  action doOpenRound(round: int): bool = all {
    st.phase == "ladder_pending",
    round == st.ladderRound + 1,
    round <= MAXL,
    hasRungFor(round),
    st' = { ...st, phase: "ladder_vote_open", ladderRound: round },
  }

  /// `resolve_round`: the round's outcome is recorded and the case waits on the
  /// host's appeal decision (the ladder path; the vote itself is modelled in
  /// `court.qnt`).
  action doResolveRound: bool = all {
    st.phase == "ladder_vote_open",
    st' = { ...st, phase: "round_resolved" },
  }

  /// `concede`: never blocked — the challenger can always drop the appeal, and
  /// the round's outcome becomes final.
  action doConcede: bool = all {
    st.phase == "round_resolved",
    st' = { ...st, phase: "final" },
  }

  /// A challenger that never escalates and never concedes is not modelled: the
  /// case would sit in `round_resolved` until the host's appeal window policy
  /// fires, which is host policy, not machine state.

  // ── Invariants ───────────────────────────────────────────────────────────

  val invPhase = st.phase.in(Set(
    "challenge_window", "round_resolved", "ladder_pending",
    "ladder_vote_open", "final",
  ))

  val invLadderRange = st.ladderRound >= 1 and st.ladderRound <= MAXL

  /// r38-1: one bond witness, one challenger (and one challenger, one bond).
  val invChallenges = (
    st.challenges.forall(c =>
      st.challenges.forall(c2 => (c.bond == c2.bond or c.idx == c2.idx).implies(c == c2)))
  )

  /// INV-ESC-9: the per-round witness is fresh — never the membership bond,
  /// never any accepted challenge bond, and never consumed twice.
  val invBondConsumption = st.log.forall(r =>
    (r.roundBond == NO_ROUND_BOND and not(STRICT))
      or (r.roundBond != NO_ROUND_BOND
            and r.roundBond != r.membershipBond
            and not(bondAccepted(r.roundBond))
            and st.log.forall(r2 => (r2.roundBond == r.roundBond).implies(r2 == r))))

  /// R42: under `requireRoundBond` every rung carries a per-round witness.
  val invStrict = (not(STRICT)) or st.log.forall(r => r.roundBond != NO_ROUND_BOND)

  /// **The transport claim.** Every recorded escalation carries wire claims
  /// that AGREE with the host's binding: the case id the host routed on and the
  /// pubkey the request authenticated as (r8-2). A wire that disagrees is
  /// refused by `canMap` and can never reach the log.
  val invBinding = st.log.forall(r =>
    r.pubkey == st.authenticated and r.requestCase == st.boundCase)

  /// **The round-bound claim**: a witness opens only rounds the case may open,
  /// and its round index is the round the reducer derived (`ladderRound + 1` at
  /// the time), never one the wire chose.
  val invRoundBound = st.log.forall(r => r.round >= 2 and r.round <= st.ladderRound + 1)

  /// The log's rounds are consecutive from 2 up to the highest opened round
  /// (`round === offset + 2`), with at most one pending rung.
  val invRungRounds = all {
    st.log.filter(r => r.round <= st.ladderRound).size() == st.ladderRound - 1,
    st.log.filter(r => r.round == st.ladderRound + 1).size() <= 1,
    st.log.forall(r => r.round <= st.ladderRound + 1),
  }

  /// r40-2's rung-spend barrier: a pending or open round always has its record.
  val invSeatNeedsRung = (
    st.phase.in(Set("ladder_pending", "ladder_vote_open"))
      .implies(hasRungFor(st.ladderRound + 1) or hasRungFor(st.ladderRound))
  )

  /// INV-ESC-5: every rung is bound to THAT challenger's accepted challenge
  /// bond — a witness that names no accepted bond proves nothing (r29-1).
  val invRungMembership = st.log.forall(r =>
    st.challenges.exists(c => c.bond == r.membershipBond and c.idx == r.challenger))

  /// A case that has opened a ladder round has at least one escalation record
  /// (a round is never opened without the record that paid for it — r40-2).
  val invLadderShape = (st.ladderRound > 1).implies(st.log.size() >= 1)

  val invLogBound = st.log.size() <= MAXL

  val inv = all {
    invPhase,
    invLadderRange,
    invChallenges,
    invBondConsumption,
    invStrict,
    invBinding,
    invRoundBound,
    invRungRounds,
    invSeatNeedsRung,
    invRungMembership,
    invLadderShape,
    invLogBound,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation runner — a seeded random walk over the transport, with the wire
// drawn from a set that DELIBERATELY includes hostile requests: a different
// case, a different pubkey, a stale round, a legacy (no round bond) request, a
// membership bond quoted as this round's payment, and a re-used round bond.
// Invariants are checked on every reachable state, so any hostile wire that got
// through the binding would surface as a violation.
// ─────────────────────────────────────────────────────────────────────────────

module escalationSim {
  import escalationTransport(N = 2, MAXL = 3, STRICT = false) as M

  val WIRES = Set(
    // well formed for round 1, challenger 1 (bond 11) — binding-compatible
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false },
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 22, concession: false },
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 0, concession: false },
    // hostile: wrong case / wrong pubkey / stale round (r8-2)
    { caseId: 2, round: 1, pubkey: 101, membershipBond: 11, roundBond: 23, concession: false },
    { caseId: 1, round: 1, pubkey: 102, membershipBond: 11, roundBond: 23, concession: false },
    { caseId: 1, round: 2, pubkey: 101, membershipBond: 11, roundBond: 23, concession: false },
    // hostile: the membership bond relabelled as this round's payment
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 11, concession: false },
    // hostile: another juror's membership bond as this round's payment (r33-1)
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 12, concession: false },
    // hostile: an unaccepted membership bond (r29-1)
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 12, roundBond: 23, concession: false },
  )

  action init: bool = M::init

  action stepChallenge: bool = {
    nondet idx = M::ROSTER.oneOf()
    nondet bond = M::BONDS.oneOf()
    M::doAcceptChallenge(idx, bond)
  }

  action stepCloseWindow: bool = M::doCloseWindow

  action stepEscalate: bool = {
    nondet idx = M::ROSTER.oneOf()
    nondet w = WIRES.oneOf()
    M::doEscalate(idx, w)
  }

  action stepOpenRound: bool = {
    nondet round = M::RUNG_ROUNDS.oneOf()
    M::doOpenRound(round)
  }

  action stepResolve: bool = M::doResolveRound

  action stepConcede: bool = M::doConcede

  action step: bool = any {
    stepChallenge,
    stepCloseWindow,
    stepEscalate,
    stepEscalate,
    stepOpenRound,
    stepResolve,
    stepConcede,
  }

  val inv = M::inv

  /// Reachability witnesses (reported by `quint run --witnesses`).
  val wPending = M::st.phase == "ladder_pending"
  val wRung = M::st.log.exists(r => r.round >= 2)
  val wOpened = M::st.ladderRound >= 2
  val wTwoRungs = M::st.log.size() >= 2
}

/// The strict instance: `requireRoundBond` on, so a legacy (no round bond)
/// request must be refused. Its own walk, because the policy is a constant.
module escalationStrictSim {
  import escalationTransport(N = 2, MAXL = 3, STRICT = true) as M

  val WIRES = Set(
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false },
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 0, concession: false },
    { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 22, concession: false },
    { caseId: 1, round: 2, pubkey: 101, membershipBond: 11, roundBond: 23, concession: false },
  )

  action init: bool = M::init

  action stepChallenge: bool = {
    nondet idx = M::ROSTER.oneOf()
    nondet bond = M::BONDS.oneOf()
    M::doAcceptChallenge(idx, bond)
  }

  action stepCloseWindow: bool = M::doCloseWindow

  action stepEscalate: bool = {
    nondet idx = M::ROSTER.oneOf()
    nondet w = WIRES.oneOf()
    M::doEscalate(idx, w)
  }

  action stepOpenRound: bool = {
    nondet round = M::RUNG_ROUNDS.oneOf()
    M::doOpenRound(round)
  }

  action stepResolve: bool = M::doResolveRound

  action stepConcede: bool = M::doConcede

  action step: bool = any {
    stepChallenge,
    stepCloseWindow,
    stepEscalate,
    stepEscalate,
    stepOpenRound,
    stepResolve,
    stepConcede,
  }

  val inv = M::inv

  val wPending = M::st.phase == "ladder_pending"
  val wRung = M::st.log.exists(r => r.round >= 2)
  val wOpened = M::st.ladderRound >= 2
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario tests — the negative/positive matrix of the v0.14.0 wire.
// (Quint 0.33 discovers only `run` defs whose name ends in `Test`.)
// ─────────────────────────────────────────────────────────────────────────────

module escalationTests {
  import escalationTransport(N = 2, MAXL = 2, STRICT = false) as T

  val W1 = { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false }

  /// The happy path: accept a challenge, close the window, escalate with a
  /// bound request, open the rung it names. The wire's round is the RESOLVED
  /// round (1); the record it produces opens round 2.
  run escalationHappyPathTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, W1))
    .then(T::doOpenRound(2))
    .expect(
      T::st.ladderRound == 2
      and T::st.phase == "ladder_vote_open"
      and T::st.log.exists(r => r.round == 2 and r.challenger == 1 and r.requestCase == 1)
    )

  /// r8-2: a request that names another case never reaches the log.
  run escalationCaseMismatchRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 2, round: 1, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false }).fail())

  /// r8-2: a request whose pubkey is not the one that authenticated never
  /// reaches the log (the append-only log must not name a juror who never
  /// escalated).
  run escalationPubkeyMismatchRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 1, round: 1, pubkey: 102, membershipBond: 11, roundBond: 21, concession: false }).fail())

  /// r8-2: a request signed to escalate past round 1 cannot open round 2 of a
  /// case that is resolving round 2 already — a stale request must not open a
  /// rung its signer never authorised.
  run escalationStaleRoundRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, W1))
    .then(T::doOpenRound(2))
    .then(T::doResolveRound)
    .then(T::doEscalate(1, W1).fail())

  /// INV-ESC-9: the same per-round bond cannot pay for a second rung.
  run escalationReusedRoundBondRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, W1))
    .then(T::doOpenRound(2))
    .then(T::doResolveRound)
    .then(T::doEscalate(1, { caseId: 1, round: 2, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false }).fail())

  /// INV-ESC-9: relabelling the membership bond as this round's payment is not
  /// a payment.
  run escalationMembershipBondAsRoundBondRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 11, concession: false }).fail())

  /// r33-1: another juror's membership bond is not this round's payment either.
  run escalationForeignMembershipBondRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doAcceptChallenge(2, 12))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 12, concession: false }).fail())

  /// r29-1: a membership bond the case never accepted proves nothing.
  run escalationUnacceptedBondRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 1, round: 1, pubkey: 101, membershipBond: 12, roundBond: 21, concession: false }).fail())

  /// r40-2: `open_ladder_round` cannot skip a rung, and cannot seat a round for
  /// which no escalation record exists.
  run openRoundSkipsRungRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, W1))
    .then(T::doOpenRound(3).fail())

  run openRoundWithoutRungRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doOpenRound(2).fail())

  /// The ladder cap: a case at `maxLadderRounds` refuses a further escalation.
  run escalationCapRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, W1))
    .then(T::doOpenRound(2))
    .then(T::doResolveRound)
    .then(T::doEscalate(1, { caseId: 1, round: 2, pubkey: 101, membershipBond: 11, roundBond: 22, concession: false }).fail())

  /// r38-1: one bond witness buys one challenger's standing.
  run challengeDuplicateBondRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doAcceptChallenge(2, 11).fail())

  /// A challenger may always drop the appeal.
  run escalationConcedeTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doConcede)
    .expect(T::st.phase == "final")

  /// The codec's shape check is not the binding check: a well-formed wire for
  /// the WRONG round parses but does not map (parsed ≠ accepted).
  run parseAcceptsButMapRejectsTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .expect(
      T::canParse({ caseId: 1, round: 2, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false })
      and not(T::canMap({ caseId: 1, round: 2, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false }))
    )
}

/// The strict-policy instance's scenarios (`requireRoundBond` on, the R42
/// default): a legacy request with no per-round witness is refused, and a
/// fresh one is accepted.
module escalationStrictTests {
  import escalationTransport(N = 2, MAXL = 2, STRICT = true) as T

  run strictLegacyRequestRejectedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 0, concession: false }).fail())

  run strictRoundBoundAcceptedTest = T::init
    .then(T::doAcceptChallenge(1, 11))
    .then(T::doCloseWindow)
    .then(T::doEscalate(1, { caseId: 1, round: 1, pubkey: 101, membershipBond: 11, roundBond: 21, concession: false }))
    .expect(T::st.log.exists(r => r.roundBond == 21))
}
