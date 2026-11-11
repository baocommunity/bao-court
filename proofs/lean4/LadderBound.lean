/-
  Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

  # The sign-based ladder bound — Lean 4 mechanisation

  This file mechanises the ESCALATION ARITHMETIC that the host's ladder gate
  implements (`ladderEconomics.ts`: `escalationOptionEv`, `deriveMaxLadderRounds`,
  `deriveLadderFlipRound`, `ladderCapWithinBound`) and that
  `docs/proofs/economics/06-expert-verify.tex.md` §1.2–§1.5 derives by hand.
  Mathlib-free: pure Lean 4 core, like `SingleFinality.lean`.

  ## The model, and its assumptions, stated exactly

  The shipped model is the unmerited challenger's expected profit after
  escalating to ladder round `d` (06 §1.2, r33-6):

      E[π](d) = (1 - a_f^d)·ρ - a_f^d·β = ρ - a_f^d·(ρ + β)

  with

    * `a_f` — the jury's measured accuracy on MANUFACTURED disputes, the
      probability an honest panel rejects the challenger's manufactured round;
    * `ρ`   — the reward on a win, as a fraction of the market value `V`;
    * `β`   — the case's challenge bond, as a fraction of `V`;
    * `d`   — the deepest ladder round the challenger escalates to; `d = 0` is
      conceding, which keeps the rejection and forfeits the bond (`-β`).

  The assumptions this file makes (all of them are the shipped gate's):

    A1. `a_f` is EXACT and rational: `a_f = A / D` with `0 < A < D`
        (`a_f ∈ (0,1)`). The perfect-jury case `a_f = 1` (`A = D`) is treated
        separately — the code returns an unbounded boundary there and so does
        this file (`perfect_jury_all_depths_safe`).
    A2. `ρ` and `β` are positive and share a denominator: `ρ = R/S`,
        `β = B/S` with `R, B > 0` and `S > 0`. `S` cancels from every sign
        comparison, so it is not a parameter.
    A3. Rounds are independent and catastrophic only at the end: after `d`
        rounds the challenger has faced `d` independent panels, each rejecting
        the manufactured round with probability `a_f`, so the win probability
        is `1 - a_f^d` and the loss probability `a_f^d`. This is 06 §1.2's
        model. Per-round bond AMOUNTS are the code's separate schedule
        (`escalationBondMultiple = 3^r`, Theorem 2 of `02-ladder.tex.md`); they
        only shift `β`, so the sign rule does not depend on them.
    A4. `d` ranges over the rounds a challenger may OPEN; the gate's question is
        "is opening round `cap` already profitable?" — the derived cap is the
        deepest `d` with `E[π](d) < 0`.

  ## The scaling trick (why there is no division and no logarithm)

  Every comparison here is a sign comparison. Multiplying `E[π](d)` by the
  positive quantity `S·D^d` gives

      sign(E[π](d)) = sign( R·D^d - A^d·(R + B) ),

  so, without ever dividing or taking a logarithm,

      `safe A D R B d`  ⟺  `R·D^d < A^d·(R + B)`  ⟺  `E[π](d) < 0`.

  The break-even point `a_f^d = ρ/(ρ+β)` (the code's
  `ladderSignBoundary = ln(ρ/(ρ+β))/ln(a_f)`) is `R·D^d = A^d·(R+B)`, which is
  NOT safe: the gate's contract is `E[π] < 0` strictly (r33-6), and that
  strictness is exactly `break_even_not_safe` below.

  ## What is proved (no `sorry`, no extra axioms)

    * `safe_zero` — conceding (`d = 0`) is always unprofitable (`-β`).
    * `safe_step_down` / `safe_monotone` — the safe set is an INITIAL SEGMENT:
      if depth `d` is unprofitable, every shallower depth is. This is the
      "sign-based ladder bound" of r33-6/r40-4, and it is what makes a single
      integer (`flipRound`) a complete description of safety.
    * `exists_unsafe` — the ladder is NOT a free option: some round is always
      profitable (`a_f < 1` drives `a_f^d → 0`), with the explicit witness
      `d = A·B` (`pow_mul_ge` is the two-term binomial bound that proves it).
    * `safe_depth_bound` — **the headline**: `safe d ↔ d < flipRound`, where
      `flipRound` is the first unsafe round. This is exactly the host gate's
      comparison (`ok = maxLadderRounds < flipRound` in `ladderCapWithinBound`).
    * `derivedCapZero_no_safe_depth` — `derivedCap = flipRound - 1 = 0` means NO
      legal ladder round is safe: `∀ d ≥ 1, ¬ safe d`. The r33-6 defect was
      clamping that case to `derivedCap = 1`, which blessed a profitable cap.
    * `flipRound_mono_accuracy` / `derivedCap_mono_accuracy` — a MORE accurate
      jury may only DEEPEN the safe cap (`A₁ ≤ A₂ ⇒ cap A₁ ≤ cap A₂`); the
      direction is the one review round 41 measured (0.30…0.95 → caps 0…5).
    * `flipRound_mono_bond` / `derivedCap_mono_bond` — a larger bond may only
      deepen it (`B₁ ≤ B₂ ⇒ cap B₁ ≤ cap B₂`).
    * `perfect_jury_all_depths_safe` — at `a_f = 1` no depth is profitable
      (the code's `+∞` boundary).

  ## What is NOT mechanised here

  That `flipRound` equals the code's `ceil(ln(ρ/(ρ+β))/ln(a_f))`. The LOGARITHM
  is not modelled (core Lean has no `Real.log`, and the gate does not need it:
  `ladderCapWithinBound` decides on the SIGN). What is mechanised is the sign
  rule and the segment structure — precisely the claim that makes one derived
  integer sufficient. Binary floating-point evaluation is not modelled either:
  this file is exact rational arithmetic, the code evaluates the same products
  in IEEE-754 doubles. See `docs/proofs/07-mechanised-escalation.tex.md`.
-/

namespace BAOCourt
namespace Ladder

/-! ## 0. A choice-free cancellation (core `Nat.lt_of_mul_lt_mul_right` uses
    `Classical.choice`, which this development deliberately does not) -/

theorem lt_of_mul_lt_mul_right' {a b c : Nat} (h : b * a < c * a) : b < c := by
  rcases Nat.lt_or_ge b c with hlt | hge
  · exact hlt
  · exact absurd (Nat.mul_le_mul_right a hge) (Nat.not_le.mpr h)

/-! ## 1. The model -/

/-- `E[π](d) < 0`, scaled by the positive `S·D^d`: the challenger's expected
    profit after escalating to round `d` is strictly negative, i.e.

        R·D^d < A^d·(R + B)   ⟺   ρ·D^d < a_f^d·(ρ+β)·D^d
                              ⟺   ρ < a_f^d·(ρ + β)
                              ⟺   E[π](d) = ρ - a_f^d·(ρ+β) < 0.

    `A/D` is `a_f`, `R/S` is `ρ`, `B/S` is `β` (A1, A2). -/
def safe (A D R B d : Nat) : Prop := R * D ^ d < A ^ d * (R + B)

/-- Break-even (`E[π](d) = 0`) is NOT safety: the gate's contract is strict
    (r33-6). -/
theorem break_even_not_safe {A D R B d : Nat}
    (h : R * D ^ d = A ^ d * (R + B)) : ¬ safe A D R B d := by
  unfold safe
  rw [h]
  exact Nat.lt_irrefl _

/-- Conceding (`d = 0`) always forfeits the bond: `E[π](0) = -β < 0`. -/
theorem safe_zero {A D R B : Nat} (hB : 0 < B) : safe A D R B 0 := by
  unfold safe
  rw [Nat.pow_zero, Nat.pow_zero, Nat.mul_one, Nat.one_mul]
  omega

/-- **The safe set is an initial segment, one step at a time.** If escalating to
    round `d+1` is unprofitable then so is escalating to round `d`:
    `a_f^{d+1}(ρ+β) > ρ·a_f^d` divided by `a_f ≤ 1` is `a_f^d(ρ+β) > ρ`.

    Proof (scaled, no division): from `R·D^{d+1} < A^{d+1}(R+B)` and `A ≤ D`,
    `R·(D^d·D) < (A^d·D)·(R+B)`; both sides carry one factor `D > 0`, so
    cancelling it gives `R·D^d < A^d·(R+B)`. -/
theorem safe_step_down {A D R B d : Nat} (hA : 0 < A) (hAD : A < D)
    (h : safe A D R B (d + 1)) : safe A D R B d := by
  unfold safe at *
  rw [Nat.pow_succ, Nat.pow_succ] at h
  have hD : 0 < D := Nat.lt_trans hA hAD
  have hle : A ^ d * A ≤ A ^ d * D := Nat.mul_le_mul_left _ (Nat.le_of_lt hAD)
  have hlt : R * (D ^ d * D) < A ^ d * D * (R + B) :=
    Nat.lt_of_lt_of_le h (Nat.mul_le_mul_right (R + B) hle)
  have hlt' : R * D ^ d * D < A ^ d * (R + B) * D := by
    have e1 : R * (D ^ d * D) = R * D ^ d * D := by ac_rfl
    have e2 : A ^ d * D * (R + B) = A ^ d * (R + B) * D := by ac_rfl
    rwa [e1, e2] at hlt
  exact lt_of_mul_lt_mul_right' hlt'

/-- Downward closure, `d` steps at a time: safety at depth `d` implies safety at
    every shallower depth. -/
theorem safe_monotone {A D R B : Nat} (hA : 0 < A) (hAD : A < D) :
    ∀ {e d : Nat}, e ≤ d → safe A D R B d → safe A D R B e := by
  intro e d hed
  induction d with
  | zero =>
    intro h
    have he : e = 0 := Nat.le_zero.mp hed
    subst he
    exact h
  | succ d ih =>
    intro h
    rcases Nat.lt_or_ge e (d + 1) with hlt | hge
    · exact ih (Nat.le_of_lt_succ hlt) (safe_step_down hA hAD h)
    · have he : e = d + 1 := Nat.le_antisymm hed hge
      subst he
      exact h

/-! ## 2. The ladder is not a free option: some round is always profitable -/

/-- `A·(A + (d+1)k) ≤ (A + d·k)·(A + k)` — the induction step of the binomial
    bound, isolated so that only linear arithmetic is needed. -/
theorem step_ineq (A d k : Nat) : A * (A + (d + 1) * k) ≤ (A + d * k) * (A + k) := by
  have hX : A ≤ A + d * k := Nat.le_add_right _ _
  have h1 : A * (A + d * k) ≤ (A + d * k) * A := Nat.le_of_eq (Nat.mul_comm _ _)
  have h2 : A * k ≤ (A + d * k) * k := Nat.mul_le_mul_right k hX
  have hsum : A * (A + d * k) + A * k ≤ (A + d * k) * (A + k) := by
    conv =>
      rhs
      rw [Nat.mul_add]
    exact Nat.add_le_add h1 h2
  calc A * (A + (d + 1) * k)
      = A * ((A + d * k) + k) := by rw [Nat.add_mul, Nat.one_mul, Nat.add_assoc]
    _ = A * (A + d * k) + A * k := by rw [Nat.mul_add]
    _ ≤ _ := hsum

/-- `A^d·(A + d·k) ≤ (A + k)^d·A` — the two-term binomial bound
    `(1 + k/A)^d ≥ 1 + d·k/A`, multiplied through by `A` so that no `A^(d-1)`
    (and no truncated subtraction) appears. Explicitly this is
    `A^{d+1} + d·k·A^d ≤ (A+k)^d·A`. -/
theorem pow_mul_ge (A k : Nat) : ∀ d, A ^ d * (A + d * k) ≤ (A + k) ^ d * A
  | 0 => by simp
  | d + 1 => by
    have ih := pow_mul_ge A k d
    have hmul : A ^ d * (A + d * k) * (A + k) ≤ ((A + k) ^ d * A) * (A + k) :=
      Nat.mul_le_mul_right (A + k) ih
    have hstep : A ^ (d + 1) * (A + (d + 1) * k) ≤ A ^ d * (A + d * k) * (A + k) := by
      rw [Nat.pow_succ]
      have hle := Nat.mul_le_mul_left (A ^ d) (step_ineq A d k)
      calc A ^ d * A * (A + (d + 1) * k)
          = A ^ d * (A * (A + (d + 1) * k)) := by rw [Nat.mul_assoc]
        _ ≤ A ^ d * ((A + d * k) * (A + k)) := hle
        _ = A ^ d * (A + d * k) * (A + k) := by rw [Nat.mul_assoc]
    calc A ^ (d + 1) * (A + (d + 1) * k)
        ≤ A ^ d * (A + d * k) * (A + k) := hstep
      _ ≤ (A + k) ^ d * A * (A + k) := hmul
      _ = (A + k) ^ (d + 1) * A := by
        rw [Nat.pow_succ, Nat.mul_assoc, Nat.mul_assoc, Nat.mul_comm A (A + k)]

/-- **The ladder eventually becomes profitable.** With `a_f = A/D < 1`, no
    finite bond funds an unbounded option: at depth `w = A·B` the expected
    profit is already `≥ 0`. (06 §1.2's "the rational `r` is the policy cap" is
    the contrapositive — the ladder is an option unless a cap stops it.)

    Proof: with `k = D - A ≥ 1`, `pow_mul_ge` gives
    `A^{w+1} + w·k·A^w ≤ (A+k)^w·A`. Since `A·(R+B) ≤ R·(A + w·k)` when
    `w = A·B` (i.e. `A·B ≤ R·w·k`, which holds because `R·k ≥ 1`), the bracket
    can be swapped for `R+B`, and one factor of `A` cancels. -/
theorem unsafe_witness {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R) :
    ¬ safe A D R B (A * B) := by
  obtain ⟨k, hkD⟩ : ∃ k, D = A + k := ⟨D - A, by omega⟩
  subst hkD
  have hk : 0 < k := by omega
  unfold safe
  -- `A·(R+B) ≤ R·(A + w·k)` with `w = A·B`
  have hAB : A * B ≤ R * (A * B) * k := by
    have hRk : 0 < R * k := Nat.mul_pos hR hk
    have hge : 1 ≤ R * k := by omega
    calc A * B = A * B * 1 := (Nat.mul_one (A * B)).symm
      _ ≤ A * B * (R * k) := Nat.mul_le_mul_left (A * B) hge
      _ = R * (A * B) * k := by ac_rfl
  have hmain : A * (R + B) ≤ R * (A + A * B * k) := by
    rw [Nat.mul_add, Nat.mul_add]
    have h1 : A * R ≤ R * A := Nat.le_of_eq (Nat.mul_comm A R)
    have h2 : A * B ≤ R * (A * B * k) := by
      calc A * B ≤ R * (A * B) * k := hAB
        _ = R * (A * B * k) := by ac_rfl
    exact Nat.add_le_add h1 h2
  -- assemble, then cancel the single factor `A`
  have hbin := Nat.mul_le_mul_left R (pow_mul_ge A k (A * B))
  have hchain : A * (A ^ (A * B) * (R + B)) ≤ A * (R * (A + k) ^ (A * B)) := by
    calc A * (A ^ (A * B) * (R + B))
        = A ^ (A * B) * (A * (R + B)) := by ac_rfl
      _ ≤ A ^ (A * B) * (R * (A + A * B * k)) := Nat.mul_le_mul_left _ hmain
      _ = R * (A ^ (A * B) * (A + A * B * k)) := by ac_rfl
      _ ≤ R * ((A + k) ^ (A * B) * A) := hbin
      _ = A * (R * (A + k) ^ (A * B)) := by ac_rfl
  exact Nat.not_lt.mpr (Nat.le_of_mul_le_mul_left hchain hA)

/-- The ladder is not a free option: `exists` form (see `unsafe_witness`). -/
theorem exists_unsafe {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R) :
    ∃ d, ¬ safe A D R B d :=
  ⟨A * B, unsafe_witness hA hAD hR⟩

/-! ## 3. The first unsafe round (`flipRound`) -/

/-- Boolean form of {@link safe} (`decide`), so the scan below is computable. -/
def safeB (A D R B d : Nat) : Bool := decide (R * D ^ d < A ^ d * (R + B))

theorem safeB_eq_true {A D R B d : Nat} : safeB A D R B d = true ↔ safe A D R B d := by
  unfold safeB safe
  exact decide_eq_true_iff

/-- Scan depths `d, d+1, …, d+fuel` and return the first UNSAFE one, or `d+fuel`
    if all of them are safe. This is the machine-checkable stand-in for the
    code's `ceil(ln(ρ/(ρ+β))/ln(a_f))`: `unsafe_witness` supplies a finite
    fuel, so the scan always lands inside the window. -/
def scanFrom (A D R B : Nat) : Nat → Nat → Nat
  | 0, d => d
  | fuel + 1, d => if safeB A D R B d then scanFrom A D R B fuel (d + 1) else d

/-- **The first unsafe round**: the code's `deriveLadderFlipRound`, i.e. the
    round at which `E[π]` turns positive. The scan window `A·B` is
    `exists_unsafe`'s witness, so the scan is guaranteed to find it. -/
def flipRound (A D R B : Nat) : Nat := scanFrom A D R B (A * B) 0

/-- **The scan's specification**: if the last depth in the window is unsafe,
    then `scanFrom fuel d` is the FIRST unsafe depth `k ≥ d`, and every depth
    `d..k-1` is safe. -/
theorem scanFrom_spec {A D R B : Nat} (hA : 0 < A) (hAD : A < D) :
    ∀ (fuel d : Nat), ¬ safe A D R B (d + fuel) →
      d ≤ scanFrom A D R B fuel d ∧ scanFrom A D R B fuel d ≤ d + fuel ∧
      ¬ safe A D R B (scanFrom A D R B fuel d) ∧
      ∀ e, d ≤ e → e < scanFrom A D R B fuel d → safe A D R B e
  | 0, d, h => by
    rw [Nat.add_zero] at h
    have hz : scanFrom A D R B 0 d = d := rfl
    refine ⟨Nat.le_refl d, Nat.le_refl d, ?_, ?_⟩
    · rwa [hz]
    · intro e hde he
      rw [hz] at he
      exact absurd hde (Nat.not_le.mpr he)
  | fuel + 1, d, h => by
    have hassoc : d + (fuel + 1) = (d + 1) + fuel := by
      rw [← Nat.add_assoc, Nat.add_right_comm]
    rw [hassoc] at h
    simp only [scanFrom]
    by_cases hs : safeB A D R B d
    · rw [if_pos hs]
      obtain ⟨h1, h2, h3, h4⟩ := scanFrom_spec hA hAD fuel (d + 1) h
      refine ⟨Nat.le_trans (Nat.le_succ d) h1, ?_, h3, ?_⟩
      · rw [hassoc]
        exact h2
      · intro e hde hek
        rcases Nat.lt_or_ge e (d + 1) with hlt | hge
        · exact safe_monotone hA hAD (Nat.le_of_lt_succ hlt) (safeB_eq_true.mp hs)
        · exact h4 e hge hek
    · rw [if_neg hs]
      have hns : ¬ safe A D R B d := fun hc => hs (safeB_eq_true.mpr hc)
      refine ⟨Nat.le_refl d, Nat.le_add_right d (fuel + 1), hns, ?_⟩
      intro e hde he
      exact absurd hde (Nat.not_le.mpr he)

set_option linter.unusedVariables false in
/-- The two facts that define the flip round: it is unsafe, and everything
    shallower is safe. -/
theorem flipRound_spec {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R)
    (hB : 0 < B) :
    ¬ safe A D R B (flipRound A D R B) ∧ ∀ e, e < flipRound A D R B → safe A D R B e := by
  have h : ¬ safe A D R B (0 + A * B) := by
    rw [Nat.zero_add]
    exact unsafe_witness (B := B) hA hAD hR
  unfold flipRound
  obtain ⟨-, -, h3, h4⟩ := scanFrom_spec hA hAD (A * B) 0 h
  exact ⟨h3, fun e he => h4 e (Nat.zero_le e) he⟩

/-- The flip round is a legal round index (`≥ 1`): round 0 is conceding, which
    is always safe. -/
theorem flipRound_pos {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R)
    (hB : 0 < B) : 0 < flipRound A D R B := by
  rcases Nat.eq_zero_or_pos (flipRound A D R B) with h | h
  · exfalso
    have hunsafe := (flipRound_spec hA hAD hR hB).1
    rw [h] at hunsafe
    exact hunsafe (safe_zero hB)
  · exact h

/-- **THE SIGN-BASED LADDER BOUND (headline).** Escalating to round `d` is
    unprofitable exactly for the rounds below the flip round:

        E[π](d) < 0   ⟺   d < flipRound(a_f, ρ, β).

    This is verbatim the host gate's decision
    (`ladderCapWithinBound` returns `ok = maxLadderRounds < flipRound`,
    r33-6/r40-4): a configured cap is inside the bound iff the round it admits
    is still priced. Derivation is `scanFrom_spec` at the witness `A·B`, plus
    downward closure of safety; no logarithm, no division. -/
theorem safe_depth_bound {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R)
    (hB : 0 < B) (d : Nat) :
    safe A D R B d ↔ d < flipRound A D R B := by
  obtain ⟨hunsafe, hbelow⟩ := flipRound_spec hA hAD hR hB
  constructor
  · intro hsafe
    rcases Nat.lt_or_ge d (flipRound A D R B) with hlt | hge
    · exact hlt
    · exact absurd (safe_monotone hA hAD hge hsafe) hunsafe
  · intro hlt
    exact hbelow d hlt

/-! ## 4. The derived cap, and `0` meaning "no safe depth" (r33-6) -/

/-- `deriveMaxLadderRounds`: the deepest round with `E[π] < 0`, i.e.
    `flipRound - 1`. `0` means NO legal ladder round is safe. -/
def derivedCap (A D R B : Nat) : Nat := flipRound A D R B - 1

/-- **`derivedCap = 0` ⇒ no safe depth.** The r33-6 defect was clamping this
    case to `1` (so `cap <= derivedCap` blessed a profitable round); the
    mechanised statement is that every LEGAL round (`d ≥ 1`) is already
    unprofitable, so a host that reads `0` must refuse every ladder. -/
theorem derivedCapZero_no_safe_depth {A D R B : Nat} (hA : 0 < A) (hAD : A < D)
    (hR : 0 < R) (hB : 0 < B) (h0 : derivedCap A D R B = 0) :
    ∀ d, 1 ≤ d → ¬ safe A D R B d := by
  intro d hd
  have hpos := flipRound_pos hA hAD hR hB
  have hfr : flipRound A D R B = 1 := by
    unfold derivedCap at h0
    exact Nat.le_antisymm (Nat.le_of_sub_eq_zero h0) (Nat.succ_le_of_lt hpos)
  intro hsafe
  have hlt := (safe_depth_bound hA hAD hR hB d).mp hsafe
  rw [hfr] at hlt
  exact absurd hd (Nat.not_le.mpr hlt)

/-! ## 5. Monotonicity in the jury accuracy and in the bond -/

/-- A more accurate jury makes every depth weakly safer (it rejects the
    manufactured round more often). -/
theorem safe_mono_accuracy {A₁ A₂ D R B d : Nat} (h : A₁ ≤ A₂)
    (hs : safe A₁ D R B d) : safe A₂ D R B d := by
  unfold safe at *
  have hpow : A₁ ^ d ≤ A₂ ^ d := Nat.pow_le_pow_left h d
  have : A₁ ^ d * (R + B) ≤ A₂ ^ d * (R + B) := Nat.mul_le_mul_right _ hpow
  exact Nat.lt_of_lt_of_le hs this

/-- A larger bond makes every depth weakly safer (the challenger loses more when
    the manufactured round is rejected). -/
theorem safe_mono_bond {A D R B₁ B₂ d : Nat} (h : B₁ ≤ B₂)
    (hs : safe A D R B₁ d) : safe A D R B₂ d := by
  unfold safe at *
  have : R + B₁ ≤ R + B₂ := by omega
  exact Nat.lt_of_lt_of_le hs (Nat.mul_le_mul_left _ this)

/-- **Monotone in `a_f`** (r41): a more accurate jury may only DEEPEN the safe
    cap — i.e. the flip round moves no earlier. The direction matters: shipping
    a cap derived from a LESS accurate jury than the one that will judge is
    exactly the r41 defect. -/
theorem flipRound_mono_accuracy {A₁ A₂ D R B : Nat}
    (hA₁ : 0 < A₁) (hA₂ : 0 < A₂) (hD : A₁ < D) (hD₂ : A₂ < D)
    (hR : 0 < R) (hB : 0 < B) (h : A₁ ≤ A₂) :
    flipRound A₁ D R B ≤ flipRound A₂ D R B := by
  have hunsafe : ¬ safe A₂ D R B (flipRound A₂ D R B) :=
    (flipRound_spec hA₂ hD₂ hR hB).1
  have hbelow : ∀ e, e < flipRound A₁ D R B → safe A₁ D R B e :=
    (flipRound_spec hA₁ hD hR hB).2
  rcases Nat.lt_or_ge (flipRound A₂ D R B) (flipRound A₁ D R B) with hlt | hge
  · exact absurd (safe_mono_accuracy h (hbelow _ hlt)) hunsafe
  · exact hge

/-- **Monotone in `β`**: a larger bond may only deepen the safe cap. -/
theorem flipRound_mono_bond {A D R B₁ B₂ : Nat} (hA : 0 < A) (hAD : A < D)
    (hR : 0 < R) (hB₁ : 0 < B₁) (hB₂ : 0 < B₂) (h : B₁ ≤ B₂) :
    flipRound A D R B₁ ≤ flipRound A D R B₂ := by
  have hunsafe : ¬ safe A D R B₂ (flipRound A D R B₂) :=
    (flipRound_spec hA hAD hR hB₂).1
  have hbelow : ∀ e, e < flipRound A D R B₁ → safe A D R B₁ e :=
    (flipRound_spec hA hAD hR hB₁).2
  rcases Nat.lt_or_ge (flipRound A D R B₂) (flipRound A D R B₁) with hlt | hge
  · exact absurd (safe_mono_bond h (hbelow _ hlt)) hunsafe
  · exact hge

/-- The derived cap is non-decreasing in the jury accuracy (the form the host
    reads). -/
theorem derivedCap_mono_accuracy {A₁ A₂ D R B : Nat}
    (hA₁ : 0 < A₁) (hA₂ : 0 < A₂) (hD : A₁ < D) (hD₂ : A₂ < D)
    (hR : 0 < R) (hB : 0 < B) (h : A₁ ≤ A₂) :
    derivedCap A₁ D R B ≤ derivedCap A₂ D R B := by
  unfold derivedCap
  exact Nat.sub_le_sub_right (flipRound_mono_accuracy hA₁ hA₂ hD hD₂ hR hB h) 1

/-- The derived cap is non-decreasing in the bond (the form the host reads). -/
theorem derivedCap_mono_bond {A D R B₁ B₂ : Nat} (hA : 0 < A) (hAD : A < D)
    (hR : 0 < R) (hB₁ : 0 < B₁) (hB₂ : 0 < B₂) (h : B₁ ≤ B₂) :
    derivedCap A D R B₁ ≤ derivedCap A D R B₂ := by
  unfold derivedCap
  exact Nat.sub_le_sub_right (flipRound_mono_bond hA hAD hR hB₁ hB₂ h) 1

/-! ## 6. The perfect jury: `a_f = 1` (`A = D`) is never profitable -/

/-- At `a_f = 1` the challenger never survives, so EVERY depth is unprofitable —
    the case the code reports as an infinite boundary (`deriveLadderFlipRound`
    returns `+∞` at `a_f = 1`). -/
theorem perfect_jury_all_depths_safe {A R B : Nat} (hA : 0 < A) (hB : 0 < B) (d : Nat) :
    safe A A R B d := by
  unfold safe
  have hpos : 0 < A ^ d := Nat.pow_pos hA
  have hlt : R * A ^ d < (R + B) * A ^ d :=
    Nat.mul_lt_mul_of_pos_right (by omega) hpos
  rwa [Nat.mul_comm (R + B) (A ^ d)] at hlt

end Ladder
end BAOCourt
