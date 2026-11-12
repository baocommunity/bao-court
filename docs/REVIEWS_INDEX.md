# BAO Court — Reviews Index

**The single map of the self-verification campaign.** Every review, simulation,
audit and campaign round this repository has run — in order, with what it
attacked, what it found (by severity), where the fix landed, and how the
residual was dispositioned. **Tracks `@bao/court` v0.15.3 · 2026-11-12.**

**Current totals at `v0.15.3`** (each with its artifact): suite **2,008 passed /
93 files** (1 env-gated live test skipped; v0.15.3 adds the 25-test
over-strictness suite); mutant catalogue
**101** across three campaigns (`docs/MUTATION_TESTING*.md`); scale campaign
**1,587,000 units / 8,286,823 assertions / 0 failures**
(`docs/benchmarks/SCALE_CAMPAIGN_V2.md`); model checking **3,869,232 states /
213,521,172 applications / 60,020,684 illegal-witness probes, 0 accepted**;
mechanised proofs **42 Lean 4 declarations** (`proofs/lean4/`, no `sorry`) +
Apalache exhaustive (`proofs/mechanized/`); independent wire differential
**100,000 cases, 0 disagreements** (`docs/DIFFERENTIAL_WIRE.md`); three-day soak
**32/32 assertions** (`docs/benchmarks/SOAK_3DAY.md`); cross-check **286 claims /
521 refs / 95.1 %**. Rounds 1–12 and the v0.11.0 → v0.15.3 release ladder are
mapped in the tables below; the narrative summary is
`docs/CAMPAIGN_REPORT.md`.

**How to use it.** This file is the index, not the record. A round's authoritative
statement is its own document (column *Record* below); this page exists so a
reader can (a) see the whole programme at once, (b) find the round that owns a
finding code, and (c) check a headline number against the artifact that produced
it. Nothing here overrides the source document: where the two disagree, the
source wins and this page is the bug.

**Network naming.** Where a round document says `demo`, read the **private
signet** — the chain BAO's hosts run (paper §11.8). It is one network, not a
play-money chain: code and configuration keep the identifier `demo`
(`/demo/*` routes, `COURT_ENVIRONMENTS`), and rail results from it are weaker
evidence than results from the public testnet4 / signet-public chains.

**The one rule every round is graded by.** A finding is `EXPLOITABLE` only when a
test in this repository (or a cited host code path) demonstrates the harm;
otherwise it is `PARTIAL` (the guard exists but is incomplete, or the documented
claim is stronger than the mechanism) or `BLOCKED` with the guard cited by file
and line. A fix is only evidence when its test **fails on the pre-fix head**.
Every residual carries a disposition — *fixed here*, *documented + pinned*, *host
fix with an owner and a trigger*, or *deferred to a named version* — never a bare
"registered". The cross-repository disposition register is `bao.markets`
`docs/operations/REGISTERED_FINDINGS_SWEEP.md` (112 rows at round 34), and it is
the single source of truth for anything not fixed in this tree.

---

## 1. The timeline

Four programmes, in the order they ran. The numbering is the campaign's own;
`R` numbers are the symposium/bug-hunt rounds, `r`-codes (r29-1, r33-5, r40-1…)
are findings inside the review rounds, and `F`/`N`/`RS`/`PO` are finding
namespaces (the paper's App. A.3 namespaces them deliberately — `F-2` in the
crypto audit is not `F-2` in the formal audit).

### 1a. Improvement rounds (R1–R4) — 2026-11-09

| # | Record | Attacked | Found | Fixed / landed | Disposition |
|---|---|---|---|---|---|
| **R1** | `FIXES-2026-08-15.md`, `FIXES-2026-08-18.md`; `bao.markets` `docs/proposals/COURT_SECURITY_AUDIT_2026-11-09.md` | validator + finality paths; ceremony machines under fuzz | **3** validator findings (1 **HIGH**: v2 scope pins declared but never enforced; 1 MED: dispatcher downgrade; 1 LOW); **5** machine-fuzz defects (lone-surrogate canonicalization collision, state-shape tampering, signing-binding re-derivation, freeze gaps, untyped unknown events) + 2 owner decisions | v0.8.2 (#36), v0.8.3 (#37) | fixed with regression tests; 2 reported-not-fixed as owner calls |
| **R2** | `bao.markets` `docs/proposals/COURT_SECURITY_AUDIT_2026-11-09.md`, `CROSS_CHECK.md` | chained/cross-module sequences; supply chain | **3** fixed (batch-Merkle-root pin absent; **restored ledgers not re-verified**; docstring trust boundaries) + 1 documented-by-design (verdictHash dedup duty) | v0.8.5 (#41) | batch-root pin + `assertValidConfirmationLedger` — the first state-restore barrier |
| **R3** | `__tests__/r3Findings.test.ts`; `bao.markets` `docs/proposals/COURT_SECURITY_AUDIT_2026-11-09.md` | property-based sweep, 570+ cases | **6** (r3-1…r3-6): restored-empty ledger finalized, raw `TypeError` escapes ×2, mid-ladder dead end, signer-set root typing | v0.9.0 (#43), v0.9.1 (#46) | fixed; roster ≥ 3 at creation is a design fix, not a patch |
| **R4** | `FORMAL_INVARIANTS.md`, `CROSS_CHECK.md` | the whole guard surface, formally | **12** (F-1…F-12); **3 substantive** fixed: F-12 monotonic clock ledgers, **F-2 present-but-empty pin silently disarmed the check**, F-3 outcome-history barrier | v0.9.2 (#47/#48) | the falsy-pin class becomes fail-closed; 158 `INV-*` invariants extracted from the actual guards |

### 1b. Symposium rounds (R5–R21) — 2026-11-09 → 2026-11-10

| # | Record | Attacked | Found | Fixed / landed | Disposition |
|---|---|---|---|---|---|
| **R5** | `FORMAL_INVARIANTS.md` | every guard, machine by machine | 158 invariants, each with an enforcement pointer; INV-VOTE-14 is the one with no executable pin (F-10) | #47 | traceability matrix is now machine-checked by `scripts/cross-check.mjs` |
| **R6** | — | no standalone artifact recorded in this tree | — | — | recorded only through the suite-count ledger in `CROSS_CHECK.md` §1 |
| **R7** | `CRYPTO_AUDIT.md` | cryptography *as used* against the FROST literature | **12 mechanisms**: 3 MED shipped (reveal-set == commitment-set guard; DKG PoK canonical challenge; dispute-key fixed-width), 4 spec'd (S-1…S-4), 5 verified-OK; `@vbyte/frost` pin verdict KEEP | v0.9.3 (#49) | S-1 (grinding/beacon) remains the load-bearing spec'd item |
| **R8** | `__tests__/reference/` | differential parity against independent reimplementations | encoding writer, Merkle tree, tally, selection, hashes — in-house differential (the paper says so); **1 real divergence class** (UTF-8 vs UTF-16 tie-break) | #52 | parity oracle is the standing cross-check for every later refactor |
| **R9** | `docs/benchmarks/BASELINE.md` | performance: per-reduce cost, proof sets, selection hot path | signing reduce **3,340 µs → 110 µs** (30×, point-validity memo); O(n) proof sets; the load-aware, ratio-based bench gate with the load-20 exclusion | v0.10.0 (#54) | every later release re-baselines through that gate; `REPRODUCIBILITY.md` makes it one command |
| **R10** | host round-10 suite (`bao.markets` #2293/#2294/#2295) | the *mechanism* layer: ack farming, redelivery griefing, cross-network epoch replay, dust starvation, weight gaming | composite SLA floor, 1+1 redelivery, ×0.8 non-participation, decay law — all host-side mechanisms | host repo | RS-9 (composite-SLA equilibrium) and the V-review C-2 finding come from here |
| **R11** | paper §1.5, §13 | does the paper describe the shipped code? | related-work table (6 neighbours, 3 axes), five claim classes, statement corrections | #55/#56 | the "every row carries an open obligation" framing starts here |
| **R12–R13** | — | no standalone artifact recorded in this tree | — | — | evidence only in the suite-count ledger |
| **R14** | `THREAT_MODEL.md`, `CROSS_CHECK.md` | the security argument, claim by claim | threat model with ADV-* adversaries + 18 proof obligations (PO-1…PO-18); the claim→evidence index that today holds **285 claims / 516 evidence refs** | #62/#63/#64 | the claim→evidence index becomes a CI gate |
| **R15** | `EVALUATION.md` | the evaluation chapter as a standalone artifact | parity, model checking, benchmarks, audit programme, scope caveats (§6) | #65 | the "145 first-order invariants" wording survives until R16 downgrades it |
| **R16** | `REVIEW_SIMULATION.md` | **adversarial external-review simulation**: 3 personas against paper + 4 verification artifacts + code | **31 rows / 30 distinct findings: 0 REJECT, 8 MAJOR, 7 MINOR, 14 QUESTION (attack failed, rebuttal recorded)**; 12 fixes shipped, RS-1…RS-10 registered | #70 | panel verdict: A accept-with-revisions, B accept-with-revisions, C accept |
| **R17** | `DRESS_REHEARSAL.md`, `docs/presentation/` | the submission artifact end to end; the demo | full-contract verification record, sign-off checklist, figures F1–F6, 30-minute outline | #69/#71/#72 | suite re-baselined; presentation claims checked against artifacts |
| **R18** | `docs/proofs/` | formal proof of the core properties | **T1–T5** line-checked (encoding, Merkle, tally, machine safety, attestation soundness) + **6 lemma gaps** (GAP-4a…GAP-6b), each naming its cost; **T6** attribution joins at v0.11.0 (#84) | #73 | T4 generalizes the finite model check to all n; the gaps are the honest perimeter |
| **R19** | `docs/proofs/economics/` | the incentive design, game-theoretically | model (00), farming (01), ladder (02), collusion (03), Goodhart (04) — and the five quantitative gaps the external reviews demanded (05) | #75 | PO-1 (bribe equilibrium) is the paper's "honest centre of gravity" |
| **R20** | `docs/proofs/security/` | security *definitions* and realization proofs | definitions, theorems, limitations for the attestation layer | #74 | the highest-theory round; the limitations file is the deliverable |
| **R21** | — | external-review intake / gap-fill round | suite recorded at 1,534; the three external reviews land 2026-11-10 and become §1c | — | evidence only in the suite-count ledger; the eight demand classes are triaged in §1c |

### 1c. External reviews — 2026-11-10 (GPT / Claude / Gemini, paper-text only)

| Record | Scope | Found | Response | Disposition |
|---|---|---|---|---|
| host `docs/proposals/REVIEW_RESPONSE_R23.md` (mechanism), `REVIEW_RESPONSE_R25.md` (parameters), `bao.markets` #2389/#2397/#2409 | the paper and the universal-jury-confirmation spec, **text only** — no code, no execution, no cryptographic analysis | 8 demand classes: (a) settlement binding, (b) five quantitative economics gaps, (c) quorum default + economic cap, (d) mechanism fixes (escalation right, abort penalty, idle decay, verifier's dilemma), (e) attribution, (f) Lean 4, (g) paper hygiene, (h) mutation + scale campaigns | PRs #78–#85, release **v0.11.0** (#88); Lean 4 (#83), attribution T6 (#84), quorum ⌈2N/3⌉ (#85), gap-fills (#79) | **5 SATISFIED / 3 PARTIALLY / 0 NOT** as audited in `REVIEW_ROUND_2.md`; the attribution PARTIAL closed by a paper edit, leaving 2 structural PARTIALs |

The reviews themselves disclosed their limits (§11.5 of the paper: AI reviewers,
paper-only, no human cryptographer, no third-party audit) and the in-house
reviewers' conflict of interest. That disclosure is why §1d exists.

### 1d. Review rounds 2–8 — 2026-11-11 (self-verification)

The fourth tier: round *n+1* attacks the artifacts round *n* shipped. The
attacker is a caller — it holds the reducer, the HTTP route, or the env var.

| # | Record | Attacked | Found | Fixed / landed | Disposition |
|---|---|---|---|---|---|
| **2** | `REVIEW_ROUND_2.md` | do the eight external-review fixes answer the objection, or move it? | **8 objections: 5 SATISFIED, 3 PARTIAL, 0 NOT**; **8 new issues** (N1–N8: 3 **MAJOR**, 5 MINOR) — γ drift 0.5 vs 0.45; economic cap advisory-by-default and failing at the shipped rung; no machine-level escalation authority witness; the 5 s wall-clock assertion still corrupting CI; provenance drift (PO range, T6, S-row) | #90 (audit + 12 doc edits) | 4 N-items fixed by edit (N1, N5, N6, N8); N2/N3/N4 → round 3; N7 noted as immutable PR history |
| **3** | `REVIEW_ROUND_3.md` | the surface the round-2 fixes **created**: the escalate witness, the derived cap, the deterministic budget, witness×finality | **1 EXPLOITABLE** (r29-1: the bond was bound to the *case*, not the challenger — a juror who posted no bond could escalate and the audit log named the wrong person); **1 EXPLOITABLE-at-host** (r29-7: cap measured on a client-declared number, LP deposits never re-assessed); **3 PARTIAL** (r29-2 log barrier, r29-10 vacuous budget ceiling, r29-8 TOCTOU); rest BLOCKED — 10 attack rows | v0.12.1 (#95/#97); model-check property corrected — it had **agreed with the bug** | 11 r29 rows swept: fixed in-round r29-1/r29-2/r29-9/r29-10, registered r29-3…r29-8 + r29-11 (60 s timeout); r29-7/8 closed upstream, r29-3 re-graded MAJOR economically |
| **4** | `REVIEW_ROUND_4.md` | the v0.13.0 surface from the inside: per-round bond, derived ladder bound, decay pairing, host churn cap | **2 EXPLOITABLE fixed** (r33-1: another juror's *membership* bond was a legal per-round payment; r33-5: an emptied log un-consumed a bond and opened a free rung — then bricked the case); **1 EXPLOITABLE-at-host** (r33-10: unmeasured cohort ⇒ no cap change on private signet/mainnet); **4 PARTIAL** (1 fixed *r33-9* `Infinity` from finite inputs, 1 barrier hardened, 2 registered) | v0.13.1 (#103/#106) | 10 registered residuals with fix shapes; **6 of 21 tests red on the unfixed base** |
| **5** | `REVIEW_ROUND_5.md` | the round-4 closures, attacked on the premise they rest on | **1 EXPLOITABLE fixed** (r38-1: the challenge pool had **no uniqueness** — one paid bond bought N challengers' standing, a two-step r29-1 bypass); **2 PARTIAL** (r38-2 `requireRoundBond` × `hostEscalation` prices nothing — documented + pinned + owner decision; r38-3 pubkey unverifiable — v0.14); **1 host** (r38-4: the host vendors the *pre-fix* `ladderEconomics.ts`, so wiring the r33-7 gate would wire the bug) | #107 | 8 residual rows, each with a disposition; 3 closures red on v0.13.1 |
| **6** | `REVIEW_ROUND_6.md` | the round-5 and round-37 fixes, at the entries that **spend a rung** | **2 EXPLOITABLE fixed** (r40-1: `escalate` re-derived the log but not the challenge pool it reads — and `open_ladder_round` ran no barrier at all; r40-2: a restored `ladder_pending` with its record deleted opened the rung); **1 PARTIAL in-package** (r40-3: the hash is unique but not **owned** — a derivable witness is preemptable); **2 PARTIAL host** (r40-4 composed predicate ≠ sign rule; r40-5 boot backfill bypasses the creation gate); docs drift fixed (r40-6) | #109, release **v0.13.2** (#110) | **490-state legal-state hunt: 0 refusals**; 6 closures red on #108 |
| **7** | `REVIEW_ROUND_7.md` | the v0.13.2 surface: the sign-rule predicate, the legacy depth clamp, the three stated non-readers, the strict round-bond default | **1 EXPLOITABLE fixed** (r41-1: `finalize` minted a verdict from a vote ledger it never re-derived — `concede` was the route in; `upheld` was caller-supplied and absent from the hash); **1 doc defect fixed** (r41-T1-doc: the `a_f` monotonicity sentence pointed the wrong way); **6 host findings** (H-1 ρ/β ≠ the enforced cap, H-2 ρ unmeasurable, H-3/H-4/H-5 the clamp's readers, metric and permanence, H-6 the escalate body cannot carry the witness) | #112; release **v0.14.0** (#114), which also shipped the H-6 transport | 4 closures red on `1b33b2f`; 40/40 legal flows finalize unchanged |
| **8** | `REVIEW_ROUND_8.md` | the v0.14.0 **escalation transport** and the r41-1 finality barrier, re-attacked from outside | **2 EXPLOITABLE fixed** (r8-1: `caseId` encoded lossily — unpaired surrogate and U+FFFD, two requests, **one digest**; r8-2: the transport **bound nothing** — an unverified `challengerPubkey` wrote a non-escalator into the append-only log, a stale `round` opened a rung nobody authorised, a `caseId` crossed cases); **4 PARTIAL fixed** (r8-3 `concession` coerced to false, r8-4 duplicate JSON keys silently resolved, r8-5 `build` validated A and returned B, r8-6 `resolve_round` bricked a case on a history that outran the ladder); the finality barrier **BLOCKED on all four paths to `finalize`** | this PR | 13 red on v0.14.0; the four r41-1 closures confirmed real (4 red on `1b33b2f`); consistent-forgery residual host-owned |

Between rounds 3 and 6 the campaign also ran the instrument rounds that produce
the numbers in §3: **29** corpora extension (#96), **30** transport + ceremony
(#98/#99), **31** economic re-verify + per-round bond (#100), **32** paper
refresh (#101), **33** Byzantine-relay matrix (#102), **34** register sweep
(#104), **35** whole-package readiness (#105), **37** mutation campaign 2
(#108). They are not review rounds of a fix, but every review round after 3
quotes them, so they are part of the record this index maps.

### 1e. Release map

| Release | PR | What it carried |
|---|---|---|
| v0.8.2 · v0.8.3 · v0.8.4 · v0.8.5 | #36 · #37 · #39 · #41 | improvement rounds 1–2 |
| v0.9.0 · v0.9.1 · v0.9.2 · v0.9.3 · v0.9.4 | #43 · #46 · #48 · #49 · #51 | rounds 3–8: ladder, property sweep, invariant doc, formal audit, crypto audit, adversarial Nostr |
| v0.10.0 · v0.10.1 · v0.10.2 | #54 · #57 · #60/#61 | rounds 9–11: performance, error taxonomy, paper/API alignment |
| v0.11.0 | #88 | the external reviews' answers: Lean 4, attribution T6, settlement binding, parameters, campaigns |
| v0.12.0 · v0.12.1 | #93 · #97 | escalate witness, derived cap, deterministic budget; **r29-1 fix** |
| v0.13.0 · v0.13.1 · v0.13.2 | #100 · #106 · #110 | per-round bond (r30-1); **r33 fixes**; **r38-1 + r40 fixes**, mutation campaign 2, strict round-bond default |
| v0.14.0 · v0.14.1 | #114 · #116 | **r41-1** (the finality derivation) + the H-6 escalation-request transport (#113); **r8-1…r8-6** (canonical `caseId`, the required wire binding, the duplicate-key/concession/one-read fixes, `resolve_round`'s history bound) |
| v0.15.0 · v0.15.1 · v0.15.2 | #128 · #131 · #135 | the exported ladder bound as the safe predicate (r52); **round-11** (a total `quoteWireValue`, the shape gate, the clawback reader); **round-12** (the escape path over all four files, the counters' write domain) |
| v0.15.3 | this PR | **r12-1 over-strictness, found by the host sync** (bao.markets PR #2488): the counter barrier required `ladderRound = 0` with no `ladder`, which refused the host's whole G-4 lane projection (42/185 host court tests). Fixed by a declared `projection: 'lane'` + a required reader argument, with a standing over-strictness matrix — `docs/LANE-PROJECTION.md`, INV-CONF-37 |

---

## 2. The failure-mode taxonomy

Nine classes. They are the campaign's actual output: the individual findings are
instances, the class is what a future reviewer should be able to recognise
without re-deriving it.

| Class | Instances | Root-cause pattern | Enforcement now |
|---|---|---|---|
| **1. Trust-boundary / pinning** | v0.8.2 F3/F1 (v2 scope pins declared, never enforced; dispatcher policy downgrade on a v1-shaped event); v0.8.5 batch-root pin absent; **F-2 present-but-empty pin** silently disarmed the group-key check on all four entry points; client `2140wtf` #201 (**unpinned batch verification — any keypair could display a fake `final`**); B-2/RS-5 caret-range crypto deps (the audit verdict describes the lockfile, not what a fresh install resolves) | The guard is named in prose but the consumer never receives the expected value — or receives `''`/`0`/`undefined` and a truthiness test treats "absent" as "no pin required". The trust boundary is *assumed* rather than asserted, and the assumption is invisible in the type. | Fail-closed emptiness (`!pin \|\| …` is typed-invalid, never "unpinned"); `V2_ONLY_POLICY_FIELDS` refuses downgrades; MUST-pin docstrings; THREAT_MODEL §5 P1–P12; CROSS_CHECK `PAPER-7.3-3`; the pinning duty is stated as an **open obligation**, not a mechanism (PO-10) |
| **2. State-restore divergence** | **r29-2** (the new `escalationLog` was an input to fee attribution and penalties, yet `finalize` re-verified the ledger and history but not the log); **r33-5** (a short log was accepted so pre-0.12 snapshots finalize — which also *un-consumed* a deleted record's bond); **r37-1** (the log's round bound ignored the `ladder_pending` half-step and refused a state the reducer itself produces); **r40-1/r40-2** (two rung-spending entries re-derived nothing); **r41-1** (`finalize` built the verdict's evidence set from the **vote** ledger, whose barrier ran at `resolve_round` — a transition a restore skips; the entry matrix had classified `concede` as a "non-reader followed by a pool-reading barrier", true of the challenge pool and false of the pool `finalize` reads) | Restore is not a hook: each handler opts in to re-validation, so the barrier set grows one entry behind the field set. The reducer's live path checks what it is about to append, never what it was handed. Inverse failure: a barrier written from the happy-path shape refuses a legal crash-window state and bricks the case. The related blind spot is **naming the pool**: an entry matrix that asks "does this entry read *the* ledger" answers a different question from "does it read *a* ledger that another transition barriered". | Per-entry matrix, pinned test by test, now stating **which pool each entry reads** — the challenge pool, the escalation log, the confirmation ledger, the outcome history **and the mass-vote ledger** are re-derived at every entry that spends a seat or locks a value (`accept_challenge`, `escalate`, `open_ladder_round`, `resolve_round`, `finalize`), and `finalize` **derives** the verdict from the deciding round's `outcomeHistory` record rather than trusting the pending field; completeness rule (one record per opened round, `ladderRound−1` / `ladderRound` while pending, and `outcomeHistory.length === ladder.round − 1` at `resolve_round`); **490-state legal-state hunt = 0 refusals**, 40/40 legal flows still finalize with identical hashes |
| **3. Bond / economics binding** | **r30-1** (the bond was a *membership* test: one accepted bond authorised every round — escalation was a free option worth 363 b₀; farming EV −2.40 % → −1.86 % of V at the shipped cap, venue/griefer ratio 0.86× → 54.1×); **r33-1** (another juror's membership bond relabelled as this round's payment); **r33-2** (the witness is a *uniqueness* test, not a *payment* test); **r38-1** (the membership pool itself had no uniqueness: one payment, unlimited standing); **r40-3** (unique but not **owned** — a derivable witness is preemptable, so a non-owner locks the payer out); r29-3/r33-3 (one bond spendable in two cases); r29-4 (`formatOnlyBondVerifier` is a hex regex) | The machine can see strings, not chains and not payments. It therefore enforces the strongest property available — *distinctness* — and the prose upgrades that to *paid*. Every fix that adds a field re-opens the class one field over unless the new field is bound per-actor and per-consumption. | `roundBondProofHash` + `requireRoundBond` (strict by default for new deployments as of R39); bond hash bound to **(challengerIdx, hash)** and **one hash → one index per case**; completeness ledger so deletion cannot un-consume; `deriveMaxLadderRounds` returns **0 = no safe depth** and `ladderCapWithinBound.ok` is **sign-based** (`cap < flipRound`), never `cap ≤ derivedCap`; host unique index + rail-backed verifier with author binding — DEFERRED-v0.14 with owner + trigger (`H-13`, `r33-2`, `r40-3`) |
| **4. Report-vs-decision mismatch** | **H-2** (`challenge_close` / `ladder_round` / `fallback_propose` deadline handlers throw `COURT_DEADLINE_HANDLER_NOT_IMPLEMENTED` — the row retries and never silently fires, so the *report* says a deadline was handled while nothing decides); H-3 (`enforce` confirmation mode is observational: the settlement path never consults `court_outcome_proposals`); SOAK-F2 (same item, seen by the soak); r29-9 (the changelog advertises `deriveCourtEconomicCap()` — a host export that does not exist here); N7 (merged PR body quotes 3,496,808 checks / 1,124 s against the artifact's 3,592,861 / 550 s); r40-5 (the boot backfill prints "existing markets keep their frozen depth" for rows that never had one); P3 (the model-check fixture declares P1–P5 while the paper advertises P6/P7) | Two descriptions of one decision drift apart: the artifact that *reports* (changelog, PR body, log line, audit counter, `propertiesChecked`) outlives the mechanism that decides, and nothing repeatedly reconciles them. A reviewer reading only the report concludes the decision exists. | Every residual names **owner + trigger** in the host's `REGISTERED_FINDINGS_SWEEP.md` (112 rows, four legal dispositions, `CLOSED-by-design` must name the enforcing guard); `scripts/cross-check.mjs` fails CI on a dangling claim/evidence pointer and on a PO code that is cited but not defined; provenance notes are *appended* to a document rather than rewriting history (N7, `SCALE_CAMPAIGN`); the readiness round re-derived 12 paper numbers from artifacts (12/12 exact, 1 stale count found) |
| **5. Over-strictness** | **r37-1** (a barrier refusing a legal `ladder_pending` state — the crash window the reducer itself creates, found by *reading a surviving mutant*); the short-log exemption (deliberate: a pre-0.12 snapshot has no log, and refusing it would make legacy cases un-finalizable); the no-challenge path (20/20 policy combinations must finalize with an empty ledger); r38-5 ("a penalty never expires outright" is false from ~156 participating epochs — a claim-vs-mechanism item in the forgiving direction) | Closing a hole by forbidding a state the reducer can reach converts a security fix into an availability bug: the case bricks *after* a panel has been seated and paid for. The class is the mirror of class 2 and is invisible to a test suite that only feeds legal-looking hand-built states. | **Legal-state enumeration, not judgement**: every legal flow is walked and both barriers are hammered on every produced state (490 states, axes `maxLadderRounds` × `requireRoundBond` × `hostEscalation` × challenged/never × authority × bond shape × terminal move), with every refusal asserted to match one of three documented policy refusals so a new barrier defect cannot hide in the walk; every phase asserted visited so the hunt cannot silently shrink; legacy and no-challenge restores pinned in every round since 3 |
| **6. Vacuity** | **MC-F7/F7** (the `partial-equivocation` instance's fabricated conflict-psigs collapsed onto its base instance — 19,822 states both — so a variant "passed" while exercising nothing; repaired to 116,906); **MC-F8/F8** (the witness fixtures were all-digit hex, so the "uppercase hex must be refused" row produced a byte-identical *legal* witness); **W-VACUOUS** (same class, found again by the round-29 witness corpus); **r29-10** (a mutant returning an infinite simulation ceiling survived 23/23 budgeted tests); round-29 corpora (a forgery mutation that was a no-op ~1/16 of the time); **M66/M40** (mutants adjudicated *equivalent* rather than counted as holes) | An adversarial row that cannot distinguish itself from the legal row proves nothing while the suite stays green. The fixture is written by the same hand as the guard, so the probe inherits the author's blind spot. | Fixture instance state counts must be **pairwise distinct** (systematizes F7); `illegalWitnessAccepted === 0` is *reachable* — the explorer fails rather than silently passing when a probe is really the legal event; the budget helper's default/junk-fallback/override/ordering are asserted (not just "elapsed < ceiling"); mutants are adjudicated equivalent only with an argument, and equivalence is recorded rather than deleted; campaign 2 re-ran on the **rebased** tree (pass-1 numbers never shipped as pass-2 facts) |
| **7. Flood / eviction** | **T-1** (one wrap delivered by 65+ relays overflowed a per-record provenance list; `fromSnapshot` rejects > 64 relays, so *the entire durable inbox — every message — was unrestorable on the next restart*, no key required); C-3 (100k records × 256 KB ⇒ ≈25.6 GB in memory, plus a JSON-snapshot transient double, and nothing in the docs said so); client `2140wtf` #201 (**20 GB ingest** before validation) and the host indexer's FIFO caps that evict oldest-first with no provenance priority (`R41-IDX-POLL-VOTER-CAP-001`, `R45-POS-LOCK-UNCAPPED-001`); SOAK-F7 (a partition longer than the reconcile overlap walked the ack cursor past unserved acks — 8 of 184,620 silently lost); host F6 (ack-reconcile starvation at scale) | A cap is enforced by *count* (or by FIFO age) with no notion of which entries are load-bearing, so a hostile relay or a flood evicts exactly the entries that matter — or pushes the store past the restore path's own contract and turns availability into a brick. The failure is a self-DoS: no key, no exploit, just volume. | Provenance capped at the **first 64 distinct sources in delivery order** (deterministic), `lastSeen` keeps advancing, restore stays strict; byte-arithmetic sizing guidance in `courtInbox` (bound by *bytes*, snapshot incrementally); the ack watermark lags **one overlap** behind `now`; bounded fast corpus subset in CI so a flood regression is caught continuously rather than at release |
| **8. Attribution** | **r29-1** (the escalation log recorded the *wrong* challenger against the *wrong* bond — the audit artifact hosts use to attribute misconduct and price fees named an innocent juror); r33-1/r38-1 (the payer of a rung logged as the wrong actor; one payment, unlimited standing); **r40-3** (preemption: the non-owner registers the payer's derivable witness first and holds the only escalation right); **r8-2a** (the transport forwarded an unverified `challengerPubkey` into the append-only log, so a bonded challenger could log a juror who never escalated); r29-5/r38-3 (`challengerPubkey` is caller-supplied; the state carries no idx→pubkey map); client `2140wtf` #201 (unpinned verification let **any keypair assert finality on screen**); PR #51 (ingest dedupe without NIP-01 id verification; uncertified outcome tag steering resolution) | The record of *who did it* is authored by the caller and then trusted, because the state has no registry to check it against. Uniqueness is mistaken for ownership, and a signature is mistaken for an identity (`T6`: the bare FROST aggregate is provably **unlinkable**). **Forwarding a claim is not binding it** — a mapper that fills one field from a proof and passes a neighbouring field through uncompared produces exactly the confusion the proof was meant to remove. | The signing-session journal (`docs/proofs/attribution.tex.md`, Theorem 6) decomposes an aggregate to per-index partials and names a failing one — **conditional on** the certified-share pin (P1) and an authenticated append-only log (P2), which is stated as the residual; one bond witness → one challenger's standing; the entry barriers re-derive `(idx, hash)` before a seat is spent; `accept_challenge` carrying the challenger pubkey is the **v0.14** snapshot change that closes r29-5/r38-3/r40-3 together; `escalationRequestToMachineEvent` **requires** the host binding `{caseId, authenticatedPubkey}` (r8-2); the host verifier must bind the witness to the **event author**, not merely prove a bond exists |
| **9. Identifier canonicalisation** | **the pre-mainnet machine fuzz** (a lone UTF-16 surrogate let two distinct outcomes hash to one commitment — the first instance); **H-6** (the escalation request hash omitted the round-bond witness, so two different round bonds produced one request hash); **r8-1** (the wire codec's `caseId` went through `TextEncoder`, so an unpaired surrogate and U+FFFD — two different ids, two different wire documents, two different *cases* — produced **one digest**). Same class, three fields, three rounds. Related, cheaper instances: FIXES-08-18 delimiter-joined hashing (an embedding delimiter aliased a field) and the `concession: "true"` coercion (r8-3) | **Attacker-controlled identifier encodings must be canonicalised once, with an injectivity pin, per FIELD.** The defect is never "the hash lacked a field" and never "the parser was lenient": it is that a field's *encoding* was not injective over the domain the attacker may choose from, so two values shared one preimage. Each field independently needs a domain on which its encoding is injective — canonical UTF-8 with no unpaired surrogates, no separator character, a byte bound, a defined absence sentinel — plus a collision probe over that field and a domain tag in the preimage. A field that is only *validated* (a shape check, a hex regex, a type test) rather than *canonicalised* is still a member of this class, which is why the fixes are one field apart: each round canonicalised what it could see. The failure is silent by construction — the hash verifies, the signature is valid, and two meanings share one digest | The encoding layer owns it: `CanonicalWriter` (length-prefixed, domain-tagged) for every cross-party hash; `isCanonicalUtf8Text` + `MAX_ESCALATION_CASE_ID_BYTES` + NUL refusal for the wire `caseId`; the domain-v2 request hash with a `'-'` sentinel for absence; the duplicate-key scanner (`assertNoRepeatedWireFields`) so one body cannot carry two claims; a pinned known-answer digest per codec so two implementations cannot drift; collision probes (the surrogate pair, the 2 000-id sweep) as *tests*, not as prose. The rule is stated in paper §11.6 and, per field, in each codec's header |

**How to use the taxonomy.** A future review should start by asking which class
it is in, because the class determines where the fix goes: class 1 fixes are
consumer-side and typed; class 2/5 fixes are barrier-side and need an entry
matrix *and* a legal-state hunt; class 3 fixes are state-side and need a
per-actor + per-consumption binding, never a stronger string check; class 4 fixes
are process (owner + trigger), not code; class 6 fixes are instrument-side and
must be shown to fail before the fix; class 7 fixes are capacity-side and must
name which entries are load-bearing; class 8 fixes are provenance-side and must
derive the actor from proof, not from a field; class 9 fixes are encoding-side
and go in the normaliser, not the caller.

---

## 3. The numbers

Every number below is from a committed artifact, not from a release note. The
column *Reproduce* names the command or file.

### 3a. The campaigns

| Instrument | Numbers | Reproduce |
|---|---|---|
| **Mutation campaign 1** (spec blindness) | **53 mutants / 18 classes**; 46 flagged, 44 real captures, **7 outright survivors** (+1 wall-clock artifact); score **86.8 %** as found; after 9 pin groups / 14 tests: **52 of 52 applicable = 100 %**, M40 adjudicated *equivalent*; `git diff-tree` on the fix commit shows **no production source changed** — the holes were specification blindness, not latent bugs | `scripts/mutation/pass1-preclosure.json`, `pass2-postclosure.json`, `pass3-detector-audit.json`; `docs/MUTATION_TESTING.md` |
| **Mutation campaign 2** (the v0.13 surface) | **25 mutants / 10 new classes** (catalogue **78 / 28**); **24 captured, 1 survivor (M66) → adjudicated equivalent**; score **96.0 %**; detector A 92.0 %, C 76.0 %, B 8.3 % of the 12 it can even see; the survivor hunt found **r37-1** (a guard pointing the wrong way in one phase) — found by *reading the survivor*, not by any mutant | `scripts/mutation/pass1-v013.json`, `pass2-v013-postclosure.json`; `docs/MUTATION_TESTING_V013.md` |
| **Scale corpora** | **1,187,000 corpus units / 3,745,566 checks / 0 failures in 608.8 s**, 9 campaigns, one invocation; earlier record 1,171,000 units / 3,592,861 / 550 s (the two are different runs; N7 records the drift) | `npx tsx scripts/campaign/run-campaign.mjs --full` → `docs/benchmarks/campaign-2026-11-11.json` |
| **Model checking** | **15 instances / 3,869,232 states / 213,521,172 event applications / 60,020,684 illegal-witness probes with 0 accepted / 0 raw throws / 3,000 determinism paths**; rosters n ≤ 4, reduced clock universes; 2,525 s regeneration; the 13-instance pre-witness sweep is labelled historical | `npx tsx scripts/model-check.mjs` → `__fixtures__/model-check-summary.json` |
| **Lean 4 (single finality)** | **633-line** development, Lean 4.14.0, `oracle_single_finality`, **no `sorry`**, axiom audit clean (`propext`, `Quot.sound` only); `machine_alone_insufficient` proves two reachable states can finalize different outcomes — the honest boundary of state-machine evidence; crypto abstracted (`Signed` uninterpreted), threshold-intersection arithmetic a named hypothesis | `proofs/lean4/` (`run.sh`, `lean-run.log`) — outside the one-command contract (needs an elan toolchain) |
| **Quint (independent re-model)** | 1,626-line model, **42 scenario tests**, seeded simulation runs (10,000 samples/runner), **Apalache bounded symbolic check to depth 10** — a second model, not a proof | `proofs/mechanized/` (`run.sh`, `quint-run.log`) — needs Quint + Apalache |
| **Differential parity** | independent reimplementations of the encoding writer, Merkle tree, tally, selection and hashes, pinned byte-for-byte and by oracle; 1 real divergence class found (UTF-16 vs UTF-8 tie-break) | `__tests__/reference/`, `__tests__/differentialParity` evidence in CROSS_CHECK |
| **Three-day soak (host)** | **30,000 settlements** over 3 virtual days + a 38 h drain = **110 virtual hours**, **32/32 assertions green**, 5.7 min wall; zero lost deadlines, zero double-publishes, sat-exact ledger parity (150,180,128 sats); found **3 real defects incl. one about itself** (SOAK-F8: the soak had been red on `main` for two protocol rounds — 11/17 assertions, 289 stuck cases, 48,089 retries); scope: in-memory Postgres + virtual clock, so logic/ordering/volume, **not** real-PG serialization, fsync or relay RTT | host repo `docs/benchmarks/SOAK_3DAY.md`, `soak-3day.json` — not regenerable from this repository |
| **Multi-process ceremony** | N = 3…7 real OS processes, separate PIDs/heaps/identities/cursors, honest loopback relay assigning total order; `SIGKILL` mid-DKG → every survivor fails closed with **no** group key; mid-signing → `SIGN_MISSING_REVEAL`, no signature; cross-round replay → equivocation, replayer disqualified; **Byzantine relay** matrix (reorder, drop, split-view, replay, silence) → `NO_EQUIVOCATION` by mechanism, 8 cases | `npm run simulate:multiprocess`, `npm run simulate:byzantine` |
| **Claim ledger** | **285 claims / 516 evidence refs / every pointer resolves / 271 covered (95.1 %) / 14 open gaps by design**; 158 invariants, 156 with executable proof | `node scripts/cross-check.mjs` |
| **Suite** | **1,804 passed / 1 skipped (81 files)** at v0.14.1; the per-round ledger (1,491 → 1,804) is recorded in CROSS_CHECK §1 | `npm test` |
| **Registered findings** | **112 rows** in the cross-repo sweep (the v0.13.1 sweep dispositioned 107: 6 fixed / 46 closed-by-design / 53 deferred-v0.14 with owner + trigger / 2 rejected) | host `docs/operations/REGISTERED_FINDINGS_SWEEP.md` |

### 3b. Finding counts by round

| Round | Rows | Exploitable | At-host exploitable | Partial | Major / minor | Blocked / questions | Fixed in-round |
|---|---|---|---|---|---|---|---|
| R1–R4 (improvement) | 3, 5, 3, 6, 12 (by round) | 1 CRITICAL (Aug pre-round), 1 HIGH (R1) | — | — | — | — | 3 (R1) + 5 (fuzz) + 3 (R2) + 6 (R3) + 3 substantive of 12 (R4) |
| R7 crypto audit | 12 mechanisms | — | — | — | 3 MED shipped, 4 spec'd, 5 OK | — | 3 |
| R16 simulation | 31 rows / 30 distinct | 0 REJECT | — | — | **8 MAJOR, 7 MINOR** | **14 QUESTION** (rebutted) | 12 |
| External reviews | 8 demand classes | — | — | 3 | — | — | 5 satisfied, 1 closed by edit |
| Review round 2 | 8 objections + 8 new | 0 | 0 | 3 | 3 MAJOR, 5 MINOR | — | 4 of 8 N-items by edit |
| Review round 3 | 10 attacks | **1** (r29-1) | 1 (r29-7) | 3 | — | rest | 4 (2 code, 1 edit, 1 test-only) |
| Review round 4 | 17 attacks | **2** (r33-1, r33-5) | 1 (r33-10) | 4 | — | rest | 3 + 1 partial |
| Review round 5 | 17 attacks | **1** (r38-1) | — | 2 | — | rest | 1 |
| Review round 6 | 16 attacks | **2** (r40-1, r40-2) | — | 3 | — | rest | 2 + 3 doc |
| Review round 7 | 21 attacks | **1** (r41-1) | — | 1 | — | rest | 3 |
| Review round 8 | 34 attacks | **2** (r8-1, r8-2) | — | 4 | — | rest | 6 + 1 doc |

**Every exploitable finding in the review rounds was fixed in the round that
found it**: r29-1, r33-1, r33-5, r33-6, r38-1, r40-1, r40-2, r41-1, r8-1, r8-2 —
ten named closures, each with a test that is red on the pre-fix head (4 of 15 in
round 3, 6 of 21 in round 4, 3 of 27 in round 5, 6 of 23 in round 6, 4 in round
7, **13 red of 34 in round 8**). The one CRITICAL
finding in the whole record is from the pre-mainnet August round (complaint
protocol without possession binding → group-secret extraction), and no review
round has ever found a REJECT-level defect in the paper.

**Distribution.** Class 1 (trust-boundary/pinning) is the largest by count; class
9 (identifier canonicalisation) is second and is the only class with the same
defect found three times in three different fields — it is the class a future
reviewer should assume is *still open* somewhere until a per-field injectivity
pin is shown for every field a preimage concatenates. Class
3 (bond/economics) owns the exploitable findings of rounds 3–5 (r29-1, r33-1,
r33-5, r38-1, plus r33-6 on the economics side); round 6's two are class 2
(r40-1, r40-2), found by asking which entries *spend a rung* rather than by
probing; round 7's r41-1 is class 2 one ledger further (which **pool** each
value-locking entry reads), and round 8's two are class 9 (r8-1) and class 8
(r8-2), found by asking what the transport *binds* rather than what it carries.
Class 6 is the instrument class: it produced the r37-1 finding by making
a surviving mutant readable, and it is the class that keeps the other eight
honest.

---

## 4. Where the record lives

| Need | Go to |
|---|---|
| A round's authoritative statement | `REVIEW_ROUND_2..8.md`, `REVIEW_SIMULATION.md`, `READINESS_REVIEW.md`, `MUTATION_TESTING*.md`, `benchmarks/SCALE_CAMPAIGN.md`, `CRYPTO_AUDIT.md`, `docs/proofs/**` |
| A claim → its executable proof | `CROSS_CHECK.md` (machine-verified; 285 claims / 516 refs) |
| An invariant → its guard → its test | `FORMAL_INVARIANTS.md` (158 `INV-*`) |
| A residual → its owner and trigger | host `docs/operations/REGISTERED_FINDINGS_SWEEP.md` (112 rows) |
| The method and its limits | paper **§11.6** "The review verifies itself"; `READINESS_REVIEW.md` persona 1 on what §11.6 can and cannot carry |
| Which environment a rail result came from | paper **§11.8** (public testnet4 / signet-public outrank the private signet; every private-signet result is labelled) |
| The campaign's method as a reviewer should apply it | paper §13 (five claim classes, four status labels, every row carrying an open obligation) |
| The proofs | `docs/proofs/README.md` (T1–T6, dependency graph, 6 lemma gaps) |
| Reproducing any number | `REPRODUCIBILITY.md` + the *Reproduce* column in §3a |

## 5. What this index is not

- **Not a review.** It re-states counts and dispositions that the source
  documents and artifacts already carry; it found nothing new.
- **Not independent.** Every round listed here was run by the same project that
  wrote the code. §11.6 states the limits: the same authors choose the targets,
  hold both the attack and the defence, and share one threat model — so a
  specification-level misreading shared by both sides survives exactly as it
  survives the differential parity. There is no incentive asymmetry, and a fix
  nobody attacked is not evidence of anything.
- **Not a claim that the numbers generalize.** Mutation scores are statements
  about the tests (the mutants are hand-written and encode the bug classes *this
  reviewer* thought of); the corpora are statistical sweeps, not exhaustive
  proofs; the model checker is exhaustive only within its abstraction; the soak
  validates logic, ordering and volume against a model of Postgres; the ceremony
  is localhost; and 96.0 % here vs 86.8 % in campaign 1 measure different mutant
  sets on different code — compare per class, never per total.
- **Not finished.** Review rounds 7 and 8 have landed and are indexed here, but
  the deferred rows
  (r29-5/r33-2/r38-3/r40-3, r33-3/r33-4, r33-7/r40-4/r40-5, r41-2, H-1…H-7) are open
  with owners and triggers, and the independent human cryptographer / third-party
  audit the paper's §12.5 lists as absent is still absent.

---

*Maintained alongside the review documents. When a round lands, add its row, add
its numbers to §3, and — if it produced a finding that does not fit an existing
class — add the class. Do not rewrite an earlier round's record: append a
post-publication note, as `REVIEW_ROUND_5.md` does.*
