/-
  Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

  Axiom audit for the mechanised single-finality layer. Every theorem below must
  depend only on Lean's own core axioms (`propext`, `Quot.sound`); anything else
  — a `sorry` (`sorryAx`), a `native_decide` escape (`Lean.ofReduceBool`), or a
  bespoke axiom — means a gap and must be treated as a failure.

  Run: `lake env lean Axioms.lean` (see run.sh).
-/
import SingleFinality
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
