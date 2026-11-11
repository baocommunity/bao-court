# BAO Court — Threat Model & Security Argument (v0.10.2)

**Status:** Track D opener, symposium round 14. This is the paper's security
chapter backbone: the formalized adversary model (§2), the per-asset argument
(§4) linking each asset → attack tree → enforcing invariant
(docs/FORMAL_INVARIANTS.md) → cryptographic anchor (docs/CRYPTO_AUDIT.md §7) →
detective control → honest residual, the MUST-pin trust-boundary inventory
(§5), and the proof-obligations register (§6).

**Companion artifacts.** Claim→evidence traceability (every security claim in
this document, the invariants doc, the crypto audit, and the paper mapped to
its exact executable evidence) lives in **docs/CROSS_CHECK.md** (round-14
companion). This document cites it and does not duplicate the mapping.
The prototype/adversary framing of §10.1–10.2 of
docs/FROST_COURT_ORACLE_PAPER.md (vectors A–M) is the narrative antecedent;
this document formalizes it.

**Conventions.** $t$ = FROST threshold (signing), $M$ = jury size,
$n$ = candidate-pool size, $V$ = disputed market escrow in sats,
$B$ = challenge bond in sats, $S$ = the slashing/stake pool in sats,
$F$ = the fee pool in sats. "Observer" = any party holding the public event
stream and the pinned parameters; every detective control below is an
observer-recomputable check, never a trust statement.

---

## 1. System summary (what is being defended)

BAO Court resolves a disputed market outcome in four phases, each a machine
with formal invariants (docs/FORMAL_INVARIANTS.md):

1. **Selection** — deterministic jury draw from a seeded exponential-clock
   lottery over the eligible juror pool (INV-SEL-1…9).
2. **Vote** — commit/reveal plurality tally with a canonical UTF-8 tie-break,
   producing a frozen verdict hash (INV-VOTE-1…23).
3. **Confirmation + ladder** — universal confirmation, challenge bonds, up to
   5 escalating re-vote rounds with overturn/flip-flop clawbacks (INV-CONF-1…36).
4. **Attestation + batch** — FROST $t$-of-$M$ Schnorr attestation (kind 89 /
   39007) over the reconstructed message; RFC-6962 Merkle batching (kind
   39018) for cohort-level reputation (INV-SIGN-1…15, INV-BATCH-1…16,
   INV-VAL-1…16).

Settlement execution (rail moves) lives host-side; the court layer produces
the **plan** (docs/ESCROW-SLASHING.md — integer-exact, observer-verifiable via
`verifyRedistributionIntegrity`) and the cryptographic evidence. The threat
model covers everything up to and including the attestation; the rail
boundary is marked where it appears.

---

## 2. Adversary model

Notation: an adversary is a tuple (corruption set, channels, computational
power, economic budget). Static corruption unless stated; all adversaries are
computationally bounded (no SHA-256 collisions, no discrete-log forgery —
assumption A1 of the paper §10.1).

### 2.1 Formalized adversaries

| ID | Adversary | Capabilities | Not in scope |
|---|---|---|---|
| **ADV-RELAY** | Hostile Nostr relay | Drop, reorder, delay, duplicate any event; serve partitioned views (over-serve selected clients); replay old events; append hostile tags to re-published events. Cannot forge (NIP-01 id + Schnorr bind content) and cannot read NIP-59 gift-wrap payloads. | Compromising juror hosts; breaking the seal cryptography. |
| **ADV-JUROR-<t** | Malicious juror minority | Controls < $t$ shares of the active cohort; votes arbitrarily, equivocates commits/nonces/partials, abstains, colludes with the coordinator, publishes its share of evidence. By Shamir privacy learns nothing about $f(0)$ beyond what its own shares give. | Forging an attestation alone; reading others' shares; **escaping attribution for a published partial** — once the session journal is published, a partial that fails share verification is attributable to its index (Theorem 6, `docs/proofs/attribution.tex.md`). |
| **ADV-JUROR-≥t** | Malicious juror majority | Controls ≥ $t$ shares: can produce **valid** attestations for any outcome, steer the signer set, and do all of ADV-JUROR-<t. This is the strongest insider adversary. | Remaining honest jurors' keys; **anonymity of the contributing shares** — a prepared collusion is still *attributable* after the fact (detective, not preventive; Theorem 6 + `docs/ATTRIBUTABLE_SIGNING.md`). |
| **ADV-COORD** | Malicious coordinator / host | Drives every machine (creates states, closes phases, dispatches); can withhold, reorder, delay, or replay events to peers; can attempt the paper's vector I (phase-timing manipulation); runs restored-snapshot recovery. **In scope in v1: release.** The host holds the settlement-signer credential, so under the host-mediated binding (`docs/SETTLEMENT-BINDING.md` §2.3) it can request the cohort's spend signature, release against no verdict, and pick among several valid verdicts for one market. Cannot sign (no shares), cannot alter frozen machine states undetected, cannot redirect an escrow to an arbitrary destination (the cohort's signature commits to one sighash and the winner must also sign). | Forging an attestation (needs $t$ shares); spending without the winner's key; surviving the published `(attestation, planHash, sighash, txid)` audit trail. |
| **ADV-PROP** | Hostile proposer / oracle | Supplies the proposed outcome, evidence-id set, ballot, deadlines, and anchoring block hash; can grind selection by timing dispute opening and by adaptive reselection (`appealCoordinator.maybeReselect`, CRYPTO_AUDIT §2.4). | Fabricating block hashes at required depth (A5). |
| **ADV-ECON** | Economic adversaries (two sub-species, the round-10 findings) | **(a) Ack-farming:** maximize measured SLA (ack rate) without participating — pre-fix the SLA was ack-rate-only. **(b) Bond-gaming:** challenge with a bonded but bad-faith dispute to farm overturn clawbacks or to launder a losing position through the ladder; exploit bond-escrow edges (witness-vs-UTXO duty, dust fungibility, redelivery rules). | Stealing sats directly; breaking the ledger state machine. |
| **ADV-LLM** | External LLM advisor (hermes-juror trust boundary) | Fully controls the advisory LLM's outputs (prompt injection, model compromise, outage, adversarial reasoning text). Controls **no** keys. Additionally — see §4.7 — influences the *inputs*: dispute evidence TEXT is attacker-influenced and flows into the advisory prompt. | Signing anything; overriding the mechanical policy; moving value. |
| **ADV-KEY** | Key compromise | Steals one or more juror share files over time (mobile/backup theft); collects shares toward $t$ across epochs; replays stale material; attempts nonce-reuse extraction (paper vector H). | Threshold collection against a refreshed group without stale-share value. |
| **ADV-NET** | Network-level adversary (eclipse) | Eclipse an individual juror (feed it a partitioned relay view: dropped peers' events + replayed old ones); junction control of a juror's relay list. Honest statement of what Nostr gives: events are **self-authenticating** (id + Schnorr over the NIP-01 serialization, recomputed at ingest — the round-8 fix), but Nostr gives **no** membership, **no** consensus, and **no** eclipse resistance; a partitioned juror may honestly act on a stale view. | Forging events; breaking TLS/transport. |

### 2.2 Composition rules

- ADV-COORD + ADV-JUROR-<t is the default assumed coalition for the
  per-asset arguments in §4 (the coordinator is untrusted by design — ADR
  0001 keeps it a driver, never an authority).
- ADV-JUROR-≥t subsumes every insider adversary; its argument is **economic,
  not cryptographic** (§4-A1 residual, PO-1).
- ADV-NET is the substrate for ADV-RELAY; the relay adversary's drop/reorder
  powers are exactly ADV-NET's applied to a relay role.

---

## 3. Assets and worst-case damage

Damage is parametric in $(V, B, S, F)$ — the protocol is amount-agnostic;
for scale, a mid-size demo market has $V \approx 10^5$ sats, with juror
stakes and fees in the $10^3$–$10^4$ range.

| # | Asset | What the attacker wants | Worst-case damage |
|---|---|---|---|
| **A1** | Verdict integrity | Publish a court-signed attestation for an outcome that did not win (or was never voted) | Up to $V + F$: the entire disputed escrow settled to the wrong side, plus fee-pool misdirection. Bounded by $V + F$ per dispute; the attestation is the finality artifact both settlement rails consume. |
| **A2** | Settlement steering | Right outcome, wrong *authority*: replay a stale epoch/round/tier attestation as final; steer which cohort/epoch's signature satisfies policy | Up to $V + F$ per dispute as A1, achieved *without* touching any verdict; plus epoch-wide reputation corruption via cross-epoch batch reuse. |
| **A3** | Juror key shares | The secret shares: one share (per-juror), $t$ shares (full group key), or the DKG transcript material | $t$-share collection = standing A1/A2 capability across every dispute the group key covers — unbounded until refresh; single-share leak ≈ 0 direct damage (Shamir privacy) but advances collection. |
| **A4** | Reputation integrity | Inflate own juror reputation/SLA (ack-farming, batch double-counting, cross-network epoch squat) or deflate rivals | Long-run: control of future jury composition — the compounding asset that converts into A1/A2 capability at threshold. Immediate: fee-pool share misallocation from $S$. |
| **A5** | Liveness | Kill a ceremony: stall confirmation, poison the ladder, wedge a cohort epoch, eclipse jurors | No theft, but locked escrow (time-value of $V$) and DoS of the appeal path; worst case the Path-C refund after $T$ returns principal and the fee pool $F$ is never distributed. |
| **A6** | Fee pool & slashing correctness | Misdirect clawbacks/slashing (aim `round_flip`/`overturned_confirmation` flags at arbitrary indices), drain $F$ via fee-ledger replay, or self-deal redistribution | Up to $S + F$: the whole stake/slashing pool plus fee pool per dispute cycle. |
| **A7** | Release authorisation (the settlement binding — paper §10.1 assumption A6) | Release an escrow with **no** verdict, or with a *stale* one among several valid ones — the host holds the settlement-signer credential and v1 binding is procedural | Up to $V$ per escrow, with **no** verdict forgery required and **no** on-chain trace that the release was unauthorised (the transfer itself is valid). Bounded only by the published `(attestation, planHash, sighash, txid)` trail — a *detective* control. See `docs/SETTLEMENT-BINDING.md`. |

---

## 4. Per-asset security argument

Structure per asset: **attack tree** (the adversary's routes) → **enforcing
invariants** (INV-\*, docs/FORMAL_INVARIANTS.md) + **crypto anchor**
(docs/CRYPTO_AUDIT.md) → **detective control** (what an observer recomputes)
→ **residual** (what is *not* proven, stated honestly).

### 4.1 A1 — Verdict integrity

```
Forge a valid kind-89/39007 attestation for a losing/fabricated outcome
├─ T1: sign it with the real group key
│   ├─ T1a: corrupt ≥t jurors ............ → RESIDUAL (economic, PO-1)
│   └─ T1b: reconstruct the key from <t shares ....... infeasible (Shamir)
├─ T2: steal/craft a key that verifiers accept
│   ├─ T2a: any fresh key, no pin ......... → R2 unpinned-key finding (§5)
│   └─ T2b: demo dispute-derived key ...... → docstring-forbidden, fixed-width (A-3)
├─ T3: re-sign elevated tags (tier/threshold) under a different key .. → R2 (§5)
└─ T4: replay/transpose another verdict's signature
    ├─ T4a: swap verdictHash post-signing ......... INV-VAL-5/6/7
    └─ T4b: transplant a signature under a new nonce ... INV-VAL-4 (nonce ≔ sig[0:64])
```

**Invariants + crypto.** The attestation certifies the *tally*, not merely an
outcome: the FROST signature verifies over a message whose reconstruction
rebinds `(marketId, outcome, round, disputeEventId, verdictHash)` from the
event's own tags (INV-VAL-5…8); the verdict hash canonically binds
`(session, winner, supporting ids)` (INV-VOTE-18, INV-VOTE-19 for the dispute
domain); reveals are one-per-juror commit-reveal openings (INV-VOTE-12/13).
Signing: FROST $t$-of-$M$ unforgeability under one-more discrete log
(Komlo–Goldberg 2020), binding factors per RFC 9591 §4.4 defeating
Drijvers/Wagner concurrent-session attacks (CRYPTO_AUDIT §1.1 — verified at
the library level, plus the machine/guard/NonceGuard fences of §1.1–1.2).

**Detective control.** An observer recomputes, from published evidence only:
the verdict hash from the supporting event-id set (INV-VOTE-20 — order
independence), the signed message from the tags (INV-VAL-7), and the Schnorr
verification against the **pinned** empaneled key (§5). Every step is
public.

**Attribution (detective control, formal since round 23).** The aggregate
alone names no signers (Theorem 6, Lemma 6.0). The **signing-session journal**
does: round-1 nonce commitments, round-2 partials, signer set, threshold and
aggregate, published append-only (RFC 9162-style log). Anyone then verifies
each partial against its certified verification share
(`s_i·G = R_i + c·λ_i·(π·Y_i)`), recomputes `s = Σ s_i`, and attributes every
defect to an index — a bad partial is `PARTIAL_INVALID` at its signer
(INV-ATTRIB-1/2, `attribution.ts`, `docs/proofs/attribution.tex.md`). The
detective control is bounded by two named premises: the **certified-share pin**
(P1 — otherwise a fabricated journal can name a substitute key) and
**authenticated append-only entries** (P2 — otherwise a relay can frame a
signer). The journal is host-side today; the log store/publication and the
mechanically-enforced batch duty are v0.11 candidates
(`docs/ATTRIBUTABLE_SIGNING.md` §5). Without a published journal a session is
unattributable — the signature cannot be un-linked retroactively.

**Residual (honest).** ADV-JUROR-≥t produces a *valid* verdict for any
outcome **by design** — that is what a threshold signature means. The
mitigation is economic and reputational, not cryptographic: unpredictable
selection (INV-SEL-3), commit-reveal observability before signing (collusion
is visible), overturn/flip-flop clawbacks (INV-CONF-27/28), and dual-panel
evidence (paper §10.2-B). The bribe equilibrium for a $2N/3$-of-$N$ jury is
**modeled and condition-bounded** — PO-1: Theorem 3.1
(`docs/proofs/economics/03-collusion.tex.md`) gives the resistance condition
with $V^{*} \approx 157$k–752k sats, and
`docs/proofs/economics/05-review-gapfills.tex.md` supplies the exact capture
tail (0.8504 % at $N{=}15$/$\rho{=}\tfrac13$; $5.0\cdot10^{-6}$ at $N{=}45$), the
per-rail $V_{\max}$ (the Lightning rail has no seizable stake) and the P+ε
correction. Hit-and-run cartels above the payment-mass region remain open
(Theorem 3.2). The single-share extraction route (T1b) assumes
Shamir privacy and no nonce-reuse leak (vector H; closed by NonceGuard +
RFC 9591 §4.1 aux randomness — CRYPTO_AUDIT §1.4, S-3 caveat for Node
restarts).

### 4.2 A2 — Settlement steering

```
Right outcome, wrong authority
├─ U1: replay stale epoch/round attestation as final
│   ├─ U1a: v1-shaped event under v2 policy .... INV-VAL-13 (downgrade refusal)
│   └─ U1b: v2 event from wrong epoch/tier ..... INV-VAL-9/10 + expectedEpoch/minTier pins
├─ U2: swap the signer set (smaller/threshold-correct-but-different)
│   ├─ U2a: signers tag ≠ actual set .... INV-VAL-11/12 (root + size = threshold)
│   └─ U2b: replay across attempts ...... INV-SIGN-1 (attempt in session hash)
├─ U3: batch confusion
│   ├─ U3a: batch root absent/mismatched under pin ... INV-VAL v2 batch pin (fail-closed)
│   ├─ U3b: batch from another epoch .... SEQUENCE-1: validate kind-39018 with SAME expectedEpoch
│   └─ U3c: same verdictHash in two epochs' batches .. F-1 (F-1 is a *dedup duty*, §6/PO-8)
└─ U4: ladder manipulation (challenge games) ........ §4.6 (bond-gaming)
```

**Invariants + crypto.** The v2 in-band finality binding puts
`(epoch, tier, threshold, signerSetRoot, attempt, batchMerkleRoot)` inside
the signed message (INV-VAL-7 v2 extension, INV-VAL-10…12); batch manifests
are signed over the RFC-6962 root + epoch + cohort + count + finalizedAt
(INV-BATCH-9/11) under domain-separated hashing (INV-BATCH-1, INV-X-1 —
cross-domain aliasing requires a SHA-256 collision; anchors: Krawczyk HKDF
§3.1, BIP-340 tagged hashes, RFC 6962 inclusion-proof soundness).

**Detective control.** Recompute the signer-set root from the presented set
(PV3 equivalence: root pin ≡ full-set pin), recompute the batch leaf from the
case inputs via `hashCourtVerdict` — rejection is *by recomputation, not
identity* (INV-BATCH-15), and re-validate the referenced batch event with the
same epoch pin (SEQUENCE-1).

**Residual.** The `batch` tag carries only the root — the epoch/cohort
binding of the batch itself comes from the *caller's* separate validation
(validator.ts docstring, SEQUENCE-1): a documented trust assumption, not a
mechanism (paper §587). Leaf format change to fold epoch/cohort into the
verdict-hash leaf would break byte-compat; deferred (PO-8/F-1). Consumer
MUST also dedup by `verdictHash` before deriving reputation (INV-BATCH-16,
convention only).

### 4.3 A3 — Juror key shares

```
Obtain shares
├─ W1: passive inference from <t shares ........ impossible (Shamir perfect privacy)
├─ W2: nonce-reuse extraction (two partials, one nonce) .... paper vector H
│   └─ closed: NonceGuard one-consumption (RFC 9591 §7.3 hedge) + INV-SIGN-4/8
│      equivocation aborts + aux-randomized nonce generation (A-7/S-4 caveat)
├─ W3: forced share disclosure via complaint abuse ....... paper vector K
│   └─ closed: possession-bound, victim-authored complaints under m+1 ≤ t
├─ W4: steal share files over time (host/mobile compromise) .... ADV-KEY residual
├─ W5: observe all shares in a single-process demo ceremony .... paper vector G
└─ W6: share-refresh lowering the threshold .................... CVE-2025-58359 analog
    └─ closed: refresh is degree-(t−1) zero-constant under UNCHANGED threshold,
       group key re-verified (CRYPTO_AUDIT §3.2)
```

**Invariants + crypto.** INV-DKG-3/4/6 (unanimous, single-transcript
certification — no subset keys), verified-before-use PoK bound to
`(market, dispute, juror)` (rogue-key resistance: Pedersen/Feldman + GJKKS
lineage; the 2026-08-15 fix made the check live at both consumption sites),
INV-DKG-9/F-12 monotonic clock ledger (old-timestamped replays inadmissible),
restore barriers re-derive the signing-session hash (INV-SIGN-2).

**Detective control.** Every published artifact is share-free by
construction: blame carries indices and reasons, never decrypted shares
(paper §10.3); commitment packages serialize public fields only (the
2026-08 leak-hardening); an observer can verify the group key = Σ qualified
constant commitments and that each verification share reproduces (INV-DKG-5/6).

**Residual.** W4/W5 are **deployment** residuals: no protocol mechanism
prevents a compromised host from reading its own share, and demo
single-process ceremonies concentrate all shares in one memory space. The
paper says this exactly (vector G: "closed only by cross-client deployment —
a production gate, not a protocol change"). Proactive refresh bounds stale
share value but refresh cadence is policy, not proof (PO-4 coverage). Node
nonce-guard persistence is memory-only across restarts (S-3/PO-5) — the
accidental-reuse window requires also replaying the same commit package into
a restarted process.

### 4.4 A4 — Reputation integrity

```
Inflate reputation / SLA / batch credit
├─ X1: ack-farming (ack without participating) ................ R10b finding
│   ├─ pre-fix: SLA = ack-rate only ............ FIXED: courtSlaComposite =
│   │   ackRate × (0.5 + 0.5 × participationRate), farmer capped at 0.5
│   ├─ redelivery spam ......................... bounded 1+1 redeliveries, ×0.8 rep penalty
│   └─ compounding exploit ..................... 0.8^k compounding, no reset; escalation exactly-once
├─ X2: batch double-counting (same verdictHash, two epochs) ... INV-BATCH-16 dedup duty (F-1)
├─ X3: cross-network epoch squat (global epoch_id PK) ......... R10b: JUROR_POOL_EPOCH_NETWORK_MISMATCH
├─ X4: selection-weight manipulation
│   ├─ X4a: caller-supplied non-pure weightFn makes verifyJurySelection vacuous ... F-5 (PO-7)
│   ├─ X4b: grind the seed (timing, reselection) ............... CRYPTO_AUDIT §2.4 (PO-2)
│   └─ X4c: two verifiers disagree on the pool snapshot ........ reputationRoot unbound (S-1)
├─ X5: idle-expiry reset loop (floor → unsummoned → expire → full w0) ... R10b flagged (PO-12)
└─ X6: unpin cohort key on batch reputation ................... §5 R2 (any key signs a manifest)
```

**Invariants + crypto.** The draw is publicly recomputable and fail-closed
(INV-SEL-4/5/9 — verification *is* recomputation, any throw ⇒ false);
eligibility closure admits exactly the documented predicates (INV-SEL-5);
batch credit is hash-bound and order-independent (INV-BATCH-2/3/9). The
SLA/composite and redelivery rules are host-side (bao.markets round-10 PR
#2294) and pinned by its tests; the court layer's contribution is that the
underlying acks/participations are attested events.

**Detective control.** An observer recomputes: the jury draw from
`(disputeEventId, blockHash, pool, params)` (INV-SEL-7), the SLA composite
from the published ack/participation ledger, and batch-derived reputation
from the kind-39018 manifests — after deduplicating by `verdictHash`.

**Residual.** F-1/F-5/X4c are the honest core: **reputation inputs are
pinned by convention, not commitment.** There is no committed
`reputationRoot` in the selection seed (S-1/PO-2), so two honest verifiers
with different pool snapshots can legitimately disagree, and seed grinding
by a miner/coordinator is *evidence-preserving* — the pin is the
attacker-chosen input, so recomputation detects nothing. Cost model
(CRYPTO_AUDIT §2.4): biasing one juror into a 5-seat jury costs ≈ pool/5
draws per grind bit; a full jury is exponential. The idle-expiry reset loop
(PO-12) has a documented design fix, not an implementation.

### 4.5 A5 — Liveness

```
Stall or kill a ceremony
├─ Y1: relay censorship/drop (ADV-RELAY/ADV-NET)
│   ├─ drop commits/reveals .................. deadlines + conservative tick expiry
│   │   (INV-VOTE-5/6/7, INV-CONF-12/13): the ceremony expires rather than hangs
│   ├─ eclipse a juror (partitioned view) .... §2.1 ADV-NET residual (PO-3)
│   └─ replay old events ..................... monotonic clock ledgers (INV-X-5, F-12 closed)
├─ Y2: coordinator withholding (ADV-COORD)
│   ├─ withhold reveals/partials ............. tick expiry; ROAST-style retry semantics
│   │   (CRYPTO_AUDIT §1.2); attempt counter in the signing-session hash
│   ├─ committed-but-silent peer traps aggregation .... A-1 fix: reveal-set == commitment-set
│   │   guard fails EARLY with a precise reason (was: guaranteed-failing final check)
│   └─ wedge DKG by dissenting ............... INV-DKG-3/4 unanimity: by design, one
│       dissenter blocks keygen (a documented trade, not a bug — §4.5 residual)
├─ Y3: ladder exhaustion / challenge spam ... maxLadderRounds ≤ 5 (INV-CONF-6/19),
│   round re-open cost carried by bonds (§4.6)
└─ Y4: wedge the epoch layer ................ soak-verified: zero lost deadlines at
    10k/day (R9b) — measured on an in-memory FAKE-pg engine + virtual clock
    (EVALUATION §6.2): logic-level evidence, not production DB performance
    (round-16 review, finding C-1; real-pg soak = RS-8), reconcile cursor F6
    fix (spurious redelivery 96.6% → 0.00%, R10a)
```

**Invariants + crypto.** Every awaiting-input phase has a tick deadline
(INV-CONF-13's table; INV-VOTE-7's conservative expiry — near-final phases
are tick-exempt so a ceremony one step from finalization is never wasted);
terminal states are absorbing (INV-X-3) so nothing resurrects; the ladder is
finite and escalation is exactly-once (INV-CONF-29). Model checking
(1.7M–3M states, 125M applications, 0 untyped throws) verifies no dead ends
and the acyclic progress graph for all three ceremony machines.

**Detective control.** The full machine state is public event-derived; any
observer can run the same reducer and confirm expiry/ladder state.

**Residual.** **Liveness under network partition is not proven** (PO-3):
deadline expiry + Path-C refund bounds the *damage* of a partition but the
protocol makes no availability claim under an ADV-NET eclipse of a
majority — a partitioned jury simply expires and refunds. DKG unanimity
(INV-DKG-3/4) is a deliberate availability trade: one dissenter blocks key
generation (the alternative — threshold keygen — risks rogue-key and split
courts; the complaint protocol with false-complaint slashing bounds the
attack cost instead). The soak numbers (R9b: p99 confirm 6.03 h, ack-rate
99.72%) are empirical, at 10k/day virtual load, not a proof.

### 4.6 A6 — Fee pool & slashing correctness

```
Misdirect the money-math
├─ Z1: forge outcomeHistory → aim clawbacks at arbitrary indices
│   └─ closed (F-3): assertValidOutcomeHistory at resolve_round + finalize
│      (consecutive rounds, ballot closure, unique well-formed winner ids/indices)
├─ Z2: double-execute a clawback/fee entry
│   └─ closed: idempotency per (idx, reason[, round]) — INV-CONF-27/28/30/31
├─ Z3: fractional-sat fabrication ..................... closed: integer-exact Math.floor
│   plan math, verifyRedistributionIntegrity observer check (ESCROW-SLASHING §5)
├─ Z4: replay fee records (cap 256, idempotent per id)  INV-CONF-30 (boundary-tested)
├─ Z5: bond-gaming (ADV-ECON-b)
│   ├─ bad-faith challenge to farm clawbacks .......... bond at risk: dispute rejected ⇒
│   │   bond forfeited into the pool (ESCROW-SLASHING §4 table)
│   ├─ bond ownership forgery ......................... bond ownership proof: Schnorr over
│   │   the bond UTXO's key, try/catch → false (escrow.ts; INV-CONF-17 binding)
│   ├─ witness-vs-UTXO skip ........................... HOST pre-dispatch duty (boundary —
│   │   machine verifies the witness hash, the host must check the UTXO) — §5 boundary row
│   └─ dust/redelivery edges .......................... R10b HELD+pinned: redelivery 1+1
│       with ×0.8 penalty, dust fungibility, 0.8^k compounding, escalation exactly-once
└─ Z6: machine-generated clawback reason confusion .... F-4: reducer writes only
    overturned_confirmation / round_flip; host policy language is open by design (PO-9)
```

**Invariants + crypto.** Clawback flags are append-only and idempotent
(INV-CONF-26/27/28); the verdict is a pure function of the verified ledgers —
flag history is *not* a verdict input (INV-CONF-34), so replaying a snapshot
with different flags cannot change the money-math's evidence base; finality =
last resolved round (INV-CONF-32) with non-empty support (INV-CONF-33).
Bond ownership: BIP-340-style Schnorr proofs over UTXO keys, all verify sites
guarded (CRYPTO_AUDIT §4.1 — noble 2.4.0 strict `schnorrVerify`, `s ≥ n`
rejected everywhere, uniformly).

**Detective control.** `verifyRedistributionIntegrity` recomputes the whole
slash/redistribution plan from the published vote evidence; the outcome
history barrier re-derives every record; fee ledgers are idempotent and
capped.

**Residual.** Z5's host-side duty (witness-vs-UTXO) is outside the court
package — the machine verifies the *witness hash binding*, not the chain
state; a host that skips the UTXO check trusts the challenger's assertion
(§5 marks this boundary). F-4: host policy may add clawback reasons beyond
the two protocol ones — the "machine-generated ⇒ protocol reasons" property
holds by construction but is untested (PO-9). And as everywhere: a ≥t
majority can *win* the ladder legitimately and steer slashing through honest
majorities — economics again (PO-1).

### 4.7 A-LLM — the LLM-advisor boundary (round-16 review, finding B-1)

The ADV-LLM row above was, before this round, the *entire* treatment — one
table entry with no per-asset argument, no evidence pointer, and no analysis
of the attack surface that matters most: **evidence TEXT is untrusted and
flows INTO the advisory LLM's prompt.**

```
Steer a juror's vote through the advisory channel
├─ L1: evidence-text prompt injection ........... the dispute author controls
│   prose that the host renders into the juror-LLM prompt
├─ L2: sanitizer bypass ......................... the shared guard is a regex
│   BLACKLIST of English injection phrases — bypassable in other languages,
│   paraphrase, or markdown structure even after Unicode normalization
├─ L3: advisory-model compromise / outage ....... ADV-LLM by definition
└─ L4: mechanical-policy steering ............... a systematically injected
    advisor can bias the advice INSIDE whatever the mechanical policy allows
```

**What "LLM advises, key signs" actually buys — stated precisely.** The
boundary is sound *as a forgery boundary*: no LLM output is ever a signing
input to FROST (the signed message is the frozen verdict hash — INV-SIGN-1),
the LLM holds no keys, and every vote a juror casts is an attributable,
slashable signed event. Prompt injection through evidence text **cannot**
forge an attestation, cannot move sats, and cannot override a machine
invariant. What it CAN do is degrade advice quality and, if the
advice→vote mapping is loose, *steer within* the mechanical policy — waste
signing attempts, bias vote text, or coordinate a slashable-but-majority
voting bloc.

**Residual (honest).** The mechanical policy that turns advice into a vote
is host-side and — before this review — unspecified in both repos; the
shared sanitizer is a phrase blacklist, a class with known bypasses
(verified against the host's `sanitizeMarketText`). The boundary's strength
is therefore *conditional*: it holds exactly as tightly as the mechanical
policy is narrow and pinned. **[REGISTERED RS-4,
docs/REVIEW_SIMULATION.md]** the advice→vote mapping specified + a
prompt-injection repro suite in the host repo. The hermes *report* channel
(distinct from per-dispute evidence) already carries fail-closed
network-marker + BIP-340 signature verification host-side — that boundary
is real and pinned (host `hermesAdvisor.ts`).

### 4.8 A7 — Release authorisation (the settlement binding)

```
Release money without a verdict (ADV-COORD, in scope since v1 ships host-mediated)
├─ W1: forge a verdict
│   └─ closed: needs t shares (A1/A3), and the validator recomputes the tally
│      commitment, market id, outcome whitelist and group-key pin (P1, P8)
├─ W2: alter an attested outcome
│   └─ closed: verdictHash is inside the signed message (INV-VOTE-19);
│      tampering fails validateAttestationEvent
├─ W3: redirect the escrow to an arbitrary destination
│   └─ closed by construction: the judge leaf is <winner> CHECKSIGVERIFY
│      <cohort> CHECKSIG — the cohort's signature commits to ONE sighash
│      (outpoints, amounts, outputs, fee, leaf) and the winner must also sign
├─ W4: release against NO verdict (authority confusion) ......... OPEN
│   └─ the signer service signs a structured request bound to
│      (kind, escrow, rail, action, planId) — no verdict field exists in it,
│      so "the cohort authorised this" and "the host asked" are
│      indistinguishable. Controls today: one signature per binding
│      (no equivocation, NOT an authorisation check), the winner's
│      signature, and the published audit tuple.
│      Closure: include attestationDigest/marketId/outcome in the request and
│      refuse a spend partial without a valid attestation
│      (docs/SETTLEMENT-BINDING.md §4.2); plus the CSFS leaf (§2.2) on Liquid.
├─ W5: pick a stale verdict among several valid ones ........... OPEN (partial)
│   └─ one attestation per (market, round) + monotone rounds + published
│      trail make it *visible*; the escrow cannot tell them apart
└─ W6: withhold the release (censorship) ....................... bounded
    └─ Path-C CLTV refund after T (A5)
```

**What the host cannot do** — and this is the part that survives the honest
statement: it cannot fabricate a verdict, cannot alter an attested one, cannot
choose the destination, and cannot spend without the winner. It *can* choose
whether and when to release, and which valid verdict to honour.

**Detective control.** Publish `(marketId, outcome, attestationEventId,
planHash, sighash, txid)` per release; re-verify out-of-band that each release is
covered by a valid attestation and that the plan pays the attested beneficiary.
Post-hoc only: funds have moved by the time it fires.

**Residual (honest).** The platform is a release authority in v1. Describing the
rail as "no single party can release" is an A6 claim that this binding does not
support — the correct sentence is **"the court decides, the host releases"**.
`docs/SETTLEMENT-BINDING.md` §2 compares all three bindings and §5 keeps the
open items.

---

## 5. Trust-boundary inventory — the MUST-pin table

The validators verify events against *themselves plus caller context pins*.
A valid signature proves only that **some** key signed the message — never
that the key is the empaneled cohort, the right epoch, or the final tier
(validator.ts SECURITY docstring, cross-module round 2 — the R2 finding).
Every consumer boundary, formalized. "Unpinned" consequences are each pinned
executably in `__tests__/adversarialCrossModule.test.ts` (SEQUENCE-1/3) and
`__tests__/propertiesValidator.test.ts` (PV1–PV4) — evidence mapping in
docs/CROSS_CHECK.md.

| # | Boundary (consumer duty) | What is trusted absent the pin | What the pin buys | What happens unpinned |
|---|---|---|---|---|
| P1 | `expectedGroupPubkey` — **every** consumer deriving finality, tier policy, reputation, or settlement (validator v1+v2, batch validator) | ANY public key | Attestation binds to the empaneled cohort's FROST key | An attacker-controlled key re-signs the *same tags with ELEVATED tier/threshold* and validates cleanly (R2 / SEQUENCE-3) — full A1/A2 capability |
| P2 | `expectedEpoch` (v2 + batch) | "some epoch" | Stale/epoch-crossed finality refused | An epoch-1 attestation satisfies epoch-2 finality policy; a foreign epoch's batch feeds reputation |
| P3 | `expectedBatchMerkleRoot` (v2) | batch root as presented | Signed finality over *that* batch; fail-closed on missing `batch` tag | A v2 attestation with a missing or swapped batch tag satisfies batch-bound policy |
| P4 | `expectedSignerSetRoot` / full `signerSet` (v2) | signers tag as presented | Root recomputation + `length === threshold` (PV3 equivalence) | A different/smaller signer set rides on the attestation |
| P5 | `minTier` / `minThreshold` (v2 policy) | policy as claimed | Tier/threshold policy actually enforced on the signed fields | Self-asserted tier/threshold accepted (compounds P1's elevated re-sign) |
| P6 | Referenced kind-39018 batch validated with the **same** `expectedEpoch` + Merkle roots matched (SEQUENCE-1) | batch event self-consistency only | The batch's epoch/cohort binding (the `batch` tag carries only the root) | Epoch confusion across the chain (U3b) |
| P7 | `expectedCohort` / `expectedFinalizedAtSec` (batch) | manifest fields as presented | Cohort + finalized-at binding (else falls back to event `created_at`) | A self-selected cohort manifest timestamps itself |
| P8 | `expectedDisputeEventId` / `expectedMarketId` / `allowedOutcomes` / `trustedPublisherPubkeys` (v1+v2) | event's own tags | Cross-dispute/cross-market confusion refused; only ballot outcomes admissible | An attestation transplanted between disputes/markets validates; a non-ballot outcome rides in |
| P9 | Pinning *duty itself* — present-but-empty pin (`''`) is **typed-invalid**, never treated as "no pin" (F-2, closed v0.9.2) | unset config silently disabling the pin | An empty pin cannot silently disarm P1–P8 | *(closed — was: unset-config joins disabled group-key enforcement on all four entry points)* |
| P10 | No v1 downgrade under v2 policy — a v1-shaped event with any v2-only policy field is refused (INV-VAL-13) | format ambiguity | Stale-artifact replay (paper vector L) closed | A round-0 confirmation or old-epoch attestation satisfies v2 policy |
| P11 | Host-side: challenge bond witness-vs-UTXO check before dispatch (INV-CONF-17 boundary note) | witness hash binding only | Bond actually exists on chain | A challenge backed by a witness hash over a spent/nonexistent UTXO enters the ladder |
| P12 | Host-side: dedup by `verdictHash` before reputation derivation (INV-BATCH-16, F-1) | batch membership scope | Reputation counts each verdict once | Silent double-count across epochs' batches |
| P13 | Host-side: verdict validation *before* requesting the settlement signature, and publication of `(marketId, outcome, attestationEventId, planHash, sighash, txid)` (A7 / `docs/SETTLEMENT-BINDING.md` §2.3) | "the cohort signed, so a verdict exists" | The release is covered by a verdict and is re-checkable after the fact | A7: release with no verdict, or against a stale one — a valid transfer with no authorising verdict anywhere in the record |
| P14 | Host-side: the escrow descriptor's judge leaf must be the canonical court leaf for `(winner, cohort key)` — exact bytes, not a substring match (`isCourtJudgeLeaf`, INV-SETTLE-1) | "the key appears in the script" | The leaf cannot be `<group> CHECKSIGVERIFY <group> CHECKSIG` (role collapse) or have its winner slot swapped | One key holding both roles releases with a single signature — the two-signature conjunction silently becomes one |

Design rule the table formalizes (paper §587): **caller-pins-not-the-event**
is a documented trust assumption, not a mechanism — the event cannot carry
its own trust context, because the attacker controls re-publication.

---

## 6. Proof-obligations register

What remains unproven, why it is acceptable **at the current deployment
stage** (vendored library + demo/testnet ceremonies + host integration), and
what would close it. Honest-gap list for reviewers; each row is also a
CROSS_CHECK.md finding-class row where evidence exists.

| # | Obligation | Current state | Acceptable now because | Closure path |
|---|---|---|---|---|
| PO-1 | Majority-collusion economics: a ≥t jury produces *valid* verdicts by design; no bribe-equilibrium model for $\lceil 2N/3\rceil$-of-$N$ under unpredictable selection + slashing | Economic mitigations implemented (clawbacks, 0.8^k compounding, SLA composite); equilibrium unmodeled | Deployment stages have small stakes; collusion is *observable* (public commit-reveal) even where unprevented | Game-theoretic analysis of the bribe game; empirical collusion monitoring on live juries; raise $t$ or jury size per market value |
| PO-2 | Selection-seed anchoring: single-block-hash seed inherits miner/relay discretion; coordinator reselection grinding; `reputationRoot` unbound (CRYPTO_AUDIT §2.4 / S-1) | Draw publicly recomputable; grinding evidence-preserving (recomputation can't detect attacker-chosen inputs); cost model recorded | Demo/testnet stake sizes make grind cost (pool/5 per bit) unattractive; adaptive reselection is *published* (selectionAttempts + excludedPubkeys) | S-1: multi-block beacon (k ≥ 3 future hashes at fixed depths) + committed pool/weight roots in the dispute-open event (needs a protocol event; >40 lines) |
| PO-3 | Liveness under network partition / eclipse | Bounded damage (deadline expiry → Path-C refund); soak-validated at 10k/day; no availability proof | The protocol *claims* refund-bounded liveness, not partition liveness; Path C is by construction | Formalize the timeout/refund DAG as a liveness theorem under ≤ 1/3 relay control; multi-relay junction redundancy as deployment policy |
| PO-4 | Transcript certification opacity: `courtDkgMachine.transcriptHash` is caller-supplied, not recomputed from the commitment set (S-2; ChillDKG ACert analog) | PoK + share checks + unanimity already fence rogue-key/steering | Single-transcript unanimity (INV-DKG-6) means all honest parties certify *some* agreed hash; the gap is transcript *content* binding | S-2: `hashDkgTranscript` over the sorted (idx, pubkey, commitments, PoK, phaseNonce) vector; require certification events to carry recomputation data |
| PO-5 | Node nonce-guard persistence: memory-only across process restarts (S-3) | Machine-level one-commitment/one-attempt disclosure makes reuse require replaying the same commit package into a restarted process | Browser jurors (the primary deployment) persist via LocalStorageNonceGuard; Node hosts are operator-controlled | File-backed guard, or session-hash-bound persisted-counter derivation (RFC 9591 §7.3-conformant) |
| PO-6 | Type-level nonce separation: `seededScalar` demo derivation is gated at runtime (`unsafeTestMode`), not in the type system (S-4) | Demo/test paths throw outside test mode | No production path reaches seeded signing nonces today | `@: SigningNonce` brand or lint rule making RFC 9591 §7.3 violations unrepresentable |
| PO-7 | `weightFn` purity unenforceable: `verifyJurySelection` recomputes with the caller's function — a non-pure/non-identical weightFn makes verification vacuous (F-5) | Docstring contract; INV-SEL-4 fail-closed on bad weight *values* | Weight functions are host-supplied code today (single deployment) | Snapshot-pinned `reputationRoot` (selection.ts future-work note) + canonical weight-function registry |
| PO-8 | Batch membership scope: leaf binds verdictHash only; cross-epoch dedup by `verdictHash` is convention (F-1) | Documented non-goal; consumers pin epochs (P2/P6) and dedup (P12) | Reputation derivation is host-side with the dedup rule implemented | Leaf-format v2 folding epoch/cohort into the leaf (byte-compat break — schedule with the v2+ rollout) |
| PO-9 | Clawback reason language: reducer writes only the two protocol reasons (by construction), host policy language is open; property untested (F-4) | INV-CONF-31 dedup + cap bound the surface | Reasons are advisory labels; money-math is flag-idempotent regardless of reason string | Named-test pinning the reducer's reason vocabulary; host reason registry |
| PO-10 | v1 validator unbounded: frozen byte-compat path accepts megabyte-scale fields (F-6) — hashing-DoS surface | v2 bounds (INV-VAL-10) cover the new path; v1 events are relay-filtered in practice | v1 is the frozen legacy verification path, not the policy path | Deprecate v1 policy consumption; enforce bounds at the publisher boundary host-side |
| PO-11 | `verifyEvent` memoization caller-visible: in-place mutation of a verified event re-presents the stale verdict (F-8) | Host parsers + SummonsAckService reconstruct field-by-field (round-8 fix); spread-clones safe by construction | All in-tree consumers use the safe pattern | Validator-side defensive clone, or a documented + type-enforced frozen-event contract |
| PO-12 | Idle-expiry reset loop (floor → unsummoned → expire → full w0 reputation restore) — R10b flagged, design fix documented | Reputation floor prevents *negative* farming; loop restores full weight over time | Requires sustained non-participation to exploit; SLA composite already caps farmers at 0.5 | Implement the documented design fix (expiry must not reset to w0; decay instead) |
| PO-13 | External-assumption watch: FROST adaptive security rests on the LDVR assumption (Crites et al., CRYPTO 2025); noble/vbyte pins carry upgrade triggers (CRYPTO_AUDIT §6) | Binding-factor structure is the RFC one; no published attack on LDVR; pins verbatim-audited | The proof-level assumption postdates the deployed construction and has no known weakness | Track LDVR attack literature; ChillDKG 1.0 / BIP-445 final as the upgrade trigger |
| PO-14 | Prototype assumption gap: paper A2–A4 (honest juror opt-in mass, authenticated channels, complaint-bound majority) are unmet by single-process demo ceremonies (paper vector G) | Documented as a production gate, not a protocol change; every ceremony invariant holds *within* the single process | Demo/testnet are stated as prototypes; cross-client deployment is the planned gate | Cross-client rollout (juror-kit + independent sessions — already code-supported via `IndependentDkg/SigningSession`) |
| PO-15 | Settlement binding (paper A6 / asset A7): v1 release is host-mediated — the cohort authorises, the host releases; no verdict is required by the signer, and the cohort's consent is a signature over the sighash, not over the verdict | Two-signature leaves (the cohort cannot redirect), one-signature-per-binding at the signer (no equivocation), validator pinning (no verdict forgery or alteration), and the published `(attestation, planHash, sighash, txid)` tuple (detective) | Stakes are small, the operator is the deployment, and the honest description ("the court decides, the host releases") is now in the paper, this model, and `docs/SETTLEMENT-BINDING.md` | Spend-session binding (`marketId ‖ attestationDigest ‖ planHash ‖ sighash` in the signing-session hash + a signer that refuses a partial without a valid attestation) and, for Liquid binary/escrow rails, the `CHECKSIGFROMSTACK` leaf — both gated in `docs/SETTLEMENT-BINDING.md` §2.2 and §4.2 |
| PO-16 | Lightning panel preimage has **no secret input**: every field of `deriveLnPreimage` (disputeId, role, pubkey, outcome, attestationDigest, round) is public once reveals close, so any party can derive any hold's preimage. Forfeiture is a host policy plus an attributable race, not a cryptographic property (paper §9.1, §10.2 O) | Ordering: the preimage cannot exist before the verdict it commits to; a settle contrary to the plan is attributable (the published preimage matches the published witness); Panel B's script-enforced path has no such exposure | Holds are host-operated in the current deployment, and the observation is documented rather than discovered by an attacker | A host-held secret witness (makes the host a custodian of every slashing claim) or migrate the economic layer to the script-enforced panel; an LN-settlement construction with a script-checked verdict |
| PO-17 | Cross-engine selection ordering: `Math.log` is not required to be bit-identical across ECMAScript engines, so near-ties in `-ln(r)/sqrt(w)` could order differently on two conforming verifiers (paper §4.2) | The 32-bit draws are exactly reproducible from public data, boundary values are clamped, and collisions resolve by the pubkey tie-break — a divergence is *detectable* by recomputation | One implementation is deployed; the draw is public and re-checkable per selection | Compare priorities exactly (or publish computed priorities with a pinned tolerance + tie-break), or replace the transcendental with a fixed-point transform |
| PO-18 | Attribution is detective and host-mediated: the journal builder/verifier ship (Theorem 6, INV-ATTRIB-1/2), but the append-only log, head publication/gossip, per-participant entries and the mechanical batch-signing duty (INV-ATTRIB-3) do not — an unjournaled session stays unattributable (P1/P2 are caller obligations) | Record format + verifier exported and tested (8 cases); `identityPinned` makes the certified-share pin explicit; the paper/model now state the detective boundary instead of implying linkability | Detection is a post-hoc slashing/reputation control; v1 already trusts the host for release (A7), so host-side journaling adds evidence without adding a new trust assumption; no validator or signature change | v0.11: append-on-aggregate in the host, per-participant signed entries, signed tree heads + gossip, and batch-manifest binding into the signed FROST message (`docs/ATTRIBUTABLE_SIGNING.md` §5.2) |

---

## 7. Summary of the argument's shape

- **Cryptographic core (A1–A3):** sound by construction against <t insiders
  — FROST/RFC 9591 binding factors, Shamir privacy, PoK-fenced DKG, strict
  BIP-340 verification at every site, all pinned executably (149 invariants;
  3M-state model checking; differential parity with zero disagreements).
- **Settlement binding (A7 = paper A6, PO-15):** *not* cryptographic in v1. The
  court attests, the host releases; the winner must co-sign, so the cohort
  cannot redirect funds, but the host can release without a verdict and choose
  among valid ones. This is the one place where the honest claim is weaker than
  the protocol's design target, and it is stated as an assumption (§1.5 of
  `docs/FORMAL_INVARIANTS.md`) rather than implied away.
- **Boundary integrity (A2, §5):** carries one deliberate, documented trust
  shape — *caller-pins-not-the-event* — with every unpinned consequence
  reproduced by a named adversarial test.
- **Economic layer (A4, A6, PO-1):** the honest center of gravity. Above the
  threshold, security *is* economics: unpredictable selection, observable
  commit-reveal, idempotent clawbacks, and SLA composite capping. These are
  implemented and attack-tested (round-10), but not equilibrium-proven.
- **Liveness (A5):** bounded by construction (deadlines → expiry → refund),
  empirically validated, not theorem-proven under partition (PO-3).
- **Deployment residuals (PO-5, PO-14):** concentrated in the single-process
  prototype and Node-host operational hygiene — both are production gates,
  not protocol defects.

Every claim in §§4–6 maps to executable evidence via docs/CROSS_CHECK.md;
gaps found during that cross-check are filed as findings there rather than
duplicated here.
