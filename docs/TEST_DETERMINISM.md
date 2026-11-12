# Test determinism

Why this document exists: the Court suite spent months producing **red runs on
trees with no code change**. Each round raised a budget. This round removes the
class, so that during a 100-hour soak **every red means something**.

Read this before adding a test, a timeout, a `setTimeout`, or a random value.

---

## 1. The failure this removes

Measured, not hypothetical (2026-11-12, 16-core box, vitest 4.1.12):

| Observation | Result |
|---|---|
| Full suite, no config, ambient load (~load 60, foreign CPU hogs) | **19 failures, all `Test timed out in 5000ms`**, two runs, **different files each time** |
| The same 9 suspect files under a controlled hog (20 busy loops) | **37 failures over 7 iterations, 100 % `Test timed out in 5000ms`** |
| Every failing file run alone | green |
| Worst single test, idle | ~2 s (`propertiesValidator` PV4) |
| Worst single test, loaded | **22 s** — 11× the ceiling that aborted it |

Two facts follow, and they are the whole design:

1. **The ceiling was never chosen.** The repo had no `vitest.config.ts`, so
   vitest's 5000 ms default applied to **1473 of 1523 tests**. FROST DKG,
   threshold signing and signature validation are CPU-bound; a 5 s ceiling on a
   2 s test is a coin flip once the box is busy.
2. **Raising a number hides it.** One agent's response to the same flake was
   `npx vitest run --testTimeout=60000`. The failures stop; nothing about the
   suite became deterministic. A test that only passes because the ceiling is
   huge is not passing, it is *not failing yet*.

The 5 s gate had a third, worse property: it produced **two false mutation
"captures" (M40/M47)** — a mutation campaign scored a mutant as "killed" because
the box was busy, and an external reviewer reproduced it (docs-only tree → 12
red, green on re-run). A flaky gate does not merely annoy; it corrupts results
that other work depends on.

---

## 2. The rules

**R1 — Never assert elapsed time as behaviour.** Assert the deterministic work:
step count/order, iteration count, state transition, outcome, recorded input.
`expect(elapsed).toBeLessThan(5000)` measures the box, not the code. This rule
already existed in prose; `determinismGuard.test.ts` now fails the build on it.

**R2 — Never sleep as synchronisation.** `await new Promise(r => setTimeout(r,
0))` is a wall-clock bet on the event loop. Worse, it is the *vacuity* class: the
assertion after it observes a partially-drained chain, so a regression that would
double-emit is invisible. Use `drainJobs()` / `drainUntil()` from
`__tests__/helpers/async.ts` — bounded by **iteration count**, never milliseconds.

**R3 — Seed everything, and print the seed.** An unseeded fuzz that finds a
crash publishes an unreproducible result. Use `mulberry32()` / `childRng()` from
`__tests__/helpers/rng.ts`; read the seed from an env var so any red run replays
verbatim (`FUZZ_SEED=… npm test`).

**R4 — A watchdog must exist, be derived, and be proven live.** Where a real
ceiling is unavoidable (a hang detector on a big scan, a flood ingest), it must
come from `budgetMs()` — env-overridable, generous — and its liveness must be
proven by an actual run, not assumed. `determinismGuard.test.ts` starts a
deliberately hung test in its own process and asserts the timeout fires. **A
watchdog that is never proven live is the vacuity class**: the old 5 s gate
"existed" for months and never once fired for the right reason.

**R5 — A per-test timeout is derived, never a literal.** Use
`testTimeoutFor(budget)` / `derivedTimeout(env)` / the `heavyTimeout()` /
`processTimeout()` / `scaleTimeout()` tiers. The derivation guarantees the
ordering that matters — `assertionBudget < testTimeout` — so a clean assertion
always gets to fire before vitest aborts (the r29-11 rule). Same for a
**child process**: `childTimeoutFor(testTimeout)` stays at 90 % so the child
reports its own reason instead of being preempted.

**R6 — Sort before comparing.** Object key order is insertion order, and an
array built from a `Set`/`Map`/relay fan-out is not a stable choice. `.sort()`
before `toEqual`, or assert membership (`toContain`) instead of sequence.

**R7 — No retries, ever.** `retry: 0` is pinned in `vitest.config.ts` and
asserted by the guard. A retry converts a real race into a green tick.

---

## 3. The inventory

Every wall-clock dependency in `__tests__/`, classified. `line` refers to the
post-fix tree.

### 3.1 Wall-clock reads — 41 sites (48 lines)

| Site | What | Class | Disposition |
|---|---|---|---|
| `appealCoordinator.test.ts` 40, 52, 86, 93, 206, 213, 248, 355, 362, 434, 441, 492, 499, 543, 550, 618, 625, 688, 695, 788, 795 (21) | fixture anchors: `resolutionTimestamp: now − 10s`, `reselectDeadline: now + 10s` | legit | Clock **is the subject** under test (deadline arithmetic). Offsets are ±10 s, 10 000× the 1 ms resolution hazard, so a second rollover cannot flip a verdict. |
| `lnSettlement.test.ts` 97, 101, 104 | `expiresAt: now + 3600`; `expect(heldAt).toBeLessThanOrEqual(now)` | legit | Monotonic upper bound read *after* the call; one-sided, so it cannot race. |
| `nip59.test.ts` 22, 54 | `created_at: now` | legit | Fixture timestamp; the assertion is about wrapping/unwrapping, not the value. |
| `appealWatcher.test.ts` 54, 66 | `committedAt`, `registeredAt` | legit | Fixture anchors (30 days back — far outside any boundary). |
| `adversarialNostr.test.ts` 609, 613 | fixture `committedAt`, `registeredAt` | legit | Same. |
| `modelCheckingCore.ts` 384, 644; `scale/index.ts` 225; `scale/corpus.ts` 265 | `performance.now()` → reported `wallMs` | legit | **Reporting only** — never asserted. A campaign report may carry a duration; a verdict may not. |
| `reviewRound11.test.ts` 798, 816 | hang detector on the exact-bound scan | **real bug → fixed** | Was a literal `toBeLessThan(5000)`. Now `SCAN_BUDGET_MS` (env `LADDER_SCAN_BUDGET_MS`), timeout derived from it. |
| `r30InboxOutboxLoad.test.ts` 84, 95, 139 | watchdog on a 10 000-call ingest | **real bug → fixed** | Was `toBeLessThan(120_000)` under a **120 000 ms timeout** — identical values, so the abort always won and the message named a timeout instead of the regression. Now `FLOOD_BUDGET_MS` (30 s) with `testTimeoutFor()` = 60 s. |
| `simulateCourt.test.ts` 92, 94 | watchdog on the end-to-end pipeline | watchdog (already derived) | `SIM_BUDGET_MS`, 30 s, env-tunable; deterministic step-list asserted **first**. This file is the model the others were brought to. |
| `adversarialNostr.test.ts` 321, 330 | watchdog on the 100 k-tag rejection | watchdog (already derived) | `VALIDATOR_BUDGET_MS`; timeout was a literal `30_000` **equal to the budget** (ordering violation) — now inherits the derived 60 s default. |
| `determinism/watchdogProbe.test.ts` 36, 37, 43 | the deliberate hang | deliberate | Excluded from the suite; run only by the liveness proof. |

### 3.2 Timers used as synchronisation — 3 sites

| Site | What | Class | Disposition |
|---|---|---|---|
| `courtSigner.test.ts` 51 (original) | `setTimeout(r, 1)` to make a mock bunker async | latent flake | **fixed** → `await Promise.resolve()`. A signer is async, not timer-bound; the only effect of the timer was to make the test's runtime depend on the host's timer phase. |
| `appealWatcher.test.ts` 123 (original) | `setTimeout(r, 0)` before `expect(onResolution).toHaveBeenCalledTimes(1)` | **real bug (vacuity)** | **fixed** → `await drainJobs()`. The `0 ms` sleep observed a half-drained chain, so a regression that double-emitted after the sleep was invisible. |
| `appealWatcher.test.ts` 112 (original) | `vi.waitFor(...)` | latent flake | **fixed** → `drainUntil(predicate, 64, label)`. |
| `taprootSpend-live.test.ts` 148 | `sleep(ms)` between chain polls | legit — **allowlisted** | Waits for a **third party** (a real network), not for our own code; there is no deterministic drain to replace it. Env-gated (`BAO_LIVE_TAPROOT`) and not in the default suite. |
| `r33ByzantineRelay.test.ts` 92 (original) | `--deadline-ms=2500` passed to the ceremony harness | **real bug** | **fixed** → `CEREMONY_PHASE_DEADLINE_MS` (20 s, env-overridable). This literal decided the **verdict**: under load the honest reordering scenario reported `completed: 0, signatures: 0` and the test failed on `report.failures`. A healthy ceremony scored as broken because the box was busy. |
| `r30MultiProcessCeremony.test.ts` 50 (original) | `--deadline-ms=4000` | **real bug** | **fixed** → same constant. A loaded run mis-classified a good DKG as `DKG_MISSING_PARTICIPANT`. |
| `r30MultiProcessCeremony.test.ts` 87 (original) | `expect(report.latencyModel.phaseDeadlineMs).toBe(4000)` | latent | **fixed** → pins `CEREMONY_PHASE_DEADLINE_MS`, i.e. the derivation, so the harness and the test can never desynchronise. |

### 3.3 Per-test timeouts — 50 declarations

| Class | Count | Disposition |
|---|---|---|
| **Literal, single-line** `{ timeout: 120_000 }` etc. | 44 | **derived** → `heavyTimeout()` / `processTimeout()` / `scaleTimeout()`, preserving each ceiling exactly |
| **Literal, redundant** `{ timeout: 60_000 }` / `{ timeout: 30_000 }` (compensating for the 5 s default) | 6 | **deleted** → inherit the derived 60 s global |
| **Literal, legacy trailing argument** `}, 300_000)` | 6 | **derived** or bound to `MODEL_CHECK_TIMEOUT`. Found only by the AST guard — line greps miss the multi-line form. |
| **Already derived** (`SIM_TIMEOUT`) | 3 | kept |

Net: **0 literal per-test timeouts**, 50 derived, 1 global deriving from env.

### 3.4 Unseeded randomness — 5 sites

| Site | What | Class | Disposition |
|---|---|---|---|
| `adversarialParserFuzz.test.ts` 159 (original) | 200-round tag-mutation fuzz | latent flake (non-reproducible red) | **fixed** → `mulberry32(FUZZ_SEED)`, `FUZZ_SEED` env-overridable |
| `propertiesBatch.test.ts` 271 (original) | Fisher-Yates shuffle in the root-determinism test | latent flake | **fixed** → `mulberry32(0x5b0ff1e)` |
| `appealWatcher.test.ts` 56 (original) | `priority: Math.random()` in a juror fixture | latent flake | **fixed** → `priorityFor(idx)` (seeded, unique per juror) |
| `adversarialNostr.test.ts` 607 (original) | `priority: Math.random()` | latent flake | **fixed** → `priorityFor(idx)` |
| `helpers/rng.ts` 9 | doc comment | n/a | — |

### 3.5 Object-key-order iteration — 17 sites

All `Object.keys` / `Object.entries` comparisons either `.sort()` first
(`differentialWire`, `reviewRound9`, `regressions`, `escalationRequestWire`,
`independentDkg`, `r30InboxOutboxLoad`, `propertiesBatch`) or assert
non-membership (`not.toContain`), which is order-insensitive by construction.
`courtNip46.test.ts:438` deliberately reverses `Object.entries(...)` to prove
field order does not matter — deterministic per spec, so **legit**.

### 3.6 Float thresholds — 0 in scope

`ladderEconomics`, `mechanisedArtifacts`, `penaltyAging`, `ladderBoundExact` use
`toBeLessThan` / `toBeGreaterThan` on **pure arithmetic over constants**. No
clock, no RNG, no allocation order — deterministic on every host. **Legit.**

### 3.7 Child-process bounds

| Site | Was | Now |
|---|---|---|
| `r33ByzantineRelay.test.ts` 77 | `timeout: 180_000` = test timeout | `childTimeoutFor(processTimeout())` (162 s inside 180 s) |
| `r30MultiProcessCeremony.test.ts` 43 | `timeout: 120_000` = test timeout | `childTimeoutFor(heavyTimeout())` (108 s inside 120 s) |
| `differentialWire.test.ts` 130 | `timeout: 300_000` inside a test **with no declared timeout** (i.e. 300 s child inside vitest's 5 s default) | `childTimeoutFor(scaleTimeout())` inside `{ timeout: scaleTimeout() }` |

---

## 4. How the rules are enforced

`__tests__/determinismGuard.test.ts` — 12 tests, two jobs.

**Part A proves the watchdog is live.** It spawns the deliberate-hang probe in
its own vitest process and asserts:

* an awaited hang is **aborted** at the timeout (the probe records a completion
  marker; the marker is absent, yet the process exits — impossible without a
  live watchdog);
* a **synchronous** loop is **not** preempted (the marker `IS` written despite a
  200 ms ceiling — the timeout is reported only after the loop returns).

The second assertion matters as much as the first: it pins the real limit, so
this document cannot drift into claiming vitest can interrupt a blocked event
loop. It cannot. (See §7.)

**Part B proves the policy is one point.** `testTimeoutFor(b) > b` for every
budget in range, nonsense budgets throw, each tier is env-overridable, and the
defaults are pinned so "make the suite feel fast" is a visible diff.

**Part C enforces the rules structurally** over `__tests__/**`. R1 is a
**TypeScript AST** walk (`ts.createSourceFile`), not a regex: an ordinary numeric
argument (`store(42)`, a `1_000`-sat fee, a `3_200` round) is a false positive
for a line matcher, and a guard that cries wolf is a guard people delete. It
found 6 real legacy timeouts that every regex in this round missed.

| Check | Rule |
|---|---|
| R1 | no `it(...)` / `test(...)` argument is a literal timeout |
| R2, R2b | no elapsed assertion against a literal ceiling; a surviving watchdog must compare against a derived budget |
| R3 | no `new Promise(r => setTimeout(r, …))` |
| R4 | no `Math.random()` in a test |
| R5 | no `vi.waitFor` |
| R6 | `retry: 0` in the config |

One allowlist entry, with its reason inline: `taprootSpend-live.test.ts` (§3.2).

---

## 5. Before → after

Both campaigns use the identical harness, the identical 9 files, and the
identical contention: `N = cores + 4 = 20` busy loops spawned by
`loaded-run.sh`. BEFORE runs `origin/main` (no `vitest.config.ts`); AFTER runs
this branch. Nothing else differs.

| Metric | Before | After |
|---|---|---|
| Iterations green | **0 / 20** | **20 / 20** |
| Timeout failures | **186** | **0** |
| Distinct failing tests | **46 of 119** | **0** |
| Worst per-test flake rate | **17 / 20** | **0 / 20** |
| Failure cause | `Test timed out in 5000ms` — **100 %** | — |

Per-iteration failure counts BEFORE ranged **2 → 18** and no iteration agreed
with any other. That is what "load-sensitive" looks like from outside, and why a
single red run carried no information.

The flakiest tests, before → after:

| Test | Before | After |
|---|---|---|
| `appealCoordinator` — progresses a manually added appeal through all phases | 17/20 | 0/20 |
| `propertiesValidator` PV1 — 120 random well-formed field combos | 16/20 | 0/20 |
| `appealWatcher` — validates a Kind 39007 attestation and emits a resolution | 13/20 | 0/20 |
| `appealWatcher` — resolves the group pubkey from a configured resolver | 12/20 | 0/20 |
| `appealWatcher` — ingests a batch of events and returns valid resolutions | 12/20 | 0/20 |
| `appealWatcher` — rejects an attestation signed by the wrong group | 11/20 | 0/20 |
| `appealCoordinator` — reselects from backups when the initial DKG fails | 9/20 | 0/20 |
| `appealWatcher` — supports watchAll mode for resolver-backed ingestion | 9/20 | 0/20 |
| `appealWatcher` — dedups concurrent duplicate deliveries racing the resolver | 7/20 | 0/20 |
| …37 further tests, 1/20 → 5/20 | 1–5/20 | 0/20 |

*(The full 46-row table is reproducible with
`node scripts/determinism/summarise-campaign.mjs /tmp/opencode/court-determinism/BEFORE 20`
— these numbers are derived from logs, never typed.)*

### 5.2 The whole suite

| Run | Result |
|---|---|
| Full suite ×3, loaded (same 20 hogs) | **FULL3_PLACEHOLDER** |
| Full suite, unloaded | **UNLOADED_PLACEHOLDER** |

### 5.3 What actually caused it

### 5.3 What actually caused it

**One root cause, and it was structural: the ceiling was never chosen.** With no
`vitest.config.ts`, vitest's 5000 ms default applied to 1473 of 1523 tests. All
186 BEFORE failures were that single timeout — not one assertion failure. The
tests are not slow; they are CPU-bound crypto, and 5 s is a coin flip on a busy
box.

On top of it, four classes made the red actively misleading:

1. **Assertions that could never fire (vacuity).** `r30InboxOutboxLoad`
   asserted `elapsed < 120_000` under a **120 000 ms timeout**. `adversarialNostr`
   used a 30 s budget under a literal 30 s timeout. `differentialWire` set a
   300 s child bound on a test with **no declared timeout at all** — a 300 s
   child inside the 5 s default. In each case the abort won the race, so the
   failure message named a timeout instead of the regression the assertion was
   built to catch. A ceiling that cannot fire is worse than no ceiling: it looks
   like coverage.
2. **`setTimeout(0)` as a synchronisation drain** in `appealWatcher`'s dedup
   test observed a half-drained chain — so a regression that double-emitted
   *after* the sleep would have passed. This is the one that could have hidden a
   real protocol bug.
3. **Unseeded RNG in four places** made any red unreproducible: a fuzz that
   finds a crash publishes a result nobody can replay.
4. **A NUL byte in `differentialParity.test.ts`** made the file `data` to
   `file(1)`, silent to `grep`, and binary to `git diff`. It escaped the first
   inventory pass entirely and only surfaced when a guard scan tried to read it
   as text. Fixed to `'\u0000'`.

**A fifth class showed up only in the full loaded run** (1980 tests, of which
the 9-file campaign sees 119): two wall-clock literals passed *into a child
harness*, which made the harness mis-classify healthy ceremonies. `--deadline-ms=2500`
in `r33ByzantineRelay` and `=4000` in `r30MultiProcessCeremony` are **verdict
inputs**, not timeouts: under load the honest reordering scenario reported
`completed: 0, signatures: 0`, and a good DKG was classified
`DKG_MISSING_PARTICIPANT`. Both are derived now. `r30` also pinned the literal
with `toBe(4000)`; it pins the derivation instead, so the two sides cannot drift.

That distinction is worth stating precisely, because it decides how each is
fixed:

* **Verdict depends on the clock** → a bug, fixed by construction (above).
* **Only the runtime depends on the clock** → a *workload* budget. The assertion
  is deterministic; the enumeration count is fixed. `modelChecking` (111 667
  states, 6.7 M transitions) measured 705 s on the loaded box against a 600 s
  ceiling, and `propertiesBatch` PB1 measured 124.6 s against 120 s. Those two
  ceilings were raised — as **capacity**, from their own env-overridable budget,
  and named as such. Raising them cannot hide a flake, because nothing in those
  tests asserts a duration; it only stops a slow box from truncating a
  deterministic enumeration.

**Real production non-determinism found: none.** Every `Date.now()` in the
library is either a defaulted parameter (`escrow`, `lnSettlement`, `selection`)
or injectable, per AGENTS rule 5. `courtSigner.randomNowSeconds()` uses
`Math.random()` deliberately — NIP-59 timestamp randomisation is a privacy blur,
and making it reproducible would be the bug. **No production file was changed in
this round.**

## 6. Running the campaigns

The harness is `scripts/determinism/loaded-run.sh`. It spawns the hogs itself,
echoes the exact command, bounds each iteration with `timeout`, and reaps every
hog on exit **including SIGINT/SIGTERM** — a wedged busy loop left running for
hours is how this box reached load 60 in the first place (nine such loops, 3.6
hours old, were found during this round).

```bash
# The loaded full suite, 3 iterations (the soak program's standard check)
./scripts/determinism/loaded-run.sh

# 20 iterations over the files that used to flake (regression campaign)
./scripts/determinism/loaded-run.sh --iterations 20 --files \
  __tests__/appealCoordinator.test.ts __tests__/hardening20260815.test.ts \
  __tests__/propertiesValidator.test.ts __tests__/r30InboxOutboxLoad.test.ts \
  __tests__/courtSigner.test.ts __tests__/dkg.test.ts \
  __tests__/validator.test.ts __tests__/appealWatcher.test.ts \
  __tests__/differentialParity.test.ts

# Lighter contention while iterating on a fix
HOGS=4 ./scripts/determinism/loaded-run.sh --iterations 1
```

Tuning without editing a test:

| Variable | Default | Raises |
|---|---|---|
| `BAO_TEST_TIMEOUT_MS` | 60 000 | every test that declares none |
| `BAO_HOOK_TIMEOUT_MS` | 60 000 | `beforeAll` / `afterAll` |
| `BAO_HEAVY_BUDGET_MS` | 60 000 | crypto corpora (timeout ⇒ 120 s) |
| `BAO_PROCESS_BUDGET_MS` | 90 000 | subprocess ceremonies (timeout ⇒ 180 s) |
| `BAO_SCALE_BUDGET_MS` | 150 000 | scale campaigns (timeout ⇒ 300 s) |
| `SIM_BUDGET_MS` | 30 000 | end-to-end pipeline watchdog |
| `VALIDATOR_BUDGET_MS` | 30 000 | 100 k-tag rejection watchdog |
| `LADDER_SCAN_BUDGET_MS` | 30 000 | exact-bound scan watchdog |
| `INBOX_FLOOD_BUDGET_MS` | 30 000 | 10 k-ingest watchdog |
| `MODEL_CHECK_BUDGET_MS` | 600 000 | model-check exploration (timeout ⇒ 1 200 s) |
| `PROPERTIES_BATCH_BUDGET_MS` | 180 000 | PB1/PB2 proof sweeps (timeout ⇒ 360 s) |
| `CEREMONY_PHASE_DEADLINE_MS` | 20 000 | per-phase deadline handed to the multi-process harness |
| `HOGS` | `cores + 4` | hog count for the harness |
| `ITER_TIMEOUT` | 1800 | per-iteration process bound (s) |

**Raising one of these is a legitimate response to a genuinely slower box. It is
not a fix for a flake.** If a run goes red, the question is which rule was
broken, not which number to grow.

---

## 7. Residual — what is still not deterministic, and why

Honest list. None of these can produce a false red in the default suite.

1. **A synchronous hang cannot be preempted.** vitest's timeout is
   asynchronous: it fires at the next await point. A blocked event loop runs to
   completion first (proven, §4). So an *infinite* synchronous loop hangs the run.
   The only real bound is the **process boundary** — which is why the harness
   wraps every iteration in `timeout`. A per-test in-body assertion is the only
   ceiling that can fire for sync work, which is why `reviewRound11`'s scan
   watchdog is an in-body assertion rather than a test timeout.
2. **Ambient load is not controlled.** The harness controls *its own* hogs, not
   the rest of the box. During this round another agent ran the same suite
   concurrently with `--testTimeout=60000`. Numbers here should be read as
   "under contention at least this bad".
3. **`Date.now()` in fixtures is real time.** The appeal fixtures anchor to the
   wall clock because the behaviour under test is deadline arithmetic. Offsets
   are ±10 s, so a rollover cannot flip a verdict — but the fixture is not
   *replayable to the millisecond*. Injecting a clock is the next step if a
   deadline boundary ever needs pinning exactly.
4. **`courtSigner.ts` backdates gift wraps with `Math.random()`.** This is
   **production by design** — NIP-59 timestamp randomisation is a privacy blur,
   not a secret, and an eavesdropper must not be able to correlate wraps. It is
   correctly not reproducible; tests assert `created_at` only on events they
   construct, never on a generated wrap.
5. **`taprootSpend-live.test.ts` sleeps.** It waits on a real chain. Allowlisted,
   env-gated, out of the default suite.
6. **Directory listing order is assumed, not verified.** No test depends on it
   today; a future test that iterates a directory would reintroduce a platform
   dependency (inode order). Sort directory listings before comparing.
