# Whole-package readiness review — v0.13.0+ (`608e6dc`), round 35

**Date:** 2026-11-11 · **Branch:** `docs/readiness` (from `origin/main` @ `608e6dc`) ·
**Scope:** the complete submission artifact — paper, all normative documents,
`docs/proofs/**`, `proofs/mechanized`, `proofs/lean4`, the code the claims name,
and the reproduction contract — reviewed as if it were submitted tomorrow.

**Method.** Three personas were run fresh and adversarially against the *whole*
package, not a diff: a venue chair (is the contribution crisp and honestly
placed?), a reproducibility reviewer (can an outsider regenerate every number
from the tag?), and an adversarial methods reviewer (are the open obligations
and the measurement claims framed so they cannot flatter us?). Every verdict
below is backed by a command that was actually run in this worktree, or by an
artifact that was actually opened. Nothing is quoted from the round documents
without re-reading the file it points at.

**What was executed for this review (this worktree, Node v22.23.2):**

| Check | Command | Result |
|---|---|---|
| Install | `npm ci --prefer-offline` | lockfile-exact, 73 packages |
| Full suite | `npx vitest run` | **1,686 passed / 1 skipped, 76 files** (234.7 s) |
| Typechecks ×3 | `npm run typecheck` / `:scripts` / `:tests` | all clean |
| Claim ledger | `node scripts/cross-check.mjs` | **285 claims / 516 evidence refs, every pointer resolves**; 271 covered (95.1 %), 14 open |
| Model-check fixture | opened `__fixtures__/model-check-summary.json` | 15 instances, 3,869,232 states, 213,521,172 applications, **60,020,684 illegal-witness probes, 0 accepted**, 0 raw throws, max depth 2 |
| Corpora artifact | opened `docs/benchmarks/campaign-2026-11-11.json` | 9 corpora, 1,187,000 units, **3,745,566 checks**, 608.8 s, 0 failures |
| Economics arithmetic | `node scripts/review-quant/economics.mjs` | every ladder/cap/κ/decay number in §8.4 and App. A S-21 reproduced |
| Mutation artifacts | opened `scripts/mutation/pass{1,2,3}-*.json` | pass 1: 53 mutants, 46 flagged, 7 survivors, 86.8 %; pass 2: 7/7 captured by the closure pins alone; pass 3: M40 equivalent |
| Proof toolchains | `command -v lean elan lake quint java` | **absent on this host** — Lean 4 and Quint are read from their committed logs, not re-executed |
| Cross-repo artifacts | host repo `bao.markets` @ `65b7cef05` | `SOAK_3DAY.md`, `soak-3day.json`, `REGISTERED_FINDINGS_SWEEP.md` all committed there |

**Housekeeping note (not mine, left untouched):** the shared `bao.markets` and
`bao-court` working trees both carry large staged reversions (216 paths in
`bao-court`'s index; the three court docs staged as deleted in `bao.markets`).
This review was done in an isolated worktree from `origin/main` and did not
touch either index. Someone should reconcile those before the next release
train, because a `git commit` on those trees would ship the reversion.

---

## Persona 1 — Venue chair

### Verdict: **READY-WITH-EDITS**

**Reasons it can be accepted.** The contribution is crisp and correctly
ordered: one protocol (JIT FROST dispute oracle), one extension (universal
confirmation + epoch cohorts + batch attestation), one artifact (reference
implementation + a stated evaluation method), one honest perimeter (§13).
The related-work table (§1.5) is the best part of the paper for a reviewer: it
names DLC, UMA, Augur, OCR, ROAST and Kleros on *three* axes, and the third
column is deliberately unflattering ("where the neighbour is better than BAO
Court") — DLC has on-chain verdict enforcement, UMA needs no panel at all,
ROAST proves a liveness guarantee this design does not have, Augur has a
stronger backstop, Kleros has a live court. A reviewer who suspects the paper of
overselling finds that suspicion pre-empted in the table rather than in a
rebuttal.

Two citations that a chair would otherwise check were verified against their
sources: **Crites/Katz/Komlo/Tessaro/Zhu, CRYPTO 2025 (LNCS 16005, 480–511;
ePrint 2025/1061)** is exactly as cited, including the LDVR framing; and
**CVE-2025-58359** is real — *but the paper's gloss of it was wrong* (see E4):
the advisory says a reduced `min_signers` on refresh did **not** lower the
threshold, it reduced the security of participants' shares. That is the single
citation-level defect found, and it was fixed here.

**Is §11.6 a methodological contribution that can carry a paper?** As written:
it can carry a *section*, not the paper. It is credible because it is falsifiable
— a finding is `EXPLOITABLE` only with a test that fails before the fix, the new
tests must be red on the pre-fix head (round 29: 4 of 15; round 4: 6 of 21), and
mutation probes ask whether the *existing* suite notices a removed guard. It is
also self-limiting in the right way: §11.6 states that a mirror cannot catch a
mirror (the explorer's own escalation property had codified the r29-1 bug), that
there is no incentive asymmetry, and that a fix nobody attacks is not evidence.
The honest weakness is *sample size*: three self-found defects plus one
instrumentation failure (SOAK-F8) is a case study, not a method with a measured
yield. Recommendation: keep it as contribution 7 **worded as an assurance-case
method tied to this artifact**, and resist any future temptation to promote it
to the headline — the headline is the protocol, and it is strong enough.

**What would still make a chair hesitate.** (i) The paper is dated at a head
that is four commits ahead of the `v0.13.0` tag, and two of those commits fix
`EXPLOITABLE` findings (r33-1, r33-5) — a reviewer who checks out the tag gets a
package with known-exploitable escalation paths and a slightly different paper.
(ii) Several supporting documents contradicted the paper's own numbers
(three different "pre-witness" state totals; a cross-check coverage table whose
total row was 9 claims short of its own rows). Those are fixed here; (i) is not
fixable by a doc edit and is the top remaining action.

**Prioritized edit list (venue chair):**
1. *(applied, E4)* Correct the CVE-2025-58359 gloss in reference [20].
2. *(remaining)* Cut `v0.13.1` at the merge head so the tag a reviewer checks
   out is the head this paper describes.
3. *(applied, E5–E8)* Refresh the suite count and the stale provenance headers
   (`CROSS_CHECK`, `THREAT_MODEL`, `REVIEW_SIMULATION`) so no document carries a
   v0.10.2 label under a v0.13.0 paper.
4. *(remaining)* Choose the venue and trim the 370-word abstract to the 250-word
   form most chairs enforce; the material to cut is the evaluation enumeration,
   which §11 repeats verbatim.

---

## Persona 2 — Reproducibility reviewer

### Verdict: **READY-WITH-EDITS**

**What genuinely reproduces.** The contract is real and the hard claim is
digit-exact: the model-check fixture is compared with *zero tolerance* on every
non-timing field, cross-check verifies all 516 evidence pointers mechanically,
and the benchmark gate is ratio-based with a quiet-box rule. Spot-checking
**12 numbers** chosen across the paper (below), *all twelve* reproduced from
committed artifacts except the suite count, which was stale by 9 tests.

| # | Paper number | Source | Result |
|---|---|---|---|
| 1 | 3,869,232 states | `__fixtures__/model-check-summary.json#totals.states` | ✅ exact |
| 2 | 213,521,172 applications | same, `totals.applications` | ✅ exact |
| 3 | 60,020,684 illegal witnesses, 0 accepted | sum of `instances[].illegalWitnessProbes` | ✅ exact (all 6 confirmation instances) |
| 4 | 537,825 states / 18,271,978 probes | `instances[9]` | ✅ exact |
| 5 | 1,187,000 units | sum of `declaredSizes` in campaign JSON | ✅ exact |
| 6 | 3,745,566 "assertions" | sum of `checks` in campaign JSON | ✅ exact (artifact calls them `checks`) |
| 7 | 608.8 s corpora | `wallMs: 608793` | ✅ exact |
| 8 | −2.40 % → −1.86 %, −0.543 % | `scripts/review-quant/economics.mjs` output | ✅ exact |
| 9 | 0.86× → 54.1× venue/griefer | same script (`54.11x`) | ✅ exact |
| 10 | 101,250 sats honest cap; 21,838 sats quorum-aware | same script | ✅ exact |
| 11 | 2.47× churn shortfall; +26.0 % decay at 6/6 | same script | ✅ exact |
| 12 | ≈223 BTC seed-grinding bound | ΔP = 1.4043e-2 (script line 95) × 3.125e8 sats | ✅ 222.5 BTC |
| — | 1,677 passing / 75 files | `npm test` at this head | ❌ **1,686 / 76** (fixed, E5–E8) |

**Where a clean-clone outsider hits a wall.** The contract header claimed
"**every** artifact the paper and CROSS_CHECK cite is regenerable with ONE
command". That was false, and it was the one claim in the package that would
have been caught by a referee in five minutes:

- `scripts/reproduce.sh` runs stages a–i: env, `npm ci`, suite, typechecks,
  simulation, model-check, bench, cross-check, suite counts. It does **not** run
  the statistical corpora, the mutation campaign, the economics derivation, the
  multi-process ceremony, the Lean 4 proof, or the Quint model — and it cannot
  run the three-day soak, which lives in the host repository.
- The **tag-to-tag table** in `docs/REPRODUCIBILITY.md` has exactly one row
  (`7ab0d441`, post-v0.10.2). The promise "every release tag reproduces its own
  numbers" is therefore unexercised for `v0.12.0`, `v0.12.1` **and `v0.13.0`**.
- `proofs/lean4` and `proofs/mechanized` were **not referenced by the paper at
  all** — not in §11, not in App. A.2, not in CROSS_CHECK. Two of the strongest
  artifacts in the repository (a 633-line Lean 4 development with a clean axiom
  audit; a 1,626-line independent Quint model with 42 scenario tests, 20,000
  seeded simulation runs and an Apalache check) were unclaimed. Under-claiming is
  safer than over-claiming, but a referee who finds them will ask what else is
  unclaimed.

**Prioritized edit list (reproducibility):**
1. *(applied, E1)* Scope the one-command claim and add the explicit
   outside-the-contract table with each artifact's own command.
2. *(applied, E5–E8)* Refresh the suite count to the measured 1,686 / 76 files
   at `608e6dc`, and record the composition of the +9 (round-33 relay suite ×8,
   r29-11 timeout pin) so the next refresh is a one-line change.
3. *(applied, E9–E13)* Replace four stale pre-witness triples with the current
   fixture numbers and label the historical ones as historical.
4. *(applied, E2/E3/E14)* Fix the cross-check total row (276→285, 262→271,
   94.9→95.1 %) and the v0.10.2 headers.
5. *(applied, E15)* Cite `proofs/lean4` and `proofs/mechanized` in App. A.2 with
   their scope and their toolchain requirement.
6. *(remaining, P1)* Tag `v0.13.1` at the merge head and append **one** row to
   the tag table from a real full-contract run (~17 min). Until then the
   tag-level promise is documentation, not evidence.
7. *(remaining, P4)* Add `--with-campaign` / `--with-mutation` optional stages,
   or keep them out permanently and cite the table added here.

---

## Persona 3 — Adversarial methods reviewer

### Verdict: **READY-WITH-EDITS**

**The six proof obligations are framed honestly.** `docs/proofs/README.md` §4 is
a closed list of **six** lemma gaps — GAP-4a (producer discipline for machine
states is assumed, not type-enforceable), GAP-4b (allowlist membership through
the string/array barrier), GAP-5a (`@vbyte/frost` semantics probe-pinned, not
verified from source), GAP-5b (T5's verification direction is a conditional
reduction), GAP-6a (attribution identity rests on the certified-share pin and an
authenticated log), GAP-6b (the batch-signing duty is normative, not mechanical).
Each one names what it costs: GAP-5a is load-bearing ("the pinned library
implements those semantics" is a premise of the whole attestation claim) and the
paper carries it into Table 2 as a stated dependency rather than burying it. The
18-entry **PO register** separately carries deployment residuals with an
"acceptable now because" column — a structure that makes it hard to quietly
upgrade a residual to a guarantee, because the upgrade would have to delete an
argument for why it was acceptable.

**The mutation score does not overfit, but it is not a release gate.** The
honest reading survives scrutiny: pass 1 is 53 mutants / 46 flagged (2 of them
wall-clock artifacts) / 7 survivors / 86.8 %; the "100 %" is a **subset**
statement — 52 of 52 *applicable* mutants, with M40 excluded as a proven
equivalent (its removal only changes the error message, because every handler
re-checks its own phase). That is stated in §6 and §7 rather than in a headline,
which is the right place for it. The 14 closure tests are genuine pins, not
tautologies — I spot-checked **five** (`mutationClosures.test.ts`):

- **C1 (M30)** — builds an event whose signer-set *root* is the pinned tag, first
  asserts the root pin alone **accepts** it (control), then asserts the length
  rule rejects it with the exact message. A tautology could not pass the control.
- **C2 (M31)** — hand-restores a frozen signer set that is a strict prefix, then
  an extra signer; both throw the freeze error on a `tick`.
- **C5 (M07)** — forces an exact priority tie by choosing a `weightFn` that makes
  every priority exactly 1, asserts the tie is real, *then* asserts ascending
  order. The tie is manufactured, not assumed.
- **C7 (M35)** — accepts exactly `MAX_BATCH_VERDICTS` and rejects `MAX + 1`.
- **C9 (M52)** — fabricates a batch event and asserts the index bound fires
  *before* the root is recomputed, by message.

The pass-2 artifact confirms each survivor was captured **only** by its own C-test
(`capturedBy: ["tests"]`, failing test name = the C-test), so the closure is not
borrowed from an unrelated detector.

Two real weaknesses remain, and both are about *when* the measurement was taken
rather than what it says: pass 2 and pass 3 ran against a **1,513-test** base
(and `MUTATION_TESTING.md` §6 still describes a "round-26 `main`", 63 files /
1,521 tests), while this head has 1,686 tests in 76 files. The pins are still
load-bearing *a fortiori* (a bigger suite can only add detections), but the
arithmetic in §6 now describes a tree that no longer exists — the classic way a
mutation table rots into a claim about the past.

**The model-checking bounds are stated precisely — except in the artifact
itself.** The paper says "rosters $n \le 4$, reduced clock universes", §11.2 says
"$n \le 3$–$4$", the proofs say "$n \le 4$", EVALUATION says "$n \le 4$ (vote
n=4 …)"; all are true of the 15 committed instances (vote up to 4, confirmation
and signing at 3). The Quint README's "exhaustive symbolic model checking of the
full state space to depth 10" is the one imprecise phrase in the package:
Apalache to depth 10 is *bounded*, and its own log says "you may increase
--max-steps". The important inversion is the one the paper makes itself: the
explorer's `propertiesChecked` array (the artifact) lists **P1–P5 plus
typed-error discipline**, while §11.2 advertises **P6/P7** as well. P6/P7 *are*
asserted in `__tests__/modelCheckingCore.ts` (the witness loop fails the instance
on acceptance; the log bound is a P2 check), so the mismatch is a declaration
gap, not a coverage gap — but an artifact that under-declares what it checked is
exactly the kind of "stale evidence" §11.6 claims to catch, one level down.

**Prioritized edit list (adversarial methods):**
1. *(applied, E9–E13)* Kill the stale model-check triples so no document cites a
   number the committed fixture cannot produce.
2. *(applied, E15)* Claim the mechanized artifacts explicitly, with their scope
   (Lean 4 abstracts the signature scheme; Quint is a second model, not a proof).
3. *(remaining, P3)* Add **P6/P7** to `PROPERTIES_CHECKED` and regenerate the
   fixture in the same commit — this changes the fixture's non-timing bytes, so
   it must be a sweep regeneration (~42 min), never a hand edit.
4. *(remaining, P2)* Re-run the closure subset at `v0.13.1` and refresh
   `MUTATION_TESTING.md` §6 (base commit, suite size, artifact timestamps).
5. *(remaining)* Reword the Quint README: "bounded symbolic check to depth 10
   (Apalache bmc)", not "exhaustive … to depth 10".
6. *(remaining, P5)* Flip `requireRoundBond` to `true` by default (or make it a
   mandatory create parameter) at v0.14 — r33-4 is the only residual in the
   register whose *default configuration* is the exploitable one.

---

## Edits applied in this PR

| # | File | Change | Persona |
|---|---|---|---|
| E1 | `docs/REPRODUCIBILITY.md` | scope the one-command claim; add the outside-the-contract artifact table (campaign, mutation, economics, multi-process, soak, Quint, Lean 4) with each command and why it is out | Repro |
| E2 | `docs/CROSS_CHECK.md` | header: v0.10.2 → v0.13.0, dated and head-stamped | Chair/Repro |
| E3 | `docs/CROSS_CHECK.md` §2 | total row corrected to the row-sum and to the tool's output: 285 / 271 / 95.1 % / 14 open (was 276 / 262 / 94.9 %) | Repro |
| E4 | paper, reference [20] | CVE-2025-58359 described accurately (parameter not validated; threshold *not* lowered; share security reduced) — verified against NVD/GHSA | Chair |
| E5 | paper §11.1 | suite 1,677/75 → **1,686/76** at this head | Repro |
| E6 | paper App. A.4 | same count, with the head named | Repro |
| E7 | `docs/CROSS_CHECK.md` §1 + `docs/REPRODUCIBILITY.md` stage c + `docs/EVALUATION.md` | 1,686/76 recorded as the current head, 1,677 kept as the R4 record, composition of the +9 stated | Repro |
| E8 | `docs/THREAT_MODEL.md`, `docs/REVIEW_SIMULATION.md` | version headers v0.10.2 → v0.13.0 (title / front matter) | Chair |
| E9 | `docs/proofs/README.md` (T4 row) | current fixture numbers replace the pre-witness triple | Repro/Methods |
| E10 | `docs/proofs/04-machine-safety.tex.md` | label the 13-instance triple as the pre-witness sweep | Methods |
| E11 | `docs/proofs/security/02-limitations.tex.md` | witness-aware sweep numbers | Methods |
| E12 | `docs/REVIEW_SIMULATION.md` (evidence-check) | 15 instances now, 13 pre-witness | Repro |
| E13 | `proofs/mechanized/README.md` | the TS checker's counts as they are now | Repro |
| E14 | paper App. A.2 | two new rows: Lean 4 single finality and the Quint re-model, both marked outside the reproduce contract with their toolchain | Chair/Repro/Methods |

No code, no fixture, and no test was modified; the fixture is byte-untouched, so
stage (f) of the contract still compares clean.

## Remaining actions (prioritized, not applied here)

| # | Action | Why it is not a doc edit | Owner |
|---|---|---|---|
| P1 | Cut `v0.13.1` at the merge head; append one tag-table row from a real full-contract run | a tag + a 17-minute measured run; also requires deciding that the two R33 `EXPLOITABLE` fixes ship as a patch release | maintainer |
| P2 | Re-run the mutation closure subset at that tag; refresh `MUTATION_TESTING.md` §6 | 35–40 min of sweep, and the numbers must come from the run | maintainer |
| P3 | Add P6/P7 to `PROPERTIES_CHECKED`; regenerate the fixture in the same commit | changes the fixture's non-timing bytes → needs a ~42 min sweep, never a hand edit | maintainer |
| P4 | Add `--with-campaign` / `--with-mutation` optional contract stages (or keep out, as now documented) | contract-script change with its own test | maintainer |
| P5 | `requireRoundBond` default → `true`, or mandatory create param (r33-4) | protocol-semantics change for hosts; needs the v0.14 API slot | maintainer |
| P6 | Independent human cryptographer / third-party audit | outside the repository's power to supply; §12.5 stays open | external |
| P7 | Reconcile the two dirty shared working trees (216 staged paths in `bao-court`; staged deletions in `bao.markets`) | not this branch's content; would sweep other sessions' work | operator |

---

## Final table — artifact → status → the one remaining gap

| Artifact | Status | The one remaining gap |
|---|---|---|
| `docs/FROST_COURT_ORACLE_PAPER.md` | **READY-WITH-EDITS** (edits applied) | The `v0.13.0` tag predates four commits, two of which fix `EXPLOITABLE` findings — "at the tag" is not the reviewed head until `v0.13.1` exists (P1) |
| `docs/CROSS_CHECK.md` (285 claims / 516 refs) | **READY** | 14 gaps stay open by design; the one with live exposure is the unbounded v1 validation path (PO-10) |
| Model-check sweep + committed fixture | **READY** | The fixture's `propertiesChecked` declares P1–P5 but the paper advertises P6/P7 — asserted in code, not declared in the artifact (P3) |
| Statistical corpora (9 campaigns, 1.187 M units) | **READY** | Not a contract stage; the paper calls the 3,745,566 counts "assertions", the artifact calls them `checks` |
| Mutation campaign (pass 1–3 + 9 pins) | **READY-WITH-EDITS** | Pass 2/3 were measured on a 1,513-test tree; the 52/52 post-closure score has not been re-measured at this head (P2) |
| `docs/proofs/**` (T1–T6, 6 lemma gaps) | **READY** | GAP-5a (pinned-library fidelity) is load-bearing for the attestation claim and cannot be closed in-repo |
| `proofs/lean4` (single finality) | **READY** | No contract stage and no toolchain in it; the signature scheme is abstracted (`Signed` uninterpreted) |
| `proofs/mechanized` (Quint re-model) | **READY** | "Exhaustive … to depth 10" is a bounded Apalache check — wording fix pending; no contract stage |
| Multi-process ceremony (N = 3…7 OS processes) | **READY** | One kernel, one clock, honest relay: the distribution gap stays PO-14 |
| Three-day soak (30,000 settlements, 32/32) | **READY** (artifact committed in the host repo @ `65b7cef05`) | Cross-repo: cannot be regenerated from this repository or its tag |
| Reproduce contract (`scripts/reproduce.sh`) | **READY-WITH-EDITS** | The tag-to-tag table has one row (post-v0.10.2); no `v0.12.x`/`v0.13.0` row exists yet (P1) |
| Escalation / confirmation machines (r33 surface) | **READY** | Shipped default is still the legacy membership semantics (`requireRoundBond: false`) — documented and pinned, exploitable by omission (P5) |
| Settlement rails (§9, A6/PO-15) | **READY (as specified, not as enforced)** | v1 release is host-mediated: specified, gated, and not cryptographically bound |

**Overall:** the package is **submittable tomorrow** with these edits, and
**independently auditable** only after P1/P2/P3 land. The strongest part of the
submission is not the protocol — it is that the paper states, in six separate
places, the exact conditions under which it is wrong, and then hands the reader
the commands to check.
