# Realization theorems — Π realizes DEF-1…4 (Round 20)

These are the proofs that the shipped protocol Π (00-definitions §0.1)
realizes the four game-based definitions of
[`00-definitions.tex.md`](00-definitions.tex.md). Proof technique throughout:
**reduction to the round-18 primitives** — each theorem is a game-hop or
hybrid argument whose non-elementary steps cite T1–T5
(`docs/proofs/01…05-*.tex.md`), the literature (KG20 / RFC 9591 / RFC 6962),
or a registered premise of 00-definitions §6. Steps that are neither
elementary nor cited are **lemma-gaps** and are registered in
[`02-limitations.tex.md`](02-limitations.tex.md) §4 — none are papered over.

Per-theorem status is stated up front and honestly:

| Theorem | Realizes | Status |
|---|---|---|
| THE-1 | DEF-1 attestation unforgeability | **Conditional reduction** (full on S1–S6, B1–B3; no unconditional claim possible — GAP-5b of T5) |
| THE-2 | DEF-2 verdict consistency | **Full** on the pipeline direction + validator binding; conditional on S1/S2 for the "genuinely group-signed" step |
| THE-3 | DEF-3 finality soundness | **Full** on the structural chain checks (downgrade/threshold/splice fail closed, unconditional); conditional on S1/S2 for the per-round threshold fact |
| THE-4 | DEF-4 confirmation liveness | **Conditional** — full under the delivery model L1; the partition/kill case is *excluded by the definition*, stated not hidden |

---

## THE-1 — Attestation unforgeability (realizes DEF-1)

> **Theorem 1.** Under premises **S1–S6, B1–B3, H-JS1, H1** (00-definitions
> §6), Π is attestation-unforgeable: for every PPT adversary $\mathcal{A}$
> in game `ATTFORGE`,
> $$\Pr[\mathcal{A}\text{ wins}] \;\le\; \Pr[\mathsf{EUF\text{-}CMA}^{-1}] +
> \Pr[\mathsf{FROST}^{-1}] + \Pr[\mathsf{S5\ fidelity}^{-1}] \;=\;
> \mathsf{negl}(\lambda).$$

### Proof (game hops)

**Game G0** — the real `ATTFORGE` experiment (DEF-1).

**Hop G0 → G1 (machine discipline is unconditional).** Replace the honest
jurors' machine executions with an abstract process that (a) accepts only
tuples $\tau \in \mathcal{T}$ into signing, and (b) executes FROST per S3's
nonce rules. Claim: this changes $\mathcal{A}$'s view by nothing, *unless*
some reachable state violates INV-SIGN-1…15 or the vote/confirmation
invariants feeding $\mathcal{T}$ — which is impossible by **B2** (T4's
structural induction over event sequences: every reachable state of every
machine satisfies the invariant bundle; creation guards are the base case,
the per-handler walk is the step) — *modulo* **H-JS1** (states only arise
from `create`/`reduce`; the mitigation layers are T4 §8's). Concretely:

- the message $\mathfrak{m}$ of any signing attempt is frozen before any
  nonce commitment (INV-SIGN-1; `courtSigningMachine.ts:269–360`) — so
  $\mathcal{A}$ (as coordinator) **cannot** adapt $\mathfrak{m}$ after seeing
  commitments: the Drijvers/Wagner concurrent-session fence is structural,
  not probabilistic;
- partials are accepted only from the frozen distinct signer set
  (INV-SIGN-4/8/10), one per signer, with equivocation aborting with blame;
- by **S6**, an honest juror contributes partials only to sessions whose
  `verdictHash` equals `hashDisputeVerdict` of its own certified tally —
  and by **B3** that hash is a pure function of the certified reveal
  multiset. Hence every attempt an honest juror *ever* signs has
  $\tau \in \mathcal{T}$: the coordinator cannot "invent" a signable tuple.

Loss of the hop: $0$ (given H-JS1/B2 — structural, not computational).

**Hop G1 → G2 (the signed message determines the tuple).** In G1, a
validating event $E$ carries $\sigma$ with
`schnorr.verify(σ, msg, Q) = true` where `msg` is the validator's
reconstruction (`validator.ts:264–273` v1 / `670–685` v2). By **B1** (T1:
the canonical encoding is injective and parses uniquely) the reconstructed
message determines exactly one tuple
$\tau' = (d, \omega, r, [\text{v2: signer-set/epoch/tier/threshold}])$ —
two distinct tuples cannot yield the same `msg`, and the event's tags cannot
yield a different tuple than the signed one (the validator compares
tag-by-tag against the reconstruction, INV-VAL-6/7/10). So $\tau(E) = \tau'$
is *the* tuple the group signed. Loss: $0$ (B1 is unconditional; H1 backs
SHA-256 determinism in the hash step).

**Hop G2 → G3 (reduce to FROST).** Suppose $\mathcal{A}$ wins G2: a
validating $E$ with $\tau(E) \notin \mathcal{T}$. By hop G1→2 the group
signature verifies over $\mathfrak{m}(\tau')$ with $\tau' \notin
\mathcal{T}$. By **B2** + **S6**, no honest signing execution ever
aggregated partials over $\mathfrak{m}(\tau')$ (that is exactly what
$\tau' \notin \mathcal{T}$ means, 00-definitions §0.3). So a valid group
signature under $Q$ exists for a message over which no honest aggregation
ran. By T5's three-case analysis (`05-threshold-soundness.tex.md` §5) —
which we invoke verbatim as a lemma — every such signature implies one of:

1. a **Schnorr forgery** under $Q$ with oracle access limited to honest
   rounds → breaks **S1**;
2. a **FROST-level forgery** (aggregation without ≥ t distinct certified
   shares, or cross-session ROS manipulation) → breaks **S2** under the
   nonce preconditions **S3** (the machine enforces them structurally by
   hop G0→1; CRYPTO_AUDIT §1.1/§1.4 pins the binding-factor and derivation
   rules);
3. the adversary **knows the group secret** of $Q$ → by **S4** that requires
   ≥ t distinct certified shares, i.e. ≥ t corrupted jurors — excluded by
   the game's $|C_{\mathcal{A}}| < t$.

In cases 1–2 we build the corresponding forger by *embedding*: the
reduction simulates all machine traffic (it sees everything — the
transcript is public), forwards honest partial-signature computations as
its EUF-CMA/FROST signing oracle queries, and outputs
$(\mathfrak{m}(\tau'), \sigma)$ from the winning event. The embedding is
valid because the message is fixed before commitments (hop G0→1), so
oracle queries never need to adapt to $\mathcal{A}$'s output. Case 3
contradicts the game's corruption bound directly. Losses: exactly
$\Pr[\mathsf{S1}^{-1}] + \Pr[\mathsf{S2}^{-1}] + \Pr[\mathsf{S5}^{-1}]$
(the last because the FROST-level semantics are the dependency's, per
**S5** / GAP-5a).

Summing the hops: $\Pr[\text{win G0}] \le \mathsf{negl}(\lambda)$. ∎ THE-1

> **Remark 1.1 (what is NOT claimed).** THE-1 says nothing about
> ≥ t-corrupted cohorts (they can "forge" trivially — their own key, by
> design; the economics round's PO-1 analysis covers why that is not an
> attack), about eclipse *liveness* (DEF-4's domain), or about v1 events
> beyond the un-parameterized tuple variant (Remark 1.2 of 00-definitions).

---

## THE-2 — Verdict consistency (realizes DEF-2)

> **Theorem 2.** Under **S1, S2, S3, S5, S6, B1, B2, B3, H-JS1**, Π is
> verdict-consistent: every final-published, validating kind-39007
> attestation's `outcome` equals $\mathrm{Plurality}(D_E)$ over the
> certified set it cites.

### Proof

Unfold the win condition into two independent claims and discharge each:

**Claim A (outcome ⇔ cited-reveals binding — unconditional).** A validating
$E$ satisfies: the `verdict` tag equals
$\mathsf{hashDisputeVerdict}(d, \omega, \mathrm{ids}_E)$ where $\mathrm{ids}_E$
are the event's own `e`…`mention` ids (`validator.ts:170–209` v1 / `510–548`
v2 — recomputed from the event, not taken on faith; malformed ids, >10 000
entries, duplicates, or a throwing helper all fail closed). By **B1** the
signed message binds $(d, \omega, r, \text{verdictHash})$ as a unit; hence
$\omega$ is exactly the outcome the group attested **for the cited id set**.

**Claim B (cited set = certified tally — conditional on B2/B3/S6, same
machinery as THE-1's hop G0→1).** The signing session that produced $E$ was
instantiated (S6) with `verdictHash` = `hashDisputeVerdict` of the juror's
certified machine tally. By **B3**, that tally's winner is a pure function
of the certified reveal multiset; by **B2**, the machine that reached
signing reached it through `finalize_tally` / the confirmation ladder's
`resolve_round` on the frozen ledger (INV-VOTE-20's reorder-invariance,
INV-CONF-32's last-round finality, INV-CONF-33's non-empty-support
fail-closed). The supporting ids published in $E$ are exactly that tally's
supporting ids (`tallyReveals`, `courtVoteMachine.ts:811–834`; finality =
last round, `courtConfirmationMachine.ts:1145–1155`). Therefore
$\mathrm{ids}_E = D$ (the certified set) and
$\omega = \mathrm{Plurality}(D)$.

Composing: $\omega = \mathrm{Plurality}(D_E)$ — the win condition fails. The
only way $\mathcal{A}$ escapes is to make the group sign a verdict hash over
a *fabricated* id set, which is THE-1's game (a never-tallied tuple) —
already bounded by THE-1. ∎ THE-2

> **Remark 2.1 (the honest scope).** Claim B is about attestations produced
> **through the machines** (the pipeline direction of T5(i), unconditional
> given S5). A validating attestation *not* produced by the machines would be
> a forgery — covered by THE-1, not here. This division of labor is
> deliberate: DEF-2 is an integrity property of honest-path output; DEF-1
> rules out honest-path-independent output.

---

## THE-3 — Finality soundness (realizes DEF-3)

> **Theorem 3.** Under **S1, S2, S3, S4, S5, B1, B2**, every final verdict
> accepted by the finality predicate (00-definitions §3) has a chain
> $\chi = (E_0, \dots, E_k)$ in which every round was properly signed at its
> recorded threshold. The three attack families of DEF-3 all fail closed.

### Proof (per attack family)

**(a) Downgrade replay — unconditional.** The shape dispatcher
`validateCourtAttestation` (`validator.ts:815–840`) checks, for a v1-shaped
event (no `epoch` tag), whether any of the `V2_ONLY_POLICY_FIELDS`
(`expectedEpoch`, `minTier`, `minThreshold`, `expectedSignerSetRoot`,
`expectedBatchMerkleRoot`, `signerSet` — `validator.ts:770–778`) was
requested; if so it returns a typed invalid result with the explicit
downgrade refusal (`validator.ts:830–840`). A finality predicate run
consistent with the documented consumer contract pins the v2 policy fields;
hence a v1-shaped round event **cannot** validate inside such a chain — the
replay dies at the dispatcher, before any signature check. The frozen v1
path (INV-VAL-16, F-6) is unchanged, so this is a property of the shipped
code, not of a policy layer. ∎ (a)

**(b) Threshold substitution — conditional on S1/S2/S3 via THE-1 + B1.**
For a v2 round $E_i$: the `threshold` and `signers` tags are bounded and
parsed (`validator.ts:554–578`); the signer-set root recomputes
(`hashSignerSetRoot`, `validator.ts:353–378`) and, when the verifier
supplies the full set, must match **and** have
$|\text{set}| = \text{threshold}$ (INV-VAL-11/12, `validator.ts:619–632`);
both are bound into the **signed** message (`buildAttestationMessageV2`,
validator reconstruction 670–685). By **B1** the signed message determines
these fields; by T5's v2 corollary (`05-threshold-soundness.tex.md` §5
corollary — invoked as a lemma) a validating v2 event implies ≥ t **equal to
the tagged threshold** distinct certified shares produced σ. So a recorded
threshold higher than the producing signer set is unattainable without a
new FROST aggregation over the *substituted* message — which is a fresh
honest-path signing attempt (THE-1's domain) or a forgery (S1/S2). The
subtler variant — re-signing the same tags with a **fresh key** at elevated
tier — is not a DEF-3 win at all: the finality predicate pins
`expectedGroupPubkey = Q` (the MUST-pin boundary, `validator.ts:767–812`
SECURITY note; SEQUENCE-3), and without the pin "the group signed" is
vacuous *by construction of the validator* (Remark 6.1 of T5). ∎ (b)

**(c) Chain splice — unconditional at the structural layer + conditional on
S1 via THE-1.** Every round's message binds
$(d, \omega, r, \text{epoch}, \text{tier}, \text{threshold},
\text{signerSetRoot})$ (INV-VAL-6/7/10) and the verifier's finality
predicate pins a **single consistent `expectedEpoch`** across the chain —
the documented batch-chaining contract (SEQUENCE-1: a `batch`-tagged
attestation must be validated together with its kind-39018 batch event under
the same epoch, with matching Merkle roots). A round from a different
session or epoch fails the pins or the reconstruction comparison; a batch
root from another epoch fails the cross-validation. What remains is
forging a group signature over the spliced message — THE-1. The ladder
linkage itself (`resolve_round` → `escalate` → next round, consecutive
rounds + cap, INV-CONF-19) is **B2**: reachable-state induction, so a
"chain" whose round structure the machine never produced is not one the
finality predicate's walk (condition 1 of 00-definitions §3) can traverse —
the walk validates each round's *machine-published* events, and
non-machine state is not part of any transcript. ∎ (c)

**Composition.** A DEF-3 win requires one of (a)–(c) to succeed; all are
excluded under the stated premises. ∎ THE-3

> **Remark 3.1 (hybrid structure — the idealized/real gap).** The chain
> abstraction itself is an *idealization*: the "chain" is a verifier-side
> graph over published events, and its ideal functionality would be a
> single signed chain pointer. The real protocol instead re-binds every
> field per round and lets the verifier walk the graph under consistent
> pins. The hybrid H₀ (ideal chain pointer) ≈ H₁ (per-round rebinding) step
> is exactly B1 (injectivity: the rebinding determines the same chain) with
> loss 0; the H₁ ≈ real step is THE-1's reduction. No unproven interpolation
> is hidden between them.

---

## THE-4 — Confirmation liveness (realizes DEF-4) — *conditional*

> **Theorem 4 (conditional on L1).** Under the delivery model **L1**
> (Δ-bounded relay delivery to non-eclipsed honest jurors, coordinator
> dispatch liveness, clock monotonicity INV-VOTE-4/CONF-10) and **T5(i)
> completeness + S5**, DEF-4 holds: quorum-met cases reach finality within
> the stated deadline bound; quorum-missed cases terminate in the Path-C
> refund, never a silent hang.

### Proof

The proof is deadline arithmetic over the machine's reachable states —
**B2** gives that every state the argument visits is actually reachable
behavior, and the tick table is the engine:

1. **Confirmations land.** Each honest juror's confirmation, published
   before $\mathrm{deadline}_{\mathrm{confirm}} - \sigma$, is delivered
   within Δ (L1) — i.e. before the deadline — so `accept_confirmation`
   passes its phase-exact and window guards (INV-CONF-11/12; the window
   comparison is `now < deadline` with monotonic clocks, INV-CONF-10).
   Redelivery is idempotent (INV-CONF-16), so duplicates cannot stall
   either.
2. **The quorum gate opens.** With ≥ `confirmQuorum` distinct-roster
   confirmations recorded, `close_confirmations` is legal (INV-CONF-15's
   gate is satisfied exactly) — and if the coordinator fails to dispatch,
   the tick table fires the *same* transition at the deadline (INV-CONF-13:
   `confirm_open` expires at `confirmDeadline`) or, when challenges exist,
   the ladder proceeds.
3. **The ladder is bounded.** Each challenge round is opened only with a
   bonded challenge (INV-CONF-17), runs `ladder_vote_open` until
   `ladder.voteDeadline` (INV-CONF-13), and `open_ladder_round` requires
   consecutive rounds under the cap (INV-CONF-19, ≤ 5 by INV-CONF-6).
   Hence after at most $k \le 5$ rounds the machine reaches
   `round_resolved` → `fee_settlement`/final.
4. **Finality mints and attests.** `finalize` derives the verdict from the
   last resolved round (INV-CONF-32) and **fails closed** on empty support
   (INV-CONF-33) — but the quorum-met hypothesis guarantees a non-empty
   confirmation ledger, so the typed error is unreachable on this path.
   The FROST ceremony over the finalized verdict completes within
   $\Delta_{\mathrm{sign}}$ by **T5(i)** (FROST completeness: given ≥ t
   honest participants' partials — which the quorum hypothesis and
   roster ≥ 3, quorum ≤ n bounds provide — the aggregate verifies and is
   published; S5 pins the engine's semantics).
5. **The quorum-miss case is safe by construction.** INV-CONF-15's
   fail-closed gate makes a silent close *illegal*; INV-CONF-13's tick
   expires the awaiting phase; INV-CONF-14's terminal absorption moves the
   case to the refund terminal. Every reachable non-terminal phase has
   exactly one of {input, deadline-tick, abort} as an outgoing edge —
   there is no absorbing non-terminal state (this is the model-checked
   core, cross-verified by the mechanized round's Quint spec
   `proofs/mechanized/court.qnt`).

Steps 1–5 are elementary given B2 (state reachability), the cited
invariant guards, T5(i) (completeness), and L1 (delivery/clocks/dispatch).
∎ THE-4

> **Remark 4.1 (what "conditional" means here — stated, not hidden).**
> Drop any L1 conjunct and THE-4's bound fails *as a bound*, not as safety:
> a relay partitioning one juror (ADV-NET) removes its confirmations (the
> quorum may then never form — the definition's own case split sends the
> case to Path-C refund); a crashed coordinator delays dispatch
> indefinitely (the machines cannot self-drive — ADR 0001); clock skew > σ
> can push an on-time confirmation past the window guard. **No liveness
> theorem for the partitioned case is claimed anywhere in this round** —
> that is PO-3 (`docs/THREAT_MODEL.md` §6), owned by 02-limitations §2.
> Integrity (DEF-1/2/3) is untouched by L1: partition can delay or strand
> honest material, never validate a false one.

---

## Status summary

| Theorem | Claim | Non-cited steps | Gap register |
|---|---|---|---|
| THE-1 | Conditional reduction to S1/S2(+S3)/S4, with S5 fidelity | none (all hops elementary or T1/T4/T5-cited) | GAP-5a (S5), GAP-5b (conditionality) |
| THE-2 | Full on the honest path (Claim A unconditional; Claim B via B2/B3/S6) | none | inherits THE-1's |
| THE-3 | (a)/(c)-structural unconditional; (b) conditional on S1/S2 via THE-1 | the hybrid step is B1, cited | inherits THE-1's |
| THE-4 | Conditional on L1; quorum-miss case = refund by construction | none | PO-3 (partition liveness) explicitly out of scope |
