# Review Round 5 — attacking the ROUND-4 fixes (v0.13.1)

**Date:** 2026-11-11 · **Base:** `origin/main` @ `bedb476` (v0.13.1) · **Branch:**
`docs/review-round-5` · **Scope:** the four closures round 4 shipped — the
refuse-any-accepted-bond rule (r33-1), the complete escalation ledger plus the
`onEscalate` barrier (r33-5), the sign-based derived bound (r33-6) and the
`Infinity` guard in the penalty arithmetic (r33-9) — attacked with the same
doctrine that produced r29-1 / r33-1 / r33-5: **find the premise the guard
assumes, the symmetric path it forgot, and the input it reads as valid.**

**Method.** The reducer is the adversary's API (a hostile host speaks it
directly, and a hostile host can also hand back a tampered snapshot), and the
pure helpers are called with hostile parameters. A finding is one of:

- **EXPLOITABLE** — a test in this repository shows the harm through the shipped
  interfaces; fixed here (`EXPLOITABLE = fix now`);
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited.

Every residual gets a **disposition** (fixed here / documented + pinned / host
fix with an owner and a trigger / deferred to a named version). Nothing is left
as a bare "registered".

**What was executed for this audit**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound5.test.ts` (**new**, 27 tests) | **27 passed** |
| the same file against the unfixed v0.13.1 sources | **3 failed** — all three r38-1 closures are real, not asserted after the fact |
| `npm test` (full suite) | **1,713 passed / 1 skipped (76 files + 1 skipped)** — §6 |
| `npm run typecheck` · `npm run typecheck:tests` | clean / clean |
| host probe (`bao.markets` @ `65b7cef05`, source audit) | §3.4 — **not fixed**, plus a new prerequisite |

**Verdict summary.** 1 EXPLOITABLE (**fixed here**: r38-1 — one bond witness
bought two challengers' standing, which is the premise the r33-1 rule rests on) ·
2 PARTIAL (1 documented + pinned: the `requireRoundBond` × `hostEscalation`
composition; 1 deferred to v0.14: the log's `challengerPubkey` is unverifiable) ·
1 host finding (r38-4: the r33-7 gate is still absent **and** the copy the host
would call is the pre-fix one) · the remaining attacks BLOCKED with pins.

The headline: **round 4's r33-1 fix refuses "any accepted challenge bond" as a
round bond, but the challenge pool it enumerates was itself not unique.** The
ledger deduped by `idx` only, so a juror that posted nothing could mint an
accepted challenge carrying a bonded juror's `bondProofHash` and then escalate
on it — the `(idx, bondProofHash)` pair r29-1 requires matches, because the
attacker printed the record first. One payment, unlimited standing, and every
attack that needs "an accepted challenge bond" became free.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | refuse-any-accepted-bond | the **membership pool has no uniqueness**: one paid bond buys N challengers' standing (two-step r29-1 bypass) | **EXPLOITABLE → fixed** (r38-1) |
| T1 | refuse-any-accepted-bond | a round bond re-used as a membership bond **inside one case** | **BLOCKED** — phase refuses it live, the barrier refuses the restored form |
| T1 | refuse-any-accepted-bond | the consumed set: is it the union of both pools? | **BLOCKED** for round bonds (log ∪ every challenge hash), pinned cell by cell |
| T1 | refuse-any-accepted-bond | `requireRoundBond: true` + `hostEscalation: true` ⇒ the strict policy is inert against challengers | PARTIAL → documented + pinned (r38-2) |
| T2 | complete ledger | records out of order / a round recorded twice / a skipped round | **BLOCKED** (3 pins) |
| T2 | complete ledger | a record whose challenger does not match the challenge ledger | **BLOCKED** (idx and bond both re-derived) |
| T2 | complete ledger | bypass the barrier via the no-challenge path (`finalize` without ever escalating) | **BLOCKED** — `finalize` runs it unconditionally; an injected record is refused |
| T2 | complete ledger | the escalate-time barrier can be skipped by a snapshot restored after it | **BLOCKED** — the tampered state is refused before a seat is spent |
| T2 | complete ledger | the log's `challengerPubkey` is free text the machine cannot check | PARTIAL → v0.14 (r38-3 = r29-5 re-confirmed) |
| T3 | sign-based bound | adversarial `a_f` / `rho` / `beta` (0, negative, NaN, > 1, strings) | **BLOCKED** — every one throws a typed error (12-case matrix) |
| T3 | sign-based bound | `derivedCap = 0` propagation: can any cap still be blessed? | **BLOCKED** — `ok` is false at every cap 1…5, and the refused round is profitable |
| T3 | sign-based bound | the sign boundary drifts an epsilon past break-even | **BLOCKED** — `a_f = ½` is exactly boundary 1 ⇒ 0; `0.51` ⇒ 1 with `E[π] < 0` |
| T3 | sign-based bound (host) | an operator sets a depth above the derived bound at creation | **NOT FIXED** at host HEAD `65b7cef05` — and the vendored copy is pre-fix (r38-4) |
| T4 | Infinity guard | other overflow paths around the penalty arithmetic | **BLOCKED** — every product covered; no NaN/Infinity reachable |
| T4 | Infinity guard | a non-finite weight that escapes to the lottery | **BLOCKED** — `weightedPriority` refuses it at use (r33-9 backstop) |
| T4 | Infinity guard | `bigint` / `number` mixing, weight × count | **BLOCKED** — the BigInt module is bounded at both ends (§4.4) |
| T4 | Infinity guard | the "never expires outright" claim | PARTIAL → doc precision, pinned (r38-5) |

---

## 1. T1 — refuse-any-accepted-bond (r33-1), attacked

### 1.1 r38-1 — one bond witness bought TWO challengers' standing (EXPLOITABLE, fixed)

**Attack.** Round 4 made the reducer refuse **any** accepted challenge bond of
the case as a per-round bond, on the premise that an accepted challenge bond is
a uniquely owned, paid witness:

```ts
// confirmationMachineHandlers.ts (v0.13.1)
const membershipBond = state.challenges.find((c) => c.bondProofHash === roundBondProofHash);
if (membershipBond) throw …   // "participant N's accepted challenge bond"
```

That premise is false one layer down. `accept_challenge` deduped by `idx` only:

```ts
const existing = state.challenges.find((c) => c.idx === event.idx);   // idx, not hash
```

So the membership pool itself had no uniqueness, and r29-1's fix (the reducer
requires the pair `(challengerIdx, bondProofHash)` to match an accepted
challenge) is satisfiable by *printing the record first*:

1. juror 2 posts bond `M` — `accept_challenge{idx: 2, bondProofHash: M}`;
2. juror 3, which posted **nothing**, sends
   `accept_challenge{idx: 3, bondProofHash: M}` — accepted, because the ledger
   only compares indices;
3. juror 3 escalates; `state.challenges.some(c => c.idx === 3 && c.bondProofHash === M)`
   is **true**, so the rung opens and `escalationLog[0]` records juror 3 as the
   payer of a bond juror 2 owns.

Measured (`reviewRound5.test.ts` › *'the borrow it enabled is a FREE membership'*,
and the pre-fix ledger reconstructed by hand): with v0.13.1 both challenges and
both escalations are accepted, and `assertValidConfirmationLedger` — the restore
barrier that re-derives the challenge ledger at `resolve_round` — accepts the
duplicated hash too. The harm is exactly the one r29-1 was written for, one
field over: **the membership bond is the standing price, and it was free.**

The ripple is what makes it the headline rather than a curiosity:

- **Unlimited standing per payment.** `N` unbonded jurors can name one bond hash
  and each receives an escalation right (and a challenge record, and a clawback
  attribution) for nothing.
- **The r33-1 rule's enumeration is unreliable.** A refusal list built from a
  pool with duplicate owners cannot distinguish "juror 2's bond" from "juror 3's
  bond"; the message names one participant for a hash that two hold.
- **r33-2b (front-run) stops requiring a bond at all.** The registered
  "a bonded rival burns a paid witness" attack assumed the attacker was a paid
  member of the case. With r38-1 anyone is.

**Why this is the machine's job, not the host's.** The shipped host verifies
nothing but the shape: `courtEscalation.ts:207` injects
`formatOnlyBondVerifier`, whose whole body is
`HEX32.test(bondTxid) && HEX32.test(bondProofHash)`
(`CourtEscalationService.ts:421`, "production must inject a rail-backed verifier
instead"). A rail-backed verifier would prove that *a* bond exists at that hash;
it still could not know that juror 3 is claiming **juror 2's** bond without a
registry keyed by hash — and this case's challenge ledger *is* that registry,
scoped to the case, which the machine already holds. So uniqueness inside one
case is a **state** property here, exactly the argument round 4 used for the
r33-1 rule two paragraphs above.

**Repro.** `reviewRound5.test.ts` ›
*'one bond witness cannot buy TWO challengers\' standing (r38-1, EXPLOITABLE)'*,
*'the borrow it enabled is a FREE membership'*,
*'the restore barrier refuses a duplicated bond hash'*. All three fail on
v0.13.1 and pass here. No over-correction: juror 3's own bond is still accepted,
and the two hashes then have distinct owners.

**Fix (shipped).** Two layers, one rule — "one bond witness buys one
challenger's standing":

```ts
// confirmationMachineHandlers.ts:onAcceptChallenge (reducer)
const bondOwner = state.challenges.find((c) => c.bondProofHash === event.bondProofHash);
if (bondOwner) throw new CourtConfirmationTransitionError(
  `challenge bond proof hash is already bound to participant ${bondOwner.idx}'s accepted `
  + 'challenge: one bond witness buys one challenger\'s standing');

// confirmationMachineCore.ts:assertValidConfirmationLedger (restore barrier)
const bondOwner = challengeBondOwners.get(record.bondProofHash);
if (bondOwner !== undefined) throw … ;   // one hash, one owner, on a restored ledger too
```

**Consumer impact.** A host whose `bondProofHash` *can* collide across jurors —
e.g. `hash(bondTxid)`, which a batch payout shares — must mix the juror index
into the witness, or its second challenge is refused. That is now written into
`CourtChallengeRecord.bondProofHash`'s docstring, `docs/PER_ROUND_BOND.md` and
the CHANGELOG; every per-juror proof (the shipped shape: a bond-ownership
witness) is unaffected.

### 1.2 The symmetric direction — a round bond re-used as a membership bond (BLOCKED)

The brief's question, "can a round bond be accepted as a MEMBERSHIP bond", has a
different answer inside one case and across cases:

| direction | live path | restored snapshot |
|---|---|---|
| round bond `R` → membership bond, **same case** | **impossible**: `accept_challenge` needs `challenge_window`, which ends before round 1 exists (`ladder_pending`/`ladder_vote_open` refuse it) | **refused** by `assertValidEscalationLog` — a record whose `roundBondProofHash` is also an accepted challenge bond throws |
| round bond `R` → membership bond, **later case** | **accepted** — the pools are per-case by construction (r33-3, §1.4) | n/a |
| membership bond `M` → round bond, **same case** | **refused** (r33-1 + r38-1) | **refused** (barrier) |

Pinned: *'a round bond cannot become a membership bond inside the SAME case
(phase + barrier)'*. The asymmetry is therefore not a hole but a *reachability*
fact: the case's phase order (`challenge_window` → ladder) makes the
round→membership direction unreachable while the case is live, and the barrier
covers the restore. **BLOCKED.**

### 1.3 The consumed set — is it the union? (BLOCKED, probed cell by cell)

For a **round bond** the consumption set is exactly the union of

- every `escalationLog[*].roundBondProofHash` (the reducer's `consumed` scan and
  the barrier's `seenRoundBonds`), and
- **every** accepted challenge bond of the case (`state.challenges`, r33-1).

Four probes, all pinned: (a) a challenge bond is refused as a round bond;
(b) a fresh hash is accepted and recorded; (c) the same hash one round later is
refused (`already consumed by round 2`); (d) an independent case accepts it
again (r33-3). For a **membership bond** the consumption set is only the case's
own challenge ledger — there is no cross-case memory, which is the boundary the
host's bond registry closes (§1.4).

### 1.4 r33-3 — one bond, two cases (PARTIAL, still registered: host fix)

Unchanged from round 4 and re-pinned in §1.3(d): the machine cannot see another
case, so both a round bond and a membership bond are reusable across cases.
**Disposition: host fix (`unique index on the bond-proof hash`), owner the host
bond registry, trigger: arming per-round bonds (`requireRoundBond: true`) on any
deployment — the demo/mainnet posture documented in `REGISTERED_FINDINGS_SWEEP`
r33-3 stays DEFERRED-v0.14.** Not fixed here: the ledger that would close it
lives in the host, which this package cannot reach.

### 1.5 r38-2 — `requireRoundBond` × `hostEscalation`: the strict policy is inert for challengers (PARTIAL, documented + pinned)

**Probe.** A case created with **both** flags accepts a challenger escalation
with **no** per-round bond:

```ts
if (state.requireRoundBond === true && state.hostEscalation !== true) { throw … }
```

The `hostEscalation !== true` half exists so a break-glass case stays compatible,
and that behaviour is pinned by `perRoundBond.test.ts` › *'a break-glass case
stays compatible: the host already escalates free'* — i.e. it is a **decision,
not an oversight**, and reasoning alone does not repeal a pinned decision.

**Measured:** `resolvedRoundOne({ requireRoundBond: true, hostEscalation: true })`
escalates a *challenger* with `roundBondProofHash: null` and reaches
`ladder_pending`; the same escalation on a strict non-break-glass case throws
`requires a per-round bond witness`.

**Why it is still worth naming.** The stated justification — "the host may
already open rounds on its own authority, so demanding one from the challenger
prices nothing" — conflates the trusted operator with the untrusted challenger.
The host's free rung is an ops recovery by the operator; the challenger's free
rung is the r30-1 free option, restored. So on a case with both flags the strict
policy genuinely prices nothing at the margin, and a deployment that turns on
`hostEscalation` "for recovery" silently unprices the ladder.

**Disposition.** Documented (`docs/PER_ROUND_BOND.md` matrix + a "never compose
these two flags" paragraph), pinned (*'(registered r38-2) …'*), and **assigned to
the owner** as a v0.14 policy split (host authority and challenger authority
priced separately) — the fix is two conditions, but it changes a pinned
decision, so it is not a review-round edit. Until then: leave
`requireRoundBond` false on a break-glass deployment, or accept that its
challengers escalate free.

---

## 2. T2 — the complete ledger and the `onEscalate` barrier

The r33-5 fix has two halves: `assertValidEscalationLog` demands one record per
opened round (`ladderRound − 1`, or `ladderRound` while `ladder_pending`), and
`onEscalate` re-runs that barrier before a rung opens. Every attack the brief
names is pinned, and the accounting was re-derived by hand against every live
path before trusting it.

### 2.1 Order, duplicates, gaps (BLOCKED — three pins)

| forged ledger (`ladderRound = 3`, so 2 records are expected) | verdict |
|---|---|
| `[round 3, round 2]` — out of order | **refused** (`consecutive 2..k sequence`) |
| `[round 2, round 2]` — the same round opened twice | **refused** (same rule) |
| `[round 2, round 4]` — a skipped round | **refused** (same rule) |

The order test is `round !== offset + 2`, so it simultaneously enforces "first
record opens round 2", "consecutive", and "no duplicate" — a duplicate changes
the offset of everything after it. A gap is also caught by completeness
independently (2 records for 3 opened rounds), so the two rules fail closed
together rather than one masking the other.

### 2.2 A record whose challenger does not match the challenge record (BLOCKED)

Two probes, both refused: `challengerIdx` not in the case roster, and
`(challengerIdx, bondProofHash)` that no accepted challenge carries. The barrier
re-derives the pair rather than trusting either half — which is exactly why
r38-1 mattered: the pair is only meaningful if the pool it points at is unique.

### 2.3 Can the no-challenge path skip the barrier? (BLOCKED)

No. `onFinalize` calls `assertValidEscalationLog` unconditionally, and it is the
only transition into `final` (`TERMINAL_PHASES` is checked before dispatch). The
no-challenge case has `ladderRound = 0`, so completeness demands an **empty**
ledger, and a hand-injected record on that state is refused at `finalize`
(pinned). A challenge injected into a never-challenged case cannot be escalated
from without paying either — the strict policy refuses the free rung
(`requires a per-round bond witness`), which is the honest cost of the no-challenge
path being free.

### 2.4 The escalate-time barrier cannot be skipped by a later restore (BLOCKED)

`onEscalate` re-runs the barrier, so a snapshot restored with a doubled record
is refused with `phase` still `round_resolved` and `ladderRound` unchanged — no
panel seated, no seat spent. Pinned. `onFinalize` still runs it, so the verdict
path never depends on the escalate path having been taken.

### 2.5 Legacy cases keep the deletion residual, scoped (PARTIAL, documented)

Re-pinned at `ladderRound = 3`: a **strict** case with an empty log is refused,
a **legacy** case (`requireRoundBond` absent/false) is accepted — by design, a
pre-0.12 snapshot has no log and refusing it would make legacy cases
un-finalizable. The scope is now explicit in the barrier docstring ("a legacy
case keeps the documented deletion residual, which is exactly why a new
deployment must opt into the strict policy"). **Disposition: documented + pinned
(round 4's r33-5 residual, unchanged); the strict policy is the answer, and
r33-4's default flip is the owner decision that activates it.**

### 2.6 r38-3 — the log's `challengerPubkey` is unverifiable (r29-5 re-confirmed; PARTIAL → v0.14)

**Probe.** An escalation by juror 2 with `challengerPubkey = ff…ff` (a key no
participant holds) is accepted, and the log records it. The reason is
structural: `CourtConfirmationMachineState` carries `participantIndices` and no
idx→pubkey map, and `accept_challenge` records no key, so there is nothing to
compare against. The enforced binding is `(challengerIdx, bondProofHash)`; the
x-only pubkey is an audit annotation.

**Severity.** Low after r38-1: the escalation still costs a real bond of the
named *index* (and, under the strict policy, a real per-round bond), so the
pubkey cannot buy standing — it can only mislabel who paid in the audit trail
that hosts use for fee attribution and misconduct evidence. It is the same class
as r33-2 (the machine sees strings), one field further out.

**This is not a new finding**: `docs/FORMAL_INVARIANTS.md` INV-ESC-4 already
carries it as *"Residual (round 3, r29-5): the pubkey is not bound to the index
— state carries no idx→pubkey registry, so a relaying host can pair juror A's
index with juror B's key"*, and calls the binding a "v0.13 case-state change"
that v0.13 shipped without. Round 5 re-confirms it at the *barrier* (the round-4
fix re-derives `bondProofHash` but not the key), which is the useful part: the
restore barrier is as strong as the weakest field it re-derives.

**Disposition: deferred to v0.14** — `accept_challenge` gains the challenger's
x-only pubkey (making `(idx, pubkey)` a state binding at challenge time) and the
barrier requires `record.challengerPubkey === challenge.challengerPubkey`. That
is a snapshot-format change, not a review-round edit; pinned so the gap is not
mistaken for a verified field.

---

## 3. T3 — the sign-based bound and `derivedCap = 0`

### 3.1 Adversarial parameters (BLOCKED — 12-case matrix)

`deriveMaxLadderRounds`, `deriveLadderFlipRound`, `ladderSignBoundary` and
`escalationOptionEv` all throw a typed `Error` for: `a_f` ∈ {0, negative, NaN,
Infinity, 1.0001, `"0.9"`}, `rho` ∈ {0, negative, NaN}, `beta` ∈ {0, negative,
Infinity}, and a `params` object of the wrong shape (`undefined`). No path
returns a garbage number, `NaN` or `-0`; every throw is a message naming the
field and the value. Pinned.

### 3.2 `derivedCap = 0` propagation inside this package (BLOCKED)

For `a_f ∈ {0.3, 0.4, 0.45, 0.5}` at `β = ρ = 0.03`: `derivedCap = 0` and
`ladderCapWithinBound(...).ok === false` for **every** legal cap 1…5, with
`flipRound = 1`. `E[π(1)]` is strictly positive below break-even and exactly
zero at `a_f = ½` (so "0 ⇒ refuse every ladder" is never merely cautious — the
round it refuses is never a losing round for the challenger). Pinned across the
grid, including the implication `ok ⇒ E[π(cap)] < 0` and the stronger
`∀ R ≤ derivedCap: E[π(R)] < 0` (the contract that was false before r33-6).

### 3.3 The boundary itself: no epsilon in either direction (BLOCKED)

- At exact break-even (`a_f = ρ/(ρ+β) = ½`) the computed boundary is **exactly
  1** (`log(x)/log(x)`), so `derivedCap = 0` — no float drift can bless the
  break-even round.
- One step above (`a_f = 0.51`) the cap becomes 1 and `E[π(1)] < 0`, i.e. the
  gate opens exactly where the sign does.
- Monotonicity holds over both axes (never deeper for a worse jury — 12-point
  sweep; never shallower for a bigger bond — 8-point sweep, `β` from `1e-6` to
  `1e300`).
- Representability edges land on the **safe** side: a bond negligible next to `V`
  (`ρ = 1e308, β = 1e-300`) cancels to ratio 1 ⇒ boundary 0 ⇒ no safe depth
  (correct: a free bond makes round 1 profitable), and a bond astronomically
  larger than `V` underflows the ratio to 0 ⇒ boundary `Infinity` ⇒ the protocol
  ceiling. Neither produces a blessed cap.

### 3.4 r33-7 at the host: **not fixed**, and the vendored copy is pre-fix (r38-4)

The brief asks to verify the host now refuses an operator depth above the
derived bound. Probed `bao.markets` @ `65b7cef05` (the head that carries the R34
sweep):

1. **No call site.** `git grep` for `ladderCapWithinBound`,
   `deriveMaxLadderRounds` and `deriveLadderFlipRound` across `HEAD` returns
   documentation, the vendored package, and the vendored package's own tests —
   **nothing in `packages/api/src` or `src/`**. So `derivedCap = 0` has no
   consumer to propagate to: the contract "a host that reads only `derivedCap`
   must treat 0 as refuse every ladder" is currently a contract with no host.
2. **The freeze accepts any legal depth.** `resolveCourtCohortConfig`
   (`packages/markets/services/bao-markets/courtEconomicRatio.ts:375-394`)
   clamps `BAO_COURT_MAX_LADDER_ROUNDS` to `1..5` and then to the panel-growth
   ceiling (`round0Panel · 3^R ≤ 405`). Nothing economic enters the decision, and
   migration 233's `CHECK (court_max_ladder_rounds BETWEEN 1 AND 5)` agrees with
   it. An operator on a degraded jury (`a_f = 0.6`, `derivedCap = 0`) can still
   freeze a 3-deep ladder, and §3.2's pin shows the machine will play all three
   rounds (`reviewRound5.test.ts` › *'(registered r33-7) the machine runs a
   ladder the economics forbids'*).
3. **There is still no measured `a_f`.** `git grep -n accuracy --
   'packages/api/src/services/court/*'` returns nothing: the gate cannot be built
   from data the host does not have.
4. **New (r38-4): the copy the host would call is the pre-fix one.** The
   vendored `packages/lib/frost-court/ladderEconomics.ts` is **byte-identical to
   bao-court `v0.13.0`** (`diff` clean), i.e. it still ships
   `return Math.min(MAX, Math.max(1, derived))` and `ok: maxLadderRounds <= derivedCap`
   — the two halves r33-6 fixed. `packages/lib/frost-court/VENDORED.md` confirms
   the sync point is `v0.13.0` (= `c456fb4` + `3d07b36`), and
   `package.json` names `0.7.2` with a stale version field. So a host engineer
   wiring the r33-7 gate today would wire the **bug**: `derivedCap = 1` at
   `a_f = 0.45` and `ok(derivedCap?) = true` — the exact blessed profitable
   round r33-6 closed.

**Disposition (r38-4, host fix, two parts — no bare "deferred"):**

| step | owner | trigger |
|---|---|---|
| **vendor-sync `packages/lib/frost-court` to bao-court ≥ v0.13.1** (F5+F6 in this PR's parent release) and refresh `VENDORED.md`/`package.json` | host dependency sync | **immediately** — it is a prerequisite of the item below, and it is the only reason the r33-6 fix is unreachable at the host |
| run `ladderCapWithinBound` in the creation gate + boot audit, persist a measured `a_f` per cohort, refuse `422` with `derivedCap`/`flipRound`, treat `derivedCap = 0` as "no court adjudication on this rail" | host court creation gate (already recorded as r33-7, DEFERRED-v0.14, owner + trigger in `REGISTERED_FINDINGS_SWEEP.md`) | arming `enforce` on any deployment, or the first market created above its derived bound |

Not fixed in this PR: this package cannot gate a host it does not run, and the
vendor-sync is a separate repository's change.

---

## 4. T4 — the `Infinity` guard and the arithmetic around it

### 4.1 The guard covers every product (BLOCKED)

`earned = w0 · Πpenalties · bonus` is the only place two caller numbers multiply
past `Number.MAX_VALUE`; `floor = minWeightFactor · w0` cannot overflow
(`minWeightFactor ≤ 1`), and `w = anchor + (earned − anchor)·e^{−λ·idle}` cannot
either (the exponent is in `[0, 1]` and `earned` is checked finite). Measured:
`1e308 × 10`, `MAX × MAX`, `1e300 × 1e10` all throw; `1e308 × 1.0000001` and
`w0 = 1e308, idle = 1e308` return finite values. **BLOCKED**, 4 new pins.

### 4.2 No reachable path returns `NaN` or `Infinity` (BLOCKED)

Seven probes — a zero bonus (`earned = 0` → the floor), 100 000 penalties at
`factor 1e-300` (multiplier underflows to 0 → the floor), a subnormal factor, a
huge idle (`9.007e15`), a huge per-record age (`1e308`), a subnormal `w0`, and a
5 000-penalty multiplicative underflow — every result is finite and non-`NaN`.
The module's `Math.max(floor, weight)` tail cannot produce `NaN` because every
input to it is checked finite. **BLOCKED.**

### 4.3 The downstream backstop (BLOCKED)

Even a weight that escaped the reputation math cannot poison a draw: the lottery
input is validated where it is *used*. `weightedPriority` throws
`SELECTION_ARGUMENT` for `Infinity`, `NaN`, `0` and negatives, `jurorWeight`
throws for a `weightFn` that returns either, and `selectJury` surfaces it as a
typed `CourtArgumentError`. `quadraticPriority` clamps `r` instead, and stays
finite at `MAX_VALUE` stake. This is the property r33-9 protects from the other
end, now pinned from this end. **BLOCKED.**

### 4.4 `bigint` vs `number`, and weight × count (BLOCKED)

- The only BigInt-heavy module (`quorumEconomics.ts`) bounds its inputs at both
  ends — `panelSize ≤ 10_000`, `quorum ≤ panelSize`, share
  `denominator ≤ 1_000_000` — so `q^N` is a bounded exact integer, and the one
  deliberate BigInt→Number conversion (`exactRatioToNumber`) scales by the
  ratio's own decimal magnitude, so a `1e-400` tail converts to ~0 rather than
  `NaN`.
- There is **no `Σweights` sum** anywhere in the selection path (it uses
  exponential clocks, `-ln(r)/weight`), so the classic "weight × count overflow"
  does not exist by construction; `stakeCapacitySats` is clamped by
  `Math.max(1, …)` inside `quadraticPriority`.
- The per-round schedule is exact and bounded: `escalationBondMultiple(r) = 3^r`
  for `r ≤ MAX_LADDER_ROUNDS + 1`, throwing outside the ladder (pinned, so a
  host multiplying by `b₀` never receives `Infinity`).

### 4.5 r38-5 — a penalty expires **outright** at ~156 participating epochs (PARTIAL, doc precision)

`agePenalties`'s docstring says the multiplier is "asymptotic to 1 (a penalty
never expires outright)". In double precision it does: for `factor = 0.8` the
deviation `0.2·e^{−λ·age}` underflows and the multiplier is **exactly 1** from
`age = 156` participating epochs onward (155 → `0.9999999999999999`, 156 → `1`).

**Direction is safe** — the cliff forgives, never penalises: the weight never
exceeds `w0`, and it is monotone in age either way, so no attacker gains
anything. It is a *claim-vs-mechanism* item, and it is now pinned so the
asymmetry is stated rather than discovered: a host cannot rely on "the record
stays forever" as an accounting fact beyond ~52 half-lives. **Disposition:
documented + pinned (r38-5); no behaviour change — the alternative (an explicit
retention cap in the module) is a host policy, and the honest number is 156.**

---

## 5. Fixes shipped in this PR

| # | File | Change | Closes |
|---|---|---|---|
| F1 | `confirmationMachineHandlers.ts:197-210` | `accept_challenge` refuses a `bondProofHash` already bound to another roster index — one bond witness, one challenger's standing | r38-1 (EXPLOITABLE) |
| F2 | `confirmationMachineCore.ts:550-578` | `assertValidConfirmationLedger` applies the same uniqueness rule to a restored challenge ledger | r38-1 |
| F3 | `confirmationMachineTypes.ts` | `CourtChallengeRecord.bondProofHash` documents the uniqueness invariant **and** the collision case (`hash(bondTxid)` over a batch payout) a host must avoid | r38-1 consumer impact |
| F4 | `docs/PER_ROUND_BOND.md` | the reducer list gains the membership-pool invariant; the matrix gains a "never compose `requireRoundBond` with `hostEscalation`" paragraph; the test index gains round 5 | r38-1, r38-2 |
| F5 | `docs/FORMAL_INVARIANTS.md` | INV-CONF-17 becomes *"challenge bond binding — one witness, one owner"* (the uniqueness clause plus its barrier), and the index row cites round 5 | r38-1 |
| F6 | `CHANGELOG.md` | the r38-1 fix, its consumer impact, and the r38-2 composition hazard | this round |
| F7 | `__tests__/reviewRound5.test.ts` | 27 probes: 3 closures (all red on v0.13.1) + 19 property pins + 5 residual pins (named `(registered …)`) | this round |

No public API was removed. The only consumer-visible change is that a case can no
longer bind one `bondProofHash` to two participants — which was never a
legitimate state, and which the escaped form of 2026-11-11 shows was reachable
through the shipped events alone.

---

## 6. Residuals, with dispositions

| # | Residual | Where | Disposition |
|---|---|---|---|
| r38-1 | one bond witness bought N challengers' standing (two-step r29-1 bypass) | this package | **FIXED here** (F1+F2+F3), 3 closures red on v0.13.1 |
| r38-2 | `requireRoundBond` is inert against challengers on a `hostEscalation` case | this package | **documented + pinned + owner decision** (v0.14 authority split); do not compose the flags until then |
| r38-3 | the log's `challengerPubkey` cannot be verified (no idx→pubkey map) — **already registered as r29-5** | this package | **deferred to v0.14** (`accept_challenge` carries the pubkey); re-confirmed at the barrier, pinned, severity low after r38-1 |
| r38-4 | the host still freezes an unchecked ladder depth, **and** vendors the pre-fix `ladderEconomics.ts` | host (bao.markets @ `65b7cef05`) | **host fix, two parts**: (a) vendor-sync ≥ v0.13.1 **now** (prerequisite); (b) the r33-7 creation/boot gate with a measured `a_f` — existing owner + trigger |
| r38-5 | a penalty expires outright at ~156 participating epochs, contradicting "never expires" | this package (documented) | **documented + pinned**, no behaviour change (safe direction; the number is 156) |
| r33-3 | one bond spendable in two cases | host | unchanged: **host unique index**, DEFERRED-v0.14 (trigger: arming `requireRoundBond` on a deployment) |
| r33-5 | a **legacy** case's log can still be emptied | this package | unchanged: **documented + pinned**, scoped to `requireRoundBond: false`; closed by opting in |
| r33-7 | the frozen depth wins over the derived bound; no measured `a_f` | host | unchanged: **DEFERRED-v0.14**, now with r38-4(a) as a hard prerequisite |

Handover: the `r38-*` codes are the review-round namespace of *this* package, and
the host's disposition register is `bao.markets`
`docs/operations/REGISTERED_FINDINGS_SWEEP.md` (round 34, 107 items). r38-2
(owner decision), r38-3 (deferred-v0.14) and r38-4 (host, two parts) belong in
the next sweep of that document; they are stated with owner and trigger here so
the sweep has nothing to re-derive. The paper's appendix A.3 table carries the
`r29-*`/`r30-*` codes only — `REVIEW_ROUND_4.md` and this document are the
canonical record for `r33-*`/`r38-*` until the next paper refresh.

## 7. Suite evidence (this branch)

```
npx vitest run __tests__/reviewRound5.test.ts   # 27 passed
# same file, the three fixed files restored from origin/main: 3 failed (r38-1 ×3)

npm test
 Test Files  76 passed | 1 skipped (77)
      Tests  1713 passed | 1 skipped (1714)
   Duration  116.76s   (warm cache; 302.07s cold)

npm run typecheck          # tsc --noEmit — clean
npm run typecheck:tests    # tsc --noEmit -p tsconfig.test.json — clean
```

1,686 (v0.13.1, `CHANGELOG.md`) + 27 = **1,713**.
