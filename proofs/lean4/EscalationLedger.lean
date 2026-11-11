/-
  Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

  # The escalation ledger: bond consumption and one-hash-one-index — Lean 4

  This file mechanises the ledger invariants that review rounds 31–40 added to
  the confirmation machine and that are currently only TEST-pinned:

    * **r38-1 / INV-CONF (challenge ledger)** — `one bond witness buys one
      challenger's standing`: a `bondProofHash` is bound to at most one roster
      index (`assertValidConfirmationLedger`'s `challengeBondOwners`,
      `onAcceptChallenge`'s `bondOwner` refusal).
    * **INV-ESC-9 / r30-1 / r33-1 (per-round bond consumption)** — the
      escalation log is append-only; each rung may carry a `roundBondProofHash`
      that is well-formed, distinct from the membership bond, never an accepted
      challenge bond of ANY juror, and never consumed by an earlier record
      (`assertValidEscalationLog`'s `seenRoundBonds`, `onEscalate`'s
      `consumed` refusal).
    * **INV-ESC-8 / r33-5 / r37-1 / r40-1 / r40-2 (the entry matrix)** — the
      log's rounds are a consecutive `2..k` sequence, every record is bound to
      its own challenger's accepted bond, and a record may not name a round the
      case never opened. These are re-derived at `escalate`, at
      `open_ladder_round` (the "rung-spend barrier", r40-2) and at `finalize`;
      the model captures the fact that the barrier can never refuse a state the
      machine itself produced (preservation, below).

  Mathlib-free (pure Lean 4 core), like `SingleFinality.lean` and
  `LadderBound.lean`.

  ## The model

  A `Case` is two ledgers:

    * `accepted` — the accepted-challenge ledger: `(rosterIdx, bondProofHash)`
      pairs, one entry per challenger (`onAcceptChallenge`);
    * `log`      — the escalation log: `CourtEscalationRecord`s, append-only
      (`onEscalate`).

  `Step` is the machine's two ledger-writing transitions, with the guards the
  reducers actually apply (see the `Step` constructors for the `file:`
  correspondence):

    * `accept` — `onAcceptChallenge`: the index is new, the bond hash owns no
      other challenger, and the challenge window precedes the ladder
      (`log = []`;
      `accept_challenge` requires phase `challenge_window`);
    * `escalate` — `onEscalate`: the record opens exactly the NEXT round
      (`r.round = |log| + 2`, i.e. `roundIndex === ladderRound + 1` with round 1
      opened by the challenge), the membership bond is THIS challenger's
      accepted bond, the round bond (when present) is distinct from that
      membership bond, is not any accepted challenge bond, and has never been
      consumed — and is mandatory under the strict policy
      (`requireRoundBond`).

  `WellFormed` bundles the ledger invariants. `reachable_wellFormed` proves by
  induction over `Step` that every state reachable from `init` satisfies it —
  that is the content: each guard is exactly the conjunct it preserves.

  ## What is proved (no `sorry`, no extra axioms)

    * `reachable_wellFormed` — every reachable state satisfies the full ledger
      invariant bundle. Hence the barriers (`assertValidEscalationLog`,
      `assertValidConfirmationLedger`) can never refuse a machine-produced
      state: the entry matrix at r40-1/r40-2 is a no-op on legal histories and
      only bites on a restored/tampered snapshot.
    * `one_hash_one_index` — **r38-1**: in any reachable state a bond witness
      belongs to at most ONE challenger index.
    * `one_index_one_hash` — the converse (a challenger has at most one
      accepted bond), so the accepted-challenge ledger is a bijection onto its
      hashes.
    * `round_bond_consumed_once` — **INV-ESC-9**: a per-round bond witness
      appears in at most one log record (one payment, one rung).
    * `consumed_not_reused` — **the consumption corollary**: a hash consumed by
      the record for round `R` is not consumed by any LATER record.
    * `round_bond_not_membership` / `round_bond_not_accepted` — **r33-1**: a
      per-round bond is never a relabelled membership bond, neither the
      challenger's own nor another juror's.
    * `strict_case_has_round_bond` — under `requireRoundBond` every record
      carries a fresh per-round witness (the R42 default).
    * `rounds_consecutive` / `opened_rounds_from_one` — **INV-ESC-8**: the
      escalation rounds are `2, 3, …, |log|+1`, so the sequence of ladder rounds
      the case has OPENED is `1, 2, …, |log|+1`.
    * `rounds_strict_mono` / `openedRounds_strict_mono` — that sequence is
      STRICTLY INCREASING from 1, and the log's own rounds are strictly
      increasing from 2.
    * `log_length_bounded` — the log never exceeds the `MAX_LADDER_ROUNDS` (5)
      ladder bound.

  ## What is NOT mechanised

  The hashes are abstract (`Hash := Nat`); that a `bondProofHash` names a real
  on-chain/L2 payment is the host's (and the rail's) check, not the machine's.
  Event-id canonicalisation, timestamp monotonicity (`at`), hex well-formedness,
  and the `host`-authority arm of `onEscalate` are TS-suite concerns and are not
  modelled. The paper's `ΔC_{r+1} = 3^{r+1} b₀` pricing is mechanised separately
  in `LadderBound.lean` (it is the `β` of that model); this file mechanises only
  the CONSUMPTION (one fresh witness per rung), which is the machine's half.
-/

namespace BAOCourt
namespace Escalation

/-! ## 1. The ledgers -/

/-- An abstract bond-proof hash (real: 32-byte lowercase hex). -/
abbrev Hash := Nat

/-- A case-roster index. -/
abbrev Idx := Nat

/-- The ladder cap (`MAX_LADDER_ROUNDS` in `confirmationMachineCore.ts`). -/
def MAX_ROUNDS : Nat := 5

/-- One entry of the escalation log (`CourtEscalationRecord`, minus the fields
    that only carry attribution or a clock). -/
structure Rung where
  /-- The ladder round this escalation OPENED (`escalate.roundIndex`). -/
  round : Nat
  /-- The asserting challenger's case-roster index. -/
  challengerIdx : Idx
  /-- The membership bond witness (`bondProofHash`) — proves standing, not payment. -/
  membershipBond : Hash
  /-- The per-round bond witness (`roundBondProofHash`) — proves payment for
      THIS rung; `none` on a legacy (`requireRoundBond: false`) witness. -/
  roundBond : Option Hash
deriving DecidableEq, Repr

/-- A case: the accepted-challenge ledger and the append-only escalation log. -/
structure Case where
  accepted : List (Idx × Hash)
  log : List Rung
deriving DecidableEq, Repr

/-- No escalation yet: the challenge window is open, round 1 is the case's own
    ladder round (it is opened by the accepted challenge, not by the log). -/
def init : Case := ⟨[], []⟩

/-! ## 2. `RoundsFrom`: consecutive round sequences -/

/-- `RoundsFrom a l` holds when `l = [a, a+1, …, a + |l| - 1]` — the machine's
    "rounds must be a consecutive `2..k` sequence" test, in a form that has an
    induction principle (`RoundsFrom.induct` is structural). -/
def RoundsFrom (a : Nat) : List Nat → Prop
  | [] => True
  | b :: rest => b = a ∧ RoundsFrom (a + 1) rest

/-- The defining property, read off one element at a time: the `i`-th round of a
    consecutive sequence starting at `a` IS `a + i`. -/
theorem RoundsFrom.get {a : Nat} :
    ∀ {l : List Nat}, RoundsFrom a l → ∀ (i : Nat) (hi : i < l.length), l[i]'hi = a + i
  | [], h, i, hi => absurd hi (Nat.not_lt_zero i)
  | b :: rest, h, i, hi => by
    obtain ⟨hb, hrest⟩ := h
    cases i with
    | zero =>
      rw [List.getElem_cons_zero]
      omega
    | succ k =>
      rw [List.getElem_cons_succ]
      have hle : k < rest.length := by
        simp only [List.length_cons] at hi
        omega
      have hk : rest[k]'hle = (a + 1) + k := hrest.get k hle
      omega

/-- Appending the next round keeps a consecutive sequence consecutive. -/
theorem RoundsFrom.append_next {a : Nat} :
    ∀ {l : List Nat}, RoundsFrom a l → ∀ b, b = a + l.length → RoundsFrom a (l ++ [b])
  | [], _, b, hb => by
    simp only [List.nil_append, List.length_nil, Nat.add_zero] at hb
    subst hb
    exact ⟨rfl, trivial⟩
  | x :: rest, h, b, hb => by
    obtain ⟨hx, hrest⟩ := h
    have hb' : b = (a + 1) + rest.length := by
      simp only [List.length_cons] at hb
      omega
    have ih := RoundsFrom.append_next hrest b hb'
    simp only [List.cons_append, List.length_cons] at ih ⊢
    exact ⟨hx, ih⟩

/-! ## 3. The ledger invariants (`assertValidEscalationLog` + `assertValidConfirmationLedger`) -/

/-- The invariant bundle. Each field is the mechanised form of one barrier
    conjunct; `reachable_wellFormed` shows every reachable state satisfies all
    of them. -/
structure WellFormed (strict : Bool) (c : Case) : Prop where
  /-- INV-ESC-8: rounds are consecutive from 2 (`round === offset + 2`). -/
  rounds : RoundsFrom 2 (c.log.map Rung.round)
  /-- INV-ESC-8 / r29-1: each record is bound to THAT challenger's accepted bond. -/
  bound : ∀ r ∈ c.log, (r.challengerIdx, r.membershipBond) ∈ c.accepted
  /-- INV-ESC-9: a round bond is not the record's own membership bond. -/
  distinct : ∀ r ∈ c.log, r.roundBond ≠ some r.membershipBond
  /-- r33-1: a round bond is not ANY accepted challenge bond of the case. -/
  notAccepted : ∀ r ∈ c.log, ∀ h, r.roundBond = some h → ∀ p ∈ c.accepted, p.2 ≠ h
  /-- INV-ESC-9: a round bond is consumed at most once. -/
  consumedOnce :
    ∀ r₁ ∈ c.log, ∀ r₂ ∈ c.log, ∀ h, r₁.roundBond = some h → r₂.roundBond = some h → r₁ = r₂
  /-- R42: under `requireRoundBond` every rung carries a fresh witness. -/
  strictWitness : strict = true → ∀ r ∈ c.log, r.roundBond.isSome
  /-- r38-1: one bond witness, one challenger index. -/
  oneHashOneIdx : ∀ i₁ i₂ h, (i₁, h) ∈ c.accepted → (i₂, h) ∈ c.accepted → i₁ = i₂
  /-- The converse: one challenger, one accepted bond. -/
  oneIdxOneHash : ∀ i h₁ h₂, (i, h₁) ∈ c.accepted → (i, h₂) ∈ c.accepted → h₁ = h₂
  /-- The `MAX_LADDER_ROUNDS` ladder bound on the log itself. -/
  lengthBound : c.log.length ≤ MAX_ROUNDS

/-! ## 4. The step relation (transcribed from the reducers) -/

/-- The two ledger-writing transitions of the confirmation machine. Every guard
    is a conjunct of `WellFormed` at the moment it is written — which is why
    the invariant is inductive. -/
inductive Step (strict : Bool) : Case → Case → Prop where
  /-- `onAcceptChallenge` (`confirmationMachineHandlers.ts`): a bond witness buys
      exactly one challenger's standing, and challenges precede the ladder
      (phase `challenge_window`, hence `log = []`). -/
  | accept {c : Case} {idx : Idx} {h : Hash}
      (freshIdx : ∀ p ∈ c.accepted, p.1 ≠ idx)
      (freshHash : ∀ p ∈ c.accepted, p.2 ≠ h)
      (preLadder : c.log = []) :
      Step strict c ⟨(idx, h) :: c.accepted, c.log⟩
  /-- `onEscalate` (`confirmationMachineHandlers.ts`): open exactly the next
      rung, under a witness bound to the state (membership + fresh round bond). -/
  | escalate {c : Case} {r : Rung}
      (nextRound : r.round = c.log.length + 2)
      (membership : (r.challengerIdx, r.membershipBond) ∈ c.accepted)
      (distinct : ∀ h, r.roundBond = some h → h ≠ r.membershipBond)
      (fresh : ∀ h, r.roundBond = some h → ∀ p ∈ c.accepted, p.2 ≠ h)
      (unconsumed : ∀ h, r.roundBond = some h → ∀ r' ∈ c.log, r'.roundBond ≠ some h)
      (strictGuard : strict = true → r.roundBond.isSome)
      (cap : c.log.length < MAX_ROUNDS) :
      Step strict c ⟨c.accepted, c.log ++ [r]⟩

/-! ## 5. Reachability -/

inductive Star {α : Type} (r : α → α → Prop) : α → α → Prop where
  | refl (a) : Star r a a
  | tail {a b c} : Star r a b → r b c → Star r a c

/-- `Reachable strict c`: some finite history of the two transitions leads to `c`. -/
def Reachable (strict : Bool) (c : Case) : Prop := Star (Step strict) init c

/-! ## 6. Preservation: the barriers never refuse a machine-produced state -/

theorem WellFormed.init (strict : Bool) : WellFormed strict init := by
  refine ⟨trivial, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro r hr
    exact absurd hr (List.not_mem_nil r)
  · intro r hr
    exact absurd hr (List.not_mem_nil r)
  · intro r hr
    exact absurd hr (List.not_mem_nil r)
  · intro r₁ hr₁
    exact absurd hr₁ (List.not_mem_nil r₁)
  · intro _ r hr
    exact absurd hr (List.not_mem_nil r)
  · intro i₁ i₂ h h₁
    exact absurd h₁ (List.not_mem_nil (i₁, h))
  · intro i h₁ h₂ h
    exact absurd h (List.not_mem_nil (i, h₁))
  · show (0 : Nat) ≤ MAX_ROUNDS
    simp [MAX_ROUNDS]

/-- `accept` (`onAcceptChallenge`): the fresh-index / fresh-hash guards give both
    uniqueness fields. The log conjuncts are vacuous because challenges precede
    the ladder (`preLadder`). -/
theorem WellFormed.accept {strict : Bool} {c : Case} {idx : Idx} {h : Hash}
    (hw : WellFormed strict c) (freshIdx : ∀ p ∈ c.accepted, p.1 ≠ idx)
    (freshHash : ∀ p ∈ c.accepted, p.2 ≠ h) (preLadder : c.log = []) :
    WellFormed strict ⟨(idx, h) :: c.accepted, c.log⟩ := by
  obtain ⟨rounds, bound, distinct, notAccepted, consumedOnce, strictWitness,
    oneHashOneIdx, oneIdxOneHash, lengthBound⟩ := hw
  rw [preLadder] at rounds lengthBound ⊢
  refine ⟨rounds, ?_, ?_, ?_, ?_, ?_, ?_, ?_, lengthBound⟩
  · intro r hr
    exact absurd hr (List.not_mem_nil r)
  · intro r hr
    exact absurd hr (List.not_mem_nil r)
  · intro r hr
    exact absurd hr (List.not_mem_nil r)
  · intro r₁ hr₁
    exact absurd hr₁ (List.not_mem_nil r₁)
  · intro _ r hr
    exact absurd hr (List.not_mem_nil r)
  · intro i₁ i₂ f h₁ h₂
    rcases List.mem_cons.mp h₁ with h₁' | h₁'
    · rcases List.mem_cons.mp h₂ with h₂' | h₂'
      · rw [Prod.mk.injEq] at h₁' h₂'
        rw [h₁'.1, h₂'.1]
      · rw [Prod.mk.injEq] at h₁'
        exact absurd h₁'.2 (freshHash (i₂, f) h₂')
    · rcases List.mem_cons.mp h₂ with h₂' | h₂'
      · rw [Prod.mk.injEq] at h₂'
        exact absurd h₂'.2 (freshHash (i₁, f) h₁')
      · exact oneHashOneIdx i₁ i₂ f h₁' h₂'
  · intro i f₁ f₂ h₁ h₂
    rcases List.mem_cons.mp h₁ with h₁' | h₁'
    · rcases List.mem_cons.mp h₂ with h₂' | h₂'
      · rw [Prod.mk.injEq] at h₁' h₂'
        rw [h₁'.2, h₂'.2]
      · rw [Prod.mk.injEq] at h₁'
        exact absurd h₁'.1 (freshIdx (i, f₂) h₂')
    · rcases List.mem_cons.mp h₂ with h₂' | h₂'
      · rw [Prod.mk.injEq] at h₂'
        exact absurd h₂'.1 (freshIdx (i, f₁) h₁')
      · exact oneIdxOneHash i f₁ f₂ h₁' h₂'

/-- `escalate` (`onEscalate`): every conjunct the append could break is a guard,
    so the invariant survives. This is the entry matrix of r40-1/r40-2 in the
    direction that matters for a legal history. -/
theorem WellFormed.escalate {strict : Bool} {c : Case} {r : Rung}
    (hw : WellFormed strict c) (nextRound : r.round = c.log.length + 2)
    (membership : (r.challengerIdx, r.membershipBond) ∈ c.accepted)
    (distinct : ∀ h, r.roundBond = some h → h ≠ r.membershipBond)
    (fresh : ∀ h, r.roundBond = some h → ∀ p ∈ c.accepted, p.2 ≠ h)
    (unconsumed : ∀ h, r.roundBond = some h → ∀ r' ∈ c.log, r'.roundBond ≠ some h)
    (strictGuard : strict = true → r.roundBond.isSome)
    (cap : c.log.length < MAX_ROUNDS) :
    WellFormed strict ⟨c.accepted, c.log ++ [r]⟩ := by
  obtain ⟨rounds, bound, distinctOld, notAccepted, consumedOnce, strictWitness,
    oneHashOneIdx, oneIdxOneHash, lengthBound⟩ := hw
  have hmem : ∀ x ∈ c.log ++ [r], x ∈ c.log ∨ x = r := by
    intro x hx
    rcases List.mem_append.mp hx with h | h
    · exact Or.inl h
    · exact Or.inr (by simpa using h)
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, oneHashOneIdx, oneIdxOneHash, ?_⟩
  · have hb : r.round = 2 + (c.log.map Rung.round).length := by
      rw [List.length_map]
      omega
    have h := RoundsFrom.append_next (a := 2) rounds r.round hb
    simpa [List.map_append] using h
  · intro x hx
    rcases hmem x hx with h | rfl
    · exact bound x h
    · exact membership
  · intro x hx
    rcases hmem x hx with h | hxr
    · exact distinctOld x h
    · subst hxr
      intro hc
      exact distinct x.membershipBond hc rfl
  · intro x hx h hh p hp
    rcases hmem x hx with h' | rfl
    · exact notAccepted x h' h hh p hp
    · exact fresh h hh p hp
  · intro r₁ h₁ r₂ h₂ h hh₁ hh₂
    rcases hmem r₁ h₁ with h' | rfl
    · rcases hmem r₂ h₂ with h'' | rfl
      · exact consumedOnce r₁ h' r₂ h'' h hh₁ hh₂
      · exact absurd hh₁ (unconsumed h hh₂ r₁ h')
    · rcases hmem r₂ h₂ with h'' | rfl
      · exact absurd hh₂ (unconsumed h hh₁ r₂ h'')
      · rfl
  · intro hs x hx
    rcases hmem x hx with h | rfl
    · exact strictWitness hs x h
    · exact strictGuard hs
  · simp only [List.length_append, List.length_singleton]
    omega

/-- One machine step preserves the invariant bundle. -/
theorem Step.preserves {strict : Bool} {c c' : Case} (hs : Step strict c c')
    (hw : WellFormed strict c) : WellFormed strict c' := by
  cases hs with
  | accept freshIdx freshHash preLadder =>
    exact WellFormed.accept hw freshIdx freshHash preLadder
  | escalate nextRound membership distinct fresh unconsumed strictGuard cap =>
    exact WellFormed.escalate hw nextRound membership distinct fresh unconsumed strictGuard cap

/-- **Every reachable state is well formed.** Hence the barriers
    (`assertValidEscalationLog` at `escalate` / `open_ladder_round` /
    `finalize`, `assertValidConfirmationLedger` at `accept_challenge`) can never
    refuse a state the machine itself produced: the entry matrix bites only on a
    restored or tampered snapshot. -/
theorem reachable_wellFormed {strict : Bool} {c : Case} (h : Reachable strict c) :
    WellFormed strict c := by
  induction h with
  | refl => exact WellFormed.init strict
  | tail _ hstep ih => exact Step.preserves hstep ih

/-! ## 7. The theorems the review rounds asked for -/

/-- **r38-1, one hash one index.** In any reachable case, a bond witness is
    bound to at most ONE challenger index: `bondProofHash ↦ idx` is a partial
    function. A juror that posted nothing cannot name a bonded juror's hash as
    its own, which is what made the borrowed-standing escalation possible. -/
theorem one_hash_one_index {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ i₁ i₂ f, (i₁, f) ∈ c.accepted → (i₂, f) ∈ c.accepted → i₁ = i₂ :=
  (reachable_wellFormed h).oneHashOneIdx

/-- The converse: a challenger has at most one accepted bond, so the accepted
    ledger is a bijection between the indices that challenged and the bond
    witnesses they posted. -/
theorem one_index_one_hash {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ i f₁ f₂, (i, f₁) ∈ c.accepted → (i, f₂) ∈ c.accepted → f₁ = f₂ :=
  (reachable_wellFormed h).oneIdxOneHash

/-- **INV-ESC-9, one payment one rung.** A per-round bond witness appears in at
    most one escalation record: no two rungs are paid for with the same bond. -/
theorem round_bond_consumed_once {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ r₁ ∈ c.log, ∀ r₂ ∈ c.log, ∀ f,
      r₁.roundBond = some f → r₂.roundBond = some f → r₁ = r₂ :=
  (reachable_wellFormed h).consumedOnce

/-- A per-round bond is never the record's own membership bond (relabelling the
    one payment is not a payment). -/
theorem round_bond_not_membership {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ r ∈ c.log, r.roundBond ≠ some r.membershipBond :=
  (reachable_wellFormed h).distinct

/-- **r33-1**: a per-round bond is never ANY juror's accepted challenge bond,
    so one juror's standing cannot be spent as another's payment. -/
theorem round_bond_not_accepted {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ r ∈ c.log, ∀ f, r.roundBond = some f → ∀ p ∈ c.accepted, p.2 ≠ f :=
  (reachable_wellFormed h).notAccepted

/-- Under `requireRoundBond` (the R42 default) every rung carries a fresh
    per-round witness — the r30-1 free option is closed. -/
theorem strict_case_has_round_bond {c : Case} (h : Reachable true c) :
    ∀ r ∈ c.log, r.roundBond.isSome :=
  (reachable_wellFormed h).strictWitness rfl

/-- **The consumption corollary: a consumed hash is never re-used in a later
    round.** If the record for round `R` paid with `f`, no record for a round
    `> R` pays with `f` — the property a host relies on when it prices each
    rung, and the property a dropped log entry would silently restore. -/
theorem consumed_not_reused {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ r ∈ c.log, ∀ f, r.roundBond = some f →
      ∀ r' ∈ c.log, r.round < r'.round → r'.roundBond ≠ some f := by
  intro r hr f hf r' hr' hlt hcontra
  have hsame : r' = r := (round_bond_consumed_once h r hr r' hr' f hf hcontra).symm
  rw [hsame] at hlt
  exact Nat.lt_irrefl _ hlt

/-- **INV-ESC-8, consecutive rounds.** The escalation log's rounds are
    `2, 3, …, |log|+1` — `round === offset + 2`, the consecutive `2..k` test. -/
theorem rounds_consecutive {strict : Bool} {c : Case} (h : Reachable strict c) :
    RoundsFrom 2 (c.log.map Rung.round) :=
  (reachable_wellFormed h).rounds

/-- The rounds the case has OPENED are `1, 2, …, |log|+1`: round 1 is the
    challenge's own ladder round, round `k+1` is opened by the `k`-th
    escalation. So the sequence starts at 1 and has no gaps. -/
theorem opened_rounds_from_one {strict : Bool} {c : Case} (h : Reachable strict c) :
    RoundsFrom 1 (1 :: c.log.map Rung.round) := by
  have hr := rounds_consecutive h
  exact ⟨rfl, hr⟩

/-- **Strictly increasing, from 1.** The `i`-th opened ladder round is `1 + i`,
    hence the opened-round sequence is strictly increasing — a witness minted
    for one round can never be replayed at another (`roundIndex` must open
    exactly `ladderRound + 1`). -/
theorem openedRounds_strict_mono {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ i (hi : i < (1 :: c.log.map Rung.round).length),
      (1 :: c.log.map Rung.round)[i] = 1 + i :=
  RoundsFrom.get (opened_rounds_from_one h)

/-- The log's own rounds are strictly increasing from 2 (no repeated or
    out-of-order rung). -/
theorem rounds_strict_mono {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ i (hi : i < (c.log.map Rung.round).length), (c.log.map Rung.round)[i] = 2 + i :=
  RoundsFrom.get (rounds_consecutive h)

/-- The log never exceeds the `MAX_LADDER_ROUNDS` (5) ladder bound. -/
theorem log_length_bounded {strict : Bool} {c : Case} (h : Reachable strict c) :
    c.log.length ≤ MAX_ROUNDS :=
  (reachable_wellFormed h).lengthBound

/-- The escalation witness OPENS exactly the next round: after a reachable
    history, the record for round `R` occupies log position `R - 2`, i.e. the
    n-th escalation opens round `n+1`. This is the "the round-bound witness
    opens only `ladderRound + 1`" claim in ledger form. -/
theorem escalation_opens_next_round {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ (i : Nat) (hi : i < c.log.length), (c.log[i]'hi).round = i + 2 := by
  intro i hi
  have hi' : i < (c.log.map Rung.round).length := by
    rwa [List.length_map]
  have hget := rounds_strict_mono h i hi'
  have hmap : (c.log.map Rung.round)[i]'hi' = (c.log[i]'hi).round :=
    List.getElem_map (f := Rung.round) (l := c.log) (n := i)
  rw [hmap] at hget
  omega

end Escalation
end BAOCourt
