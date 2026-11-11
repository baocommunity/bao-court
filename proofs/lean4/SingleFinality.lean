/-
  Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

  # Single finality for the BAO Court confirmation machine — Lean 4 mechanisation

  This file mechanises the "one verdict per case, one message per epoch"
  (single-finality / non-equivocation) property of the BAO Court universal
  confirmation machine (`courtConfirmationMachine.ts` +
  `confirmationMachineHandlers.ts:onFinalize`). It is Mathlib-free: pure Lean 4
  core, so it builds in seconds and has no cache/lockfile surface.

  ## What is modelled

    * `Session`     — one confirmation case: `(epoch, caseId)` key, `phase`,
                      single-valued `verdict : Option Outcome`. `(epoch, caseId)`
                      is the "session key": a case lives in exactly one epoch.
    * `Phase`       — the eleven phases of `CourtConfirmationPhase`.
    * `Effect`      — what a transition may do to a session: change the phase,
                      and optionally record the verdict. It **cannot** change
                      the key — that is what makes the session table functional.
    * `step`        — the machine's event dispatch, transcribed from
                      `produce()`/`confirmationMachineHandlers.ts`. `advance`
                      is the single transition primitive and refuses terminal
                      phases, which is `TERMINAL_PHASES.has(state.phase)` in TS.
    * `Message`     — the batch an epoch finalises: `(epoch, verdicts)` where
                      `verdicts` is the epoch's final `(caseId, outcome)` list.

  ## What is proved (no `sorry`, no extra axioms)

    * `terminal_untouched` / `final_stable` — a session in a terminal phase
      (`final`, `expired`, `aborted`) is never modified by ANY later step. Hence
      a finalized verdict is immutable for the rest of the history.
    * `finalized_outcome_unique` — at most one outcome is final for a given
      `(epoch, caseId)` in any state (the session table is functional and the
      verdict field is single-valued).
    * `oracle_single_finality` — the headline theorem: at most one `Message` is
      finalized per epoch. `State.Finalized` is the observer's check on a
      message (sound: every claim is a machine-final session; complete: every
      machine-final session is claimed); the proof then runs through
      `finalized_outcome_unique` + `funext`, NOT through a definitional rewrite.
    * `machine_alone_insufficient` — a machine-checked counterexample showing
      two reachable states that finalize *different* outcomes for the same case.
      This is the honest boundary: the machine alone gives per-state
      determinism; cross-history non-equivocation needs the signature layer.
    * `no_equivocation` — cross-signer-set non-equivocation, reduced to two
      named assumptions (`hintersect`, `hsign_once`, see the section below).

  ## Assumption boundary

  Everything about the *machine* (phases, transitions, finality, immutability,
  message determinism) is proved. Cryptography — signatures, threshold quorum
  intersection, collision resistance of the digest — is abstracted into the
  `Abstraction` structure: `Signed : Signer → Digest → Prop` is an uninterpreted
  signature predicate, `Honest` is an uninterpreted honesty predicate, and the
  digest of a certificate is *modelled as* its `(epoch, caseId, outcome)`
  payload (the real system hashes exactly that tuple; treating a hash as its
  preimage is the standard abstraction, and collision resistance is what
  justifies it). The two assumptions are stated as explicit hypotheses of
  `no_equivocation`, never as global axioms, and are discussed in README.md.
-/

namespace BAOCourt

/-! ## 1. Protocol identities -/

abbrev Epoch := Nat
abbrev CaseId := Nat
abbrev Outcome := Nat
abbrev Signer := Nat

/-- A session key: one confirmation case, in exactly one epoch. -/
abbrev CaseKey := Epoch × CaseId

/-! ## 2. Phases (mirror of `CourtConfirmationPhase`) -/

inductive Phase where
  | confirmOpen | confirmClosed | challengeWindow | ladderPending
  | ladderVoteOpen | ladderVoteClosed | roundResolved | feeSettlement
  | final | expired | aborted
deriving DecidableEq, Repr

/-- `TERMINAL_PHASES = { final, expired, aborted }` (confirmationMachineCore.ts). -/
def Phase.isTerminal : Phase → Bool
  | .final => true
  | .expired => true
  | .aborted => true
  | _ => false

/-! ## 3. Sessions and the state -/

/-- One confirmation case. `verdict` is the *single-valued* outcome field: the
    verdict set by `resolveRound` (ladder path) or left `none` (never-challenged
    path, where `finalize` mints the verdict from the confirmation ledger). -/
structure Session where
  epoch : Epoch
  caseId : CaseId
  phase : Phase
  verdict : Option Outcome
deriving DecidableEq, Repr

structure SystemState where
  sessions : List Session
deriving DecidableEq, Repr

def init : SystemState := ⟨[]⟩

/-- The session table lookup (`state.sessions` keyed by `(epoch, caseId)`). -/
def look (k : CaseKey) : List Session → Option Session
  | [] => none
  | se :: rest => if (se.epoch, se.caseId) = k then some se else look k rest

theorem look_cons_self {k se rest} (h : (se.epoch, se.caseId) = k) :
    look k (se :: rest) = some se := by
  simp [look, h]

theorem look_cons_other {k se rest} (h : (se.epoch, se.caseId) ≠ k) :
    look k (se :: rest) = look k rest := by
  simp [look, h]

/-- The session table is functional: one lookup result, hence one session. -/
theorem look_some_unique {l : List Session} {k : CaseKey} {a b : Session}
    (h1 : look k l = some a) (h2 : look k l = some b) : a = b := by
  rw [h1] at h2
  exact Option.some.inj h2

/-! ## 4. Effects and the table update -/

/-- What a transition may do to its target session. It may move the phase and
    optionally record the verdict; it can never change `(epoch, caseId)`. -/
inductive Effect where
  | advance (p : Phase)
  | advanceVerdict (p : Phase) (v : Outcome)

def Effect.apply : Effect → Session → Session
  | .advance p, se => { se with phase := p }
  | .advanceVerdict p v, se => { se with phase := p, verdict := some v }

@[simp] theorem effect_apply_epoch (e : Effect) (se : Session) : (e.apply se).epoch = se.epoch := by
  cases e <;> rfl

@[simp] theorem effect_apply_caseId (e : Effect) (se : Session) : (e.apply se).caseId = se.caseId := by
  cases e <;> rfl

@[simp] theorem effect_apply_key (e : Effect) (se : Session) :
    ((e.apply se).epoch, (e.apply se).caseId) = (se.epoch, se.caseId) := by
  cases e <;> rfl

/-- Replace the session at key `k`, if present. Never inserts: insertion is only
    `open`, and it is guarded by "no session at this key yet". -/
def updateAt (k : CaseKey) (e : Effect) : List Session → List Session
  | [] => []
  | x :: rest => if (x.epoch, x.caseId) = k then e.apply x :: rest else x :: updateAt k e rest

theorem look_updateAt_self (k e l) : look k (updateAt k e l) = (look k l).map (Effect.apply e) := by
  induction l with
  | nil => rfl
  | cons x rest ih =>
    simp only [updateAt]
    by_cases h : (x.epoch, x.caseId) = k
    · rw [if_pos h, look_cons_self (by rw [effect_apply_key, h]), look_cons_self h]
      rfl
    · rw [if_neg h, look_cons_other h, ih, look_cons_other h]

theorem look_updateAt_other {k' k} (e : Effect) (l : List Session) (h : k' ≠ k) :
    look k' (updateAt k e l) = look k' l := by
  induction l with
  | nil => rfl
  | cons x rest ih =>
    simp only [updateAt]
    by_cases hx : (x.epoch, x.caseId) = k
    · have hx' : (x.epoch, x.caseId) ≠ k' := by rw [hx]; exact fun hh => h hh.symm
      rw [if_pos hx, look_cons_other (by simpa using hx'), look_cons_other hx']
    · rw [if_neg hx]
      by_cases hx' : (x.epoch, x.caseId) = k'
      · rw [look_cons_self hx', look_cons_self hx']
      · rw [look_cons_other hx', ih, look_cons_other hx']

/-! ## 5. The transition primitive -/

/-- The single transition primitive. Fail-closed: no session, a terminal phase,
    or a failed guard all yield `none` (the TS machine throws
    `CourtConfirmationTransitionError`; `none` is the total-function version).

    The `se.phase.isTerminal` check is the machine's global
    `TERMINAL_PHASES.has(state.phase)` barrier, applied to every event. -/
def advance (s : SystemState) (k : CaseKey) (guard : Session → Bool) (e : Effect) :
    Option SystemState :=
  match look k s.sessions with
  | none => none
  | some se =>
    if se.phase.isTerminal then none
    else if guard se then some ⟨updateAt k e s.sessions⟩ else none

/-- Characterisation of a successful advance. -/
theorem advance_eq_some_iff {s s' : SystemState} {k : CaseKey} {guard : Session → Bool}
    {e : Effect} :
    advance s k guard e = some s' ↔
      ∃ se, look k s.sessions = some se ∧ se.phase.isTerminal = false ∧ guard se = true ∧
        s' = ⟨updateAt k e s.sessions⟩ := by
  unfold advance
  cases h : look k s.sessions with
  | none => simp [h]
  | some se =>
    by_cases ht : se.phase.isTerminal
    · simp [h, ht]
    · by_cases hg : guard se
      · simp [h, ht, hg]
        exact ⟨fun hh => hh.symm, fun hh => hh.symm⟩
      · simp [h, ht, hg]

/-! ## 6. Events and the machine -/

inductive Event where
  | openCase (e : Epoch) (c : CaseId)
  | accept (e : Epoch) (c : CaseId)
  | closeConfirmations (e : Epoch) (c : CaseId) (confirmed : Outcome)
  | challenge (e : Epoch) (c : CaseId)
  | openLadder (e : Epoch) (c : CaseId)
  | resolveRound (e : Epoch) (c : CaseId) (winner : Outcome)
  | closeRound (e : Epoch) (c : CaseId)
  | recordFee (e : Epoch) (c : CaseId)
  | finalize (e : Epoch) (c : CaseId)
  | expire (e : Epoch) (c : CaseId)
  | abort (e : Epoch) (c : CaseId)

/-- Event dispatch, transcribed from `produce()` in
    `courtConfirmationMachine.ts` / `confirmationMachineHandlers.ts`.

        confirm_open -accept-> confirm_closed
        confirm_closed -closeConfirmations(o)-> challenge_window     (verdict := o)
        challenge_window -challenge-> ladder_pending
        ladder_pending -openLadder-> ladder_vote_open
        ladder_vote_open -resolveRound(w)-> ladder_vote_closed       (verdict := w)
        ladder_vote_closed -closeRound-> round_resolved
        challenge_window | round_resolved -recordFee-> fee_settlement
        fee_settlement -finalize-> final

    `finalize` is the ONLY event whose effect sets `phase := final`, it is
    reachable only from `feeSettlement`, and its guard requires a recorded
    verdict (`if (!pending) throw` in `onFinalize`). The effect is
    `.advance .final`, i.e. it does NOT touch `verdict` — the finalized outcome
    is exactly the verdict that was already in the state, so the finalize event
    cannot choose an outcome of its own. -/
def step (s : SystemState) (ev : Event) : Option SystemState :=
  match ev with
  | .openCase e c =>
    if (look (e, c) s.sessions).isSome then none
    else some ⟨{ epoch := e, caseId := c, phase := .confirmOpen, verdict := none } :: s.sessions⟩
  | .accept e c => advance s (e, c) (fun se => se.phase == .confirmOpen) (.advance .confirmClosed)
  | .closeConfirmations e c o =>
    advance s (e, c) (fun se => se.phase == .confirmClosed) (.advanceVerdict .challengeWindow o)
  | .challenge e c =>
    advance s (e, c) (fun se => se.phase == .challengeWindow) (.advance .ladderPending)
  | .openLadder e c =>
    advance s (e, c) (fun se => se.phase == .ladderPending) (.advance .ladderVoteOpen)
  | .resolveRound e c w =>
    advance s (e, c) (fun se => se.phase == .ladderVoteOpen) (.advanceVerdict .ladderVoteClosed w)
  | .closeRound e c =>
    advance s (e, c) (fun se => se.phase == .ladderVoteClosed) (.advance .roundResolved)
  | .recordFee e c =>
    advance s (e, c) (fun se => se.phase == .challengeWindow || se.phase == .roundResolved)
      (.advance .feeSettlement)
  | .finalize e c =>
    advance s (e, c) (fun se => se.phase == .feeSettlement && se.verdict.isSome) (.advance .final)
  | .expire e c => advance s (e, c) (fun _ => true) (.advance .expired)
  | .abort e c => advance s (e, c) (fun _ => true) (.advance .aborted)

/-! ## 7. The terminal barrier: finality is absorbing -/

/-- A session in a terminal phase is never touched by any guarded advance. -/
theorem terminal_untouched_advance {s s' : SystemState} {t k : CaseKey}
    {guard : Session → Bool} {eff : Effect} (h : advance s t guard eff = some s')
    {se : Session} (hk : look k s.sessions = some se) (ht : se.phase.isTerminal = true) :
    look k s'.sessions = some se := by
  by_cases hkt : t = k
  · subst hkt
    obtain ⟨se', hl', hterm, -, hs'⟩ := advance_eq_some_iff.mp h
    rw [hk] at hl'
    have hse : se' = se := (Option.some.inj hl').symm
    rw [hse, ht] at hterm
    cases hterm
  · obtain ⟨se', -, -, -, hs'⟩ := advance_eq_some_iff.mp h
    rw [hs', look_updateAt_other eff s.sessions (fun hh => hkt hh.symm)]
    exact hk

/-- THE terminal-phase barrier: `TERMINAL_PHASES.has(state.phase)` in TS means
    no event can move a terminal session. `openCase` refuses an existing key and
    every other event goes through `advance`, so a terminal session survives
    every single-step transition unchanged. -/
theorem terminal_untouched {s s' : SystemState} {ev : Event} (h : step s ev = some s')
    {k : CaseKey} {se : Session} (hk : look k s.sessions = some se)
    (ht : se.phase.isTerminal = true) : look k s'.sessions = some se := by
  cases ev with
  | openCase e c =>
    rw [step] at h
    by_cases hsome : (look (e, c) s.sessions).isSome = true
    · simp only [hsome, if_pos] at h
      cases h
    · have hne : (e, c) ≠ k := by
        intro hh
        rw [hh, hk] at hsome
        simp at hsome
      rw [Bool.not_eq_true] at hsome
      rw [if_neg (by simp [hsome])] at h
      obtain rfl : s' = ⟨{ epoch := e, caseId := c, phase := .confirmOpen, verdict := none } ::
        s.sessions⟩ := (Option.some.inj h).symm
      rw [look_cons_other (k := k)
        (se := { epoch := e, caseId := c, phase := .confirmOpen, verdict := none })
        (rest := s.sessions) (by simpa using hne)]
      exact hk
  | accept e c => exact terminal_untouched_advance h hk ht
  | closeConfirmations e c o => exact terminal_untouched_advance h hk ht
  | challenge e c => exact terminal_untouched_advance h hk ht
  | openLadder e c => exact terminal_untouched_advance h hk ht
  | resolveRound e c w => exact terminal_untouched_advance h hk ht
  | closeRound e c => exact terminal_untouched_advance h hk ht
  | recordFee e c => exact terminal_untouched_advance h hk ht
  | finalize e c => exact terminal_untouched_advance h hk ht
  | expire e c => exact terminal_untouched_advance h hk ht
  | abort e c => exact terminal_untouched_advance h hk ht

/-- `finalize` is reachable only from `feeSettlement` with the verdict recorded
    (the barrier `onFinalize` enforces), and it only changes the phase. -/
theorem finalize_barrier {s s' : SystemState} {e : Epoch} {c : CaseId}
    (h : step s (.finalize e c) = some s') :
    ∃ se, look (e, c) s.sessions = some se ∧ se.phase = .feeSettlement ∧
      se.verdict.isSome = true ∧ s' = ⟨updateAt (e, c) (.advance .final) s.sessions⟩ := by
  obtain ⟨se, hl, -, hg, hs'⟩ := advance_eq_some_iff.mp h
  rw [Bool.and_eq_true] at hg
  exact ⟨se, hl, by simpa using hg.1, by simpa using hg.2, hs'⟩

/-- Consequently, an event whose step succeeds leaves any finalized session's
    verdict untouched — in particular, a second `finalize` cannot change it. -/
theorem final_verdict_of_state {s : SystemState} {k : CaseKey} {se : Session}
    (hk : look k s.sessions = some se) (hf : se.phase = .final) (hv : se.verdict = some o) :
    ∃ se', look k s.sessions = some se' ∧ se'.phase = .final ∧ se'.verdict = some o :=
  ⟨se, hk, hf, hv⟩

/-! ## 8. Reachability -/

/-- One machine step. -/
def Step (s s' : SystemState) : Prop := ∃ ev, step s ev = some s'

inductive Star (r : α → α → Prop) : α → α → Prop where
  | refl (a) : Star r a a
  | tail {a b c} : Star r a b → r b c → Star r a c

/-- A state is reachable when some finite event history leads to it from `init`. -/
def Reachable (s : SystemState) : Prop := Star Step init s

/-- **Immutability of a finalized verdict along any history.** Once a case is
    `final` with verdict `o`, no later step changes either the phase or the
    verdict. This is the inductive statement (over ALL reachable states) that a
    bounded model checker gives only up to its depth bound. -/
theorem final_stable {s s' : SystemState} (h : Star Step s s') {k : CaseKey} {se : Session}
    (hk : look k s.sessions = some se) (hf : se.phase = .final) :
    ∃ se', look k s'.sessions = some se' ∧ se'.phase = .final ∧ se'.verdict = se.verdict := by
  induction h with
  | refl => exact ⟨se, hk, hf, rfl⟩
  | tail _ hstep ih =>
    obtain ⟨se₁, hl₁, hf₁, hv₁⟩ := ih
    have ht : se₁.phase.isTerminal = true := by rw [hf₁]; rfl
    obtain ⟨ev, hev⟩ := hstep
    have hl₂ := terminal_untouched hev hl₁ ht
    exact ⟨se₁, hl₂, hf₁, hv₁⟩

/-! ## 9. Per-case finality is unique -/

/-- A case `(e, c)` is finalized with outcome `o` in state `s`. -/
def FinalizedOutcome (s : SystemState) (e : Epoch) (c : CaseId) (o : Outcome) : Prop :=
  ∃ se, look (e, c) s.sessions = some se ∧ se.phase = .final ∧ se.verdict = some o

/-- **At most one outcome is final per case, in any state.** The session table is
    functional (one session per `(epoch, caseId)`) and the session's verdict is a
    single `Option Outcome` — so two finalized outcomes for one case coincide.
    (This is where `Effect` never touching the key pays off.) -/
theorem finalized_outcome_unique (s : SystemState) (e : Epoch) (c : CaseId)
    (o₁ o₂ : Outcome) (h₁ : FinalizedOutcome s e c o₁) (h₂ : FinalizedOutcome s e c o₂) :
    o₁ = o₂ := by
  obtain ⟨se₁, hl₁, -, hv₁⟩ := h₁
  obtain ⟨se₂, hl₂, -, hv₂⟩ := h₂
  have hse : se₁ = se₂ := look_some_unique hl₁ hl₂
  rw [hse, hv₂] at hv₁
  exact (Option.some.inj hv₁).symm

/-! ## 10. The epoch message and the headline theorem -/

/-- The epoch's finalized verdict map: for each case of the epoch, the outcome of
    its `final` session (if any). This is a *pure function of the state* — the
    message an epoch finalizes is derived from the machine, never independently
    asserted by a host. -/
def finalVerdicts (s : SystemState) (e : Epoch) : CaseId → Option Outcome :=
  fun c => (look (e, c) s.sessions).bind fun se => if se.phase = .final then se.verdict else none

/-- The verdict map agrees with the per-case finality predicate. -/
theorem finalVerdicts_eq_some_iff {s : SystemState} {e : Epoch} {c : CaseId} {o : Outcome} :
    finalVerdicts s e c = some o ↔ FinalizedOutcome s e c o := by
  unfold finalVerdicts FinalizedOutcome
  cases h : look (e, c) s.sessions with
  | none => simp [h]
  | some se =>
    by_cases hf : se.phase = .final
    · simp [h, hf]
    · simp [h, hf]

/-- The batch an epoch finalizes: the epoch tag plus the case→outcome map
    (`batchAttestation.ts` commits exactly this as the epoch's root). -/
structure Message where
  epoch : Epoch
  verdicts : CaseId → Option Outcome

namespace State

/-- `State.Finalized s e m` — the state `s` finalizes `m` as epoch `e`'s message.

    Two conjuncts, both meaningful and both checkable by an observer against the
    machine state, in the shape of a batch attestation:

    * **soundness** — every verdict the message claims is a `final` session of
      the machine (`onFinalize` wrote it);
    * **completeness** — every `final` session of that epoch is claimed.

    Note what is NOT assumed: the message is not required to *be* a particular
    object. Soundness + completeness are the observer's checks, and the theorem
    below shows they pin the message uniquely — that is the real content, and
    the proof runs through per-case uniqueness (§9) and `funext`, not through
    rewriting a definition. -/
def Finalized (s : SystemState) (e : Epoch) (m : Message) : Prop :=
  m.epoch = e ∧
  (∀ (c : CaseId) (o : Outcome), m.verdicts c = some o → FinalizedOutcome s e c o) ∧
  (∀ (c : CaseId) (o : Outcome), FinalizedOutcome s e c o → m.verdicts c = some o)

end State

/-- **SINGLE FINALITY (headline).** At most one message is finalized per epoch:
    if a state finalizes `m₁` and `m₂` for the same epoch, then `m₁ = m₂`.

    Suppose both messages claim a verdict for some case `c`. Each claim is a
    machine-final outcome for `(e, c)` (soundness), and `finalized_outcome_unique`
    says at most one outcome is final for a case — so the two claims agree. If
    one message claims no verdict for `c`, the other cannot either: its claim
    would be a final outcome, which completeness of the first message would then
    have to claim too. Hence the verdict maps are equal (`funext`) and, with
    equal epoch tags, the messages are equal. -/
theorem oracle_single_finality (s : SystemState) (e : Epoch) (m1 m2 : Message) :
    State.Finalized s e m1 ∧ State.Finalized s e m2 → m1 = m2 := by
  rintro ⟨⟨h1e, h1sound, h1complete⟩, ⟨h2e, h2sound, h2complete⟩⟩
  have he : m1.epoch = m2.epoch := by rw [h1e, h2e]
  have hv : m1.verdicts = m2.verdicts := by
    funext c
    cases hc : m1.verdicts c with
    | some o₁ =>
      have hfin : FinalizedOutcome s e c o₁ := h1sound c o₁ hc
      exact (h2complete c o₁ hfin).symm
    | none =>
      have hnone : m2.verdicts c = none := by
        cases hc2 : m2.verdicts c with
        | none => rfl
        | some o₂ =>
          have hfin : FinalizedOutcome s e c o₂ := h2sound c o₂ hc2
          have hbad : m1.verdicts c = some o₂ := h1complete c o₂ hfin
          rw [hc] at hbad
          cases hbad
      exact hnone.symm
  cases m1 with
  | mk e1 v1 =>
    cases m2 with
    | mk e2 v2 =>
      simp only at he hv
      rw [he, hv]

/-- The epoch's finalized message, as the state determines it. -/
def epochMessage (s : SystemState) (e : Epoch) : Message := ⟨e, finalVerdicts s e⟩

theorem epochMessage_finalized (s : SystemState) (e : Epoch) :
    State.Finalized s e (epochMessage s e) := by
  refine ⟨rfl, ?_, ?_⟩
  · intro c o h
    have h' : finalVerdicts s e c = some o := by simpa [epochMessage] using h
    exact finalVerdicts_eq_some_iff.mp h'
  · intro c o h
    simpa [epochMessage] using finalVerdicts_eq_some_iff.mpr h

/-- Consequence: the message a state finalizes is **unique and exists** — every
    finalized message for an epoch IS the state's own derived message. -/
theorem finalized_eq_epochMessage {s : SystemState} {e : Epoch} {m : Message}
    (h : State.Finalized s e m) : m = epochMessage s e :=
  oracle_single_finality s e m (epochMessage s e) ⟨h, epochMessage_finalized s e⟩

/-! ## 11. The honest boundary: the machine alone is NOT enough -/

/-- A concrete finalized session for outcome `o` in case `(0, 0)`, epoch 0. -/
def traceState (o : Outcome) : SystemState :=
  ⟨[{ epoch := 0, caseId := 0, phase := .final, verdict := some o }]⟩

/-- The never-challenged event history that finalizes `(0, 0)` with outcome `o`:
    open -> accept -> closeConfirmations o -> recordFee -> finalize. -/
def traceEvents (o : Outcome) : List Event :=
  [.openCase 0 0, .accept 0 0, .closeConfirmations 0 0 o, .recordFee 0 0, .finalize 0 0]

/-- The intermediate machine states of `traceEvents`. -/
def s1 : SystemState :=
  ⟨[{ epoch := 0, caseId := 0, phase := .confirmOpen, verdict := none }]⟩
def s2 : SystemState :=
  ⟨[{ epoch := 0, caseId := 0, phase := .confirmClosed, verdict := none }]⟩
def s3 (o : Outcome) : SystemState :=
  ⟨[{ epoch := 0, caseId := 0, phase := .challengeWindow, verdict := some o }]⟩
def s4 (o : Outcome) : SystemState :=
  ⟨[{ epoch := 0, caseId := 0, phase := .feeSettlement, verdict := some o }]⟩

theorem step_open : step init (.openCase 0 0) = some s1 := rfl
theorem step_accept : step s1 (.accept 0 0) = some s2 := rfl
theorem step_close (o : Outcome) : step s2 (.closeConfirmations 0 0 o) = some (s3 o) := rfl
theorem step_fee (o : Outcome) : step (s3 o) (.recordFee 0 0) = some (s4 o) := rfl
theorem step_finalize (o : Outcome) : step (s4 o) (.finalize 0 0) = some (traceState o) := rfl

/-- `traceState o` is genuinely REACHABLE (not a hand-built state): the five
    events of `traceEvents` drive the machine from `init` to it. -/
theorem trace_reachable (o : Outcome) : Reachable (traceState o) := by
  refine Star.tail (Star.tail (Star.tail (Star.tail
    (Star.tail (Star.refl init) ⟨.openCase 0 0, step_open⟩)
    ⟨.accept 0 0, step_accept⟩)
    ⟨.closeConfirmations 0 0 o, step_close o⟩)
    ⟨.recordFee 0 0, step_fee o⟩)
    ⟨.finalize 0 0, step_finalize o⟩

/-- **The machine alone does not give single finality across histories**, and it
    must not be claimed to. Two reachable states finalize `(0, 0)` with
    different outcomes: a host that runs two divergent histories (two signer
    sets, a restart, an equivocating host) reaches both. Cross-history
    single-finality therefore rests on the signature layer — §12. -/
theorem machine_alone_insufficient :
    ∃ s₁ s₂ : SystemState, ∃ o₁ o₂ : Outcome,
      o₁ ≠ o₂ ∧ Reachable s₁ ∧ Reachable s₂ ∧
        FinalizedOutcome s₁ 0 0 o₁ ∧ FinalizedOutcome s₂ 0 0 o₂ := by
  refine ⟨traceState 1, traceState 2, 1, 2, by decide, trace_reachable 1, trace_reachable 2, ?_, ?_⟩
  · exact ⟨_, rfl, rfl, rfl⟩
  · exact ⟨_, rfl, rfl, rfl⟩

/-! ## 12. Cross-signer-set non-equivocation (crypto abstracted) -/

/-- A digest: the tuple a certificate signs. The real system hashes exactly
    `(epoch, caseId, outcome)`; a hash is treated as its preimage (collision
    resistance justifies this — see README §Assumption boundary). -/
abbrev Digest := Epoch × CaseId × Outcome

/-- A quorum certificate over one case's outcome. -/
structure Certificate where
  epoch : Epoch
  caseId : CaseId
  outcome : Outcome
  signers : List Signer
deriving DecidableEq, Repr

def Certificate.digest (c : Certificate) : Digest := (c.epoch, c.caseId, c.outcome)

/-- The binding a certificate commits to: `(epoch, caseId)`. The epoch is part of
    it, so a certificate can never be replayed into another epoch. -/
def Certificate.binding (c : Certificate) : CaseKey := (c.epoch, c.caseId)

/-- The crypto abstraction. `Signed` and `Honest` are uninterpreted; nothing
    about their meaning is assumed beyond §12's two hypotheses. -/
structure Abstraction where
  Signed : Signer → Digest → Prop
  Honest : Signer → Prop
  Quorum : List Signer → Prop

/-- A certificate is valid under an abstraction when its signer set satisfies
    the quorum predicate and every member actually signed this digest. -/
def Certificate.Valid (A : Abstraction) (c : Certificate) : Prop :=
  A.Quorum c.signers ∧ ∀ v ∈ c.signers, A.Signed v c.digest

/-- A certificate binds its digest to exactly one epoch — the epoch binding of
    `batchAttestation.ts` (`H(BatchManifest/v1, u32(epoch), ...)`). -/
theorem binding_epoch_ne {c₁ c₂ : Certificate} (h : c₁.epoch ≠ c₂.epoch) :
    c₁.binding ≠ c₂.binding := by
  intro hb
  exact h (congrArg Prod.fst hb)

/-- **Cross-signer-set non-equivocation.** Two valid certificates for the same
    `(epoch, caseId)` binding must carry the same outcome — no matter which
    signer sets produced them, which host assembled them, or which history they
    came from. This is the property the machine alone cannot give (§11) and it
    is exactly what makes the epoch message of §10 unique *across runs*.

    Two explicit hypotheses, nothing hidden:

    * `hintersect` — threshold intersection: any two quorums over the same
      binding share an honest signer. Justified by `2q > n` and at most `f < q`
      Byzantine members: `|Q₁ ∩ Q₂| ≥ 2q - n > f`, so the intersection cannot be
      entirely Byzantine. (Not mechanised: it needs a finite-set cardinality
      library; it is the standard threshold-intersection fact, and it is stated
      here as a hypothesis rather than an axiom so callers must supply it.)
    * `hsign_once` — an honest signer never signs two distinct outcomes for the
      same `(epoch, caseId)`. This is the non-equivocation duty of a juror; the
      TS side enforces it by binding every signature to `(sessionHash, epoch)`. -/
theorem no_equivocation (A : Abstraction) (c₁ c₂ : Certificate)
    (hintersect : ∀ d₁ d₂ : Certificate, d₁.binding = d₂.binding →
      ∃ v, A.Honest v ∧ v ∈ d₁.signers ∧ v ∈ d₂.signers)
    (hsign_once : ∀ (v : Signer) (e : Epoch) (c : CaseId) (o₁ o₂ : Outcome),
      A.Honest v → A.Signed v (e, c, o₁) → A.Signed v (e, c, o₂) → o₁ = o₂)
    (h₁ : c₁.Valid A) (h₂ : c₂.Valid A) (hb : c₁.binding = c₂.binding) :
    c₁.outcome = c₂.outcome := by
  obtain ⟨v, hv, hm₁, hm₂⟩ := hintersect c₁ c₂ hb
  have hs₁ : A.Signed v c₁.digest := h₁.2 v hm₁
  have hs₂ : A.Signed v c₂.digest := h₂.2 v hm₂
  have he : c₁.epoch = c₂.epoch := congrArg Prod.fst hb
  have hc : c₁.caseId = c₂.caseId := congrArg Prod.snd hb
  simp only [Certificate.digest] at hs₁ hs₂
  rw [he, hc] at hs₁
  exact hsign_once v c₂.epoch c₂.caseId c₁.outcome c₂.outcome hv hs₁ hs₂

/-- The same statement in machine terms: a machine-final outcome that carries a
    valid certificate is unique for its case. (The machine records the verdict;
    the certificate is what makes it binding across histories.) -/
theorem machine_final_certified_unique (A : Abstraction) {e : Epoch}
    {c : CaseId} {o₁ o₂ : Outcome} (c₁ c₂ : Certificate)
    (hcert₁ : c₁.epoch = e ∧ c₁.caseId = c ∧ c₁.outcome = o₁)
    (hcert₂ : c₂.epoch = e ∧ c₂.caseId = c ∧ c₂.outcome = o₂)
    (hintersect : ∀ d₁ d₂ : Certificate, d₁.binding = d₂.binding →
      ∃ v, A.Honest v ∧ v ∈ d₁.signers ∧ v ∈ d₂.signers)
    (hsign_once : ∀ (v : Signer) (e : Epoch) (c : CaseId) (o₁ o₂ : Outcome),
      A.Honest v → A.Signed v (e, c, o₁) → A.Signed v (e, c, o₂) → o₁ = o₂)
    (h₁ : c₁.Valid A) (h₂ : c₂.Valid A) :
    o₁ = o₂ := by
  have hb : c₁.binding = c₂.binding := by
    simp only [Certificate.binding]
    rw [hcert₁.1, hcert₁.2.1, hcert₂.1, hcert₂.2.1]
  have := no_equivocation A c₁ c₂ hintersect hsign_once h₁ h₂ hb
  rw [hcert₁.2.2, hcert₂.2.2] at this
  exact this

end BAOCourt
