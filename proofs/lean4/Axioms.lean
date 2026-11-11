/-
  Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

  Axiom audit for the mechanised layers. Every theorem below must depend only on
  Lean's own core axioms (`propext`, `Quot.sound`); anything else — a `sorry`
  (`sorryAx`), a `native_decide` escape (`Lean.ofReduceBool`), or a bespoke
  axiom — means a gap and must be treated as a failure.

  Three modules are audited:

    * `SingleFinality`    — one verdict per case, one message per epoch (§1);
    * `LadderBound`       — the sign-based ladder bound (§2, r33-6/r40-4);
    * `EscalationLedger`  — bond consumption + one-hash-one-index (§3, r38-1,
                            INV-ESC-8/9).

  Run: `lake env lean Axioms.lean` (see run.sh).
-/
import SingleFinality
import LadderBound
import EscalationLedger

/-! ## 1. Single finality (`SingleFinality.lean`) -/
open BAOCourt

#print axioms terminal_untouched
#print axioms final_stable
#print axioms finalized_outcome_unique
#print axioms oracle_single_finality
#print axioms epochMessage_finalized
#print axioms finalized_eq_epochMessage
#print axioms machine_alone_insufficient
#print axioms no_equivocation
#print axioms machine_final_certified_unique

#check @oracle_single_finality
#check @finalize_barrier

/-! ## 2. The sign-based ladder bound (`LadderBound.lean`) -/

#print axioms BAOCourt.Ladder.break_even_not_safe
#print axioms BAOCourt.Ladder.safe_zero
#print axioms BAOCourt.Ladder.safe_step_down
#print axioms BAOCourt.Ladder.safe_monotone
#print axioms BAOCourt.Ladder.pow_mul_ge
#print axioms BAOCourt.Ladder.unsafe_witness
#print axioms BAOCourt.Ladder.exists_unsafe
#print axioms BAOCourt.Ladder.flipRound_spec
#print axioms BAOCourt.Ladder.flipRound_pos
#print axioms BAOCourt.Ladder.safe_depth_bound
#print axioms BAOCourt.Ladder.derivedCapZero_no_safe_depth
#print axioms BAOCourt.Ladder.safe_mono_accuracy
#print axioms BAOCourt.Ladder.safe_mono_bond
#print axioms BAOCourt.Ladder.flipRound_mono_accuracy
#print axioms BAOCourt.Ladder.flipRound_mono_bond
#print axioms BAOCourt.Ladder.derivedCap_mono_accuracy
#print axioms BAOCourt.Ladder.derivedCap_mono_bond
#print axioms BAOCourt.Ladder.perfect_jury_all_depths_safe

#check @BAOCourt.Ladder.safe_depth_bound
#check @BAOCourt.Ladder.derivedCapZero_no_safe_depth

/-! ## 3. The escalation ledger (`EscalationLedger.lean`) -/

#print axioms BAOCourt.Escalation.reachable_wellFormed
#print axioms BAOCourt.Escalation.one_hash_one_index
#print axioms BAOCourt.Escalation.one_index_one_hash
#print axioms BAOCourt.Escalation.round_bond_consumed_once
#print axioms BAOCourt.Escalation.round_bond_not_membership
#print axioms BAOCourt.Escalation.round_bond_not_accepted
#print axioms BAOCourt.Escalation.strict_case_has_round_bond
#print axioms BAOCourt.Escalation.consumed_not_reused
#print axioms BAOCourt.Escalation.rounds_consecutive
#print axioms BAOCourt.Escalation.opened_rounds_from_one
#print axioms BAOCourt.Escalation.openedRounds_strict_mono
#print axioms BAOCourt.Escalation.rounds_strict_mono
#print axioms BAOCourt.Escalation.log_length_bounded
#print axioms BAOCourt.Escalation.escalation_opens_next_round

#check @BAOCourt.Escalation.consumed_not_reused
#check @BAOCourt.Escalation.one_hash_one_index
