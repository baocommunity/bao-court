# SCALE CAMPAIGN V2 — an order of magnitude more corpus on the v0.14 surface

The Court's corpus, extended by an order of magnitude **on its newest surface**.
v0.14.0/v0.14.1 shipped two things: the challenger **escalation-request
transport** (a versioned wire codec, `courtEscalationRequest.ts`) and the
**concede/finalize barrier** (r41-1, the four restore-time ledger barriers). This
round adds three campaigns over exactly that surface and re-runs the whole
corpus in one invocation:

| | before (v0.13 round) | after (this round) | growth |
|---|---|---|---|
| campaigns | 9 | **12** | +3 |
| corpus units | 1,187,000 | **1,587,000** | +400,000 (×1.34) |
| assertions | 3,745,566 | **8,323,560** | +4,577,994 (×2.22) |
| failures | 0 | **0** | — |
| one-invocation wall | 608.8 s | **1,097.9 s** | ×1.80 |

The **extension itself** is the order-of-magnitude step. Round 29 added
16,000 units / 152,705 assertions for the whole v0.12.0 surface; this round adds
**400,000 units / 4,577,254 assertions** for the v0.14 surface — **×25 units,
×30 assertions** on the same surface class.

Artifact: `docs/benchmarks/campaign-2026-11-11-v2.json` (profile `full`, seed
`20261111`, **one** invocation, `declaredSizes === actualSizes` for all twelve
campaigns). `docs/benchmarks/campaign-2026-11-11.json` and
`docs/benchmarks/SCALE_CAMPAIGN.md` are untouched and remain the v0.13 record
that the paper cites; this page supersedes them for corpus size only.

```
npm test                                                  # FAST subset, part of CI
npx tsx scripts/campaign/run-campaign.mjs --fast          # FAST, prints the table, writes a profile file
npx tsx scripts/campaign/run-campaign.mjs --full          # FULL corpus (the artifact below)
npx tsx scripts/campaign/run-campaign.mjs --full --only escalationTransport,ledgerBarrier,bondAlgebra
npx tsx scripts/campaign/run-campaign.mjs --full --only tally --merge    # documented split
npx tsx scripts/campaign/run-campaign.mjs --full --requests 50000 --states 25000 --bond-sequences 25000
```

Every number on this page comes from that artifact. Nothing is
declared-and-assumed: the runner prints and records the size that **ran**, and
`--only` / `--merge` are unchanged and still record each invocation.

---

## 1. The three new campaigns

| # | Campaign | Unit | What is driven | Invariants asserted |
|---|---|---|---|---|
| 10 | `escalationTransport` | request | one challenger escalation request through the **whole transport**, in host order: `build` / `parse` → `serialize` → `parse` → `escalationRequestToMachineEvent` → `reduceCourtConfirmationMachine`. 91-row wire matrix rotated over a pool of **32 real driven cases** (ladder round 1..4 × strict/legacy × break-glass/default × roster 3/5) | **T1** no raw throw escapes any stage — every refusal is the codec's own `CourtConfirmationTransitionError`; **T2** the accept/refuse decision matches the row's expectation at the row's stage (wire / binding / reducer), and the object entry point and the text entry point agree on every payload except the duplicate-key rows where the defect is unrepresentable in an object; **T3** `parse(serialize(r))` reproduces the preimage AND the exact bytes; **T4** DIGEST INJECTIVITY over every accepted request in the run (digest → canonical preimage map; a repeated digest with a different preimage is the r7 H-6 / r8-1 collision), plus the fixed 9-field preimage arity; **T5** no accepted request carries a claim the host binding contradicts (pubkey, case id, round, digest, bond owner, per-round witness); **T6** a mapped event either opens exactly the next round with one frozen record carrying the request's per-round witness, or is a typed refusal — never a silent no-op; **T7** the demonstrated hazards are real (`TextEncoder` maps a lone surrogate and U+FFFD to identical bytes; NFC ≠ NFD; the `'-'` sentinel is the absent-bond slot and no hex32 can equal it) |
| 11 | `ledgerBarrier` | restored state | one `CourtConfirmationMachineState` through **every applicable barrier** — `assertValidConfirmationLedger`, `assertValidOutcomeHistory`, `assertValidEscalationLog`, `assertValidMassVoteLedger` — in both directions: a **reachable** state (captured by driving the real machine; 643 states across all 11 phases) and a **forged** one drawn from a 5,984-cell grid (11 phases × 17 log shapes × 8 challenge-ledger shapes × strict/legacy × host/default) | **B1** no false refusal — every reducer-reachable state is ACCEPTED by every applicable barrier (a barrier that refuses a restorable snapshot bricks a live case; r37-1 was exactly that); **B2** the accepted set is **exactly** the legal set — each barrier's verdict must equal an independent oracle written in the campaign from the invariant text, not from the product code, and the count is reported; no refusal may be untyped |
| 12 | `bondAlgebra` | sequence | one **legal** escalation sequence: a 7-seat case driven to `round_resolved`, then climbed to round `R` (drawn 1..5) with witnessed escalations, probing the illegal presses at every rung — challengers drawn 2..5 from the 7-juror roster over a bond pool with **deliberate collisions** (repeated txids) | **A1** one hash, one index — presenting an accepted bond witness for a second juror is a typed refusal and the ledger keeps one owner; **A2** no re-consumption — replaying a consumed per-round witness, quoting a membership bond as the round's payment, replaying the round index, or pressing `host` without the frozen break-glass policy are all typed refusals that never grow the log; **A3** rounds strictly increase (`2..L` consecutive, `ladderRound` +1 per accepted press); **A4** the ΔC schedule equals the geometric series — `escalationBondMultiple(e) === 3^e` and `cumulativeLadderBondMultiple(L−1) === (3^L − 1)/2`, checked against the closed form rather than against the package's own table; **A5** consumption-count parity — reaching round `L` consumed exactly `L−1` distinct witnesses, none a membership bond; **A6** typed errors only |

The campaigns keep the run's rules: they are DETERMINISTIC in `(seed, size)` (no
clock, no CSPRNG, no I/O — two runs of each produce byte-identical metrics), they
RECORD failures instead of throwing, and they report the corpus size that
actually ran.

## 2. The corpus that actually ran

Profile `full`, seed `20261111`, artifact `docs/benchmarks/campaign-2026-11-11-v2.json`,
**one invocation**, `failedChecks = 0`, `actualSizes === declaredSizes`.

| Campaign | Corpus | Checks | Failures | Wall | Notes on coverage |
|---|---|---|---|---|---|
| `confirmation` | **10,000 sequences** | 731,225 | 0 | 3.3 s | unchanged campaign, re-run |
| `tally` | **1,000,000 tallies** | 2,010,400 | 0 | 326.1 s | unchanged campaign, re-run |
| `merkle` | **1,000 batches** | 151,538 | 0 | 50.0 s | unchanged campaign, re-run |
| `validator` | **50,000 events** | 50,000 | 0 | 487.3 s | unchanged campaign, re-run (real signatures) |
| `selection` | **10,000 draws** (+100,000 χ² trials) | 229,693 | 0 | 10.3 s | unchanged campaign, re-run |
| `encoding` | **100,000 encodings** | 420,005 | 0 | 4.5 s | unchanged campaign, re-run |
| `witness` | **10,000 witnesses** | 29,620 | 0 | 5.4 s | unchanged campaign, re-run |
| `epochRotation` | **1,000 batches** | 15,139 | 0 | 36.9 s | unchanged campaign, re-run |
| `finality` | **5,000 chains** | 108,686 | 0 | 27.4 s | unchanged campaign, re-run |
| `escalationTransport` | **200,000 requests** | 509,876 | 0 | 18.2 s | 142,864 wire refusals / 57,136 wire accepts; 19,781 mapped events, 37,355 binding refusals; reducer accepted 15,385 and refused 4,396 (the strict-case and membership-bond-relabel rows); **184,615 typed refusals, 0 raw errors**; 74,720 distinct request digests with **0 collisions**; 13,188 surrogate-hazard probes; all **91** matrix rows fired; 0.056 ms median, 0.178 ms p95, 12.0 ms max |
| `ledgerBarrier` | **100,000 states** | 700,832 | 0 | 13.2 s | 350,416 barrier runs on reachable states — **0 refusals**; 350,416 barrier runs on forged states — 276,530 accepted / 73,886 refused, and the oracle said legal/illegal on exactly those numbers (**0 disagreements**, 0 untyped refusals); all **5,984** grid cells visited; stock 643 reachable states across **all 11 phases**; the ladder-only mass-vote barrier ran 50,416 times; 0.102 ms median, 0.291 ms p95, 11.0 ms max |
| `bondAlgebra` | **100,000 sequences** | 3,366,546 | 0 | 114.8 s | 200,210 legal escalations accepted; **772,499 illegal probes, every one a typed refusal** (200,210 membership-bond relabels, 200,210 round rewinds, 112,105 re-consumption replays, 159,974 host presses without the policy, 100,000 duplicate-bond-owner claims); 1,601,050 consumption checks + 600,630 schedule checks; target rounds 1..5 all exercised (~20,000 sequences each), deepest rung reached 5; 1.008 ms median, 2.686 ms p95, 10.3 ms max |
| **Total** | **1,587,000 units** | **8,323,560** | **0** | **1,097.9 s (18.3 min)** | |
| *of which this round* | *400,000 units* | *4,577,254* | *0* | *146.2 s* | the v0.14 surface |

### 2.1 The honest comparison to the old numbers

| | units | assertions |
|---|---|---|
| round-29 extension (v0.12 surface) | 16,000 | 152,705 |
| **round-46 extension (v0.14 surface)** | **400,000** | **4,577,254** |
| ratio | **×25.0** | **×30.0** |

The *whole* corpus therefore grows ×1.34 in units and ×2.22 in assertions. The
order-of-magnitude claim is about the newest surface, which is where the new
code is and where the marginal coverage matters; the six-year-old campaigns
(`tally`, `validator`) dominate the total and were deliberately not re-scaled —
re-running them unchanged is what makes the before/after comparable.

### 2.2 The runtime envelope

**18.3 minutes of corpus wall time in ONE invocation** (1,097.9 s; 18m19s
end-to-end including tsx transpile, the artifact write and the JSON summary) on
a 16-core host at **load average 11.9 → 22.2**. Host contention dominates the
wall number and nothing else: corpus sizes, per-campaign checks, assertion
counts and failure counts are reproducible byte for byte from
`(profile, seed)`.

Measured on the same host within one hour, at different loads:

| campaign | at load ≈6 (aborted run) | at load ≈12–22 (this artifact) |
|---|---|---|
| `tally` | 131.5 s | 326.1 s |
| `validator` | 186.9 s | 487.3 s |
| `merkle` | 24.5 s | 50.0 s |
| **nine legacy campaigns** | **396.8 s** | **951.2 s** |

So treat the envelope as **11–19 minutes, host-contention dependent** (the
legacy nine alone have been measured at 550 s, 608.8 s and 951.2 s across three
hosts/loads). The extension's own 146.2 s is 13 % of this run and is the most
predictable part of it — it is dominated by `bondAlgebra` (114.8 s), which drives
up to five real ladder rounds with real bond consumption per sequence.

The FAST profile is unchanged in practice: all twelve campaigns' FAST sizes cost
**5.9–10.7 s of corpus work in total** (measured at load ≈4 and load ≈22
respectively; the three new campaigns contribute ≈0.3–0.5 s of it), and the whole
`npm test` suite is **2 m 07 s**
(1812 passed, 1 skipped) — the same order it was before this round. `--fast`
writes a `-fast`-suffixed artifact so it can never overwrite the round's
committed full record.

## 3. Findings

Two. Both have a repro test in the tree; neither is a corpus artefact.

### 3.1 PRODUCT — r46-1: a signed concession was minted as an escalation (fixed)

Found by campaign 10. `CourtEscalationRequest` carries `concession: boolean`,
documented as *"True when the challenger DROPS the appeal (concede, never
blocked)"*, and it is a **signed** field: it sits in the v2 hash preimage and r8-3
made it a strict boolean precisely because *"a coerced `true` → `false` flips a
signed field"*. `escalationRequestToMachineEvent` never read it.

Measured on v0.14.1, a request built and hashed with `concession: true` — and
re-parsed from its own canonical wire text, so re-encoding cannot launder it —
came back from the only mapper as `{ type: 'escalate', roundIndex: 2 }`. The
reducer **accepted** it: the case moved to `ladder_pending`, a fresh per-round
bond witness was consumed in the challenger's name, and the append-only
`escalationLog` recorded **that challenger as the escalator**. That is the r8-2
attribution harm (a non-escalator written into the permanent log) reproduced one
signed flag over, and it inverted the single press a concession exists to
prevent. The digest being correct makes the contradiction *provable afterwards*,
which is mitigation, not a defence — the rung was already opened and the bond
already spent.

**Fix (minimal, fail-closed):** the mapper refuses a concession-bearing request
and names the documented path. The concession itself is not blocked — the host
ends the ladder with the machine's own `concede` event, which is what
`FORMAL_INVARIANTS.md` and the paper already say the host may do while a
*witnessed* concede (SPEC §9.2 ESC-RIGHT-3) stays the open item it already was.
Repro: `__tests__/findingR46.test.ts` (2 of 4 tests red on `bc28ff3`, all 4 green
after). Recorded in `CHANGELOG.md`. The campaign now carries a
`concession-must-not-escalate` row so the corpus locks it at scale.

**Consumer impact:** a host that routed a `concession: true` request through this
mapper was escalating against its signer. It must call `concede` instead. Nothing
else changes — a non-concession request maps exactly as before.

### 3.2 CAMPAIGN — the timing summary could not survive 200,000 samples (fixed)

`timingMetrics` (the shared per-unit timing summary in
`__tests__/scale/corpus.ts`) computed its maximum as `Math.max(...samples)`. The
spread materialises every sample as a call argument, so above roughly 125k
samples it throws `RangeError: Maximum call stack size exceeded` — in the
*summary*, after the corpus has already run. The first FULL invocation of this
round died exactly there (nine legacy campaigns green, `escalationTransport`
finished its 200,000 requests at 18.2 s and then blew up writing their timing
line). No legacy campaign records one sample per unit at that size, so nothing
had ever hit it.

**Fix:** fold the maximum instead of spreading it. Regression lock:
`__tests__/scale/scaleCampaign.test.ts` › *"scaffolding: summarises a
250,000-sample timing array without blowing the argument limit"* (red before the
fold, green after), which also pins the empty-sample behaviour.

### 3.3 What was NOT found

No digest collision, no accepted request that contradicts its host binding, no
barrier that refused a reducer-reachable state, no barrier that accepted a state
its independent oracle called illegal, no re-consumable bond witness, no round
that skipped or rewound, and no schedule that disagreed with `3^R`. Every one of the
**1,031,000 typed refusals** across the three campaigns (`184,615` transport +
`73,886` barrier + `772,499` bond) carried the machine's own error type
(`rawErrors = 0` in all three).

## 4. What this corpus does and does not cover

**It covers.** The transport's fail-closed decision on 91 wire shapes including
every field boundary and every injected defect the r7/r8 reviews named; the
injectivity of the request digest over 74,720 distinct accepted requests; the
mapping's binding of every claim the reducer cannot check; the reducer's
enforcement of the per-round bond through the wire; all four restore-time
barriers over a 5,984-cell state grid in both directions; the bond ledger's
one-hash-one-index, no-re-consumption and strictly-increasing-round discipline
over 200,210 real escalations; and the package's own `ΔC` schedule against the
closed-form geometric series.

**It does not cover** (stated so the claim cannot be read wider):

- **Authentication.** NIP-98 itself is never exercised. The campaigns hand the
  mapper the `CourtEscalationBinding` the host is supposed to have proved; that
  the host proves it correctly is outside the package and outside this corpus.
- **Replay across time.** `signedAtSec` is carried and hashed but nothing here
  imposes a freshness window — that is host policy. The corpus asserts only that
  a request cannot cross a *case* or a *round*.
- **The object-path asymmetry.** A host that `JSON.parse`s a body and hands the
  object to the codec loses duplicate keys; only the text scan can see them.
  Campaign 10 asserts the asymmetry exists (3 rows) rather than pretending it
  does not, and the module documents it. Duplicate-key refusal is therefore a
  property of *the text entry point*.
- **Phase legality.** The four barriers are per-ledger. Whether a given phase may
  legally *hold* a given ledger is the reducer's phase guard, covered by
  campaigns 1 and 9, not by campaign 11.
- **The oracle's independence is bounded.** Campaigns 11's oracle is written from
  the invariant text in the campaign file rather than from the product code, but
  the same author wrote both. A shared misreading of the invariant would produce a
  green campaign. The two acceptable defences — reading the text independently and
  expecting the *reducer* to disagree with the barrier somewhere — are used where
  they exist; this is the same caveat the `tally` (reduce oracle) and `merkle`
  (`node:crypto` reference tree) campaigns carry.
- **Amounts.** Campaign 12 asserts the machine's *consumption* discipline and the
  package's schedule table. It cannot assert that a host actually charges
  `3^R · b₀` — the amounts are host-side and outside the package.
- **Statistical strength.** These are seeded corpora, not proofs. They raise the
  cost of a regression escaping; they do not replace the model checker
  (`scripts/model-check.mjs`) for the exhaustive counterpart, and they say
  nothing about liveness, only about what the deterministic machines accept.

## 5. Reproducing

```bash
# the artifact (18 min on a loaded 16-core host, ~11 min on an idle one)
npx tsx scripts/campaign/run-campaign.mjs --full --out docs/benchmarks/campaign-2026-11-11-v2.json

# the whole thing again, byte-identical except timestamps
npx tsx scripts/campaign/run-campaign.mjs --full --no-write

# the extension alone (2.5 min), split with --merge if a host cannot fit one run
npx tsx scripts/campaign/run-campaign.mjs --full --only escalationTransport,ledgerBarrier,bondAlgebra --no-write

# the CI path
npx vitest run __tests__/scale/scaleCampaign.test.ts   # 14 tests, ~6 s
npm test                                               # 1812 passed, 1 skipped, ~2 m
```

Determinism was verified for all three new campaigns by running each twice at
reduced size and comparing every counter: identical.
