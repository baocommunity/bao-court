# Review Round 6 — attacking the round-5 and round-37 fixes (v0.13.1)

**Date:** 2026-11-11 · **Base:** `origin/main` @ `57f61f5` (#108, post-r37-1) ·
**Branch:** `docs/review-round-6` · **Scope:** the four closures the last two
rounds shipped — the **one-hash-one-index** rule (r38-1: `accept_challenge`
uniqueness + the challenge-ledger barrier), the **complete escalation ledger**
plus its barriers (r33-5 + r37-1, which taught the round bound about the
`ladder_pending` half-step), the **sign-based derived bound** (r33-6) as consumed
by the host's new creation gate (R39), and the docs that describe them.

**Method.** Unchanged, because it keeps working: the reducer is the adversary's
API (a hostile host speaks it directly *and* hands back tampered snapshots), the
pure helpers are called with hostile parameters, and every claim in the docs is
re-derived from the code rather than quoted. A finding is one of:

- **EXPLOITABLE** — a test in this repository shows the harm through the shipped
  interfaces; fixed here;
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited.

Every residual gets a **disposition** (fixed here / documented + pinned / host
fix with an owner and a trigger / deferred to a named version). Nothing is left
as a bare "registered".

**What was executed**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound6.test.ts` (**new**, 23 tests) | **23 passed** |
| the same file with `confirmationMachineHandlers.ts` restored from `origin/main` | **6 failed** — both r40 closures and the doc pin are real, not asserted after the fact |
| the **legal-state hunt** (5 × 2 × 2 × 2 × authority × bond-shape walk, §2.1) | **0** barrier refusals of reducer-reachable states |
| `npm test` (full suite) | **1,739 passed / 1 skipped (78 files + 1 skipped)** — §6 |
| `npm run typecheck` · `npm run typecheck:tests` | clean / clean |
| host probe (`bao.markets` @ `867beb6ad`, R39 in) | §3 — the gate exists; **one bypass** and **one predicate divergence** below |

**Verdict summary.** 2 EXPLOITABLE (**both fixed here**, both the same shape: the
one-hash-one-index rule and the complete-ledger rule were re-derived at *some*
entries but not at the two that **spend a rung**) · 1 PARTIAL in this package
(uniqueness ≠ ownership: the hash is unique but preemptable — r40-3, host
verifier + v0.14) · 2 PARTIAL at the host (the boot backfill/freeze path bypasses
the R39 gate, r40-5; the gate's composed predicate is not the sign rule, r40-4) ·
the rest BLOCKED with pins.

The headline is an asymmetry, not a new idea. Round 5 closed "one bond witness
bought two challengers' standing" at the reducer and at the *restore*; round 37
taught the round bound about `ladder_pending`. **But `escalate` ran only the *log*
barrier — not the challenge-ledger barrier that makes the log's witness test
meaningful — and `open_ladder_round`, the transition that actually spends the
seat, ran no barrier at all.** So on a restored snapshot both round-5 harms were
still reachable one entry later, and both ended in a bricked case after a real
panel had been summoned.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | one-hash-one-index | a restored ledger that binds one hash to **two** indices satisfies the `(idx, bondProofHash)` test at `escalate` | **EXPLOITABLE → fixed** (r40-1) |
| T1 | one-hash-one-index | same tampered ledger, restored **straight to `ladder_pending`** (escalate skipped) | **EXPLOITABLE → fixed** (r40-1, second entry) |
| T1 | one-hash-one-index | is the barrier at **every** entry that reads the pool? | **NO → fixed** (5 readers now covered; the 3 non-readers stated) |
| T1 | one-hash-one-index | one paid bond buys N challengers' standing (r38-1 re-attack) | **BLOCKED** — reducer + barrier |
| T1 | one-hash-one-index | the hash is unique but **not owned**: a non-owner registers a derivable witness first | **PARTIAL → registered r40-3** (host verifier + v0.14) |
| T1 | one-hash-one-index | cross-case reuse: refused, or correct by construction? | **BLOCKED (correct)** — the pool is per case by design, documented |
| T2 | complete ledger | a restored `ladder_pending` with the record **deleted** opens the rung (bond un-consumed, panel seated, case bricked) | **EXPLOITABLE → fixed** (r40-2) |
| T2 | complete ledger | does a legitimate **no-challenge** flow now get refused? (empty log at finalize) | **BLOCKED** — 20/20 policy combinations finalize |
| T2 | complete ledger | **legal-state hunt**: which phase × log shapes does the barrier refuse? | **BLOCKED** — 0 of the enumerated legal states (§2.1) |
| T2 | complete ledger | order / duplicates / gaps / foreign challenger (r33-5 re-attack) | **BLOCKED** (re-pinned) |
| T2 | complete ledger | a **legacy** log emptied at `ladder_pending` | **PARTIAL (unchanged)** — documented + pinned, scoped to `requireRoundBond: false` |
| T3 | derived bound | is there any `a_f` **default** in this package? | **BLOCKED** — none; the host's 0.85 is a declaration |
| T3 | derived bound | can a consumer composing `cap <= derivedCap` diverge from the sign rule? | **PARTIAL → host r40-4** (unreachable at ρ=β, reachable at β≠ρ) |
| T3 | derived bound | does the R39 creation gate cover **every** write path? | **NO → host r40-5** (boot backfill + NULL fallback) |
| T3 | derived bound | `derivedCap = 0` propagation | **BLOCKED** — re-pinned across the grid |
| T4 | the docs | do REVIEW_ROUND_5 / READINESS / PER_ROUND_BOND describe the shipped code? | **PARTIAL → fixed here** (3 doc corrections, r40-6) |

---

## 1. T1 — one-hash-one-index (r38-1), attacked

### 1.1 r40-1 — `escalate` re-derived the log but not the pool the log reads (EXPLOITABLE, fixed)

**Attack.** Round 5 made `accept_challenge` bind one `bondProofHash` to one roster
index and taught `assertValidConfirmationLedger` the same rule, on the premise
that "the membership pool the r33-1 rule reads must be unique". `onEscalate` runs
`assertValidEscalationLog` before a rung opens — but that barrier re-derives the
*log*, and only **reads** the challenge pool through the r29-1 witness test:

```ts
if (!state.challenges.some(c => c.idx === challengerIdx && c.bondProofHash === bondProofHash)) throw …
```

`assertValidConfirmationLedger` — the barrier that would refuse the duplicate —
was **not** called at `escalate`. A restored snapshot is not re-validated by the
reducer (there is no global restore hook; each handler opts in), so:

1. rest a legal `round_resolved` snapshot, append a second challenge record for
   juror 3 carrying juror 2's `bondProofHash` (the r38-1 shape);
2. escalate as juror 3 — `some(c => c.idx === 3 && c.bondProofHash === M2)` is
   **true**, so the rung opens and `escalationLog[0]` names juror 3 as the payer
   of a bond juror 2 owns;
3. `open_ladder_round` seats the round panel; `resolve_round` then throws from
   the ledger barrier, so the case can only brick **after** the panel was
   summoned.

This is r38-1's exact harm ("one payment, unlimited standing") surviving one
entry later, plus a new DoS: the case can never finalize on that ledger. The
argument r33-5 used for the log barrier — *"waiting until finalize lets a free
rung be opened (and its panel seated) … and then bricks the case at finalize"* —
applies verbatim one barrier over.

**Repro.** `reviewRound6.test.ts` › *'(r40-1) escalate REFUSES a restored ledger
that binds one hash to two participants'*, *'… the refusal lands BEFORE a seat is
spent — the case is untouched'*. Both fail on #108 and pass here (measured: 6
red on the restored pre-fix handlers, §6).

**Fix (shipped).** `onEscalate` runs the challenge-ledger barrier immediately
after the log barrier — the witness test's own premise, re-derived where the
witness is used:

```ts
assertValidEscalationLog(state);
assertValidConfirmationLedger(state);   // r40-1: the pool the test below reads
```

### 1.2 r40-1 (second entry) — `open_ladder_round` ran no barrier at all (EXPLOITABLE, fixed)

Same ledger, but the host restores **straight to `ladder_pending`** (a legal
phase, and the one r37-1 was just taught to accept): escalate is skipped
entirely, so the barrier added in §1.1 never runs. `onOpenLadderRound` validated
the round number, the cap, the deadline and the roster — and nothing else.

**Repro.** *'(r40-1) open_ladder_round refuses the same ledger when escalate was
skipped'* — refused here, accepted on #108.

**Fix (shipped).** `onOpenLadderRound` runs **both** barriers before it can seat
a panel. It is the rung-spend transition, so it is the last place the state can
be checked before venue cost is committed:

```ts
assertValidEscalationLog(state);
assertValidConfirmationLedger(state);
```

**The entry matrix** (the brief's "does the barrier apply at EVERY entry"),
pinned test by test in *'the barrier runs at EVERY entry that READS the challenge
pool'*:

| entry | reads the pool? | barrier | pin |
|---|---|---|---|
| `accept_challenge` | yes (live uniqueness) | own rule (reducer) | r38-1, re-pinned |
| `escalate` | yes (witness test) | log **+ ledger** | **new (r40-1)** |
| `open_ladder_round` | yes (via the log) | log **+ ledger** | **new (r40-1)** |
| `close_ladder_round` | no (mass-vote ledger only) | — | stated, not faked |
| `resolve_round` | yes (clawback attribution) | ledger + history + votes | r38-1 (round 5) |
| `concede` | no | — | stated |
| `flag_clawback` | no | — | stated |
| `finalize` | yes (verdict evidence) | ledger + history + log | r29-2 / r38-1 |

The three non-readers are **stated** rather than given a fake assertion: each is
followed by a pool-reading barrier (`resolve_round` or `finalize`) before any
value is locked in, so the pool cannot be laundered through one of them.

### 1.3 r40-3 — the hash is unique but not **owned** (PARTIAL → registered)

**Attack.** r38-1's consumer note says a host whose witness derivation *collides*
across jurors (e.g. `hash(bondTxid)`, which a batch payout shares) must mix the
juror index in. That describes an accident. The real property is sharper:
**a derivable witness is preemptable.** `hash(bondTxid)` is computable by anyone
the moment the bond is on chain, and the uniqueness rule is first-come-first-
served, so a juror that owns no bond can register the payer's hash under its own
index and lock the payer **out** of the case:

```
attacker idx 3: accept_challenge { bondTxid: payerTxid, bondProofHash: H }   → accepted
payer   idx 2: accept_challenge { bondTxid: payerTxid, bondProofHash: H }   → REFUSED
```

Measured (*'(registered r40-3) the hash is unique but NOT OWNED…'*): the attacker
holds the only challenge record and therefore the only escalation right on a bond
it never paid; the payer is refused with «already bound to participant 3».

**Severity.** Not worse than r38-1 in cost — one payment still buys one standing
— but it is a *new* availability loss: before round 5 both records were accepted
and the payer could still escalate. And the standing is stolen, not merely
duplicated.

**Why the machine cannot close it.** `CourtConfirmationMachineState` carries
`participantIndices` and no idx→pubkey registry, and `accept_challenge` records
no key, so the machine cannot tell the owner from the copier — the same
structural limit as r33-2/r38-3, and the shipped host verifier is
`formatOnlyBondVerifier` (`HEX32.test` twice), which cannot either.

**Disposition (two parts, both named):**

| step | owner | trigger |
|---|---|---|
| the host's bond verifier MUST bind the witness to the **event author** (the bond UTXO's owner key == the submitting juror's key) — a rail-backed verifier that only proves "a bond exists at this hash" is insufficient | host court escalation service (the r33-2/r33-3 registry work already assigned) | **before** arming real bonds on any deployment |
| `accept_challenge` gains the challenger's x-only pubkey, making `(idx, pubkey)` a state binding the barrier can re-derive | this package, **v0.14** (registered as r38-3 / r29-5; the same snapshot-format change closes both) | first deployment needing index-only witnesses |

Pinned so the gap is not mistaken for a verified field, and the `bondProofHash`
docstring now says **preemptable**, not just "may collide".

### 1.4 Cross-case reuse — refused, or correct by construction? (BLOCKED, semantics documented)

The brief asks whether the same bond hash legitimately appearing across cases is
refused, and whether refusing it would be over-strict. **It is accepted**, and
that is correct at this layer:

- the binding is `(bondProofHash) → one roster index **per case**`; the registry
  is `state.challenges`, which is the case's ledger. Two independent cases are
  two independent registries, and `assertValidConfirmationLedger` accepts the same
  hash in both (pinned: *'cross-case reuse is ACCEPTED by design'*);
- the **intended semantics**, now stated in one place: *one bond witness buys one
  challenger's standing in one case; a juror holds at most one challenge per case
  (one record per idx); the same bond may be cited by a different case, and
  closing that is the host's global registry (r33-3)*. A machine-level cross-case
  ledger does not exist and would be over-strict to fake — `state` is the whole
  world this machine can see;
- within one case, one juror cannot hold two challenges (conflicting-challenge
  refusal, INV-CONF-17), so "one bond serving one case at a time" is exact.

### 1.5 The collision case, attacked (BLOCKED as a *state* question, resolved in §1.3)

Two jurors presenting the **same** hash is refused whether their `bondTxid`s match
(a batch payout, the documented shape) or differ (a forged relabel) — pinned twice
('the collision shape (hash(bondTxid) over a batch) is refused, not silently
merged', and the reducer's own refusal). The *exploitable* half of the collision
is not the duplicate record; it is preemption (§1.3), which the "mix the juror
index in" mitigation also fixes — because a per-juror witness is not derivable by
another party.

---

## 2. T2 — the complete ledger, and the over-strictness hunt

### 2.1 THE LEGAL-STATE HUNT (the r37-1 class, enumerated) — 0 refusals

The r37-1 lesson is that a barrier which refuses a state the reducer can reach is
a **defect in the barrier**, not in the caller. So this round replaced judgement
with an enumeration: walk every legal flow and hammer both barriers on **every
state the reducer produces**.

Axes: `maxLadderRounds` 1…5 × `requireRoundBond` × `hostEscalation` ×
never-challenged/challenged × authority (`challenger`|`host`) × round-bond shape
(absent|fresh) × terminal move (`escalate` | `concede`→`finalize`). **490 states**,
each checked with `assertValidEscalationLog` **and**
`assertValidConfirmationLedger`.

| phase reached | legal log shape (measured) | barrier |
|---|---|---|
| `confirm_open`, `confirm_closed` | `ladderRound 0`, log `[]` | accept |
| `challenge_window` | `ladderRound 0`, log `[]` | accept |
| `ladder_pending` (first, no escalation yet) | `ladderRound 0`, log `[]` | accept |
| `ladder_pending` (after `escalate`) | `ladderRound k`, log **`k`** records (rounds `2..k+1`) | accept |
| `ladder_vote_open` / `ladder_vote_closed` | `ladderRound k`, log **`k−1`** records (`2..k`) | accept |
| `round_resolved` | `ladderRound k`, log `k−1` | accept |
| `fee_settlement` (from `resolve_round` at the cap) | `ladderRound k`, log `k−1` | accept |
| `fee_settlement` (from `concede` at round k) | `ladderRound k`, log `k−1` | accept |
| `fee_settlement` (never challenged) | `ladderRound 0`, log `[]`, all policies | accept |
| `final` | as its predecessor | accept |

**Result: 0 refusals.** Every rung-spending transition that was refused in the
walk is a *documented policy* refusal (host authority without `hostEscalation`;
a strict case without a round-bond witness; a host escalation carrying a
challenger witness) — the test asserts that every refusal message matches one of
those three, so a future barrier refusal cannot hide in the walk. Every phase in
the graph is asserted visited, so the hunt cannot silently shrink.

**The `ladder_pending` offset is the one that matters**, and it is now pinned as a
table (definition: *one record per **opened** round — `ladderRound − 1`, or
`ladderRound` while a rung is pending* — verified against the lifecycle, and ±1
record on an otherwise legal snapshot is refused in both directions).

### 2.2 r40-2 — a deleted record at `ladder_pending` still opened the rung (EXPLOITABLE, fixed)

§1.2's second entry, seen from the log's side. Restore a legal `ladder_pending`
snapshot with `escalationLog: []` (the bond that paid for the rung is now
un-consumed), then `open_ladder_round`: **accepted** on #108. The panel is seated,
the bond is spendable again, and the case can only brick at `resolve_round`
(completeness) — the exact harm r33-5 was written for, at the one transition
r33-5 missed.

**Repro.** *'(r40-2) a strict log EMPTIED at ladder_pending is refused at
open_ladder_round'* — refused here («escalation log is incomplete: 0 record(s)
for 1 opened round(s)»), accepted on #108.

**Fix.** Covered by §1.2's `assertValidEscalationLog(state)` at
`onOpenLadderRound`; the test also re-pins r37-1 (a **legal** pending snapshot
passes every barrier) so the fix cannot regress into the bug round 37 fixed.

### 2.3 The no-challenge path — could a legitimate flow now be REJECTED? (BLOCKED, 20 combinations)

The brief's specific worry: a case that **concedes without ever opening a round**
has `ladderRound 0` and an empty log, while the rule reads "one record per opened
round". Measured across all 20 combinations (`maxLadderRounds` 1…5 × strict ×
host): `close_challenge_window` → `fee_settlement` with `ladderRound 0`, log `[]`,
`assertValidEscalationLog` clean, `finalize` → `final` with `upheld: true` and
`|supportingEventIds| = |roster|` (the confirmation ledger). **No empty-log
refusal exists**, because `expectedRecords = max(0, ladderRound − 1)` and the
`log.length > 0 || requireRoundBond === true` guard is what makes an emptied log
fatal **only** when the case records escalations. Pinned
(*'the no-challenge path finalizes under EVERY policy'*).

### 2.4 The ledger's other attacks (BLOCKED, re-pinned)

Order (`[3,2]`), duplicate (`[2,2]`), gap (`[2,4]`), a challenger that is not on
the roster, a `(idx, hash)` pair no accepted challenge carries, a dropped **last**
record at `round_resolved` (refused at `escalate`), and the +1-record direction
(refused by completeness or by the `2..k` sequence) — all refused. Two notes that
matter for the docs:

- the `round > openedRounds` bound is **redundant** with completeness: a
  consecutive `2..k` log has length `k−1`, and completeness pins the length to the
  opened count, so the bound can only ever be a belt. That is *why* r37-1's
  off-by-one was harmless on shipped paths and fatal on the documented restore
  path — pinned as such rather than fixed twice.
- `close_ladder_round` does not read the log or the challenge pool (it validates
  the mass-vote ledger). Not a gap: `resolve_round` and `finalize` both do before
  any value is locked in.

### 2.5 Legacy cases keep the deletion residual, scoped (PARTIAL, unchanged)

A **legacy** case (`requireRoundBond` absent/false) restored with an emptied log
at `ladder_pending` still opens the rung — indistinguishable from a pre-0.12
snapshot, which must stay finalizable (round 3's target 1.5). **Disposition:
documented + pinned, unchanged (r33-5 residual); the strict policy is the answer,
and r33-4's default flip is the owner decision that activates it** — the shipped
host now defaults it on (R39, §3.2), which is that decision being taken.

---

## 3. T3 — `deriveLadderFlipRound` / `derivedCap` and their consumers

### 3.1 No `a_f` default anywhere in this package (BLOCKED)

`assertLadderParameters` refuses `undefined`, an object without `a_f`, `0`,
negatives, `NaN`, `Infinity`, `> 1` and strings for all three derivations
(pinned). So the package cannot silently disagree with a host: `a_f = 0.85` is
the **host's declaration** (R39), never a package default. The shipped pair for
that declaration is `derivedCap 4 / flipRound 5`, pinned.

### 3.2 r40-4 — a consumer composing the two integers is not the sign rule (PARTIAL → host)

The package's verdict is sign-based (`ok = cap < flipRound`, r33-6). The R39 host
gate re-composes it as `ok = derivedCap >= 1 && cap <= derivedCap`. The two agree
**iff** `flipRound = derivedCap + 1`, i.e. unless the sign boundary is an exact
integer.

- **At the host's own constants (ρ = β = 0.03) it is unreachable.** Probe: 2 000
  ULPs either side of `0.5^(1/k)` for k = 2…7 — **no representable `a_f` yields an
  integral boundary** (pinned). So the divergence is not live today.
- **It becomes reachable the moment β stops being ρ** — which is the direction the
  host must eventually move (the escrow's real bond is 5 %, and the gate's own
  comment says ρ = β = 3 % was chosen as the *conservative* stand-in). Measured:
  `a_f = 0.5, ρ = 0.03, β = 0.09` ⇒ boundary exactly `2`, `derivedCap = 2`,
  `flipRound = 2`; the package says `ok(2) = false` and `E[π(2)] = 0` **exactly**,
  while a composed `cap <= derivedCap` says `true`.

**Disposition: host fix (one import), owner the host court creation gate, trigger
the moment β becomes configurable or a measured bond is used.** The refusal is
`E[π] ≥ 0` — a break-even rung is a *free option*, not a deterrent — so the
sign-based predicate is the correct one and the composed form must be retired
rather than patched.

### 3.3 r40-5 — the R39 gate is bypassed by the boot backfill and the NULL fallback (PARTIAL → host)

The gate enforces the bound on the **two creation writers** (`POST
/markets/create`, `POST /admin/markets`) — the admin route is covered, which is
the brief's first question. It is not covered on the two paths that write the
same column afterwards:

1. **`auditFrozenCourtLadders` (boot audit)** writes
   `resolveCourtCohortConfig(env).{round0Panel,maxLadderRounds}` into every court
   market whose `court_max_ladder_rounds` is NULL — with **no**
   `assessLadderDepthBound` call (`CourtLadderFreeze.ts`, the backfill `UPDATE`).
   `resolveCourtCohortConfig` clamps only to the panel-growth ceiling
   (`round0·3^R ≤ 405`); nothing economic enters it.
2. **`readFrozenCourtLadderForMarket`** falls back to the same unbounded config
   for a NULL row and flags it, so a case can escalate on it before any backfill.

So a deployment that sets `BAO_COURT_MAX_LADDER_ROUNDS=5` — the exact value
creation now refuses (cap 4 at `a_f = 0.85`) — has its legacy rows **frozen at
5** by the audit at the next boot, and cases then run the profitable rounds the
gate exists to prevent. The boot audit *does* print the refusal-shaped message
(«NEW markets are refused with 422 … existing markets keep their frozen depth»),
which states the intent — but "keep their frozen depth" is only true for rows
that already had one.

**Disposition: host fix, owner the ladder-freeze/backfill path, trigger the next
deploy that arms per-round bonds or changes `BAO_COURT_MAX_LADDER_ROUNDS`.** The
fix is the same call the writers already make: assess `cohort.maxLadderRounds`
before the backfill `UPDATE` and before returning the NULL fallback — refuse the
backfill (leave the row NULL and warn loudly) rather than freeze an unblessed
depth, because freezing is a promise the gate would refuse to make.

### 3.4 `derivedCap = 0` (BLOCKED, re-pinned)

At `a_f ∈ {0.3, 0.4, 0.45, 0.5}`, `derivedCap = 0`, and `ok` is false for every
legal cap 1…5; the grid also re-asserts the contract `ok ⇒ E[π(cap)] < 0` at
`a_f = 0.85` (the only accuracy with margin). The host gate's `derivedCap >= 1`
conjunct is what makes 0 mean "refuse every ladder" there — correct on both
sides.

---

## 4. T4 — do the round-5 docs describe the SHIPPED behaviour?

Three corrections, all fixed here (r40-6). The r37-1 fix postdates both round-5
documents, so this is exactly the drift the brief predicted.

| claim | where | was it true? | action |
|---|---|---|---|
| "`assertValidEscalationLog` — the barrier `finalize` re-runs **and** `escalate` now re-runs before a rung opens" | `PER_ROUND_BOND.md` | **incomplete** — `open_ladder_round` is the third caller (and the one that spends the seat) | rewritten to name all three, plus the challenge-ledger half |
| "`escalate` re-runs that barrier; every attack the brief names is pinned" | `REVIEW_ROUND_5.md` §2.4 | true **as of #107**, superseded by r37-1 (#108) and r40-1 (here) | post-publication note added (history kept, supersession named) |
| the reducer rule list (1…5) | `PER_ROUND_BOND.md` | **missing** the r33-1/r38-1 pool-uniqueness precondition that r40-1 now re-derives at the entry | rule 6 added |
| "a restored snapshot cannot re-open the option by editing the log" | `PER_ROUND_BOND.md` | true for the **log**; false for the **challenge pool** until this round | corrected, with both barriers named |
| nothing on restoring a **`ladder_pending`** snapshot | `PER_ROUND_BOND.md`, `FORMAL_INVARIANTS.md` | the barrier refused it before r37-1 — a host reading the restore contract would have concluded the opposite | one paragraph + INV-ESC-8 text updated |
| "`bondProofHash` … a host whose derivation can collide across jurors must mix the juror index in" | `confirmationMachineTypes.ts`, `PER_ROUND_BOND.md`, `CHANGELOG` | true but understated: a *derivable* witness is **preemptable**, not merely collidable (§1.3) | docstring + doc worded as preemption |

`READINESS_REVIEW.md` was checked for the same drift and carries no claim about
these barriers (it scopes itself to the submission artifact and the
string/array barrier), so it needed no correction — recorded here so the check is
not mistaken for a skip.

---

## 5. Fixes shipped in this PR

| # | File | Change | Closes |
|---|---|---|---|
| F1 | `confirmationMachineHandlers.ts:557` | `onEscalate` runs `assertValidConfirmationLedger` after `assertValidEscalationLog` — the pool the r29-1 witness test reads | r40-1 (EXPLOITABLE) |
| F2 | `confirmationMachineHandlers.ts:268-269` | `onOpenLadderRound` runs **both** barriers before a panel seat is spent | r40-1, r40-2 (EXPLOITABLE) |
| F3 | `confirmationMachineTypes.ts` | `CourtChallengeRecord.bondProofHash` says **preemptable** (a derivable witness is first-come-first-served) alongside the collision note | r40-3 |
| F4 | `docs/PER_ROUND_BOND.md` | reducer rule 6 (the pool uniqueness precondition), the barrier at all three callers, the `ladder_pending` restore paragraph, preemption, test index | r40-6 |
| F5 | `docs/FORMAL_INVARIANTS.md` | INV-CONF-17 gains the entry matrix + the ownership boundary; INV-ESC-8 gains `open_ladder_round` as a caller and the redundancy note | r40-6 |
| F6 | `docs/REVIEW_ROUND_5.md` | post-publication note (r37-1 + r40-1 supersession) — the record is kept, not rewritten | r40-6 |
| F7 | `CHANGELOG.md` | both closures, the ownership residual, and the consumer impact | this round |
| F8 | `__tests__/reviewRound6.test.ts` | 23 probes: 6 closures (all red on #108) + the legal-state hunt + 10 property pins + 3 residual pins named `(registered …)` | this round |

No public API was removed. The only consumer-visible change is that a restored or
hand-built state can no longer escalate or open a rung on a challenge ledger the
machine could not have produced — which was never a legitimate state.

## 6. Residuals, with dispositions

| # | Residual | Where | Disposition |
|---|---|---|---|
| r40-1 | `escalate` and `open_ladder_round` re-derive the log but not the challenge pool it reads — a restored duplicate-hash ledger bought a free rung and bricked the case | this package | **FIXED here** (F1+F2), 6 closures red on #108 |
| r40-2 | a restored `ladder_pending` with the record deleted opened the rung and un-consumed its bond | this package | **FIXED here** (F2) |
| r40-3 | the hash is unique but not **owned**: a derivable witness is preemptable (a non-owner locks the payer out) | this package + host | **host verifier bind (now) + v0.14 `accept_challenge` pubkey (r38-3/r29-5)**; pinned, owner + trigger named |
| r40-4 | the R39 gate composes `cap <= derivedCap` instead of the sign rule; unreachable at ρ=β (probed), reachable once β≠ρ (`a_f=0.5, β=3ρ` ⇒ `E[π]=0` blessed) | host | **host fix (one import), trigger: β becomes configurable** |
| r40-5 | the R39 gate guards both creation writers but not the boot backfill / NULL fallback, which write the same column from the unbounded config | host | **host fix, trigger: next `BAO_COURT_MAX_LADDER_ROUNDS` or per-round-bond deploy** — refuse the backfill rather than freeze an unblessed depth |
| r40-6 | the round-5 docs predate r37-1 and understated the barrier's callers, the pool precondition and preemption | this package (docs) | **fixed here** (F4+F5+F6) |
| r38-2 | `requireRoundBond` × `hostEscalation` prices nothing | this package | unchanged: documented + pinned + owner decision (v0.14 authority split). **The host took the decision the other way** (R39 defaults `requireRoundBond: true` and excludes `hostEscalation` from production configs) |
| r38-3 | the log's `challengerPubkey` is unverifiable | this package | unchanged: **v0.14** — and it is now the *same* change that would close r40-3 |
| r33-3 | one bond spendable in two cases | host | unchanged: host unique index; the machine's pool is per case **by design** (§1.4) |
| r33-5 | a **legacy** case's log can still be emptied | this package | unchanged: documented + pinned, scoped to `requireRoundBond: false`; the host now defaults strict |
| r33-7 | no measured `a_f` | host | unchanged: **DEFERRED-v0.14**; R39 gates the *assumed* accuracy (0.85) — the gate is only as good as the number typed |

Handover: the `r40-*` codes are this package's review-round namespace; the host
disposition register is `bao.markets` `docs/operations/REGISTERED_FINDINGS_SWEEP.md`,
whose rows r33-7/r38-4 should absorb r40-4 and r40-5. The `r29-*`/`r30-*` codes in
the paper's appendix A.3 are unchanged; `REVIEW_ROUND_4.md`, `REVIEW_ROUND_5.md`
and this document are the canonical record for `r33-*`/`r38-*`/`r40-*` until the
next paper refresh.

## 7. Suite evidence (this branch)

```
npx vitest run __tests__/reviewRound6.test.ts   # 23 passed
# same file, confirmationMachineHandlers.ts restored from origin/main: 6 failed
#   (r40-1 ×3, the entry matrix, r40-2, and the PER_ROUND_BOND doc pin)

npm test
 Test Files  78 passed | 1 skipped (79)
      Tests  1739 passed | 1 skipped (1740)
   Duration  107.70s

npm run typecheck          # tsc --noEmit — clean
npm run typecheck:tests    # tsc --noEmit -p tsconfig.test.json — clean
```

1,716 (#108, `CHANGELOG.md`) + 23 = **1,739**.

The legal-state hunt runs inside the suite (it is the 490-state walk in §2.1), so
the r37-1 class cannot come back silently: any new barrier that refuses a
reducer-reachable state turns that test red with the phase, round, log length and
policy printed.
