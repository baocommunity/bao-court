# Campaign Report — 2026-11-10 → 2026-11-13

A consolidated account of the adversarial campaign run against the BAO Court
protocol and its host, from the release of `v0.10.2` to `v0.16.0`. Every claim
below points at a committed artifact, a merged PR, or a release tag. Where
something is *not* proven, the residual list at the end says so.

This report is the narrative companion to:

- `docs/REVIEWS_INDEX.md` — every review round, with severities and dispositions.
- `docs/EVALUATION.md` — the evidence table, updated per round.
- `docs/FROST_COURT_ORACLE_PAPER.md` — the paper (evidence and scope of
  verification; §11.6 is the methodology this campaign produced).

---

## 1. What was run

| Type | Count | Written up in |
|---|---|---|
| **Adversarial review rounds** (attack the last round's fixes) | 11 (rounds 2–12) | `docs/REVIEW_ROUND_{2..12}.md` |
| **Instrument rounds** (campaigns, mutation, determinism, ceremony, bonds, proofs, differential) | 14 (rounds 29–37, 51–54) | `docs/benchmarks/`, `docs/MUTATION_TESTING*.md`, `docs/TEST_DETERMINISM.md`, `docs/MULTI_PROCESS_CEREMONY.md`, `docs/LANE-PROJECTION.md`, `docs/proofs/07-*.md`, `docs/DIFFERENTIAL_WIRE.md` |
| **External-review responses** (GPT / Claude / Gemini) | 8 demand classes | `docs/REVIEW_RESPONSE_R23.md`, `R25` |
| **Sync rounds** (vendored mirror + client) | 15 | vendor `VENDORED.md` per release |
| **Continuous programs** (unattended, ~100 h) | 2 (rail soak; 6-hourly ceremony soak) | `docs/MULTI_PROCESS_CEREMONY.md` §"The continuous program"; host rail-soak series |
| **Releases** | 10 tags (`v0.11.0` … `v0.16.0`) | GitHub Releases |

The review rounds follow one rule that produced almost every finding in this
campaign: **attack the fix you just shipped, as an adversary who has read it.**
Each round's "targets" are the previous round's patches, not the original code.

---

## 2. What was found

Findings are graded `EXPLOITABLE` only when a test demonstrates the harm.
The ten most consequential, in order of when they were found:

1. **`concede` → `finalize` forged a verdict** (round 7). `concede` was a
   "stated non-reader" of the mass-vote barrier but walked into `finalize`,
   which read the vote ledger without it. Measured on `v0.13.2`:
   `FINAL outcome=MAYBE supported=3` on a case where both panels voted NO, with
   `upheld` caller-supplied and absent from the hash.
2. **The escalation bond priced membership, not consumption** (economics
   verifier, round 30). One bond funded every round (`ΔC = 0` instead of the
   `3^(r+1)·b₀` schedule); at the protocol cap **77 % of farming deterrence
   evaporated**. The shipped depth (R = 2) was fair only by accident
   (venue/griefer cost ratio 0.86×; 54.1× at R = 5).
3. **The bond was bound to the CASE, not the CHALLENGER** (round 29). A juror
   holding no bond could escalate on a bonded juror's accepted hash, and the
   audit log named the wrong person. The model checker's "independent" property
   had mirrored the same weak check — **it agreed with the bug**.
4. **The economic cap bound nothing** (round 2). Off by default; and when on,
   the arithmetic version of the rule refused the markets it existed to price.
   The predicate was right; the module reported the ratio as if it were the cap.
5. **Canonicalisation collisions, three times** (rounds 8, 9, 11). Unpaired
   surrogates, then `trim()` folding, then (inside the *new* code) parameter
   spelling — distinct identifiers collapsing to one digest.
6. **A signed concession hashed as an unsigned escalation** (round 10). The
   round-9 check was a *field* check; re-presenting the same signed concession
   with `concession:false` produced an escalation nobody signed.
7. **`ladder.round` vs `ladderRound`** (round 10). `finalize` read one field for
   the verdict and the other for the log; a skewed snapshot finalised round 2's
   YES over round 3's NO.
8. **The durable inbox could be made unrestorable** (transport round). One
   wrap delivered by 65+ relays exceeded the 64-source snapshot limit — no key
   needed, and every message lost on restart.
9. **A replay was blamed as equivocation** (round 54). A byte-identical
   redelivery was reported as equivocation and an honest juror blamed
   (`equivocatingJurors:[2]`, `duplicatesIgnored:0`), because the collapse
   compared parsed payloads **by reference** — false for two parses of one
   signed event, so the identical-duplicate branch could never fire. In a blame
   protocol a false accusation is a correctness bug, not a cosmetic one: in a
   bonded deployment it is the input to a slash. Identity is now the signed
   event id, collapsed before any blame reasoning.
10. **A barrier refused a legal host state** (v0.15.3, found by the *host* sync,
    not by us). The round-counter barrier required `ladderRound = 0` whenever no
    `ladder` object was present — true of every state the machine produces and
    false of the state a host persists, so **42 of 185** host court tests went
    red across 8 suites. Fixed by declared provenance (`projection:'lane'`) and
    a reader-aware rule; the third instance of the over-strictness class, and
    the first found by a consumer.

Plus: a live host bug found only by *running* the reducer — `challengerIdx: 0`
is outside every machine roster, so **every escalation would have been refused
in production** while the route's own pre-checks passed.

---

## 3. What shipped

Release ladder, each tag on `main` with a GitHub Release:

| Tag | Headline |
|---|---|
| `v0.11.0` | Lean 4 single finality, FROST attribution (Theorem 6), settlement-binding analysis, `confirmQuorum` ⌈2N/3⌉, proofs/economics/security artifacts, mutation campaign 1 (53 mutants), 1.17 M-unit corpora |
| `v0.12.0` | Machine-level escalate witness (host bypass closed), derived economic cap with γ single-sourced, deterministic simulation budget, provenance reconciliation |
| `v0.12.1` | Challenger-bound escalation bond, escalation-log verification at `finalize`, witness-aware model checking (3.87 M states / 60 M probes) |
| `v0.13.0` | Per-round bond (consumption, not membership), `deriveMaxLadderRounds`, penalty ageing paired with decay |
| `v0.13.1` / `v0.13.2` | Review-round-4 fixes; review rounds 5–6 fixes; mutation campaign 2; strict round-bond default for new deployments |
| `v0.14.0` / `v0.14.1` / `v0.14.2` | Escalation request transport; the finality-forgery fix; canonical ids and the host-binding requirement; review-round-9 fixes |
| `v0.15.0` | **Mechanised escalation layer** (42 Lean declarations, no `sorry`), exact BigInt ladder bound, **independent Python wire implementation + 100 k differential**, 10× campaign (1,587,000 units / 8,286,823 assertions) |
| `v0.15.1` | Review-round-11 fixes (escape totality, event-shape validation, the missed clawback reader) |
| `v0.15.2` | Review-round-12 fixes (the total echo path, the counters' write domain, the clip) |
| `v0.15.3` | **Over-strictness closed** (`projection:'lane'` + reader-aware counters, 42/185 host tests → 189/189) and the **determinism** work (no test asserts a duration; the ceiling is derived from the box) |
| `v0.16.0` | **Bond-gated ceremony** (`bondCheckGate.ts`, enforced before the roster), **stable juror identities** (`--juror-keys`, odd-Y refused), **replay is not equivocation** (identity = signed event id), plus the unattended ceremony soak |

Host (`bao.markets`) and client (`2140wtf`) were synced to each tag; the
vendored mirror is byte-exact modulo two documented transforms
(`package.json` version, `VENDORED.md`).

---

## 4. The evidence stack

Each layer checks the one beneath it.

| Layer | Artifact | Result |
|---|---|---|
| **Mechanised proof** | `proofs/lean4/` (4 modules, 42 declarations) | `safe_depth_bound` (`E[π](d) < 0 ↔ d < flipRound`, reduced to an integer inequality), `safe_monotone`, `unsafe_witness`, `one_hash_one_index`, `consumed_not_reused`, `rounds_consecutive`, `reachable_wellFormed`. **No `sorry`; axioms `propext` + `Quot.sound` only.** |
| **Model checking** | `proofs/mechanized/` (Quint + Apalache) | 58 scenarios, exhaustive depth 10/8, no violation |
| **State-space exploration** | model checker | 15 instances, 3,869,232 states, 213,521,172 applications, **60,020,684 illegal-witness probes with 0 accepted** |
| **Independent implementation** | `scripts/differential/wire_ref.py` | Written from the spec; reproduced the known-answer digest on first run. 100 k cases → **0 disagreements**, 51,252 accepted requests byte-identical |
| **Mutation testing** | `docs/MUTATION_TESTING*.md` | Campaign 1: 53 mutants / 18 classes. Campaign 2: +25 (v0.13 surface). Campaign 3: +23 (wire). Catches: 86.8 % → 96.0 % → 100 % post-closure |
| **Corpora** | `docs/benchmarks/SCALE_CAMPAIGN_V2.md` | 1,587,000 units / 8,286,823 assertions / 0 failures |
| **Fault soak** | `docs/benchmarks/SOAK_3DAY.md` | 30,000 settlements, 3 epoch boundaries, 32/32 assertions, with partitions, churn, restarts, witness storms, cursor rollbacks |
| **Distributed ceremony** | `docs/MULTI_PROCESS_CEREMONY.md`, `docs/DISTRIBUTED_CEREMONY.md` | N real OS processes, real DKG + signing over a relay; **Byzantine relay NO_EQUIVOCATION** (split views starve both halves — mechanism, not luck); then three separate hosts + relay + coordinator, k = 2 / k = 3 / a real `SIGKILL` over ssh |
| **Bond gate** | `bondCheckGate.ts`, `__tests__/bondCheckGate.test.ts`, `docs/MULTI_PROCESS_CEREMONY.md` §"The bond gate" | a seat costs a *proven* bond: typed refusal for every non-proof, enforced before the roster; three boxes × three bonds → one key, one **verified** signature; a spent bond → `ROSTER_BELOW_THRESHOLD` with no key and no signature |
| **Bond rails (public)** | host `bao.markets` #2616 (testnet4), #2597 (Liquid testnet), `scripts/court/verify-bond.mts` | **testnet4**: 3 × 100,000 sat court-locked 2-of-2 bonds from a real 0.00563475 tBTC deposit (block 161026), `BOND_RAIL_PROVEN`, `scriptBinding:"configured"`, two agreeing sources, slash spend validated (`testmempoolaccept allowed, vsize 137`) **not broadcast**. **Liquid testnet**: 3 × 100,000 sat court-locked, `blockstream` + `liquid.network` agreeing (one fail-closed `BOND_ORACLE_DISAGREEMENT` before they did) |
| **Continuous programs** | `docs/MULTI_PROCESS_CEREMONY.md` §"The continuous program"; host rail-soak series | rail soak 5-min / hourly / 6-hourly with boot-gap accounting and per-source health; 6-hourly ceremony soak with scenario rotation; running tally **1 rail bug / 8 harness bugs**, all regression-locked |
| **Determinism** | `docs/TEST_DETERMINISM.md`, `__tests__/determinism.test.ts` | 1,432 latency sites removed (1,383 implicit 5 s defaults + 49 literals + 8 fixed deadlines); 18 failing test-runs / 1,340 → **0 / 1,280**; the harness ceiling derived from the running box; the juror phase deadline now bounds silence |
| **Unit/integration** | suite | **2,029 passing / 1 skipped, 95 files** (v0.16.0) |
| **Contract** | `scripts/reproduce.sh` | 13 stages; `REPRODUCED` verdict; digit-exact model-check fixture |
| **Cross-check** | `scripts/cross-check.mjs` | **286 claims / 521 refs / 95.1 %**; dangling codes fail the build |

**Environment ranking applies to every rail claim in this repository.** The
network BAO's hosts run is a **private signet** (Bitcoin consensus rules, one
operator, a faucet we control); code and configuration keep the identifier
`demo` for it, so `demo` in an artifact name is this network, not a second
chain. Evidence from a **public** chain (testnet4, Liquid testnet,
`signet-public`) is stronger — external counterparties, an independent validator
set, an adversary who is not us — so the private signet is used only where the
public testnet does not carry the rail (today: Lightning, Cashu), and every
result from it is labelled `private signet`. Rail order follows the same
ranking: **Liquid on testnet** first — the bond/ceremony rail — then on-chain
**testnet4 / signet-public**, and Lightning/Cashu only on the private signet
until the public testnet runs them. **The bond rung is now proven on both
priority rails, on public chains**: court-locked 2-of-2 bonds on testnet4 and on
Liquid testnet, each verified by two independent sources and each spend-validated
by a signed, unbroadcast slash. What that does *not* prove is the **release**
step (host-mediated, PO-15), the **Liquid juror binding** (the covenant binds the
case while the on-chain 2-of-2 binds the juror — LJ-1, a parallel round), or any
form of decentralisation: the court key, the wallet and every box belong to one
operator, and the testnet4 relay node has no wallet, so that deposit came from a
human. Nothing in this report claims a *settlement* rail as proven. The paper's
full statement is §11.8.

---

## 5. The methodology (the reusable part)

`docs/REVIEWS_INDEX.md` names ten failure-mode classes that this campaign kept
rediscovering. They are the campaign's actual output, because they predict where
the next bug is:

1. **Trust-boundary pinning** — an unpinned consumer accepts anything (F-2, the
   client's fake `final`).
2. **State-restore divergence** — a restored snapshot passes a barrier
   (r29-2, r33-5, r37-1, r40-1/2).
3. **Bond / economic binding** — membership vs consumption (r30-1),
   one-hash-one-index (r38-1), preemption (r40-3).
4. **Report-vs-decision mismatch** — the number reported is not the number used
   (H-2, the ladder-bound off-by-one, the market cap).
5. **Over-strictness** — a barrier refuses a legal state (r37-1's mirror; closed
   by a 490-state legal-state hunt).
6. **Vacuity** — a test passes without asserting (F7, F8, r29-10, r9-5's own
   injectivity pin).
7. **Flood / eviction** — caps without provenance priority (client summons,
   the durable inbox).
8. **Attribution** — who may assert (r29-1, r40-3, Theorem 6).
9. **Canonicalisation** — attacker-controlled encodings must be canonicalised
   **once, per field, with an injectivity pin** (three instances).
10. **Measurement / instrument dependence** — the verdict depends on the load of
    the box or on a comparison that cannot fire (r54-1's reference comparison;
    the 5 s default; the absolute juror deadline). The instrument is not exempt
    from the evaluation.

Three further rules proved load-bearing: **grade `EXPLOITABLE` only with a
demonstrating test**; **never weaken a prior guarantee to make a new test
pass** (r55 implemented a fix, found it turned an earlier pin red, and withdrew
it); and **a false accusation is a bug** — a blame protocol that cannot
distinguish a replay from equivocation disqualifies an honest juror, so both
directions of the verdict are pinned, not only the one the threat model
emphasises.

---

## 6. Residuals — stated, not hidden

| Residual | Why it is open | Trigger that forces it |
|---|---|---|
| `concede` is host-API-enforced (not machine-witnessed) | Named residual, `SPEC §9.2` | the first deployment that needs witness-level concession |
| Bond ownership is not preempted (r40-3) | The witness is index-bound, not pubkey-bound | v0.14 machine API widening `challengerKeys` |
| **The Liquid covenant binds the case, not the juror (LJ-1)** | The on-chain 2-of-2 commits to the juror key; the Liquid bond lock commits to the case | the parallel round that adds the juror key to the Liquid bond lock |
| **A bond proves collateral at verification time, not future honesty** | A seat price, not a behaviour guarantee | inherent; the verdict's safety rests on the DKG/reveal gates and the threshold |
| **Settlement release is host-mediated (PO-15)** | v1 has the cohort authorise and the host release | the spend-session binding + the `CHECKSIGFROMSTACK` leaf |
| **The testnet4 relay node has no wallet** | So the bond deposit came from a human with an external wallet; no faucet this project controls | a funded, wallet-bearing public-testnet node |
| **One operator** holds the court key, the funding wallet, every ceremony box and the verifier's choice of sources | No independent counterparty; the ceremony is coordination, not decentralisation | an independent operator running a juror, a relay or a verifier |
| No unaffiliated external replication | Needs an outside evaluator | submission to a venue |
| Majority collusion is κ-bounded, not eliminated | Mechanism design, not a bug | — |
| Lightning rail has no slashing (α = 0) | Rail property | a staked Lightning rail |
| Authorship, venue/DOI | Not technical | the authors' decision |

---

## 7. Reproduce

```bash
git checkout v0.16.0
bash scripts/reproduce.sh          # 13 stages, prints VERDICT
npm test                           # 2,029 passing / 1 skipped, 95 files
node scripts/cross-check.mjs       # 286 claims / 521 refs
npm run campaign:full                                          # 1.59 M units / 8.29 M assertions
(cd scripts/differential && node run.mjs --profile full)       # 100 k cases, 0 disagreements
python3 scripts/differential/wire_ref.py --selftest            # the independent reference
(cd proofs/lean4 && ./run.sh)      # 42 declarations, no sorry
node scripts/court/multi-process-ceremony.mjs --matrix         # Byzantine relay matrix
npm run simulate:distributed                                   # three real boxes + relay
npm run soak:status                                            # the 6-hourly ceremony series
npx vitest run __tests__/bondCheckGate.test.ts                 # the bond gate's roster decisions
npx vitest run __tests__/determinism.test.ts                   # the static determinism guard
```

The two public-testnet bond runs are **not** regenerable from this repository:
they need funded coins, a court key and a chain verifier, all of which live in
the host (`bao.markets` PRs #2616/#2597). The artifacts record every public value
(outpoints, scripts, heights, sources) so a reviewer can re-check them against
the chains directly.
