# Test determinism — load-insensitivity by construction (round 51)

The suite must produce the **same verdict on a loaded box as on an idle one**.
This document records the inventory that found where that was untrue, the
reproduction, the fixes, the measured before/after, the rules that now enforce
it, and the residual that is still timing-dependent on purpose.

Read this with `__tests__/helpers/watchdog.ts` (the only wall-clock knob) and
`__tests__/determinism.test.ts` (the static guard that polices the rules).

---

## 0. Why this round exists

Four rounds of evidence, all recorded, none speculative:

| # | Evidence | Where |
|---|---|---|
| 1 | The old **5 s** `simulateCourt` wall-clock gate produced **two FALSE mutation "captures"** (M40/M47) | `docs/MUTATION_TESTING.md` §3.1, §7, §"Pass 3" |
| 2 | An external reviewer reproduced it: a **docs-only tree → 12 red**, no code change | `docs/MUTATION_TESTING.md` §7 |
| 3 | **review-round-10** under heavy parallel load: **15 timing flakes**, green on clean re-runs | `docs/REVIEW_ROUND_10.md` |
| 4 | The soak rounds found load-dependent behaviour **twice** | campaign notes, rounds 43–50 |

Every previous answer raised a number (5 s → 30 s → 120 s → 180 s). Raising a
budget does not remove the class; it hides it until the box is busy enough. This
round removes the dependence instead: **nothing in the suite asserts that work
finished within a duration**, and the harness ceiling is derived from a
measurement taken on the box that is running the tests.

---

## 1. Inventory (whole suite: 85 test files, 1,873 tests)

Produced mechanically (`__tests__/determinism.test.ts` re-runs the static half
of it on every `npm test`; the AST pass that produced this table is described
in §6).

| Class | Count | Verdict |
|---|---|---|
| **Assertion on elapsed time** (`expect(Date.now() - start / elapsedMs).toBeLessThan(…`) | **3** | **real flake** — all three removed (§2.1) |
| **Implicit harness timeout** (no declared timeout ⇒ vitest's absolute 5 s) | **1,383** | **latent flake** — root cause of 5/7 failures in reproduction run 1; replaced by a derived watchdog (§2.2) |
| **Declared absolute timeout** (`{timeout: 30_000…600_000}`, positional form) | **49** | latent flake — the tightest (120 s vs a 19 s test) failed under load; all routed through `wd()` (§2.2) |
| **Fixed subprocess phase deadline** (`--deadline-ms=4000/2500`, `spawnSync`/`execFile` `timeout:`) | **8** | **real flake** — 2 of 7 failures in reproduction run 1 were this (§2.3) |
| **Sleep / timer as synchronisation** (`setTimeout` in a test body) | **2** | **latent flake** — one polling `vi.waitFor`, one `setTimeout(0)` flush, one 1 ms "latency" mock (§2.4) |
| **Polling with a deadline** (`vi.waitFor`) | **1** | **real flake** — 1 s default deadline; failed in reproduction run 2 (§2.4) |
| **Unseeded randomness** (`Math.random()`) | **4** | latent flake / irreproducible failure — seeded (§2.5) |
| **Real clock read in a fixture** (`Math.floor(Date.now()/1000)` for `created_at`, deadlines) | **43** | **legit** with three caveats, see §5 |
| **Float comparison** (`toBeCloseTo`, statistical tolerance on seeded samples) | **46** | **legit** — tolerances are on deterministic (seeded) data; no duration among them |
| **Key/`Set` iteration order** (`Object.keys`, `new Set(`) | **82** | **legit** — every comparison either sorts first or is order-insensitive by design; see §5 |
| **Wall clock recorded but never asserted** (`wallMs` in campaign results, `printStats`) | **4** | **legit** — data for the artifact, not a gate |

Totals by class: **3 real assertion flakes, 1 real polling flake, 8 real
deadline sites, ≈1,432 latent timeout sites, 5 unseeded-RNG sites, 175 legit
clock/float/order uses.**

### The three duration assertions that existed

| File:line (pre-round) | Assertion | Classification |
|---|---|---|
| `__tests__/simulateCourt.test.ts:107` | `expect(elapsed).toBeLessThan(SIM_BUDGET_MS /* 30 s */)` | real flake (the historical 5 s → 30 s gate) |
| `__tests__/adversarialNostr.test.ts:319` | `expect(Date.now() - start).toBeLessThan(VALIDATOR_BUDGET_MS /* 30 s */)` | real flake (timed out at 43.8 s under load in run 2) |
| `__tests__/r30InboxOutboxLoad.test.ts:129` | `expect(elapsedMs).toBeLessThan(120_000)` | real flake (1.2 s clean, unbounded under load) |

---

## 2. Reproduction (controlled CPU hog, N = cores + 4 = 20)

Harness: 20 busy-loop processes for the duration of each run, 16-core box,
`npx vitest run` unmodified. (The box was *also* running a mutation sweep and a
second session's suite — that is the campaign's real condition, and the reason
run-to-run variance is itself part of the evidence.)

### 2.1 Before — 3 consecutive loaded runs of the unmodified tree

| Run | Result | Wall | Failures |
|---|---|---|---|
| 1 | **7 red** / 1,873 | 1,088 s | 5 timeouts + 2 harness-deadline |
| 2 | **6 red** / 1,873 | 910 s | 4 timeouts + 2 harness-deadline |
| 3 | **green** / 1,873 | 756 s | — |

**Every failure was a clock, none was a behaviour.** The failing set was
*different in every run* (run 1 and run 2 share only two test ids; run 3 is
green) — the signature of timing, not of a broken assertion. That intermittency
is precisely why "it passed on my box" was never evidence, and why the fix
cannot be another constant.

Run 1:

| Test | Duration | Gate it crossed |
|---|---|---|
| `appealWatcher` — "dedups concurrent duplicate deliveries…" | 6,313 ms | 5 s default timeout |
| `appealWatcher` — "ingests a batch of events…" | 7,152 ms | 5 s default timeout |
| `appealWatcher` — "supports watchAll mode…" | 5,581 ms | 5 s default timeout |
| `propertiesValidator` — PV1 | 10,333 ms | 5 s default timeout |
| `propertiesBatch` — PB1/PB4 (19.3 s clean) | 123,091 ms | **120 s** declared timeout |
| `r30MultiProcessCeremony` — "rejects a process replaying…" | 11,587 ms | `--deadline-ms=4000` |
| `r33ByzantineRelay` — "replaying relay: duplicates are idempotent…" | 11,503 ms | `--deadline-ms=2500` |

Run 2 (different set):

| Test | Duration | Gate it crossed |
|---|---|---|
| `adversarialNostr` — over-served `e` tags | 43,817 ms | 30 s `VALIDATOR_BUDGET_MS` |
| `appealWatcher` — "validates a Kind 39007 attestation…" | 27,275 ms | `vi.waitFor` 1 s poll + 5 s default |
| `appealWatcher` — "dedups concurrent duplicate deliveries…" | 24,798 ms | 5 s default timeout |
| `propertiesValidator` — PV1 | 34,479 ms | 5 s default timeout |
| `r30MultiProcessCeremony` — "fails closed with SIGN_MISSING_REVEAL…" | 40,306 ms | `--deadline-ms=4000` |
| `r33ByzantineRelay` — "reordering relay…" | 26,237 ms | `--deadline-ms=2500` |

### 2.2 Measured slowdown of the same test bodies (loaded ÷ clean)

124 tests take ≥300 ms clean. Comparing the identical test ids between the
clean baseline and loaded run 2:

| Percentile of slowdown | Value |
|---|---|
| p50 | 2.4× |
| p90 | 4.6× |
| max (reliably measured: model-check instance 54.5 s → 433 s) | **8×–16×** |

That number is why every previous "generous" constant eventually failed, and
why the fix has to be a *ratio*, not a bigger constant.

### 2.3 After the fix — same harness, same box, same ambient load

*Final shipping build; the three loaded runs, then one unloaded:*

| Run | Result | Wall | 1-min load avg | Slowest test |
|---|---|---|---|---|
| loaded 1 | **green** / 1,884 | 1,786 s | 77–81 | model-check instance **836 s** |
| loaded 2 | **green** / 1,884 | 1,854 s | 78–81 | **943 s** |
| loaded 3 | **green** / 1,884 | 1,943 s | 60–81 | **968 s** |
| **unloaded** | **green** / 1,884 | 1,274 s | 24–58 | 613 s |

**This is the decisive number.** The slowest tests in the three loaded runs took
**836 s, 943 s and 968 s** — every one of them against the **600 s literal** it
carried before this change. With the assertion fixes *alone* those runs would
still have been red; they are green because that ceiling is now
`wd(600_000)` → `min(600 s × factor, 30 min)`: a hang gate that follows the box
instead of a constant that expires.

Fairness note: the *before* runs carried load 45–68; these after-runs carried
**60–81** — heavier, not lighter, so the comparison does not favour the fix. The
"unloaded" run is only as unloaded as a shared 16-core box allows (24–58, because
a parallel campaign ran through it); it is green too. The per-test isolation
matrix (§2.5) used one identical harness for both sides.

### 2.4 Nothing was weakened

| | Before | After |
|---|---|---|
| Tests | 1,873 | **1,884** (+11) |
| Skipped | 1 (env-gated live taproot) | 1 (same) |
| `typecheck` / `typecheck:scripts` / `typecheck:tests` | green | green |
| Mutation detectors | suite was one of three | unchanged — and the two historical **false captures (M40/M47) can no longer happen**: the budget that produced them is deleted, and the behaviour they were supposed to violate is asserted structurally |

The three removed duration assertions were replaced by *stronger* statements, not
weaker ones: step-sequence + outcome equality, a two-size linearity proof by tag
read count, and the record/provenance/byte bounds that already encoded "O(1) per
ingest". A mutant that made the pipeline quadratic would now fail on the ratio;
before, it would only have failed if the box happened to be fast.

### 2.5 Per-test flake rate, 20 runs each, under the same hog

Same harness for both sides: 20 iterations per target, one 20-loop hog, box
carrying a mutation sweep. 1,340 test-runs before, 1,280 after.

| Test | Before | After | What the clock did |
|---|---|---|---|
| `r30MultiProcessCeremony` — "rejects a process replaying its previous round messages" | **4/20** | **0/20** | honest phase aborted at the harness phase deadline; the juror was reported as `DKG_MISSING_PARTICIPANT` while it was alive and working |
| `appealWatcher` — "dedups concurrent duplicate deliveries racing…" | **2/20** | **0/20** | 5 s default timeout (1.5 s clean) |
| `appealWatcher` — "ingests a batch of events and returns valid resolutions" | **2/20** | **0/20** | 5 s default timeout |
| `appealWatcher` — "rejects an attestation signed by the wrong group" | **2/20** | **0/20** | 5 s default timeout |
| `appealWatcher` — "resolves the group pubkey from a configured resolver…" | **2/20** | **0/20** | 5 s default timeout |
| `propertiesValidator` — PV4 (v2-only policy fields) | **2/20** | **0/20** | 5 s default timeout |
| `appealWatcher` — "supports watchAll mode…" | **1/20** | **0/20** | 5 s default timeout |
| `appealWatcher` — "validates a Kind 39007 attestation and emits a resolution" | **1/20** | **0/20** | `vi.waitFor`'s 1 s poll deadline, then the 5 s default |
| `propertiesValidator` — PV1 | **1/20** | **0/20** | 5 s default timeout |
| `r33ByzantineRelay` — "replaying relay: duplicates are idempotent…" | **1/20** | **0/20** | harness phase deadline |
| `r30MultiProcessCeremony` — the other three | 0/20 | 0/20 | — |
| `r33ByzantineRelay` — the other seven | 0/20 | 0/20 | — |
| `r30InboxOutboxLoad` — all eleven | 0/20 | 0/20 | — |
| `propertiesBatch` — all eight | 0/20 | 0/20 | PB1/PB4's 120 s literal only trips under *full-suite* parallelism (1 of 3 loaded runs), not with a hog alone |
| `adversarialNostr` — over-served tag scan | 0/20 | 0/20 | its 30 s budget held in isolation; it tripped in run 2 of 3 under full-suite load |
| `simulateCourt` — large instance | n/a (new test) | **0/20** | see the tuning note below |

**Totals: 18 failing test-runs / 1,340 before → 0 / 1,280 after.**

One test is *not* in this table because isolation never caught it: `r33ByzantineRelay`
"inverting one sender's commit/reveal pair" is 0/20 on both sides, yet it failed
once in a loaded full run. Its cause is not a test-side clock and not the suite's
timeout — it is the harness's hard-coded 800 ms inversion window (§3.3, item 2),
which only an intra-run interleaving exposes. It is fixed there and is green in
all three loaded runs.

Two honest notes:

* **Tuning the default was part of the work, and it is in the record.** The
  first build used a 10 s default; `simulateCourt`'s large instance then failed
  **3/20** (38–50 s wall against a 38 s derived ceiling) because the estimator
  reads ~4× while a real 2 s body ran ~20× slower. The default is now 60 s —
  the measured worst case (2.4 s × 20), not a feeling — and the same 20 runs are
  0/20. A watchdog that has not been *measured against the worst observed
  inflation* is just a smaller version of the bug.
* **Isolation and full-suite load are different treatments.** PB1/PB4 and the
  tag-scan test are 0/20 in isolation because their flake needs the suite's own
  16-way worker parallelism on top of the hog. That is why both proofs are
  reported: the isolation matrix (§2.5) and the three full loaded runs (§2.1,
  §2.3).


---

## 3. The fixes (by construction, not by budget)

### 3.1 No test asserts elapsed time — the three gates are gone, not raised

| Test | Before | After |
|---|---|---|
| `simulateCourt` "is load-insensitive…" | `elapsed < 30 s` | **deleted.** The test now asserts the deterministic contract only: all eight steps, in order, each green, at pool 20 / jury 7 / 3 backups. A fourth test (`differs by seed`) locks anti-vacuity: a mutant that ignored the seed would make the reproducibility tests trivially true. |
| `adversarialNostr` "over-served `e` mention tags" | `Date.now() - start < 30 s` | **replaced by a work count.** The same over-bound event is validated with a `Proxy` counting tag-element reads, at two sizes (12k and 60k). Both must be rejected with the same typed bound; reads must scale **linearly** (ratio ≤ 12 for a 5× size increase; quadratic would be 25×). No clock, no threshold on time, and it is a *stronger* statement than "finished in 30 s". |
| `r30InboxOutboxLoad` 10k flood | `elapsedMs < 120_000` | **deleted.** The O(1)-per-ingest property is already asserted structurally (record count, per-record provenance length, snapshot byte bound) — all of them fail if an ingest starts scanning the record set. |

Performance is not unmeasured — it moved to where it belongs: the benchmark
harness (`scripts/bench-vs-baseline.mjs`, `docs/benchmarks/`), which may assert
on time precisely because it is a measurement tool, not a correctness gate.

### 3.2 The harness ceiling is derived from the box it runs on

`__tests__/helpers/watchdog.ts` + `__tests__/helpers/determinism.setup.ts` +
`vitest.config.ts`:

```
bestMsPerUnit    = min of 9 short CPU bursts              (uncontended cost)
loadFactor       = max of 6 × ~25 ms bursts ÷ (units × bestMsPerUnit), clamped [1, 8]
watchdogMs(base) = min(base × loadFactor, max(30 min, base))
```

* A **short burst** (~1.5 ms) usually completes inside one scheduler quantum, so
  its *minimum* is a fair estimate of this CPU's cycle cost.
* A **long burst** (~25 ms of the same work, sized from the measured per-unit
  cost so it costs the same on any box) is preempted repeatedly, so its
  *wall ÷ best-case* ratio is the load. Worst-of-6, deliberately: underestimating
  the factor brings the flake back, overestimating only widens a hang gate.
* Calibration runs **per worker, in the setup file**, not in `vitest.config.ts`:
  the config module is evaluated before the pool starts, i.e. before the load
  exists. All 16 workers calibrate together, which is exactly the condition the
  tests will run in.
* `DEFAULT_WATCHDOG_MS = 60_000` is the *measured worst case*, not a vibe: the
  slowest test that relies on the default takes 2.4 s clean and up to 20× that
  under a 40+ load average (≈48 s). It is a hang gate, so a wide margin costs
  nothing (a per-test ceiling tighter than the box is the bug this round killed).
* All **49 declared timeouts** now read `wd(N)`: same relative margin on every
  box, one env override, no bare literal left anywhere (a bare literal cannot
  follow the box — that is exactly the shape that flaked).
* Override: **`BAO_TEST_WATCHDOG_MS`** replaces every derived ceiling.
  `BAO_TEST_WATCHDOG_TRACE=1` prints the per-worker factor and timeout.

`suiteTestTimeoutMs` keeps the r29-11 ordering property: the harness timeout is
always strictly greater than the derived ceiling, so a slow *assertion* reports
"watchdog", never an opaque vitest timeout.

### 3.3 The phase deadline bounds SILENCE, not elapsed time (the one real non-determinism outside the tests)

`r30MultiProcessCeremony` and `r33ByzantineRelay` drive real multi-process
ceremonies and assert `report.failures` is empty. Two defects, both real:

1. **The test passed a fixed deadline** (`--deadline-ms=4000` / `2500`). It is
   now `HARNESS_DEADLINE_MS = wd(8_000)` (identical on an idle box, wider when
   the box is busy) and the report assertion compares against that value instead
   of a literal. `spawnSync`/`execFile` timeouts in `differentialWire` go
   through `wd()` for the same reason.
2. **The invert (order-sensitivity) hold was a hard-coded 800 ms** — the relay
   withheld one juror's FROST commitments for a fixed window so its reveal would
   overtake them. Under load the whole pipeline is 10–20× slower, 800 ms stopped
   being a window at all, every juror completed normally and the harness's own
   "the mode did something" check failed. A promise about *order* cannot be a
   constant; it is now 40× the reorder window (`REORDER_WINDOW_MS = wd(90)`),
   which lands ~45 % of the peers' idle deadline on any box. Two bounds have to
   hold at once (longer than the victim takes to publish its reveal, shorter
   than the peers' idle deadline), which is *why* it must be a duration: a
   structural "release the commits when the reveal appears" gate deadlocks, since
   the victim needs the peers' reveals to aggregate and the peers need the
   victim's commitment to reveal. Tried, measured, rejected — recorded here so
   nobody re-tries it.
3. **The child's phase deadline was an absolute clock** —
   `while (Date.now() < dkgDeadline)` in `scripts/court/juror-child.ts`. That
   makes "the box is loaded" indistinguishable from "a juror is gone": the poll
   loop's own 20 ms sleeps stretch under load, an HONEST phase overran the
   budget, and the juror reported `DKG_MISSING_PARTICIPANT` for a live peer.
   This is the one **real non-determinism outside the test files** that this
   round found, and it is fixed at the source: **the deadline now bounds
   SILENCE, not elapsed time** — every accepted record resets it. A killed or
   silenced peer still produces no progress and fails closed with the same typed
   classification after the same budget (the stall tests still pass, 0/20 both
   before and after); a slow box keeps making progress and is never aborted for
   being slow. Measured effect: the r30 replay test's flake rate went
   **4/20 → 2/20 (deadline only) → 0/20 (silence bound + scaled budget)**, and
   the r33 invert test went from a coin-flip to **12/12 direct runs + green in
   every loaded full run**.

Residual: a phase that *does* stall pays the idle budget, so the four stall
tests cost `4 × 8 s` on an idle box (the two files together run 77 s instead of
36 s). That is the price of not asking a clock to tell "slow" from "dead".

### 3.4 No polling, no sleeping

| Site | Before | After |
|---|---|---|
| `appealWatcher` "validates a Kind 39007 attestation…" | `await vi.waitFor(() => expect(onResolution).toHaveBeenCalledTimes(1))` — a 1 s poll deadline, failed in run 2 | the emission itself is the synchronisation point: the callback resolves a promise the test awaits. Nothing polls, nothing reads a clock. |
| `appealWatcher` dedupe window | `onevent!(); await setTimeout(0); expect(count).toBe(1)` | `onevent!(); expect(emissions).toHaveLength(1)` — the dedupe reservation is taken **synchronously** at the top of `handleEvent`, so the decision is already final when the call returns. The assertion is strictly stronger than "no emit within one macrotask turn". |
| `courtSigner` mock bunker | `await setTimeout(resolve, 1)` per signer call | `await Promise.resolve()` — keeps the only property the mock is for (the call is async) at zero clock cost. |
| `taprootSpend-live` `sleep(2000)`/`sleep(3000)` | — | **kept** and allowlisted: it waits on a real network and never runs in `npm test` (§5). |

### 3.5 Everything seeded

| Site | Fix |
|---|---|
| `propertiesBatch` PB3 shuffle | `childRng(31_337, 'PB3-shuffle')` — the permutation was irrelevant to the assertion but made a failure unreplayable |
| `adversarialParserFuzz` tag-mutation fuzz | `mulberry32(0x5eed_4a11)` — same draw count, seeded stream |
| `appealWatcher` / `adversarialNostr` juror fixtures | `priority: idx / 10` (distinct, deterministic) |

### 3.6 The gate is proven live

A watchdog nobody has seen fire is indistinguishable from a deleted one.
`__tests__/determinism.test.ts` asserts all four properties on every run:

1. **derived** — the factor is measured, finite, ≥1 and ≤ `MAX_LOAD_FACTOR`;
2. **installed** — the setup file's marker is present, so a change that drops
   `setupFiles` (restoring vitest's absolute 5 s default) fails;
3. **live** — a deliberately starved 25 ms computation under a 5 ms budget
   raises `WatchdogExceededError` with the right budget/elapsed, and the same
   helper over a generous budget does *not* throw (a gate that always throws is
   not a gate);
4. **ordered** — `suiteTestTimeoutMs(base) > watchdogMs(base)` at the default
   and under an override.

---

## 4. Rules (enforced, not advisory)

The static guard in `__tests__/determinism.test.ts` reads every
`__tests__/**/*.test.ts` on each run and fails with `file:line`:

| # | Rule | Why |
|---|---|---|
| 1 | **Never assert elapsed time.** No `expect(...)` may read `Date.now()`, `performance.now()`, `elapsed*`, `tookMs`, `durationMs`. | A duration threshold measures the box (three false captures, one external reproduction). |
| 2 | **Never sleep as synchronisation.** No `setTimeout`/`setInterval` in a test body (allowlist: the env-gated live test). | A sleep is a clock assertion with extra steps, and 0 ms is not "after the work". |
| 3 | **Never poll a deadline.** No `vi.waitFor`. | Its 1 s default deadline is a wall-clock gate (failed in run 2). |
| 4 | **Seed everything.** No `Math.random()` in a test. | A failure must be replayable from the test body. |
| 5 | **No bare numeric timeout.** `{timeout: N}` and the positional `}, N);` are banned; use `wd(N)`. | A literal cannot follow the box and has no override. |
| 6 | **No fixed subprocess deadline.** No `--deadline-ms=<number>`. | Make the harness phase deadline a watchdog like everything else. |
| 7 | **Watchdogs must be proven live** (§2.7). | Prevents a silently disabled gate. |
| 8 | **Sort before comparing** where iteration order could matter; prefer `Set`-membership over positional equality. | Order is not part of most contracts; asserting it couples the test to an implementation detail (see `style` note in §5). |
| 9 | **Clocks in fixtures are acceptable** when the fixture's *direction* is safe (a deadline 1 h in the future, an assertion `≤ now`). | Banning `Date.now()` outright would ban modelling "an event that happened just now". |

House style for the three "must wait for async work" cases:

```ts
// 1. the code resolves a promise → await THAT, never a deadline
const emitted = await firstEmission;
// 2. the decision is synchronous → assert immediately, do not flush
onevent!(event); expect(emissions).toHaveLength(1);
// 3. you believe you need a sleep → you need a callback, a promise, or an
//    injected clock. If none exists, the SUT has a testability gap: fix that.
```

---

## 5. What remains timing-dependent (residual), and why

| Residual | Why it cannot be removed | Mitigation |
|---|---|---|
| **The harness timeout itself** (vitest must have *some* deadline) | A hung test must terminate; a process cannot be interrupted by a "state transition" | Derived ratio (§2.2), 30-min absolute ceiling, CI job `timeout-minutes: 15` |
| **Calibration cost** (~0.35 s CPU per worker at startup) | The estimator must run somewhere | Cached per worker process; measured once, not per file |
| **Estimator error** — preemption is bursty; a factor of 3 can hide an 8× test | The factor is a sample, not the truth | Worst-of-5, clamp to 8, and the *default* base is already 4× the measured cost of the slowest test that uses it |
| **The 43 fixture clock reads** (`created_at`, `expiresAt`, `challengedAt`) | The SUT compares against a **host-injected** clock in production; these fixtures model "just now" | The *direction* of every comparison is load-safe (deadline +1 h, assertion `≤ now`); a fixture at a boundary would be a real flake and none is |
| **`Vec`/`Map` iteration order** (82 sites) | V8 preserves insertion order for these types; hashing order is not involved | Every order-sensitive assertion sorts first; §4 rule 8 |
| **`taprootSpend-live` real sleeps** | It waits for a real network/chain | Env-gated (`BAO_LIVE_TAPROOT=true`), excluded from `npm test`, allowlisted explicitly |
| **Subprocess ceremonies (r30/r33)** | Real separate processes; their mutual deadlines are protocol semantics | Deadline is a watchdog (§2.3); the child's own phase logic is unchanged |
| **Machine speed drift across the campaign** | Wall-clock baselines in `docs/benchmarks/` age | Benchmarks record the box; the suite no longer depends on speed at all |

---

## 6. How the inventory was produced

* AST pass over all 85 test files with the TypeScript compiler API: every
  `it`/`test`/`describe` call, its declared timeout (object `{timeout}` or
  positional third argument — the positional form hides from grep, e.g.
  `it(name, fn, 600_000)` in `modelChecking.test.ts`), plus call-chain forms
  (`it.skipIf(...)(name, fn, 300_000)`).
* Text pass for clock reads, timers, `waitFor`, `budgetMs`, `Math.random`,
  float comparisons and iteration helpers.
* Cross-referenced against the JSON reporter's per-test `duration` from a clean
  run, so "which tests sit close to their gate" was measured, not guessed.
* The static half is re-run by the guard test on every `npm test`; the AST pass
  is a campaign tool (it is only needed when adding new files or call forms).

---

## 7. Verify

```bash
npm test                                  # 1,873 tests, clean box
node /tmp/opencode/r51/hog.mjs 3600 &     # 20 busy loops (cores + 4)
npm test                                  # same verdict under load
BAO_TEST_WATCHDOG_TRACE=1 npm test        # per-worker factor + timeout
BAO_TEST_WATCHDOG_MS=300000 npm test      # replace every derived ceiling
npm run typecheck && npm run typecheck:tests
```

A flake under load is now a **bug in the suite**, not a season: open it against
this document and add the missing rule to §4 rather than raising a number.

---

## 8. Provenance

* Round 51 of the determinism campaign; branch `test/r51-determinism`.
* Reproduction harness: 20 busy loops (`cores + 4`), 3 consecutive full-suite
  runs before the change and 3 after, on the same 16-core box, while the box
  also carried a mutation sweep and a second session's suite (the campaign's
  normal condition).
* Every claim in §1–§2 is measured, not inferred; §5 names what was *not* fixed
  and why, so the next round does not re-discover it as new.
