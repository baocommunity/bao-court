# BAO Court — Symposium Talk Outline (30 minutes)

**Version:** round 16 (presentation artifacts) · tracks `@bao/court` v0.10.2 ·
**Companion:** [`FIGURES.md`](FIGURES.md) (F1–F6) · [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md)

---

## 0. The one-sentence contribution statement

The thing you say when they ask *"so what is this?"* — three variants, same
protocol, three doors in:

**Protocol-first.**
> BAO Court is a just-in-time FROST threshold oracle for prediction-market
> disputes: a jury drawn by public verifiable lottery runs distributed key
> generation so no party — including the platform — ever holds the group
> secret, votes under commit–reveal, and produces a single ordinary Schnorr
> signature over the frozen verdict that any third party can verify.

**Engineering-first.**
> BAO Court is a platform-neutral TypeScript reference implementation of a
> threshold dispute oracle whose every claim is machine-checked: 145
> first-order invariants extracted from the actual guards, a 3.1-million-state
> exhaustive model-check sweep with zero untyped throws, differential parity
> against independent reimplementations with zero disagreements, and a
> one-command reproducibility contract that regenerates all of it from a
> clean clone.

**Economics-first.**
> BAO Court prices dispute resolution like a market: jurors are drawn by an
> unpredictable quadratic lottery, paid and slashed by an integer-exact
> deterministic ledger, and a bond-witnessed challenge opens a ×3-per-round
> escalation ladder whose cumulative cost rises from 4× to 364× — making
> bad-faith griefing superlinearly expensive while juries form only when a
> dispute actually exists.

**Which variant when:** protocol-first for cryptographers; engineering-first
for the "is it real?" question (it pairs with the live demo); economics-first
for the "why not just a committee/Kleros?" question. Lead with protocol-first;
the other two are held in reserve for Q&A.

---

## 1. The arc at a glance

| Segment | Time | Section | Figures | Demo |
|---|---|---|---|---|
| (a) The problem | 0:00–3:30 | §2 | F1 | — |
| (b) The protocol | 3:30–11:00 | §3 | F1, F2, F3 | simulate:court (5-min script §4 of DEMO_SCRIPT) |
| (c) Formal results | 11:00–17:00 | §4 | F2, F3 | model-check (live, 1s) |
| (d) Security argument | 17:00–22:00 | §5 | F5 | — |
| (e) Evaluation | 22:00–27:00 | §6 | F4 | cross-check + reproduce VERDICT |
| (f) What's next | 27:00–30:00 | §7 | — | — |

Slide budget: **14 slides + 1 live demo slide** ≈ 2 min/slide average.

---

## 2. (a) The problem — agentic / cryptographic dispute resolution

### Slide 1 — "Every prediction market has a judge"
- Centralized operators concentrate three powers: **resolution, custody, appeal** (paper §1.1).
- Even custody-decentralizing protocols typically keep a **single-key oracle** and a server-administered dispute fallback.
- For *agentic* markets (AI traders, no human watching) the dispute oracle is the trust root — a single key is a single point of compromise and coercion.
- Goal state: resolution authority that is **threshold, just-in-time, publicly verifiable, and self-custody-preserving**.
- *Artifact:* paper §1.1–1.2 (desired-properties table).

### Slide 2 — "Why threshold signatures, not committees or tokens"
- **vs. script multisig (committee):** M-of-N FROST emits **one** BIP-340 signature under **one** key — on-chain cost and privacy, native absentee tolerance, Taproot-compatible, one curve shared by Bitcoin/Liquid/Lightning (paper §1.3).
- **vs. token-voting (Kleros-lite):** unpredictable stake-weighted lottery (×½ exponent — a 4× stake buys only 2× selection odds) means raw capital cannot *buy* the jury; commit–reveal makes voting observable before anything signs (paper §4.2, §8.4).
- **vs. standing committees:** jurors exist only when a dispute does — capital is never locked for a market's lifetime (JIT empanelment, paper §3.4); epoch cohorts amortize the per-case DKG for universal confirmation.
- **The catch that motivates everything else:** a threshold oracle is only as trustworthy as its *ceremony* — hence the rest of the talk.
- *Artifact:* paper §1.2 table, §1.3, §4.2 Proposition (exponential race).

---

## 3. (b) The protocol — ceremony stages + universal confirmation

### Slide 3 — "The ceremony pipeline" [F1]
- Four certified stages: **selection → DKG → vote → signing**, each a pure, fail-closed state machine; any contradiction **aborts the attempt** rather than degrading it (README §1, §4).
- Selection seed = `H(disputeEventId ‖ blockHash)` — publicly recomputable, unpredictable before mining (selection is a proof, not a claim).
- Pedersen/PedPop DKG (`pedpop-v1-experimental`): **no party ever holds the group private key**; possession-bound, victim-authored complaints defeat forced share-disclosure (m+1 ≤ t).
- Commit–reveal vote → **frozen verdict hash**; FROST signs the *tally*, not just the outcome — an attestation for a losing outcome is structurally invalid.
- *Artifact:* README §1, paper §2.4, §3.3, §5; FIGURES.md F1.

### Slide 4 — "Universal confirmation: evidence for every outcome" [F2]
- The dispute path covers only contested markets; v0.8.0 extends the same panel machinery to **every** settlement — the primary oracle becomes a *proposal the panel can uphold or overturn* (paper §6).
- Confirmations are public, attributable, non-replayable signed endorsements (`hashCourtConfirmation`); no commit/reveal needed.
- The **challenge window is bond-witnessed**: a challenge without verified economic backing cannot open the ladder.
- Ledger barriers re-derive confirmation/outcome ledgers before any value moves (`resolve_round`, `finalize`) — a hand-edited snapshot cannot steer clawbacks (F-3).
- *Artifact:* paper §6.1; confirmationMachineTypes.ts (11 phases); FIGURES.md F2.

### Slide 5 — "The escalation ladder and clawbacks" [F4]
- Challenged cases run mass-vote ladder rounds; reference panels grow ×3 (r1=15, r2=45, r3=135), `maxLadderRounds` ≤ 5; escalation is **host-driven and explicit** — the machine never auto-escalates.
- Two idempotent clawback rules price errors: `overturned_confirmation` (flags every confirming juror when the proposal falls) and `round_flip` (flags round r−1's majority when round r disagrees).
- Finality = the **last resolved round's winner**, under the same `hashCourtVerdict` domain as disputes — one attestation format serves both paths.
- *Artifact:* CHANGELOG v0.9.0, paper §6.2–6.3; FIGURES.md F4.

### Slide 6 — "One signature per epoch: batch attestations" [F3]
- Universal confirmation creates a volume problem — one ceremony per case does not scale to thousands of settlements/day (paper §7).
- **Epoch cohorts** run the DKG once per epoch (≤300, 201 recommended) and reuse the group key across the cohort's signed validity window; rotation is a signed handoff chain — a stale cohort cannot outlive its window.
- **Kind-39018 batch attestations:** one threshold signature over an RFC-6962 Merkle manifest certifies up to **10,000 verdicts**; per-case verification is an O(log n) inclusion proof (~1.3 ms flat).
- **v2 in-band finality binding:** epoch, tier, threshold, signer-set root, and batch root are *inside the signed message* — a stale v1 artifact can never satisfy v2 policy (downgrade refused, INV-VAL-13).
- *Artifact:* paper §7.1–7.3; batchAttestation.ts; FIGURES.md F3.

### ★ Live demo slide (place here) — "This is running, not rendered"
- 5-minute scripted demo: deterministic whole-court ceremony, live state-space sweep, claim→evidence cross-check, reproduction VERDICT. Full second-by-second script with expected outputs and fallbacks: **DEMO_SCRIPT.md**.
- *Artifact:* `npm run simulate:court`, `scripts/model-check.mjs`, `scripts/cross-check.mjs`, `docs/benchmarks/repro-log-2026-11-10.txt`.

---

## 4. (c) The formal results

### Slide 7 — "145 invariants, extracted from the guards" 
- `docs/FORMAL_INVARIANTS.md`: **145 first-order invariants** (INV-SEL/VOTE/CONF/SIGN/BATCH/VAL/X), each extracted from the *actual guards in source* — an audit by another name — each with a `file:line` enforcement pointer and a pinning test.
- Traceability matrix machine-checked: **144/145 (99.3%) carry executable proof** (INV-VOTE-14 open, a defense-in-depth capacity guard).
- The audit produced 12 findings (F-1…F-12); the substantive F-12 (machines lacked a monotonic clock ledger → stale-timestamped replays were admissible) shipped in v0.9.2.
- *Artifact:* FORMAL_INVARIANTS.md; CROSS_CHECK.md §1 (counts are printed by the cross-check script).

### Slide 8 — "3.9M states, zero untyped throws, zero illegal witnesses accepted"
- Exhaustive finite-state exploration of the three ceremony machines: **3,869,232 concrete states · 213.5M event applications · 195.0M typed throws · 0 raw `TypeError`/`RangeError`** (15 instances), plus **60,020,684 illegal escalation-witness probes with 0 accepted** at every reachable state.
- Properties asserted on **every edge**: phase legality (P1), data invariants incl. real SHA-256 re-derivation and real secp256k1 nonce points (P2), no dead ends (P3), acyclic progress graph (P4), determinism — 3,000 replayed paths, all byte-identical (P5), illegal-witness immunity (P6), witness-log bound (P7).
- Honest scope: explored rosters are n ≤ 4 because state spaces grow combinatorially — but the properties are checked on the machines' **own reducer code paths**, not a model of them. Two of the checker's own fixture defects (MC-F7, MC-F8) are published: a sweep is only as good as the fixtures it dispatches, and one property here *mirrored* the bug it was meant to catch (r29-1).
- The checking cost was itself optimized: signing-machine reduce **3,340 µs → 110 µs (30×)** made the equivocation-variant instances tractable; witness probing (not exploration) is now the sweep's dominant cost (2,525 s full mode).
- *Artifact:* `__fixtures__/model-check-summary.json` (regenerable: `npx tsx scripts/model-check.mjs`); `docs/benchmarks/SCALE_CAMPAIGN.md` §2.1; EVALUATION §2.1; paper §11.2.

### Slide 9 — "Differential parity: zero disagreements"
- Every critical pure function is **reimplemented independently** — different algorithm, different library, same contract — and asserted to agree: CanonicalWriter (byte-identity/prefix-freeness/injectivity), batch Merkle (exhaustive n=1..128, 8,256 proofs), all 64 v2 hash-field subsets (`node:crypto` vs `@noble`), the selection lottery (exact + statistical chi-square over 100k draws), plurality tie-break (exhaustive 3^n).
- **A disagreement is by construction a finding** — either a bug or an under-specified contract. Result: **0 disagreements**.
- The methodology pins the *spec*, not the code: reference implementations are readable restatements, so a rewrite that changes observable behaviour fails here first. All randomness seeded — every assertion reproducible.
- *Artifact:* `__tests__/differentialParity.test.ts` + `__tests__/reference/` (PR #52); EVALUATION §2.2.

### Slide 10 — "The finding taxonomy"
- ~30 findings across the committed adversarial record, **five top-severity** (1 CRITICAL + 4 HIGH), every one fixed with a regression test or dispositioned in the Gap register — none silently dropped.
- Five recurring classes: **trust-boundary pinning** (largest), **parsing/canonicalization**, **availability/DoS**, **races/replay/concurrency**, **economic**.
- Code-maturity signal: **every top-severity finding attached to code that was new at audit time**; none ever attached to the stabilized v0.7.x core — finding rate on the mature core decayed to MED/LOW across ~8 consecutive rounds.
- *Artifact:* EVALUATION §3.1–3.2 (audit-record table + finding-class distribution).

---

## 5. (d) The security argument

### Slide 11 — "Threat model: nine formalized adversaries"
- Formalized as (corruption set, channels, compute, budget): hostile relay, juror <t, juror ≥t, coordinator, proposer, economic ×2, LLM advisor, key compromise, network eclipse (THREAT_MODEL §2).
- Per-asset argument structure: **attack tree → enforcing invariant → crypto anchor → detective control → honest residual**, for six assets (verdict integrity, settlement steering, key shares, reputation, liveness, fee/slashing correctness).
- Default coalition: coordinator + juror-<t — the coordinator is untrusted **by design** (ADR-0001: a driver, never an authority).
- The strongest insider (juror ≥t) can produce valid verdicts **by design** — above the threshold, security *is* economics.
- *Artifact:* THREAT_MODEL §2–4; FIGURES.md F5 for the boundary story.

### Slide 12 — "Honest residuals — including majority-collusion economics"
- **PO-1 (the honest center of gravity):** no bribe-equilibrium model for a ⌈2N/3⌉-of-N jury; mitigations implemented and attack-tested (unpredictable selection, observable commit–reveal, overturn/flip-flop clawbacks, SLA composite capping farmers at 0.5) but **not equilibrium-proven**.
- **Caller-pins-not-the-event:** a valid signature proves *some* key signed — consumers MUST pin the empaneled group key, epoch, roots; every unpinned consequence is reproduced by a named adversarial test (P1–P12, THREAT_MODEL §5).
- **Liveness under partition is not proven** (PO-3): deadlines + Path-C refund *bound the damage*; the soak validates empirically (zero lost deadlines at 10k/day), not a theorem.
- **Single-process prototype:** demo ceremonies concentrate shares in one memory space (vector G) — a production gate (cross-client deployment), not a protocol defect.
- *Artifact:* THREAT_MODEL §6 (PO-1…PO-18), §7 ("the argument's shape"); EVALUATION §6 (threats to validity).

---

## 6. (e) Evaluation

### Slide 13 — "Performance: measured, never assumed" [F4]
- **450×:** the O(n) full-set Merkle proof generator (v0.10.0) — 10k-leaf proof set ~32 s (extrapolated) → **~71 ms**; **30×:** signing-machine reduce via the point-validity memo (3,340 → 110 µs); **2.7×** selectJury; **4.4×** canonical encode — all gated on differential parity passing **unchanged** (byte-output-identical).
- Per-case batch verification is **flat** (~1.3 ms from 10 to 10,000 leaves) — verification scales flat, batching scales linear.
- **Refused optimizations are recorded with numbers:** 27× on ranking but only 1.12× end-to-end — below the ≥2× ship bar; buffer pooling and state-memoization refused with reasons.
- **The soak:** one day at **10,000 settlements/day** on unmodified real services (virtual clock, 2m52s wall): **20/20 assertions**, zero lost deadlines (20,668 scheduled, every one fired exactly once), sat-exact ledger parity vs an independent oracle, 0 double-publishes — and it *found* F6 (ack-reconcile starvation, p99 20.6 min → 1.98 min after the fix).
- *Artifact:* docs/benchmarks/BASELINE.md; EVALUATION §4; FIGURES.md F4.

### Slide 14 — "Claim coverage: 95.1%, machine-checked"
- 285 claims indexed across the four sources (invariants, paper, crypto audit, model-check/bench/suite meta-claims); **516 evidence refs resolve**, and the **14 open obligations** (of an 18-entry gap register, 4 closed) are registered with a planned proof — the open list *is* the roadmap. Both counts are printed by `node scripts/cross-check.mjs`.
- The coverage number is itself machine-checked: `node scripts/cross-check.mjs` verifies every evidence pointer (tests exist, fixtures hold, instances match) and **exits non-zero on a dangling pointer** — the claims cannot drift silently.
- **The audit program as methodology** (paper §11.5): each round picks an attack surface, records what it finds, lands the disposition — rounds 1–3 adversarial, formal audit, model checking, literature audit, differential parity, performance, host-side mechanism audit. Not "the authors assert" but "the round that owns this claim pinned it, and the pin regenerates from one command."
- One-command reproducibility: `bash scripts/reproduce.sh` regenerates every artifact from a clean clone — committed run: **REPRODUCED, every artifact PASS** (999.9s).
- *Artifact:* CROSS_CHECK.md; REPRODUCIBILITY.md; docs/benchmarks/repro-log-2026-11-10.txt.

---

## 7. (f) What's next — the proof obligations

### Slide 15 — "PO-1…PO-18: the honest-gap register as a roadmap"
- 17 registered proof obligations, each with **stage-acceptability** (why it's safe to ship now) and a **closure path** (what would close it).
- Highlights: **PO-1** game-theoretic model of the majority-collusion bribe game; **PO-2** multi-block selection beacon + committed reputation roots; **PO-3** liveness theorem under ≤1/3 relay control; **PO-13** external-assumption watch (LDVR / Crites et al. CRYPTO 2025; ChillDKG/BIP-445 upgrade trigger); **PO-14** cross-client ceremonies close the prototype assumption gap; **PO-15** settlement binding (host-mediated release in v1); **PO-16** Lightning preimage is publicly computable (forfeiture is host policy); **PO-17** cross-engine selection ordering; **PO-18** attribution is detective (the journal is what attributes a FROST signature).
- Production gates beyond the proofs: rail *execution* adapters, contract-enforced phase deadlines on-chain, independent side-channel audit, and the third-party FROST differential (the second half of the parity gate).
- Close on the methodology, not the marketing: *the design is backed by an evaluation methodology, not a claim — and every pin regenerates from one command.*
- *Artifact:* THREAT_MODEL §6 (register); paper §12 (honest status), §13 (scope of verification: proven / machine-checked / empirically evaluated / open obligation).

### Q&A quick pulls
| Likely question | Answer + artifact |
|---|---|
| "What if a majority colludes?" | Valid verdicts by design; economic mitigations; equilibrium open = PO-1 (THREAT_MODEL §4.1, §7) |
| "Why not ChillDKG?" | Planned suite upgrade, never mislabelled as active; gated on BIP-445 vectors + cross-impl parity (README §2, CRYPTO_AUDIT §6) |
| "What does the model check NOT prove?" | Large-n combinatorics, real-DB soak, partition liveness — EVALUATION §6, stated with the same care as the results |
| "Who holds the key?" | Nobody — Pedersen DKG, unanimous roster, no dealer (paper §2.4, §5 step 4) |
| "Can I verify a verdict?" | One BIP-340 verify (~1.3 ms) + O(log n) Merkle proof, from public data only (paper §3.3, §7.2) |
