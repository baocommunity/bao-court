# Review Round 7 — attacking v0.13.2 and the R41 host fixes

**Date:** 2026-11-11 · **Base:** `bao-court` `origin/main` @ `8bac1bc`
(v0.13.2, #110) · **Host under test:** `bao.markets` @ `c018b0883` (R41 / #2434,
merged 2026-11-11) · **Branch:** `docs/review-round-7`.

**Scope, as briefed.** Four targets: (1) the **sign-rule predicate** that
replaced r40-4's composed integer test — its `{a_f, ρ, β}` inputs, their edges
and their monotonicity, and whether the host can assess with *different* ρ/β
than the cap it enforces; (2) the **legacy depth clamp** that closed r40-5 —
whether a too-deep row can still be written, whether every consumer READS the
clamped value, whether the clamp metric can be spoofed, and whether repeated
boots are idempotent; (3) the **v0.13.2 entry matrix** — the three entries
round 6 recorded as non-readers, probed with forged-state snapshots; (4) the
**strict round-bond default** — what a legacy deployment finds after upgrading.

**Method.** Unchanged, because it keeps working: the reducer is the attacker's
API (a hostile host speaks it directly *and* hands back tampered snapshots), the
pure helpers are called with hostile parameters, and every documentary claim is
re-derived from the code. A finding is one of:

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
| `npx vitest run __tests__/reviewRound7.test.ts` (**new**, 19 tests) | **19 passed** |
| the same file with `confirmationMachineHandlers.ts` restored from `8bac1bc` | **4 failed** — the r41-1 closures are real, not asserted after the fact |
| the **over-strictness walk** (2 policies × 2 authorities × depths 1–5 × never-challenged, §3.6) | **40/40 flows finalize**, identical verdicts and hashes |
| `npm test` (full suite) | **1,758 passed / 1 skipped (79 files + 1 skipped)** — §7 |
| `npm run typecheck` · `npm run typecheck:tests` | clean / clean |
| host probes (`bao.markets` @ `c018b0883`) | §1.5, §2.1–2.5, §4 — read from the tree, arithmetic re-run against this package |

**Verdict summary.** **1 EXPLOITABLE** (fixed here): `finalize` minted a
canonical verdict from a vote ledger it never re-derived, and the reachable
route into it is `concede` — one of the three entries the last round *stated*
were safe. Enter through it with a forged snapshot and the machine settles the
losing side of a case. Plus **1 doc defect fixed here** (the monotonicity
direction in `ladderEconomics.ts` is backwards — measured, not inferred) and
**5 host findings** (§1.5 H-1/H-2, §2.2 H-3, §2.3 H-4, §2.4 H-5, §4 H-6), each
with an owner and a trigger. The rest is BLOCKED with pins.

The headline is the same shape as rounds 5 and 6, one ledger over: round 6's
entry matrix asked *which entries read the challenge pool* and got the right
answer. It did not ask **which pool each value-locking entry reads**.
`finalize` reads `state.ladder.votes` — the vote ledger — to build the verdict
hash's evidence set, and the mass-vote barrier that validates it runs at
`resolve_round`, which a restore skips.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | sign rule | `ok(cap)` is the sign rule; is it monotone in `a_f` and `β`? | **BLOCKED** — monotone in both (pinned grid) … but the docstring states the `a_f` direction **backwards** → **fixed** (r41-T1-doc) |
| T1 | sign rule | ρ = 0, β = 0, `a_f` = 0/1/`NaN`/overflow | **BLOCKED** — every one throws except `a_f = 1` (legal, infinite bound) and `ρ+β` overflow (reads as `a_f = 1`); both pinned, host env rejects `1` |
| T1 | sign rule | the β ≠ ρ cell that motivated r40-4 | **BLOCKED** — break-even refused at the exact integer boundary (`E[π] = 0`); the retired composition would have blessed it |
| T1 | sign rule | can the host assess with ρ/β **different** from the ones the cap was priced under? | **PARTIAL → host H-1** (constant β is the bond at CREATION; the rule needs bond/V now — 3 rungs of drift) |
| T1 | sign rule | can ρ be measured, or only `a_f`? | **PARTIAL → host H-1** (only accuracy has an env; the two money parameters are compile-time) |
| T2 | legacy clamp | a row written AFTER the backfill with depth > bound? | **BLOCKED** — both creation writers gate; the third and fourth writers (catalogue outbox, mirror consumer) write NULL and are read-clamped |
| T2 | legacy clamp | does every consumer read the EFFECTIVE depth? | **NO → host H-3** (the capacity gate and the liquidity-add gate read the row directly; escalation is clamped) |
| T2 | legacy clamp | idempotent across repeated boots? | **BLOCKED** — the second boot early-returns on `missing = 0`; `min(configured, derived)` is idempotent |
| T2 | legacy clamp | can the metric be spoofed? | **PARTIAL → host H-4** (one increment per READ, no market label; a Counter used as a gauge on the missing rows) |
| T2 | legacy clamp | a clamp that freezes an unblessed depth **permanently**? | **PARTIAL → host H-5** (the backfill WRITES `min(configured, derived)`; a transient env typo is durable, no re-widening) |
| T2 | legacy clamp | `derivedCap = 0` ⇒ "no depth is safe" | **PARTIAL → host H-5** (`Math.max(1, derivedCap)` serves depth 1, the profitable rung) |
| T3 | entry matrix | `close_ladder_round` (non-reader) on a forged snapshot | **BLOCKED** — locks nothing in; `resolve_round`/`finalize` re-derive the pool |
| T3 | entry matrix | `concede` (non-reader) on a forged snapshot | **EXPLOITABLE → fixed** (r41-1): it walks into `finalize`, which read the vote ledger without validating it |
| T3 | entry matrix | `flag_clawback` (non-reader) | **BLOCKED** — phase- and roster-guarded; flags are deliberately not a verdict input (identical hash pinned) |
| T3 | entry matrix | is the verdict itself re-derived at `finalize`? | **NO → fixed** (r41-1): outcome came from the snapshot, `upheld` too, and `upheld` is not in the hash |
| T4 | strict default | does a legacy deployment break on upgrade? | **BLOCKED (inert)** — the host parses the flag and warns at boot; no case consumes it |
| T4 | strict default | is there an upgrade note, and is it accurate? | **PARTIAL → fixed here** (checklist in `PER_ROUND_BOND.md`; the host runbook's "passed where cases are built" is false → host H-6) |
| T4 | strict default | what breaks when the wiring lands? | **PARTIAL → host H-6** — the escalate body schema (`additionalProperties: false`) cannot carry `roundBondProofHash`, so the transport must ship BEFORE the policy is enforced |

---

## 1. T1 — the sign-rule predicate: `{a_f, ρ, β}`

### 1.1 The predicate itself (BLOCKED, pinned)

`ladderCapWithinBound` decides by the SIGN (`cap < flipRound`, i.e.
`E[π(cap)] < 0` strictly), and returns both derived integers for the message.
Probed at `ρ = β = 0.03` (the host's constants) and across the grid:

```
a_f   0.30  0.45  0.50  0.51  0.60  0.70  0.75  0.80  0.85  0.90   0.95
cap      0     0     0     1     1     1     2     3     4     5      5
flip     1     1     1     2     2     2     3     4     5     7     14
```

The boundary at the host's own constants is `4.265024281798726` (cap 4, first
profitable round 5) — the numbers the gate prints.

- **Monotone in `a_f`.** `cap` and `flip` are both non-decreasing in `a_f`
  (0 → 5 as accuracy runs 0.30 → 0.95) and the boolean verdict is monotone at
  every legal cap: once `ok(k)` is true it stays true for every higher accuracy.
  A less accurate jury never gets a deeper ladder. **Pinned.**
- **Monotone in `β`.** `cap` at `a_f = 0.85, ρ = 0.03` runs
  `0, 1, 3, 4, 5, 5, 5` for `β = 0.003 … 0.5` — a bigger bond never shrinks the
  safe depth. **Pinned.**
- **Scale-free.** The verdict depends only on `ρ/(ρ+β)`:
  `(0.85, 0.03, 0.03)`, `(0.85, 0.3, 0.3)` and `(0.85, 3, 3)` all give
  `4.265024281798726`. Pinned, and it is the reason §1.5's drift is a *ratio*
  problem, not a units problem.
- **The r40-4 cell, re-attacked.** `a_f = 0.5, ρ = 0.03, β = 0.09` puts the
  boundary at exactly `2` (`a_f = ρ/(ρ+β)`): `derivedCap = flipRound = 2`,
  `E[π(2)] = 0` exactly, and the sign rule refuses — while the retired
  composition `cap <= derivedCap` still says `true`. Regression-locked, and the
  depth one below the boundary is safe at every (a_f, β) pair probed, so the
  refusal is the break-even rung and nothing wider.

### 1.2 The edges (BLOCKED)

`ρ = 0`, `β = 0`, negative ρ/β, `a_f = 0`, `NaN`, `a_f > 1`, `ρ = ∞` all throw
from `assertLadderParameters` (the host maps them to
`LADDER_BOUND_PARAMS_INVALID`). Two legal-but-dangerous inputs are **pinned
rather than "fixed"**, because both are documented mathematics:

1. **`a_f = 1`** is legal in this package — a perfect jury never makes the
   ladder profitable — and yields an INFINITE bound, i.e. *every* depth is safe.
   That is the one input that disables the gate. The host's env resolver refuses
   `1` and everything `>= 1` and falls back to 0.85
   (`courtAssumedJurorAccuracy`), so the shipped entry is safe; a caller using
   the explicit `assumedAccuracy` parameter (tests, or a future "measured"
   path) has no such guard. Pinned in both layers.
2. **`ρ + β` overflow** (`1e308 + 1e308 = ∞`) makes the boundary `∞` and takes
   the same branch as `a_f = 1` — cap 5, everything blessed. Not reachable with
   fractions of V (ρ + β ≤ 2), and tightening it would change the documented
   `a_f = 1` semantics with it. Pinned as a known reading, not asserted as a
   guard.

`derivedCap = 0` (a_f ≤ ρ/(ρ+β), i.e. ≤ 0.5 at ρ = β) refuses every legal cap
1…5 and `E[π(R)] ≥ 0` throughout — the "no depth is safe" contract holds. The
exact cell `a_f = 0.5` is break-even at R = 1 (`E[π(1)] = 0`), and `ok` refuses
there too.

### 1.3 The docstring pointed the wrong way (PARTIAL → fixed, r41-T1-doc)

`deriveMaxLadderRounds`' docstring said *"Monotone **non-increasing** in `a_f`
(a less accurate jury must not be given a deeper ladder) and non-decreasing in
`β`."* The parenthetical is right and the adjective is **backwards**: the cap
rises 0 → 5 as `a_f` rises, so the function is non-**decreasing** in `a_f`. A
host author writing a pre-flight check from that sentence would invert the
direction — the exact class of defect the round-5/6 doc audits kept finding
(a claim that reads as a guard and is not one). Corrected in `ladderEconomics.ts`
and pinned as text *and* as behaviour (`reviewRound7.test.ts` › '(r41-T1-doc)…').

### 1.4 The `ok` verdict is what the host must read (BLOCKED, re-pinned)

`derivedCap` saturates at the machine ceiling (5) while `flipRound` does not
(7 at `a_f = 0.9`, 14 at 0.95), so above the ceiling the two integers stop
tracking the boundary at all and only the sign rule still answers the question.
That is precisely why R41 retired the composition, and why a consumer must never
re-derive `ok` from `derivedCap`. Pinned.

### 1.5 H-1 — the host assesses with ρ/β that need not be the ones it enforces (PARTIAL → host)

**The attack the brief asked for: "can the host pass DIFFERENT ρ/β than the cap
used?"** R41 does not merely pass different numbers — it passes **constants**:
`COURT_LADDER_BOUND_RHO = COURT_LADDER_BOUND_BETA = 0.03`
(`CourtLadderBoundGate.ts`), injectable only from a test. The rule, however, is
a function of the **realised** `β = bond / V` **at the time the ladder is used**,
and the host's bond is a sat amount fixed at creation:

```
packages/markets/services/bao-markets/DisputeEscrowService.ts:109
  const baseBond = Math.max(Math.floor(marketVolume * 0.05), 10_000);
```

At creation that is conservative in the safe direction (`β ≥ 0.05 > 0.03`, and
the docstring says so). It stops being conservative the moment `V` grows, which
the host explicitly allows (liquidity adds up to the economic cap, and the
capacity gate recomputes the cap from `markets.liquidity + pool_liquidity`).
Run through this package's own arithmetic at `a_f = 0.85`:

| where | β = bond/V | the package's safe cap | what R41's gate says |
|---|---|---|---|
| creation, 200 000-sat market (bond 10 000) | 0.05 | **5** | 4 (stricter — safe) |
| the same bond after `V` reaches 1 000 000 | 0.01 | **1** | **4** (three profitable rungs) |

`E[π(2)] … E[π(4)] > 0` at `β = 0.01`, i.e. the gate blesses three rungs that
are profitable for an unmerited challenger — the harm `r40-4` was about, one
parameter over. `ρ` has the same shape and less cover: there is no env, no
case-derived value, and no host-side derivation of it at all; only the
*accuracy* has an operator override (`BAO_COURT_ASSUMED_JUROR_ACCURACY`), which
cannot fix a money-parameter error (lowering it tightens a *different* quantity
and the refusal message tells the operator to do exactly that).

**Disposition: host fix** (owner: the court creation gate + the escalation
pre-flight; trigger: the next deploy that arms per-round bonds, or the first
measured/derived ρ/β). Two changes, both small: derive `beta` from the case's
frozen bond over the **current** exposure (`bondSats / resolveCourtMarketExposureSats(...)`)
rather than the constant, and re-assess at escalation (where the clamp already
runs) so a market that grew is re-priced; expose ρ the same way, or document it
as an assumption with the same standing as `a_f = 0.85`.

---

## 2. T2 — the legacy depth clamp (r40-5's fix)

### 2.1 Can a row be written AFTER the backfill with depth > the bound? (BLOCKED)

Every writer of `court_max_ladder_rounds`, enumerated from the tree at
`c018b0883`:

| # | writer | gated? |
|---|---|---|
| 1 | `createMarket` INSERT (`db/pg-queries.ts:595`) via `POST /markets/create` (`routes/markets.ts:2268`, gate at the earlier `assessLadderDepthBound` call) | **yes** — 422 `LADDER_DEPTH_EXCEEDS_BOUND` |
| 2 | the same INSERT via the admin upsert (`routes/markets.ts:646`, gate at 621) | **yes** — same call, both writers, one rule |
| 3 | the boot backfill UPDATE (`CourtLadderFreeze.ts:318`) | **yes** — `clampLadderDepthToBound` before the `UPDATE` |
| 4 | catalogue outbox (`catalogue/catalogueOutbox.ts:96`) | writes **no** court columns → NULL → read-clamped |
| 5 | mirror consumer (`catalogue/mirrorConsumer.ts:320`) | writes **no** court columns → NULL → read-clamped |
| 6 | `scripts/load-test-matching-engine.mjs:159` (dev) | no court columns → NULL |

So there is no path that writes a depth **above** the bound, and the two writers
that are not gated at all write NULL, which every reader clamps. `migrations/233`
only adds the columns, the CHECK (`1..5`) and the partial scan index — it does
not backfill, so it cannot freeze an unblessed depth either.

### 2.2 Does every consumer READ the effective value? (NO → H-3)

The R41 header claims *"every READ (frozen row, NULL fallback, escalation,
deposit re-assessment) serves the same effective value"*. Three consumers were
checked; one is clamped, two are not:

| consumer | how it reads | clamped? |
|---|---|---|
| escalation route (`routes/courtEscalation.ts:204`) → `readFrozenCourtLadderForCase` | through the freeze module | **yes** |
| **capacity gate** (`services/court/CourtCohortCapacity.ts:201-203`) → `resolveCourtLadderFreeze` on the raw row | direct SQL, no clamp | **NO** |
| **liquidity-add gate** (`services/court/courtExposureGate.ts:157-158`) | direct SQL, no clamp | **NO** |
| summons board (`routes/courtSummons.ts`, `SummonsAckService`) | reads no ladder column at all (grepped) | n/a — not a consumer |
| `resolveMaxLadderRounds(env)` (`CourtEscalationService.ts:80`) | env only | **dead code** — no caller; the freeze module's own header still says escalation uses it (drift) |

**H-3 (PARTIAL → host, owner: the capacity/exposure gates, trigger: next deploy
that changes `BAO_COURT_MAX_LADDER_ROUNDS` or the assumed accuracy — i.e. any
deploy where the clamp actually bites).** The direction matters and it is the
dangerous one: a deeper depth means a bigger deepest rung means a *larger* cap
(`deriveCourtEconomicCap` reads `cohort.maxLadderRounds`), so the unclamped
capacity gate computes the cap for a panel the ladder will now refuse to seat.
Concretely, at `round0Panel = 5` and `a_f = 0.75` the bound is 2, so a row
frozen at 3 is served as 2 (45 seats, cap 101 250 sats) — while the capacity gate
still prices 3 (135 seats, `γσN = 1.215` ⇒ **unbounded**). A 1 M-sat market then
passes the gate and escalates onto a predominantly 45-seat rung: the r30-2
capital-invariant violation, reintroduced by the clamp's asymmetry. The fix is
one call: route both readers through `readFrozenCourtLadderForMarket` (or apply
`clampLadderDepthToBound` to `resolved.cohort` before `assessCourtEconomicRatio`).

### 2.3 The clamp metric can be inflated, and measures attempts rather than markets (PARTIAL → H-4)

`bao_court_ladder_depth_clamped_total{source}` is incremented inside
`reportLadderClamp`, which runs on **every read** of a clamped market — so N
escalation attempts against one deeply-clamped market produce N increments, and
there is no market label to separate one market from fifty. Any NIP-98-authed
juror can therefore raise `source="escalation"` at will (30 requests/minute on
the route) — the count can be inflated to look like a fleet-wide misconfiguration
or drowned in noise after a single real one. Separately, the *missing* counter is
incremented with `inc({...}, missing)` once per boot, i.e. a Counter used as a
gauge, so its value double-counts across boots. Disposition: host (metrics
hygiene): emit the clamp once per (market, source) per boot, or label it by
market and expose the depth as a gauge; leave the counter for the boot audit.

### 2.4 The clamp is idempotent across boots — and PERMANENT (BLOCKED + PARTIAL → H-5)

Idempotent: the second boot counts `missing = 0` and returns before the `UPDATE`,
so nothing is re-written; and `min(configured, derived)` applied to an
already-clamped row is the same number, so even a forced second pass shifts
nothing. **Verified by the code path, not assumed.**

Permanent, which is the part nobody wrote down: the backfill **writes**
`min(configured, derived)` **into the row**, and a row that is no longer NULL is
never selected again. So a single boot with a low
`BAO_COURT_ASSUMED_JUROR_ACCURACY` (a typo: `0.4` instead of `0.85`) freezes
every legacy court market at the bound implied by 0.4 — depth 0 ⇒ the floor of
1 — and **raising it back does not restore the depth**, because the promise is
now on the row. Round 6's recommendation was "refuse the backfill rather than
freeze an unblessed depth"; R41 chose clamp-and-write, which is safe but turns a
transient env value into a durable freeze.

The same `Math.max(1, derivedCap)` floor is the other half of H-5: when
`derivedCap = 0` the assessment says **no depth is safe** (`E[π(1)] ≥ 0`), and
the clamp serves depth 1 anyway — a written column has no representation for
"unarmable", so the honest behaviour is to refuse the LADDER (a typed refusal at
escalation) rather than to serve its most profitable rung. Both halves are
PARTIAL: tighten-only and loudly logged, but not fail-closed.

**Disposition: host fix** (owner: the freeze/backfill path; trigger: next deploy
that arms bonds or touches the assumed accuracy). Write the **configured** depth
and let the read-time clamp tighten (the header already promises reads never
rewrite the row), or keep the write and add a re-widening path keyed on an
explicit operator action; and make `derivedCap = 0` a refusal, not a floor.

### 2.5 The clamp at the creation writers is a different predicate (BLOCKED)

The creation gate REFUSES outright (`!ok ⇒ 422`) while the read path CLAMPS
(`min`). That asymmetry is deliberate and documented ("a freeze is a promise" vs
"the column is the promise, the clamp is the ceiling"), and it is consistent:
both call the same `assessLadderDepthBound`, so a row that a create would refuse
is served tightened rather than rejected, which cannot brick an existing case.
Pinned as the intended difference.

**Note on scope.** T2 has no package-side `describe()` block because the clamp
lives entirely in the host (`CourtLadderFreeze.ts` / migration 233); nothing in
this package reads or writes the depth. The package-side half of the same
question — what the bound *is*, and how it moves with ρ/β — is pinned in T1's
describe (§1.1–1.2), which is the arithmetic the host's clamp consumes.

---

## 3. T3 — the entry matrix's three NON-readers (v0.13.2)

### 3.1 The premise under attack

`docs/REVIEW_ROUND_6.md` §1.2 classified the entries:

> `close_ladder_round` — no (mass-vote ledger only) … **`concede`** — no …
> **`flag_clawback`** — no … The three non-readers are **stated** rather than
> given a fake assertion: each is followed by a pool-reading barrier
> (`resolve_round` or `finalize`) before any value is locked in.

The claim is exact about the **challenge pool** and silent about the pool
`finalize` actually reads for a challenged case. `finalize` builds the verdict
hash's preimage from `state.ladder.votes` (`finalSupportingEventIds`) — the
**vote ledger** — and ran `assertValidConfirmationLedger`, `assertValidOutcomeHistory`
and `assertValidEscalationLog`, but never `assertValidMassVoteLedger`. The
mass-vote barrier ran at `resolve_round`, which a *restore* skips.

### 3.2 `close_ladder_round` — probed, BLOCKED

A forged snapshot at `ladder_vote_open` with a duplicated challenge pool passes
`close_ladder_round` (it validates the vote ledger only, by design) and parks at
`ladder_vote_closed`. `resolve_round` refuses it immediately after
(`binds one bond proof hash to participants 2 and 3`), and so does `finalize`, so
the case **bricks** and never settles wrong. No value is locked in; the entry is
safe as stated. Pinned.

### 3.3 `concede` — the route in (EXPLOITABLE → fixed, r41-1)

`concede` re-derives nothing: `round_resolved → fee_settlement` on the strength
of the pending verdict. That is fine for a machine-produced state and it is the
door for a restored one, because the NEXT entry — `finalize` — is the one that
locks value in.

**Repro (now a test).** Walk a legal challenged case (round 1 and round 2 both
NO against a YES proposal) to `fee_settlement` **through `concede`**, then hand
the reducer a restored snapshot with:

```ts
ladder.votes = [{ idx: 1, outcome: 'YES', eventId: <hex32> }]      // one forged ballot
verdict      = { outcome: 'YES', upheld: true, supportingEventIds: [], verdictHash: '' }
```

On `8bac1bc` this **accepted** and returned `phase: 'final'` with
`outcome: 'YES'`, `upheld: true` and a canonical `verdictHash` — the market pays
the side every panel voted against, and the hash verifies because the forged
ballot is in its preimage. The same door accepts (measured, not inferred):

- **an outcome outside the frozen ballot, with padded support.** Three forged
  records (`idx 1` twice with the same event id, plus off-roster `idx 99`) and a
  pending verdict naming `MAYBE` — an outcome the case cannot adjudicate —
  finalized on `8bac1bc` as `FINAL outcome=MAYBE supported=3`;
- **duplicate ballots / duplicate event ids** — inflating the verdict's support
  set at no cost (the honest path refuses both at `resolve_round`);
- **off-roster voters** — a ballot from an index the case never seated;
- **a malformed event id** — refused eventually, but as the **VOTE machine's**
  `CourtVoteTransitionError` (`supporting event ids must be 32-byte lowercase
  hex`) escaping out of this machine, the r3-1 class of foreign error type;
- **`upheld` flipped** with the outcome untouched — invisible to any verifier,
  because `upheld` is not in the preimage: `H(session, outcome, eventIds)` is
  identical either way.

**Fix (shipped).** `onFinalize` now (a) runs `assertValidMassVoteLedger` for a
challenged case, and (b) **derives** the verdict instead of trusting the pending
field: outcome and supporting ids come from the deciding round's append-only
`outcomeHistory` record — the commitment `resolve_round` wrote in the SAME
transition as the tally — and the vote ledger must agree with that record
(round number, majority outcome, and the exact winning event-id multiset). The
pending `outcome`/`upheld` must equal the derived values; the minted verdict uses
the derived ones. `upheld` is now `record.outcome === proposedOutcome`, never a
caller-supplied flag.

**Why the history and not the tally.** A tally over a forged ledger is
consistent with itself (one forged YES ballot makes YES the majority). The
history record is the machine's independent commitment to the same round, so
touching one without the other is provably not a machine-produced state. The
residual that remains is stated in §3.7.

### 3.4 `flag_clawback` — probed, BLOCKED

Phase-guarded to `fee_settlement`, roster-guarded (`assertParticipant`), reason
bounded and deduplicated per `(idx, reason)`. It writes only the flag ledger,
which is deliberately **not** a verdict input: the test finalizes the same
snapshot with and without an extra flag and asserts the **identical**
`verdictHash` (INV-CONF-34 re-pinned). Nothing to launder.

### 3.5 Blind spot found while probing: `record_fee` in no phase (BLOCKED)

`record_fee` has no phase guard of its own; the REDUCER refuses it after a
terminal phase (`cannot process record_fee after final`), which is what the
existing test pins. So a final state cannot grow a fee ledger, and
`fee_settlement` is the only state where fees can be appended. Not a finding —
recorded so the check is not mistaken for a skip.

### 3.6 How much did the fix tighten the machine? (0 refusals)

The r37-1 lesson: a barrier that refuses a state the reducer can produce is a
defect in the barrier. So the fix was walked over **40 legal flows** — both
`requireRoundBond` policies × both escalation authorities × `maxLadderRounds`
1…5 × never-challenged and challenged-to-the-cap — asserting that each still
reaches `final` with the honest verdict, and that the verdict hashes are
unchanged. **40/40 finalize.** The derivation also holds for every earlier suite
(1,758 tests, §7), including the multi-round, property and model-checking tests.

### 3.7 The residual: a CONSISTENT forgery is undetectable here (registered)

A snapshot that rewrites the votes, the matching history record AND the pending
verdict together is still accepted, because all three are state and the machine's
only record of what a panel did is that state. `assertValidOutcomeHistory`
verifies the record's SHAPE (consecutive rounds, ballot closure, unique hex ids,
valid indices), not its agreement with an independent log. This is the documented
boundary rather than a new gap — the machine is snapshot-friendly plain JSON and
the host must authenticate the event stream before dispatching (`the event
boundary must authenticate authors and roster indices`, `courtConfirmationMachine.ts`)
— but it was previously implicit, and r41-1 shows what "implicit" costs. Pinned
as `(registered r41-2)`, disposition: **v0.14 — a per-round vote commitment in
the history record** (`hash(eventIds)` committed at `resolve_round` and carried
by a signed attestation) is what would let a restore detect a rewritten round;
until then the host's event authentication is the only anchor.

---

## 4. T4 — the strict round-bond default, and what an upgrade finds

### 4.1 The default is real, and inert (BLOCKED — no breakage today)

`DEFAULT_COURT_FEATURE_FLAGS.requireRoundBond = true` and
`parseStrictUnlessDisabled` makes absent/empty/junk parse to `true`; only an
explicit `BAO_COURT_REQUIRE_ROUND_BOND=0` opts into the legacy policy, and
`courtDeploymentPolicyWarnings` says so at boot on non-demo networks. **No case
consumes the flag**: `git grep requireRoundBond` over `packages/api` at
`c018b0883` finds only `courtFeatureFlags.ts`, a comment in `server.ts`, and the
vendored package. The host runbook says the same thing in its own words —
"**Not yet wired to a case** … `packages/api` still does not create court
confirmation-machine cases".

So the brief's worry — *a legacy deployment upgrading gets strict mode suddenly
and its flows break* — **does not happen today**: the flag is parsed, warned
about, and nothing else. On this package's side, a pre-0.13 snapshot with the
field ABSENT stays legacy (pinned: it escalates without a round bond and
finalizes), which is the upgrade path that matters for restores.

### 4.2 The upgrade note was missing the one thing that will break (PARTIAL → fixed here + H-6)

The compat matrix documented what legend/strict mean, but not the **order of
operations** for a deployment moving to strict. Two facts make that order
mandatory rather than cosmetic:

1. `ESCALATE_BODY_SCHEMA` (`routes/courtEscalation.ts`) is
   `additionalProperties: false` and has **no** `round_bond_proof_hash` field, and
   `EscalationRequest`/`hashEscalationRequest` do not carry one either. A client
   literally cannot submit the witness a strict case demands.
2. The machine's refusal is fail-closed but total: every challenger escalation on
   a strict case becomes `COURT_ESCALATION_REFUSED`, so the ladder parks at its
   last resolved round forever.

So the future breakage is: **flip the policy before shipping the transport ⇒ dead
ladder.** `docs/PER_ROUND_BOND.md` now carries a five-point upgrade checklist
(transport first, the policy is frozen per case and cannot be relaxed, never
combine with `hostEscalation`, legacy cases keep the deletion residual, both ends
must agree on one-witness-one-standing), pinned by a doc test.

**H-6 (PARTIAL → host, owner: the runbook + the escalation relay, trigger: the
enforce-mode case wiring — `COURT_TECH_DEBT.md` #3 — whichever lands first).**
`docs/operations/COURT_ROUND_BOND_POLICY.md` §2 says the flag is *"parsed,
warned about at boot, and passed where cases are built"* — the last clause is
false (nothing passes it). Correct the sentence, and add the relay/schema step to
the same section so the two land together; `hashEscalationRequest` must also bind
the round-bond witness, or two different round bonds produce one request hash.

> **Status (R43).** The package half shipped: `courtEscalationRequest.ts` is the
> versioned wire codec (build/serialize/parse/hash/toMachineEvent) with the
> optional `roundBondProofHash`, a v2 request-hash domain that binds it, and a
> known-answer digest both suites pin. The host must adopt it in the escalate
> body schema + `hashEscalationRequest` **before** the policy is enforced; see
> `docs/PER_ROUND_BOND.md` §"Upgrading a deployment to the strict policy", point
> 1.

### 4.3 `hostEscalation` still makes the policy inert (BLOCKED, re-pinned)

`requireRoundBond: true` + `hostEscalation: true` grants the exemption to
*challenger* escalations as well (r38-2), and the host's own runbook excludes the
combination from production and warns at boot. Pinned from this side: the
break-glass case escalates without a witness and reaches `ladder_pending`.
Unchanged residual, unchanged disposition (v0.14 authority split).

---

## 5. Fixes shipped in this PR

| # | File | Change | Closes |
|---|---|---|---|
| F1 | `confirmationMachineHandlers.ts:onFinalize` | runs `assertValidMassVoteLedger` for a challenged case — the ledger whose records become the verdict's evidence | r41-1 (EXPLOITABLE) |
| F2 | `confirmationMachineHandlers.ts:deriveFinalVerdict` (new) | derives the verdict from the deciding round's `outcomeHistory` record and requires the vote ledger to agree (round, majority, exact winning id set); `upheld` derived, never trusted | r41-1 |
| F3 | `ladderEconomics.ts` | monotonicity docstring direction corrected (measured: non-DEcreasing in `a_f`) | r41-T1-doc |
| F4 | `docs/PER_ROUND_BOND.md` | entry-matrix correction (`finalize` reads the vote ledger) + the 5-point strict-policy upgrade checklist + the r41 test index | r41-1, r41-T4 |
| F5 | `docs/FORMAL_INVARIANTS.md` | INV-CONF-32 rewritten as a re-derivation, INV-CONF-32b added (the evidence barrier), stale table row removed | r41-1 |
| F6 | `CHANGELOG.md` | both closures, the doc fix, consumer impact | this round |
| F7 | `__tests__/reviewRound7.test.ts` | 19 probes: 4 r41-1 closures (red on `8bac1bc`), the non-reader matrix, the 40-flow over-strictness walk, the sign-rule edge/grid pins, 2 doc pins | this round |

No public API was removed. The consumer-visible change is that a restored or
hand-built state can no longer mint a verdict from a vote ledger the machine
could not have produced — which was never a legitimate state — and that
`verdict.upheld` in a `final` state is now always the honest derivation.

## 6. Residuals, with dispositions

| # | Residual | Where | Disposition |
|---|---|---|---|
| r41-1 | `finalize` minted a canonical verdict from an unvalidated vote ledger; reachable through `concede`; `upheld` was caller-supplied | this package | **FIXED here** (F1+F2), 4 closures red on `8bac1bc` |
| r41-2 | a CONSISTENT forgery (votes + matching history + pending verdict) is undetectable at this layer — the machine's only record of a round is its own state | this package | **v0.14** — a per-round vote commitment carried by a signed attestation; until then the host's event authentication is the anchor. Pinned |
| r41-T1-doc | the monotonicity sentence said "non-increasing in `a_f`" (backwards) | this package (docs) | **FIXED here** (F3), text + behaviour pinned |
| H-1 | the gate assesses with constant ρ = β = 0.03 while the rule needs the realised `bond/V`; a market that grows 5× drifts 3 rungs (safe cap 1, gate blesses 4); only `a_f` has an operator override | host | **host fix**, owner: creation gate + escalation pre-flight; trigger: arming per-round bonds / first derived ρ/β |
| H-2 | `a_f = 1` (and `ρ+β` overflow) yields an infinite bound; legal in the package, refused by the host's env resolver but not by its explicit-parameter path | package contract + host | **documented + pinned** (both layers); host must keep `assumedAccuracy` off any env-sourced path |
| H-3 | the capacity gate and the liquidity-add gate read the frozen depth WITHOUT the R41 clamp, so they price a rung the ladder will refuse to seat (r30-2's shape; e.g. 1 M sats on a 45-seat rung) | host | **host fix**, owner: `CourtCohortCapacity` + `courtExposureGate`; trigger: any deploy where the clamp bites. One call: `clampLadderDepthToBound` before `assessCourtEconomicRatio` |
| H-4 | `bao_court_ladder_depth_clamped_total` increments per READ with no market label; a single clamped market yields N counts under juror-controlled retries; the missing counter is used as a gauge | host | **host fix** (metrics hygiene), owner: metrics registry + freeze module |
| H-5 | the backfill WRITES the clamped depth, so a transient low assumed-accuracy boot permanently freezes legacy rows (no re-widening); `derivedCap = 0` is floored to depth 1 (a profitable rung) instead of refusing the ladder | host | **host fix**, owner: the freeze/backfill path; trigger: next deploy touching bonds or the assumed accuracy |
| H-6 | the runbook says the flag is "passed where cases are built" (it is not), and the escalate body schema cannot carry `roundBondProofHash` — the transport must land BEFORE the policy is enforced, or every escalation 409s | host | **host fix** (doc + relay + request hash), owner: runbook + escalation relay; trigger: the enforce-mode case wiring (`COURT_TECH_DEBT.md` #3) |
| H-7 | `resolveMaxLadderRounds(env)` has no caller while the freeze module's header still says escalation reads it | host | **host fix** (delete or re-wire + doc), owner: `CourtEscalationService`; trigger: next touch of that service |
| r40-3 | the hash is unique but not owned (a derivable witness is preemptable) | this package + host | unchanged: host verifier binds the witness to the event author; v0.14 `accept_challenge` pubkey |
| r33-5 | a **legacy** case's log can still be emptied | this package | unchanged: documented + pinned, scoped to `requireRoundBond: false`; the strict policy is the answer and can only be chosen at creation (§4.2 point 4) |
| r33-7 | no measured `a_f` | host | unchanged: **DEFERRED-v0.14**; R41 gates the assumed accuracy |
| H-2 (§1.5 of round 6) | ρ is never derived, only declared | host | folded into **H-1** here (it is the same defect, measured) |

Handover: the `r41-*` codes are this package's review-round namespace; the host
disposition register is `bao.markets` `docs/operations/REGISTERED_FINDINGS_SWEEP.md`,
whose rows r33-7/r38-4 should absorb H-1, H-3, H-4, H-5, H-6 and H-7. The
`r29-*`/`r30-*` codes in the paper's appendix A.3 are unchanged;
`REVIEW_ROUND_4.md`, `REVIEW_ROUND_5.md`, `REVIEW_ROUND_6.md` and this document
are the canonical record for `r33-*`/`r38-*`/`r40-*`/`r41-*` until the next
paper refresh.

## 7. Suite evidence (this branch)

```
npx vitest run __tests__/reviewRound7.test.ts   # 19 passed
# same file, confirmationMachineHandlers.ts restored from 8bac1bc: 4 failed
#   (the vote-ledger barrier, the losing-outcome verdict, the duplicate/outsider/
#    malformed-id matrix, and the `upheld` re-derivation)

npm test
 Test Files  79 passed | 1 skipped (80)
      Tests  1758 passed | 1 skipped (1759)
   Duration  114.20s

npm run typecheck          # tsc --noEmit — clean
npm run typecheck:tests    # tsc --noEmit -p tsconfig.test.json — clean
```

1,739 (#109 / v0.13.2) + 17 behavioural + 2 doc pins = **1,758**.

The over-strictness walk runs inside the suite (the 40 legal flows in §3.6), so
a future barrier that refuses a reducer-reachable state turns it red with the
policy, authority and depth printed.
