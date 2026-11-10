# REPRODUCIBILITY — the one-command contract

Every artifact the protocol paper (`docs/FROST_COURT_ORACLE_PAPER.md`) and
`docs/CROSS_CHECK.md` cite is regenerable from a clean clone with ONE command:

```bash
bash scripts/reproduce.sh                 # full contract (~19 min measured)
# or: npm run reproduce
bash scripts/reproduce.sh --quick         # skip model-check + bench (~3.5 min)
bash scripts/reproduce.sh --full-model-check  # exhaustive sweep, no --fast
```

Exit code: `0` = every artifact PASS · `1` = at least one FAIL · `2` = usage.
The script never stops at the first failure — every stage runs so the VERDICT
is complete. Re-runs are idempotent (`.repro-artifacts/` is rebuilt from
scratch; the model-check fixture is snapshotted before regeneration and its
exact pre-run bytes restored afterwards).

## Stages

| # | Stage | What it proves | Variance bound |
|---|---|---|---|
| a | clean-environment check | Node ≥ 22, npm, git, lockfile present; warns if tree is dirty | none (boolean) |
| b | `npm ci` | lockfile-exact dependency install | registry latency only |
| c | `npm test` (full suite) → json + junit | all 1,491 tests green; machine-readable reports | pass/fail is boolean; wall time is load-dependent |
| d | typechecks ×3 | `tsc --noEmit` green for impl / scripts / tests | none (boolean) |
| e | `simulate:court` | end-to-end deterministic whole-court sim ends `RESULT: ALL GREEN` | none (seeded; same seed → same result, asserted in-suite) |
| f | `model-check --fast` + fixture comparison | state-space sweep is **digit-identical** to the committed fixture `__fixtures__/model-check-summary.json` (only timing fields excluded) | digits: **zero tolerance**; wall time: load-dependent |
| g | `bench --json` vs BASELINE | performance medians vs `docs/benchmarks/baseline-medians.json` | **±20%** of baseline median = ok; **>3× slower** = REGRESSION → FAIL (see below) |
| h | `scripts/cross-check.mjs` | every evidence pointer in `docs/CROSS_CHECK.md` resolves to executable evidence | none (boolean) |
| i | suite pass-counts | parity / property / invariant / model-checking suites summarized from stage (c)'s JSON | none (boolean) |
| j | VERDICT | per-stage PASS/FAIL + runtimes + total | — |

## Variance bounds (stage g, in detail)

`scripts/bench-vs-baseline.mjs` classifies each benchmark row:

- `ok` — median within **±20%** of the baseline median.
- `OVER-BOUND` — slower than baseline by >20% but ≤3×: a **warning**, not a
  failure. BASELINE.md documents load-driven swings up to ×30 on this shared
  16-thread host; single-pass bench under concurrent agent load routinely
  lands here.
- `REGRESSION` — slower by **>3×**: unambiguous regression or wrong machine
  class → stage fails.
- `FASTER` / `no-baseline` — informational.

Rationale: the contract's hard claims are **correctness** (tests, typechecks,
simulation, digit-identical model-check states). Performance is guarded only
against gross regression (3×), not host noise, because the baselines were
taken on a shared box with documented ×30 load swings.

## Environment matrix

| Field | Baseline (committed) | Contract requires |
|---|---|---|
| Node | v22.23.2 (baselines + fixtures taken on this) | **≥ 22** (hard check, stage a) |
| OS | linux x64 | any Node-22-supported platform (fixtures are platform-independent; wall times are not comparable cross-platform) |
| CPU reference | AMD Ryzen 7 PRO 8840HS, 16 threads | any; bench verdicts are ratio-based (see bounds) |
| Clock | `process.hrtime.bigint` only — no `Date.now` in measured paths | — |
| Network | only stage (b) `npm ci` touches the registry | all measurement stages are offline and CPU-bound |

Measured wall time, full-contract reproduction run of 2026-11-10 (16-thread
shared host, moderate load, VERDICT in `docs/benchmarks/repro-log-2026-11-10.txt`):
**total 999.9s ≈ 16.7 min** (stage f ≈ 9.6 min and stage c ≈ 2.6 min dominate).
`--quick` skips f and g (≈ 12.5 min of the measured total).

## Artifacts produced (`.repro-artifacts/`, git-ignored)

`test-results.json` + `junit.xml` (stage c) · `simulate.log` (e) ·
`model-check-summary.expected.json` + `model-check-fast-regenerated.json` (f) ·
`bench.json` (g) · per-stage logs `stage-{b..i}.log` · VERDICT block (stdout).

## Failure-mode guide (what a FAIL in each stage means)

| Stage fails | Most likely meaning | First check |
|---|---|---|
| a | Node < 22, or npm/git/lockfile missing | `node --version`; use the same major as the environment matrix |
| b | registry unreachable or lockfile drift | network/proxy; `npm ci` again (it is lockfile-exact by construction) |
| c | a test genuinely failed — a protocol regression | the failing test name in the log; check `docs/CROSS_CHECK.md` for the claim it carries |
| d | type error in impl (`typecheck`), scripts, or tests | the `tsc` error; the three tsconfigs map 1:1 to directories |
| e | whole-court sim not `ALL GREEN` | the sim is seeded and deterministic — a failure is a real protocol bug, not flake |
| f | state-space digits differ from the committed fixture, or the committed fixture is not `mode: "full"` | a machine/explorer change moved reachable-state counts: re-run the FULL sweep (`scripts/reproduce.sh --full-model-check` or `npx tsx scripts/model-check.mjs`) and commit the refreshed fixture with the change |
| g | `REGRESSION` row (>3× baseline median **on a quiet box, load < 2**) | real perf regression or wrong machine class — profile before reverting. `OVER-BOUND` rows (>20%, ≤3×) on a loaded host are expected noise: re-run on a quiet box to enforce the hard gate |
| h | a dangling evidence pointer in `docs/CROSS_CHECK.md` | the named ref: a test/bench/fixture was renamed or deleted without updating the index |
| i | a contract suite (parity/property/invariant/…) has failures | same as (c) — these suites are called out explicitly because the paper cites them |

Two-stage FAIL correlation: if **f and h fail together** with `totals.instances`
/ `determinismPathsReplayed` mismatches, the committed fixture itself is
stale or was replaced by a fast-mode run — regenerate the full fixture.

## Tag-to-tag reproducibility promise

Every release tag reproduces **its own** numbers: check out the tag, run
`bash scripts/reproduce.sh`, and the VERDICT must say `REPRODUCED` against
that tag's committed fixture and baseline. Digit-stable artifacts are
fingerprinted with a **stable artifact hash** — the SHA-256 of the
model-check fixture with all timing fields (`generatedAt`, `totalWallMs`,
per-instance `wallMs`) stripped and instances name-sorted:

```bash
npx tsx scripts/compare-model-check-fixture.mjs --hash __fixtures__/model-check-summary.json
```

| Tag / commit | date (UTC) | stable artifact hash | record |
|---|---|---|---|
| `7ab0d441f182` (post-v0.10.2, round 14/15 docs) | 2026-11-10 | `35eb7eb8b5c292125bcddd693a4c812b1c55b63f0b341b25ad126148fd7d614d` | `repro-log-2026-11-10.txt` |

Policy: every future release tag appends a row here (hash computed by the
tag's own contract run). A changed hash means the state-space numbers moved —
legal only alongside a committed refreshed fixture and a paper/CROSS_CHECK
update in the same release.

## Runtime budget (measured, not assumed)

Target was < 15 min on a dev box; measured on the reference host
(16-thread, load 3–5 from concurrent agent work):

| Mode | measured | dominant stages |
|---|---|---|
| full contract | **999.9 s / 1015.1 s** (2026-11-10 pair, ≈ 17 min) | f `model-check --fast` ≈ 9.6–11.3 min · c `npm test` ≈ 2.8–3.1 min · g bench ≈ 4.2–4.3 min |
| `--quick` | ≈ 3.5 min | c + d + e + h + i |

**Honest split:** the 15-minute target is missed by ~2 min on this box. The
split that exists is the model-check run-mode split (`--fast` skips the
`vote n=4 k=2` headline instance via `FAST_SKIP_NAMES`; `--full-model-check`
runs the exhaustive sweep, ≈ +10 min, and is what refreshes the committed
fixture). `--quick` exists for iteration, not for contract claims — a
reproduction record must be a full-contract run.

## Reproduction records

Committed runs live in `docs/benchmarks/`:

- `repro-log-2026-11-10.txt` — full-contract run, VERDICT included
  (2026-11-10 08:59Z, total 999.9 s, RESULT: REPRODUCED). Recorded from a
  used worktree, so stage (a) prints its dirty-tree warning — a clean clone
  at the tag will not see it.
- `BASELINE.md` / `baseline-medians.json` — the performance baseline pair.
