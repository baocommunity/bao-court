# proofs/lean4 — the mechanised Court layer (Lean 4)

Three Mathlib-free Lean 4 developments, all kernel-checked:

| Module | What it mechanises | Doc |
|---|---|---|
| `SingleFinality.lean` | **single finality** — at most one message finalized per epoch, at most one outcome per case (Theorem 4's finality arm; the machine-alone boundary is proved as a counterexample) | this file, §4–6 |
| `LadderBound.lean` | **the sign-based ladder bound** — `E[π](d) < 0 ↔ d < flipRound`, monotonicity in `a_f` and `β`, `derivedCap = 0` ⇒ no safe depth (r33-6/r40-4) | `docs/proofs/07-mechanised-escalation.tex.md` §2–3 |
| `EscalationLedger.lean` | **bond consumption + one-hash-one-index** — per-round bonds never re-used (INV-ESC-9), one bond one challenger (r38-1), rounds consecutive from 1 (INV-ESC-8), and the entry-matrix barriers never refuse a legal history (r40-1/r40-2) | `docs/proofs/07-mechanised-escalation.tex.md` §4 |

This is the interactive-theorem-prover (ITP) layer of the proof stack — the
complement to `proofs/mechanized` (Quint), which machine-checks a **bounded**
state space.

**Status: CHECKED.** Lean 4.14.0 (pinned by `lean-toolchain`), `lake build`
green for all three modules, **no `sorry`**, and the axiom audit shows only
Lean's own core axioms (`propext`, `Quot.sound`) — the ladder module avoids
`Nat.lt_of_mul_lt_mul_right` precisely because it drags in `Classical.choice`
(see `lt_of_mul_lt_mul_right'`). Log: `lean-run.log`.

```lean
-- as mechanised (SingleFinality.lean §10) — single finality
theorem oracle_single_finality (s : SystemState) (e : Epoch) (m1 m2 : Message) :
    State.Finalized s e m1 ∧ State.Finalized s e m2 → m1 = m2

-- as mechanised (LadderBound.lean §3) — the ladder gate
theorem safe_depth_bound {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R)
    (hB : 0 < B) (d : Nat) :
    safe A D R B d ↔ d < flipRound A D R B

-- as mechanised (EscalationLedger.lean §7) — a consumed bond is spent
theorem consumed_not_reused {strict : Bool} {c : Case} (h : Reachable strict c) :
    ∀ r ∈ c.log, ∀ f, r.roundBond = some f →
      ∀ r' ∈ c.log, r.round < r'.round → r'.roundBond ≠ some f
```

---

## 1. How to re-run (one command)

```bash
# one-time toolchain install (~2 min, ~1.2 GB into ~/.elan)
curl -sSfL https://elan.lean-lang.org/elan-init.sh | sh -s -- -y \
  --default-toolchain leanprover/lean4:v4.14.0

cd proofs/lean4
./run.sh                    # lake build + sorry guard + axiom audit
./run.sh > lean-run.log 2>&1
```

Or directly, without the script:

```bash
cd proofs/lean4
lake build                          # kernel-checks every proof
lake env lean Axioms.lean           # axiom audit (printed, expected below)
```

`lean-toolchain` pins `leanprover/lean4:v4.14.0`; `lakefile.toml` declares one
library (`SingleFinality`) with **no dependencies**. `lake` fetches the pinned
toolchain automatically if `elan` is installed with a different default.

Expected axiom audit — the only acceptable output is `propext` / `Quot.sound`
(Lean core, arising from `funext` and list reasoning) or nothing at all:

```
'BAOCourt.terminal_untouched'        depends on axioms: [propext, Quot.sound]
'BAOCourt.final_stable'              depends on axioms: [propext, Quot.sound]
'BAOCourt.finalized_outcome_unique'  does not depend on any axioms
'BAOCourt.oracle_single_finality'    depends on axioms: [Quot.sound]
'BAOCourt.machine_alone_insufficient' does not depend on any axioms
'BAOCourt.no_equivocation'           does not depend on any axioms
```

Any `sorryAx` or `Lean.ofReduceBool` in that list means a gap. (`run.sh` fails
the build if any declaration reports `uses 'sorry'`.)

---

## 2. What is modelled — and what is not

Deliberately minimal: the theorem's essence, not the whole protocol.

| Lean | TS source | Notes |
|---|---|---|
| `Session` = `(epoch, caseId, phase, verdict : Option Outcome)` | `CourtConfirmationMachineState` | `(epoch, caseId)` is the **session key**; `verdict` is the single-valued outcome field. |
| `Phase` (11 constructors) + `isTerminal` | `CourtConfirmationPhase`, `TERMINAL_PHASES` | exact transcription. |
| `advance` (guard + `Effect`, refuses terminal phases) | `produce()` guard clauses | one transition primitive; the `TERMINAL_PHASES.has(state.phase)` barrier is inside it. |
| `Effect.advance p` / `.advanceVerdict p v` | handler return records | an effect **cannot** change `(epoch, caseId)` — that is what makes the session table functional. |
| `step` (11 events) | `confirmationMachineHandlers.ts` | the phase graph of `courtConfirmationMachine.ts` §1: `confirm_open → confirm_closed → challenge_window → … → fee_settlement → final`, plus `expire`/`abort`. |
| `finalize` guard = `phase == feeSettlement && verdict.isSome`, effect = `.advance .final` | `onFinalize` | the verdict is **not** touched by `finalize`: the finalized outcome is exactly the verdict already in the state. |
| `Message` = `(epoch, verdicts : CaseId → Option Outcome)` | `batchAttestation.ts` epoch root | the batch's case→outcome map. |
| `Certificate` / `Abstraction` | `validator.ts`, `batchAttestation.ts`, FROST signatures | crypto section (§12 of the Lean file); see §4 below. |

**Not modelled** (and therefore not claimed): the confirmation ledger and its
re-verification barrier, the bond witness, the mass-vote and outcome-history
ledgers, deadlines/time, clawback flags, hashes of event ids, the FROST
ceremony/DKG, NIP-59 transport, and the settlement rails (A6). Those live in the
TS suite, `invariantAssertions.test.ts`, and the pen-and-paper proofs
(`docs/proofs/`). The Lean model abstracts each machine instance to a session
with a phase and a verdict — the level at which single finality is a statement
about the protocol rather than about bytes.

---

## 3. What is proved

| Theorem | Statement (informal) | Relies on |
|---|---|---|
| `look_some_unique` | the session table is functional: one session per `(epoch, caseId)` | — |
| `terminal_untouched_advance`, `terminal_untouched` | **no event can modify a session in a terminal phase** (`final`, `expired`, `aborted`) | — |
| `finalize_barrier` | `finalize` succeeds only from `feeSettlement` **with a recorded verdict**, and only changes the phase | — |
| `final_stable` | **once final, always final**: along any history, a finalized session keeps its phase and verdict forever | `propext` |
| `finalized_outcome_unique` | at most one outcome is final for a given `(epoch, caseId)`, in any state | — |
| `oracle_single_finality` | **at most one message is finalized per epoch** | `Quot.sound` |
| `epochMessage_finalized`, `finalized_eq_epochMessage` | a finalized message exists, and *every* finalized message **is** the state's derived message | `propext` |
| `machine_alone_insufficient` | **two reachable states finalize different outcomes for the same case** — a machine-checked statement of the layer's limit | — |
| `binding_epoch_ne` | a certificate's binding includes the epoch, so cross-epoch replay changes the binding | — |
| `no_equivocation` | **two valid certificates for the same `(epoch, caseId)` binding carry the same outcome** | 2 named hypotheses (§4) |
| `machine_final_certified_unique` | machine-final + certified ⇒ unique outcome per case | same 2 |

`Reachable` / `Star Step init s` is an **inductive** reachability relation over
event histories, and `final_stable` is proved for **every finite history of any
length** — not to a depth bound.

### The argument, in one paragraph

`finalize` is the only event that enters phase `final`, it is reachable only
from `fee_settlement` with a verdict already recorded, and its effect cannot
change the verdict — so the outcome written into `final` is whatever the state
already held (`finalize_barrier`). Terminal phases are absorbing
(`terminal_untouched`), so no later event can rewrite it (`final_stable`). The
session key is fixed by construction (`Effect` cannot touch `epoch`/`caseId`) and
the verdict field is a single `Option Outcome`, so at most one outcome is final
per case (`finalized_outcome_unique`). The epoch's message is the map
`case ↦ final outcome` derived from the state (`finalVerdicts`); a message is
*accepted* as finalized when it is sound (every claim is a machine-final
session) and complete (every machine-final session is claimed). Soundness of one
message plus completeness of the other forces their case→outcome maps to agree —
if one claims `c ↦ o`, that is a machine-final outcome, and by
`finalized_outcome_unique` the other cannot claim anything else for `c`; if one
claims nothing for `c`, nothing can be final for `c`, so neither can the other.
Two equal maps with equal epoch tags are one message (`oracle_single_finality`).

---

## 4. Assumption boundary — proved vs assumed

This is the part to read sceptically. Everything about the **machine** is
proved. Everything about **cryptography** is an explicit, named hypothesis in the
statement of `no_equivocation` — never a global `axiom`, so a caller cannot use
the theorem without supplying them.

**Abstracted, and why that is legitimate.** `Signed : Signer → Digest → Prop`
and `Honest : Signer → Prop` are uninterpreted predicates: the model says
nothing about what a signature *is*, only that a certificate carries a digest
that its signer set signed. `Digest` is the tuple `(epoch, caseId, outcome)` —
the real system hashes exactly that tuple (`hashCourtVerdict`,
`H(BatchManifest/v1, u32(epoch), …)`), and treating a hash as its preimage is
the standard abstraction, justified by collision resistance.

**The two hypotheses** (proof `no_equivocation`):

1. **`hintersect` — threshold intersection.** Any two quorum signer sets over the
   same binding share an **honest** member. Justified by `2q > n` with at most
   `f < q` Byzantine members: `|Q₁ ∩ Q₂| ≥ 2q − n > f`, so the intersection
   cannot be entirely Byzantine. **This arithmetic is NOT mechanised here** — it
   needs finite-set cardinality (Mathlib's `Finset`, or a `List` pigeonhole
   development) and pulling Mathlib in would trade a seconds-long dependency-free
   build for a gigabyte one. It is the standard threshold-intersection fact, the
   same one `docs/proofs/05-threshold-soundness.tex.md` proves in prose, and it
   is a hypothesis so that the gap is visible in the theorem statement rather
   than hidden.
2. **`hsign_once` — juror non-equivocation.** An honest signer never signs two
   distinct outcomes for the same `(epoch, caseId)`. On the TS side every
   signature is bound to `(sessionHash, epoch)` (`hashCourtConfirmation`,
   `batchAttestation` tags), so an honest implementation signs at most one
   verdict per case per epoch. This is assumption A4/honest-majority territory in
   `docs/FORMAL_INVARIANTS.md` §1.5, not a machine property.

**Consequence for reading the headline theorem.** `oracle_single_finality` is
about **one state at a time**: any state — reachable or not — has at most one
finalized message per epoch, because the message is derived from a state whose
per-case outcome is single-valued. It does **not** say two different states agree,
and `machine_alone_insufficient` proves that they need not: two reachable states
finalize case `(0,0)` with different outcomes. That is not a bug in the machine —
it is what "two independent histories" means — and it is precisely why
cross-history single finality is **not** a machine theorem but a signature-layer
theorem: `no_equivocation` (via `hintersect` + `hsign_once`) is the statement
that no two signer sets can both produce a valid certificate for different
outcomes of the same `(epoch, caseId)`.

The honest one-line summary: **the machine gives determinism per state; the
signature layer gives agreement across runs; the two together give single
finality.** The first is proved here without assumptions, the second is reduced
here to two named hypotheses.

---

## 5. What this adds beyond Quint (`proofs/mechanized`)

Quint with Apalache is *bounded*: `quint run` samples 10 000 seeded runs of ≤ 60
steps, and `quint verify` is exhaustive **only to depth 10**. Its invariants are
checked on the states the spec can reach within those bounds. Lean proves
statements about **all** states, with no depth bound, and can quantify over
objects the spec never constructs.

Concretely, four things this layer adds:

1. **Unbounded histories.** `final_stable` holds for a history of any finite
   length; no step bound, no seed, no sampling. "Final is absorbing" is the
   property that *must* be unbounded — a counterexample at depth 11 is exactly
   what a depth-10 check cannot rule out.
2. **Quantification over messages, not just states.** `oracle_single_finality`
   quantifies over *all* `m : Message` satisfying the soundness/completeness
   checks — including messages no spec action ever builds. Model checking can
   only refute claims about objects the spec has variables for.
3. **A machine-checked negative result.** `machine_alone_insufficient` is a proof
   that the machine layer alone cannot deliver cross-history single finality. It
   dates the boundary between "proved" and "assumed" in §4, instead of leaving it
   to prose.
4. **Assumptions in the types.** `hintersect` and `hsign_once` are hypotheses of
   the theorem, visible in `#check`, so an auditor sees exactly what was assumed.
   Prose assumptions drift; typed ones do not.

What Quint still does better, and keeps doing: it models **far more** of the
machine (ledgers, deadlines, clawback, ballots, ties) and it is executable —
you can run scenarios against it. The two layers are complementary: Quint covers
breadth in a bounded depth, Lean covers depth for a narrow, central property.

---

## 6. Relationship to the invariant catalogue

- **INV-CONF-32 (finality = last resolved round)** — the Lean `finalize` guard
  and `finalize_barrier` are the abstract form of "the verdict is the last
  resolved round's winner": the outcome finalized is the one already in the
  state, never a fresh choice.
- **INV-CONF-34 (verdict determinism — flags are not verdict inputs)** — the Lean
  `Session.verdict` is a single field with no clawback-flag input, so replaying a
  state yields the same verdict; `finalized_outcome_unique` is its
  consequence at the finality layer.
- **INV-BATCH-9 (manifest binding)** — `Certificate.binding` includes the epoch
  and `binding_epoch_ne` proves a cross-epoch replay changes the binding: the
  abstract form of `u32(epoch)` inside `hashBatchManifest`.
- **fail-closed discipline (§2) / `TERMINAL_PHASES`** — `terminal_untouched` is
  the machine-level form of the terminal barrier (`final`, `expired`, `aborted`
  have no outgoing transition).
- **A1 / A4** (`docs/FORMAL_INVARIANTS.md` §1.5) — the threshold and honesty
  assumptions that §4's `hintersect` / `hsign_once` stand on.

---

## 7. Files

| File | What it is |
|---|---|
| `SingleFinality.lean` | the confirmation-machine model + single-finality proofs (~600 lines) |
| `LadderBound.lean` | the ladder-sign model + `safe_depth_bound` and its corollaries |
| `EscalationLedger.lean` | the escalation/challenge ledgers + consumption and ordering theorems |
| `Axioms.lean` | axiom audit for every headline theorem of all three modules (run by `run.sh`) |
| `lakefile.toml`, `lean-toolchain` | project + pinned toolchain (`v4.14.0`), no dependencies |
| `run.sh` | one-command re-run: build, `sorry` guard, axiom audit |
| `lean-run.log` | output of the recorded run (this checkout) |
| `.gitignore` | `.lake/` build directory |
