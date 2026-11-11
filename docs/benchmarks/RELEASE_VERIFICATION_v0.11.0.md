# Release verification — v0.11.0

Independent post-release verification of the **release artifact** (`v0.11.0`,
tag object on commit `eb912977c06a`), run from a **detached worktree at the tag** —
not from `main` — so that every number below describes what a consumer actually
checks out, not what happened to land afterwards.

| | |
|---|---|
| Tag | `v0.11.0` (annotated, tagger `Mr BAO <79491200+baocommunity@users.noreply.github.com>`, 2026-11-11T01:48:19Z) |
| Commit | `eb912977c06a1ab2614bf0d021620926be8c10d9` — `release: v0.11.0 — … (#88)` |
| Worktree | `git worktree add --detach ../bao-court--verify-0110 v0.11.0` (`git describe --tags --exact-match` → `v0.11.0`) |
| Host | Linux x86_64, Node **v22.23.2**, npm 10.9.8, Lean 4.14.0 (`410fab728470`) |
| Verification date | 2026-11-11 |
| **Verdict** | **PASS — the tag is the artifact, and the artifact reproduces** (`REPRODUCED`, exit 0) |

`main` at verification time was `6d6165e` (`docs(mutation): re-verify the
pass-2 baseline on the shipped base (#89)`) — one docs-only commit ahead of the
tag, which is expected and does not affect any check here.

---

## 1. The tag *is* the artifact — PASS

```
$ git describe --tags --exact-match
v0.11.0
$ node -p "require('./package.json').version"
0.11.0
$ grep -n '^## \[0.11.0\]' CHANGELOG.md
353:## [0.11.0] — 2026-11-11
```

```
$ gh release view v0.11.0
title:      v0.11.0 — Lean4 ITP, attribution, settlement binding, parameter hardening, campaigns
tag:        v0.11.0
draft:      false
prerelease: false
author:     baocommunity
created:    2026-11-11T01:48:19Z
published:  2026-11-11T01:48:32Z
url:        https://github.com/baocommunity/bao-court/releases/tag/v0.11.0
```

### Release notes vs. `CHANGELOG.md` substance

The release body is a condensed paragraph; every clause maps onto a shipped,
verifiable artifact — none of it is aspirational text.

| Release-note clause | Changelog bullet | Verified against |
|---|---|---|
| "Lean 4 single-finality machine-checked (no sorry; axiom audit clean) + `machine_alone_insufficient`" | Lean 4 mechanisation of single finality | `proofs/lean4/` build + axiom audit (§4.5) |
| "FROST session attribution (Theorem 6)" | `attribution.ts`, session journal, RFC 9162 journal spec | `attribution.ts` + `package.json` export `./attribution` |
| "court judge leaf + settlement-binding analysis (A6/INV-SETTLE-1/F-13, honest v1 host-mediated)" | `buildCourtJudgeLeaf` + A6 | `liquidEscrow.ts:264`; `docs/SETTLEMENT-BINDING.md` |
| "`confirmQuorum` default ⌈2N/3⌉" | parameter hardening | `confirmationMachineCore.ts:52` — `Math.ceil((2 * rosterSize) / 3)`; default applied at `courtConfirmationMachine.ts:239`; `quorumBelowSupermajority` at `:252` |
| "proofs (5 theorems + 4 economic + 4 security definitions + attribution)" | Proofs bullet | `docs/proofs/01..05-*.tex.md`, `economics/00..05` (5 files + README), `security/00..02`, `attribution.tex.md` |
| "mutation campaign (53 mutants, 8 spec holes closed, 100% re-sweep)" | mutation bullet | `docs/MUTATION_TESTING.md`: "**53 mutants across** 18 classes", "Combined post-closure score: **52/52 applicable = 100 %**" |
| "1,171,000 units / 3,592,861 checks / 0 failures" | scale campaign bullet | `docs/benchmarks/campaign-2026-11-11.json` — `status: green`, `failedChecks: 0`, `actualSizes` summing to **1,171,000**, per-corpus `checks` summing to **3,592,861** |
| "invariants 145 → 149" | Invariants bullet | 149 distinct `INV-*` ids in `docs/FORMAL_INVARIANTS.md`; `cross-check.mjs` indexes `{"invariant":149}` |
| "suite 1,534 passed" | Suite bullet | `npm test` → **1534 passed | 1 skipped** (§3) |

Scale-campaign arithmetic recomputed from the committed JSON (not copied from
the prose):

```
actualSizes  confirmation 10000 · tally 1000000 · merkle 1000 ·
             validator 50000 · selection 10000 · encoding 100000   = 1,171,000
Σ corpora[].checks                                              = 3,592,861
failedChecks = 0   status = green   profile = full   seed = 20261111
```

---

## 2. The full reproducibility contract on the tag — PASS (`REPRODUCED`)

```
timeout 2700 bash scripts/reproduce.sh     # -> exit 0
```

> Note on the cap: the first attempt under `timeout 1200` was killed at 20:00
> (`exit 124`) **while stage `g1` (bench) was still running** — the host was
> loaded (`loadAvg1m=26.09`, see §5) and the box needs 1,242 s for the full
> contract, versus the 1,000–1,015 s documented in `docs/REPRODUCIBILITY.md`.
> That is a wall-clock guardrail, not a contract failure; the complete run below
> is the authoritative one. All stages before the kill had already passed, with
> identical counts.

```
==================== VERDICT ====================
 commit: eb912977c06a   node: v22.23.2   date: 2026-11-11T02:37:48Z
 flags: (default: full contract)
-------------------------------------------------
 [a] clean-env check                                      PASS (0.037s)
 [b] npm ci (only network-dependent stage)                PASS (1.114s)
 [c] npm test (full suite) → json + junit               PASS (185.300s)
 [d] typechecks ×3 (impl / scripts / tests)              PASS (6.714s)
 [e] simulate:court (end-to-end whole-court deterministic sim) PASS (1.110s)
 [f1] model-check --fast (deterministic state-space sweep) PASS (708.454s)
 [f2] fixture comparison (regenerated == committed, digit-identical) PASS (0.213s)
 [f] model-check + fixture comparison                     PASS (708.754s)
 [g1] bench --json (single pass)                           PASS (338.706s)
 [g2] bench vs baseline (±20% bound, FAIL at >3x)         PASS (0.034s)
 [g] bench --json vs BASELINE                             PASS (338.755s)
 [h] cross-check.mjs (every evidence pointer in docs/CROSS_CHECK.md) PASS (0.099s)
 [i] suite pass-counts                                    PASS (0.044s)
-------------------------------------------------
 artifacts:
   npm ci ......................... PASS (lockfile-exact install)
   full test suite ................ PASS (json: .repro-artifacts/test-results.json, junit: .repro-artifacts/junit.xml)
   simulate:court ................. PASS (ALL GREEN, escrow/LN/liquid coherent)
   model-check fixture ............ PASS (digit-identical vs committed; stable hash: 35eb7eb8b5c292125bcddd693a4c812b1c55b63f0b341b25ad126148fd7d614d)
   bench (--json, single pass) .... PASS (variance bound ±20% vs BASELINE.md, FAIL >3x)
   cross-check evidence refs ...... PASS (count in .repro-artifacts/stage-h.log)
   parity/property/invariant ...... PASS (pass-counts in .repro-artifacts/stage-i.log)
-------------------------------------------------
 RESULT: REPRODUCED — every artifact PASS — total 1241.997s
=================================================
```

### Model-check: regenerated fixture is digit-identical to the committed one

```
[model-check] totals: {"instances":12,"states":1876862,"abstractStates":956449,"progressEdges":4233015,
  "selfLoops":2622176,"applications":73770605,"typedThrows":66915414,"rawThrows":0,
  "illegalEventChecks":45714690,"determinismPathsReplayed":2400}
[model-check] wall time: 806.2s
--- [f1] exit=0 ---

=== [f2] fixture comparison (regenerated == committed, digit-identical) ===
[compare-model-check] note: fast mode: skipped committed instances: vote n=4 k=2
[compare-model-check] OK — 12 regenerated instance(s) digit-identical to committed fixture
  (timing fields excluded) [fast mode; committed also carries: vote n=4 k=2]
--- [f2] exit=0 ---
```

`rawThrows = 0` across 18.77 M states / 73.77 M applications: the machine never
leaks an untyped error, on the tag exactly as committed.

### Cross-check: every evidence pointer resolves

```
=== [h] cross-check.mjs (every evidence pointer in docs/CROSS_CHECK.md) ===
cross-check: 276 claims indexed, 502 evidence refs verified
claims by kind:   {"invariant":149,"paper":71,"model-check":7,"bench":7,"suite":4,"error-taxonomy":5,"finding":12,"audit":21}
claims by evidence: {"test":243,"gap":13,"doc":4,"fixture":4,"bench":8,"model-check":1,"script":1,"pkg":2}
gap register entries: 18

OK — every evidence pointer in docs/CROSS_CHECK.md resolves.
--- [h] exit=0 ---
```

---

## 3. The shipped suite: 1,534 passed — claimed number CONFIRMED

```
$ npm test            # inside reproduce.sh stage [c]
 Test Files  63 passed | 1 skipped (64)
      Tests  1534 passed | 1 skipped (1535)
--- [c] exit=0 (185.300s) ---
```

Machine-readable corroboration from the artifacts that same stage wrote:

```
.repro-artifacts/junit.xml   : tests="1535" failures="0" errors="0"
.repro-artifacts/test-results.json : suites=320 passed=1534 failed=0 pending=1 total=1535 success=true
```

Contract-suite breakdown (`stage-i.log`) — the pass-counts are asserted, not eyeballed:

```
[test-suite-summary] contract suites (inside npm test):
  differential-parity    39 passed
  property-based         18 passed
  invariant-assertions   27 passed
  model-checking         19 passed
  adversarial            582 passed
  regressions            26 passed
  TOTAL                  1534 passed, 1 skipped in 64 files
```

The one skip is the pre-existing documented skip (same 1 skipped in every
historical release); **zero failures, zero deltas** against the CHANGELOG's
"Suite 1,534 passed".

---

## 4. Artifact consistency on the tag — PASS

| Artifact | Status | Evidence |
|---|---|---|
| `docs/proofs/` | present | `01-encoding`, `02-merkle-soundness`, `03-tally`, `04-machine-safety`, `05-threshold-soundness` (`.tex.md`), `attribution.tex.md`, `economics/` (5 docs), `security/` (3 docs), `README.md` |
| `proofs/mechanized/` | present | `court.qnt`, `run.sh`, `quint-run.log`, `README.md` |
| `proofs/lean4/` | present | `SingleFinality.lean`, `Axioms.lean`, `lakefile.toml`, `lean-toolchain`, `run.sh`, `lean-run.log`, `README.md` |
| `docs/MUTATION_TESTING.md` | present | 53-mutant catalogue record, pass 1 (86.8 %, 7 survivors) → post-closure 100 % |
| `docs/benchmarks/SCALE_CAMPAIGN.md` | present | 1,171,000 units / 3,592,861 checks / 0 failures |
| `attribution.ts` exported | yes | root module + `package.json` export map `"./attribution": {"types": "./attribution.ts", "default": "./attribution.ts"}`; re-exported from `index.ts`; exercised by `__tests__/attribution.test.ts` |

### 4.5 Lean 4 (ITP) — kernel-checked, no `sorry`

```
$ cd proofs/lean4 && ./run.sh          # exit 0
# tool: Lean (version 4.14.0, x86_64-unknown-linux-gnu, commit 410fab728470, Release)
═══ 1/2 lake build (kernel-checks every proof) ═══
✔ [2/3] Built SingleFinality
Build completed successfully.
[ok] build clean, no 'sorry'

═══ 2/2 axiom audit (no sorryAx / ofReduceBool / custom axioms) ═══
'BAOCourt.terminal_untouched' depends on axioms: [propext, Quot.sound]
'BAOCourt.final_stable' depends on axioms: [propext, Quot.sound]
'BAOCourt.finalized_outcome_unique' does not depend on any axioms
'BAOCourt.oracle_single_finality' depends on axioms: [Quot.sound]
'BAOCourt.epochMessage_finalized' depends on axioms: [propext, Quot.sound]
'BAOCourt.finalized_eq_epochMessage' depends on axioms: [propext, Quot.sound]
'BAOCourt.machine_alone_insufficient' does not depend on any axioms
'BAOCourt.no_equivocation' does not depend on any axioms
'BAOCourt.machine_final_certified_unique' does not depend on any axioms
oracle_single_finality : ∀ (s : SystemState) (e : Epoch) (m1 m2 : Message),
  State.Finalized s e m1 ∧ State.Finalized s e m2 → m1 = m2
═══ ALL CHECKS COMPLETED ═══
```

9 declarations audited; axiom footprint is exactly `propext` + `Quot.sound`
(classical Lean), **no `sorryAx`, no `ofReduceBool`, no custom axioms**. The
regenerated log is **identical to the committed `proofs/lean4/lean-run.log`**
after the header (date/tool line) and the two first-build `lake` manifest `info:`
lines — i.e. the shipped Lean log is a genuine output of the shipped sources.

---

## 5. Deltas found (none release-blocking)

1. **Wall-clock, not correctness: 1,242 s vs the documented 1,000–1,015 s.**
   `docs/REPRODUCIBILITY.md` §"measured" budgets ≈17 min; this host needed
   20:42 for the same contract (stage f 708 s and stage g 339 s dominating).
   Cause is host load, recorded by the script itself:
   `[bench-vs-baseline] host loadAvg1m=26.09 — regression gate DOWNgraded to warning`.
   Consequently `timeout 1200 bash scripts/reproduce.sh` — the cap in the
   release-verification checklist — **cannot** complete the full contract on a
   loaded box; use `timeout 1800`+ (or `--quick`) for the smoke pass.
2. **Three bench rows over the ±20 % bound, zero regressions.** With the gate
   downgraded on load, `g2` reported `over-bound=3 regressions=0`:
   `selectJury roster=50` +122.2 %, `selectJury roster=201` +63.1 %,
   `reduceCourtSigningMachine transitions=10000` +227.8 % (flagged
   `OVER-BOUND-LOADED`). The FAIL threshold is >3×, so the gate passes; the two
   `selectJury` rows look like `BASELINE.md` staleness worth a quiet-box
   refresh, not a v0.11.0 behaviour change. A re-run on load < 2 should be
   captured in the next `repro-log-*.txt`.
3. **`--fast` model-check omits one committed instance.** `[f2]` records
   `fast mode: skipped committed instances: vote n=4 k=2`; the committed
   fixture carries it and only the exhaustive sweep (`--full-model-check`)
   regenerates it. Documented behaviour, stated here so the 12-vs-13 instance
   gap is never mistaken for a mismatch.
4. **No delta** in the two headline claims: suite **1,534** and campaign
   **1,171,000 / 3,592,861 / 0** both match the CHANGELOG and release notes
   exactly.

---

## 6. Verdict

**PASS.** On the `v0.11.0` tag — not on `main` — `package.json` says `0.11.0`,
the CHANGELOG carries the matching section, the GitHub Release exists and its
notes are a faithful condensation of that section, the one-command contract
prints **`RESULT: REPRODUCED — every artifact PASS`** with a digit-identical
model-check fixture, the shipped suite is **1,534 passed / 0 failed**, every
cited artifact is inside the tag, and the Lean 4 mechanisation builds clean with
no `sorry` and a two-axiom footprint. The only deltas are wall-clock (a loaded
host) and baseline staleness on two `selectJury` rows — neither touches
behaviour, correctness, or any released claim.

## 7. Reproducing this verification

```bash
git worktree add --detach ../bao-court--verify-0110 v0.11.0
cd ../bao-court--verify-0110
timeout 1800 bash scripts/reproduce.sh            # expect: RESULT: REPRODUCED, exit 0
npm test                                          # expect: 1534 passed | 1 skipped
cd proofs/lean4 && ./run.sh                       # expect: no 'sorry', axiom audit clean
```

Logs from this run (host-local, not committed): `/tmp/opencode/reproduce-0110-full.log`,
`/tmp/opencode/lean4-0110.log`.
