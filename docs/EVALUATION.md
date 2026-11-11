# BAO Court — Evaluation

**Version:** tracks `@bao/court` v0.15.2 · **Date:** 2026-11-11 · **Round:** 56
(final totals refresh after review rounds 9–12)

> **Final totals at `v0.15.2`.** Suite 1,953 tests / 90 files (clean-runner CI);
> 101 mutants across three campaigns; 1,587,000 campaign units / 8,286,823
> assertions / 0 failures; 3,869,232 states / 60,020,684 illegal-witness probes
> with 0 accepted; 42 Lean 4 declarations with no `sorry` (axioms `propext`,
> `Quot.sound`); 100,000-case independent wire differential with 0
> disagreements; three-day soak 32/32; cross-check 285 claims / 516 refs /
> 95.1 %. Tables below are the per-round measurements, each dated to the release
> it was taken on.

This is the paper's evaluation section as a standalone artifact. Every number
below comes from **existing committed evidence** — a merged PR, a committed
fixture, a recorded soak/bench artifact — and each table names the artifact a
reviewer can click through to. Nothing here was measured for this document;
where a number is regenerable, the regenerating command is named, and the
one-command reproducibility contract (regenerating *everything* on this page
from a fresh clone) is specified in **docs/REPRODUCIBILITY.md**.

Claim→evidence traceability for the *underlying* claims (as opposed to this
chapter's summary numbers) lives in **docs/CROSS_CHECK.md**; the security
argument this chapter evaluates empirically is **docs/THREAT_MODEL.md**;
performance methodology and full tables are **docs/benchmarks/BASELINE.md**.
This chapter cites those artifacts and does not duplicate them.

---

## 1. Methodology in one paragraph

The claims of the paper were not checked once; they are the output of a
round-by-round program (paper §11.5) in which each round picks an attack
surface or a verification technique, records what it finds, and lands the
disposition — a shipped fix with pinned tests, a documented hold, or a spec'd
follow-up. The evaluation evidence therefore has five layers: **exhaustive
model checking** of the ceremony machines, witness-aware since v0.12 (§2.1),
**differential parity** against independent reimplementations (§2.2),
**property-based sweeps** and a **formal-invariants audit** (§2.3–2.4),
**statistical corpora** of 1.19 M seeded cases (§2.5), and a decade-compressed
**adversarial audit record** — including the rounds that attacked its own
fixes — plus a host-API pentest and two soaks (§3, §4). Performance is measured,
never assumed, including the optimizations that were *refused* with numbers
(§4). The threat-model chapter closes the loop: 285 indexed claims, **95.1%**
backed by executable evidence (§5). What the numbers do **not** prove is stated
in §6 — reviewers should read it, especially items 7–8, which are the new
limits this refresh introduced rather than removed.

**Recorded verification state at v0.10.2 `main` (2026-11-10, PR #64):** full
suite **1,491 passed / 1 skipped (61 files)**; `npm run typecheck` +
`typecheck:tests` clean; `node scripts/cross-check.mjs` verifies all 493
evidence pointers, exit 0. *(Rehearsal refresh, round 17, 2026-11-10: full
suite now **1,492 passed / 1 skipped (61 files)** — one test added by the
round-16 review fixes; all contract stages PASS — see
`docs/DRESS_REHEARSAL.md`.)*
*(Round 21, 2026-11-11: full suite now **1,534 passed / 1 skipped (64 files)** —
14 mutation-closure tests added by the mutation campaign; see
`docs/MUTATION_TESTING.md`.)*
*(Review round 3, 2026-11-11: full suite now **1,561 passed / 1 skipped (66 files)** —
15 adversarial tests added while attacking the shipped escalate witness; see
`docs/REVIEW_ROUND_3.md`.)*
*(Round 30, 2026-11-11: **1,606 passed / 1 skipped (70 files)** — the transport
and multi-process ceremony campaign (seal games, MLS surface, inbox/outbox load,
4 ceremony scenarios) plus the economic re-verify's modules.)*
*(Round 31 / R31, 2026-11-11 — `c456fb4`: **1,656 passed / 1
skipped (74 files)**, `npm run typecheck` clean, `node scripts/cross-check.mjs`
exit 0 over **285 claims / 516 evidence refs** (95.1 % covered, gap register 18
entries: 14 open, 4 closed). The +50 over round 30 are the per-round bond
consumption matrix, the derived ladder economics, penalty ageing, and the
churn/quorum cap arithmetic.)*
*(Review round 4 / R33, 2026-11-11 — **1,677 passed / 1 skipped
(75 files)** at `841b012`, `npm run typecheck` clean. The +21 are
`reviewRound4.test.ts`: the foreign-membership-bond and emptied-ledger closures,
the escalate-time log barrier, the sign-based ladder pre-flight, the idle-gap
penalty pins and the overflow guard. See `docs/REVIEW_ROUND_4.md`.)*
*(Round 34 / readiness review, 2026-11-11 — **current head `608e6dc`:
1,686 passed / 1 skipped (76 files)**, `npm run typecheck` clean,
`node scripts/cross-check.mjs` exit 0 over 285 claims / 516 evidence refs. The
+9 over the R33 count are the round-33 Byzantine-relay suite (`#102`, 8 tests,
merged after that count was taken) and the r29-11 budget-derived timeout pin.)*
*(Review rounds 5–6, 2026-11-11 — **1,739 passed / 1 skipped (78 files)** at
`8bac1bc` (v0.13.2), reached through review round 5's r38-1 closure and review
round 6's 23 probes (the r40-1/r40-2 closures, the barrier-at-every-entry
matrix, the 490-state legal-state hunt). See `docs/REVIEW_ROUND_5.md`,
`docs/REVIEW_ROUND_6.md`.)*
*(Review round 7, 2026-11-11 — **1,758 passed / 1 skipped (79 files + 1
skipped)** at `4cd97f1`: +19 for `reviewRound7.test.ts` — the four r41-1
closures (all red on the pre-fix head), the three stated non-readers probed, the
40-flow over-strictness walk, the sign-rule edge/grid pins and two doc pins. See
`docs/REVIEW_ROUND_7.md`.)*
*(Review round 8 / this refresh, 2026-11-11 — **current head `bc28ff3`
(v0.14.1): 1,804 passed / 1 skipped (81 files)**, `npm run typecheck` +
`typecheck:tests` + `typecheck:scripts` clean, `node scripts/cross-check.mjs`
exit 0 over **285 claims / 516 evidence refs** (95.1 % covered; gap register 18
entries: 14 open, 4 closed). The +46 over round 7 are `reviewRound8.test.ts`
(34 — the r8-1…r8-6 closures, of which **13 are red on the released v0.14.0
head**, plus the four paths to `final`, re-attacked from outside) and
`escalationRequestWire.test.ts` (12 — the transport's round-trip, strict
refusal matrix and pinned known-answer digest). See `docs/REVIEW_ROUND_8.md`.)*

---

## 2. Correctness at scale

### 2.1 Exhaustive model checking of the ceremony machines

**Artifact:** `__fixtures__/model-check-summary.json` (committed), regenerated
by `npx tsx scripts/model-check.mjs` · **PRs #53** (v0.9.4), fixture refreshed
**PR #63/#64** (full-mode regeneration, 17 min) and **again in rounds 29/30**
(witness-aware: 15 instances, 2,525 s full mode) · methodology and abstraction
limits: the header of `__tests__/modelCheckingCore.ts`; properties P1–P7 +
typed-error discipline described in paper §11.2.

Every reachable state × every event application of the three ceremony phase
machines (vote, confirmation/ladder, signing), asserting at every step: phase
legality, the data-invariant set (real SHA-256 commit–reveal and
session-hash re-derivation, real secp256k1 nonce points, signer-set freeze,
deep-frozen states, monotonic clock on **every edge**), the no-dead-ends
biconditional, acyclicity of the progress graph (Kahn), and ≥200 replayed
determinism paths per instance. Since the escalate witness exists, the explorer
also **dispatches an illegal escalation-witness matrix at every reachable
state** (P6) and fails the instance if any witness is accepted, and checks the
`escalationLog` bound (P7).

| Metric (15 instances, full sweep) | Value |
|---|---|
| Concrete states explored | **3,869,232** |
| Event applications | **213,521,172** |
| Typed throws (illegal-event discipline exercised) | 195,033,132 |
| Illegal-event checks | 145,907,861 |
| **Illegal escalation witnesses dispatched** | **60,020,684** |
| **Illegal witnesses accepted** | **0** |
| Max observed `escalationLog` depth | 2 |
| **Raw throws (`TypeError`/`RangeError`)** | **0** |
| Progress edges / idempotent self-loops | 12,796,460 / 5,691,580 |
| Determinism paths replayed | 3,000 — all byte-identical |

*Artifact:* `__fixtures__/model-check-summary.json#totals` (witness-aware sweep;
pre-witness sweep was 13 instances / 3,149,142 states / 134,838,724
applications, tables in `docs/benchmarks/SCALE_CAMPAIGN.md` §2.1).

Per-instance (the committed fixture; every row carries `rawThrows: 0` and 200
determinism replays):

| Instance | States | Applications | Terminal states |
|---|---|---|---|
| vote n=1 k=2 | 334 | 15,224 | 152 |
| vote n=2 k=2 | 2,650 | 117,289 | 1,424 |
| vote n=3 k=2 | 42,646 | 1,843,302 | 25,544 |
| vote n=4 k=2 | 1,268,770 | 54,752,135 | 794,624 |
| vote n=2 k=3 | 5,482 | 246,757 | 2,984 |
| confirm n=3 q=3 r=1 challengers=all | 362,046 | 22,196,730 | 234,078 |
| confirm n=3 q=1 r=1 dup-event-ids | 1,010,820 | 64,190,226 | 668,382 |
| confirm n=3 q=1 r=2 | 111,915 | 6,729,987 | 69,009 |
| confirm n=3 q=1 r=1 roundRoster | 61,455 | 3,783,072 | 39,669 |
| **confirm n=3 q=1 r=2 escalate-witness challengers=1,2** | **537,825** | **38,045,170** | — |
| **confirm n=3 q=1 r=3 host-escalation** | **182,265** | **12,805,030** | — |
| signing n=2 t=1 | 2,532 | 78,588 | 2,232 |
| signing n=3 t=2 | 19,822 | 617,139 | 17,552 |
| signing n=3 t=2 commitment-equivocation | 143,764 | 4,464,858 | 127,844 |
| signing n=3 t=2 partial-equivocation | 116,906 | 3,635,665 | 106,416 |

*Artifact:* `__fixtures__/model-check-summary.json#instances` (the
partial-equivocation instance's state space was **repaired from a vacuous 19,822
to 116,906** by PR #58 after finding that its fabricated conflict-psigs collapsed
onto the base instance — recorded as finding **MC-F7**: *a variant instance whose
state space equals its base's is not exercising what it claims*. The witness
round found the same class one level down — **MC-F8**: the witness fixtures were
all-digit hex, so the "uppercase hex" probe was a no-op until the new
illegal-witness assertion caught it.)

**The cost of checking is itself measured.** The signing machine's per-reduce
cost — the inner loop of exhaustive checking — was **3,340 µs per transition
at threshold=21** (dominated by re-validating every stored commitment's curve
point: 2 × `Point.fromHex` ≈ 88 µs per decode, O(threshold) decodes per
reduce). The bounded point-validity memo (v0.10.0) cut it to **110 µs — 30×
— with the invariant check unchanged**; the equivocation variants above are
tractable *because* of that measurement (docs/benchmarks/BASELINE.md
"Post-optimization", PR #54).

### 2.2 Differential parity — zero disagreements

**Artifact:** `__tests__/differentialParity.test.ts` + `__tests__/reference/`
· **PR #52** (37 tests, 5 reference modules) · methodology: paper §11.3.

Every critical pure function is reimplemented **independently** (different
algorithm, different library, same contract) and asserted to agree with the
production implementation. **Result: 0 disagreements.** What is pinned:

| # | Area | Independent reference | What is pinned |
|---|---|---|---|
| 1 | `CanonicalWriter` | byte-accumulator writer + independent parser | byte-identity, round-trip, prefix-freeness, injectivity, boundary/unicode, fail-closed ranges |
| 2 | Batch Merkle tree | array-slice RFC-6962 builder + record/replay proof verifier | exhaustive n=1..128 (8,256 proofs), every proof verifies, tampered paths reject; O(n) full-set generator (v0.10.0) pinned to the same verifier (n=1..128, 333, 1000) |
| 3 | Verdict/manifest/attestation-v2 hashes | `node:crypto` vs `@noble/hashes` | randomized + boundary agreement across **all 64 v2 optional-field subsets** |
| 4 | Selection lottery | exact u32/ranking differential + inverse-CDF clock | EXACT equality; STATISTICAL equality (chi-square, moments, winner law over 100k draws) |
| 5 | Plurality + tie-break | reduce-based reference tally | exhaustive 3^n assignments (n ≤ 4), random big tallies, UTF-8-vs-UTF-16 tie-break divergence pin |

*Artifact:* PR #52; suite continuously enforced in CI — a disagreement is by
construction a finding (implementation bug or under-specified contract).
The round-9 performance work (PR #54) was gated on this suite passing
**unchanged**: optimizations never change byte output.

### 2.3 Property-based sweeps

**Artifacts:** PRs **#44** (suite) and **#45** (updated for the v0.9.0
ladder), findings fixed in **PR #46** (v0.9.1) · files:
`__tests__/propertiesConfirmation.test.ts`, `propertiesBatch.test.ts`,
`propertiesValidator.test.ts` — all seeded (`mulberry32`), deterministic, no
new dependencies.

| Suite | Generated cases | Asserted per case |
|---|---|---|
| Confirmation | 400 random legal event sequences (rosters 2..25, 2..5 outcomes, random challenge/ladder interleavings) | never throws on legal input; terminals only {final, expired, aborted}; every final verdict recomputes against `hashCourtVerdict`; monotonic clock; deep freeze; hostile probes fail typed |
| Batch | 48 random batches (n = 1..300) vs an in-test independent RFC-6962 oracle | every index's proof verifies (oracle fold + full `verifyCaseInBatch` over really-signed events); root determinism under shuffling; full mutation matrix rejected by recomputation; validator never throws on hostile events |
| Validator | 120 signed v2 events over random well-formed field combos | tamper matrix (epoch/tier/threshold/signerSetRoot/attempt/batchMerkleRoot/marketId/outcome/round/dispute/verdict × tag-only and content-consistent variants) → all invalid; root-pin ≡ full-set pin; v2 downgrade refusal; no raw errors |

≈570 generated cases total. The sweep **found the round-3 findings** (r3-1…
r3-6, including the mid-ladder dead end r3-6 — a 2-member challenged case
could never resolve — fixed fail-closed at creation in PR #46), which is the
property suite earning its keep, not just passing.

### 2.4 The formal-invariants audit

**Artifact:** `docs/FORMAL_INVARIANTS.md` · **PR #47** (v0.9.1), hardening of
its findings in **PR #48** (v0.9.2).

**158 invariants** (`INV-<machine>-<n>`), each extracted from the
*actual guards* in source — an audit by another name — each carrying an
enforcement pointer (`file:line`) and the pinning test. Precision note
(round-16 external review, finding A-3): the family is *predominantly*
first-order and machine-checked; INV-CORE-1…8 are the language definitions
the invariant family is stated over, INV-SEL-3 is statistical by nature
(pinned by a paired-derivation statistical differential), and INV-VOTE-14
is pinned as defense-in-depth only (F-10). The
invariant↔guard↔test traceability matrix (§12 of that doc) is machine-checked
via docs/CROSS_CHECK.md: **156/158 (98.7%) carry executable proof**; the two
exceptions are named — INV-VOTE-14 (a defense-in-depth capacity guard,
FINDING-F-10) and INV-ATTRIB-3 (the batch-signing duty, spec-level until the
manifest hash enters the signed FROST message). The two newest are
**INV-ESC-8** (the escalation-log tamper barrier re-derived at `finalize`,
round 29) and **INV-ESC-9** (per-round bond consumption, round 31). The audit
produced 12 findings (F-1…F-12); the substantive F-12 (signing/DKG
machines lacked a monotonic clock ledger — old-timestamped replays were
admissible) shipped in v0.9.2 and is now checked on **every edge of the
model-checked state space**.

### 2.5 Statistical corpora — 1.19 million cases, one invocation

**Artifact:** `docs/benchmarks/SCALE_CAMPAIGN.md` + the committed
`docs/benchmarks/campaign-2026-11-11.json` (PR #96) · regenerable with
`npx tsx scripts/campaign/run-campaign.mjs --full`; CI runs a bounded fast
subset of **every** campaign (~10–15 s), so the corpora are enforced
continuously rather than quoted.

Nine seeded campaigns run **1,187,000 units and 3,745,566 assertions with zero
failures in 10.1 minutes** of corpus time on the reference host (608.8 s;
`declaredSizes` and `actualSizes` are identical for all nine — no corpus was
silently reduced). The campaigns drive generated inputs against **independent
oracles**, not against the implementation's own output:

| Campaign | Corpus | Assertions | What it pins |
|---|---|---|---|
| confirmation | 10,000 sequences | 731,225 | legal-sequence invariants C1–C6 incl. the quorum-policy flag, monotone clock, freeze, verdict recomputation, typed rejection |
| tally | 1,000,000 tallies | 2,010,400 | winner + whole supporting-id sequence vs a reduce-based UTF-8 oracle; 400,018 forced exact ties |
| merkle | 1,000 batches | 151,538 | production root/leaves == independent RFC-6962 tree; 86,309 verified proofs; 45,829 tampered proofs rejected |
| validator | 50,000 signed events | 50,000 | 25k accept / 25k reject, each rejection matching its **own** reason |
| selection | 10,000 draws | 229,693 | determinism, ranking parity, chi-square weight proportionality (χ² = 5.994 < 24.322) |
| encoding | 100,000 encodings | 420,005 | byte identity, round-trip, injectivity, prefix-freeness, fail-closed bounds |
| **witness** | **10,000 witnesses** | **28,880** | 27-row illegal-witness matrix through the real reducer: 740 accepted, 9,260 typed refusals, **0 raw errors**; replay/cap/oversize probes |
| **epochRotation** | **1,000 batches** | **15,139** | 39 rotations: epoch/cohort pins, re-signing refusals, cross-epoch re-batching, membership proofs |
| **finality** | **5,000 chains** | **108,686** | challenge windows → witnessed escalations → verdict → batch finality; terminal phases refuse a *perfect* witness |

**Scope:** these are *statistical* sweeps over generated inputs; the exhaustive
counterpart is §2.1, and neither subsumes the other. The one production-bug
count across all nine campaigns is **zero**; the one campaign bug (a mutation
that was a no-op for hashes already ending in the target digit) is recorded —
it is the same class as MC-F7/MC-F8, and it is why the corpus prints its own
mutation coverage.

---

## 3. Security evaluation

### 3.1 The audit record, condensed

**Artifacts:** `docs/FIXES-2026-08-15.md`, `docs/FIXES-2026-08-18.md`,
`docs/FIXES-2026-08-21.md` (pre-symposium adversarial reviews),
PRs **#36** (round-1 validator audit), **#37** (round-1 machine fuzz),
**#41** (round-2 cross-module), **#44/#45/#46** (round-3 property sweep),
**#47/#48** (formal audit), **#49** (crypto-literature audit),
**#51** (adversarial Nostr) · dispositions per finding in
docs/CROSS_CHECK.md.

| Audit round | Version / PR | Findings (severity) |
|---|---|---|
| Adversarial review of v0.2.0 | FIXES-2026-08-15 | 9 — 1 CRITICAL (complaint protocol lacks possession binding → group-secret extraction), 2 HIGH (forged-complaint ceremony DoS; poisoned-backup restore under a foreign group key), 3 MED, 3 LOW |
| Adversarial review of v0.4.0 | FIXES-2026-08-18 | 1 HIGH — delimiter-joined hashing aliasing (two distinct verdicts → identical FROST-signed message) → `CanonicalWriter` length-prefixed hashing |
| V12 audit (35 actionable) | v0.5.3, PR #5 / FIXES-2026-08-21 | 35, all implemented (deep-frozen states, ledger validation barriers, transport re-verification, verdict re-binding); 3 shipped as documented divergences with rationale |
| Security round 1 — validator/finality | v0.8.2, PR #36 | 3 — 1 HIGH (v2 scope pins declared but never enforced), 1 MED (dispatcher silently drops v2 policy on v1-shaped events), 1 LOW (unbounded v2 field lengths) |
| Security round 1 — machine fuzz | v0.8.3, PR #37 | 5 fixed (lone-surrogate canonicalization bypass — two distinct outcomes hashed identically; state-shape tampering; signing-binding re-derivation; freeze discipline; unknown-event typed errors) + 2 reported-not-fixed (owner decisions) |
| Security round 2 — cross-module | v0.8.5, PR #41 | 3 fixed (batch-Merkle-root pin absent; restored ledgers not re-verified; docstring trust-boundary hardening) + 1 documented-by-design (verdictHash dedup duty) |
| Security round 3 — property sweep | v0.9.1, PRs #44–46 | 6 (r3-1…r3-6: typed fail-closed restores, raw-TypeError escapes, the mid-ladder dead end, hashSignerSetRoot typing) |
| Formal audit | v0.9.2, PRs #47/#48 | 12 findings (F-1…F-12); 3 substantive fixed in v0.9.2 (F-12 clock ledgers, F-2 empty-pin fail-closed, F-3 outcome-history barrier) |
| Crypto-literature audit | v0.9.3, PR #49 | 12 mechanisms reviewed — 3 MED shipped (reveal-set==commitment-set guard; DKG PoK canonical challenge; dispute-key fixed-width contract), 4 spec'd (S-1…S-4), 5 verified-OK, `@vbyte/frost` pin verdict KEEP |
| Adversarial Nostr | v0.9.4, PR #51 | 3 real bugs (uncertified outcome-tag read steering resolution; ingest dedup without NIP-01 id verification; enumerable verifyEvent cache carried by spread) |
| **Review round 3 — the fixes attacked** | v0.12.1, PR #95 | **1 EXPLOITABLE** (r29-1: the escalation bond was bound to the *case*, so a juror with no bond could escalate on another's accepted hash and the audit log named the wrong challenger), 1 EXPLOITABLE-at-host (r29-7: cap on a client-declared number), 3 PARTIAL (2 fixed — r29-2 escalation-log barrier, r29-10 vacuous budget; 1 registered), rest BLOCKED with guards cited; 8 residuals registered |
| **Round-30 transport + ceremony** | v0.12.1, PR #98 | 1 operational brick (**T-1**: a wrap delivered by 65+ relays made the *whole* durable inbox unrestorable — no key needed), seal-layer and MLS attacks each pinned to the layer that catches them, inbox/outbox load under a 10k-event flood, and 4 multi-process ceremony scenarios (kill mid-DKG, kill mid-signing, cross-round replay) |
| **Round-31 economic re-verify + per-round bond** | v0.13.0, PR #99/#100 | 5 economic attacks: **r30-1 MAJOR** (the bond was a *membership* test, so escalation was a free option worth 363 $b_0$) → fixed in the reducer; **r30-2 MAJOR** (frozen ladder is a ceiling; churn 135→45 is 2.47× short) → closed host-side; **r30-3 SAFE** (the brief's premise was wrong — a weaker quorum *tightens* the cap); r30-4 (idle decay's ramp dominates the cliff it replaced); r30-5 SAFE on the label |
| **Review round 5 — the round-4 closures attacked** | v0.13.1, PR #107 | **1 EXPLOITABLE** (r38-1: the challenge pool had **no uniqueness**, so one paid bond bought N challengers' standing — a two-step r29-1 bypass), 2 PARTIAL (r38-2 `requireRoundBond` × `hostEscalation` prices nothing; r38-3 pubkey unverifiable → v0.14), 1 host (r38-4: the host vendored the pre-fix `ladderEconomics.ts`); 3 closures red on v0.13.1 |
| **Review round 6 — the entries that spend a rung** | v0.13.2, PR #109/#110 | **2 EXPLOITABLE** (r40-1: `escalate` re-derived the log but not the challenge pool it reads; r40-2: a restored `ladder_pending` with its record deleted opened the rung), 1 PARTIAL in-package (r40-3: the hash is unique but not **owned** — a derivable witness is preemptable), 2 PARTIAL host (r40-4 the composed predicate disagreed with the sign rule; r40-5 the boot backfill bypassed the creation gate); **490-state legal-state hunt: 0 refusals** |
| **Review round 7 — the value-locking entry's other ledger** | v0.14.0, PR #112/#114 | **1 EXPLOITABLE** (r41-1: `finalize` minted a canonical verdict from a vote ledger it never re-derived — `concede` was the route in, and `upheld` was caller-supplied and absent from the hash preimage; the reachable harm is settling the losing side of a case, or `FINAL outcome=MAYBE` on a case no ballot could answer), 1 doc defect (r41-T1-doc: the `a_f` monotonicity sentence pointed the wrong way), 6 host findings (H-1 ρ/β ≠ the enforced cap, H-2 `a_f = 1`, H-3/H-4/H-5 the clamp's readers, metric and permanence, H-6 the escalate body cannot carry the witness); **4 closures red on the pre-fix head, 40/40 legal flows finalize unchanged** |
| **Review round 8 — the transport, and the barrier from outside** | v0.14.1, PR #115/#116 | **2 EXPLOITABLE** (r8-1: `caseId` was encoded lossily — an unpaired surrogate and U+FFFD are two ids and **one request hash**; r8-2: the transport **bound nothing** — an unverified `challengerPubkey` wrote a non-escalator into the append-only log, a stale wire `round` opened an unauthorised rung, a `caseId` crossed cases), **4 PARTIAL fixed** (r8-3 `concession` coerced to false, r8-4 duplicate JSON keys silently resolved, r8-5 `build` validated A and returned B, r8-6 `resolve_round` bricked a case on a history that outran the ladder), the finality barrier **BLOCKED on all four paths to `finalize`**; **13 of 34 red on v0.14.0** |

Condensed: **≈50 findings across the committed adversarial record, ten at the
top of this document's own severity scale** — 1 CRITICAL and 4 HIGH from the
pre-mainnet rounds, plus **ten named `EXPLOITABLE` closures** from the re-attack
rounds (r29-1, r33-1, r33-5, r33-6, r38-1, r40-1, r40-2, r41-1, r8-1, r8-2) —
every one fixed with a regression test or dispositioned in the
Gap register; none silently dropped. That the last top-severity entries sit
in code written *after* the previous audit is the section's own thesis
(§3.2) continuing to hold — and it now holds across six consecutive review
rounds, each of which attacked the fixes the round before shipped.

**Finding-class distribution** (each class names its representative committed
findings):

| Class | Share | Representative findings |
|---|---|---|
| Trust-boundary pinning | largest | v0.8.2 F3/F1 (un-enforced scope pins, policy downgrade); v0.8.5 batch-root pin; F-2 empty-pin; the R2 unpinned-key class (THREAT_MODEL §5 P1–P12) |
| Identifier canonicalisation | large, and the class that keeps returning | FIXES-08-18 delimiter aliasing; lone-surrogate hash collision (PR #37); **H-6** (the round-bond witness omitted from the request hash, so two bonds hashed alike); **r8-1** (`caseId` through a lossy `TextEncoder`, so two cases hashed alike); state-shape tampering; r3-2/r3-3 raw-TypeError escapes; PR #51 ingest-dedup and spread-cache bugs. The rule this class taught: canonicalise **per field**, with an injectivity pin per field (paper §11.6) |
| Attribution / identity | large | r29-1 (the log named a juror who never escalated); r38-1/r40-1 (the payer of a rung logged as the wrong actor, or the rung bought with a borrowed bond); r40-3 (preemption of a derivable witness); **r8-2** (the transport forwarded an unverified `challengerPubkey` into the append-only log); r29-5/r38-3 (`challengerPubkey` caller-supplied, no idx→pubkey map) |
| Availability / DoS | medium | forged-complaint ceremony DoS (FIXES-08-15 #2); cross-index eventId wedge (PR #37); r3-6 mid-ladder dead end; T-1 (a 65-relay delivery bricked the durable inbox); r40-2/r8-6 (a restored snapshot bricked a case with value locked); host F6 ack-reconcile starvation at scale (PR #2295) |
| Races / replay / concurrency | medium | Drijvers concurrent-session hardening (CRYPTO_AUDIT §1.1); nonce-equivocation aborts; F-12 monotonic clock ledger; the escalation replay window (a request signed for round 1 applied at round 3, r8-2b); host quorumMet deadline-pin clobber (soak F3, PR #2293) |
| Economic | medium | round-10 mechanism audit: ack farming (composite SLA), redelivery griefing (1+1, ×0.8), cross-network epoch replay, dust starvation, weight gaming (host repo, THREAT_MODEL §4.4/§4.6); r30-1 (membership vs consumption) and H-1 (a constant-β gate drifting three rungs) |

### 3.2 The finding-per-LOC-of-new-code observation

The audit record doubles as a code-maturity measurement: **every top-severity
finding attached to code that was new at the time of the audit** — the
v0.2.0-era complaint/restore paths (1 CRITICAL + 2 HIGH), the v0.4.0-era
hand-rolled hashing (1 HIGH), and the v0.8.x-era v2 validator paths (1 HIGH,
in code new in v0.8.1). **No top-severity finding ever attached to the
stabilized v0.7.x core** (the settlement-rail math and the machines as they
stood after v0.7.2) in any subsequent round — later rounds' findings against
that core were MED/LOW refinements (typed errors, restore barriers,
memoization hazards). For the pre-mainnet claim this validates: risk
concentrates in fresh code, the audit program was run *before* mainnet, and
the finding rate on the mature core decayed to the MED/LOW tail across
roughly eight consecutive adversarial rounds.

The pattern recurred in review rounds 7–8, and it is worth stating as a
prediction rather than a post-hoc note: all three of those rounds' new
exploitables attach to code **less than two rounds old** — r41-1 to the
round-5-era `finalize`, r8-1 and r8-2 to the v0.14.0 transport — while the same
rounds' attacks on the settled core (the sign-rule arithmetic, the ladder
witness, the four paths to `final`) came back `BLOCKED` with the guard cited by
file and line. Fresh code is where the risk is; the audit rate on the mature
core is the tail.

### 3.3 Host-API penetration test

**Artifact:** bao.markets PR **#2287** (33-test repro suite,
`packages/api/src/routes/__tests__/courtPentest.test.ts`, driving genuinely
signed kind-27235 events — real secp256k1, no auth mocking — through
`app.inject`).

- **Vulnerability found and fixed:** the **NIP-98 signed query string was not
  bound** — the middleware compared only the URL path, so a captured ticket
  signed for `GET /v1/court/summons-board?case_id=X` could be replayed at the
  same path with `case_id=Y` for the full 5-minute validity window. Fix:
  fail-closed query binding (decoded pairs, order/encoding-insensitive) when
  the signed `u` tag carries a query; path-only signatures keep legacy
  behaviour. Backward compatible.
- **Hardening verified in-suite (no change needed):** cross-juror ack (403),
  admin scope (server-configured pubkeys only), injection surface (every
  user-controlled param reaches pg as a bound `$n` parameter; length caps
  reject 10 KB params), capabilities drift (public-read-only dispute routes,
  non-custodial summons/ops endpoints).
- **Accepted-risk register** (documented in-suite with rationale): 5-min
  replay window across replicas/after restart (in-memory replay cache);
  ±300 s timestamp skew; summons-board any-authed visibility (data mirrors
  already-public relay events); 404/403 existence oracle for authed callers;
  uncacheable public dispute-stats (rate-limited, D2 asserts 429);
  unpaginated per-market disputes feed (bounded by one market's history).

### 3.4 Adversarial suites as permanent regression value

Every audit round left its repro behind as an always-on suite — the audits
never "expire":

| Suite | Tests | Origin |
|---|---|---|
| `__tests__/adversarialMachines.test.ts` | 88 | PR #37 (the round-1 machine-fuzz round added 404 adversarial tests; the v0.10.x suite reorganization consolidated them) |
| `__tests__/attestationValidator.adversarial.test.ts` | 33 | PR #36 (30-case repro) + r3 additions |
| `__tests__/courtRelayAdversary.test.ts` | 80 | hostile-relay vectors (paper §10.2-M), PR #51 era |
| `__tests__/adversarialCrossModule.test.ts` | 24 | PR #41 |
| `__tests__/adversarialNostr.test.ts` + `adversarialParserFuzz.test.ts` | 20 + fuzz | PR #51 / round-1 fuzz |
| `__tests__/cryptoLiteratureAudit.test.ts` | literature pins (AUDIT-1…AUDIT-5+) | PR #49, extended PR #63 |
| `__tests__/reviewRound3.test.ts` | 15 | PR #95 — the attacks that found r29-1/r29-2/r29-10 (4 failed before the fix) |
| `__tests__/perRoundBond.test.ts` + `ladderEconomics.test.ts` + `penaltyAging.test.ts` | 12 + 12 + 13 | PR #100 — the consumption matrix, the derived cap/flip round, decay pairing |
| `__tests__/r30{SealGames,MarmotTransport,InboxOutboxLoad}.test.ts` | 38 | PR #98 — transport layering, MLS contract, inbox/outbox load and provenance bounds |
| `__tests__/r30MultiProcessCeremony.test.ts` | 4 scenarios | PR #98 — happy path + 2 kill points + replay, gated in CI |

Any future change that reopens a closed finding fails a named test — the
round-14 cross-check (PR #63/#64) additionally makes the *documentation* of
those pins machine-verified (`node scripts/cross-check.mjs`, 516 refs, 0
dangling).

---

## 4. Performance

**Artifact:** `docs/benchmarks/BASELINE.md` (PRs **#50** baseline, **#54**
optimization round) — regenerable via `npm run bench` (`--json` machine
twin); methodology: `process.hrtime.bigint`, 3 warmups, 9 samples,
median/p95/**min**, reproducibility pair agreement 27/29 within ±20%
(median pair deviation 5.8%).

### 4.1 The optimization round (v0.10.0) — measured, byte-output-identical

| Benchmark | Params | before → after (median) | Speedup |
|---|---|---|---|
| `buildBatchMerkleProofs` (full 10k-leaf proof set) | 10,000 leaves | ~32 s (extrapolated; >60 s measured) → **~71 ms** | **~450×** |
| `reduceCourtSigningMachine` | 10k transitions, roster=threshold=21 | 3,340 µs → 110 µs | **30×** |
| `canonicalWriter.encodeHash` | 1,000 field groups | 6.46 ms → 1.48 ms | **4.4×** |
| `selectJury` | roster=10,000 | 88.5 ms → 32.5 ms | **2.7×** |
| validators / tree build / per-case verify | — | ≈unchanged | ~1× (the ~1.3 ms Schnorr-verify floor dominates) |

No byte output changed anywhere — the differential-parity suite (§2.2) passed
**unchanged** as the ship gate.

**Refused optimizations — recorded with the numbers that refused them**
(BASELINE.md "Round-9 findings"):

- *Heap-based O(n log k) top-k selection:* 27× on the ranking step alone
  (4.0 ms → 0.148 ms, measured, parity-confirmed) but only **1.12×
  end-to-end** (sha256 draws dominate) — below the ≥2× ship bar; refused.
- *CanonicalWriter buffer pooling:* the pre-sized per-instance buffer already
  captures the win; cross-call pooling adds shared mutable state to a
  security-critical encoder for no measured benefit — refused.
- *State-hash-keyed memoization of signing invariants:* captures ~5% beyond
  the point memo and risks masking the restored-snapshot corruption class the
  check exists to catch — specified, not shipped.

### 4.2 The soak — one day at 10,000 settlements/day

**Artifact:** bao.markets PRs **#2293** (R9 soak:
`scripts/soak/court-soak.mts` + README, hermetic, virtual-clock) and
**#2295** (R10 cursor fix + re-measure). Full pipeline — propose → confirm
(5-juror panels) → 5% challenges → ladder rounds → hourly batch attestations
→ summons acks/redeliveries → deadline sweeps → retention — on **unmodified
real services** over an in-memory pg engine, virtual clock (1300×
compression, **2m52s wall**).

| Assertion | Result |
|---|---|
| Lost deadlines | **zero** — 20,668 scheduled, every one fired exactly once (1,860 sweep passes, 0 handler failures) |
| Ledger parity | **sat-exact** vs an independent oracle |
| Double-publishes | zero (134,997 unique relay events = 13.5/settlement, matching the R1b event model ≈13) |
| Batch attestations | 48 hourly batches / 10,000 verdicts / 134 Merkle spot-proofs OK |
| Ack-record latency | p99 **20.6 min → 1.98 min** after the F6 cursor fix (5× headroom vs the 10-min SLA) |
| Spurious redeliveries | **96.6% → 0.00%** (52,330/54,193 → 0/1,863) after the persisted reconcile cursor + tier-1 targeted re-check |
| Relay re-serves | 410k → 154k per day |
| Memory | peak heap **388 MB, no drift** |
| Wall time | 2m52s at 1300× compression (budget < 10 min) |
| Assertion battery | 17/17 (R9) → **20/20 pass** (R10 final) |

The soak *found* F6 (the ack-reconcile starvation: limit-500 oldest-first
over a 30-min lookback records acks ~18 min late — past the 10-min SLA) and
F1/F3/F5 (clock injection, deadline-pin clobber, coordinator CPU ceiling)
— it was an evaluation instrument that paid for itself, and the fix
(PR #2295) re-measured the before-state in the same harness (`--f6-stateless`)
so the before/after table is one artifact, not two methodologies.

### 4.3 The three-day soak — 30,000 settlements, deterministic faults (R11)

**Artifact:** bao.markets PR **#2414** (`scripts/soak/court-soak.mts
--days 3 --faults`; committed `docs/benchmarks/soak-3day.json` +
`SOAK_3DAY.md`). Three virtual days at the spec's 10,000 settlements/day plus a
38 h drain (110 virtual hours) in **5.7 minutes of wall clock** (1149.5×
compression, budget 20 min): **32/32 assertions pass** — the 19 pre-existing
invariants now measured *across* epoch boundaries rather than within one day,
plus 13 new ones for rotation, retention, faults and the bonded-witness path.

| Assertion | Result |
|---|---|
| Settlements / batches | 30,000 / 11 + 24 + 62 hourly batches (3 epoch boundaries) |
| Lost deadlines · double-publishes · re-applications | **zero · zero · zero** |
| Ledger parity | **sat-exact per day and cumulative** (150,180,128 sats == oracle, 60,067 entries) |
| Epoch rotation | cases book into their *proposal day's* epoch, so rotation never strands in-flight work (10,535 cases finalized after the next day opened); the other era's pin rejects every batch (negative control 97/97) |
| Retention | exact at **every** day boundary vs a fresh JS oracle (3/3); after 3 days the live set is O(window), not O(history) |
| `§9.2` witness path at volume | 1,627 requests → 1,393 machine feeds, **0 duplicate feeds**, ≤ 2 escalations/case, one alert per escalated summons |
| Injected faults (seeded) | relay partitions holding writes then delivering late/out-of-order; 10 % mid-day juror churn; coordinator restarts with volatile state dropped; 100 adversarial witness-storm events/day (replay, wrong round, stale, malformed, case mismatch, forged bond); PITR-style ack-cursor rollback of −2 h |
| Unaccounted acks | **zero** (after SOAK-F7's lagged watermark) |
| Wall / heap | 344.5 s; peak heap 962 MB |

**The soak found three real defects, one of them about itself** — the most
important evaluation result in this chapter, because it is the instrument
refusing to stay green:

| # | Finding | Status |
|---|---|---|
| **SOAK-F8** | The R9/R10 soak was **red on `main`**: the reference ladder handler emitted an unwitnessed `escalate`, which vendored v0.12.0 refuses. Measured on unmodified `main`: 11/17 assertions, **289 stuck cases, 48,089 handler retries**, confirm p99 6.53 h. Nothing re-ran the soak on protocol changes. | fixed — the soak now drives the real §9.2 path |
| **SOAK-F7** | The 300 s reconcile overlap is a re-*serve* window, not a delivery-delay bound: a partition longer than the overlap walked the persisted cursor **past** unserved acks — **8 of 184,620 acks silently lost** (0.004 %), 510 more saved only by a targeted re-check. | fixed — the cursor lags one overlap behind `now` |
| **SOAK-F11** | `court_summons` is unique on `(case, juror, kind)`, so a ladder rung re-drawing an already-served juror inserts nothing: that juror's ack binds to no row, participation never records, the board shows the summons as never sent — **no error, no alert**. | fixed — fresh-draw tracking + `ack_no_silent_loss` |

Scope is the same as §4.2's and stated in the artifact: in-memory Postgres and a
virtual clock, so this measures logic, ordering, retention and event volume at
3× the horizon — not real-Postgres serialization, fsync latency or relay RTTs.

---

## 5. Threat-model coverage

**Artifact:** `docs/THREAT_MODEL.md` (**PR #62**) + `docs/CROSS_CHECK.md`
(**PRs #63/#64**).

| Dimension | Count | Artifact |
|---|---|---|
| Assets (parametric damage in V, B, S, F) | **6** (verdict integrity, settlement steering, key shares, reputation, liveness, fee/slashing correctness) | THREAT_MODEL §3 |
| Formalized adversaries | **9** (relay, juror <t, juror ≥t, coordinator, proposer, economic ×2 sub-species, LLM advisor, key compromise, network eclipse) | THREAT_MODEL §2 |
| Proof obligations (honest-gap register) | **18** (PO-1…PO-18, each with stage-acceptability + closure path) | THREAT_MODEL §6 |
| MUST-pin trust boundaries | 12 (P1–P12, each unpinned consequence reproduced by a named adversarial test) | THREAT_MODEL §5 |
| Claims indexed | **285** across the four claim sources (158 invariants included) | CROSS_CHECK §2 |
| **Claim coverage** | **95.1%** (271/285) covered by executable evidence; **14 open obligations** (every one registered with a planned proof), in a gap register of **18 entries** (14 open, 4 closed) — both numbers printed by `node scripts/cross-check.mjs` | CROSS_CHECK §2 + Gap register |

The 95.1% number is itself machine-checked: `node scripts/cross-check.mjs`
parses the index, verifies all **516** evidence refs resolve against the tree
today, prints the open/closed split of the gap register, and exits non-zero on
a dangling pointer — the coverage claim cannot drift silently.

---

## 6. Threats to validity

What these numbers do **not** prove — stated with the same care as the
results:

1. **Model-checking bounds are small.** Explored rosters are n ≤ 4 (vote n=4
   is the largest instance at 1.27M states) with reduced clock universes,
   because the state space grows combinatorially; the production selection
   benchmark and host config use rosters up to n=201. The model-checked
   properties are checked on the machines' **own reducer code paths** (not a
   model of them), which is why small-n results transfer at all — but
   combinatorial behaviours that only manifest at large n (e.g. tally tie
   structures over dozens of outcomes) are covered by property sweeps and
   the n=1..300 batch property suite, not by exhaustive exploration.
2. **The soak runs against a fake pg engine and a virtual clock.** The 10k/day
   soak (PRs #2293/#2295) injects an in-memory pg engine via a module-resolve
   hook and patches `Date` globally. Real-Postgres serialization, connection
   pool exhaustion, fsync latencies, and real relay RTTs are **not** covered;
   the numbers validate the *logic* (ledger parity, deadline accounting,
   cursor drain) and the event-volume model, not production DB performance.
   The clock compression (1300×) is legitimate for event-ordering logic but
   says nothing about wall-clock I/O behaviour.
3. **Differential parity is single-implementation.** The five reference
   modules are independent *reimplementations by the same team* — they pin
   the spec against mis-implementation and refactoring, but a spec
   misreading shared by author and re-implementer survives. The
   cross-implementation FROST differential (second independent FROST
   codebase) remains an open production gate (PAPER-12-5, Gap register).
4. **Benchmark host variance is real and was caught once.** The reference
   host is a shared 16-thread laptop-class box; a third baseline run taken
   under load ≥ 20 deviated by up to ×18 and was **excluded as an
   environment artifact** (the load-20 exclusion, BASELINE.md
   "Reproducibility & caveats") — an honest demonstration that µs-scale
   numbers from a loaded shared host are not reproducible, and why `min` is
   reported as the noise-floor estimator and pair-run deltas are published
   alongside every headline. CI budgets must baseline on a quiet box
   (load < 2) before wiring alerts (BASELINE.md §Track-B note).
5. **"0 raw throws" is scoped to the explored space.** The typed-error
   discipline result (195M typed throws, 0 raw) covers the enumerated state
   spaces of three machines — parser-level hostility is covered
   separately (fuzz + validator property suites), and host-side code is
   outside this package entirely.
6. **Economic claims are implemented and re-derived, not equilibrium-proven.**
   The majority-collusion bribe game (PO-1), selection-seed grindability cost
   model (PO-2), and SLA-farming bounds are analyzed and mechanism-pinned,
   not modeled game-theoretically; THREAT_MODEL §7 marks the economic layer
   as the argument's honest center of gravity. Round 31 improved one row of
   this (the ladder is now a consumption test with a derived cap, §4.2 of the
   paper) and *found that the row above it had been wrong in our favour* —
   which is exactly the class of error an in-house model cannot be trusted to
   catch reliably.
7. **The re-attack rounds are self-review, and the instruments are in-house
   too.** Review rounds 2–8 found **six** of this artifact's own
   defects (§3.1) — the latest being a finality forgery the round-6 entry matrix
   had *stated* was safe, and a wire encoding that gave two cases one digest —
   but
   the attacker and the author are the same people, working from the same
   threat model: a specification-level misreading shared by both survives, as
   it does in §6.3. Three concrete demonstrations that this is not a formality:
   the model checker's escalation-bond property had **mirrored** the weak
   predicate it was supposed to check (r29-1), the soak was silently **red
   on `main`** for two protocol rounds (SOAK-F8), and a canonicalisation class
   was fixed three times in three different fields (paper §11.6) — each fix
   correct, each one field short of the rule. All three were found by
   *attacking*, not by restating — and all are why no row here is labelled
   independently verified.
8. **The multi-process ceremony is localhost.** N = 3…7 real OS processes, real
   PIDs/identities/state dirs, signed events and relay-assigned ordering — on
   one kernel and one clock, with an honest, always-available relay and no
   packet loss, partitions, clock skew or custody (paper §11.7; PO-14 open).
   It closes the *coordination* question, not the *distribution* one.
9. **Evaluation numbers age.** Suite counts (1,656 at `c456fb4`, 1,677 at the
   review-round-4 head, 1,758 at the review-round-7 head `4cd97f1`, **1,804 at
   `bc28ff3` / v0.14.1**), coverage
   (95.1%), the model-check totals and the bench medians are per-round records
   tied to a commit. The cross-check script's exit-0 gate is the mechanism that
   makes stale numbers *visible*; `docs/REPRODUCIBILITY.md` specifies how a
   reviewer regenerates every number on this page from one command — and
   SOAK-F8 is what happens when a harness is allowed to age unobserved.

---

## 7. Evidence index

| Section | Artifact | PR |
|---|---|---|
| §2.1 model-check totals + per-instance | `__fixtures__/model-check-summary.json`, `scripts/model-check.mjs` | #53, #63/#64 (fixture), #58 (MC-F7 repair), #96 (witness-aware) |
| §2.2 differential parity | `__tests__/differentialParity.test.ts`, `__tests__/reference/*` | #52 |
| §2.3 property suites | `__tests__/properties{Confirmation,Batch,Validator}.test.ts` | #44, #45, #46 |
| §2.4 formal invariants | `docs/FORMAL_INVARIANTS.md` | #47, #48, #95 (INV-ESC-8), #100 (INV-ESC-9) |
| §2.5 statistical corpora | `docs/benchmarks/SCALE_CAMPAIGN.md`, `docs/benchmarks/campaign-2026-11-11.json`, `scripts/campaign/run-campaign.mjs` | #96 |
| §3.1 audit record | `docs/FIXES-2026-08-{15,18,21}.md`, `docs/REVIEW_ROUND_3.md` … `docs/REVIEW_ROUND_8.md` | #36, #37, #41, #49, #51, #95, #98, #99/#100, #107, #109/#110, #112/#114, #115/#116 |
| §3.3 API pentest | `packages/api/src/routes/__tests__/courtPentest.test.ts` (host repo) | bao.markets #2287 |
| §4.1 benchmarks + optimization | `docs/benchmarks/BASELINE.md`, `bench/court.bench.mjs` | #50, #54 |
| §4.2 soak (one day) | `scripts/soak/court-soak.mts` + README (host repo) | bao.markets #2293, #2295 |
| §4.3 soak (three days, faults) | `scripts/soak/court-soak.mts --days 3 --faults`, `docs/benchmarks/soak-3day.json` + `SOAK_3DAY.md` (host repo) | bao.markets #2414 |
| §5 threat model + coverage | `docs/THREAT_MODEL.md`, `docs/CROSS_CHECK.md`, `scripts/cross-check.mjs` | #62, #63, #64 |
| §6 validity methodology | `__tests__/modelCheckingCore.ts` header, BASELINE.md caveats, `docs/MULTI_PROCESS_CEREMONY.md` | #53, #50, #98 |

Every pointer above resolves on `main`; the doc-level check is
`node scripts/cross-check.mjs` (exit 0) plus the one-command regeneration
contract in **docs/REPRODUCIBILITY.md**.
