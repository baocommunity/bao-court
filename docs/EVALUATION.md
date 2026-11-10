# BAO Court — Evaluation

**Version:** tracks `@bao/court` v0.10.2 · **Date:** 2026-11-10 · **Round:** 15
(symposium evaluation chapter)

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
follow-up. The evaluation evidence therefore has four layers: **exhaustive
model checking** of the ceremony machines (§2.1), **differential parity**
against independent reimplementations (§2.2), **property-based sweeps** and a
**formal-invariants audit** (§2.3–2.4), and a decade-compressed **adversarial
audit record** plus a host-API pentest (§3). Performance is measured, never
assumed, including the optimizations that were *refused* with numbers (§4).
The threat-model chapter closes the loop: 272 indexed claims, 94.9%→95.2%
with executable proof (§5). What the numbers do **not** prove is stated in
§6 — reviewers should read it.

**Recorded verification state at v0.10.2 `main` (2026-11-10, PR #64):** full
suite **1,491 passed / 1 skipped (61 files)**; `npm run typecheck` +
`typecheck:tests` clean; `node scripts/cross-check.mjs` verifies all 493
evidence pointers, exit 0.

---

## 2. Correctness at scale

### 2.1 Exhaustive model checking of the ceremony machines

**Artifact:** `__fixtures__/model-check-summary.json` (committed), regenerated
by `npx tsx scripts/model-check.mjs` · **PRs #53** (v0.9.4), fixture refreshed
**PR #63/#64** (full-mode regeneration, 17 min) · methodology and abstraction
limits: the header of `__tests__/modelCheckingCore.ts`; properties P1–P5 +
typed-error discipline described in paper §11.2.

Every reachable state × every event application of the three ceremony phase
machines (vote, confirmation/ladder, signing), asserting at every step: phase
legality, the data-invariant set (real SHA-256 commit–reveal and
session-hash re-derivation, real secp256k1 nonce points, signer-set freeze,
deep-frozen states, monotonic clock on **every edge**), the no-dead-ends
biconditional, acyclicity of the progress graph (Kahn), and ≥200 replayed
determinism paths per instance.

| Metric (13 instances, full sweep) | Value |
|---|---|
| Concrete states explored | **3,145,632** |
| Event applications | **128,522,740** |
| Typed throws (illegal-event discipline exercised) | 112,076,252 |
| Illegal-event checks | 68,077,138 |
| **Raw throws (`TypeError`/`RangeError`)** | **0** |
| Progress edges / idempotent self-loops | 11,716,954 / 4,729,534 |
| Determinism paths replayed | 2,600 — all byte-identical |

*Artifact:* `__fixtures__/model-check-summary.json#totals` (PR #63/#64).

Per-instance (the committed fixture; every row carries `rawThrows: 0` and 200
determinism replays):

| Instance | States | Applications | Terminal states |
|---|---|---|---|
| vote n=1 k=2 | 334 | 15,224 | 152 |
| vote n=2 k=2 | 2,650 | 117,289 | 1,424 |
| vote n=3 k=2 | 42,646 | 1,843,302 | 25,544 |
| vote n=4 k=2 | 1,268,770 | 54,752,135 | 794,624 |
| vote n=2 k=3 | 5,482 | 246,757 | 2,984 |
| confirm n=3 q=3 r=1 challengers=all | 362,046 | 14,231,718 | 234,078 |
| confirm n=3 q=1 r=1 dup-event-ids | 1,010,820 | 41,952,186 | 668,382 |
| confirm n=3 q=1 r=2 | 108,405 | 4,136,817 | 65,499 |
| confirm n=3 q=1 r=1 roundRoster | 61,455 | 2,431,062 | 39,669 |
| signing n=2 t=1 | 2,532 | 78,588 | 2,232 |
| **signing n=3 t=2** | **19,822** | 617,139 | 17,552 |
| signing n=3 t=2 commitment-equivocation | 143,764 | 4,464,858 | 127,844 |
| signing n=3 t=2 partial-equivocation | 116,906 | 3,635,665 | 106,416 |

*Artifact:* `__fixtures__/model-check-summary.json#instances` (PR #53, fixture
regenerated in PR #63; the partial-equivocation instance's state space was
**repaired from a vacuous 19,822 to 116,906** by PR #58 after finding that
its fabricated conflict-psigs collapsed onto the base instance — recorded as
finding F7: *a variant instance whose state space equals its base's is not
exercising what it claims*).

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

**145 invariants** (`INV-<machine>-<n>`), each extracted from the
*actual guards* in source — an audit by another name — each carrying an
enforcement pointer (`file:line`) and the pinning test. Precision note
(round-16 external review, finding A-3): the family is *predominantly*
first-order and machine-checked; INV-CORE-1…8 are the language definitions
the invariant family is stated over, INV-SEL-3 is statistical by nature
(pinned by a paired-derivation statistical differential), and INV-VOTE-14
is pinned as defense-in-depth only (F-10). The
invariant↔guard↔test traceability matrix (§12 of that doc) is machine-checked
via docs/CROSS_CHECK.md: **144/145 (99.3%) carry executable proof** (the one
open entry, INV-VOTE-14, is a defense-in-depth capacity guard, FINDING-F-10).
The audit produced 12 findings (F-1…F-12); the substantive F-12 (signing/DKG
machines lacked a monotonic clock ledger — old-timestamped replays were
admissible) shipped in v0.9.2 and is now checked on **every edge of the
model-checked state space**.

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

Condensed: **≈30 findings across the committed adversarial record, five of
them top-severity** (1 CRITICAL + 4 HIGH), every one fixed with a regression
test or dispositioned in the Gap register — none silently dropped.

**Finding-class distribution** (each class names its representative committed
findings):

| Class | Share | Representative findings |
|---|---|---|
| Trust-boundary pinning | largest | v0.8.2 F3/F1 (un-enforced scope pins, policy downgrade); v0.8.5 batch-root pin; F-2 empty-pin; the R2 unpinned-key class (THREAT_MODEL §5 P1–P12) |
| Parsing / canonicalization | large | FIXES-08-18 delimiter aliasing; lone-surrogate hash collision (PR #37); state-shape tampering; r3-2/r3-3 raw-TypeError escapes; PR #51 ingest-dedup and spread-cache bugs |
| Availability / DoS | medium | forged-complaint ceremony DoS (FIXES-08-15 #2); cross-index eventId wedge (PR #37); r3-6 mid-ladder dead end; host F6 ack-reconcile starvation at scale (PR #2295) |
| Races / replay / concurrency | medium | Drijvers concurrent-session hardening (CRYPTO_AUDIT §1.1); nonce-equivocation aborts; F-12 monotonic clock ledger; host quorumMet deadline-pin clobber (soak F3, PR #2293) |
| Economic | medium | round-10 mechanism audit: ack farming (composite SLA), redelivery griefing (1+1, ×0.8), cross-network epoch replay, dust starvation, weight gaming (host repo, THREAT_MODEL §4.4/§4.6) |

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

Any future change that reopens a closed finding fails a named test — the
round-14 cross-check (PR #63/#64) additionally makes the *documentation* of
those pins machine-verified (`node scripts/cross-check.mjs`, 493 refs, 0
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

---

## 5. Threat-model coverage

**Artifact:** `docs/THREAT_MODEL.md` (**PR #62**) + `docs/CROSS_CHECK.md`
(**PRs #63/#64**).

| Dimension | Count | Artifact |
|---|---|---|
| Assets (parametric damage in V, B, S, F) | **6** (verdict integrity, settlement steering, key shares, reputation, liveness, fee/slashing correctness) | THREAT_MODEL §3 |
| Formalized adversaries | **9** (relay, juror <t, juror ≥t, coordinator, proposer, economic ×2 sub-species, LLM advisor, key compromise, network eclipse) | THREAT_MODEL §2 |
| Proof obligations (honest-gap register) | **14** (PO-1…PO-14, each with stage-acceptability + closure path) | THREAT_MODEL §6 |
| MUST-pin trust boundaries | 12 (P1–P12, each unpinned consequence reproduced by a named adversarial test) | THREAT_MODEL §5 |
| Claims indexed | **272** across the four claim sources | CROSS_CHECK §2 |
| **Claim coverage** | **94.9%** with executable proof at PR #63 (258/272), refreshed to **95.2%** (259/272) in PR #64 after four in-round gap closures; **13 open gaps** each registered with a planned proof | CROSS_CHECK §2 + Gap register |

The 94.9% number is itself machine-checked: `node scripts/cross-check.mjs`
parses the index, verifies all 492 evidence refs resolve against the tree
today, and exits non-zero on a dangling pointer — the coverage claim cannot
drift silently.

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
   discipline result (112M typed throws, 0 raw) covers the enumerated state
   spaces of three machines — parser-level hostility is covered
   separately (fuzz + validator property suites), and host-side code is
   outside this package entirely.
6. **Economic claims are implemented, not equilibrium-proven.** The
   majority-collusion bribe game (PO-1), selection-seed grindability cost
   model (PO-2), and SLA-farming bounds are analyzed and mechanism-pinned,
   not modeled game-theoretically; THREAT_MODEL §7 marks the economic layer
   as the argument's honest center of gravity.
7. **Evaluation numbers age.** Suite counts (1,491), coverage (95.2%), and
   bench medians are per-round records tied to a commit (v0.10.2,
   2026-11-10). The cross-check script's exit-0 gate is the mechanism that
   makes stale numbers *visible*; docs/REPRODUCIBILITY.md specifies how a
   reviewer regenerates every number on this page from one command.

---

## 7. Evidence index

| Section | Artifact | PR |
|---|---|---|
| §2.1 model-check totals + per-instance | `__fixtures__/model-check-summary.json`, `scripts/model-check.mjs` | #53, #63/#64 (fixture), #58 (F7 repair) |
| §2.2 differential parity | `__tests__/differentialParity.test.ts`, `__tests__/reference/*` | #52 |
| §2.3 property suites | `__tests__/properties{Confirmation,Batch,Validator}.test.ts` | #44, #45, #46 |
| §2.4 formal invariants | `docs/FORMAL_INVARIANTS.md` | #47, #48 |
| §3.1 audit record | `docs/FIXES-2026-08-{15,18,21}.md` | #36, #37, #41, #49, #51 |
| §3.3 API pentest | `packages/api/src/routes/__tests__/courtPentest.test.ts` (host repo) | bao.markets #2287 |
| §4.1 benchmarks + optimization | `docs/benchmarks/BASELINE.md`, `bench/court.bench.mjs` | #50, #54 |
| §4.2 soak | `scripts/soak/court-soak.mts` + README (host repo) | bao.markets #2293, #2295 |
| §5 threat model + coverage | `docs/THREAT_MODEL.md`, `docs/CROSS_CHECK.md`, `scripts/cross-check.mjs` | #62, #63, #64 |
| §6 validity methodology | `__tests__/modelCheckingCore.ts` header, BASELINE.md caveats | #53, #50 |

Every pointer above resolves on `main`; the doc-level check is
`node scripts/cross-check.mjs` (exit 0) plus the one-command regeneration
contract in **docs/REPRODUCIBILITY.md**.
