# Theorem 7 — The escalation layer, mechanised (ladder bound, bond consumption, transport binding)

**Modules:** `ladderEconomics.ts`, `courtEscalationRequest.ts`,
`confirmationMachineHandlers.ts` (`onAcceptChallenge`, `onEscalate`,
`onOpenLadderRound`), `confirmationMachineCore.ts`
(`assertValidEscalationLog`, `assertValidConfirmationLedger`).
**Artifacts:** `proofs/lean4/{LadderBound,EscalationLedger}.lean` (kernel-checked,
Mathlib-free) and `proofs/mechanized/escalation.qnt` (Quint: 16 scenarios + 2
seeded simulation runs + Apalache where a JVM is present).
**Status:** every theorem below is machine-checked — no `sorry`, and the axiom
audit (`proofs/lean4/Axioms.lean`) shows only Lean's own `propext` and
`Quot.sound`. Sections 8 and 9 state exactly what is NOT mechanised.

The escalation layer accumulated five machine changes across review rounds 31–40
that were until now *test-pinned only*: per-round bond consumption (INV-ESC-9),
one-hash-one-index (r38-1), the escalation ledger's entry matrix (r40-1/r40-2),
the sign-based ladder bound (r33-6/r40-4) and the wire's binding refusals
(r8-1/r8-2). A test pins one path; a theorem pins every path. This file records
which conjunct is now a theorem, where it is proved, and what remains a test.

---

## 1. Statement

Write `a_f`, `ρ`, `β` for the jury's accuracy on manufactured disputes, the
reward on a win and the challenge bond (`06-expert-verify.tex.md` §1.2), and

    E[π](d) = (1 − a_f^d)·ρ − a_f^d·β = ρ − a_f^d·(ρ + β)

for the unmerited challenger's expected profit after escalating to ladder round
`d` (`d = 0` conceding).

> **Theorem 7.1 (sign-based ladder bound).** For exact rationals
> `a_f = A/D ∈ (0,1)`, `ρ = R/S`, `β = B/S` with `R, B, S > 0`, and with
> `flipRound(a_f, ρ, β)` the least round at which `E[π]` is non-negative,
>
>     E[π](d) < 0  ⟺  d < flipRound(a_f, ρ, β).
>
> Consequently the host gate `maxLadderRounds < flipRound`
> (`ladderCapWithinBound`) accepts exactly those caps whose deepest admitted
> round is still unprofitable.

> **Theorem 7.2 (monotonicity and the `derivedCap = 0` corollary).**
> (a) `derivedCap = flipRound − 1` is non-decreasing in `a_f` and in `β`: a
> more accurate jury, or a larger bond, may only DEEPEN the safe cap.
> (b) `derivedCap = 0` means NO legal ladder round is safe: `∀ d ≥ 1,
> ¬(E[π](d) < 0)`. (The r33-6 defect clamped this case to `1`, which blessed a
> profitable cap.)
> (c) At `a_f = 1` every depth is unprofitable (the code's `+∞` boundary).

> **Theorem 7.3 (ledger: consumption, one-hash-one-index, round order).** For
> every state reachable from `create` by the machine's two ledger-writing
> transitions (`accept_challenge`, `escalate`):
> (a) **r38-1** — a membership bond witness is bound to at most ONE challenger
> index (and each challenger to at most one bond);
> (b) **INV-ESC-9** — a per-round bond witness appears in at most one escalation
> record, and a witness consumed at round `R` is never consumed at any `R' > R`;
> (c) **r33-1** — a per-round bond is never the record's own membership bond and
> never ANY accepted challenge bond;
> (d) **R42** — under `requireRoundBond` every record carries one;
> (e) **INV-ESC-8** — the log's rounds are `2, 3, …, |log|+1`, so the sequence of
> ladder rounds the case has OPENED is `1, 2, …, |log|+1`: strictly increasing
> from 1, with no gaps and no repeats; the log never exceeds
> `MAX_LADDER_ROUNDS = 5`.
> (f) The invariant bundle is preserved by every transition, so the barriers
> (`assertValidEscalationLog`, `assertValidConfirmationLedger`) can never refuse
> a state the machine itself produced — the r40-1/r40-2 entry matrix bites only
> on a restored or tampered snapshot.

> **Theorem 7.4 (transport binding, model-checked).** In the Quint model of the
> v0.14.0 wire, for every wire the environment may offer (including hostile
> ones), every recorded escalation carries wire claims that agree with the HOST
> binding — the case id the host routed on and the pubkey the request
> authenticated as — and a round-bound witness opens only `ladderRound + 1`;
> `open_ladder_round` seats only a round for which a pending escalation record
> exists.

---

## 2. The model, and its assumptions

The mechanised ladder model is 06 §1.2's, with the assumptions stated as
hypotheses rather than prose (they are all in the `LadderBound.lean` docstring):

| # | Assumption | Where |
|---|---|---|
| A1 | `a_f` is exact and rational: `a_f = A/D`, `0 < A < D`. `a_f = 1` handled separately (`perfect_jury_all_depths_safe`). | `LadderBound.lean` §1, §6 |
| A2 | `ρ = R/S`, `β = B/S` with `R, B, S > 0`; `S` cancels from every sign comparison. | §1 |
| A3 | Rounds are independent and catastrophic only at the end: win probability `1 − a_f^d`, loss probability `a_f^d`. Per-round bond AMOUNTS (`3^r b₀`, Theorem 2 of `02-ladder.tex.md`) only shift `β`; the sign rule does not depend on them. | §1 |
| A4 | `d` ranges over the rounds a challenger may OPEN; the gate asks whether opening round `cap` is already profitable. | §1, §3 |

**Why there is no logarithm and no division.** Every claim is a sign claim, and
multiplying `E[π](d)` by the positive `S·D^d` gives

    sign(E[π](d)) = sign( R·D^d − A^d·(R+B) ),

so `safe A D R B d  ⟺  R·D^d < A^d·(R+B)` is the whole model
(`LadderBound.lean:safe`). Break-even is `R·D^d = A^d(R+B)`, and
`break_even_not_safe` proves it is NOT safe — the strictness the gate's contract
requires (r33-6).

---

## 3. The ladder bound — `safe_depth_bound`

```lean
theorem safe_depth_bound {A D R B : Nat} (hA : 0 < A) (hAD : A < D) (hR : 0 < R)
    (hB : 0 < B) (d : Nat) :
    safe A D R B d ↔ d < flipRound A D R B
```

Supporting lemmas, in dependency order (`proofs/lean4/LadderBound.lean`):

| Lemma | Content | Role |
|---|---|---|
| `safe_zero` | `E[π](0) = −β < 0` | conceding is always unprofitable |
| `safe_step_down` | `safe (d+1) → safe d` | cancels one factor `D` after `A ≤ D` |
| `safe_monotone` | `e ≤ d → safe d → safe e` | the safe set is an INITIAL SEGMENT |
| `step_ineq`, `pow_mul_ge` | `A^{d+1} + d·k·A^d ≤ (A+k)^d·A` | two-term binomial bound `(1+k/A)^d ≥ 1 + d·k/A` |
| `unsafe_witness` | `¬ safe (A·B)` | **the ladder is not a free option**: witness `d = A·B` |
| `scanFrom_spec` | the scan finds the FIRST unsafe round in a window | `flipRound` implementation |
| `flipRound_spec` | `¬safe flipRound ∧ ∀ e < flipRound, safe e` | the two defining facts |
| `flipRound_pos` | `0 < flipRound` | round 0 is conceding, never the flip |

*Proof of Theorem 7.1.* (⇐) is `flipRound_spec`'s "everything below is safe".
(⇒) If `safe d` and `flipRound ≤ d`, `safe_monotone` gives `safe flipRound`,
contradicting `flipRound_spec`. Both directions are `safe_depth_bound` in the
artifact; nothing else is used.

*Why `flipRound` is defined by a scan and not `ceil(ln(ρ/(ρ+β))/ln a_f)`.* Core
Lean 4.14 has no `Real.log`, and the gate does not need one: it compares SIGNS.
The mechanised content is exactly the claim that makes one integer sufficient —
safety is a segment, and the first unsafe round exists (`unsafe_witness`).
`flipRound` is therefore defined as the least unsafe round over the window
`[0, A·B]`, which `unsafe_witness` proves is long enough.

### 3.1 Monotonicity and the `derivedCap = 0` corollary

| Theorem | Statement |
|---|---|
| `safe_mono_accuracy` | `A₁ ≤ A₂ → safe A₁ → safe A₂` (depth-wise) |
| `safe_mono_bond` | `B₁ ≤ B₂ → safe B₁ → safe B₂` (depth-wise) |
| `flipRound_mono_accuracy` | `A₁ ≤ A₂ → flipRound A₁ ≤ flipRound A₂` |
| `derivedCap_mono_accuracy` | `A₁ ≤ A₂ → derivedCap A₁ ≤ derivedCap A₂` |
| `flipRound_mono_bond`, `derivedCap_mono_bond` | same in `β` |
| `derivedCapZero_no_safe_depth` | `derivedCap = 0 → ∀ d ≥ 1, ¬ safe d` |
| `perfect_jury_all_depths_safe` | `a_f = 1 ⇒ ∀ d, safe d` |

The *direction* is the deliverable: r41's defect was stating it backwards. In
the mechanisation a more accurate jury may only `≤`-deepen the cap, and the
proof is the depth-wise monotonicity plus "first unsafe" minimality — so a host
that ships a cap derived from a LESS accurate jury than the one that judges
cannot satisfy `safe_depth_bound` at its cap.

`derivedCapZero_no_safe_depth` is r33-6 exactly: `derivedCap = 0` forces
`flipRound = 1` (since `flipRound > 0`), so **every legal round is already
unprofitable** — a host that treats `0` as "allow one round" (the old clamp to
`1`) admits a round outside the bound.

---

## 4. The ledger — `EscalationLedger.lean`

The model is the two ledgers the machine keeps (`accepted` challenges and the
append-only `log`), plus the two transitions that write them. `Step.escalate`
takes the guards `onEscalate` applies; `Step.accept` takes the guards
`onAcceptChallenge` applies, including `log = []` (challenges precede the
ladder: `accept_challenge` requires phase `challenge_window`).

`WellFormed` bundles the invariants and `reachable_wellFormed` proves by
induction over `Step` that every reachable state satisfies it. The theorems are
then projections with the review-round names attached:

| Theorem | Conjunct proved | Review id |
|---|---|---|
| `one_hash_one_index` | `(i₁,f) ∈ accepted → (i₂,f) ∈ accepted → i₁ = i₂` | r38-1 |
| `one_index_one_hash` | `(i,f₁) ∈ accepted → (i,f₂) ∈ accepted → f₁ = f₂` | r38-1 (converse) |
| `round_bond_consumed_once` | a round bond appears in ≤ 1 record | INV-ESC-9 |
| `consumed_not_reused` | consumed at `R` ⇒ not consumed at any `R' > R` | INV-ESC-9 corollary |
| `round_bond_not_membership` | `r.roundBond ≠ some r.membershipBond` | INV-ESC-9 |
| `round_bond_not_accepted` | never any accepted challenge bond | r33-1 |
| `strict_case_has_round_bond` | `requireRoundBond ⇒ every rung has one` | R42 |
| `rounds_consecutive` | log rounds are `2..|log|+1` | INV-ESC-8 |
| `opened_rounds_from_one` | opened rounds are `1,2,…,|log|+1` | INV-ESC-8 |
| `openedRounds_strict_mono`, `rounds_strict_mono` | `i`-th round is `1+i` / `2+i` | strictly increasing |
| `escalation_opens_next_round` | the `i`-th record names round `i+2` | r40-2 |
| `log_length_bounded` | `|log| ≤ MAX_LADDER_ROUNDS` | ladder cap |
| `reachable_wellFormed` | the barriers never refuse a legal history | r33-5/r40-1/r40-2 |

`consumed_not_reused` is the one that matters economically: `onEscalate` prices
a rung by demanding a witness no earlier record used, so a RESTORED snapshot
that dropped a log entry silently un-consumes the bond that entry paid with.
`reachable_wellFormed` says that cannot happen to a history the machine
produced; the `assertValidEscalationLog` calls at `escalate`,
`open_ladder_round` and `finalize` are what catch the snapshot that was
tampered with.

---

## 5. Code ↔ model correspondence

Each mechanised conjunct, the function that implements it, and the theorem that
pins it. Line numbers are for `origin/main` @ `v0.14.2` (post review rounds
9–10, which added the `bondTxid` binding to the mapper — row `r9-2` below).

| Conjunct (mechanised form) | Implementation | Mechanised by |
|---|---|---|
| `E[π](d) = ρ − a_f^d(ρ+β)` and its sign | `ladderEconomics.ts:302` `escalationOptionEv` | `safe` (def) + `safe_depth_bound` |
| break-even is NOT safe (strict `< 0`) | `ladderEconomics.ts:184` `strictlySafeAtDepth`; `:260` `deriveMaxLadderRounds`; `:324` `ladderCapWithinBound` | `break_even_not_safe` |
| `ok = maxLadderRounds < flipRound` ⟺ `safe(maxLadderRounds)` | `ladderEconomics.ts:324` `ladderCapWithinBound` | `safe_depth_bound` (both directions) |
| `derivedCap = flipRound − 1` (clamped), `0` = no safe depth | `ladderEconomics.ts:260` `deriveMaxLadderRounds` (exact integer scan, R52) | `derivedCap`, `derivedCapZero_no_safe_depth` |
| monotone non-decreasing in `a_f`, in `β` | `ladderEconomics.ts` `deriveMaxLadderRounds` docstring contract | `flipRound_mono_accuracy`, `flipRound_mono_bond`, `derivedCap_mono_*` |
| `a_f = 1` ⇒ unbounded boundary | `ladderEconomics.ts:222` (`if (a_f === 1) return +∞`) | `perfect_jury_all_depths_safe` |
| one bond witness ⇒ one challenger | `handlers.ts:166` `onAcceptChallenge` (`bondOwner` refusal at `:206–211`); `core.ts:564,633` (`challengeBondOwners`) | `one_hash_one_index`, `one_index_one_hash` |
| round bond fresh, ≠ membership, ≠ any accepted bond | `handlers.ts:668–681` (`roundBondProofHash === bondProofHash`, `membershipBond` lookup) | `round_bond_not_membership`, `round_bond_not_accepted` |
| round bond never consumed twice | `handlers.ts:686–690` (`consumed` refusal); `core.ts:438` (`seenRoundBonds`) | `round_bond_consumed_once`, `consumed_not_reused` |
| strict cases require the witness | `handlers.ts:660–665`; `core.ts:445–448` | `strict_case_has_round_bond` |
| membership witness = THIS challenger's accepted bond | `handlers.ts:632–641`; `core.ts:411` | `WellFormed.bound` (in `reachable_wellFormed`) |
| rounds consecutive `2..k` | `core.ts:371` (`round !== offset + 2`) | `rounds_consecutive`, `escalation_opens_next_round` |
| log length ≤ 5 | `handlers.ts:578–583`; `core.ts:333–337` | `log_length_bounded` |
| `roundIndex === ladderRound + 1` | `handlers.ts:606–610` (`expectedRound`) | `Step.escalate.nextRound`, `escalation_opens_next_round` |
| completeness + consumption re-derived before a rung is spent | `handlers.ts:590,599` (barrier at `onEscalate`) and `:275–276` (barrier at `onOpenLadderRound`) | `reachable_wellFormed` |
| wire `caseId` = the case the host routed on | `courtEscalationRequest.ts:811–824` | `invBinding` (Quint) |
| wire `challengerPubkey` = the authenticated pubkey | `courtEscalationRequest.ts:826–831` | `invBinding` (Quint) |
| wire `round` = the round being resolved | `courtEscalationRequest.ts:847–852` | `invBinding` (Quint) |
| ambiguous bond owner refused (`bonds.length > 1`) | `courtEscalationRequest.ts:889–894` | `bondUnique` + `invRungMembership` (Quint) |
| wire `bondTxid` = the accepted challenge's txid (**r9-2**, round 9) | `courtEscalationRequest.ts:905–911` | TS suite (+ `__tests__/mechanisedArtifacts.test.ts`); see item 8 |
| `roundIndex` derived from the CASE, never the wire | `courtEscalationRequest.ts:914–935` | `invRoundBound` (Quint) |

---

## 6. The transport, model-checked (Quint)

`proofs/mechanized/escalation.qnt` is an independent re-model of the wire path
`parse → map → reduce` plus the two ledger write transitions. It is a third
model (different language, different toolchain, written from the TS guards), in
the same spirit as `court.qnt`.

**Actions:** `doAcceptChallenge`, `doCloseWindow`, `doEscalate(idx, wire)`,
`doOpenRound(round)`, `doResolveRound`, `doConcede`.
**Predicates (one per TS layer):** `canParse` (`buildCourtEscalationRequest`'s
shape check), `canMap` (`escalationRequestToMachineEvent`'s r8-2 binding check —
three refusals: case id, authenticated pubkey, resolved round; the fourth,
`bondTxid`, landed in round 9 and is outside the Quint abstraction, see §8
item 8), `canReduce` (`onEscalate`'s witness checks, including `bondUnique` for
the r8-2 ambiguity refusal).

**Invariants** (checked on every state of every simulated trace, and by
Apalache where a JVM is present): `invPhase`, `invLadderRange`,
`invChallenges` (r38-1), `invBondConsumption` (INV-ESC-9 + r33-1),
`invStrict` (R42), **`invBinding`** (Theorem 7.4's first claim), 
**`invRoundBound`** and **`invRungRounds`** (`ladderRound + 1`, consecutive),
**`invSeatNeedsRung`** (r40-2), `invRungMembership` (INV-ESC-5), `invLogBound`.

**Hostile inputs, deliberately offered** (`escalationSim.WIRES`): a request for
a different case, a request claiming another juror's pubkey, a stale-round
request, a legacy request with no round bond, the membership bond relabelled as
this round's payment, another juror's membership bond as payment, and an
unaccepted bond. The simulation draws from that set, so a binding that leaked
would violate `invBinding` rather than pass silently.

**Scenarios** (16, `quint test`): happy path (escalate → open → ladderRound 2),
case mismatch refused, pubkey mismatch refused, stale round refused, re-used
round bond refused, membership-bond-as-round-bond refused, foreign membership
bond refused, unaccepted bond refused, rung-skip refused, seat-without-record
refused, ladder cap refused, duplicate challenge bond refused (r38-1),
concession always allowed, "parses but does not map" (a well-formed wire for the
wrong round), and the strict instance's legacy-refusal + fresh-witness-accept
pair.

**Run results** (`proofs/mechanized/quint-run.log`): typecheck clean; 42
`court.qnt` scenarios + 16 escalation scenarios passing; 4 seeded simulation
runs (`--seed 42`) with no invariant violation; Apalache exhaustive checking to
depth 10 (`court.qnt`) and 8 (`escalation.qnt`) where a JVM is available — the
committed log records which ran.

---

## 7. Why this is not just the tests again

A test is one path through a guard; these artifacts quantify over all paths (the
Lean theorems: over all `d`, all parameter values in the stated ranges, all
reachable ledger states) or over all states up to a depth bound (Apalache) /
10⁵·-scale random walks (the simulator). Concretely:

* the r33-6 defect was a *boundary* case that five tests passed and one grid
  measurement caught; `derivedCapZero_no_safe_depth` is the general statement;
* r40-2 was a *restored-snapshot* path that no live-path test reaches;
  `reachable_wellFormed` states that the barrier is a no-op for live histories
  and (by contrapositive) that only tampering can trip it;
* the r8-2 wire refusals were three separate `if` blocks; `invBinding` is one
  statement about the log's contents.

---

## 8. What is NOT mechanised (honest scope)

1. **The logarithm.** `flipRound` is not proved equal to
   `ceil(ln(ρ/(ρ+β))/ln a_f)`. Core Lean has no real logarithm; the gate does not
   need one (it compares signs), and the mechanised claim — safety is a segment
   with a first unsafe round — is precisely what makes the derived integer
   sufficient. Anyone who changes the gate to compare the BOUNDARY numerically
   re-opens this gap.
2. **Floating point — and the code↔model gap it DID expose, now closed (R52).**
   The mechanisation is exact rational arithmetic; the code used to evaluate
   `floor(ln(ρ/(ρ+β))/ln a_f)` in IEEE-754 doubles. That was not a one-ulp
   curiosity: at an EXACT-INTEGER boundary the `floor` named the break-even
   round, while the mechanised `derivedCap` is `flipRound − 1` and the theorem
   `safe_depth_bound` says break-even is NOT safe. Verified in round 46a at
   `a_f = ½, β = 3ρ` (plain floats): the exported cap was 2, `E[π](2) = 0`, and
   the GATE refused the very number it exported — report-vs-decision mismatch
   (H-2) for any host that trusted the number instead of re-deriving. **Fixed in
   R52:** the cap is now the predicate, evaluated in integers —
   `R·D^d < A^d·(R+B)` on the exact rational each parameter names
   (`0.03` → `3/100`) — identical at every boundary and everywhere else, so
   `deriveMaxLadderRounds = flipRound − 1` (clamped) is now a code↔model
   equality, not an approximation. What remains un-mechanised is only the
   rounding of `escalationOptionEv` (a float REPORTING function that no decision
   reads) and `ladderSignBoundary` (float telemetry: it can still overflow to
   `+∞` where the exact path answers correctly). Property-locked over a
   460-configuration grid in `__tests__/ladderBoundExact.test.ts` (independent
   exact-rational oracle, boundary table, and the `d = A·B` witness).
3. **The wire codec's canonicalisation.** UTF-8 injectivity of `caseId`
   (r8-1), the duplicate-key refusal (r8-4), the non-boolean `concession`
   refusal (r8-3), the singleton-read discipline (r8-5) and the v2 hash preimage
   are TESTED (`__tests__/reviewRound8.test.ts`, `escalationRequestWire.test.ts`),
   not proved. The Quint model abstracts `parse` to a domain check. Real SHA-256
   collision resistance is likewise assumed, not mechanised.
4. **The host's authentication.** `invBinding` says the log agrees with the
   binding — it does not say the binding is TRUE. That NIP-98 proved
   `authenticatedPubkey`, and that the host routed on the right `caseId`, are
   ASSUMPTIONS about the host, stated as such (the Quint state's
   `authenticated`/`boundCase` are inputs, not derived).
5. **Authority and attribution fields.** The `host`-authority arm of
   `onEscalate` (break-glass policy) and the `at` timestamp are not modelled in
   Lean; the reducer's `authority` matrix is covered by the TS suite
   (`perRoundBond.test.ts`, `escalationWitness.test.ts`). The Quint model has a
   single challenger authority.
6. **The rails.** That a `bondProofHash` names a real on-chain/L2 payment is the
   host's (and the rail's) check. Hashes in both models are abstract (`Nat` /
   `int`); injectivity is all the guards require.
7. **Liveness.** Nothing here says a case ever resolves; the theorems are
   safety statements (like Theorem 4). `concede` is modelled as always enabled
   but no theorem requires the challenger to use it.
8. **The `bondTxid` binding (r9-2, round 9).** Round 9 taught the mapper to
   compare the request's `bondTxid` with the accepted challenge's
   (`courtEscalationRequest.ts:905–911`) — the request hash commits to a txid the
   case must actually have bound. The Quint `Wire` type abstracts the txid away
   (hashes and ids are `int` literals there), so `invBinding` does not cover it;
   it is pinned by `__tests__/mechanisedArtifacts.test.ts` (the refusal is
   asserted) and by the round-9 TS suite. Widening the Quint wire to carry a
   txid is the obvious next step, and would be a mechanical change to
   `canMap` + one invariant conjunct.
9. **The unmodelled half of r30-1.** The per-round bond AMOUNT schedule
   (`escalationBondMultiple = 3^r`) is Theorem 2 of `02-ladder.tex.md`; the
   machine only enforces CONSUMPTION (one fresh witness per rung), which is what
   `EscalationLedger.lean` proves. A host that prices a rung below the schedule
   is outside these theorems.

---

## 9. Re-running

```bash
cd proofs/lean4 && ./run.sh                 # lake build + axiom audit → lean-run.log
cd proofs/mechanized && ./run.sh            # 58 scenarios + 4 sims + Apalache
```

Requirements: elan/Lean 4.14.0 (`proofs/lean4/lean-toolchain`); quint 0.33.1
(`npm i -g @informalsystems/quint@0.33.1`) and a JVM 21 for the Apalache steps
(skipped, with a note, when `java` is absent). Both scripts regenerate the
committed logs.
