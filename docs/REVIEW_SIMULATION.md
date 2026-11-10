# BAO Court — External-Review Simulation (Round 16)

**Version:** tracks `@bao/court` v0.10.2 · **Date:** 2026-11-10 · **Round:** 16
(symposium external-review simulation)

**Method.** Three reviewer personas — a formal-methods skeptic (A), an applied
cryptographer (B), a systems/economics reviewer (C) — were tasked with
*attacking* the paper (`docs/FROST_COURT_ORACLE_PAPER.md`), the four
verification artifacts (`FORMAL_INVARIANTS`, `THREAT_MODEL`, `CRYPTO_AUDIT`,
`EVALUATION`, `CROSS_CHECK`, `TESTING_GUIDE`), and the code where a claim
needed checking. Every finding below was **evidence-checked against the real
tree before being written** — where the attack failed, the finding is recorded
as a QUESTION with the rebuttal; where it landed, a fix shipped in this PR
(doc edits / a pinning test) or a follow-up was registered.

Severity scale: **REJECT** (a claim is wrong in a way that changes the
paper's verdict) / **MAJOR** (a claim is overstated, unscoped, or load-bearing
and unverified) / **MINOR** (precision, drift, bounds) / **QUESTION**
(attack failed; recorded with the rebuttal).

**Panel verdict (summary).** No REJECT-level finding: every headline claim
survived its evidence check — the two arithmetic/wording errors found were
cosmetic, and the sharpest attacks (LLM-juror evidence injection, dependency
caret-ranges, PoK compat sunset, DKG model-checking exclusion, composite-SLA
Goodhart floor) all landed as **MAJOR** with either a shipped fix or a
registered obligation. Per-reviewer: A — accept with revisions (language
downgrades demanded, all granted); B — accept with revisions (two trust
boundaries must be documented before production); C — accept (the engineering
claims are honestly scoped; the economics remain the honest center of
gravity, as the paper itself says).

Fixes shipped in this PR are marked **[FIX SHIPPED]**; registered follow-ups
are marked **[REGISTERED]** with an id (`RS-n`) and are cross-referenced from
the Gap register / proof-obligations register where applicable.

---

## Reviewer A — formal-methods skeptic

*Conduct: read FORMAL_INVARIANTS in full, the model-checking core and fixture,
the property/parity suites, and spot-checked guard line numbers and the
selection verification code.*

### A-1 (MAJOR) — The model-checking program covers three of the four ceremony machines; the paper never says why the DKG is excluded [FIX SHIPPED]

**Attack.** The abstract claims "the three ceremony phase machines are
exhaustively model-checked", but §6.4 of the same paper calls *four* machines
(vote, confirmation, signing, **DKG**) ceremony machines. The DKG machine has
the most intricate semantics in the system — unanimity advance
(INV-DKG-3/4), single-transcript certification with blame (INV-DKG-6),
tick-exempt `certified`, six sink phases — and it is the machine whose
failure mode (a wrongly-derived group key) is the most expensive. Why is the
exhaustive explorer not pointed at it?

**Evidence-check.** `__fixtures__/model-check-summary.json`: 13 instances,
all vote/confirm/signing. The `modelCheckingCore.ts` header names exactly
three machines. `courtDkgMachine.ts` is verified only by pinning tests
(courtDkgMachine.test.ts, invariantAssertions.test.ts). The paper nowhere
states the exclusion or a rationale.

**Fix (shipped).** Paper §11.2 now states the exclusion and its rationale
(the DKG machine's peer events carry cryptographic payloads whose validity is
decided *outside* the reducer — encrypted-share verification — so a
state-space exploration would mostly exercise typed rejection of payloads the
machine cannot see inside; the machine's *structural* invariants are pinned
by the invariant suite), plus a registered follow-up. **[REGISTERED RS-1]**
Extend `modelCheckingCore.ts` with a DKG adapter (structural events only:
`add_participant`-family + `certify`/`expire`/`abort`) so INV-DKG-1…12 join
the exhaustive sweep.

### A-2 (MAJOR) — The F7 vacuity lesson was fixed for one instance but not systematized: nothing prevents the next vacuous variant [FIX SHIPPED]

**Attack.** Finding F7 (PR #58) is exactly the failure mode of property-based
verification: the `partial-equivocation` instance's fabricated conflict-psigs
collapsed onto its base instance — 19,822 states both — so the suite *passed*
while exercising nothing the variant claimed. The repair was manual. What
stops a future instance addition from regressing to vacuity silently? The
committed-fixture test asserts states > 0 and rawThrows = 0 — never that a
variant actually differs from its base.

**Evidence-check.** Confirmed: `modelChecking.test.ts` › 'exists and covers
every required instance, all green' checks presence and greenness only.
Today's 13 instances all have pairwise-distinct state counts (334 …
1,268,770), so the guard is currently satisfiable.

**Fix (shipped).** A new fixture-level test in `modelChecking.test.ts`:
**all instance state counts must be pairwise distinct**, with the F7
rationale in the message — a variant instance whose state space equals
another's is not exercising what it claims and must be re-tuned or renamed.
This converts F7 from a one-time repair into a permanent, always-on
discipline.

### A-3 (MAJOR) — "145 first-order invariants" is not an accurate description of the 145 [FIX SHIPPED]

**Attack.** EVALUATION §2.4 says "145 first-order invariants". Reading
FORMAL_INVARIANTS: (i) INV-CORE-1…8 are *language definitions* (type
signatures of the guards), not invariants; (ii) INV-SEL-3 is a
*probabilistic* statement (exponential-clock semantics), pinned
statistically, not first-order; (iii) INV-VOTE-14 has **no** enforcement test
(F-10 — the doc's own traceability row is "—"); (iv) INV-CONF-4/15 and
INV-SIGN-3 are parameter-range rules whose *security* content ("economic") is
a policy claim, not a mathematical invariant. A reviewer counts perhaps ~130
first-order, machine-checked properties of the stated 145.

**Evidence-check.** Confirmed against FORMAL_INVARIANTS §3–§14 and the
CROSS_CHECK index (145 invariant claims, 144 with executable proof, INV-VOTE-
14 open).

**Fix (shipped).** EVALUATION §2.4 reworded: "145 invariants — predominantly
first-order and machine-checked; one (INV-SEL-3) is statistical by nature;
one (INV-VOTE-14) is pinned as defense-in-depth only (F-10); the count
includes the core language definitions the invariant family is stated
over." The normative doc (FORMAL_INVARIANTS) already labels these classes
honestly; the *evaluation chapter* was the overstatement.

### A-4 (MINOR) — Invariant line-number drift exceeds the documented caveat [FIX SHIPPED]

**Attack.** FORMAL_INVARIANTS says line numbers are "v0.9.1 source except
where a v0.9.2-hardening row states otherwise". But the v0.10.x suite/module
reorganization shifted far more: INV-CONF-2 cites `courtConfirmationMachine.ts:586-590`
(guard actually at ~line 188, post-reorg), INV-VOTE-3 cites the `accept_commit`
guard at line 526 (now ~line 630+). The cross-check script verifies *test
names*, never line numbers — so the enforcement pointers can rot without a
machine signal.

**Evidence-check.** Confirmed by reading the current sources at the cited
and actual lines.

**Fix (shipped).** The drift caveat in FORMAL_INVARIANTS §1.4 now covers the
v0.10.x reorganization explicitly and states that line pointers are
advisory — the invariant ID + test name (machine-verified by
`scripts/cross-check.mjs`) is the binding reference. **[REGISTERED RS-2]** a
`--lines` mode for the cross-check script that re-resolves enforcement
pointers to the named guard symbol.

### A-5 (MINOR) — `verifyJurySelection`'s 1e-12 float tolerance admits a narrow re-ranking window; the doc should state the bound [REGISTERED]

**Attack.** `verifyJurySelection` compares priorities with
`Math.abs(expected - selected) > 1e-12` (`selection.ts:~429`). Two *distinct*
u32 draws yield priorities differing by ≈ 2.33e-10/√(rate); when that gap
drops below 1e-12, a verifier could accept a jury whose order differs from a
bit-exact recomputation — the "verification is recomputation" property
(INV-SEL-9) is then only ε-true.

**Evidence-check.** Confirmed the tolerance in source. The bound: in
quadratic mode the rate is √stake, so the window opens only at stake >
~5.4×10¹⁰ sats (≈ 540 BTC) — unreachable at current scale; in `weightFn`
reputation mode the weight is host-supplied and *can* reach the window.

**Fix.** Doc note added to INV-SEL-9 in FORMAL_INVARIANTS stating the
tolerance and the exact bound. **[REGISTERED RS-3]** replace the float
tolerance with an exact comparison over the integer u32 draw + a canonical
decimal ranking, or document a maximum weight.

### A-6 (QUESTION) — Determinism is sampled (200 paths), not exhaustively replayed

**Attack.** "Determinism paths replayed: 2,600" could be read as an
exhaustive replay; it is ≥ 200 *sampled* states per instance.

**Evidence-check / rebuttal.** `modelCheckingCore.ts` header and
EVALUATION §2.1 both say "sampled set of ≥ 200 reachable states per
instance". The sampling is over the reachable set with a fixed seed, so it is
reproducible. Claim language elsewhere is accurate. **No change needed.**

### A-7 (QUESTION) — The P3 parking-state set is "probe-derived" — circularity?

**Attack.** The no-dead-ends biconditional exempts "the machine's own
probe-derived parking states" — if the probe uses the same reducer to decide
parkability, the property risks being true by construction.

**Evidence-check / rebuttal.** The probe is a *forward reachability search
for a non-aborted terminal* using only legal events; a state is exempted only
if the search *fails* to find progress, and the resulting parking set is a
documented, named list per machine (checked against the machines' docstrings
in the model-checking core header). The biconditional direction that matters
(a state that *can* reach a terminal is never flagged) does not depend on the
exempt set. **Accepted as sound; language already precise in the header.**

### A-8 (QUESTION) — "Exhaustive" in the abstract vs bounded instances

**Attack.** Instances are n ≤ 4 with reduced clock universes; "exhaustive
finite-state model checking" is exhaustive only within the abstraction.

**Evidence-check / rebuttal.** Paper §11.2 states the abstraction limits in
its own closing paragraph; EVALUATION §6.1 item 1 is dedicated to it; the
modelCheckingCore header documents the run-mode split. The properties are
checked on the production reducers, not a model — the honest-transfer
argument. **Rebutted: the scoping is already stated at every level of the
docs.**

### A-9 (QUESTION) — Statistical differentials ride a 32-bit LCG (mulberry32)

**Attack.** The 100k-draw chi-square/moments differentials use `mulberry32`
(period 2³²); a weak generator could mask distributional divergence.

**Evidence-check / rebuttal.** The statistical test compares two
*derivations over the same shared draws* (production clock vs inverse-CDF
clock) — generator bias affects both arms identically and cancels in the
comparison; the exact u32 and end-to-end-ranking differentials carry the
soundness load, the statistical suite only guards formulation divergence.
**Rebutted — with a standing note:** future statistical claims that depend on
generator quality (not paired-derivation comparisons) should not ride
mulberry32.

### A-10 (QUESTION) — "Zero raw throws" is scoped to the explored space

**Attack.** The abstract's "zero raw throws" headline could be read as a
global property of the package.

**Evidence-check / rebuttal.** EVALUATION §6.5 scopes it exactly ("the
enumerated state spaces of three machines; parser-level hostility is covered
separably by fuzz + validator suites; host code is outside this package").
**Rebutted.**

### A-11 (MINOR — cross-panel catch) — Coverage arithmetic error in EVALUATION §5 [FIX SHIPPED]

**Attack.** "95.2% (259/272) … **14 open gaps**": 272 − 259 = **13**, and
CROSS_CHECK §2 says "13 open". One of the two is wrong.

**Evidence-check.** Confirmed: CROSS_CHECK's index counts 17 Gap-register
rows of which 13 are OPEN (the register also lists closed-before-round and
CLOSED-this-round rows; EVALUATION's "14" matches neither 13 nor 17).

**Fix (shipped).** EVALUATION §5 corrected to **13 open gaps** (matching the
machine-checked index, which is the authoritative count).

---

## Reviewer B — applied cryptographer

*Conduct: read CRYPTO_AUDIT against the code (`crypto.ts`, `signing.ts`,
`dkg.ts`, `independentDkg.ts`, `validator.ts`, `nip44Crypto.ts`), the
`@vbyte/frost` dependency analysis, the selection-seed analysis, and the
host-repo LLM-juror boundary (`hermesAdvisor.ts`, `marketQualityBot.ts`).*

### B-1 (MAJOR) — The LLM-juror boundary is one adversary-table row; the untrusted-evidence→prompt flow is nowhere analyzed [FIX SHIPPED]

**Attack.** THREAT_MODEL §2.1 defines ADV-LLM ("hermes-juror trust
boundary… fully controls the advisory LLM's outputs… controls no keys") — and
that one table row is the *entire* treatment. The paper never mentions the
LLM juror at all (grep: zero hits). CROSS_CHECK has no ADV-LLM claim and no
evidence pointer. The new attack surface the audits underweighted: **dispute
evidence TEXT is attacker-influenced and flows into the advisory LLM's
prompt** — a disputant can write evidence whose prose is a prompt injection,
so "LLM advises, key signs" inherits the strength of a sanitizer and a
"mechanical policy" that this repository neither specifies nor pins.

**Evidence-check.** Host repo: `packages/api/src/services/hermesAdvisor.ts`
does fail-closed network-marker + BIP-340 signature verification of the
*report* (good — that boundary is real), and the shared sanitizer
(`marketQualityBot.sanitizeMarketText`) is a **regex blacklist of English
injection phrases** ("ignore previous instructions", "you are now", "DAN"…)
after Unicode normalization — semantically trivial to bypass in other
languages, paraphrases, or structured-markdown injection. The boundary claim
"LLM advises, key signs" is sound **only if** the mechanical policy that
turns advice into a vote is itself specified, fail-closed, and
attestation-bound — none of which is documented in this repo.

**Fix (shipped).** THREAT_MODEL §2.1's ADV-LLM entry expanded + a new §4.7
(LLM-advisor boundary) analyzing: (a) the evidence-text→prompt flow as an
untrusted input channel; (b) the sanitizer's blacklist nature and its bypass
classes; (c) the precise statement of what "advises, never signs" buys —
prompt injection can degrade advice quality but cannot forge the FROST
signature, cannot move sats, and every vote the juror casts is an
attributable, slashable signed event; (d) the residual: a systematically
injected LLM can *steer within* the mechanical policy (waste juror attempts,
bias vote text), so the mechanical policy must be narrow and pinned.
**[REGISTERED RS-4]** the host-repo mechanical-policy contract (advice→vote
mapping) specified and pinned by a prompt-injection repro suite.

### B-2 (MAJOR) — The dependency "pin" is a caret range: the audit verdict describes the lockfile, not what a fresh install resolves [REGISTERED]

**Attack.** CRYPTO_AUDIT §6 says "Pin verdict: keep 1.1.5" and bases the
malleability-consensus argument on "@noble/curves 2.4.0" — but `package.json`
declares `"@vbyte/frost": "^1.1.5"`, `"@noble/curves": "^2.2.0"`,
`"nostr-tools": "^2.13.0"`. A fresh clone resolves *whatever* 1.x/2.x is
current at install time. The audit's own upgrade trigger (c) — "any change to
noble's schnorrVerify strictness… pin it in the upgrade checklist" — is
precisely what an unpinned range can absorb silently.

**Evidence-check.** Confirmed: caret ranges in package.json (lines 137-140);
`npm ls` shows the lockfile state (noble 2.4.0, @vbyte/frost 1.1.5,
nostr-tools 2.26.0). The lockfile *does* pin what CI installs; the risk is
the gap between "audited" and "freshly resolved".

**Fix.** **[REGISTERED RS-5]** exact-pin the four crypto-relevant deps
(`1.1.5`, `2.4.0`, hashes, `2.26.0`) or add an engrossed dependency-audit
check (CI diff of `npm ls @noble/curves` vs the audited versions). Deliberately
not shipped here: dependency-resolution policy is an owner decision that
affects host repos vendoring this package. Doc correction shipped with B-4.

### B-3 (MAJOR) — The DKG PoK v1-compat path has no sunset: the aliasing class the fix closed is still accepted by every verifier, forever [FIX SHIPPED / part REGISTERED]

**Attack.** The v1→v2 PoK challenge fix (A-2 in CRYPTO_AUDIT) ships a
verifier that accepts **both** encodings. The docstring calls v1 acceptance
"a documented compatibility window" — but there is no version gate, no
suite/roster flag, no deprecation deadline: *every* verifier runs both
checks permanently. A hostile peer can still exploit the
`(market, dispute)` delimiter-aliasing against any juror whose verification
accepts v1 — which, absent a sunset, is all of them forever. "Compat" that
never retires is a permanent weakening dressed as a transition.

**Evidence-check.** `crypto.ts` `verifyProofOfKnowledge`: iterates
`[pokChallengeV2(...), pokChallengeV1(...)]` with no gate. The mitigation
argument in the docstring (roster binding at the event boundary) is real but
bounds, not eliminates, the ceremony-binding confusion.

**Fix (shipped).** CRYPTO_AUDIT §2.3 now states the sunset obligation
explicitly: v1 acceptance must be removed (or gated behind an explicit
mixed-fleet flag) once the fleet is v2-uniform, with the trigger being the
juror-kit rollout milestone. **[REGISTERED RS-6]** the gate itself
(`requireV2Pok` session parameter).

### B-4 (MINOR) — "Uniform since every verifier links the same noble" is false on this very tree — two noble copies exist [FIX SHIPPED]

**Attack.** CRYPTO_AUDIT §4.1 justifies malleability-uniformity by claiming
every verifier links the same noble. But `nostr-tools` (used for NIP-01
id verification and `nip44`) carries its **own nested @noble/curves@2.0.1**
while the court's direct dep is 2.4.0 — the tree has two copies, and the
strictness argument silently depends on both being equally strict.

**Evidence-check.** `npm ls`: `@noble/curves@2.4.0` (court + frost) and
`@noble/curves@2.0.1` (nested under nostr-tools). **Empirical probe run for
this review** (reproduced, both versions): `schnorr.verify` accepts a valid
signature and rejects `s = n` on **both** 2.4.0 and 2.0.1 — uniform *today*,
by coincidence of upstream behavior, not by the tree's construction.

**Fix (shipped).** CRYPTO_AUDIT §4.1 claim corrected: uniformity is an
*empirically verified today* property across both in-tree noble copies, with
the nostr-tools-bump scenario added to the §6 upgrade triggers.

### B-5 (QUESTION) — Deterministic HKDF nonce derivation vs RFC 9591 §7.3 / ROAST

**Attack.** RFC 9591 is explicit that share-only deterministic nonces are a
key-recovery vector; where exactly do deterministic derivations sit relative
to the signing path?

**Evidence-check / rebuttal.** `@vbyte/frost generate_nonce(secret, aux)` =
H3(aux ‖ secret) with fresh CSPRNG aux when no seed is passed; the court
never passes seeds to `create_commit_pkg`. The deterministic `seededScalar`
paths are gated (`unsafeTestMode` throws otherwise) and confined to DKG
coefficients under test mode + demo key material; the residual — nothing
enforces this at the type level — is S-4/PO-6, registered with a `@:
SigningNonce` brand as the closure. The Node nonce-guard restart window is
S-3/PO-5. Both honestly registered; the RFC-required aux-randomness is
present on every production path. **Rebutted (residuals registered).**

### B-6 (MINOR) — The encrypted-transport layer is outside the literature audit's scope

**Attack.** CRYPTO_AUDIT's scope list covers signing, DKG, validator,
selection — but `nip44Crypto.ts` and the NIP-59 seal/unwrap logic
(`nip59.ts`, `courtUnwrapCore.ts`) are the channel every *share* travels
over, and they are verified only by the relay-adversary suite, not
literature-audited.

**Evidence-check.** Confirmed: `nip44Crypto.ts` delegates the symmetric
crypto to nostr-tools' `nip44` (reasonable), but the unwrap discipline
(recipient-tag check, seal-author equality, rumor-id recomputation) is
in-repo logic. **[REGISTERED RS-7]** a transport-audit round (NIP-44 v2
implementation notes, NIP-59 seal games, key-derivation aliasing) with the
same finding discipline as round 7.

### B-7 (QUESTION) — Seeded selection vs grinding

**Attack.** The seed is one block hash; a miner grinds coinbase tweaks, and
the coordinator can reselect adaptively until a favorable roster appears —
and recomputation *detects nothing* because the pin is the attacker-chosen
input.

**Evidence-check / rebuttal.** This is the audit's own conclusion (§2.4,
finding A-4/S-1): grinding is "evidence-preserving", the cost model is
recorded (≈ pool/5 draws per grind bit for one juror; full jury exponential),
and the spec'd fix is a multi-block beacon + committed pool/weight roots
(PO-2). The reviewer's strongest form of the attack is already the doc's
position; what remains is the >40-line protocol event (S-1), correctly
registered rather than pretended fixed. **Rebutted (registered).**

### B-8 (QUESTION) — DKG unanimity is a liveness trade

**Attack.** INV-DKG-3/4 unanimity means one dissenter (or one offline juror)
blocks key generation entirely; with backups and reselection, a persistent
adversary can keep a ceremony from ever completing.

**Evidence-check / rebuttal.** Documented as a deliberate trade
(THREAT_MODEL §4.5-Y2, paper §10.3): threshold keygen risks rogue-key and
split courts; the complaint protocol with false-complaint slashing bounds
the attack's *cost*; reselection has a deadline after which the appeal
refunds (Path C). **Rebutted as a documented design decision — with the
liveness residual correctly carried in PO-3.**

### B-9 (QUESTION) — Adaptive-security assumption (LDVR) postdates the construction

**Attack.** FROST's adaptive security rests on Crites et al.'s 2025 LDVR
assumption — newer than the deployed code, no published attack, but also no
track record.

**Evidence-check / rebuttal.** PO-13 carries exactly this, with concrete
upgrade triggers (LDVR attack literature; ChillDKG 1.0/BIP-445 final). The
binding-factor structure is the RFC 9591 one and defends the *static*
corruption model the threat model actually assumes. **Rebutted
(registered).**

### B-10 (QUESTION) — Demo dispute-key fixed-width fix keeps hex-lenient inputs

**Attack.** The A-3 fix enforces a 64-char *width* but not hex-ness — why is
injectivity enough?

**Evidence-check / rebuttal.** Injectivity of `pk ‖ id` needs only the fixed
width of the first field (the doc says exactly this); the key's dlog is
public by construction (its docstring forbids authentication use), so the
demo key's only job is deterministic derivation. **Rebutted.**

---

## Reviewer C — systems / economics reviewer

*Conduct: read EVALUATION + BASELINE + the soak's actual implementation in
the host repo (fake-pg engine), the inbox/batch memory bounds in code, the
retainer/SLA composite in the host's round-10 suite, and the retention/SLA
host-side boundary claims.*

### C-1 (MAJOR) — The 10k/day soak is a 1,049-line hand-written fake Postgres behind a virtual clock; the headline reads like a production claim [FIX SHIPPED / REGISTERED]

**Attack.** "Zero lost deadlines at 10,000/day, sat-exact ledger parity,
p99 ack 1.98 min" — all measured against `courtSoakFakePg.mts` (a
team-written in-memory pg engine, 1,049 lines) with `Date` patched globally
at 1300× compression. The soak validates the team's *model* of Postgres
against the services — real serialization anomalies, connection-pool
exhaustion, fsync latency, and relay RTT are untested. EVALUATION §6.2
admits this, but THREAT_MODEL §4.5-Y4 says "soak-verified: zero lost
deadlines at 10k/day" without the fake-pg qualifier — the qualifier must
travel with the claim everywhere it appears.

**Evidence-check.** Confirmed: host PRs #2293/#2295 ship
`courtSoakFakePg.mts` + `courtSoakPgHook.mjs` (module-resolve injection) +
global `Date` patch. The soak did find real bugs (F6 cursor starvation) —
it is a genuine instrument, just not a production-performance one.

**Fix (shipped).** THREAT_MODEL §4.5 Y4 now carries the fake-pg/virtual-clock
qualifier. **[REGISTERED RS-8]** a soak mode against real Postgres
(dockerized, single node) as the pre-production gate.

### C-2 (MAJOR) — The composite SLA's 0.5 floor is a Goodhart surface: the cap only binds if the retainer threshold sits *above* it, and the metric prices attendance, not coherence [FIX SHIPPED]

**Attack.** The round-10 fix defines
`composite = ackRate × (0.5 + 0.5 × participationRate)` — pinned:
all-ack/zero-participation = exactly **0.5**, half-participation = 0.75,
full = 1.0. Three game-theoretic gaps: (i) if the host's retainer/retention
threshold is ≤ 0.5, the "cap" passes a pure farmer — the cap binds only
relative to a threshold the court docs never specify; (ii) the composite is
*linear, published, and monotone* — the textbook recipe for
optimize-the-measure: a juror sets participation to exactly the cheapest
rate that clears the threshold, forever; (iii) it prices **attendance, not
coherence** — a juror who acks everything, votes in everything, and votes
*wrong* in everything keeps SLA 1.0 (coherence is priced only by slashing
when an overturn happens, which a good-faith-looking wrong voter can
attribute to honest error). Also: who counts a "participation" is
host-defined — the metric's gameability is inherited from that definition.

**Evidence-check.** Host round-10 suite (bao.markets PR #2294,
`mechanismAdversarial.test.ts`): the composite values above are pinned
exactly as stated; the participation definition and retainer threshold are
not pinned anywhere in either repo. Paper §7.4 describes the floor without
stating the threshold constraint.

**Fix (shipped).** Paper §7.4 now states the two obligations the composite's
soundness depends on: the retainer threshold MUST be set strictly above the
0.5 floor (else the cap is decorative), and the participation definition is a
pinned host duty; coherence-vs-attendance pricing is explicitly left to the
slashing layer, with the wrong-but-attentive juror named as the residual.
**[REGISTERED RS-9]** equilibrium note (extend PO-1's game-theoretic closure
to the composite metric: threshold-sitting under a published linear metric).

### C-3 (MINOR) — The inbox's worst-case memory (~25 GB) is nowhere stated [FIX SHIPPED]

**Attack.** `courtInbox.ts`: `MAX_RECORDS = 100_000`,
`MAX_WRAP_CONTENT_BYTES = 256 * 1024`. Worst case: 100k records × 256 KB ≈
**25.6 GB** in memory, and `snapshot()` deep-copies the whole structure as
JSON — a transient doubling on top. A host that sizes memory by the record
count ("100k records, fine") and not the byte bound can be OOM-killed by a
hostile relay serving maximal wraps; the soak's 388 MB peak never
approached this regime.

**Evidence-check.** Both constants confirmed in source; no doc states the
byte arithmetic.

**Fix (shipped).** `courtInbox.ts` module docstring now carries the
worst-case byte arithmetic (≈ 25.6 GB records + JSON-snapshot transient
double) and the sizing guidance: hosts must bound by *bytes*, not record
count, and should snapshot incrementally.

### C-4 (MINOR) — Full proof-set generation is O(n) hashes but O(n log n) memory, with no streaming API [REGISTERED]

**Attack.** `buildBatchMerkleProofs` materializes the complete node table
(2n−1 hashes) *plus* n proofs × O(log n) sibling hashes — fine at the 10k
cap (~tens of MB), but a host serving several concurrent epoch batches
multiplies it, and there is no way to emit proofs incrementally.

**Evidence-check.** Confirmed by reading the implementation (full `nodes`
Map + pre-sized path arrays). At the cap the numbers are modest and the
71 ms measurement is real; this is a scaling-shape note, not a defect.
**[REGISTERED RS-10]** an iterator/streaming variant if multi-batch hosts
materialize in practice.

### C-5 (QUESTION) — Single-host benchmarks vs fleet claims

**Attack.** Every µs/ms number comes from one shared 16-thread laptop-class
box; a load-20 run deviated ×18 and was excluded; the "fleet" framing
(thousands of settlements/day) is extrapolated from that box plus a
virtual-clock soak.

**Evidence-check / rebuttal.** BASELINE.md documents the load-20 exclusion
and reports `min` as the noise-floor estimator with pair-run deltas
published; REPRODUCIBILITY.md makes the whole thing one-command regenerable;
EVALUATION §6.4 owns the host-variance problem in its own voice. **Rebutted
— with the standing requirement (already in BASELINE.md) that CI budgets
baseline on a quiet box.**

### C-6 (QUESTION) — Operational toil numbers are unauditable from this repo

**Attack.** Retention, SLA tracking, retainer ledger — "pinned by the host's
own adversarial suite (round-10)" — live in a different repository; a
reviewer of *this* paper must take the cross-reference on faith.

**Evidence-check / rebuttal.** PAPER-7.4-1 is a registered gap in
CROSS_CHECK with exactly this framing ("this repo carries the pointer
only"), and the boundary is a stated design rule (§7.4: protocol math vs
host policy). **Rebutted — the gap register is the right mechanism; the
pointer's continued resolution is machine-checked by the cross-check gate.**

### C-7 (QUESTION) — MAX_FEES = 256 adequacy at ladder scale

**Attack.** Fee entries cap at 256 per case (INV-CONF-30); with the ladder's
×3 panels (up to 135 seats × 5 rounds) plus summons fees, is 256 reachable
via *legal* paths at production rosters (201-seat cohorts)?

**Evidence-check / rebuttal.** The cap is per-case and fee entries are
host-published records, not per-juror-per-round by construction; the
mechanism audit (round 10) priced the redelivery/churn surface at 1+1 per
summons. At the reference rosters the cap is ≥ 1 fee event per juror-round;
a legal-path overflow would require ~2 fee events per juror — plausible only
if host policy doubles fee publication, which is a host-budget question, not
a protocol defect. **Accepted as adequate; flagged for the host's capacity
review.**

### C-8 (QUESTION) — Bribe economics remain unmodeled (the honest center of gravity)

**Attack.** 50%/100% slashing, clawbacks, and the composite are mechanisms;
no equilibrium analysis says a ≥t coalition *shouldn't* form at realistic
stake-to-value ratios — for a high-value market the bribe can exceed the
slash.

**Evidence-check / rebuttal.** PO-1 states exactly this ("the bribe
equilibrium for a 2N/3-of-N jury is not modeled"), with the closure path
(game-theoretic analysis + per-market-value threshold scaling). The paper's
§7 summary calls the economic layer "the honest center of gravity". **Rebutted
as honestly registered — the finding is the register's existence, which
predates this review.**

### C-9 (MINOR) — Cross-panel: the EVALUATION §5 "14 open gaps" arithmetic error

Covered as **A-11** (fix shipped). Reviewer C independently flags it because
it sits in the chapter a systems reader checks first.

### C-10 (QUESTION) — Suite-count drift between TESTING_GUIDE ("~1486") and the paper ("1,491")

**Evidence-check / rebuttal.** TESTING_GUIDE says "~1486 tests" with a
tilde; the paper's abstract says "live count re-recorded per round in
CROSS_CHECK §1" and SUITE-4 exists precisely to pin the per-round count
(1,491 at v0.10.2). Today's run confirms 1,491 passed / 1 skipped. **Rebutted
— the drift-protection mechanism (SUITE-4 + per-round recording) is the
correct answer to the reviewer's own objection.**

---

## Fix ledger (this PR)

| # | Finding | Fix | Where |
|---|---|---|---|
| 1 | A-2 | Vacuity guard: fixture instance state counts pairwise distinct (F7 systematized) | `__tests__/modelChecking.test.ts` |
| 2 | A-1 | DKG model-check exclusion stated + rationale + RS-1 | paper §11.2 |
| 3 | A-3 | "145 first-order invariants" precision downgrade | EVALUATION §2.4 |
| 4 | A-4 | Line-pointer drift caveat extended to v0.10.x; ID+test is the binding reference | FORMAL_INVARIANTS §1.4 |
| 5 | A-5 | INV-SEL-9 tolerance bound documented | FORMAL_INVARIANTS INV-SEL-9 |
| 6 | A-11/C-9 | "14 open gaps" → "13" | EVALUATION §5 |
| 7 | B-1 | ADV-LLM expanded; new §4.7 LLM-advisor boundary (evidence-text→prompt analysis) | THREAT_MODEL |
| 8 | B-2/B-4 | Noble-uniformity claim corrected (two in-tree copies; probe recorded); caret-range caveat; RS-5 | CRYPTO_AUDIT §4.1, §6 |
| 9 | B-3 | PoK v1-compat sunset obligation + RS-6 | CRYPTO_AUDIT §2.3 |
| 10 | C-1 | Soak claim carries the fake-pg/virtual-clock qualifier | THREAT_MODEL §4.5 |
| 11 | C-2 | Composite-SLA threshold/consumption obligations + Goodhart residual | paper §7.4 |
| 12 | C-3 | Inbox worst-case byte arithmetic (≈25.6 GB + snapshot doubling) | `courtInbox.ts` docstring |

## Registered follow-ups (RS-n)

| ID | Finding | Obligation |
|---|---|---|
| RS-1 | A-1 | DKG-machine adapter for the exhaustive explorer (structural event space) |
| RS-2 | A-4 | cross-check `--lines` mode re-resolving enforcement pointers |
| RS-3 | A-5 | exact-integer ranking comparison (or documented max weight) replacing the 1e-12 tolerance |
| RS-4 | B-1 | host-repo mechanical-policy contract + prompt-injection repro suite for the LLM juror |
| RS-5 | B-2 | exact-pin the crypto deps (or CI dependency-audit gate); owner decision |
| RS-6 | B-3 | `requireV2Pok` session parameter retiring v1 PoK acceptance |
| RS-7 | B-6 | transport-crypto literature-audit round (NIP-44/NIP-59 as used) |
| RS-8 | C-1 | real-Postgres soak mode as a pre-production gate |
| RS-9 | C-2 | extend PO-1's equilibrium analysis to the composite metric (threshold-sitting) |
| RS-10 | C-4 | streaming/incremental batch-proof generation if multi-batch hosts need it |

## Verification

- `npm test` — full suite green (including the new vacuity-guard test).
- `npm run typecheck && npm run typecheck:tests` — clean.
- `node scripts/cross-check.mjs` — exit 0 (492 evidence pointers resolve).
- New empirical probe recorded in this review: noble 2.4.0 and the
  nostr-tools-nested 2.0.1 both reject `s = n` (run 2026-11-10, this tree).
