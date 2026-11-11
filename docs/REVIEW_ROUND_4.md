# Review Round 4 — attacking the v0.13.0 surface

**Date:** 2026-11-11 · **Base:** `origin/main` @ 3d07b36 (v0.13.0) · **Branch:**
`docs/review-round-4` · **Scope:** the newest layer — the per-round escalation
bond (`roundBondProofHash` / `requireRoundBond`, R31), the derived ladder bound
(`ladderEconomics.ts`), the decay pairing (`penaltyAging.ts`), and the host's
churn cap (bao.markets R31a / migration 233 + 234).

**Method.** Rounds 2 and 3 reviewed and then attacked the *previous* fixes. This
round takes the v0.13 surface and attacks it from the inside: the reducer is the
adversary's API (a hostile host speaks it directly), the pure helpers are called
with hostile parameters, and the host's gate is read as source because this
package cannot run it. Each finding below is one of:

- **EXPLOITABLE** — a test in this repository (or a cited host path) shows the
  harm; fixed here or, if host-only, must be fixed in the host before arming;
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited.

`EXPLOITABLE = fix now`: three of this round's findings were cheap and are
shipped here (§5). Everything else is a registered residual with a fix shape.

**What was executed for this audit**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound4.test.ts` (**new**, 21 tests) | **21 passed** |
| the same file against the unfixed base (`git show origin/main:<file>`) | **6 failed** — every closure is real, not asserted after the fact |
| `npm test` (full suite) | **1,677 passed / 1 skipped (74 files + 1 skipped file)** — §7 |
| `npm run typecheck` | clean |
| host probe (bao.markets @ 77e63c222, source audit + its own tests) | §4, no runnable cross-repo harness |

**Verdict summary.** 2 EXPLOITABLE (both fixed here) · 1 EXPLOITABLE-at-host
(registered) · 4 PARTIAL (1 fixed, 1 barrier hardened, 2 registered) · the rest
BLOCKED. The headline is that **R31's consumption test is real but narrower than
its documentation claims**: the machine enforces *one distinct hash per rung*,
and a hostile host can satisfy that with a hash nobody ever paid (§1.5). The
second headline is in the host and unchanged from R31a: **the churn cap is inert
on demo and mainnet unless an operator states the cohort** (§4.1).

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | per-round bond | another challenger's **membership bond** relabelled as this round's payment | **EXPLOITABLE → fixed** (r33-1) |
| T1 | per-round bond | a restored snapshot with the log **emptied** reuses a consumed bond and opens a free rung | **EXPLOITABLE → fixed** (r33-5) |
| T1 | per-round bond | the witness is a uniqueness test, not a payment test (never-paid hash) | PARTIAL → registered (r33-2) |
| T1 | per-round bond | a bonded rival **front-runs** a paid witness and burns it | PARTIAL → registered (r33-2b) |
| T1 | per-round bond | the same round bond spent in **two cases** | PARTIAL → registered (r33-3) |
| T1 | per-round bond | the shipped DEFAULT is the legacy free option | PARTIAL → registered + documented (r33-4) |
| T1 | per-round bond | `assertValidEscalationLog` at every finalize path incl. no-challenge | **BLOCKED** (guard + new no-challenge pin) |
| T2 | derived bound | a sub-½-accurate jury: `derivedCap = 1` blessed the **profitable** round 1 | **EXPLOITABLE → fixed** (r33-6) |
| T2 | derived bound | frozen depth above the derived bound; nothing at creation checks it | PARTIAL → registered (r33-7) |
| T3 | decay pairing | idle gaps hand weight back / anchor not at the floor | **BLOCKED** (5 new pins incl. huge idle) |
| T3 | decay pairing | overflow: finite inputs → `Infinity` weight | **PARTIAL → fixed** (r33-9) |
| T3 | decay pairing | `ageEpochs` is a caller input: a wall clock restores the r30-4 idle path | PARTIAL → registered (r33-8) |
| T3 | decay pairing | `minWeightFactor: 1` silently disables every penalty | PARTIAL → registered, documented (r33-8b) |
| T4 | churn cap (host) | cohort inflation by sybil registration | **BLOCKED** — admin-scoped admission (§4.2) |
| T4 | churn cap (host) | unmeasured cohort ⇒ **no cap change at all** on demo/mainnet | **EXPLOITABLE-at-host → registered** (r33-10) |
| T4 | churn cap (host) | `COUNT(*)` counts admitted-but-dead keys: the cohort is an upper bound | PARTIAL → registered (r33-11) |
| T4 | churn cap (host) | TOCTOU: escalation gate is two unserialised statements | PARTIAL → registered (r33-12) |

---

## 1. T1 — the per-round escalation bond, attacked

The v0.13 witness is `roundBondProofHash` (`confirmationMachineTypes.ts:122-132`),
validated at `confirmationMachineHandlers.ts:566-620` and re-derived at
`finalize` by `assertValidEscalationLog` (`confirmationMachineCore.ts:315-430`).
The claims under attack are INV-ESC-9 and the compatibility matrix in
`docs/PER_ROUND_BOND.md`.

### 1.1 r33-1 — another juror's MEMBERSHIP bond was a legal per-round bond (EXPLOITABLE, fixed)

**Attack.** `onEscalate` compared the round bond with the escalating
challenger's own membership bond and with the log — and with nothing else:

```ts
if (roundBondProofHash === (event.bondProofHash as string)) throw …   // own membership only
const consumed = log.find((r) => r.roundBondProofHash === roundBondProofHash);
```

A case with two bonded challengers (jurors 2 and 3) therefore let juror 3
escalate quoting **juror 2's accepted challenge bond** as its own per-round
payment. The password was already in the state: `state.challenges` holds every
accepted bond. Consequences: a paid witness is billed to someone else, it is
consumed out of the case's ledger (juror 2 can no longer use it), and the log
records juror 3 as the payer of a bond it never posted — the exact attribution
failure r29-1 fixed one layer up, reintroduced for the new field.

**Repro.** `reviewRound4.test.ts` › *'refuses ANOTHER challenger's accepted
membership bond as this round's payment (r33-1)'*. On the unfixed base the
escalation reaches `ladder_pending` with `roundBondProofHash = ee…ee` (juror 2's
bond); with the fix it throws and the log stays empty.

**Fix (shipped).** Both layers, same rule:

```ts
// confirmationMachineHandlers.ts:601-608 (reducer)
const membershipBond = state.challenges.find((c) => c.bondProofHash === roundBondProofHash);
if (membershipBond) throw new CourtConfirmationTransitionError(…);
// confirmationMachineCore.ts:404-411 (restore barrier, same refusal)
if (state.challenges.some((c) => c.bondProofHash === roundBondProofHash)) throw …
```

Pinned also at finalize (*'refuses a relabelled membership bond at finalize too'*).

### 1.2 r33-5 — the log could be emptied, and the consumed bond reused (EXPLOITABLE, fixed)

**Attack.** `assertValidEscalationLog` accepted a SHORT log on purpose (a
pre-0.12 snapshot has none). That exemption is harmless for an *audit* artifact
and fatal for a *consumption ledger*: deleting a record also un-consumes its
bond hash. A restored snapshot at `round_resolved` (round 2, one record paid
with bond `H`) with `escalationLog: []` passed the barrier, and the next
`escalate` reused `H` — a free third rung on a bond the case had already spent.
`onEscalate` did not call the barrier at all, so the rung opened; `finalize`
later refused with *'escalation log rounds must be a consecutive 2..k
sequence'*, i.e. the exploit had already cost a 3×-seated round **and** bricked
the case. The same shape works with only the LAST record dropped (rounds 2 and 3
recorded, delete round 3's, reuse its hash for round 4).

**Repro.** *'a restored snapshot with EVERY record deleted cannot reuse a
consumed bond (r33-5)'* and *'deleting only the LAST record is refused as well'*.
Both reach `ladder_pending` on the unfixed base.

**Fix (shipped).** Two halves:

1. **Completeness** (`confirmationMachineCore.ts:338-353`): the ledger must hold
   one record per opened round — `ladderRound − 1`, or `ladderRound` while a
   round is pending. Enforced whenever the case **has** records (so any deletion
   is caught) *and* unconditionally for `requireRoundBond === true` (so a strict
   case cannot be emptied at all). A legacy case with no records keeps the
   documented deletion residual, which is exactly why a new deployment must opt
   into the strict policy.
2. **Escalate-time barrier** (`confirmationMachineHandlers.ts:521`): `onEscalate`
   re-runs `assertValidEscalationLog` before a rung opens, so a tampered
   snapshot is refused *before* the panel is seated instead of at finalize.
   `onFinalize` still calls it — the verdict path does not depend on the
   escalate path having run.

No over-correction: *'a legacy (0.11/0.12) case with no log still escalates and
finalizes'* and *'a never-challenged strict case finalizes with an empty ledger'*
both pass.

### 1.3 r33-2 — the witness is a uniqueness test, not a payment test (PARTIAL, registered)

**Attack.** Under `requireRoundBond: true`, a never-paid 32-byte hash
(`hexId('9')`) is a legal per-round bond: the reducer validates shape,
distinctness and non-consumption, and nothing binds the hash to an escrow, an
amount, or even a chain. `docs/PER_ROUND_BOND.md` says "one fresh witness per
rung is a property of the state" — true of *uniqueness*, false of *payment*.

**Why it is not EXPLOITABLE at the machine.** The machine cannot see a chain, and
the challenge bond has the same division of labour (`accept_challenge` validates
shape; the host verifies the witness before dispatch — r29-4 already records that
`formatOnlyBondVerifier` is a hex regex). But the asymmetry matters for the
economics: for the *membership* bond the machine can at least tie a hash to a
juror via `state.challenges`; for the round bond it cannot tie it to anything.
The r30-1 pricing is therefore only as real as the host's per-round
verification, and the document must say so (it now does).

**Fix shape (v0.14).** An accepted-round-bond ledger, mirroring
`accept_challenge`: `accept_round_bond {idx, round, bondTxid, bondProofHash}`
verified by the host before dispatch, with `escalate` required to name an entry
of `(idx, round)`. That makes ownership a state property and closes 1.4 too.

**Pinned:** *'(registered r33-2) the witness is a UNIQUENESS test, not a payment
test'*.

### 1.4 r33-2b — a bonded rival can burn a paid witness by front-running (PARTIAL, registered)

**Attack.** Juror 2 posts and verifies a fresh bond `R` for round 2. Juror 3,
also bonded, escalates first using `R` as its own per-round bond. Juror 2's
escalation with `R` is then refused ("already consumed by round 2"). Because the
machine cannot tell whose bond a hash is, the *order* of two legal events decides
who is billed, and the loser's payment is spent under the winner's name.

**Bound.** Only one `escalate` per resolved round is possible at all (the phase
moves to `ladder_pending`), so this is not a way to open extra rungs — it is
attribution theft plus griefing of a rival's bond, and it requires the attacker
to already hold an accepted challenge bond (a paid member of the case). The
victim's remedy is the fee ledger and the host's bond registry.

**Pinned:** *'(registered r33-2b) a second bonded challenger can burn a paid
witness by front-running'* — it documents the refusal, and shows the same hash
succeeds from the pre-escalation state, so the harm is ordering, not
authentication. Fix shape: 1.3's ledger (+ an ownership check), not a string
comparison.

### 1.5 r33-3 — one round bond, two cases (PARTIAL, registered)

**Attack.** The consumption set is the case's own `escalationLog`, so the same
hash is consumable once per case. Two cases, one payment: each machine sees a
"fresh" witness. Same class as the challenge-bond reuse r29-4 (the machine cannot
see other cases).

**Fix shape (host).** A unique index on the bond-proof hash in the host's bond
registry (the r29-4 remedy), applied to round bonds as well as challenge bonds.
**Pinned:** *'(registered r33-3) one round bond can be spent in two DIFFERENT
cases'*.

### 1.6 r33-4 — the shipped default is the legacy free option (PARTIAL, registered + documented)

**Probe (measured, not inferred).** `createCourtConfirmationMachine({…})` with no
`requireRoundBond` yields `requireRoundBond === false` and `maxLadderRounds === 2`
(`courtConfirmationMachine.ts:290,318`), and a witness with no round bond is
accepted on that case — a challenger reaches round 3 and 4 on the **one**
membership bond, i.e. `ΔC = 0`, the r30-1 finding, live in the default config.
The hosted deployment is on the permissive path twice over: `bao.markets`
vendors **v0.12.0** (`packages/lib/frost-court/package.json`) and has no
`roundBond`/`requireRoundBond` reference anywhere, and its production code does
not drive this machine (only the synthetic-juror harness imports
`hashCourtConfirmation`).

**Why it is not fixed here.** The matrix in `docs/PER_ROUND_BOND.md` is a
deliberate, documented compatibility decision: flipping the default silently
changes the ladder semantics of every *new* case and, for a host that has not yet
wired per-round bond verification, turns escalation into a 409. That is an owner
decision with a host-side prerequisite, not a review-round edit. What this round
owes the owner is the plain statement and a pin that fails the day the default
changes:

**Pinned:** *'(registered r33-4) the shipped default is the LEGACY free option'*.

**Fix shape.** (i) flip the factory default to `true` when the host wires the
bond (restore keeps reading absent as `false`, so old snapshots still load);
(ii) until then, require an explicit choice (`requireRoundBond` **mandatory** in
the create params) so no deployment gets the free option by omission; (iii) the
host records the policy on the case row next to `court_confirm_quorum` so an
auditor can query which live cases are strict.

### 1.7 Does the barrier cover EVERY finalize path, including no-challenge? — BLOCKED (pinned)

`onFinalize` calls the barrier unconditionally (`confirmationMachineHandlers.ts:755`),
before it mints the verdict, and it is the only transition into `final`
(`TERMINAL_PHASES` is checked before dispatch, so nothing can move a state into
`final` another way). The paths are:

| path | `ladderRound` | log | barrier verdict |
|---|---|---|---|
| never challenged → `close_challenge_window` → `fee_settlement` → final | 0 | `[]` | accepted (new pin) |
| challenged, resolved at the cap → `fee_settlement` → final | R | R−1 | accepted |
| escalated k times, conceded → `fee_settlement` → final | k+1 | k | accepted |
| restored with a dropped record (either policy) | R | < R−1 | **refused** |

The no-challenge row was not pinned before: a strict case with `ladderRound = 0`
could have tripped a completeness rule. It is now a test
(*'a never-challenged strict case finalizes with an empty ledger'*), so the guard
is complete without over-correcting.

---

## 2. T2 — `deriveMaxLadderRounds` versus the freeze

### 2.1 r33-6 — the clamp blessed a PROFITABLE round (EXPLOITABLE, fixed)

**Attack.** `deriveMaxLadderRounds` returned
`clamp(floor(boundary), 1, MAX_LADDER_ROUNDS)`. When a jury's accuracy on
manufactured disputes is at or below `ρ/(ρ+β)` (½ at `β = ρ`), the boundary is
`≤ 1`, round 1 is **already profitable**, and there is no safe depth at all. The
clamp reported `1` anyway, and `ladderCapWithinBound` compared
`maxLadderRounds <= derivedCap`, so the host pre-flight returned
`{ ok: true, derivedCap: 1, flipRound: 1 }` — approving the one round the
economics forbids, and contradicting its own docstring ("`E[π] < 0` for every
`R <= deriveMaxLadderRounds`"). The measured grid:

| `a_f` | old `derivedCap` | old `ok(cap=1)` | `E[π(1)]` |
|---|---|---|---|
| 0.45 / 0.4 / 0.3 | 1 | **true** | +0.024 / +0.03 / +0.039 |
| 0.75 | 2 | true (`cap 2`) | −0.0047 |
| 0.9 | 5 | true (`cap 2`) | −0.0186 |

This is the *jurisdiction that matters least for the cap and most for the
attack*: a degraded or captured jury is precisely where a deeper ladder must be
refused, and the gate said yes.

**Repro.** *'never approves a cap at or above the flip round (r33-6)'* — fails on
the unfixed base at `a_f = 0.45`, and re-checks the implication `ok ⇒ E[π(cap)] < 0`
over the whole grid (`a_f` 0.55…1 × cap 1…5).

**Fix (shipped).** `deriveMaxLadderRounds` returns **0** ("no safe depth") when
the boundary is `≤ 1`; `ladderCapWithinBound.ok` is decided by the **sign**
(`maxLadderRounds < flipRound`), not by a comparison against the clamped cap.
Both are pinned to the published rows (5/2/1 at `a_f` 0.9/0.75/0.7), and the
consumers' contract is written down: a host that reads only `derivedCap` must
treat `0` as "refuse every ladder".

### 2.2 r33-7 — the frozen depth wins, and nothing at creation checks it (PARTIAL, registered)

**Question.** A market frozen at 3 rounds whose `a_f` admits 2: who wins? **The
frozen config**, and nothing refuses it:

- **In this package:** the machine has no `a_f` and must not invent one, so a case
  with `maxLadderRounds: 5` is constructible while `ladderCapWithinBound` says a
  `0.75` jury admits 2. Pinned: *'(registered r33-7) the machine accepts a frozen
  depth ABOVE the derived bound'*.
- **In the host:** `bao.markets` creation writes the frozen pair
  (`routes/markets.ts:2211` → migration 233 `court_max_ladder_rounds`) from
  `BAO_COURT_MAX_LADDER_ROUNDS`, and **no code path calls
  `deriveMaxLadderRounds` / `ladderCapWithinBound` / `deriveLadderFlipRound`**
  (`git grep` over the hosted head returns only this package's own tests). Worse,
  there is **no measured `a_f` anywhere in the host** — no accuracy table, no
  per-jury calibration input — so the "cap the ladder from the measured accuracy"
  instruction in `docs/PER_ROUND_BOND.md` §"What the host must do" (3) is, today,
  unexecutable: the number it needs does not exist.

**Fix shape (host).** (i) Persist a measured `a_f` per cohort (the share of
manufactured challenges a panel rejects) and run `ladderCapWithinBound` in the
creation gate next to the economic-ratio check, refusing `422` with
`derivedCap`/`flipRound` in the payload; (ii) the same check in the boot audit
over live cases, which turns existing over-bound markets into a visible list
rather than a silent one; (iii) if `derivedCap = 0`, refuse court adjudication
for that rail entirely (fail closed to the rail's non-court path) instead of
freezing a ladder.

---

## 3. T3 — `agePenalties` / `pairedJurorWeight`

### 3.1 Idle gaps — BLOCKED (five new pins)

The r30-4 exploit was the idle *reset*: wait long enough, get your weight back.
Re-tested with deliberate idle gaps (`idleEpochs` 0…12, plus
`Number.MAX_SAFE_INTEGER`) across five penalty records:

| property | result |
|---|---|
| `w(idle)` non-increasing in idle, every penalty set | **holds** (pin) |
| a floored juror is **exactly** the floor for every idle, incl. huge | **holds** — `50` at 0, 1, 3, 6, 13, 1000, 9.007e15 |
| a bonus fades *toward* `w0` (120 → 110 at 3 epochs → 100 at ∞) | **holds** |
| ageing is monotone and idling-independent (0.80 → 0.90 → 0.975) | **holds** |
| a partially penalised juror is dragged **down** by idling, not preserved | **holds** (55 at idle 9 vs 90 at idle 0) |

The last row is the subtle one and it is now explicit in the module: the anchor is
the floor, so idling never leaves a juror at an aged (better) weight — the aged
value has to be re-earned by participating. That is the direction 06 §4.3
requires, and the test states it so nobody "fixes" it into a reset.

NaN / negative / non-finite inputs all throw (`w0`, `idleEpochs`, `factor`,
`ageEpochs`, `minWeightFactor`), so the floor is not reachable by garbage.

### 3.2 r33-9 — finite inputs, infinite weight (PARTIAL, fixed)

`pairedJurorWeight({ w0: 1e10, bonusMultiplier: 1e308 })` returned `Infinity`:
both inputs are finite and pass every guard, but `earned = w0 · Π · bonus`
overflows. The weight is a lottery/selection input, where `Infinity` silently
dominates every comparison and poisons every average. The module's own rule is
"a non-finite parameter is a caller bug", so the same rule now applies one step
later: `earned` must be finite, else throw (`penaltyAging.ts:176-183`). Pinned by
*'refuses an overflowing bonus instead of returning Infinity (r33-9)'*, with a
large-but-representable bonus still accepted.

### 3.3 r33-8 — the participating clock is a caller input (PARTIAL, registered)

`pairedJurorWeight` ages penalties by whatever `ageEpochs` the host stored (it
passes `epochs = 0` to `agePenalties`). If the host stores "epochs since
incurred" — a wall-clock difference — the r30-4 idle path returns: the juror
serves the penalty by *waiting*. The module cannot tell the two apart, so this is
a data-provenance requirement, not a code defect. Written into the module
docstring and registered.

**Fix shape (host).** Persist a per-juror `participating_epochs` counter (epochs in
which the juror was seated *and* voted) and derive `ageEpochs = participating_now
− participating_at_incurrence`; a boot audit that recomputes the two clocks and
flags rows where the wall clock ran ahead of the participation clock.

### 3.4 r33-8b — `minWeightFactor: 1` disables every penalty (PARTIAL, pinned + documented)

The floor is also the anchor, so `minWeightFactor: 1` (`floor = w0`) leaves
nothing to decay: a `0.1×` penalty scores **full weight**. The guard allows `1`
(`minWeightFactor <= 1`) as "no floor below w0", which is self-defeating — "no
floor" is `0`, and `0` is already rejected. Not fixed by narrowing the range
(that would break a host that deliberately runs without a floor and re-open a
behaviour change in a review round); documented in the module and pinned by
*'(registered r33-8) `minWeightFactor: 1` disables every penalty'*.

---

## 4. T4 — the churn cap (host, bao.markets @ 77e63c222)

`assessCourtCohortCapacity` (`packages/api/src/services/court/CourtCohortCapacity.ts`)
recomputes the cap at `min(N_cfg, drawable cohort)` and flags `cap_degraded`; the
gate is called at creation, at `addLiquidity` and at escalation
(`routes/courtEscalation.ts:163-180`). Four attacks.

### 4.1 r33-10 — "unmeasured" means no cap change, and demo/mainnet are always unmeasured (EXPLOITABLE-at-host, registered)

`resolveDrawableCourtCohortSize` returns the env override if set, else
`COUNT(*) FROM court_jurors` on **testnet only**, else `null`. On `null`,
`assessCourtEconomicRatio` sets `cohortUnmeasured` and applies **no** tightening,
so `capDegraded` is false and every gate passes. The host's own test asserts it:

```ts
// CourtCohortCapacity.test.ts › 'a demo deployment without a stated cohort is UNMEASURED — no change'
expect(result!.cohortUnmeasured).toBe(true);
expect(result!.capDegraded).toBe(false);          // and capEffectiveSats is the policy cap
```

So on the two deployments the project actually runs, the r30-2 churn defence is
**off by default**: the 135-frozen → 45-drawable case is only caught if an
operator remembered to set `BAO_COURT_DRAWABLE_COHORT`. The demo drawable set is
bond-holder based and per-case, which is why the env exists — but "unknown"
should not mean "unbounded" for an *escalation* gate.

**Fix shape (host).** Treat an unmeasured cohort as the **measured minimum** for
value-increasing decisions: either (a) refuse escalation with
`409 COURT_CAP_DEGRADED_UNMEASURED` (concession stays free, as today) unless the
deployment states a cohort, or (b) substitute the *observed* seated panel from
the last resolved round of this case (a lower bound the database already has) and
flag it. Junk/negative overrides already degrade to unmeasured — with (a) that
becomes fail-closed instead of fail-open.

### 4.2 Can an attacker inflate the drawable cohort? — BLOCKED (as shipped)

- `court_jurors` is written only by `admitJuror` (`courtJurorAdmission.ts:47-56`)
  behind `POST /admin/court/jurors` with `requireAuth` + `requireScope('admin')`
  (`routes/admin.ts:254-285`), plus the operator env seed
  (`BAO_COURT_JUROR_PUBKEYS`). The schema's `source` CHECK admits only
  `operator`/`turnstile`, and **no turnstile path exists** — so there is no
  self-registration: sybil inflation requires admin compromise.
- `BAO_COURT_DRAWABLE_COHORT` is an operator statement (env), parsed as a
  non-negative safe integer; a **larger** value only *loosens* this deployment's
  own cap and cannot affect another network's admission table.
- The count is *not* snapshot-shared with the frozen panel: `min(N_cfg, cohort)` is
  computed from the frozen row, so a cohort *above* `N_cfg` cannot raise the cap
  beyond what creation priced (`courtStricterCap` keeps
  `min(cap_at_creation, cap_effective_now)`).

So the "sybil → cohort inflation → the exploit returns" chain does not exist as
shipped. Two real weaknesses remain, both data-quality rather than identity:

### 4.3 r33-11 — `COUNT(*)` counts admitted-but-dead keys: the cohort is an upper bound (PARTIAL, registered)

`SELECT COUNT(*)::int AS count FROM court_jurors` counts *admissions*, while the
panel that can actually be seated is `admitted ∩ reachable` (the coordinator
seats from the same table; an offline key is a seat the draw cannot fill). The
r30-2 harm is precisely "the seated panel is smaller than the frozen rung", so an
admission count that includes non-participants re-opens a smaller version of it —
bounded by how stale the roster is, and invisible because nothing compares
`seated` with `N_min(V)` at draw time.

**Fix shape (host).** Count a key only if it has published a court event within
the retention window (or has a live bond), and re-check `seated ≥ N_min(V)` when
the coordinator draws; if the draw comes up short, flag `cap_degraded` and refuse
the *next* value-increasing action.

### 4.4 r33-12 — the escalation gate is two unserialised statements (PARTIAL, registered)

`assessCourtCohortCapacity` runs `readCourtCapacityRow` (one `pgQuery`) and then
`resolveDrawableCourtCohortSize` (a second `pgQuery`) with **no transaction** when
the caller omits `client` — and `routes/courtEscalation.ts:164` omits it. The
exposure basis (`markets.liquidity + amm_pools.liquidity_l`) can therefore move
between the two reads, and a concurrent `addLiquidity` (which *does* hold the
pool row lock, per `courtExposureGate.ts`'s contract) can commit after the
escalation gate read the old basis. Two requests each pass against the pre-state:
the classic TOCTOU, in the same module that exists because of a TOCTOU (r29-8).

**Fix shape (host).** Run the assessment inside one transaction with
`SELECT … FROM markets WHERE id = $1 FOR SHARE` (or the pool row lock) so the
basis and the cohort are read from one snapshot and a concurrent deposit
serialises against it; the route currently passes no `client`, which is the
one-line tell.

---

## 5. Fixes shipped in this PR

| # | File | Change | Closes |
|---|---|---|---|
| F1 | `confirmationMachineHandlers.ts:601-608` | a per-round bond may not be **any** accepted challenge bond of the case (not just the escalating juror's own) | r33-1 (EXPLOITABLE) |
| F2 | `confirmationMachineCore.ts:404-411` | the restore barrier applies the same rule at finalize | r33-1 |
| F3 | `confirmationMachineCore.ts:338-353` | the escalation log must be **complete** (one record per opened round); a strict case may never be emptied | r33-5 (EXPLOITABLE) |
| F4 | `confirmationMachineHandlers.ts:521` | `onEscalate` re-runs the log barrier before a rung opens | r33-5 |
| F5 | `ladderEconomics.ts:133` | `deriveMaxLadderRounds` returns **0 = no safe depth** when the boundary is ≤ 1 | r33-6 (EXPLOITABLE) |
| F6 | `ladderEconomics.ts:202` | `ladderCapWithinBound.ok` is **sign-based** (`cap < flipRound`), so the gate can never approve a profitable cap | r33-6 |
| F7 | `penaltyAging.ts:176-183` | an overflowing `earned` weight throws instead of returning `Infinity` | r33-9 |
| F8 | `penaltyAging.ts` (docstring) | the participating clock, the `minWeightFactor: 1` hazard and the exact anchor contract are written down | r33-8, r33-8b |
| F9 | `__tests__/reviewRound4.test.ts` | 21 probes: 6 closures (all red on the unfixed base) + 9 registered pins + the no-challenge finalize path | this round |

No public API was removed; `deriveMaxLadderRounds` can now return `0`, which is
the only consumer-visible change and is documented as "no safe depth" (a host
that treated the old clamp as a legal cap was being told the wrong thing).

---

## 6. Residuals registered (owner decides, host fixes)

Disposition of every row in this table: `bao.markets`
`docs/operations/REGISTERED_FINDINGS_SWEEP.md` (round 34, with an owner and the
trigger that would force each one).

| # | Residual | Where | Fix shape |
|---|---|---|---|
| r33-2 | the per-round witness is a uniqueness test, not a payment test | this package | `accept_round_bond` ledger (v0.14) |
| r33-2b | a bonded rival can front-run and burn a paid witness | this package | same ledger + ownership binding |
| r33-3 | one round bond spendable in two cases | host | unique index on the bond-proof hash (r29-4 remedy) |
| r33-4 | the shipped `requireRoundBond` default is the free option; the host vendors v0.12 and never opts in | this package + host | flip the default when the host wires the bond, or make the flag mandatory; record it on the case row |
| r33-7 | the frozen depth wins and is never checked against the derived bound; no `a_f` is measured anywhere | host | creation + boot-audit `ladderCapWithinBound`; persist measured `a_f` |
| r33-8 | `ageEpochs` is caller-supplied: a wall clock restores the idle path | host | persist a participating-epoch counter; audit the two clocks |
| r33-8b | `minWeightFactor: 1` disables penalties | this package (documented) | use `< 1` (default 0.5); consider rejecting `1` in v0.14 |
| r33-10 | unmeasured cohort ⇒ no cap change on demo/mainnet | host | fail closed for value-increasing actions when the cohort is unknown |
| r33-11 | the cohort counts admitted-but-dead keys | host | count recently-participating keys; re-check `seated ≥ N_min(V)` at draw |
| r33-12 | the escalation gate reads its inputs unserialised (TOCTOU) | host | one transaction + row lock |

## 7. Suite evidence (this branch)

```
npm test
 Test Files  74 passed | 1 skipped (75)
      Tests  1677 passed | 1 skipped (1678)
   Duration  264.72s

npm run typecheck   # tsc --noEmit — clean
npx vitest run __tests__/reviewRound4.test.ts   # 21 passed
# same file with the four source files restored from origin/main: 6 failed
```

The six red-before-green tests are r33-1 (×2), r33-5 (×2), r33-6 and r33-9.
