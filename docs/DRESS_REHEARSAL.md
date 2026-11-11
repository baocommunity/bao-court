# DRESS REHEARSAL — End-to-End Verification Record

**Round:** 17 (symposium closing gate) · **Branch:** `chore/dress-rehearsal` ·
**Base:** `origin/main` @ `8422faa` · **Date:** 2026-11-10 · **Host:** linux
x64, 16 threads (shared box; load 2.7–4 during the bench stage, noted below)

This is the rehearsal record: every program artifact executed **as the
audience will see it**, outputs captured, issues found and fixed in this PR,
and the final sign-off checklist. One continuous pass on the rehearsal
branch; nothing skipped, nothing green-washed.

---

## 1. Stage-by-stage run record

### 1.1 The reproduction contract — `bash scripts/reproduce.sh` (FULL)

Full contract (no flags), single continuous foreground run. VERDICT captured
verbatim:

```
==================== VERDICT ====================
 commit: 8422faa6a827   node: v22.23.2   date: 2026-11-10T10:02:02Z
 flags: (default: full contract)
-------------------------------------------------
 [a] clean-env check                                      PASS (0.148s)
 [b] npm ci (only network-dependent stage)                PASS (1.685s)
 [c] npm test (full suite) → json + junit               PASS (172.957s)
 [d] typechecks ×3 (impl / scripts / tests)              PASS (6.041s)
 [e] simulate:court (end-to-end whole-court deterministic sim) PASS (1.073s)
 [f1] model-check --fast (deterministic state-space sweep) PASS (525.248s)
 [f2] fixture comparison (regenerated == committed, digit-identical) PASS (0.373s)
 [g1] bench --json (single pass)                           PASS (223.699s)
 [g2] bench vs baseline (±20% bound, FAIL at >3x)         PASS (0.026s)
 [h] cross-check.mjs (every evidence pointer in docs/CROSS_CHECK.md) PASS (0.072s)
 [i] suite pass-counts                                    PASS (0.035s)
-------------------------------------------------
 RESULT: REPRODUCED — every artifact PASS — total 931.510s
=================================================
```

Highlights against the committed record:

- **Full suite:** 1,492 passed / 1 skipped (61 files) — the 1 skipped is the
  env-gated live taproot test, as documented.
- **Model-check fixture:** regenerated `--fast` sweep is **digit-identical**
  to the committed fixture; stable artifact hash
  `35eb7eb8b5c2…d7d614d` — **byte-equal to the hash recorded in
  `docs/REPRODUCIBILITY.md`** for `7ab0d441f182`.
- **Bench:** 34 comparable rows, **0 over-bound, 0 regressions**. Honest
  note: host loadAvg1m was 2.74 during (g), so the hard gate self-reported
  warning-mode (per the load-aware design in `docs/REPRODUCIBILITY.md`); no
  row was anywhere near the 3× regression bound.
- **Cross-check:** 272 claims indexed, **493 evidence refs verified**, exit 0.
- **Suite pass-counts (stage i):** differential-parity 39, property-based 18,
  invariant-assertions 27, model-checking 19, adversarial 582, regressions 26
  — total 1,492 passed in 61 files.
- Total 931.5 s ≈ **15.5 min**, inside the ~17 min measured contract
  envelope (999.9–1015.1 s) and, this time, under the 15-min aspirational
  target + variance.

### 1.2 Demo script beats — `docs/presentation/DEMO_SCRIPT.md`, executed live

- **Beat 2 (`simulate:court`, run twice + diff):** output matches the
  script's expected block exactly — same seed → same jury (5/12), same group
  key `d243bcb9d57e…`, same Liquid address
  `tex1qdzh32c00ch3s89udh9mutnevfwdzppj8pg9dnf69pz45umn34vgq4rerfv`, same
  slashing pool 5000, `RESULT: ALL GREEN`. The two-run diff is **exactly one
  line** — the attestation signature bytes (fresh FROST nonces by design,
  vector H), precisely as the script promises.
- **Beat 3 (`model-check --only "signing n=2"`):** matches the documented
  block digit-for-digit — states 2532, applications 78588, typedThrows
  66503, **rawThrows 0**, determinismPaths 200 (wallMs 852 vs documented
  1041 — timing only, as expected). Fixture restored after the demo (the
  committed full-sweep fixture is untouched in this PR; `git status` clean).
- **Beat 4 (`cross-check.mjs`):** exact match with the documented output —
  272 claims, 493 refs, gap register 17, `OK`, exit 0.
- **Beat 3 one-liner (`node -e … require(fixture)`):** works; prints the
  committed headline `{"instances":13,"states":3145632,…}` as documented.
- **Beat 5:** covered by §1.1 — the committed-log fallback remains valid and
  the live full-contract run reproduced the same VERDICT shape.

### 1.3 The reviewer's 30-minute docs walk

Path walked in order: README → GLOSSARY → FORMAL_INVARIANTS (header +
method note) → THREAT_MODEL (header) → CRYPTO_AUDIT §7 → EVALUATION
(summary + §5) → REPRODUCIBILITY (contract) → TESTING_GUIDE, plus every
doc-to-doc link on that path.

- All cross-links resolve (GLOSSARY ↔ FORMAL_INVARIANTS §15, THREAT_MODEL ↔
  CROSS_CHECK/CRYPTO_AUDIT, README ↔ paper/FAQ/glossary, EVALUATION ↔
  benchmarks, CHANGELOG/tags, CI workflow badge target present).
- FORMAL_INVARIANTS' v0.9.2 header + line-number caveat is explicitly
  reconciled by its round-16 note (A-4) — not confusing on a second look.
- GLOSSARY `CourtError (v0.10.1)` and README quick-start pin `#v0.10.1`:
  both correct — v0.10.1 is the newest release **tag** (0.10.2 is tagged in
  CHANGELOG but not yet released as a git tag), so no change made.

**Stale numbers found and fixed in this PR** (see §2).

---

## 2. Issues found and dispositions

| # | Issue | Disposition |
|---|---|---|
| 1 | `README.md` §11 claimed "787 passing" — three releases stale (actual: 1,492) | Fixed — **landed independently in the parallel coherence PR #71** (same measured number); deduplicated on rebase |
| 2 | `docs/REPRODUCIBILITY.md` stage-c row said "all 1,491 tests green" | Fixed — landed independently in PR #71; deduplicated on rebase |
| 3 | `docs/EVALUATION.md` §1 recorded 1,491 passed (PR #64 state) | Annotated in this PR with the round-17 rehearsal refresh (1,492; PR-#64 line kept as history) |
| 4 | `docs/EVALUATION.md` §5 said "492 evidence refs" vs the script's actual 493 | **Fixed in this PR** → 493 |
| 5 | `docs/presentation/DEMO_SCRIPT.md` said "14 open gaps" (PR #63 number) vs the register's 13 open (of 17 entries) | **Fixed in this PR** → 13 |
| 6 | `docs/TESTING_GUIDE.md` header said "~1486 tests" | Fixed — landed independently in PR #71; deduplicated on rebase |
| 7 | (Observation, no change) demo beat-2 diff shows 4 banner lines if the presenter uses `npm run simulate:court` instead of direct `tsx` — the script already prescribes direct `tsx`; no change needed | Documented here |
| 8 | Demo Beat 3 (`--only` sweep) rewrites the committed model-check fixture, so a following Beat 4 cross-check reports MC-3/MC-4 and exits non-zero — found live in rehearsal (the gate worked exactly as designed) | **Fixed in this PR** — Beat 3 heads-up + a fallback-table row added to `DEMO_SCRIPT.md` (`git restore __fixtures__/model-check-summary.json` between beats) |

*Rebase note: the contract run in §1.1 executed on base `8422faa`; the
parallel round-17 coherence PR (#71) landed mid-rehearsal and this branch
was rebased onto it (`ecdc1e5`) before merge. PR #71 independently fixed
issues 1/2/6 with the same measured numbers — two independent sessions
measuring 1,492/1 skipped is itself a reproducibility data point.*

Nothing else: no broken links, no failing stage, no non-trivial debt
surfaced by the full contract run.

---

## 3. Sign-off checklist — the program's completion certificate

| Program artifact | Present | Verifiable | Green |
|---|---|---|---|
| Protocol paper (`docs/FROST_COURT_ORACLE_PAPER.md`) | ✅ | claims → CROSS_CHECK index | ✅ |
| One-command contract (`scripts/reproduce.sh` + `docs/REPRODUCIBILITY.md`) | ✅ | full run above: REPRODUCED, 931.5 s | ✅ |
| Full test suite (61 files, 1,492 passed) | ✅ | json + junit artifacts captured | ✅ |
| Typechecks ×3 (impl / scripts / tests) | ✅ | stage (d) PASS | ✅ |
| Whole-court simulation (`scripts/simulateCourt.ts`) | ✅ | `RESULT: ALL GREEN`, two-run diff = 1 sig line | ✅ |
| Model-check fixture (`__fixtures__/model-check-summary.json`) | ✅ | digit-identical regeneration; stable hash matches record | ✅ |
| Performance baseline (`docs/benchmarks/BASELINE.md` + medians json) | ✅ | 0 regressions / 0 over-bound vs ±20% gate | ✅ |
| Committed reproduction record (`docs/benchmarks/repro-log-2026-11-10.txt`) | ✅ | VERDICT block reproduced live this round | ✅ |
| Claim→evidence index (`docs/CROSS_CHECK.md` + `scripts/cross-check.mjs`) | ✅ | 272 claims / 493 refs resolve, exit 0 | ✅ |
| Formal invariants (`docs/FORMAL_INVARIANTS.md`, 146 INV-*) | ✅ | pinned by invariant-assertions + model-checking suites | ✅ |
| Threat model (`docs/THREAT_MODEL.md`) + crypto audit (`docs/CRYPTO_AUDIT.md`) | ✅ | §7 argument skeleton ↔ invariants ↔ anchors | ✅ |
| Evaluation chapter (`docs/EVALUATION.md`) | ✅ | every number ↔ committed artifact | ✅ |
| Presentation kit (`docs/presentation/OUTLINE.md`, `FIGURES.md`, `DEMO_SCRIPT.md`) | ✅ | demo beats executed live this round | ✅ |
| Testing guide (`docs/TESTING_GUIDE.md`) + helpers kit | ✅ | suite map matches the 61-file tree | ✅ |
| Glossary (`docs/GLOSSARY.md`) | ✅ | INV ids resolve; version note accurate | ✅ |

**SIGN-OFF: every program artifact present, verifiable, and green. The
rehearsal is the show: the show is ready.**

---

*Recorded by the round-17 dress-rehearsal session (subagent, identity
`Mr BAO`, branch `chore/dress-rehearsal`). Raw artifacts from the run are
git-ignored under `.repro-artifacts/`; the VERDICT and stage logs quoted
here were captured 2026-11-10 09:46–10:02 UTC.*
