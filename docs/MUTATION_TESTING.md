# Mutation testing — what the spec is blind to

> **Round 37 supersedes the numbers below for the v0.13 surface.** This
> document is the *first* campaign (53 mutants, 18 classes); it predates the
> per-round bond, `requireRoundBond`, the churn cap, the quorum-aware cap, the
> decay pairing, the sign-based ladder bound and the round-4 fixes. The
> v0.13 campaign — 25 further mutants in 10 new classes, and the 7 holes it
> found — is `docs/MUTATION_TESTING_V013.md`. The catalogue is now **78
> mutants in 28 classes** and this document's method section still describes
> the runner exactly; its result tables are historical.

The suite answers *"does the code do what the tests say?"*. It cannot answer
*"do the tests say what the protocol needs?"*. Mutation testing asks the second
question mechanically: inject one deliberate bug into the source, run every
detector the repository has, and see whether **anything** notices. A mutant that
nothing notices is a hole in the specification — an invariant, a proof, or a
test that was supposed to exclude that bug class and does not.

This document records the campaign, its results, the seven holes it found, the
tests that close them, and what the method does *not* prove.

Harness: `scripts/mutation/` (`mutants.mjs`, `run-mutants.mjs`,
`model-probe.mjs`, `spot-check.mjs`). Closure pins: `__tests__/mutationClosures.test.ts`.

---

## 1. Method

A **mutant** is one semantic edit — a single `find` → `replace` on one source
file — that a reviewer would call a bug. The catalogue holds **53 mutants across
18 bug classes** (`scripts/mutation/mutants.mjs`), covering the guards the
protocol is actually built from: deadline boundaries, quorum, thresholds,
ledger barriers, duplicate indices, the monotonic clock, clamp/cap boundaries,
Merkle domain separation, signer-set freezes, clawback idempotence, terminal
phase guards, abort precedence, canonical encoding, hex canonicalisation, empty
pins (F-2), and batch proof bounds.

The runner guarantees the measurement is about the *spec*, not the environment:

- **Sandboxed.** The tree is copied to `<tmp>/bao-court-mutation-<pid>/`;
  the repository the runner was launched from is never written to. A
  `git status --porcelain` snapshot must be byte-identical before and after, and
  a mismatch is reported as a runner bug (exit 1), not as a result.
- **Green baseline first.** The pristine copy must pass the whole suite before
  any mutant runs, otherwise every capture would be environmental noise.
- **Unambiguous by construction.** Every `find` string must occur **exactly
  once** in its file; the runner refuses to start otherwise, so no mutant can be
  applied to the wrong occurrence.
- **Deterministic.** Mutants run in id order, no randomness, no clock or
  environment reads in detection; results are sorted.
- **Crash-safe.** Each finished mutant is appended to `<out>.partial.jsonl`
  as it completes, so an interrupted campaign still yields evidence.
- **Bounded.** `--jobs N` parallelism, `--only M01,M06` subsets,
  `--test-timeout` seconds per mutant suite. A mutant that sends the suite into
  a loop *is* detected (the suite never goes green) but must not hang the
  campaign: one early sweep spent 27 minutes on M08 before the cap existed.

### Three independent detectors

| | Detector | Scope | Why it is separate |
|---|---|---|---|
| **A** | `vitest` battery | full suite **minus** `__tests__/modelChecking.test.ts` | the published suite: unit, adversarial, property, pipeline, parity, invariant |
| **B** | model explorer | `scripts/mutation/model-probe.mjs` → the reduced inline instances of `__tests__/modelCheckingCore.ts`, for the three ceremony machines (`confirmation`, `vote`, `signing`) | exhaustive reachability of the state machines, independent of any example a human wrote |
| **C** | invariant spot-check | `scripts/mutation/spot-check.mjs` → 18 black-box probes (S01–S18), each a restatement of one published `docs/FORMAL_INVARIANTS.md` invariant | asserts the promise, not the implementation's own guard; never imports the test helpers |

`modelChecking.test.ts` is excluded from A because its work *is* detector B;
counting it in both would distort the per-detector comparison and quadruple the
sweep cost. `--include-model-check` opts back in.

Structural note recorded up front: **21 of the 53 mutants touch no modelled
machine at all** (`selection.ts`, `batchAttestation.ts`, `courtSession.ts`,
`validator.ts`, `courtCeremonyCore.ts`), so B cannot fire on them by design —
its honest denominator is the 32 machine-attached mutants, not 53.

---

## 2. How to run

```bash
node scripts/mutation/run-mutants.mjs                    # full sweep (≈35–40 min on a busy 16-core box)
node scripts/mutation/run-mutants.mjs --jobs 6           # parallelism
node scripts/mutation/run-mutants.mjs --only M07,M24     # subset
node scripts/mutation/run-mutants.mjs --test-timeout 420 # cap one mutant's suite (default 900 s)
node scripts/mutation/run-mutants.mjs --no-baseline      # skip the green check (never on a report run)
node scripts/mutation/run-mutants.mjs --out /tmp/x.json  # artifact location
```

Output: per-mutant log lines, a summary, and a JSON artifact (`last-run.json`
by default) with every mutant's verdict, which detectors fired, the failing test
names, and the clean-tree assertion.

---

## 3. Results — as found (pass 1)

Artifact: `scripts/mutation/pass1-preclosure.json`. Baseline: 1,473/1,474 tests
green in the sandbox (the 1 is the env-gated live Taproot test), so no capture
below is environmental noise.

| Metric | Value |
|---|---|
| Mutants | **53** in 18 classes |
| Flagged (any detector) | **46** |
| — of which false (wall-clock only) | **2** (M40, M47 — §3.1) |
| Real captures | **44** |
| Survived outright | **7** |
| Mutation score | **86.8 %** flagged / **83.0 %** real |

### Per detector

| Detector | Flagged / 53 | Score | Honest denominator |
|---|---|---|---|
| **A** — vitest battery | 44 (42 real, see below) | **83.0 %** flagged → 79.2 % real | 53 |
| **B** — model explorer | 10 | 18.9 % overall → **31.3 %** | 32 machine-attached mutants |
| **C** — invariant spot-check | 23 | **43.4 %** | 53 |
| **Union** | **46 flagged / 44 real** | **86.8 %** flagged → 83.0 % real | 53 |

Two facts matter more than the numbers: the detectors are **not redundant**
(the union beats the best single detector by 3 mutants), and the strongest
detector still missed 7 bugs — including 3 on machines the explorer walks
exhaustively.

### 3.1 False captures — the wall-clock trap

Two mutants were flagged by exactly one failing test, and that test measures
**wall-clock time**, not behaviour:

```
simulateCourt.test.ts :: fast: completes the full pipeline well under the
default 5s budget → "expected 8853 to be less than 5000"
```

Under sweep load the end-to-end simulation runs slow, so the 5 s budget fails
"for" the mutant. **M40 and M47 were captured by nothing but their own
slowness.** A capture whose only failing test is a performance budget is not
evidence: it is load noise with a bug attached. Both are re-adjudicated below
(§5, §7): M47's hole is real and is now pinned by C8, M40 turned out to be an
*equivalent* mutant that no test should ever catch.

**Remedy applied (v0.12, closes review-round-2 N4).** The absolute 5 s gate is
gone. The test now asserts the deterministic work first — the exact eight-step
pipeline, in order, each green — and keeps only a generous ceiling: **30 s by
default**, overridable with `SIM_BUDGET_MS` (`__tests__/helpers/budget.ts`).
The measured baseline is ≈1.2 s for `poolSize: 20, jurySize: 7`, so the ceiling
has ~25× headroom against load noise yet still fails a real 100× regression
(≈120 s). The 100 000-tag validator scan got the same treatment
(`VALIDATOR_BUDGET_MS`). Any future performance claim belongs in `bench/`, not
in a suite assertion.

### Per class

"As found" is the pass-1 score; "after pins" is the score once the closure tests
in §5 exist (§6 verifies it).

| Bug class | Mutants | As found | After pins | Survivors found |
|---|---|---|---|---|
| `deadline-off-by-one` | 4 | 4/4 | 4/4 | — |
| `tie-break-reversal` | 3 | 2/3 | 3/3 | M07 |
| `quorum-dropped` | 2 | 2/2 | 2/2 | — |
| `threshold-weakened` | 4 | 4/4 | 4/4 | — |
| `ledger-barrier-removed` | 4 | 3/4 | 4/4 | M15 |
| `duplicate-idx` | 3 | 3/3 | 3/3 | — |
| `monotonic-clock-removed` | 3 | 3/3 | 3/3 | — |
| `clamp-boundary` | 4 | 3/4 | 4/4 | M24 |
| `merkle-domain-separation` | 2 | 2/2 | 2/2 | — |
| `signer-set-check-dropped` | 2 | **0/2** | 2/2 | M30, M31 |
| `cap-off-by-one` | 4 | 3/4 | 4/4 | M35 |
| `clawback-dedup-removed` | 3 | 2/3 | 3/3 | M37 |
| `phase-guard-loosened` | 3 | 2/3 real | 2/3 real + 1 equivalent | — (M40 equivalent) |
| `abort-precedence` | 2 | 2/2 | 2/2 | — |
| `encoding-length-prefix` | 2 | 2/2 | 2/2 | — |
| `hex-case` | 2 | 2/2 | 2/2 | — |
| `empty-pin-acceptance` | 3 | 3/3 | 3/3 | — |
| `proof-bounds` | 3 | 3/3 | 3/3 | — |

`signer-set-check-dropped` was the worst class: **both** mutants survived, i.e.
the repository asserted signer-set roots and thresholds but never that the set
handed to finality is the set the commitments froze.

### Mutant table

`A` = test suite, `B` = model explorer, `C` = invariant spot-check.

| ID | Class | File | Intent (the bug injected) | Result |
|---|---|---|---|---|
| M01 | `deadline-off-by-one` | `courtCeremonyCore.ts` | accepts an event arriving EXACTLY at the deadline (should be strictly-before) — every machine shares this guard | **caught** A+C |
| M02 | `deadline-off-by-one` | `confirmationMachineHandlers.ts` | a tick at exactly the deadline no longer expires the phase (expiry slips one tick) | **caught** A+B+C |
| M03 | `deadline-off-by-one` | `confirmationMachineHandlers.ts` | the legal at-deadline close is refused (boundary moved one tick the other way) | **caught** A+C |
| M04 | `deadline-off-by-one` | `courtVoteMachine.ts` | the vote ceremony does not expire at exactly the reveal deadline | **caught** A |
| M05 | `tie-break-reversal` | `courtVoteMachine.ts` | UTF-16 code-unit order replaces UTF-8 byte (code point) order: astral vs BMP outcomes sort differently | **caught** A+C |
| M06 | `tie-break-reversal` | `confirmationMachineHandlers.ts` | ladder-round ties resolve to the larger outcome instead of the canonical smaller one | **caught** C |
| M07 | `tie-break-reversal` | `selection.ts` | exact-priority ties rank pubkeys descending — the draw stops being reproducible across implementations | **caught** — pin C5 |
| M08 | `quorum-dropped` | `confirmationMachineHandlers.ts` | close_confirmations proceeds with fewer confirmations than the quorum (silent under-quorum case) | **caught** A+C |
| M09 | `quorum-dropped` | `confirmationMachineHandlers.ts` | quorum becomes quorum+1 (a satisfied quorum is refused) — quorum boundary off-by-one | **caught** A+C |
| M10 | `threshold-weakened` | `courtSigningMachine.ts` | the commitment set freezes with t-1 signers — the distinct-signer threshold is no longer reached | **caught** A+C |
| M11 | `threshold-weakened` | `courtSigningMachine.ts` | aggregation accepts t-1 partial signatures (t-1-of-n "threshold" aggregate) | **caught** A+B |
| M12 | `threshold-weakened` | `validator.ts` | finality policy admits an attestation whose threshold is one below the pinned minimum | **caught** A |
| M13 | `threshold-weakened` | `validator.ts` | finality policy admits a tier one below the pinned minimum | **caught** A |
| M14 | `ledger-barrier-removed` | `confirmationMachineHandlers.ts` | resolve_round trusts a hand-restored mass-vote ledger (ballot closure, roster, uniqueness unchecked) | **caught** A |
| M15 | `ledger-barrier-removed` | `confirmationMachineHandlers.ts` | resolve_round takes clawback indices from an unverified confirmation ledger | **caught** — pin C3 |
| M16 | `ledger-barrier-removed` | `confirmationMachineHandlers.ts` | finalize mints a verdict on top of an unverified (forged) outcome history | **caught** A |
| M17 | `ledger-barrier-removed` | `confirmationMachineHandlers.ts` | close_ladder_round accepts a tampered vote ledger | **caught** A |
| M18 | `duplicate-idx` | `confirmationMachineHandlers.ts` | a juror can publish two different confirmations (one seat, two endorsements) | **caught** A+C |
| M19 | `duplicate-idx` | `courtVoteMachine.ts` | one voter reveals twice — the reveal ledger can inflate a tally | **caught** B |
| M20 | `duplicate-idx` | `confirmationMachineHandlers.ts` | one round-panel seat mass-votes repeatedly — repeated votes count in the tally | **caught** A+B |
| M21 | `monotonic-clock-removed` | `courtConfirmationMachine.ts` | clock rollback accepted — a restored snapshot can re-admit events a later timestamp already excluded | **caught** A+B+C |
| M22 | `monotonic-clock-removed` | `courtVoteMachine.ts` | clock rollback accepted in the vote machine | **caught** A+B |
| M23 | `monotonic-clock-removed` | `courtSigningMachine.ts` | clock rollback accepted in the signing machine | **caught** A+B |
| M24 | `clamp-boundary` | `selection.ts` | r = 1 escapes the clamp → priority 0 → that juror deterministically wins every draw | **caught** — pin C6 |
| M25 | `clamp-boundary` | `selection.ts` | same clamp flip in weighted mode — weight is ignored for the r = 1 boundary juror | **caught** A |
| M26 | `clamp-boundary` | `selection.ts` | eligibility clamp boundary: a juror exactly at the minimum stake is excluded | **caught** A |
| M27 | `merkle-domain-separation` | `batchAttestation.ts` | leaf preimage reuses the interior-node tag (0x01) — the domain-separation prefix no longer distinguishes levels | **caught** A+C |
| M28 | `merkle-domain-separation` | `batchAttestation.ts` | interior-node preimage reuses the leaf tag (0x00) | **caught** A+C |
| M29 | `clamp-boundary` | `batchAttestation.ts` | RFC-6962 split boundary off-by-one (n = 2^m + 1 and friends) — roots diverge from every other implementation | **caught** A+C |
| M30 | `signer-set-check-dropped` | `validator.ts` | a signer set of any size paired with any declared threshold validates (signerSet root still matches its own set) | **caught** — pin C1 |
| M31 | `signer-set-check-dropped` | `courtSigningMachine.ts` | a restored signing state's frozen signer set is no longer re-verified against the stored commitments (A-1) | **caught** — pin C2 |
| M32 | `cap-off-by-one` | `confirmationMachineHandlers.ts` | the last permitted ladder round is refused (cap off-by-one) | **caught** A+B+C |
| M33 | `cap-off-by-one` | `confirmationMachineHandlers.ts` | escalate re-opens a round past the cap — the ladder becomes unbounded | **caught** A |
| M34 | `cap-off-by-one` | `confirmationMachineHandlers.ts` | a resolved final round parks in round_resolved instead of settling (host must escalate past the cap) | **caught** A |
| M35 | `cap-off-by-one` | `batchAttestation.ts` | batch cap off-by-one: exactly MAX_BATCH_VERDICTS is refused | **caught** — pin C7 |
| M36 | `clawback-dedup-removed` | `confirmationMachineHandlers.ts` | overturned_confirmation flags duplicate per juror across rounds (fee clawback queued twice) | **caught** A |
| M37 | `clawback-dedup-removed` | `confirmationMachineHandlers.ts` | round_flip flags duplicate per voter (idempotence of the flip-flop rule broken) | **caught** — pin C4 |
| M38 | `clawback-dedup-removed` | `confirmationMachineHandlers.ts` | operator flag_clawback is no longer idempotent — repeated flags accumulate | **caught** A+B |
| M39 | `phase-guard-loosened` | `courtConfirmationMachine.ts` | the reducer-wide terminal guard is gone: unguarded handlers (record_fee) mutate a settled case | **caught** A+C |
| M40 | `phase-guard-loosened` | `courtVoteMachine.ts` | same guard removal in the vote machine | **equivalent** (survives: every handler re-checks its own phase, so only the error text moves — see §7) |
| M41 | `phase-guard-loosened` | `confirmationMachineHandlers.ts` | abort from a terminal phase overwrites a settled verdict with an aborted failure | **caught** A+B |
| M42 | `abort-precedence` | `courtConfirmationMachine.ts` | abort is no longer dispatched before the terminal guard: its precedence over the terminal check is inverted | **caught** A+C |
| M43 | `abort-precedence` | `courtVoteMachine.ts` | same precedence inversion in the vote machine | **caught** A |
| M44 | `encoding-length-prefix` | `courtSession.ts` | CanonicalWriter loses its length prefix — adjacent variable-length fields become re-interpretable (delimiter ambiguity) | **caught** A+C |
| M45 | `encoding-length-prefix` | `courtSession.ts` | u32 encoding becomes little-endian — every hash domain diverges from the canonical big-endian spec | **caught** A+C |
| M46 | `hex-case` | `courtCeremonyCore.ts` | uppercase hex accepted as canonical — two spellings of one value (hash/compare/equality divergence) | **caught** A+C |
| M47 | `hex-case` | `courtSession.ts` | same uppercase acceptance in the session encoder | **caught** — pin C8 (pass-1 capture was wall-clock only) |
| M48 | `empty-pin-acceptance` | `validator.ts` | v1 validator treats an empty pin as "no pin" — the group key pin is silently disabled (F-2) | **caught** A+C |
| M49 | `empty-pin-acceptance` | `validator.ts` | v2 finality validator silently disables the pin on an empty string (F-2) | **caught** A |
| M50 | `empty-pin-acceptance` | `batchAttestation.ts` | batch attestation validation disables the cohort pin on an empty string (F-2) | **caught** A+C |
| M51 | `proof-bounds` | `batchAttestation.ts` | duplicate verdict hashes are batched — two identical leaves make proof indices ambiguous | **caught** A+C |
| M52 | `proof-bounds` | `batchAttestation.ts` | proof index bound off-by-one: index === count is treated as inside the batch | **caught** C (spot S17) + pin C9 |
| M53 | `proof-bounds` | `confirmationMachineHandlers.ts` | finalize mints a verdict backed by zero evidence (r3-1 guard removed) | **caught** A |

---

## 4. The survivors (the holes, named)

Seven mutants survived outright, and an eighth (M47) survived everything except
the wall-clock budget test — eight real spec holes. Each row is a bug the whole
1,474-test spec, all 145 `INV-*` invariants, the proofs, the invariant
spot-check, and the exhaustive explorer were blind to (M47 is listed in §5).

| ID | Hole | Why everything missed it |
|---|---|---|
| **M07** | `selection.ts`: exact-priority ties ranked pubkeys **descending** in `selectJury`'s comparator. Both orders are deterministic, so every "is the draw reproducible?" test passed; only *inter-implementation* reproducibility (the property that lets two parties derive the same jury) broke. | Tests asserted *stable*, not *which* order; no probe compared against the UTF-8 byte ordering the spec fixes. |
| **M15** | `confirmationMachineHandlers.ts`: `resolve_round` took clawback indices from a confirmation ledger **without re-verifying it**. Comparable barriers (M14, M16, M17) were tested; this one was not. | Coverage of the sibling handlers did not generalise; the explorer does not model clawback index provenance. |
| **M24** | `selection.ts`: `quadraticPriority` let `r = 1` escape the clamp, giving priority **0** — a juror with zero random value deterministically won every draw. | Tests covered `r = 0` and general `r ∈ (0,1)`; the exact `r = 1` boundary was never instantiated. A classic boundary hole, on the *last* branch of a clamp. |
| **M30** | `validator.ts`: v2 finality accepted a signer set of **any size** with **any** declared threshold (the root still matched the set it hashed). | The suite pinned "root matches set" and "threshold ≥ minimum" separately; nothing asserted the two agree with each other — `|signerSet| = threshold`. |
| **M31** | `courtSigningMachine.ts`: a **restored** signing state's frozen signer set was not re-verified against the stored commitments (finding A-1). | Restore paths were tested for *shape*, not for the freeze discipline the fresh path enforces. |
| **M35** | `batchAttestation.ts`: the batch cap became exclusive — exactly `MAX_BATCH_VERDICTS` was refused. | The suite tested `MAX + 1` rejection and left the legal boundary implicit. |
| **M37** | `confirmationMachineHandlers.ts`: `round_flip` duplicated clawback flags for a voter already flagged in a restored ledger. | M36 and M38 (siblings) were covered; this path was reached only through ledgers never restored. |

Classes: 3 boundary (`m24`, `m35`, plus the tie-break boundary), 2
presentation/consistency (`m07`, `m30`), 2 restore-path barriers (`m15`, `m31`,
`m37`). The pattern is consistent: **the suite tests the guard, not the
agreement between the guards, and it tests the fresh path, not the restored
one.**

---

## 5. Closures

`__tests__/mutationClosures.test.ts` adds **9 pin groups / 14 tests**. A pin is
minimal by contract: it asserts the ONE boundary the mutant moved, with the
smallest state that reaches it, and it must fail when the mutant is re-applied
(that is what §6 checks — a pin that passes under its mutant is worthless).

| Pin | Mutant | Asserts |
|---|---|---|
| **C1** | M30 | v2 finality rejects a correctly-rooted signer set **smaller** and **larger** than the declared threshold |
| **C2** | M31 | a restored signing state rejects a committed-set **prefix** and an **extra** signer — the freeze survives restore |
| **C3** | M15 | `resolve_round` refuses a confirmation ledger whose hashes were never accepted |
| **C4** | M37 | `round_flip` does not duplicate a flag already present for that round (idempotent against a restored ledger) |
| **C5** | M07 | exactly-tied jurors order by **ascending** pubkey bytes, not descending |
| **C6** | M24 | `quadraticPriority` clamps `r = 1` to `1 − EPS` (a positive priority, never 0), and keeps the `r = 0` branch |
| **C7** | M35 | a batch of exactly `MAX_BATCH_VERDICTS` is accepted; `MAX + 1` is not |
| **C8** | M47 | the session encoder rejects an **uppercase** block hash; the lowercase form is accepted (the pin, verified load-bearing: with C8 in place the mutant fails on C8 and nothing else) |
| **C9** | M52 | `verifyCaseInBatch` rejects `index === count` before recomputing the root |

C8 closes the eighth hole: M47's pass-1 "capture" was the 5 s budget test
failing under load, i.e. it was a survivor all along. Re-run against the current
base, M47 fails **only** C8 — the pin is load-bearing. C9 hardens M52, which a
spot probe (S17) already caught, so the pin is belt-and-braces rather than a
closure.

---

## 6. Verification — pass 2 (post-closure)

The closure claim is only true if the pins actually fire. Pass 2 re-applies
**every pass-1 survivor** to a sandbox that contains the pins.

Artifact: `scripts/mutation/pass2-postclosure.json`.

```bash
node scripts/mutation/run-mutants.mjs --only M07,M15,M24,M30,M31,M35,M37 --jobs 3
```

| | Result |
|---|---|
| Base | round-26 `main` for the recorded re-run (pass 1 was measured pre-R25; the catalogue was re-validated after every rebase — all 53 `find` strings still occur exactly once) |
| Baseline in sandbox | 1,512/1,513 green (the 1 is the env-gated live test) |
| Survivors re-applied | 7 |
| Captured | **7 / 7** — all by detector **A**, each pin failing exactly as required |
| Survived | **0** |
| Clean-tree assertion | **PRISTINE** (repository untouched) |

Combined post-closure score: **52/52 applicable = 100 %** — 44 real captures in
pass 1, 7 closed by C1–C7, M47 closed by C8; M40 is the 53rd mutant and is
**equivalent** (§7), so it is excluded from the denominator rather than counted
as a hole. Post-closure per-detector attribution: **A 50/52 (96.2 %)**,
**B 10/52 (31.3 % of the 30 applicable machine-attached)**, **C 23/52
(44.2 %)** — the pins are tests, so detector A is where the closure lands; B and
C gained nothing, which is itself a finding (§7).

### Pass 3 — adjudicating the two wall-clock captures

Artifact: `scripts/mutation/pass3-detector-audit.json`.

```bash
node scripts/mutation/run-mutants.mjs --only M40,M47,M52 --jobs 3
```

| Mutant | Verdict on the current base | Failing detectors |
|---|---|---|
| **M47** | **caught — by pin C8 only** (the pass-1 capture was the 5 s budget) | A (`mutationClosures.test.ts :: C8`) |
| **M52** | caught — spot probe S17 and pin C9 | A (`C9`), C (`S17`) |
| **M40** | **SURVIVED — equivalent mutant** | none |

M40 is equivalent, and the reason is instructive: deleting the reducer-wide
terminal guard leaves every handler's own `state.phase !== …` check in place, so
the machine still refuses the event — only the error *message* changes. The
guard is defence-in-depth (uniform taxonomy), not behaviour, and no test should
have to catch its removal. It is kept in the catalogue as a known equivalent
rather than deleted: ids are stable, and a future refactor that drops the
per-handler checks would make it live again.

Suite delta: **+1 file, +14 tests** — 63 files / 1,521 tests on the base
(round-26 `main`: 1,520 passing + the env-gated skip), **64 files / 1,535 tests**
with the pins (1,534 passing + 1 env-gated skip).

---

## 7. What this does not prove

- **A performance assertion is not a detector.** The old `simulateCourt.test.ts`
  asserted the whole pipeline finished inside 5 s. Under sweep load it failed,
  and in pass 1 that was enough to "capture" M40 (an equivalent mutant) and M47
  (a real hole whose other detectors were silent). Two of 46 pass-1 captures —
  4 % — were load noise, and the same test also made two full-suite runs red on
  a loaded box with no code change. Treat any capture whose only failing test is
  a wall-clock budget as *unproven*: a flaky performance gate corrupts mutation
  results and CI alike. **Fixed in v0.12** — deterministic step assertions plus
  a 30 s env-tunable ceiling (`SIM_BUDGET_MS`), so this class of capture can no
  longer occur.
- **Equivalent mutants exist.** M40 shows the catalogue can contain a mutant
  whose removal changes nothing observable; the runner has no automatic
  equivalence detection, so verdicts must be adjudicated by hand (as here).
- **One edit per file.** Higher-order mutants (two coordinated edits, or a bug
  that requires deleting a guard *and* its caller) are not in the catalogue.
  Real bugs are correlated; this campaign only measures single-guard blindness.
- **A curated catalogue.** 53 mutants in 18 classes is a sample, not a proof of
  coverage. A class nobody thought to write is invisible here — the catalogue is
  the artifact to extend, and ids are stable so old results stay comparable.
- **Detector B is narrow.** The explorer walks the reachable state space of the
  three ceremony machines, and even there it missed 3 of the 7 survivors
  (M15, M31, M37): its properties P1–P5 do not encode clawback-index
  provenance, signer-set freeze on restore, or flag idempotence. Exhaustive
  reachability is not exhaustive *property* coverage — properties are written by
  hand too.
- **Detector C is a restatement.** The 18 probes are black-box and independent
  of the test helpers, but they were written by the same author as the
  invariants; a shared misreading of the paper would be invisible to both. C
  caught 23 mutants and none of the 7 survivors.
- **Detection ≠ repair.** A captured mutant proves a detector fires, not that
  the resulting error is typed, actionable, or correctly worded at the rail.
- **Not a release gate (yet).** Wall cost is ~35–40 minutes for the full sweep
  on a loaded 16-core box, so it runs per documentation/release pass, not per
  PR. The `--only` subset plus `--test-timeout` keeps a targeted re-check inside
  a minute per mutant; the natural CI subset is the survivor set plus the class
  representatives.

---

## 8. Artifacts

| File | What |
|---|---|
| `scripts/mutation/mutants.mjs` | the catalogue: 53 mutants, 18 classes, id-stable |
| `scripts/mutation/run-mutants.mjs` | the harness: sandbox, three detectors, baseline, clean-tree assertion, checkpointing |
| `scripts/mutation/model-probe.mjs` | detector B — bounded explorer over the reduced machine instances |
| `scripts/mutation/spot-check.mjs` | detector C — 18 black-box invariant probes |
| `scripts/mutation/pass1-preclosure.json` | pass 1: 53 mutants, 86.8 %, 7 survivors |
| `scripts/mutation/pass2-postclosure.json` | pass 2: the 7 survivors re-applied, 7/7 caught, 0 survived |
| `scripts/mutation/pass3-detector-audit.json` | pass 3: the two wall-clock captures adjudicated — M47 caught by C8 alone, M52 by S17 + C9, M40 equivalent |
| `__tests__/mutationClosures.test.ts` | the 9 closure/hardening pins |
