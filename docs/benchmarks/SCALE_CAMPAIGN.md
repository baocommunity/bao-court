# SCALE CAMPAIGN — the "ten thousand times more tests" round

The largest corpus the Court has ever run: **1,171,000 seeded cases** (plus
100,000 chi-square trials) across six campaigns, **3,592,861 assertions**,
**zero failures**, in one 9.2-minute invocation. CI runs a bounded FAST
subset (7–20 s depending on host load) of every campaign; the FULL corpus is the standalone runner whose
committed artifact is `docs/benchmarks/campaign-2026-11-11.json`.

```
npm test                                          # FAST subset, part of CI
npx tsx scripts/campaign/run-campaign.mjs --fast  # FAST, prints the table + writes an artifact
npx tsx scripts/campaign/run-campaign.mjs --full  # FULL corpus (the artifact below)
npx tsx scripts/campaign/run-campaign.mjs --full --only tally,validator --merge   # documented split
```

Every number this document quotes comes from the committed artifact. Nothing is
declared-and-assumed: `declaredSizes` (what the round set out to run) and
`actualSizes` (what ran) are both in the JSON, and the summary table prints the
actual corpus size.

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
| **Total** | **1,171,000 units** | **3,592,861** | **0** | **550.3 s (9.2 min)** | |

### The runtime envelope

The declared FULL corpus takes **9.2 minutes of corpus wall time in ONE
invocation** (550.3 s; 9m12s end-to-end including tsx transpile and the artifact
write) on a 16-core host at load average ≈19. The same corpus took **18.7
minutes** earlier the same night under load average 30–50, so treat the envelope
as **9–19 minutes, host-contention dependent**: the wall numbers scale with the
machine, every counter, corpus size and failure count does not (two runs of this
corpus produced byte-identical metrics).

The runner supports the documented split when a host cannot fit one invocation —
`--only <a,b,c>` for each group, `--merge` into the same artifact — and records
each invocation (corpora, sizes, wall, failed checks) in the artifact's
`invocations` list. No split was needed for this artifact, and **no corpus size
was reduced**: `declaredSizes` and `actualSizes` are identical for all six
campaigns.

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

The runner exits non-zero on any failed check, so it is usable as a gate:

```bash
npx tsx scripts/campaign/run-campaign.mjs --full && echo GREEN
```
