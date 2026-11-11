# Review Round 2 — does the response actually answer the reviewers?

**Date:** 2026-11-11 · **Base:** `origin/main` @ 6d6165e (v0.11.0 + #89) · **Scope:**
the eight demand classes of the three external reviews (GPT / Claude / Gemini,
2026-11-10, paper-text-only) as triaged in the host's review note
(`bao.markets` `memory/2026-11-10.md` §156), each audited against the *shipped
tree* rather than the release notes.

**Method.** Three reviewer personas again — A (formal-methods skeptic),
B (applied cryptographer), C (systems/economics). Each claimed fix was read in
place, its tests executed, its numbers reproduced, and its cross-repo half
checked in `baocommunity/bao.markets` where the fix does not live here. The
question asked of every item is the reviewer's own: **did the fix answer the
objection, or move it?**

**What was executed for this audit**

| Check | Result |
|---|---|
| `npm test` | **1,534 passed / 1 skipped (64 files)** — matches the release claim. Note: an *earlier identical run on the same docs-only tree* returned **12 failed / 1,522 passed across 9 files**, and the immediate re-run was green with no code change — see N4, which this observation instantiates |
| `node scripts/cross-check.mjs` | **276 claims, 502 evidence refs verified, 18 gap rows, exit 0** |
| `node scripts/review-quant/economics.mjs` | reproduces every table in the economics gap-fills (capture, γ-invariant, P+ε, grinding, √k) |
| Lean 4 re-run | **not performed** — no `lean`/`elan` in this audit sandbox; the committed `proofs/lean4/lean-run.log` + `run.sh` were read, not re-executed |
| Mutation / scale re-run | not re-executed (35–40 min and 9–19 min respectively); the committed pass-2/pass-3 artifacts and the campaign JSON were read and reconciled against the docs |

**Verdict summary.** 5 SATISFIED · 3 PARTIALLY · 0 NOT — of which one PARTIAL
(attribution) is closed by a doc edit in this PR, leaving **2 PARTIAL**.
Nothing regressed a headline claim: every objection was either answered,
answered-at-a-trust-boundary-and-labelled, or is now a *named* open obligation.
The two remaining PARTIALs are structural, not editorial: the escalation
authority is enforced by the host API but not by the protocol machine, and the
economic-ratio market cap cannot bind on the shipped ladder configuration.

| # | Objection | Verdict | Where the answer is | Residual |
|---|---|---|---|---|
| (a) | The paper's "Path B / no single party can release" did not describe the shipped rail | **SATISFIED** | `docs/SETTLEMENT-BINDING.md`; paper §1.2/§3.2/§9.2/§10.1/§12.6; A6 + INV-SETTLE-1 + F-13; PO-15 | Spend-session binding + signer policy unshipped; v1 release stays host-mediated |
| (b) | The five quantitative economics gaps | **SATISFIED** | `docs/proofs/economics/05-review-gapfills.tex.md`; `scripts/review-quant/economics.mjs`; paper §4.1/§4.2/§10.2 | GAP-5a…5f (the doc's own ledger); ρ unobservable; `L_stream` a deployment datum |
| (c) | Parameter hardening: quorum default + economic-ratio market cap | **PARTIALLY** | `confirmationMachineCore.ts:51`; `courtConfirmationMachine.ts:239,252`; host `courtEconomicRatio.ts` (#2397) | Cap is **advisory-by-default** and **fails at the shipped round-2 rung**; γ drift 0.5 (doc) vs 0.45 (code) |
| (d) | Mechanism fixes: escalation-right, abort penalty, decaying commitment, verifier's-dilemma audits | **PARTIALLY** | host `bao.markets` #2389 (`CourtEscalationService`, `courtLadderParticipation`, decay, `spotAuditScheduler`) | **No machine-level authority witness** on `escalate`/`concede`; none of it appears in this repo's paper or docs |
| (e) | Attribution: a FROST signature names no one | **PARTIALLY → SATISFIED by edit** | `attribution.ts`; `docs/proofs/attribution.tex.md` (Thm 6); `docs/ATTRIBUTABLE_SIGNING.md`; INV-ATTRIB-1…3; PO-18 | The paper did not cite any of it (T6/S-row/§13) — edit E1–E6 closes this |
| (f) | Lean 4 mechanisation of single finality | **SATISFIED** | `proofs/lean4/` (Lean 4.14.0, `oracle_single_finality`, no `sorry`, axiom audit clean) | Crypto abstracted (`Signed` uninterpreted); threshold-intersection arithmetic unmechanised |
| (g) | Paper hygiene: related work, corrections, disclosure, scope | **SATISFIED** | paper §1.5 (six-row table), §11.5 (disclosure), §13 (five claim classes), App. A (provenance) | Two overclaims survived in Abstract/Conclusion — edits E8/E9 |
| (h) | Mutation + scale campaigns | **SATISFIED** | `docs/MUTATION_TESTING.md` (53 mutants, 7+1 holes, 52/52 post-closure); `docs/benchmarks/SCALE_CAMPAIGN.md` (1.17M units) | 5 s wall-clock gate still in the suite (N4); PR #86 body contradicts the artifact (N7) |

---

## (a) Settlement binding — SATISFIED, with the objection's sharpest form conceded

The reviewers' claim was that the paper described a rail that does not exist:
the judge leaf `<winner> CHECKSIGVERIFY <oracle> CHECKSIG` verifies a
**transaction** signature, while the court produces a signature over a **Nostr
attestation**, and "no single party — including the platform — can release" was
therefore false.

**Did the fix remove the host from the release path?** No — and the document
says so in its own voice. The attested-spend design adds a *second signing
session* over the taproot sighash; the host still builds the plan, requests the
signature and validates the attestation. `docs/SETTLEMENT-BINDING.md` §1.2.5
states it ("the host builds the release plan, asks for that signature, and
validates the attestation itself"), §2.1's first failure mode names the
authority confusion explicitly ("a signer service that signs any structured
request from its host (v1 reality) makes the cohort a rubber stamp"), and §2.3
labels the v1 lane as a named trust point. The paper now carries the same
sentence in three places (§1.2's table, §9.2, §12.6: *"the court decides the
verdict, the host releases"*), and §10.1's host-as-adversary table scores
"release with no verdict at all" as **not** cryptographically prevented.

That is the correct answer to *this* objection: the reviewers attacked an
overclaim, and the overclaim is gone. What the fix does **not** do is make
settlement threshold-enforced; §2.2 specifies the CHECKSIGFROMSTACK variant
with four explicit gates and ships none of them, and §4.2 lists the signing
ceremony work (spend-session hash extension, signer policy, request shape) as
"next".

Evidence: `liquidEscrow.ts:264–311` (`buildCourtJudgeLeaf`/`isCourtJudgeLeaf`,
x-only only, winner≠group refused), byte-identity to the legacy builder pinned
at `__tests__/liquidEscrow.test.ts:165`; `FORMAL_INVARIANTS.md:188` (A6),
`:1227` (INV-SETTLE-1), `:1395` (traceability row, resolves), `:1491` (F-13);
`THREAT_MODEL.md:539` (PO-15); `docs/SETTLEMENT-BINDING.md` §3 (the
cohort-lifetime rule `resolveBy + slack ≤ cohort.endsAtSec`, which the reviewers
did not ask for and which is the most useful part of the fix).

**Residual.** The signer is still the enforcement surface. Until §4.2 items 1–4
land, "the host cannot release without a verdict" remains a *procedural* claim
with a post-hoc detective control, which the doc states rather than implies.

## (b) Economic gap-fills — SATISFIED, and one reviewer figure is correctly overturned

All five items are answered with derivations that reproduce from
`node scripts/review-quant/economics.mjs` (exact BigInt rationals, no deps):

- Capture table, exact binomial at `t = ⌈2N/3⌉` — the reviewers' two figures
  confirmed to their stated precision (0.850427 % at N=15, 5.0011·10⁻⁶ at N=45),
  then extended to the *shipped* ladder rungs (5/15/45/135/405) and to round 0,
  where the answer is much worse than the reviewers assumed (3-of-5 ⇒ 0.2099 at
  ρ=⅓, 0.4813 at ρ=0.49).
- Per-rail `V_max` with the Lightning rail's α=0 handled honestly: the
  invariant is *unsatisfiable* there, so the reduction must be a value cap —
  a stronger answer than "state a per-rail number".
- P+ε **corrected**: the expected briber cost is `max(0, 1−2π)·X`, i.e. free at
  π≥½ and *full price* at π=0. The reviewer's "costs ε" is the π→1 limit. The
  correction is derivable in one line from the shipped coherence-contingent
  payoff, and the paper adopts it.
- Seed grinding: `V > R_blk/Pr[X=t−1]`, cheapest shipped case ≈223 BTC ⇒ ≥220×
  above any BAO market, with the fix stated as an *ordering* (derived seed
  height from the freeze height) and the tip-block residual named.
- √stake splitting: √k proved, the 1 % gate gives `k_max`, and saturation is
  **linear** in stake — so the paper's own anti-plutocracy sentence was
  corrected downward (§4.2). A reviewer cannot ask for more than being proved
  wrong about one's own claim.

Residuals are the doc's own (GAP-5a…5f): binomial-vs-hypergeometric, ρ not
observable, `L_stream` a measurement, P+ε credibility unescrowed, `D` not
implementable, split cost unmeasured. These are the right residuals; none is
silent.

## (c) Parameter hardening — PARTIALLY

**Quorum: the code half is done and the conflict is now declared, not hidden.**
`confirmQuorum` defaults to `confirmSupermajority(N) = ⌈2N/3⌉`
(`confirmationMachineCore.ts:51`, `courtConfirmationMachine.ts:239`), the
one-juror row is unreachable by omission, and an explicit sub-supermajority
quorum is accepted but written to state as
`quorumBelowSupermajority: true` (`:252`, INV-CONF-4). Tests pin 3/5/7-seat
defaults, 3-of-5 flagged, 9-of-15 flagged / 10-of-15 clean, and the behavioural
consequence (3 of 5 confirmations cannot close, the 4th does).

*Does the capture table's ⌈2N/3⌉ recommendation conflict with the shipped
3-of-5 acceptance?* **It still describes two different configurations, but the
difference is now machine-visible rather than implicit.** The default is 4-of-5;
the spec's rollout is 3-of-5; a host that follows the spec passes the parameter
explicitly and the state says the case is at 0.2099/0.4813 instead of
0.0453/0.1752. That is the honest resolution for a host parameter — but note
what it is *not*: a binding rule. A host can ship the weak configuration and the
mechanism will proceed.

**Market cap: the rule does not bind on the shipped panel configs.**
`bao-court` (this repo) contains no implementation at all — only the derivation
(§2.5–2.6 of the gap-fills). The implementation is host-side
(`bao.markets` #2397, `courtEconomicRatio.ts`) and it is **advisory by
default**: `BAO_COURT_ECON_RATIO` off logs the ratio and creates the market; on,
an over-cap market is refused 422 `ECON_RATIO_BELOW_MINIMUM`. When on, the
shipped configuration still fails its own invariant: at `maxLadderRounds = 2`
the deepest rung is 45 seats, and `γΣS/V = γσN` is **0.405** at the shipped
γ = 0.45 (0.45 at the doc's γ = 0.5) — round 3 (135 seats, 1.215) is the first
rung that holds. So the choice is: log-and-proceed, or refuse exactly the
markets the rule was meant to protect unless the ladder cap rises to 3.

*New drift found here:* the court doc pins `γ = α·p_flip = 0.5` and its guardian
arithmetic says "2,000,000 sats bonded for a 1,000,000-sat dispute"; the shipped
gate uses **γ = 0.45** (2.22M). Both are internally consistent; the doc never
mentions 0.45. Edit E7 records it (N1).

## (d) Mechanism fixes — PARTIALLY, and the sharpest unresolved item in the whole round

The four mechanism findings shipped — in the **host repository**, not here:

| Finding | Shipped where | Shape |
|---|---|---|
| Escalation is the platform's power (Claude #7) | `bao.markets` #2389 | `CourtEscalationService` + NIP-98 `POST /v1/court/cases/:id/escalate` + migration 232 + `BAO_COURT_HOST_ESCALATION` **default false**; ESC-RIGHT-1…5 in the host spec |
| Round-2 abort is free (Gemini C) | #2389 | `courtLadderParticipation.ts` ⇒ `non_participation` clawback flags + ×0.8 reputation unit per aborted round |
| Idle-reset cliff (Gemini) | #2389 | `w_eff = w₀ + (w−w₀)e^(−λ·idle)`, half-life 3 epochs; `idleExpiryEpochs` reporting-only |
| Verifier's dilemma / blind confirming (Claude #6) | #2389 | spot-audit rate as a signal function of panel agreement speed (≤4× baseline, ceiling 50%, seeded); canary proposals **spec-only** |

**Did the escalation fix remove host power, or gate it behind a flag that
defaults off?** The default is the *strong* setting, not a neutral one: with
`BAO_COURT_HOST_ESCALATION` false the host **may not** escalate or concede while
the challenger window is open, and operator discretion is break-glass only
(marked `authority: "host"`). So the deployed API no longer gives the platform
the appeal power — that part of the objection is genuinely answered.

**What is not answered is the design objection at the protocol layer.** The
confirmation machine still accepts a bare host-dispatched `escalate`/`concede`
with no authority witness: `courtConfirmationMachine.ts:365` dispatches
`onEscalate` on `event.type` alone, and the state carries no proposer,
challenger or request hash for the transition. A host that bypasses its own API
(the event is just a reducer input) has the old power. The host note is explicit
that this half is *not* shipped: "Machine-side `authority` + `requestHash`
witness on `escalate`/`concede` — queued upstream (bao-court) — exact wire shape
in SPEC §9.2" (`REVIEW_RESPONSE_R23.md`, status column **SPEC**). Nothing in
this repo mentions ESC-RIGHT, LADDER-ABORT, the decay law, or the audit-rate
function (grep: zero hits), and paper §6.2 still reads "escalation is
host-driven and explicit … the host plays `escalate` … or `concede`".

So: **mechanism shipped, design half-open.** A paper-only reviewer of this
repository sees the objection unanswered; edit E10 at least stops the paper from
describing the deployment as if the host still held the right.

## (e) Attribution — PARTIALLY, and this one was an editorial omission, not a technical gap

The substance is real and strong: `attribution.ts` (362 lines) with
`buildSigningJournal` / `verifyAggregateAttribution` / `hashSigningJournal`,
eight fail-closed per-index codes, `docs/proofs/attribution.tex.md` (Lemma 6.0
proves the bare aggregate is *unlinkable* — the honest starting point — and the
journal is what makes attribution possible), INV-ATTRIB-1…3 with traceability
rows, PO-18, and the D-BATCH signer duty answering "one signature certifies
10,000 verdicts".

**But the paper does not cite any of it.** `docs/FROST_COURT_ORACLE_PAPER.md`
has no "Theorem 6", no T6 row in App. A.2 (the list still ends at T5), no S-row
for `docs/ATTRIBUTABLE_SIGNING.md`, and §13's cryptographic-security rows say
nothing about signer attribution. §11.5 and §14 still say "five line-checked
theorems". The reviewer's finding — *the artifact every verifier sees names no
one* — is invisible in the paper that is supposed to answer it.

This is a pure provenance omission, so it is fixed by edit rather than left as a
residual: E1 (S-16), E2 (T6), E4/E6 (count), E5 (§13 row), E3 (PO range).

Residual after the edit: attribution is **detective**, requires the
certified-share pin (P1) and authenticated append-only entries (P2), and the
journal is host-side in v0.11 — PO-18 says all three.

## (f) Lean 4 single finality — SATISFIED (read, not re-run)

The artifact is exactly what the reviewers asked for and the statement has
content: `oracle_single_finality` quantifies over two *distinct* messages
finalized in the same epoch, with `State.Finalized` defined as batch
soundness + completeness, so the proof runs through per-case uniqueness and
`funext` rather than a definitional rewrite. Supporting lemmas are the useful
ones (`finalize_barrier`, `terminal_untouched`, `final_stable` over unbounded
histories, `finalized_outcome_unique`, `binding_epoch_ne`), and
`machine_alone_insufficient` is the most valuable artifact of the round: it
*proves* two reachable states can finalize different outcomes for the same case,
i.e. per-state determinism is not cross-run agreement — the honest boundary of
what a state machine can establish.

`lean-run.log` shows a clean build, no `sorry`, and an axiom audit of
`propext` / `Quot.sound` only. **Limits, as stated:** crypto is abstracted
(`Signed` uninterpreted) and the threshold-intersection arithmetic is a named
hypothesis, not mechanised. Not re-run in this sandbox (no toolchain); that is
a verification gap of *this audit*, not of the artifact.

## (g) Paper hygiene — SATISFIED

- **Related work (§1.5)** is a real comparison, not a citation dump: six rows
  (DLC, UMA, Augur, Chainlink OCR, ROAST, Kleros) with a column that names what
  each neighbour does *better* — DLC's script-enforced verdict, UMA's
  no-ceremony path, Augur's fork backstop, ROAST's proven liveness, Kleros's
  live appeals market. FROST is now cited as SAC 2020 (Komlo–Goldberg), and the
  LDVR / CVE-2025-58359 references were added. This is the strongest single
  page in the paper.
- **Assurance framing (§13)** replaces rank language with five claim classes,
  four status labels, and a table in which **every row carries an open
  obligation**. The preamble's two readings (proven-about-the-spec ≠
  proven-about-the-code; every row has a perimeter) are exactly what a
  formal-methods reviewer asks for.
- **Disclosure (§11.5)** is exemplary: it names the AI reviewers, states
  paper-only scope with no code/execution/cryptographic analysis, and states
  what none of it is (no human cryptographer, no third-party audit, no peer
  review). It also disclaims the in-house reviewers' conflict of interest.
- **Statement corrections** landed where they matter: "structurally invalid" →
  publicly detectable; "independent reimplementations" → in-house differential;
  Lightning preimage has no secret input (PO-16); commit–reveal stops copying,
  not buying; the P2WSH `M`,`N` privacy disclosure reconciled.

Two overclaims survived (N6, edits E8/E9): the Abstract and Conclusion still say
exhaustive model checking covers "the ceremony machines" while §6.4 defines
*four* and §11.2/§13 scope *three*; and the Conclusion's "every settlement rests
on panel evidence rather than the platform's word" contradicts §10.1's own table,
where release-with-no-verdict is the row marked **no**.

## (h) Mutation + scale — SATISFIED, with two caveats the docs already half-own

**Mutation.** 53 mutants / 18 classes, three independent detectors, sandboxed
with a green baseline and an exactly-once guard. Result as found: 46 flagged,
44 real captures, 7 outright survivors plus M47 hidden behind a wall-clock-only
"capture". Closed with 9 pin groups / 14 tests; pass 2 re-applies all seven
survivors → 7/7 caught, 0 survived, clean tree PRISTINE; M40 adjudicated as an
**equivalent** mutant rather than counted as a hole. `git diff-tree` on the fix
commit (b1a1cd0) shows **no production source file changed** — the eight holes
were *specification blindness* (promises with no test that could fail), not
latent machine bugs. That distinction is the campaign's most important result
and the document states it.

Caveats: (i) the 5 s wall-clock assertion that produced two of the 46 pass-1
captures is **still in the suite** (`__tests__/simulateCourt.test.ts:56`) after
`MUTATION_TESTING.md` §7 concluded it "corrupts mutation results and CI alike" —
the doc prescribes the fix and the code keeps the defect (N4). This audit
reproduced the failure mode without trying: a full run of the **docs-only**
tree under host load returned 12 failures across 9 files, and the identical
re-run was green (1,534 passed) with no code change. (ii) detector B,
the exhaustive explorer, catches 31.3 % of machine mutants and missed 3 of the 7
survivors, so "exhaustive reachability" is explicitly *not* exhaustive property
coverage — honest, and it slightly weakens the implied reach of the
model-checking claim.

**Scale.** 1,171,000 corpus units / 3,592,861 assertions / 0 failures in one
9.2-minute invocation (artifact `campaign-2026-11-11.json`, `wallMs = 550,399`,
`declaredSizes == actualSizes` for all six campaigns). The campaign found one
bug — in itself (a forgery mutation that was a no-op ~1/16 of the time) — and
re-ran green, which is the right way to report an instrument defect. Merged PR
#86's body quotes a *different* run (3,496,808 checks, 1,124 s, three merged
invocations); the tree is self-consistent, the PR text is not (N7).

---

## New issues found by this audit

| # | Issue | Severity | Status |
|---|---|---|---|
| **N1** | γ drift: the gap-fills pin `γ = α·p_flip = 0.5` and quote 2.0M sats bonded per 1M-sat dispute; the shipped gate uses **γ = 0.45** (2.22M). Neither document mentions the other. | MINOR | **fixed by edit E7** |
| **N2** | The economic-ratio cap is **advisory by default** (`BAO_COURT_ECON_RATIO` off): a rule that logs is not a rule. With the flag on, the shipped `maxLadderRounds = 2` config fails its own invariant (0.405 < 1) and refuses the high-value disputes it exists to price. | MAJOR | round-3 decision (raise the cap to 3, or gate value at creation, or accept refusal) |
| **N3** | Escalation authority has **no machine-level witness**: `escalate`/`concede` still dispatch on `event.type` with no proposer/challenger/request-hash binding, so a host bypassing its own API recovers the old power. The host note lists this half as "queued upstream (bao-court)". | MAJOR | round 3 (protocol carve: `authority` + `requestHash` on both events) |
| **N4** | The 5 s wall-clock assertion remains in `__tests__/simulateCourt.test.ts:56` after the mutation round concluded it corrupts both mutation verdicts and CI (two false captures, two red runs in #85). Self-inconsistent: documented remedy, unapplied. | MAJOR (CI integrity) | round 3 (relative budget or test-only measurement) |
| **N5** | Provenance drift after the new work: App. A.1 says "PO-1…PO-17" (PO-18 exists); App. A.2 omits T6; "five line-checked theorems" in §11.5/§13/§14; no S-row for `ATTRIBUTABLE_SIGNING.md`; `docs/presentation/OUTLINE.md:169` still says "all 14 open gaps" (the A-11 arithmetic fix landed in EVALUATION only). | MINOR | **fixed by edits E1–E6, E11** |
| **N6** | Two surviving overclaims: Abstract/Conclusion "exhaustive model checking of the ceremony machines" (four defined, three checked); Conclusion "every settlement rests on panel evidence" vs §10.1's release-with-no-verdict row. | MINOR | **fixed by edits E8/E9** |
| **N7** | Merged PR #86's body (3,496,808 checks / 1,124 s / three invocations) contradicts the committed artifact and `SCALE_CAMPAIGN.md` (3,592,861 / 550 s / one invocation). Tree consistent; the merged PR text is not. | MINOR | round 3 (a correcting note in the campaign doc; the PR body is immutable history) |
| **N8** | Paper §6.2 describes escalation as host-driven with no mention of the merged ESC-RIGHT host rule, so the paper simultaneously *understates* the deployment and leaves the reviewer's finding visible in the text. | MINOR | **fixed by edit E10** |

No new issue was found in the judged-green paths: the quorum default change does
not break the machines (`MAX_CLAWBACK_FLAGS = 10_000` comfortably absorbs the
host's new `non_participation` flags, and the reducer accepts host-reason strings
by design — F-4/PO-9); the judge-leaf builder adds no consensus surface
(byte-identical, pinned); and the attribution module changes no signature or
validator path.

---

## What none of the eight fixes addressed (round 3's honest list)

1. **The distributed run.** Every ceremony in this repository is single-process.
   PO-14 is the gate and it has not moved: no cross-host DKG/signing, no
   independent juror devices, no relay partition during a signature. The Lean
   proof abstracts signatures; the model checker explores reducers; the campaigns
   replay one process. A reviewer should treat "threshold oracle" as
   *threshold-attested in one process* until PO-14 closes.
2. **External replication.** No third party has reproduced a number. The
   differential suite is in-house (the paper now says so); the FROST
   cross-implementation differential is still the missing half of §12.5; the
   benchmarks are one shared box with a documented load-20 exclusion; the scale
   campaign ran on one host in one invocation. "Reproducible here" is not
   "replicated there".
3. **Related-work completeness.** §1.5 is good on *systems* neighbours and thin
   on *threshold-cryptography* neighbours: no Boldyreva/Gennaro et al. threshold
   Schnorr lineage, no Drijvers-style two-round-attack citation in the related
   work (it is in the audit, not the paper), no Shoup/Stinson DKG-analysis line
   beyond Pedersen, and no formal "optimistic oracle vs threshold oracle"
   comparison beyond the UMA row. Also absent: any prior *jury-for-oracle*
   system (Kleros is the only one cited).
4. **Benchmark depth.** No per-rail end-to-end (lock → settle → cancel through a
   real LN/Liquid node), no multi-batch memory profile (§9's 25.6 GB inbox
   worst case is arithmetic, not measurement), no real-Postgres soak (RS-8), and
   no p99 under concurrent load — the load-20 run was excluded rather than
   characterised.
5. **The two structural PARTIALs** above: the escalation authority witness (N3)
   and a market cap that binds (N2).
6. **The verifier's-dilemma half.** The audit-rate function is a heuristic
   (faster agreement ⇒ more audits) with a spec-only canary. Nothing shows the
   audit sample is adversary-proof: a cartel that agrees *slowly* buys its rate
   back down. That is a design question for round 3, not a documentation gap.

---

## Edits made in this PR

All are documentation-only; each is ≤ 20 lines. Nothing under
`packages/lib/frost-court`-equivalent vendored paths was touched (this repo has
none), and no production code changed.

| # | File | Edit | Closes |
|---|---|---|---|
| **E1** | `docs/FROST_COURT_ORACLE_PAPER.md` App. A.1 | new **S-16** row → `docs/ATTRIBUTABLE_SIGNING.md` | N5/(e) |
| **E2** | same, App. A.2 | new **T6** row → `docs/proofs/attribution.tex.md` (Theorem 6, conditional on P1/P2) | N5/(e) |
| **E3** | same, App. A.1 | S-6 obligation range `PO-1…PO-17` → `PO-1…PO-18` | N5 |
| **E4** | same, §13 preamble | "line-checked for T1–T5" → "T1–T6" | N5 |
| **E5** | same, §13 attestation row | adds the attribution result + its detective boundary (T6, PO-18) | (e) |
| **E6** | same, §11.5 + §14 | "five line-checked theorems" → "six (T1–T5 core, T6 attribution)" | N5 |
| **E7** | `docs/proofs/economics/05-review-gapfills.tex.md` §2.5 | records the shipped gate's γ = 0.45 (vs the doc's 0.5) and its advisory-by-default status | N1 |
| **E8** | paper Abstract | "five core properties … exhaustive model checking of the ceremony machines" → "six core properties … three of the four ceremony machines (the DKG machine is invariant-pinned only)" | N6 |
| **E9** | paper §14 | same model-checking scoping, "five" → "six" theorems, and "every settlement rests on panel evidence" qualified with host-mediated release (PO-15) | N6 |
| **E10** | paper §6.2 | "host-driven" → "explicit, and the caller is whoever the deployment authorises", plus the ESC-RIGHT-1…5 reality, break-glass default-off, and the missing machine-level authority witness | N8/(d) |
| **E11** | `docs/presentation/OUTLINE.md` | stale "272 claims / 259 (95.2 %) / all 14 open gaps" → machine truth (276 claims, 502 refs, 13 open gaps) | N5 |
| **E12** | `README.md` doc map + `CHANGELOG.md` | registers this audit in the documentation map and the change log | — |

**Verification after the edits:** `npm test` (unchanged, docs-only),
`node scripts/cross-check.mjs` exit 0, and `cmp`-level consistency of the new
S/T rows against the files they name.
