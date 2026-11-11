# Mutation testing — the v0.13 surface (CAMPAIGN 2)

*Round 37. Companion: `bao.markets/docs/MUTATION_TESTING_V013.md` (the host
economics leg). Evidence: `scripts/mutation/pass1-v013.json` (as found, base
**v0.13.1 `bedb476`** + this round's harness) and
`scripts/mutation/pass2-v013-postclosure.json` (after closure, re-run on the
rebased tree — main had advanced to round 5 `d7117c0`, r38-1).*

The first campaign (`docs/MUTATION_TESTING.md`, 53 mutants in 18 classes) asked
whether the *spec* could see a deliberate bug in the ceremony. It could not see
seven of them, and those seven became tests (`__tests__/mutationClosures.test.ts`).

That campaign predates almost everything v0.13 is built on. Since it ran, the
package grew: the **per-round bond** (R31, r30-1), `requireRoundBond`, the churn
cap, the quorum-aware cap (r30-3), the **decay pairing** (r30-4a/b), the
**sign-based ladder bound** (r33-6), the **complete escalation ledger** (r33-5)
and the round-4 fixes (r33-1 refuse *any* accepted membership bond; the bond
billing that followed). None of it appeared in a mutant.

This round adds **25 mutants in 10 new classes** for that surface, runs the same
three detectors, and closes what survives.

---

## 1. Method

Unchanged from campaign 1 — the runner is the same program
(`scripts/mutation/run-mutants.mjs`), and the guarantees are the ones the first
campaign bought with a 27-minute hang and two wall-clock false captures:

- **Sandboxed.** The tree is copied under `/tmp/bao-court-mutation-<pid>/`; the
  repository is never written to. Tracked `git status` and a sha256 of every
  mutable file must be identical before and after, or the run reports a *runner
  bug* (exit 1).
- **Green baseline first** — the pristine sandbox must pass the suite, or every
  capture is noise.
- **Unambiguous by construction** — every `find` must occur exactly once.
  `node scripts/mutation/check-catalogue.mjs` proves the whole catalogue in ~1 s
  before a sweep (new in this round; the runner still refuses ambiguous finds).
- **Deterministic and crash-safe** — mutants run in id order; each finished
  mutant is appended to `<out>.partial.jsonl` immediately.

### Three detectors

| | Detector | Scope |
|---|---|---|
| **A** | `vitest` battery | the full suite **minus** `__tests__/modelChecking.test.ts` (that work *is* B) and `__tests__/simulateCourt.test.ts` (a wall-clock budget, which produced two false captures in campaign 1) |
| **B** | model explorer | `scripts/mutation/model-probe.mjs` → the reduced inline instances of the three ceremony machines (`confirmation`, `vote`, `signing`) |
| **C** | invariant probe | `scripts/mutation/spot-check.mjs` → **S01–S32**: 18 campaign-1 probes plus **S19–S32**, one per v0.13 invariant (INV-ESC-*, 02-ladder Thm 2, 06 §1.5/§3/§4, INV-CONF-4), importing nothing from `__tests__/` |

Detector C grew with the surface on purpose. A probe is a black-box restatement
of a published invariant; when a *new* invariant is published and no probe
restates it, detector C silently stops covering that area — which is how a
"43 % detector" stays at 43 % while the spec doubles.

Structural note, recorded up front: **13 of the 25 new mutants touch no modelled
machine** (`ladderEconomics`, `penaltyAging`, `quorumEconomics` are pure
functions; `courtConfirmationMachine.ts`'s factory is outside the explored
transition relation). Detector B's honest denominator for this round is the
**12** machine-attached mutants, not 25 — the same honesty campaign 1 applied
when it said 21 of 53 could not be seen by B at all.

---

## 2. How to run

```bash
node scripts/mutation/check-catalogue.mjs                  # applicability, ~1 s
node scripts/mutation/run-mutants.mjs --jobs 5             # full sweep (~45–60 min)
node scripts/mutation/run-mutants.mjs --only M54,M65       # subset
node scripts/mutation/run-mutants.mjs --only M54,M55,...   # this round's 25
```

The round-37 sweep used `--jobs 5 --only <the 25 new ids>`; the full-suite
baseline in that run was green (see §3).

---

## 3. Results

Baseline (pristine sandbox, detector-A scope): **1663/1664** green, 0 failed, in
55.0 s (the 1 is the env-gated live Taproot test). The first attempt failed one
load-sensitive test (`r33ByzantineRelay`, a 5-node multi-process matrix) and the
runner retried the baseline once — that is the only place a retry is allowed, and
it is recorded in the run log, not hidden.

### Pass 1 — as found

Artifact: `scripts/mutation/pass1-v013.json`.
Tree state certified **pristine** before and after (`cleanTree.unchanged: true`).

| Metric | Value |
|---|---|
| New mutants | **25** in 10 classes (catalogue 78 / 28) |
| Captured | **24** |
| Survived | **1** (M66) |
| Mutation score | **96.0 %** |

| Detector | Captured / 25 | Score | Honest denominator |
|---|---|---|---|
| **A** — vitest battery | 23 | **92.0 %** | 25 |
| **B** — model explorer | 1 | 4.0 % overall | **12** machine-attached → **8.3 %** |
| **C** — invariant probe | 19 | **76.0 %** | 25 |
| **Union** | **24** | **96.0 %** | 25 |

Per class:

| Class | Captured | Score | Survivors |
|---|---|---|---|
| `round-bond-consumption` | 5/5 | 100 % | — |
| `escalation-witness-binding` | 2/2 | 100 % | — |
| `require-round-bond` | 3/3 | 100 % | — |
| `escalation-ledger-completeness` | 2/3 | 66.7 % | **M66** |
| `ladder-bound-sign` | 4/4 | 100 % | — |
| `penalty-aging` | 2/2 | 100 % | — |
| `weight-anchor` | 2/2 | 100 % | — |
| `policy-flag-recording` | 1/1 | 100 % | — |
| `ladder-bond-schedule` | 2/2 | 100 % | — |
| `quorum-capture-arithmetic` | 1/1 | 100 % | — |

### Per mutant

| ID | Class | A | B | C | Verdict |
|---|---|---|---|---|---|
| M54 | round-bond-consumption (consumed set skipped) | ✓ | — | ✓ | captured |
| M55 | round-bond-consumption (membership bond relabelled) | ✓ | — | ✓ | captured |
| M56 | round-bond-consumption (refuse only OWN bond — r33-1) | ✓ | — | ✓ | captured |
| M57 | round-bond-consumption (barrier relabel check) | ✓ | — | · | captured |
| M58 | round-bond-consumption (barrier cross-round reuse) | ✓ | — | · | captured |
| M59 | escalation-witness-binding (roundIndex dropped) | ✓ | ✓ | · | captured |
| M60 | escalation-witness-binding (bond not bound to its own challenger) | ✓ | — | · | captured |
| M61 | require-round-bond (strict accepts missing, live) | ✓ | — | ✓ | captured |
| M62 | require-round-bond (strict accepts missing, barrier) | ✓ | — | ✓ | captured |
| M63 | require-round-bond (policy not recorded) | ✓ | — | ✓ | captured |
| M64 | escalation-ledger-completeness (short log accepted) | ✓ | — | ✓ | captured |
| M65 | escalation-ledger-completeness (barrier not re-run on escalate) | ✓ | — | ✓ | captured |
| M66 | escalation-ledger-completeness (round bound removed) | · | · | · | **survived → equivalent** |
| M67 | ladder-bound-sign (no-safe-depth clamped to 1) | ✓ | — | ✓ | captured |
| M68 | ladder-bound-sign (`ok` by derivedCap, not the sign) | · | — | ✓ | captured |
| M69 | ladder-bound-sign (safe cap rounds up) | ✓ | — | ✓ | captured |
| M70 | ladder-bound-sign (flip round floored) | ✓ | — | ✓ | captured |
| M71 | penalty-aging (elapsed ignored) | ✓ | — | ✓ | captured |
| M72 | penalty-aging (λ halved — half-life 6) | ✓ | — | ✓ | captured |
| M73 | weight-anchor (anchor at w0 — r30-4a) | ✓ | — | ✓ | captured |
| M74 | weight-anchor (floor clamp removed) | ✓ | — | · | captured |
| M75 | policy-flag-recording (weak quorum never recorded) | ✓ | — | ✓ | captured |
| M76 | ladder-bond-schedule (2^R marginal) | ✓ | — | ✓ | captured |
| M77 | ladder-bond-schedule (cumulative one rung short) | ✓ | — | ✓ | captured |
| M78 | quorum-capture-arithmetic (κ baseline floored) | ✓ | — | ✓ | captured |

Two rows are worth reading:

- **M68 (Detector C alone).** Replacing the sign test `ok: maxLadderRounds <
  flipRound` with the derivedCap comparison `ok: maxLadderRounds <= derivedCap`
  is invisible to the suite, because the two agree at every non-integer sign
  boundary and every published row is non-integer. They differ at an **exact**
  integer boundary — `a_f = 0.5, ρ = 1, β = 3` gives
  `ln(¼)/ln(½) = 2` — where the derivedCap comparison blesses the break-even
  round. Probe S26 is the only thing that pins it. This is precisely the
  detector-independence argument the first campaign made, and the reason a
  43 %-scoring detector earned its keep.
- **M59 (Detector B's only kill).** Dropping the `roundIndex === ladderRound + 1`
  binding is caught by the explorer *and* the suite. The explorer reaches it
  because escalation is a transition in the modelled confirmation machine —
  one of the twelve mutants B can see at all.

---

## 4. The survivor: M66, and the bug it uncovered (r37-1)

M66 deletes the escalation log's round bound
(`a record may not name a round the case never opened`). Nothing fired.

**Why:** the guard is unreachable on the shipped rules. The consecutive `2..k`
rule forces `round = offset + 2`, and the completeness rule forces
`log.length = ladderRound − 1` (or `ladderRound` in `ladder_pending`); the largest
reachable round is therefore exactly `ladderRound` (`+1` while pending), so the
bound can never be exceeded. **M66 is equivalent** — not a spec hole.

**What investigating it found.** The barrier's *completeness* rule was
deliberately taught about `ladder_pending` («the offset differs there by one»),
but the *round bound* was not: it compared against `state.ladderRound` alone. A
state produced by `escalate` — phase `ladder_pending`, `ladderRound` 1, one
record naming round 2 — therefore **threw its own barrier's error**:

```
CourtConfirmationTransitionError: escalation log records a round the case never opened
```

Confirmed by a direct probe of a legal state, not by reading. The reducer never
calls the barrier in that phase (it validates before appending, and at
finalize), so nothing shipped broke — but `assertValidEscalationLog` is exported
as the **restore-time barrier** (INV-ESC-8), and a host that restores a snapshot
parked between `escalate` and `open_ladder_round` — a crash window the reducer
itself creates — was refused by the barrier that is supposed to vouch for it.

**The fix** (`confirmationMachineCore.ts`): the bound is now
`ladderRound + (phase === 'ladder_pending' ? 1 : 0)`, i.e. the rounds the case may
have opened, matching the completeness rule. The closure pins
(`__tests__/mutationClosuresV013.test.ts`, C10) assert:

1. a legal `ladder_pending` snapshot is **accepted** (this test **fails** on the
   pre-fix source — verified by reverting the hunk and re-running);
2. a record naming a round beyond the pending rung is still **refused**;
3. a log longer than the opened rounds is still **refused**.

This is the outcome a mutation campaign is for: the survivor was not a missing
assertion, it was a guard pointing the wrong way in one phase.

---

## 5. Pass 2 — after the fix and the pins

Artifact: `scripts/mutation/pass2-v013-postclosure.json`.

> **Provenance.** Pass 1 ran on v0.13.1 (`bedb476`). While this round was in
> flight, main advanced to round 5 (`d7117c0`, r38-1: `accept_challenge` now
> binds one proof hash to one roster index, plus four dispositions). Pass 2 was
> re-run **on the rebased tree** so the recorded verdicts describe the code that
> is actually shipping — the alternative (rebasing quietly and shipping
> pass-1-era numbers) is how a mutation table becomes fiction.

| Metric | Pass 1 (v0.13.1) | Pass 2 (rebased, r38-1 in) |
|---|---|---|
| Mutation score | 96.0 % (24/25) | **96.0 % (24/25)** |
| Detector A | 92.0 % (23/25) | 92.0 % (23/25) |
| Detector C | 76.0 % (19/25) | 76.0 % (19/25) |
| M66 | survived | survived (**equivalent**) |
| Clean tree | pristine | pristine |

The score does **not** move, and claiming otherwise would be the dishonest move:
M66 is unreachable by construction, so no test can kill it without making the
package's rules self-contradictory. The round's gain is the r37-1 fix and its
three pins, plus the two closure facts the re-run establishes: the fix changed no
other mutant's verdict, and the new tests run inside every mutant's suite without
becoming a source of noise.

---

## 6. Honest conclusion

**The v0.13 surface is well pinned — materially better than the v0.11 surface
campaign 1 measured.** 24 of 25 deliberate regressions were caught, and the
captures are not concentrated in one detector: A alone gets 23, C alone 19, B
alone 1 of the 12 it can even see. The parts the review rounds fought over are
the parts with the densest pins: the per-round bond (5/5), the strict policy
(3/3), the witness binding (2/2), the ladder sign (4/4) and the decay pair (4/4).

Four qualifications, in order of how much they should worry a reader:

1. **A 96 % score is a statement about the tests, not the protocol.** The mutants
   are hand-written; they encode the bug classes *this reviewer* thought of.
   The r37-1 finding is the proof of the asymmetry: the only real defect the
   round found was found by *reading the survivor*, not by any of the 25 mutants
   or 32 probes.
2. **The escalation-ledger class is the weakest at 66.7 %, and one mutant there
   is equivalent.** The bound exists because a future change to the other two
   rules could make it live; the campaign could not demonstrate it live, and says
   so rather than deleting the guard (deleting it on "it looks dead" reasoning is
   how the r37-1 class of bug gets reintroduced).
3. **Detector B is nearly blind to this round by construction** — 12 of 25
   mutants touch the modelled confirmation machine, and the pure economics
   modules (`ladderEconomics`, `penaltyAging`, `quorumEconomics`) are functions,
   not transitions. The explorer's 8.3 % here is not a regression: it is the same
   structural boundary campaign 1 documented, now with a larger economics
   surface behind it.
4. **Scores are not comparable across rounds unless the denominators are.** 96.0 %
   here and 86.8 % in campaign 1 measure different mutant sets on different
   code — the useful comparison is per class, not per total.

Host leg (bao.markets side of the same surface): `bao.markets/docs/MUTATION_TESTING_V013.md`
— 11 mutants, 81.8 % as found, 100 % after two pinning tests, with one
equivalence and one registered inconsistency of its own.

