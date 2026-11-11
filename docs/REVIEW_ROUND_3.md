# Review Round 3 — attacking the surface the round-2 fixes created

**Date:** 2026-11-11 · **Base:** `origin/main` @ 0364180 (v0.12.0) · **Branch:**
`docs/review-round-3` · **Scope:** the four items the round-2 audit
(`docs/REVIEW_ROUND_2.md`) and the host's response (`bao.markets` #2409,
`REVIEW_RESPONSE_R25.md`) shipped as *fixes* — the escalate witness, the derived
economic cap, the deterministic budget, provenance reconciliation.

**Method.** The round-2 audit asked whether each fix answered the reviewer. This
round asks the complementary question, and it is the harder one: **what did the
fix itself open?** Every target was attacked as an adversary with the reducer (or
the HTTP route, or the env var) in hand, not re-read as a reviewer. A finding is
`EXPLOITABLE` only when a test in this repository (or a cited host code path)
demonstrates the harm; otherwise it is `PARTIAL` (the guard exists but is
incomplete) or `BLOCKED` with the guard cited.

**What was executed for this audit**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound3.test.ts` (new) | **15 passed** — 4 of them failed before the fixes below |
| `npm test` | **1,561 passed / 1 skipped (66 files)** — see §6 |
| `npm run typecheck` | clean |
| Mutation probe on `budgetMs` (`return Number.POSITIVE_INFINITY`) | **survived 23/23 budgeted tests** before the fix, **killed 2/2** after (§3) |
| `SIM_BUDGET_MS=1` probe | fails at **1,236 ms** measured — the ceiling is live, not decorative (§3) |
| `node scripts/cross-check.mjs` | exit 0, unchanged (283 claims / 512 refs) |

**Verdict summary.** 1 EXPLOITABLE (fixed here) · 1 EXPLOITABLE-at-host
(registered, host repo) · 3 PARTIAL (2 fixed here, 1 registered) · the rest
BLOCKED. The escalate witness is structurally sound — bounds, replay and phase
guards all hold — but it bound the *bond hash to the case* rather than to the
*challenger*, so a juror who posted no bond could escalate on a bonded juror's
hash and the audit log named the wrong person. That is fixed and pinned.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | escalate witness | a non-bonded juror quotes a bonded juror's accepted bond hash | **EXPLOITABLE → fixed** (r29-1) |
| T1 | escalate witness | forged witness record appended to a restored snapshot, then finalized | **PARTIAL → fixed** (r29-2) |
| T1 | escalate witness | log inflation / cross-round replay / legacy restore / `hostEscalation` drift | **BLOCKED** (guards cited), 3 residuals registered |
| T2 | economic cap | split a large market into k sub-cap markets | **BLOCKED by construction** (§2.1) |
| T2 | economic cap | cap measured on a client-declared, creation-time liquidity; LP deposits unchecked | **EXPLOITABLE at host → registered** (r29-7) |
| T2 | economic cap | ladder depth is env-live at escalation, cap frozen at creation | **PARTIAL → registered** (r29-8) |
| T2 | economic cap | shadow-mode `would_reject` as a side channel | **BLOCKED** (§2.4) |
| T2 | economic cap | changelog advertises `deriveCourtEconomicCap()` — not in this package | **found, fixed by edit** (r29-9) |
| T3 | deterministic budget | a mutant that makes the ceiling infinite passes the whole suite | **PARTIAL → fixed** (r29-10, test-only) |
| T4 | witness × finality | verdict cites the wrong round; witness after `final`; witness-driven abort | **BLOCKED** (guards cited, 2 new pins) |

---

## 1. T1 — the escalate witness, attacked

The v0.12.0 witness is `{authority, challengerIdx, challengerPubkey, requestHash,
bondProofHash, roundIndex}` validated at `confirmationMachineHandlers.ts:487-588`
and appended to the frozen `escalationLog` (`confirmationMachineTypes.ts:105-129`).
The claims under attack are INV-ESC-1…8 (`docs/FORMAL_INVARIANTS.md:672-771`).

### 1.1 r29-1 — the bond was bound to the CASE, not to the CHALLENGER (EXPLOITABLE, fixed)

**Attack.** `onEscalate` accepted any `bondProofHash` that appeared in
`state.challenges` — with no check that the challenge belonged to the juror named
in `challengerIdx`:

```ts
// before (confirmationMachineHandlers.ts:544)
if (!state.challenges.some((c) => c.bondProofHash === event.bondProofHash)) throw …
```

A juror who posted **no bond** could therefore escalate by quoting a bonded
juror's hash. The escalation succeeded, and because the record is the audit
artifact hosts use to attribute misconduct and price fees, it named the wrong
challenger against the wrong bond.

**Repro.** `__tests__/reviewRound3.test.ts` › *'a juror with NO bond cannot
escalate on another juror's accepted bond hash'*. Before the fix it failed at the
escalation assertion (the spoof reached `ladder_pending`); the same witness
naming the bond's owner still succeeds. Note the **factory** was already safe —
`challengerEscalationEvent` refuses `challengerIdx` without a matching challenge
(`courtConfirmationMachine.ts:336-343`) — which is exactly the round-2 threat
model: the hostile party is a host that speaks the reducer directly, and the
reducer was the hole.

**Fix (shipped).** Bind both halves — `confirmationMachineHandlers.ts:544-555`:

```ts
if (!state.challenges.some(
  (c) => c.idx === (idx as number) && c.bondProofHash === event.bondProofHash,
)) throw new CourtConfirmationTransitionError(
  'escalation bond proof hash does not match an accepted challenge bond of this challenger');
```

The model checker's independent property was codified with the same weak check
(`__tests__/modelCheckingCore.ts:994`), so it *agreed with the bug* — a textbook
mutual-assurance failure. It is now stated as
`c.idx === record.challengerIdx && c.bondProofHash === record.bondProofHash`
(*'P2: escalation bond bound to THAT challenger's accepted challenge (r29-1)'*).

**Residual (registered, r29-5).** The witness binds a bond hash to an *index*,
not to a *pubkey*: `challengerPubkey` is caller-supplied and never compared with
any registry. A host that relays an escalation can put juror A's index next to
juror B's key. Closing it needs an idx→pubkey pin in the case state (a v0.13 API
change), and INV-ESC-4 now says so.

### 1.2 r29-2 — the witness log had no tamper barrier (PARTIAL, fixed)

**Attack.** `onFinalize` re-verifies the confirmation ledger and the outcome
history (`assertValidConfirmationLedger`, `assertValidOutcomeHistory`) because a
hand-restored snapshot must not steer a verdict. The new `escalationLog` — an
input to **fee attribution and misconduct penalties** — was not re-verified
anywhere. A restored `fee_settlement` snapshot could append a record naming a
juror who never escalated, a round that was never opened, or a bond that juror
never posted, and finalize minted a canonical verdict on top of it. The verdict
hash deliberately does not cover the log (the log is not an adjudicating input),
so nothing downstream would notice.

**Repro.** Two tests, both failing before the fix:
*'a forged escalation record on a restored snapshot is refused at finalize'*
(record for round 3 of a two-round case, naming a juror with no bond) and
*'a host-authority record cannot appear on a case that never allowed it'*.

**Fix (shipped).** `assertValidEscalationLog` (`confirmationMachineCore.ts:313-413`)
called from `onFinalize` (`confirmationMachineHandlers.ts:692`). It enforces:
consecutive `2..k` rounds, no record for a round the case never opened, finite
non-decreasing timestamps, `challenger` records that name a roster participant
**and** that participant's own accepted bond, and `host` records only under the
frozen `hostEscalation` policy with no challenger fields.

A **short** log is accepted on purpose (see 1.5): deletions remain
host-attestation (INV-ESC-6), because a deleted entry and a pre-0.12 state are
indistinguishable. That boundary is now written down instead of implied.

### 1.3 Spam, replay, cost — BLOCKED, with the bound and the cost named

| Attack | Outcome | Guard |
|---|---|---|
| Repeated `escalate` in one phase | **BLOCKED** | phase gate `confirmationMachineHandlers.ts:491-495`; `escalate` only from `round_resolved` |
| Open the same round twice | **BLOCKED** | after `escalate` the phase is `ladder_pending`; `open_ladder_round` needs `round === ladderRound + 1` (`:245-250`) |
| Inflate the log | **BLOCKED** | `log.length >= MAX_LADDER_ROUNDS` (`:505-508`) **and** the ladder cap (`maxLadderRounds ≤ 5`); a hand-restored log at the bound is refused (pinned) |
| Replay a witness on to the next round | **BLOCKED** | `roundIndex !== ladderRound + 1` (`:517-521`) — pinned by *'a witness minted for round r cannot be replayed on to round r+1'* |
| Replay across cases | **BLOCKED** at the machine | the check reads `state.challenges` only, so a foreign case's hash proves nothing **unless the same bond is accepted by both cases** (r29-4) |

**Cost (registered, r29-3).** The bound is structural, not economic: one accepted
challenge bond funds **every** round of the same case. A challenger who posted a
single bond can force up to `maxLadderRounds − 1` extra panels (3× seats each)
at no incremental stake — pinned as *'one accepted bond can fund every round of
the same case (registered residual)'*. Whether escalation should require a fresh
bond per round (appeal fee) is an economic-design decision for the owner, not a
safety bug: the loss is bounded at 4 extra rounds, the per-round work is
recorded (`record_fee`), and `non_participation` clawbacks price the panel side.

**Cross-case bond reuse (registered, r29-4).** `accept_challenge` validates only
the *shape* of `bondTxid`/`bondProofHash` (`:175-176`) and does not require the
hash to be unused by another case — the machine cannot see other cases. If a host
accepts one on-chain bond as the challenge bond of two cases, one bond backs two
escalation rights and two slashing claims. The host must dedupe bond hashes in
its bond registry (a unique index on `bond_proof_hash`), and the escalation route
currently verifies bonds with `formatOnlyBondVerifier`
(`bao.markets` `packages/api/src/routes/courtEscalation.ts:180`,
`CourtEscalationService.ts:421-422`) — a hex regex, not a chain check. The
machine's r29-1 binding is what makes that acceptable *within* a case; it cannot
make it acceptable across cases.

### 1.4 `hostEscalation` (default false) — config drift, and why it is not a brick

A host that needs break-glass ops recovery must set `hostEscalation: true` **at
case creation**, because the policy is frozen with the case
(`courtConfirmationMachine.ts:307`, fail-closed at `:559-563`). A host that
discovers the need later cannot retrofit it. That is deliberate — but it is not
a liveness hazard, and the test proves it: with the policy off, `concede` is
still legal from `round_resolved` and drives the case to `fee_settlement`
(*'a refused escalation cannot abort or move the case'* ends on exactly that
transition). The cost of the wrong setting is *appeal depth*, not a stuck case.

**Residual (registered, r29-6).** `hostEscalation` lives in the state, so a
hand-restored snapshot that flips it to `true` is honoured (pinned in the test as
a documented limitation). The policy is only as trustworthy as the snapshot the
host signs; the log barrier of 1.2 at least makes a *forged use* of it visible at
finalize.

### 1.5 Legacy snapshots — restore and finalize both survive

The v0.12.0 reducer normalises an absent `escalationLog` to `[]` before dispatch
(`courtConfirmationMachine.ts:407-409`), and `assertValidEscalationLog` accepts a
short log. Pinned by two tests: *'pre-0.12 snapshots without an escalation log
normalise to an empty ledger'* (v0.12.0) and, new here, *'a pre-0.12 snapshot (no
escalationLog) still finalizes'* — a 0.11-shaped state at `fee_settlement`
finalizes to a canonical `verdictHash`. **The witness does not make legacy
snapshots un-restorable**, which was the specific risk in adding a required
array field to a frozen state.

---

## 2. T2 — the derived economic cap (host-side)

`deriveCourtEconomicCap()` is **not in this package** (see 2.5). The
implementation is `bao.markets`
`packages/markets/services/bao-markets/courtEconomicRatio.ts` (617 lines,
`V_max = γ·s₀·N` in the floor regime, unbounded at/above the 112-seat scale-free
threshold, γ single-sourced at 0.45), wired at market creation
(`packages/api/src/routes/markets.ts:2052-2103`). All probes below are against
that file at the hosted head; this repository can only register the findings.

### 2.1 Splitting a large market into k sub-cap markets — BLOCKED by construction

**Attack.** At the shipped 45-seat rung the cap is 101,250 sats. Split a
1,000,000-sat dispute into ten 100,000-sat markets: each passes.

**Why it is not a bypass.** Bonds are posted **per case**, so the aggregate
capacity scales with the number of markets:

| | k = 1 (500k market) | k = 6 × 83,333 sats |
|---|---|---|
| stake / juror | max(2 %·500,000, 5,000) = 10,000 | max(1,667, 5,000) = 5,000 |
| Σ over 45 jurors | 450,000 | 225,000 per market → 1,350,000 total |
| γ·ΣS | 202,500 **< 500,000 → refused** | 101,250 per market **≥ 83,333 → allowed** |

Splitting *raises* the total bond to 1.35 M sats to put 500 k at risk, i.e. the
attack costs the adversary more capital, not less. There is no aggregate
per-creator bound and none is needed **for the capital invariant** — Θ(ΣV) ≤
γ·ΣΣS holds market-by-market. What splitting *does* buy is independent panels
(ten 45-seat juries instead of one), which is a collusion-replication cost, not a
cap breach. The residual is operational: ten cases, ten fee ledgers, ten
escalation rights.

The one way to get one bond to cover two exposures is the cross-case bond reuse
of r29-4 — that, not the split, is the aggregate hole.

### 2.2 r29-7 — the cap measures a self-declared creation-time number (EXPLOITABLE at host, registered)

**Attack.** At creation the gate reads `body.liquidity`:

```ts
// packages/api/src/routes/markets.ts:1862-1879
const requestedLiquidity = typeof body.liquidity === 'number' ? body.liquidity : 0;
…
const marketLiquidity = poolModel === 'amm'
  ? Math.max(AMM_MIN_LIQUIDITY_SATS, requestedLiquidity) : …
```

and only then evaluates the cap (`:2052-2067`). Two consequences:

1. **The creator picks the number the cap is compared against.** A market that
   declares `liquidity` at the AMM minimum passes on any real value.
2. **The value at risk grows after creation and is never re-assessed.** LP
   deposits are a separate route — `POST /v1/amm/liquidity`
   (`packages/api/src/routes/amm.ts:411-490`, `addLiquidity` at `:470`, amount
   `>= 1000`, market must be `active`) — with no economic-ratio call anywhere in
   that file (`courtEconomicRatio` appears only in `markets.ts` and `server.ts`).

So: create at 100,000 sats (inside the 101,250 cap), then add 1,000,000 sats of
LP depth. The adjudicating panel is still 45 seats with 225,000 sats of bonds
against 1.1 M at risk — γ·ΣS/V = 0.09. This is the reviewer's "advisory-by-default
cap" objection returning in a worse form: the cap is a **creation-time gate on a
declared number**, not a bound on the value at risk.

**Fix shape (host, registered).** Re-assess on every value-increasing path
(LP deposit, position open) against the market's *current* at-risk value, or
derive the cap from `marketLiquidity + Σ lp_deposits` at each deposit; the
decision should reuse `evaluateCourtEconomicRatio` with the same rail and cohort.
Until then the honest description is "creations above the cap are refused;
deposits are not".

### 2.3 r29-8 — cap frozen at creation, ladder read live at escalation (TOCTOU, registered)

The cap is computed at creation from `resolveCourtCohortConfig()`
(`markets.ts:2060` → env `BAO_COURT_MAX_LADDER_ROUNDS`), while the case's
adjudicating depth is read **again from the env at escalation time**
(`packages/api/src/services/court/CourtEscalationService.ts` via
`resolveMaxLadderRounds()`, `routes/courtEscalation.ts:177`). Nothing freezes the
ladder on the case row for arbitration purposes.

- Raising the env between creation and escalation (2 → 3) is *safe*: the panel
  grows to 135 seats, capacity only increases.
- **Lowering it (3 → 2) is not**: a market priced under an unbounded cap at
  creation is later adjudicated by a 45-seat panel whose capacity is 101,250
  sats. The invariant V ≤ γ·ΣS is violated retroactively, silently.

This is a governance footgun rather than an attacker lever (only the operator
moves the env), but it is exactly the TOCTOU the review asked about, and the
runbook's own advice — "raise `BAO_COURT_MAX_LADDER_ROUNDS` to 3 **first**, then
re-shadow, then arm" (`docs/operations/ECON_RATIO_RUNBOOK.md:94`) — is a
procedure, not a guard.

**Fix shape (host, registered).** Persist `maxLadderRounds` on the case row at
creation and use that value for both the cap and the escalation; add a boot guard
that refuses an env value below the deepest priced rung of any live case.

### 2.4 Shadow-mode metrics as a side channel — BLOCKED

`BAO_COURT_ECON_RATIO=shadow` records
`bao_court_econ_ratio_would_reject_total{rail,reason}` and a structured
`would_reject` log line carrying `market_value_sats`, `max_market_value_sats`,
`ratio`, `panel_size`, `adjudicating_round`, `gamma` (`markets.ts:2087-2103`).
Every input is public: the value at risk is the market's own declared liquidity,
the cap is published in the runbook and the warning message itself quotes it
("this ladder's cap is 101,250 sats"). The decision label is derived arithmetic,
not hidden state. Nothing here reveals a secret, a juror, a vote or a verdict.
The only inference available to an outside observer is the operator's ladder
configuration — which the refusal message at `:2073-2085` discloses verbatim in
`enforce` mode anyway. No fix.

### 2.5 r29-9 — the changelog advertises an export this package does not have (found, fixed by edit)

`CHANGELOG.md` (v0.12.0) reads: *"**Economic security cap derived, γ
single-sourced at 0.45**: `deriveCourtEconomicCap()` — `V_max(N) = γ·s₀·N` …
shadow mode `off|shadow|enforce` with `would_reject` metrics, boot guard and
ECON_RATIO_RUNBOOK"*. It is listed under **this** package's release with no
qualifier, and `grep -r deriveCourtEconomicCap . --exclude-dir=node_modules`
returns exactly one hit: that changelog line. The function, the metrics and the
runbook live in `bao.markets`. A consumer pinning `@bao/court` v0.12.0 and
looking for the cap finds nothing — the same class of provenance defect as round
2's N5/N7, in the release notes rather than the paper.

**Fix (shipped).** The bullet now names the owning repository and path, and the
matching line in `docs/REVIEW_ROUND_3.md` is the trace. This is a documentation
fix only: no behaviour changes, and the cap remains a host-side control.

---

## 3. T3 — the deterministic budget

The v0.12.0 replacement (`__tests__/helpers/budget.ts`, `SIM_BUDGET_MS` default
30 s) is the right shape: deterministic assertions first, a generous ceiling
second, an env override for slow boxes. Two questions were probed.

### 3.1 r29-10 — the helper was unpinned, so a vacuous ceiling survived the suite (PARTIAL, fixed test-only)

**Attack.** Mutate the helper to return an infinite ceiling and ask whether any
test notices:

```diff
-  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
+  return Number.POSITIVE_INFINITY; // MUTANT
```

Result: `npx vitest run __tests__/simulateCourt.test.ts
__tests__/adversarialNostr.test.ts` → **23 passed**. The two call sites assert
`elapsed < budget`, which is *always true* under the mutant, and nothing pinned
the helper itself. So the answer to "can a test silently pass without asserting
anything because of the budget?" was **yes — by mutating the helper**, and the
mutation was invisible to the whole 1,546-test suite at the time of the probe
(the tree is 1,561 after this PR). The new test file kills it
(2 of the 3 T3 tests fail under the mutant).

**Fix (shipped, test-only).** `__tests__/reviewRound3.test.ts` T3 pins: default
30,000 ms, finite when the variable is absent, fallback to the default for junk
(`''`, `' '`, `'abc'`, `'0'`, `'-1'`, `'NaN'`, `'Infinity'`), an explicit
override honoured (`2500`, `120000`), and the ceiling's *ordering* property
(> 5 s, < the 60 s vitest timeout, so a 100× regression trips an assertion rather
than a timeout). No production change.

### 3.2 Is any test vacuous under the budget? — no, and here is the audit

| Budgeted test | Deterministic assertions BEFORE the ceiling | Ceiling |
|---|---|---|
| `simulateCourt.test.ts:37` (whole pipeline) | `r.ok`, exact eight-step order, every step green, 5 selected, group key hex, attestation valid, 5,000 sats slashed, 4 LN settled / 1 cancelled, `tex1` address, broadcast txid | — |
| `simulateCourt.test.ts:75` (load-insensitive) | `r.ok`, eight-step order, all steps green | 30 s |
| `adversarialNostr.test.ts:318` (100k-tag scan) | `result.valid === false`, `result.error` matches `/1\.\.10000/` | 30 s |

Every ceiling is preceded by behavioural assertions, so no test passes *because
of* the budget. The ceilings are also live:

- measured baseline **1,236 ms** (pool 20 / jury 7) on this box;
- `SIM_BUDGET_MS=1` → the assertion fails with
  `pipeline took 1236ms; budget 1ms` — the ceiling is not a tautology;
- 30 s = **24× baseline**, so a 100× regression (≈124 s) fails, a 10× box does
  not — the designed behaviour, and the brief's "a 10× slower CI box would still
  pass" is correct and intended.

**Residual (registered).** The vitest per-test timeout is still absolute
(`{ timeout: 60_000 }`, `simulateCourt.test.ts:12`), i.e. 48× baseline. A box
loaded past that would fail as a *timeout*, not as a clean assertion — the exact
flake class the round-2 fix set out to eliminate, one layer down. A future
change should either drop the per-test timeout (leaving the assertion) or make
it derive from `budgetMs`.

---

## 4. T4 — witness × finality

### 4.1 A finalize with an escalation in the log cites the right round — BLOCKED (new pin)

`onFinalize` mints the verdict from the LAST resolved round's winning votes when
the case was challenged (`confirmationMachineHandlers.ts:723-733`), and the
escalation log is not an input to the verdict hash. Pinned by *'finalize after an
escalation cites the LAST resolved round and the right votes'*: a case escalated
to round 2, resolved YES there, conceded, then finalized produces
`outcome = YES` and `supportingEventIds` equal to **round 2's** winning vote ids
(sorted) — round 1's NO votes appear nowhere — while the witness log is carried
into the final state verbatim. The round is right because the escalation moves
`ladderRound` through `open_ladder_round` (`:251`), not through the log.

### 4.2 A witness after `final` — BLOCKED (new pin)

`TERMINAL_PHASES = {final, expired, aborted}` is checked before dispatch
(`courtConfirmationMachine.ts:438-440`), so *'no witness can be added after
final'* throws `cannot process escalate after final`, the phase stays `final` and
the log is the **same object** (no copy, no append). The restore-path variant —
append a record to a *pre-final* snapshot — is r29-2, now refused by
`assertValidEscalationLog`.

### 4.3 Can a challenger witness force an abort (griefing)? — BLOCKED

`escalate` cannot abort: `abort` is a distinct event (`onAbort`) and a refused
escalation throws before any state is produced. Three probes (non-bonded
challenger, foreign bond, malformed request hash) each throw a
`CourtConfirmationTransitionError` and leave `phase`, `failure` and
`escalationLog` untouched. The remaining grief surface is economic, not
state-corrupting: a *legal* escalation forces a 3× panel (r29-3). Liveness is
preserved — `concede` and `abort` remain reachable from `round_resolved`.

---

## 5. Fixes shipped in this PR

| # | File | Change | Closes |
|---|---|---|---|
| F1 | `confirmationMachineHandlers.ts:544-555` | the escalation bond must belong to **this** challenger (`idx` + hash), not merely to the case | r29-1 (EXPLOITABLE) |
| F2 | `confirmationMachineCore.ts:313-413` | new `assertValidEscalationLog` restore barrier (consecutive rounds, bounded, monotone, challenger-own-bond, host-policy) | r29-2 |
| F3 | `confirmationMachineHandlers.ts:692` | `onFinalize` calls the log barrier alongside the ledger and history barriers | r29-2 |
| F4 | `__tests__/modelCheckingCore.ts:994` | the independent model-check property now states the `idx` binding (it agreed with the bug) | r29-1 |
| F5 | `__tests__/reviewRound3.test.ts` (new, 15 tests) | the four attacks above, the bounds, the legacy-restore and finality pins, and the budget-helper pins | T1, T3, T4 |
| F6 | `__tests__/escalationWitness.test.ts:146-155` | the v0.12.0 message regex follows F1 and points at the new test | r29-1 |
| F7 | `CHANGELOG.md` | the econ-cap bullet names `bao.markets` and its path instead of implying an export here | r29-9 |
| F8 | `docs/FORMAL_INVARIANTS.md` | INV-ESC-4/5 restated, new **INV-ESC-8** (log barrier), traceability row, invariant/test counts | r29-1, r29-2 |

Total production diff: **~100 lines in two files** — a five-line predicate change in
`onEscalate`, one call site in `onFinalize`, and the new guard with its JSDoc.
Everything else is tests and documentation. No public export changed; the
`escalate` event shape is unchanged, so no consumer breakage beyond the tighter
predicate (an escalation that quoted another juror's bond now fails — which is
the point).

## 6. Verification

```
$ npm test
 Test Files  65 passed | 1 skipped (66)
      Tests  1561 passed | 1 skipped (1562)
   Duration  200.28s
```

(typecheck and the probe logs are reproduced in the PR body.)

## 7. Residuals registered (not fixed here)

| # | Residual | Severity | Where the fix goes |
|---|---|---|---|
| r29-3 | one challenge bond funds every round of the same case (no per-round appeal cost) | LOW (bounded at 5 rounds) | economic design — `docs/proofs/economics/02-ladder.tex.md` / host fee policy |
| r29-4 | one on-chain bond can be accepted as the challenge bond of two cases; the escalation route verifies bonds with a hex regex (`formatOnlyBondVerifier`) | MAJOR | host bond registry (unique `bond_proof_hash`) + a real chain verifier |
| r29-5 | `challengerPubkey` is not bound to `challengerIdx` (no idx→pubkey registry in state) | MEDIUM | v0.13 case-state API (`challengerKeys`) |
| r29-6 | `hostEscalation` is only as trustworthy as the signed snapshot that carries it | MEDIUM | host-side state hash over the whole state (including the log) |
| r29-7 | the cap measures client-declared creation liquidity; LP deposits are never re-assessed | MAJOR (host) | `packages/api/src/routes/amm.ts` — re-assess on deposit |
| r29-8 | cap frozen at creation, ladder depth read live from env at escalation | MAJOR (host) | persist `maxLadderRounds` per case + boot guard |
| — | per-test vitest timeout (60 s) is still an absolute gate | LOW | derive from `budgetMs` or drop |

None of these is reachable by an unprivileged actor through this package's public
API; r29-7 and r29-8 are reachable in the host deployment and are the two that
should be fixed next.

## 8. What this round says about the fix it attacked

The witness is a genuine improvement: the unwitnessed `escalate` is a typed
error, `ladder_pending` has exactly two entry transitions, the round is
machine-checked, and the log is bounded and now tamper-barriered. What round 2
did not test was **what the witness is bound to**. It bound the bond to the case
and called it done; the challenger half of the same sentence was left to the
factory helper, which the hostile-host threat model does not use. That is the
general lesson worth carrying into round 4: *every binding asserted in prose must
be asserted in the reducer, per-actor, or the audit artifact records the wrong
actor* — and an independent property checker that mirrors the implementation
cannot catch the mirror.
