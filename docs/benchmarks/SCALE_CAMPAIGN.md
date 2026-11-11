# SCALE CAMPAIGN — the "ten thousand times more tests" round

The largest corpus the Court has ever run: **1,187,000 seeded cases** (plus
100,000 chi-square trials) across **nine** campaigns, **3,745,566 assertions**,
**zero failures**, in one 10.1-minute invocation. The last three campaigns are the
round-29 extension for the v0.12.0 surface: the **escalate witness** (valid +
every illegal form), **cohort rotation** (epoch N vs N+1 batch finality), and
**verdict finality chains** (challenge windows → witnessed escalations →
batch-attested verdict). CI runs a bounded FAST subset (≈10–15 s of corpus
work for all nine campaigns, host-load dependent) of every campaign; the FULL
corpus is the standalone runner whose committed artifact is
`docs/benchmarks/campaign-2026-11-11.json`.

```
npm test                                          # FAST subset, part of CI
npx tsx scripts/campaign/run-campaign.mjs --fast  # FAST, prints the table + writes an artifact
npx tsx scripts/campaign/run-campaign.mjs --full  # FULL corpus (the artifact below)
npx tsx scripts/campaign/run-campaign.mjs --full --only tally,validator --merge   # documented split
npx tsx scripts/campaign/run-campaign.mjs --full --only witness,epochRotation,finality
npx tsx scripts/campaign/run-campaign.mjs --full --witnesses 50000 --chains 20000  # size overrides
```

Every number this document quotes comes from the committed artifact. Nothing is
declared-and-assumed: `declaredSizes` (what the round set out to run) and
`actualSizes` (what ran) are both in the JSON, and the summary table prints the
actual corpus size.

**Provenance note (N7, review round 2).** The merged body of PR #86 quotes a
different invocation than the artifact committed with it — 3,496,808 checks /
1,124 s across three merged runs, against 3,592,861 assertions / 550 s in one
invocation. The tree was never inconsistent; the PR text was, and it is immutable
history. The numbers in *this* page are the artifact's (and now the round-29
extension's), so this note is the correcting record rather than a rewrite.
Disposition: `bao.markets` `docs/operations/REGISTERED_FINDINGS_SWEEP.md`.

---

## 1. What each campaign proves

| # | Campaign | Unit | What is driven | Invariants asserted |
|---|---|---|---|---|
| 1 | `confirmation` | sequence | legal confirmation-machine event sequences: rosters 3..25, outcomes 2..5, quorum 1..roster, `maxLadderRounds` 1..3, challenge / ladder / escalate / concede / fee / clawback / tick / abort interleavings | **C1** no throw on a legal event; **C2** phase union + terminal set `{final, expired, aborted}`, plus the R25 quorum-policy flag (`quorumBelowSupermajority === confirmQuorum < ⌈2N/3⌉`) on every state; **C3** monotone clock ledger (`latestTimestamp === event.now`, unchanged by `abort`); **C4** freeze (shallow every step, depth-first on a 1-in-17 sample); **C5** final verdict recomputes (`hashCourtVerdict`), sorted supporting ids from the correct ledger, `upheld === (outcome === proposed)`, overturn flags every confirmer, `outcomeHistory` consecutive + flip-flop clawbacks; **C6** every rejection throws the machine's OWN typed error |
| 2 | `tally` | tally | plurality tallies finalized through the public vote-machine reducer over a valid `reveal_closed` ledger (2..50 participants) | winner and the **entire supporting-id sequence** equal the independent reduce-based oracle (`__tests__/reference/refTally.ts`, `Buffer.compare` UTF-8 ordering); sampled verdict-hash recomputation; 200 fully-driven control tallies per run (commit → reveal → finalize) |
| 3 | `merkle` | batch | Merkle batches of 1..2048 verdict hashes | **M1** production root AND leaf sequence equal the independent reference tree (array-slice RFC-6962 + `node:crypto`); **M2** duplicate-free leaves; **M3** root is a function of the SET (shuffled rebuild); **M4** every proof verifies (all for n ≤ 500, ≥ 10% strided for n > 500) under the independent record-and-replay verifier, plus bulk-vs-single proof parity; **M5** tamper matrix (path flip / truncate / extend, wrong index, wrong leaf) rejects |
| 4 | `validator` | event | real signed v2 attestation events (real Schnorr group signature + real publisher signature) through the recommended dispatcher with the full finality pin set | **ACCEPT** valid events in both kind shapes (kind-89 / kind-39007) with optional `attempt` / `batch` tags; **REJECT** 32 single-property tampers, each asserted to fail for its OWN reason (substring match on the returned error, not merely `valid === false`) |
| 5 | `selection` | draw | jury draws over rosters 3..500 in BOTH weight modes (`quadraticPriority` stake path and `weightFn` reputation path) | **S1** roster shape, 1..k indices, no duplicate pubkeys, members drawn from the pool; **S2** ascending priorities; **S3** determinism (same seed/roster/params → identical roster); **S4** `verifyJurySelection` accepts; **S5** top-k equals the independent reference ranking (`node:crypto` + `DataView`); **S6** weight proportionality by chi-square (df = 7, p = 0.001) |
| 6 | `encoding` | encoding | canonical `CanonicalWriter` field mixes (u8/u32/u64/text/hex/bytes, unicode + boundary payloads) | **E1** byte identity with the independent reference writer; **E2** re-encode identity; **E3** round-trip through the independent recursive-descent parser (`consumed === length`, values equal); **E4** injectivity on a single-field mutation + prefix-freeness between same-schema encodings; **E5** fail-closed boundaries on both writers |
| 7 | `witness` | witness | escalate-shaped events (v0.12.0 witness round) dispatched through the real reducer against REAL cases parked at `round_resolved` (rosters 3..7, quorum 1..N, 1..3 ladder rounds, 1..3 accepted bonds, break-glass policy on/off); 27-row matrix rotated, free fields randomised | **W1** every illegal witness throws the machine's OWN typed error; **W2** a rejected witness never moves the phase or the log (no reachable escalation); **W3** an accepted witness opens exactly the next round and appends exactly one frozen record matching the event (authority/idx/pubkey/request/bond/at); **W4** `escalationLog ≤ min(maxLadderRounds, MAX_LADDER_ROUNDS)` and the previous state is untouched (append-only); **W5** a foreign case's bond is refused (cross-case replay) and a second escalation in the same resolved round is refused; **W6** the frozen `hostEscalation` policy decides the host path (refused by default, logged with null challenger fields only under break-glass) |
| 8 | `epochRotation` | batch | kind-39018 batch attestations laid out across a cohort timeline (1 rotation every 25 batches, real per-epoch Schnorr keys derived from the seed) | **R1** rotations chain through `assertEpochRotationOrdering` (exactly +1 epoch, key must change, window must move forward) and same-key / skipped-epoch / backwards-window rotations are typed refusals; **R2** a valid batch verifies under its own `expectedEpoch`/`expectedCohort` and is refused under either neighbour's pins; **R3** an epoch-N batch re-signed by the N+1 cohort, and an N+1 event signed with the old key, both fail; **R4** cross-epoch re-batching of the SAME verdict hash by the successor cohort is legal and verifies in BOTH epochs (dedupe reputation by verdictHash); **R5** case membership proofs verify in their own batch and a borrowed proof authenticates nothing |
| 9 | `finality` | chain | whole case lifecycles driven through the reducer — challenge window → ladder rounds, each further round opened by a witness-bound escalation (challenger or break-glass host) → fee ledger → `final`; rotated with `aborted` / `expired` chains | **F1** `final` carries a verdict whose hash RECOMPUTES, `aborted`/`expired` carry a failure and no minted verdict; **F2** supporting ids are exactly the named finality ledger (confirmation ledger, or the last round's winning votes), sorted, non-empty; **F3** `upheld === (outcome === proposedOutcome)` + overturn flags every confirmer; **F4** `outcomeHistory` consecutive + flip-flop clawbacks; **F5** the witness log records every escalation played, consecutive from 2, matching its witness, never above the cap; **F6** batch finality (real manifest signature) verifies, wrong epoch pin and tampered proof/inputs are refused, `verifyCaseInBatch` accepts, and every terminal phase refuses a PERFECT escalation witness while a terminal tick changes nothing but the clock |

## 2. The corpus that actually ran

Profile `full`, seed `20261111`, artifact `docs/benchmarks/campaign-2026-11-11.json`.

| Campaign | Corpus | Checks | Failures | Wall | Notes on coverage |
|---|---|---|---|---|---|
| `confirmation` | **10,000 sequences** | 731,225 | 0 | 9.0 s | 96,053 legal transitions, 105,715 typed-rejection probes, 11,644 depth-first freeze audits; terminals final 2,618 / expired 6,809 / aborted 573; 1,266 ladder cases (326 multi-round, 327 escalated, 368 conceded), 572 overturns, 1,266 cases with an explicit round panel; per-sequence 0.59 ms median, 1.4 ms p95, 56.3 ms max |
| `tally` | **1,000,000 tallies** | 2,010,400 | 0 | 241.4 s | 400,018 forced exact ties (521,931 tallies decided by the tie-break); 820,897 ballots containing the UTF-16/UTF-8 divergence pair; 11.2M ledger entries, ledgers 2..50 (mean 11.2); 700,408 non-ASCII winners; 10,000 sampled verdict-hash recomputations; 200 fully-driven control tallies |
| `merkle` | **1,000 batches** | 151,538 | 0 | 44.5 s | 280,672 leaves (mean 281, max 2,048); every boundary size 1,2,3,4,5,7,8,9,1023,1024,1025,2047,2048; 86,309 independently verified proofs in 799 fully-checked batches; 6,200 bulk-vs-single proof parity samples; 45,829 tampered proofs, all rejected |
| `validator` | **50,000 events** | 50,000 | 0 | 243.9 s | real signatures: 25,000 accepted / 25,000 rejected across 34 distinct rows (~780 cases per tamper row); 16,667 kind-39007 dispute attestations, 15,768 batch-tagged, 17,648 attempt-tagged; 4,096 distinct field combos / 4,096 group signatures, 50,000 publisher signatures |
| `selection` | **10,000 draws** + 100,000 chi-square trials | 229,693 | 0 | 8.6 s | 5,000 quadratic + 5,000 weight-mode draws over rosters 3..500 (989,098 juror scans, mean 99); 200 determinism + 200 `verifyJurySelection` + 200 independent-ranking samples; chi² = 5.994 (critical 24.322, df 7, p = 0.001), max weight deviation 2.1% |
| `encoding` | **100,000 encodings** | 420,005 | 0 | 2.9 s | 34,283 unicode payloads, 9,444 empty payloads, 10,000 injectivity mutations + 10,000 prefix-freeness comparisons, 100,000 parser round-trips, 6.4 MB encoded, 9 fail-closed boundary probes × both writers |
| `witness` | **10,000 witnesses** | 28,880 | 0 | 2.4 s | 740 accepted witnessed escalations (740 log records, depth ≤ 2), 9,260 typed refusals / 0 raw errors, all 27 matrix rows fired; 371 cross-case bond replays, 370 duplicate-round probes, 370 hand-restored-cap probes, 1,483 oversized-value probes; 0.02 ms median, 0.049 ms p95, 0.94 ms max |
| `epochRotation` | **1,000 batches** | 15,139 | 0 | 68.3 s | 40 cohorts / 39 rotations; 4,460 cases batched, 1,000/1,000 valid batches; 2,000 epoch-pin refusals, 1,950 cohort-pin refusals, 1,950 re-signing refusals, 975 cross-epoch replays, 4,597 membership proofs, 2,536 borrowed-proof refusals; 24.6 ms median, 209 ms p95, 301 ms max (real Schnorr sign+verify per batch) |
| `finality` | **5,000 chains** | 108,686 | 0 | 16.5 s | 2,500 `final` + 1,250 `aborted` + 1,250 `expired` chains; 3,750 challenge windows, 1,902 witnessed escalations (224 break-glass host), 1,250 multi-round; 2,500 verdict recomputations + provenance checks + batch verifications + membership proofs + epoch-pin refusals, 5,000 tamper refusals, 5,000 terminal-witness refusals; 1,902 overturns and 1,902 round flips; 3.3 ms median, 8.8 ms p95, 18.9 ms max |
| **Total** | **1,187,000 units** | **3,745,566** | **0** | **608.8 s (10.1 min)** | |

### The runtime envelope

The declared FULL corpus takes **10.1 minutes of corpus wall time in ONE
invocation** (608.8 s; ~10m30s end-to-end including tsx transpile and the
artifact write) on a 16-core host at load average ≈8. The pre-extension
six-campaign corpus took **9.2 minutes** (550.3 s) on the same class of host and
**18.7 minutes** under load average 30–50, so treat the envelope as
**10–19 minutes, host-contention dependent**: the wall numbers scale with the
machine, every counter, corpus size and failure count does not (two runs of the
earlier corpus produced byte-identical metrics). The round-29 extension adds
**16,000 units / 152,705 assertions / 87 s** for the whole v0.12.0 surface
(witness 2.4 s, epoch rotation 68.3 s — real Schnorr per batch — and finality
16.5 s).

The runner supports the documented split when a host cannot fit one invocation —
`--only <a,b,c>` for each group, `--merge` into the same artifact — and records
each invocation (corpora, sizes, wall, failed checks) in the artifact's
`invocations` list. No split was needed for this artifact, and **no corpus size
was reduced**: `declaredSizes` and `actualSizes` are identical for all nine
campaigns.

### 2.1 Model checking with witness events (the exhaustive counterpart)

The campaigns above are statistical; the **exhaustive** counterpart for the same
v0.12.0 surface is the model checker (`scripts/model-check.mjs`,
`__tests__/modelCheckingCore.ts`), extended this round with the `escalate`
witness event. Two confirmation instances are NEW, and every confirmation
instance now probes the illegal-witness matrix at **every reachable state** (an
accepted illegal witness fails the instance outright):

| Instance | Concrete states | Event applications | Witness probes | Max `escalationLog` |
|---|---|---|---|---|
| `confirm n=3 q=1 r=2 escalate-witness challengers=1,2 [clock 6/12/14]` | 537,825 | 38,045,170 | 18,271,978 | 1 |
| `confirm n=3 q=1 r=3 host-escalation [clock 6/12/14]` | 182,265 | 12,805,030 | 6,188,788 | 2 |
| all six confirmation instances | 2,266,326 | 147,750,215 | 60,020,684 | 2 |
| **full sweep (15 instances)** | **3,869,232** | **213,521,172** | **60,020,684** | **2** |

Artifact: `__fixtures__/model-check-summary.json` (mode `full`, wall 2,525 s on
the 16-core reference host at load ≈8; the pre-witness sweep was 1,196 s /
134.8M applications, so witness probing is the sweep's dominant new cost). All
15 instances report `rawThrows = 0` and `illegalWitnessAccepted = 0`, and the
pairwise-distinct state-count guard (finding F7) passes. Two properties are
asserted structurally at every state, not sampled:

- **no illegal witness ever produces a reachable escalation** — the probe set is
  dispatched outside the transition graph and any acceptance is a hard failure;
- **`escalationLog` never exceeds `min(maxLadderRounds, MAX_LADDER_ROUNDS)`** —
  the explorer tracks the maximum observed depth per instance (2 at the deepest
  instance) and the state invariant re-checks the bound at every state.

## 3. Failures found

**Production bugs: none.** No campaign produced a single mismatch against any
independent oracle, no untyped error escaped any machine, no proof verified when
it should not have, and no tampered attestation was accepted.

**Campaign bugs: one, and it is worth recording** because it shows the matrix is
not self-satisfying. The `dispute-verdict-forgery` row forged the last hex digit
of the verdict hash with `endsWith('0') ? '1' : '2'` — for the ~1-in-16 combos
whose hash already ended in `2`, that mutation was a **no-op**, leaving a
genuinely valid event that the validator then (correctly) accepted. The campaign
caught it on the first full run: 37 of 50,000 events, every one in that row. The
mutation now uses `endsWith('0') ? '1' : '0'`, guaranteeing a different digit,
and the corpus was re-run green — the artifact committed here is that green run
(the failing run predates it and is described here, not hidden in the JSON).
The validator's behaviour was correct throughout; the expectation was wrong.

**Round-29 finding W-VACUOUS (test bug, caught before merge, worth recording
for the second time).** The new exhaustive escalation-witness instances fire an
"illegal witness was ACCEPTED" assertion, and that assertion caught the fixture
itself on its first run: the model-check witness values were **all-digit hex**
(`hex('7')` → `'7777…'`), so the matrix's "uppercase hex must be refused" row
produced a byte-identical **legal** witness — a probe that could never fire.
The fix is two-part: the witness fixtures now contain hex LETTERS
(`'ab'.repeat(32)` / `'cd'.repeat(32)`), and the campaign's casing probe uses a
letters-only literal so it cannot degenerate. This is the same failure class as
model-checking finding **F7** (a variant instance whose state space equals its
base instance's): an adversarial row that cannot distinguish itself from the
legal row proves nothing while the suite stays green. Both are now guarded —
F7 by the pairwise-distinct state-count check, W-VACUOUS by the
`illegalWitnessAccepted === 0` assertion being *reachable* (the explorer fails,
rather than silently passing, when a probe is really the legal event).

**Verified, not assumed (finality).** A tick at a terminal phase is an
ACCEPTED clock-only no-op — the machine's tick-exempt terminal rule — so the
finality corpus asserts that nothing but `latestTimestamp` can move (phase,
verdict, confirmation ledger, witness log, clawback ledger all byte-identical)
instead of asserting a throw. Any *non-tick* event at a terminal, including a
PERFECT escalation witness bound to the case's own accepted bond, is a typed
`CourtConfirmationTransitionError` — 5,000 chains × 1 witness each.

### 3.1 A corpus that is NOT here, and why (do not assume coverage)

`deriveCourtEconomicCap()` — the derived economic security cap (`V_max(N) =
γ·s₀·N` below the ⌈1/(γσ)⌉ threshold, unbounded above; 45 seats → 101,250 sats,
101,251 refused; γ = 0.45 → 112-seat threshold) — is **not exported by
`@bao/court`**. It ships in the consumer: `bao.markets`
`packages/markets/services/bao-markets/courtEconomicRatio.ts` (PR #2409,
commit `2c3c32554`), together with the shadow-mode gate and the
`ECON_RATIO_RUNBOOK`. A boundary corpus for it therefore cannot be built in
this repository — importing across repositories would make this suite depend on
a checkout it does not own, and re-implementing the rule here would test a
MIRROR of the predicate rather than the predicate, which is exactly the class
of vacuous coverage (§3, W-VACUOUS / F7). The 10k boundary corpus
(101,250 / 101,251 at 45 seats, the 111/112/114-seat threshold, the unbounded
region) belongs to the bao.markets campaign and is recorded here as **deferred,
not covered**.

## 4. What the sizes buy statistically

A campaign is only worth its name if the corpus makes specific failure modes
*probable to observe*. Per campaign, the sizes buy:

- **Confirmation — 10,000 sequences, 96k legal transitions, 105k hostile
  probes.** The machine has 11 phases and a 5-round ladder cap; the reachable
  interleaving space at this configuration is far beyond enumeration, and the
  previous property suite sampled 400 sequences. With N = 10,000 sequences, a
  fault that a *random sequence* triggers with probability p is caught with
  probability 1 − (1 − p)^N: p = 10⁻³ → >99.99%, p = 10⁻⁴ → 63%, p = 10⁻⁵ →
  9.5%. Every honour path is hit hundreds of times (the rarest, multi-round
  escalation, 326 times), so no single path can hide behind aggregate counts.
- **Tally — 10⁶ tallies.** Winner selection is a 2..8-way plurality with a
  byte-order tie-break. The interesting cases are *ties*: the campaign forces
  them in 40% of draws and observed 521,931 tallies actually decided by the
  tie-break, of which 820,897 ballots contained the astral/BMP pairs whose
  UTF-16 and UTF-8 orders disagree (U+1F600 vs U+FFFF and U+10FFFF vs U+FFFF).
  700,408 winners were non-ASCII, so the byte-order path is the common path, not
  a corner case. A tie-break written with JavaScript's default string order
  fails on the first divergent pair — the chance of never drawing one is ~0.
- **Merkle — 1,000 batches over the full 1..2048 range.** The RFC-6962
  unbalanced split is only interesting where n is not a power of two; the
  log-uniform size draw plus forced neighbours (1023/1024/1025, 2047/2048)
  rotates the split shape across every level. 86,309 proofs were verified
  independently (799 batches checked in full) and 45,829 tampered proofs were
  rejected; a sibling-order or direction bug in any one split shape fails on the
  first proof that touches it.
- **Validator — 50,000 signed events over a 32-row matrix.** Each row is a
  distinct rejection *reason*; 50,000 events give ~750–790 cases per row, so a
  row whose tamper is only caught on some field combinations (unicode, boundary
  lengths, threshold 1 vs 5) is exercised hundreds of times. Because the error
  must match the expected substring, a validator change that rejects for the
  *wrong* reason (e.g. catching a divergence at a pin instead of the consistency
  table) fails just as loudly as one that accepts.
- **Selection — 10,000 draws over rosters 3..500 + 10⁵ chi-square trials.**
  Determinism failures and duplicate selections are roster-size-dependent (the
  pubkey tie-break only matters at scale); 989k juror scores cover every roster
  size from 3 to 500 in both weight modes. The chi-square over 10⁵
  single-winner trials detects a weight-law deviation of a few percent at
  p = 0.001 (observed 5.994 vs critical 24.322; the largest per-juror deviation
  was 2.1%).
- **Witness — 10,000 witness events over a 27-row matrix.** The witness
  guard is a conjunction of six independent checks (phase, ladder cap, round
  index, roster membership, hash shape, bond binding, policy), so a defect in
  any ONE of them is a single-field mutation of a legal event. With
  10,000 units every row is drawn hundreds of times
  (740 accepts, 9,260 typed refusals, 27 distinct
  row/outcome pairs), the accepted witnesses append 740 real log
  records (depth ≤ 2), and the adversarial rows
  (`cross-case-bond-replay` 371, `duplicate-round-same-case`
  370, `hand-restored-cap` 370, oversized values
  1,483) each fire. A single missed guard fails on the first unit
  that draws its row — the accept rows make "the legal move still works" part
  of the same corpus, so a fail-closed-everything regression cannot pass.
- **Epoch rotation — 1,000 batches over 40 cohorts
  (39 rotations).** The epoch/cohort binding is exercised in both
  directions on every batch: own pins accept, both neighbour epochs' pins
  refuse (2,000 epoch-mismatch refusals, 1,950 cohort-mismatch
  refusals), the N+1 cohort re-signing an N batch and the old key signing an
  N+1 event both fail (1,950 refusals), and cross-epoch re-batching of
  the same verdict hash is proven LEGAL and independently verifiable
  (975 replays, 4,597 case proofs). A rotation bug that accepts
  a same-key successor fails on the first rotation row; a pin bug that accepts
  a neighbour epoch fails on every batch.
- **Finality — 5,000 chains.** 2,500 `final` chains,
  1,250 aborted chains, 1,250 expired chains, 3,750
  challenge windows, 1,902 witnessed escalations (224 break-glass),
  1,250 multi-round chains. Every final chain re-derives its verdict
  (2,500 recomputations, 2,500 provenance checks,
  2,500 batch verifications, 2,500 membership proofs,
  2,500 epoch-pin refusals, 5,000 tamper refusals), and every
  terminal chain plays a PERFECT escalation witness that must be refused
  (5,000 refusals). 1,902 chains overturn the proposal and
  1,902 round flips drive clawbacks, so the "finality is a path property"
  claim is tested on paths that actually flip.
- **Encoding — 10⁵ encodings.** Injectivity and prefix-freeness are
  *per-pair* properties; 10⁵ encodings with 10⁴ mutation pairs plus unicode and
  empty payloads make an ambiguity between two field boundaries effectively
  certain to surface. The independent parser round-trip means the claim is not
  "the writer is self-consistent" but "an independent implementation of the
  grammar can read it back exactly".

**What the sizes do NOT buy** (stated so nobody over-claims):

- Statistical campaigns cannot prove a *∀* property; exhaustive model checking
  (`scripts/model-check.mjs`) and the differential suite remain the proof
  artefacts. This round is a probability amplifier, not a replacement.
- The tally corpus reaches `finalize_tally` over a ledger that is *built* rather
  than *replayed* through `accept_commit`/`accept_reveal`: the reducer's own
  `assertValidRevealLedger` barrier re-derives every commit hash and re-checks
  roster membership, outcomes, and id uniqueness, so the ledger is validated
  input — but the event-replay path itself is covered by a 200-case control
  sample per run, not by all 10⁶ cases. The reason is cost, not convenience:
  replay is quadratic in ledger size and would cap the corpus at ~10³ tallies.
- The validator corpus reuses one group signature per distinct field combo
  (4,096 combos). The group signature binds only the protocol fields, so this is
  protocol-faithful, and each event still carries its own publisher signature
  and its own validation — but the number of *distinct signed messages* is
  4,096, not 50,000.
- The confirmation invariant battery samples the full depth-first freeze audit
  (1 in 17) and the full hostile probe set (1 in 11) rather than running them on
  every transition; the cheap invariants (phase, clock, terminal set, freeze of
  the exported graph) run on every transition.

## 5. Reproducing

```bash
npm ci
npx tsx scripts/campaign/run-campaign.mjs --full --out /tmp/campaign.json
```

The run is deterministic in `(profile, seed)`: every campaign derives its
streams from `childRng(seed, label)`, every key in the validator campaign is
`sha256('BAO-Court/scale/<seed>/<label>')` (no CSPRNG), and no assertion depends
on the clock. Wall times will differ; every counter, corpus size and failure
count will not.

Per-campaign size overrides exist for the documented split (`--sequences`,
`--tallies`, `--batches`, `--events`, `--draws`, `--encodings`, `--witnesses`,
`--rotations`, `--chains`); the artifact records `declaredSizes`,
`actualSizes` and every invocation.

The runner exits non-zero on any failed check, so it is usable as a gate:

```bash
npx tsx scripts/campaign/run-campaign.mjs --full && echo GREEN
```
