# Theorem 3 — Tally well-definedness

**Module:** `courtVoteMachine.ts` (`tallyReveals` lines 811–834,
`compareOutcomeUtf8` 178–187, `hashCourtVerdict` 239–276); the confirmation
machine's round tally `tallyRoundVotes` is the same selection rule
(`confirmationMachineHandlers.ts:351–376`) and inherits the proof.
**Status:** proof complete. No lemma-gaps. Conditional on premises **E1**
(canonical UTF-8 outcomes) and **J1** (runtime semantics), both discharged at
protocol call sites.

---

## 1. Statement

Let R be a reveal ledger — a finite list of records
`(idx, outcome, salt, eventId)` admitted by the vote machine. Define the
**reveal multiset** ⟦R⟧ = the multiset of pairs `(outcome, eventId)` over
R's records (idx/salt are tally-irrelevant). Let

    n_o        = |{ (outcome, eventId) ∈ ⟦R⟧ : outcome = o }|          (count)
    ids(o)     = { eventId : (outcome, eventId) ∈ ⟦R⟧, outcome = o }    (id set)

and let ≤_U be the total order on outcome strings induced by
`compareOutcomeUtf8` (Lemma 3.1).

> **Theorem 3 (Tally well-definedness).** The vote machine's verdict —
> `(winner, supportingEventIds, verdictHash)` produced by
> `createCourtVoteMachine` → … → `finalize_tally` — is a well-defined
> function of ⟦R⟧ alone: if R and R′ are two ledgers with ⟦R⟧ = ⟦R′⟧
> (any order, any interleaving of the same ballots), then the machine emits
> the identical verdict triple. In particular the winner is the **unique**
> outcome w with
>
>     ∀ o: (n_w > n_o) ∨ (n_w = n_o ∧ w ≤_U o),
>
> i.e. maximum count, ties broken by *minimum* in unsigned UTF-8 byte order.

## 2. Premises

| # | Premise | Where enforced |
|---|---|---|
| **E1** | Every outcome string (allowlist entries and revealed outcomes) is **canonical UTF-8**: `UTF8⁻¹(UTF8(s)) = s`. This makes `s ↦ UTF8(s)` injective, so the byte-order total order of Lemma 3.1 descends to a total order on strings (antisymmetry on strings, not just on bytes). | Creation guard `courtVoteMachine.ts:487–509` (round-trip check at line 502, against `isCanonicalUtf8Text` `courtCeremonyCore.ts:64–70`); reveal acceptance checks the outcome against the frozen allowlist (`courtVoteMachine.ts:711–713`), so any admitted reveal outcome is a creation-admitted string. The comparator is only ever invoked on allowlist outcomes. |
| **J1** | Runtime semantics: `TextEncoder.encode` is deterministic WHATWG UTF-8; `Array.prototype.sort` is correct (its output is a sorted permutation of the input); `Map` iteration = insertion order (this order will be *eliminated* by the proof, not assumed away). | ECMAScript / WHATWG spec. |
| **(internal)** | Event ids admitted into the ledger are lowercase hex: `HEX_32 = /^[0-9a-f]{64}$/` at accept (`courtVoteMachine.ts:714–721`) and re-checked by the ledger barrier (`assertValidRevealLedger`, lines 396–405; run again at close/finalize, lines 773, 788). Hence the final `.toLowerCase()` (line 830) is the identity on admitted data and cannot merge two distinct ledger ids. | Line-checked. |
| **(internal)** | Event ids in the ledger are pairwise distinct (INV-VOTE-11: accept-time check lines 615–627 of the invariant doc; guard `adversarialMachines`-pinned; barrier re-check `courtVoteMachine.ts:411–413`). Hence the winner's id list, as a multiset, is a SET, and its sorted form is unique. | Line-checked. |

## 3. Lemma 3.1 — `compareOutcomeUtf8` is a strict total order

**Code (`courtVoteMachine.ts:178–187`).** For strings a, b with byte images
A = UTF8(a), B = UTF8(b): scan i = 0 … min(|A|,|B|)−1; return A[i] − B[i] at
the first differing byte; after the scan return |A| − |B|.

> **Lemma 3.1.** On the set of finite byte strings, define
> u ≺ v ⟺ [∃ i < min(|u|,|v|): u[j] = v[j] ∀ j < i ∧ u[i] < v[i]]
>        ∨ [u ⊏ v]  (proper byte prefix).
> Then ≺ is a strict total order (irreflexive, transitive, trichotomous), and
> `compareOutcomeUtf8(a, b)` equals the sign of (A ≺ B, A = B, B ≺ A). Under
> premise E1, a ↦ UTF8(a) is injective, so ≺ induces a strict total order on
> the admissible outcome strings; `cmp(a,b) = 0 ⟺ a = b`.

*Proof.*

**Trichotomy.** Given u ≠ v, let i be the first position where they differ
(scanf up to min(|u|,|v|)). If such i exists, exactly one of u[i] < v[i],
v[i] < u[i] holds (integers are trichotomous), giving exactly one of
u ≺ v, v ≺ u. If no differing position exists, then one of u, v is a prefix
of the other; since u ≠ v it is a *proper* prefix, and the shorter one ≺
the longer. Irreflexivity: no i with u[i] < u[i]; u ⊏ u is false.

**Transitivity.** Assume u ≺ v and v ≺ w; show u ≺ w.

- *Case A: u ⊏ v (u is a proper prefix of v).*
  - If v ⊏ w: then u ⊏ v ⊏ w, and |u| < |w|, so u ⊏ w ⟹ u ≺ w.
  - If v ≺ w at first difference j: v and w agree on [0, j).
    - If j ≤ |u|: u agrees with v everywhere on [0, |u|), and v agrees with w
      on [0, j) ⊇ [0, j] ∋ j when j < |u| … precisely: for all positions
      p < j, u[p] = v[p] = w[p]; at j ≤ |u| (j < |u| or j = |u|):
        - j < |u|: u[j] = v[j] < w[j] and u, w agree before j ⟹ u ≺ w at j.
        - j = |u| ≤ |v|: u ⊏ v means u[p] = v[p] for p < |u| = j; v[j] < w[j];
          u has no position j, so u agrees with w on [0, |u|) and
          |u| < |w| (w has position j) ⟹ u ⊏ w ⟹ u ≺ w.
    - If j > |u|: u agrees with v on all of [0, |u|), v agrees with w on
      [0, j) ⊇ [0, |u|), so u ⊑ w; and w has a position j > |u| − actually
      |u| < j ≤ |w| ⟹ |u| < |w| ⟹ u ⊏ w ⟹ u ≺ w.
- *Case B: u ≺ v at first difference i (u, v agree on [0, i), u[i] < v[i]).*
  - If v ⊏ w: v[p] = w[p] for all p < |v|; i < |v| (i is a position of v), so
    u[i] < v[i] = w[i], and for p < i: u[p] = v[p] = w[p] ⟹ u ≺ w at i.
  - If v ≺ w at first difference j:
    - j < i: for p < j, u[p] = v[p] = w[p]; u[j] = v[j] < w[j] (j < i means
      u, v agree at j) ⟹ u ≺ w at j.
    - j = i: u[i] < v[i] < w[i], agreement before i both pairs ⟹ u ≺ w at i.
    - j > i: v, w agree on [0, j) ⊇ [0, i], so w[i] = v[i] > u[i]; u, w agree
      on [0, i) (both agree with v there) ⟹ u ≺ w at i.

All subcases close; ≺ is transitive. With irreflexivity + trichotomy + transitivity,
≺ is a strict total order. (This is the standard lexicographic-order theorem
for sequences over a totally ordered alphabet, with the prefix rule as the
shorter-string case; the case analysis above is included for completeness.)

**The code computes the sign of ≺.** If a differing byte exists at the first
difference i, the loop returns A[i] − B[i], whose sign is exactly the truth
value of A[i] < B[i] vs >; the agreement prefix in the code matches ≺'s
definition (lines 181–185). If no difference exists in the common prefix, the
code returns |A| − |B| (line 186), whose sign is the prefix case of ≺.

**Descent to strings.** cmp(a,b) = 0 ⟹ |A| = |B| and no differing byte ⟹
A = B ⟹ (premise E1: UTF8 injective on admissible outcomes) a = b. Trichotomy
and transitivity descend through the injective map. ∎ Lemma 3.1

> **Remark (UTF-8 byte order ≠ UTF-16 code-unit order).** JavaScript's default
> string comparison (`<`, `Array.sort` on strings) compares UTF-16 code units,
> which disagrees with UTF-8 byte order on supplementary-plane characters
> (e.g. U+FFFD `EF BF BD` vs U+1F600 `F0 90 80 80`). The protocol deliberately
> uses byte order — the canonical serialization order — and the divergence is
> pinned by a test with a supplementary-plane pair
> (`courtVoteMachine.test.ts` › 'breaks ties by canonical UTF-8 byte order,
> not UTF-16 code units'; oracle sweep in `invariantAssertions.test.ts`,
> INV-X-9: `compareOutcomeUtf8` ≡ `Buffer.compare(UTF8(a), UTF8(b))` over 500
> randomized unicode pairs).

## 4. Proof of the Theorem

Throughout, fix the machine's frozen configuration (sessionHash, roster,
allowlist, deadlines — identical for R and R′ since both live in the same
machine's reachable history; the tally consumes only `state.reveals` and the
frozen fields, lines 811–834, 789–802).

**Step 1 (counts are multiset functions — commutative monoid).** Let
Out(R) = set of outcomes occurring in ⟦R⟧. The imperative accumulation
(lines 812–817) starts from the empty map and, for each record in list order,
appends its eventId to the list keyed by its outcome. After processing a
prefix S of the ledger, the map satisfies

    counts_S(o) = [ eventId : (outcome, eventId) ∈ ⟦S⟧, outcome = o ]  (in first-occurrence order)

by a trivial induction on |S| (each record contributes exactly one append to
exactly its own outcome's list; nothing else mutates the map). Consequently,
for the full ledger, `counts_R(o)` and `counts_R′(o)` are two orderings of
the same multiset of event ids — ⟦R⟧ = ⟦R′⟧ by hypothesis. The downstream
consumers of `counts` use **only** order-insensitive data:

- `eventIds.length` in the selection loop (lines 822–823) — a multiset
  cardinality, n_o, identical for R and R′. (Formally: the counting monoid is
  (ℕ^Outcomes, +, 0), pointwise addition of count vectors — commutative and
  associative — so ANY aggregation order of the same multiset yields the same
  vector (n_o); the imperative fold computes exactly this vector by the
  induction above.)
- the winner's list, canonicalized in Step 3.

**Step 2 (winner selection is order-independent — unique extremum).** The
selection loop (lines 818–828) folds over `counts.entries()` in insertion
order, maintaining `(winner, winnerCount)` and replacing iff

    better(o, c, w, cw) ⟺ c > cw ∨ (c = cw ∧ compareOutcomeUtf8(o, w) < 0).

Define the target: w* = the unique outcome satisfying (∗) of §1.

- *Existence.* The ledger is non-empty at `finalize_tally` (checked at lines
  789–791 before `tallyReveals` is called, line 792), so Out(R) ≠ ∅ and
  finite. Among the outcomes with maximal count (a non-empty finite set),
  Lemma 3.1's total order has a unique minimum (finite totally ordered sets
  have unique minima). Set w* to it: for every o, either n_o < n_w* (maximality)
  or n_o = n_w* and o ∉ … precisely, for o with n_o = n_w*, minimality gives
  w* ≤_U o. So w* satisfies (∗).
- *Uniqueness.* If w and w′ both satisfy (∗), then n_w = n_w′ (each bounds the
  other: n_w ≥ n_w′ and n_w′ ≥ n_w) and w ≤_U w′ and w′ ≤_U w, so w = w′ by
  antisymmetry (Lemma 3.1 + E1).
- *The fold computes w* regardless of entry order.* Claim by induction on the
  enumeration: after processing any set S of entries (in any order), the fold
  state is the unique (∗)-extremum over the sub-multiset S. Base: S = ∅ —
  state is `('', −1)`; for the first entry (o, n_o ≥ 1 > −1 = winnerCount)
  the replacement fires, giving (o, n_o), the extremum of a singleton. Step:
  let (w_S, c_S) be the extremum over S and add entry (o, n_o).
  - If n_o > c_S: o beats every element of S on count, so (o, n_o) is the
    extremum of S ∪ {o}; the fold replaces (condition line 822). ✓
  - If n_o = c_S: the extremum of S ∪ {o} is min_U(w_S, o); the fold replaces
    iff `compareOutcomeUtf8(o, w_S) < 0` (line 823) — exactly min-selection
    under the total order; if it keeps w_S it is because w_S ≤_U o, and w_S
    remains the extremum. ✓
  - If n_o < c_S: o cannot be the extremum (some s ∈ S beats it on count,
    satisfying (∗) against o); the fold keeps w_S. ✓
  Since ⟦R⟧ = ⟦R′⟧ gives the same entry SET (o, n_o) — Step 1 — and the fold
  result is order-independent by the claim, both ledgers yield
  winner = w*, winnerCount = n_w*. ∎ (Step 2)

**Step 3 (supporting ids are a function of the multiset).** The winner's id
list (line 829) is, by Step 1's invariant, an enumeration of
ids(w*) = { eventId : (w*, eventId) ∈ ⟦R⟧ } = same set for R′. The code maps
`toLowerCase` (identity on admitted lowercase-hex ids — §2 internal premise,
re-checked by the barrier INV-VOTE-15) and sorts (lines 830–832) with the
default string comparator. For 64-char lowercase-hex ids every character is
ASCII (< 0x80), where UTF-16 code-unit order, code-point order, and UTF-8
byte order coincide — so the comparator agrees with the total order of
Lemma 3.1 restricted to id strings. The ids are pairwise distinct (§2 internal
premise), so the sorted list is the *unique* non-decreasing permutation of a
finite totally-ordered set of distinct elements — a canonical form of the
set, independent of the enumeration order. Hence
supportingEventIds(R) = supportingEventIds(R′). ∎ (Step 3)

**Step 4 (verdict hash is a function of the triple).** `verdictHash` is
computed by `hashCourtVerdict({sessionHash, outcome: winner, supportingEventIds})`
(lines 796–800) — a pure, deterministic function: input validation, then
CanonicalWriter encoding (Theorem 1: the encoding is a function of the tuple,
CW-3 determinism; and injective under E1/E2), then SHA-256 (deterministic,
J1). Same (sessionHash, winner, sorted ids) ⟹ same verdictHash. And
`sessionHash` is a frozen configuration field, identical in both runs. ∎
(Step 4)

∎ Theorem 3.

## 5. Corollaries and scope

> **Corollary 5.1 (Verdict support conservation, INV-VOTE-17).** The verdict's
> `supportingEventIds` is exactly the sorted set of reveal event ids voting
> for the winner — non-empty because winnerCount = n_w* ≥ 1 (non-empty
> ledger). Line-checked at lines 829–832.

> **Corollary 5.2 (Dispute-verdict commitment order independence,
> INV-VOTE-19).** `hashDisputeVerdict` (lines 302–341) sorts its supporting
> ids before hashing (line 335), so the kind-39007 commitment is a function
> of the *set* of supporting ids by the same canonical-form argument
> (Step 3).

> **Corollary 5.3 (Confirmation-machine round tally).** `tallyRoundVotes`
> (`confirmationMachineHandlers.ts:351–376`) is the identical
> count/compare fold over the mass-vote ledger; its `upheld ⟺ winner =
> proposedOutcome` (line 374) is then likewise a function of the vote
> multiset. Its ledger is barrier-verified before use
> (`assertValidMassVoteLedger`, called at `close_ladder_round` and
> `resolve_round`).

> **Remark 5.4 (What is NOT claimed).** (i) Well-definedness is relative to
> the ledger the machine actually holds; the theorem assumes the ledger is
> the one the machine admits (INV-VOTE-8/11/12/13 — one commit/reveal per
> idx, reveal ⊨ commit, ballot closure), re-verified by the barriers at
> close/finalize (lines 773, 788). A tampered ledger outside the admission
> language is rejected, not tallied. (ii) The map from *voters' intentions*
> to ⟦R⟧ (who voted what) is a protocol/liveness question, outside this
> theorem; the commit-reveal binding (INV-VOTE-12) is what makes ⟦R⟧
> non-malleable per participant. (iii) The winner is a function of the
> multiset including eventId pairing — relevant only for the supporting-id
> list, never for the winner itself, which depends on counts alone.

## 6. Executable evidence

| Property | Where |
|---|---|
| Exhaustive order-independence: 3ⁿ ballot assignments for n = 1..4 (120 machines), identical winners/ids/hashes under a reduce-based reference tally | PR #52 differential suite, `__tests__/differentialParity.test.ts` (refTally) |
| Big random tallies (10 × 300 jurors, unicode outcome pool): identical results | PR #52 |
| Reveals/commits reordered → identical verdict | `adversarialMachines.test.ts` › 'reveals reordered (and commits reordered) produce the identical verdict' (INV-VOTE-20) |
| Tie-break correctness + UTF-16 divergence pinned | `courtVoteMachine.test.ts` › 'breaks ties deterministically…'; '…canonical UTF-8 byte order, not UTF-16 code units' |
| Comparator oracle: ≡ Buffer.compare over 500 randomized unicode pairs | `invariantAssertions.test.ts` › comparator oracle sweep (INV-X-9) |
| Non-empty finalize guard | `courtVoteMachine.test.ts` › finalize-without-reveals rejection; model-check P2 'verdict ⇔ phase coherence' |

## 7. How to check this proof (≈ 25 minutes)

1. Read `tallyReveals` (`courtVoteMachine.ts:811–834`) and confirm the fold
   semantics used in Step 2 (strictly-greater replaces; equal-count replaces
   iff cmp < 0).
2. Read `compareOutcomeUtf8` (178–187) and check it against Lemma 3.1's ≺.
3. Check the transitivity case analysis in Lemma 3.1 (the six subcases).
4. Check the premises: outcome round-trip at creation (487–509), HEX_32 ids
   at accept (714–721) and barrier (396–413), non-empty finalize (789–791).
5. Run `npx vitest run __tests__/differentialParity.test.ts
   __tests__/adversarialMachines.test.ts __tests__/invariantAssertions.test.ts`.
