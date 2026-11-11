# SCALE CAMPAIGN V2 — an order of magnitude more corpus on the v0.14 surface

The Court's corpus, extended by an order of magnitude **on its newest surface**.
v0.14.x shipped two things: the challenger **escalation-request transport** (a
versioned wire codec, `courtEscalationRequest.ts`) and the **concede/finalize
barrier** (r41-1, the four restore-time ledger barriers). This round adds three
campaigns over exactly that surface and re-runs the whole corpus in one
invocation.

| | before (v0.13 round) | after (this round) | growth |
|---|---|---|---|
| campaigns | 9 | **12** | +3 |
| corpus units | 1,187,000 | **1,587,000** | +400,000 (×1.34) |
| assertions | 3,745,566 | **8,286,823** | +4,541,257 (×2.21) |
| failures | 0 | **0** | — |
| one-invocation wall | 608.8 s | **2,018.7 s** at load 47–62 | ×3.3 |
| one-invocation **CPU** | — | **987.2 s** (16.5 min) | ≈×1.6 |

The **extension itself** is the order-of-magnitude step. Round 29 added 16,000
units / 152,705 assertions for the whole v0.12.0 surface; this round adds
**400,000 units / 4,540,517 assertions** for the v0.14 surface — **×25 units,
×30 assertions** on the same surface class.

Artifact: `docs/benchmarks/campaign-2026-11-11-v2.json` (profile `full`, seed
`20261111`, **one** invocation, `declaredSizes === actualSizes` for all twelve
campaigns, `failedChecks = 0`). `docs/benchmarks/campaign-2026-11-11.json` and
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
| 10 | `escalationTransport` | request | one challenger escalation request through the **whole transport**, in host order: `build` / `parse` → `serialize` → `parse` → `escalationRequestToMachineEvent` → `reduceCourtConfirmationMachine`. A **93-row** wire matrix (11 accept / 82 reject) rotated over a pool of **32 real driven cases** (ladder round 1..4 × strict/legacy × break-glass/default × roster 3/5) | **T1** no raw throw escapes any stage — every refusal is the codec's own `CourtConfirmationTransitionError`; **T2** the accept/refuse decision matches the row's expectation at the row's stage (wire / binding / reducer), and the object entry point and the text entry point agree on every payload except the duplicate-key rows, where the defect is unrepresentable in an object; **T3** `parse(serialize(r))` reproduces the preimage AND the exact bytes; **T4** DIGEST INJECTIVITY over every accepted request in the run (digest → canonical preimage map; a repeated digest with a different preimage is the r7 H-6 / r8-1 collision), plus the fixed 9-field preimage arity; **T5** no accepted request carries a claim the host binding contradicts (pubkey, case id, round, digest, bond owner, per-round witness); **T6** a mapped event either opens exactly the next round with one frozen record carrying the request's per-round witness, or is a typed refusal — never a silent no-op; **T7** the demonstrated hazards are real (`TextEncoder` maps a lone surrogate and U+FFFD to identical bytes; NFC ≠ NFD; the `'-'` sentinel is the absent-bond slot and no hex32 can equal it) |
| 11 | `ledgerBarrier` | restored state | one `CourtConfirmationMachineState` through **every applicable barrier** — `assertValidConfirmationLedger`, `assertValidOutcomeHistory`, `assertValidEscalationLog`, `assertValidMassVoteLedger` — in both directions: a **reachable** state (captured by driving the real machine; 643 states across all 11 phases) and a **forged** one drawn from a 5,984-cell grid (11 phases × 17 log shapes × 8 challenge-ledger shapes × strict/legacy × host/default) | **B1** no false refusal — every reducer-reachable state is ACCEPTED by every applicable barrier (a barrier that refuses a restorable snapshot bricks a live case; r37-1 was exactly that); **B2** the accepted set is **exactly** the legal set — each barrier's verdict must equal an independent oracle written in the campaign from the invariant text, not from the product code, and the count is reported; no refusal may be untyped |
| 12 | `bondAlgebra` | sequence | one **legal** escalation sequence: a 7-seat case driven to `round_resolved`, then climbed to round `R` (drawn 1..5) with witnessed escalations, probing the illegal presses at every rung — challengers drawn 2..5 from the 7-juror roster over a bond pool with **deliberate collisions** (repeated txids) | **A1** one hash, one index — presenting an accepted bond witness for a second juror is a typed refusal and the ledger keeps one owner; **A2** no re-consumption — replaying a consumed per-round witness, quoting a membership bond as the round's payment, replaying the round index, or pressing `host` without the frozen break-glass policy are all typed refusals that never grow the log; **A3** rounds strictly increase (`2..L` consecutive, `ladderRound` +1 per accepted press); **A4** the ΔC schedule equals the geometric series — `escalationBondMultiple(e) === 3^e` and `cumulativeLadderBondMultiple(L−1) === (3^L − 1)/2`, checked against the closed form rather than against the package's own table; **A5** consumption-count parity — reaching round `L` consumed exactly `L−1` distinct witnesses, none a membership bond; **A6** typed errors only |

The campaigns keep the run's rules: they are DETERMINISTIC in `(seed, size)` (no
clock, no CSPRNG, no I/O), they RECORD failures instead of throwing, and they
report the corpus size that actually ran.

Because the campaign targets the newest code, it re-checks the round-9 fixes as a
side effect: exact case ids (r9-1 — padded ids and NBSP-padded ids are refused,
on the request **and** on the host's binding), `bondTxid` bound to the challenge
record (r9-2), and the concession refusal (r9-3) each have their own matrix row.

## 2. The corpus that actually ran

Profile `full`, seed `20261111`, artifact `docs/benchmarks/campaign-2026-11-11-v2.json`,
**one invocation**, `failedChecks = 0`, `actualSizes === declaredSizes`.

| Campaign | Corpus | Checks | Failures | Wall | Notes on coverage |
|---|---|---|---|---|---|
| `confirmation` | **10,000 sequences** | 731,225 | 0 | 2.9 s | unchanged campaign, re-run |
| `tally` | **1,000,000 tallies** | 2,010,400 | 0 | 166.4 s | unchanged campaign, re-run |
| `merkle` | **1,000 batches** | 151,538 | 0 | 23.7 s | unchanged campaign, re-run |
| `validator` | **50,000 events** | 50,000 | 0 | 463.6 s | unchanged campaign, re-run (real signatures) |
| `selection` | **10,000 draws** (+100,000 χ² trials) | 229,693 | 0 | 69.3 s | unchanged campaign, re-run |
| `encoding` | **100,000 encodings** | 420,005 | 0 | 11.6 s | unchanged campaign, re-run |
| `witness` | **10,000 witnesses** | 29,620 | 0 | 15.2 s | unchanged campaign, re-run |
| `epochRotation` | **1,000 batches** | 15,139 | 0 | 160.9 s | unchanged campaign, re-run |
| `finality` | **5,000 chains** | 108,686 | 0 | 124.6 s | unchanged campaign, re-run |
| `escalationTransport` | **200,000 requests** | 473,139 | 0 | 63.1 s | 144,087 wire refusals / 55,913 wire accepts; 15,057 mapped events, 40,856 binding refusals; the reducer accepted 10,755 and refused 4,302 (the strict-case, membership-bond-relabel and concession rows); **189,245 typed refusals, 0 raw errors**; 73,121 distinct request digests with **0 collisions**; 12,906 surrogate-hazard probes; all **93** matrix rows fired; 0.043 ms median, 0.17 ms p95, 12.0 ms max (idle-host measurement) |
| `ledgerBarrier` | **100,000 states** | 700,832 | 0 | 113.2 s | 350,416 barrier runs on reachable states — **0 refusals**; 350,416 barrier runs on forged states — 276,530 accepted / 73,886 refused, and the oracle said legal/illegal on exactly those numbers (**0 disagreements**, 0 untyped refusals); all **5,984** grid cells visited; stock 643 reachable states across **all 11 phases**; the ladder-only mass-vote barrier ran 50,416 times; 0.10 ms median, 0.28 ms p95, 11.0 ms max (idle-host measurement) |
| `bondAlgebra` | **100,000 sequences** | 3,366,546 | 0 | 800.9 s | 200,210 legal escalations accepted; **772,499 illegal probes, every one a typed refusal** (200,210 membership-bond relabels, 200,210 round rewinds, 112,105 re-consumption replays, 159,974 host presses without the policy, 100,000 duplicate-bond-owner claims); 1,601,050 consumption checks + 600,630 schedule checks; target rounds 1..5 all exercised (~20,000 sequences each), deepest rung reached 5; 1.01 ms median, 2.69 ms p95, 10.3 ms max (idle-host measurement) |
| **Total** | **1,587,000 units** | **8,286,823** | **0** | **2,018.7 s (33.6 min)** | |
| *of which this round* | *400,000 units* | *4,540,517* | *0* | *977.2 s* | the v0.14 surface |

### 2.1 The honest comparison to the old numbers

| | units | assertions |
|---|---|---|
| round-29 extension (v0.12 surface) | 16,000 | 152,705 |
| **round-46 extension (v0.14 surface)** | **400,000** | **4,540,517** |
| ratio | **×25.0** | **×29.7** |

The *whole* corpus therefore grows ×1.34 in units and ×2.21 in assertions. The
order-of-magnitude claim is about the newest surface, which is where the new code
is and where the marginal coverage matters; the older campaigns (`tally`,
`validator`) dominate the total and were deliberately not re-scaled — re-running
them unchanged is what makes the before/after comparable.

### 2.2 The runtime envelope — and why the committed wall number is inflated

The committed artifact took **2,018.7 s of corpus wall time in one invocation**
(33m39s end-to-end) because the 16-core host was **4× oversubscribed by parallel
agent sessions** during the run: load average 47 → 62, against 11.9 → 22.2 for the
same corpus an hour earlier. The corpus's own cost did not move. Two runs of this
exact corpus on this host:

| run | code | load average | wall | process **user CPU** |
|---|---|---|---|---|
| A | v0.14.1 + 91 rows | 11.9 → 22.2 | **1,097.9 s** | **958.9 s** |
| B (committed) | v0.14.2 + 93 rows | 47 → 62 | **2,018.7 s** | **987.2 s** |

Wall time nearly doubled; CPU time moved by 3 %. Every counter that the corpus
*computes* is byte-identical between runs (see §5); only the clock is not. So:

- **the number to budget with is the CPU time: ≈16 minutes** for the full corpus,
  of which the extension is ≈2.5 minutes (dominated by `bondAlgebra`, which drives
  up to five real ladder rounds with real bond consumption per sequence);
- **wall time is 11–34 minutes**, host-contention dependent, and the legacy nine
  campaigns are the volatile part (396.8 s at load ≈6, 951.2 s at load ≈22–62),
  because `validator` and `epochRotation` do real Schnorr signing per case.

The FAST profile is unchanged in practice: all twelve campaigns' FAST sizes cost
**5.9–10.7 s of corpus work in total** (measured at load ≈4 and load ≈22
respectively; the three new campaigns contribute ≈0.3–0.5 s of it), and the whole
`npm test` suite is **2 m 16 s** (1856 passed, 1 skipped, 85 files). `--fast`
writes a `-fast`-suffixed artifact so it can never overwrite the round's
committed full record.

## 3. Findings

Two. One is a **defect in the product**, found by campaign 10 and — as it turned
out — found and fixed independently by review round 9 in the same release window;
this PR therefore ships **no product change** and keeps the repro as an
independent regression lock. The other is a bug in the campaign scaffolding,
fixed here.

### 3.1 PRODUCT — a signed concession was minted as an escalation (found here, fixed upstream as r9-3)

Found by campaign 10 while building the transport matrix. `CourtEscalationRequest`
carries `concession: boolean`, documented as *"True when the challenger DROPS the
appeal (concede, never blocked)"*, and it is a **signed** field: it sits in the v2
hash preimage and r8-3 made it a strict boolean precisely because *"a coerced
`true` → `false` flips a signed field"*. On v0.14.0/v0.14.1,
`escalationRequestToMachineEvent` never read it.

Measured on v0.14.1: a request built and hashed with `concession: true` — and
re-parsed from its own canonical wire text, so re-encoding cannot launder it, and
with the digest differing from the escalate form — came back from the only mapper
as `{ type: 'escalate', roundIndex: 2 }`. The reducer **accepted** it: the case
moved to `ladder_pending`, a fresh per-round bond witness was consumed in the
challenger's name, and the append-only `escalationLog` recorded **that challenger
as the escalator**. That is the r8-2 attribution harm (a non-escalator written
into the permanent log) reproduced one signed flag over, and it inverted the
single press a concession exists to prevent. The digest being correct makes the
contradiction provable *afterwards*, which is mitigation, not a defence — the
rung was already opened and the bond already spent.

**Disposition.** Review round 9 found the same defect from the outside and fixed
it in v0.14.2 as **r9-3**, with the same remedy this campaign arrived at
independently: a typed refusal that routes a concession to `concede` (a concession
must never be blocked, and SPEC §9.2 ESC-RIGHT-3's *witnessed* concede remains the
open item it already was). This PR ships **no product change** — the corpus
commit is rebased onto v0.14.2 and keeps:

- `__tests__/findingR46.test.ts` — the repro, reframed as an **independent
  regression lock** (2 of 4 tests red on v0.14.1, all 4 green on v0.14.2). It is
  kept precisely because the corpus found it without reading the review;
- the `concession-must-not-escalate` row in the wire matrix, so the corpus keeps
  it locked at 200,000-request scale.

That two independent routes converged on the same defect, the same harm and the
same remedy is the useful datum here; the campaign verifies the fix rather than
claiming it.

### 3.2 CAMPAIGN — the timing summary could not survive 200,000 samples (fixed here)

`timingMetrics` (the shared per-unit timing summary in
`__tests__/scale/corpus.ts`) computed its maximum as `Math.max(...samples)`. The
spread materialises every sample as a call argument, so above roughly 125k samples
it throws `RangeError: Maximum call stack size exceeded` — in the *summary*, after
the corpus has already run. The first FULL invocation of this round died exactly
there (nine legacy campaigns green, `escalationTransport` finished its 200,000
requests in 18.2 s and then blew up writing their timing line). No legacy campaign
records one sample per unit at that size, so nothing had ever hit it.

**Fix:** fold the maximum instead of spreading it. Regression lock:
`__tests__/scale/scaleCampaign.test.ts` › *"scaffolding: summarises a
250,000-sample timing array without blowing the argument limit"* (red before the
fold, green after), which also pins the empty-sample behaviour.

### 3.3 What was NOT found

No digest collision, no accepted request that contradicts its host binding, no
barrier that refused a reducer-reachable state, no barrier that accepted a state
its independent oracle called illegal, no re-consumable bond witness, no round
that skipped or rewound, and no schedule that disagreed with `3^R`. Every one of
the **1,035,630 typed refusals** across the three campaigns (`189,245` transport +
`73,886` barrier + `772,499` bond) carried the machine's own error type
(`rawErrors = 0` in all three).

## 4. What this corpus does and does not cover

**It covers.** The transport's fail-closed decision on 93 wire shapes including
every field boundary and every injected defect the r7/r8/r9 reviews named; the
injectivity of the request digest over 73,121 distinct accepted requests; the
mapping's binding of every claim the reducer cannot check; the reducer's
enforcement of the per-round bond through the wire; all four restore-time barriers
over a 5,984-cell state grid in both directions; the bond ledger's
one-hash-one-index, no-re-consumption and strictly-increasing-round discipline over
200,210 real escalations; and the package's own `ΔC` schedule against the
closed-form geometric series.

**It does not cover** (stated so the claim cannot be read wider):

- **Authentication.** NIP-98 itself is never exercised. The campaigns hand the
  mapper the `CourtEscalationBinding` the host is supposed to have proved; that
  the host proves it correctly is outside the package and outside this corpus
  (registered as r9-6: the binding is a trust anchor, and a host that fills
  `authenticatedPubkey` from the wire reproduces the pre-r8-2 harm exactly).
- **Replay across time.** `signedAtSec` is carried and hashed but nothing here
  imposes a freshness window — that is host policy. The corpus asserts only that a
  request cannot cross a *case* or a *round*.
- **The object-path asymmetry.** A host that `JSON.parse`s a body and hands the
  object to the codec loses duplicate keys; only the text scan can see them.
  Campaign 10 asserts the asymmetry exists (3 rows) rather than pretending it does
  not, and the module documents it. Duplicate-key refusal is therefore a property
  of *the text entry point*.
- **Phase legality.** The four barriers are per-ledger. Whether a given phase may
  legally *hold* a given ledger is the reducer's phase guard, covered by campaigns
  1 and 9, not by campaign 11.
- **The oracle's independence is bounded.** Campaign 11's oracle is written from
  the invariant text in the campaign file rather than from the product code, but
  the same author wrote both, so a shared misreading of the invariant would
  produce a green campaign. The two acceptable defences — reading the text
  independently, and expecting the *reducer* to disagree with the barrier
  somewhere — are used where they exist; this is the same caveat the `tally`
  (reduce oracle) and `merkle` (`node:crypto` reference tree) campaigns carry.
  (Round 49's independent Python reimplementation of the wire,
  `scripts/differential/`, *is* a language-and-author-independent oracle; it
  covers the codec, not the barriers.)
- **Amounts.** Campaign 12 asserts the machine's *consumption* discipline and the
  package's schedule table. It cannot assert that a host actually charges
  `3^R · b₀` — the amounts are host-side and outside the package.
- **Bond ownership.** One-hash-one-index is enforced; whether the juror that
  registered a witness *owns* the bond is the host verifier's check (r40-3, not
  preempted by anything here).
- **Statistical strength.** These are seeded corpora, not proofs. They raise the
  cost of a regression escaping; they do not replace the model checker
  (`scripts/model-check.mjs`) for the exhaustive counterpart, and they say nothing
  about liveness, only about what the deterministic machines accept.

## 5. Reproducing

```bash
# the artifact (≈16 min of CPU; 11–34 min wall depending on host contention)
npx tsx scripts/campaign/run-campaign.mjs --full --out docs/benchmarks/campaign-2026-11-11-v2.json

# the whole thing again, byte-identical except timestamps
npx tsx scripts/campaign/run-campaign.mjs --full --no-write

# the extension alone, split with --merge if a host cannot fit one run
npx tsx scripts/campaign/run-campaign.mjs --full --only escalationTransport,ledgerBarrier,bondAlgebra --no-write

# the CI path
npx vitest run __tests__/scale/scaleCampaign.test.ts   # 14 tests, ~7 s idle / ~33 s loaded
npm test                                               # 1856 passed, 1 skipped, ~2 m
```

**Re-generability, checked rather than claimed.** Every counter, unit, check,
failure and note is reproducible from `(profile = full, seed = 20261111)`:

- `escalationTransport` re-ran at full size against the shipping code and
  reproduced **all** of its 200,000 units, 473,139 checks and 16 metrics
  identically;
- `ledgerBarrier` (700,832 checks) and `bondAlgebra` (3,366,546 checks) produced
  **identical** numbers under two different code versions (v0.14.1 and v0.14.2)
  and two very different host loads — so their counters are independent of both
  the rebase and the contention;
- all three were additionally run twice at reduced size and compared counter by
  counter: identical.

Only the wall-clock fields differ between runs, and §2.2 shows why.
