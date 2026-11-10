# Security definitions — the game-based layer (Round 20)

These are the **ideal-level security definitions** of BAO Court's attestation
layer, in the GMR/CryptoVerse game-based style: for each property, an
explicit **experiment** (a simulator could be coded against it verbatim), a
**win condition**, and an explicit **premise register**. The companion file
[`01-theorems.tex.md`](01-theorems.tex.md) proves that the shipped protocol
(the four phase machines + validator + ceremony) **realizes** these
definitions; [`02-limitations.tex.md`](02-limitations.tex.md) states what
they deliberately do not cover.

Every definition is written to be *attackable*: if you think a definition is
vacuous, or that the protocol does NOT realize it, the game tells you exactly
what to build. Nothing here is informal prose dressed as a theorem — each
experiment is pseudocode, each premise is registered in §6 and cited to
`file:lines` or to the round-18 proofs (T1–T5 in `docs/proofs/`).

---

## 0. Conventions and the real protocol Π

### 0.1 Parties and adversary

The protocol Π is the shipped BAO Court core:

| Component | Artifact | Role |
|---|---|---|
| Vote machine | `courtVoteMachine.ts` (INV-VOTE-1…23) | commit/reveal plurality tally → frozen verdict |
| Confirmation machine | `courtConfirmationMachine.ts` (INV-CONF-1…36) | universal confirmation, challenge bonds, ≤5-round ladder, `finalize` |
| DKG machine | `courtDkgMachine.ts` (INV-DKG-1…11) | Pedersen t-of-n DKG, unanimous single-transcript certification |
| Signing machine + FROST engine | `courtSigningMachine.ts`, `signing.ts` (INV-SIGN-1…15) | threshold Schnorr attestation |
| Validator | `validator.ts` (INV-VAL-1…16, v1 + v2 + dispatcher) | the acceptance predicate |

Parties, with the exact adversary tuple of `docs/THREAT_MODEL.md` §2.1:

- **Jurors** $J = \{1,\dots,n\}$, FROST threshold $t$, certified group key $Q$
  (BIP-340 x-only) from a completed DKG.
- **Coordinator $C$** (ADV-COORD): drives every machine — creates states,
  closes phases, dispatches, may withhold/reorder/delay/replay events to
  peers, may run restored-snapshot recovery, may instantiate *multiple*
  signing sessions. **Has no shares** and cannot alter frozen machine states
  undetected (freeze discipline, INV-VOTE-23/CONF-36/SIGN freeze, T4 §8).
- **Relay $R$** (ADV-RELAY ⊕ ADV-NET): drop, reorder, delay, duplicate,
  partition views, replay old events, append hostile tags to re-published
  events. Cannot forge event ids (NIP-01 id + Schnorr bind content).
- **Adversary $\mathcal{A}$** in every experiment below = the coalition
  $\text{ADV-COORD} \cup \text{ADV-RELAY} \cup \text{ADV-JUROR-<t}$: static
  corruption of a juror set $C_{\mathcal{A}}$ with $|C_{\mathcal{A}}| < t$
  (their shares, their event-signing keys), plus full control of $C$'s
  machine-driving and $R$'s transport. $\mathcal{A}$ is PPT; all hashes are
  SHA-256; all signatures BIP-340 Schnorr.

### 0.2 Attestation tuples

Fix a dispute session $d$ (the canonical 32-byte lowercase dispute id; the
session hash `sessionHash` = `hashCourtSession(...)` binds roster, ballot,
deadlines, epoch — `courtSession.ts`, INV-CORE-*). Define the
**attestation tuple** of a signing attempt $a$ as

$$\tau(a) \;=\; (\,d,\ \omega,\ r,\ \mathrm{sctx}(a)\,)$$

where:

- $\omega$ = the outcome string in the signed message
  (`buildAttestationMessage`/`buildAttestationMessageV2`),
- $r$ = the round tag (v1) / round + attempt + epoch + tier + threshold +
  signerSetRoot tags (v2),
- $\mathrm{sctx}(a)$ = `hashCourtSigningSession`'s input tuple
  $(\text{sessionHash}, \text{verdictHash}, \omega, \text{roster}, t,
  \text{attempt})$ — `courtSigningMachine.ts:230–254`.

Two tuples are **equal** iff all components are equal. The signer-set
component of $\tau$ is treated **per version** (T5 Remark 6.2, stated
honestly): for **v2**, the `signers` tag commits to the sorted distinct index
set under `SignerSet/v1` (`validator.ts:353–378`) and is bound into the
signed message, so $\tau$'s signer-set component is *event-verifiable*; for
**v1**, no signer-set commitment exists in the signed material — the
component is taken to be the *protocol-level* set guaranteed to exist by
T5(ii) (≥ t distinct certified shares), which a third party cannot re-derive
from the event alone.

### 0.3 The tallied set

For an execution of Π, the **tallied set** $\mathcal{T}$ is the set of tuples
$\tau$ such that **some machine execution reached signing with $\tau$**:

- the vote machine for session $d$ reached `tally_final` (or the confirmation
  machine's `finalize`/mass-vote path resolved round $r$) with winner $\omega$
  over its **certified** reveal/confirmation ledger,
- the signing machine for $(d, \omega, r, \text{attempt})$ was instantiated
  with $\mathrm{sctx}(\cdot)$ derived from that finalized state — i.e. its
  `verdictHash` = `hashDisputeVerdict` of that tally (`courtVoteMachine.ts:302–345`)
  and its message was bound **before** any nonce commitment was accepted
  (INV-SIGN-1, `courtSigningMachine.ts:269–360`).

$\mathcal{T}$ is an *execution-dependent*, public, observer-recomputable
object: every element is derivable from the published machine events (the
commit/reveal ledger, the signing session events). A tuple is **never
tallied** if it is not in $\mathcal{T}$ for the execution under attack.

> **Remark 0.1 (why "tallied" is the right anchor).** The coordinator can
> instantiate a signing machine for *any* syntactically well-formed tuple —
> machine `create` is unprivileged. What it cannot do is make honest jurors
> contribute partials to a session whose verdict hash does not match the
> tally their own machine derived (premise **S6** below). Hence $\mathcal{T}$
> = tuples with at least one honest-signed attempt, and "never tallied"
> attacks are exactly "attestations about verdicts no honest juror ever
> voted on".

---

## 1. DEF-1 — Attestation unforgeability (game `ATTFORGE`)

> **Definition 1 (Attestation unforgeability).** Fix an empaneled cohort
> $(n, t, Q)$ produced by a completed, unanimously certified DKG, and an
> honest execution of Π on a set of dispute sessions $\mathcal{D}$. The
> adversary $\mathcal{A}$ (§0.1) interacts with the following oracles:
>
> - $\mathcal{O}_{\mathrm{run}}$ — the **ceremony oracle**: $\mathcal{A}$
>   drives the coordinator role arbitrarily (create/close/abort machines,
>   instantiate signing sessions, run recovery) and honest jurors execute
>   their machine algorithms faithfully (per **S6**); all published traffic
>   is visible to $\mathcal{A}$.
> - $\mathcal{O}_{\mathrm{relay}}$ — full ADV-RELAY/ADV-NET powers over
>   delivery of every published event.
>
> **Win.** $\mathcal{A}$ outputs a Nostr event $E$ of kind 89 or 39007 and a
> context $\Gamma$ pinning `expectedGroupPubkey = Q` (for v2 additionally
> the full finality policy: `expectedEpoch`, `minTier`, `minThreshold`,
> `expectedSignerSetRoot` as applicable) such that
>
> 1. $\mathsf{validateCourtAttestation}(E, \Gamma) = \{\text{valid:
>    true}\}$ (the shipped dispatcher, `validator.ts:815–840`), **and**
> 2. the tuple $\tau(E)$, extracted per §0.2, is **not** in the tallied set
>    $\mathcal{T}$ of the executed transcript ($\tau$'s session was either
>    never voted to $\omega$, never resolved at round $r$, or (v2) never
>    signed by the signer set claimed).
>
> $\Pi$ is **attestation-unforgeable** if for every PPT $\mathcal{A}$,
> $\Pr[\mathcal{A} \text{ wins}] \le \mathsf{negl}(\lambda)$ in $\lambda$ =
> the Schnorr security parameter.

**The reduction target.** THE-1 (in `01-theorems.tex.md`) proves DEF-1 by
reduction to:

- **S1** BIP-340 Schnorr EUF-CMA under the pinned key (round-18 T5 §3),
- **S2** FROST soundness (KG20 eprint 2020/852 / RFC 9591) under its
  preconditions,
- **S3** the nonce rules (aux-mixed derivation, one-consumption
  `NonceGuard`, one commitment/one partial per signer, message bound
  pre-commitment) — the KG20 preconditions as enforced in code,
- **S4** the DKG Shamir t-of-n sharing with unanimous certification,
- **S5** `@vbyte/frost` 1.1.5 implements the S2 semantics,
- **B1 (T1 injectivity)** the `CanonicalWriter` encoding has a left inverse
  and is injective per schema — so the reconstructed attestation message
  determines **exactly one** tuple $(d, \omega, r, \text{fields})$
  (`docs/proofs/01-encoding.tex.md`),
- **B2 (T4 safety)** every reachable state of the signing machine satisfies
  INV-SIGN-1…15 — in particular the message is frozen before commitments and
  partials come only from the frozen distinct signer set
  (`docs/proofs/04-machine-safety.tex.md`),
- **B3 (T3 well-definedness)** the tally winner is a pure function of the
  reveal multiset with the canonical UTF-8 tie-break
  (`docs/proofs/03-tally.tex.md`),
- **S6 (tally-path discipline — the honest-signer algorithm)** an honest
  juror's signing client instantiates a signing session **only** with
  $\mathrm{sctx}$ whose `verdictHash` = `hashDisputeVerdict` computed from
  the juror's *own* certified vote/confirmation machine state for $d$
  (`independentSigning.ts:112–131` — the verdict hash enters the bound
  attestation message at construction and is thereafter immutable;
  INV-SIGN-1/2 re-derive it at every machine reduce).

> **Remark 1.1 (oracle access is real, not idealized).** The experiment's
> oracles are *the actual transcript*: nothing grants $\mathcal{A}$ signing
> queries for chosen messages beyond what the coordinator can honestly
> provoke — which is the FROST RO setting S2 analyzes (the adversary may
> initiate rounds; each round's message is fixed before commitments by S6 +
> INV-SIGN-1). This is the same "adaptive oracle access to honest signing
> computations" T5 §3 S1 states; no stronger oracle is assumed.

> **Remark 1.2 (v1/v2 asymmetry in the win condition).** For v1 events, win
> condition 2 uses the protocol-level signer set (existential, by T5(ii));
> a v1 event therefore cannot support a win of the form "valid attestation
> for an untallied tuple **signed by signer set $S$**" unless $S$ is pinned
> via the (v2-only) `expectedSignerSetRoot` — v1 has no in-band signer-set
> commitment. This is the round-18 v1/v2 asymmetry promoted to the
> definition: DEF-1 is *fully parameterized* only on the v2 path; the v1
> path realizes the un-parameterized variant (tuple without the signer-set
> component).

---

## 2. DEF-2 — Verdict consistency (game `VERDICTCONS`)

> **Definition 2 (Verdict consistency).** In the same setting as DEF-1,
> call a kind-39007 event $E$ **final-published** if it is the attestation of
> the verdict the confirmation machine's `finalize` produced for session $d$
> (INV-CONF-32: outcome = the LAST resolved round's winner; supporting ids =
> that round's winning vote ids, or the confirmation ledger when no challenge
> was raised — `courtConfirmationMachine.ts:1145–1155`).
>
> **Win.** $\mathcal{A}$ produces a final-published attestation $E$ with
> $\mathsf{validateCourtAttestation}(E, \Gamma) = \text{valid}$ (group key
> pinned to $Q$) whose `outcome` tag $\omega$ **differs from**
> $\mathrm{Plurality}(D_E)$, where $D_E$ is the certified reveal /
> confirmation set **cited by $E$** (the `e` … `mention` supporting event
> ids) and $\mathrm{Plurality}$ is the round-18 tally function: max count,
> ties broken by lexicographic unsigned-UTF-8 byte order
> (`courtVoteMachine.ts:811–834`, `compareOutcomeUtf8` at 178–187).
>
> $\Pi$ is **verdict-consistent** if $\mathcal{A}$'s win probability is
> negligible.

**What DEF-2 formalizes.** This is `hashDisputeVerdict`'s reason for
existing, promoted to a security property: the attestation does not merely
carry an outcome — it *certifies the tally*. The validator's verdict-binding
check (`validator.ts:170–209` v1, `510–548` v2) recomputes
`hashDisputeVerdict{disputeId, outcome, supportingIds}` from the event's own
tags and demands equality with the signed `verdict` tag; by **B1** the
message determines the tuple, so a signed verdict hash pins (dispute,
outcome, cited-reveals) as a unit. DEF-2 then needs only: *the cited reveals
are the certified tally's supporting set* — which is the **B2** machine
invariant chain (the signing session's `verdictHash` derives from the vote
machine's `tallyReveals` on the frozen ledger; INV-VOTE-20's
reorder-invariance and INV-CONF-32's last-round finality).

> **Remark 2.1 (the certified set, not the raw ledger).** $D_E$ ranges over
> the **certified** reveal set — reveals accepted into the frozen ledger
> under INV-VOTE-11…19 (one reveal per commit, commit-bound outcome/salt,
> deadline gates) — not over arbitrary published events. This is why a
> relay cannot "help" $\mathcal{A}$ by serving extra reveals: only
> ledger-accepted reveals are tally inputs (B2/T4).

---

## 3. DEF-3 — Finality soundness (game `CHAINFORGE`)

The consumer-side **finality predicate** is the composition the validator's
dispatcher documents (`validator.ts:767–812`): a verdict on session $d$ is
**final** for a verifier when

1. **chain walked** — the verifier validated, with the group key pinned to
   $Q$ and consistent `expectedEpoch`, the attestation of **every** ladder
   round $0..k$ of $d$'s resolved chain (each round's kind-89/39007
   attestation, and any kind-39018 batch attestation chained through the
   `batch` tag with matching Merkle roots — SEQUENCE-1 of
   `adversarialCrossModule.test.ts`), and
2. **appeal windows closed** — the confirmation machine for $d$ is in a
   near-final/terminal state with `ladderRound` = the last permitted round
   (INV-CONF-6: `maxLadderRounds ≤ 5`), the challenge deadline has passed
   (INV-CONF-13's tick table), and no challenge bond is outstanding
   (INV-CONF-17), i.e. per `appealTiming.ts` no appeal phase
   (`DEFAULT_APPEAL_TIMINGS`) is active.

> **Definition 3 (Finality soundness).** Call a chain
> $\chi = (E_0, \dots, E_k)$ **properly signed** if every $E_i$ validates
> under $Q$ with the v2 finality policy pins at **exactly the values
> recorded in $\chi$'s own round fields** (each round's `threshold`,
> `signerSetRoot`, `epoch`, `tier` as tagged and bound into
> $E_i$'s signed message), and consecutive rounds are linked by the ladder
> state machine (`resolve_round` → `escalate` → next round's vote, INV-CONF-19).
>
> **Win.** $\mathcal{A}$ presents a final verdict for session $d$ accepted by
> the finality predicate such that **some** round $E_i \in \chi$ is **not**
> properly signed — in particular:
>
> - **(downgrade replay)** $E_i$ is a v1-shaped event standing in for a
>   round whose policy required v2 finality fields (the dispatcher refuses:
>   `V2_ONLY_POLICY_FIELDS` requested of a v1-shaped event is a hard
>   rejection, `validator.ts:830–840`), or
> - **(threshold substitution)** $E_i$'s recorded threshold exceeds the
>   signer set that actually produced it (blocked by the `signers` tag's
>   in-band binding + INV-VAL-12's `|set| = threshold` + B1's injectivity of
>   the bound message), or
> - **(chain splice)** $E_i$ is a valid attestation of a *different*
>   session/epoch spliced into $\chi$ (blocked by the message reconstruction
>   binding all of $(d, \omega, r, \text{epoch, tier, threshold,
>   signerSetRoot})$ — INV-VAL-6/7/10 — and the verifier's consistent
>   `expectedEpoch` pin across the chain).
>
> $\Pi$ has **finality soundness** if $\mathcal{A}$'s win probability is
> negligible.

**Why this definition is not vacuous.** Each failure mode names a concrete
adversarial construction a simulator can attempt: replay a stale low-threshold
attestation into a high-policy chain; re-sign tags with a fresh key under an
elevated tier (SEQUENCE-3); splice a batch root from another epoch. THE-3
proves all three fail closed under the stated premises.

---

## 4. DEF-4 — Confirmation completeness / liveness (game `CONFLIVE`)

Liveness definitions need an environment model; we state the partition
assumption **as part of the definition**, not as an afterthought.

> **Environment model (delivery).** Let $\Delta$ be the **delivery bound**:
> any event published by an honest party in phase $p$ is delivered to every
> non-eclipsed honest participant within $\Delta$ seconds, **unless** the
> relay-eclipse adversary has eclipsed the recipient (in which case the
> recipient is excluded from the liveness claim). Local clocks are
> monotonic and within skew $\sigma$ of a common reference (the machines'
> deadline comparisons are on Unix seconds — INV-VOTE-4/CONF-10).
>
> **Definition 4 (Confirmation completeness).** If, by
> $\mathrm{deadline}_{\mathrm{confirm}} - \sigma$, at least
> `confirmQuorum` **honest** jurors (roster members, per INV-CONF-2's
> panel ≥ 3 and INV-CONF-4's quorum range) each publish a well-formed
> confirmation of the proposed outcome, and the coordinator dispatches
> `close_confirmations` (or the tick table fires per INV-CONF-13), then the
> case reaches **finality** — `finalize` mints the verdict (INV-CONF-32) and
> DEF-2's final-published attestation exists — **within**
> $\mathrm{deadline}_{\mathrm{confirm}} + \Delta_{\mathrm{sign}}$, where
> $\Delta_{\mathrm{sign}}$ bounds the FROST ceremony duration under the
> delivery model.
>
> **The deadline bound (stated with the case split it induces).**
> - **Quorum met by the deadline** → `close_confirmations` is legal
>   (INV-CONF-15: the gate is $|\text{confirmations}| \ge
>   \text{confirmQuorum}$) and the case proceeds; if challenges exist, each
>   ladder round is bounded by its `voteDeadline` (INV-CONF-19's consecutive
>   rounds + cap), so finality arrives by
>   $\mathrm{deadline}_{\mathrm{confirm}} + k \cdot W_{\mathrm{ladder}} +
>   \Delta_{\mathrm{sign}}$ with $k \le 5$ (INV-CONF-6).
> - **Quorum never met** → the machine is *not* silently closable
>   (INV-CONF-15's fail-closed gate): a tick expires it to the **Path-C
>   refund** terminal state (`docs/THREAT_MODEL.md` §4-C, PO-3's "bounded
>   damage"). Liveness of *verdict finality* is then **vacuously not
>   claimed** — the honest statement is: quorum-met cases finalize within
>   the bound; quorum-missed cases terminate in a refund, never a hang.
>
> $\Pi$ satisfies DEF-4 **conditional on the delivery model** (relay
> delivery within $\Delta$ to non-eclipsed jurors, clock monotonicity, and
> coordinator dispatch liveness — the coordinator is the driver per ADR 0001
> and a crashed coordinator is modeled as delivery failure).

> **Remark 4.1 (honesty about the coordinator).** The coordinator is
> untrusted by design (ADR 0001) but the machines are *driven* by it: a
> coordinator that never dispatches `tick` or `close_confirmations` delays
> finality beyond any bound while the case is not aborted. The definition
> therefore conditions on coordinator dispatch liveness, and the
> abort-from-any-phase escape (INV-CONF-14) is the mitigation — a party can
> always move the case to a terminal state, never be trapped in a
> non-terminal one forever *by the machine itself*.

---

## 5. Reading order

DEF-1 → THE-1 (the reduction: everything downstream of "an attestation is a
genuine group signature over a tallied tuple"). DEF-2/DEF-3 reuse THE-1's
machinery plus the validator's binding checks; DEF-4 is orthogonal (liveness
vs. integrity) and rests on machine deadline arithmetic + T5(i)
completeness. The premise registry (§6) is shared.

## 6. Premise registry (complete — nothing assumed silently)

| ID | Premise | Source / enforcement | Used by |
|---|---|---|---|
| **S1** | BIP-340 Schnorr EUF-CMA under pinned $Q$ | round-18 T5 §3; @noble/curves 2.4.0 verification | DEF-1, THE-1 |
| **S2** | FROST soundness (KG20 / RFC 9591) under its preconditions | round-18 T5 §3 | DEF-1, THE-1 |
| **S3** | Nonce rules: aux-mixed HKDF derivation, one-consumption `NonceGuard`, one commitment/one partial, message bound pre-commitment | `signing.ts:88–194, 266–271`; INV-SIGN-1/4/8; CRYPTO_AUDIT §1.1/§1.4 | S2's preconditions |
| **S4** | DKG: Shamir t-of-n, group secret never materializes, unanimous single-transcript certification | INV-DKG-5/6; `dkg.ts`, `independentDkg.ts` | DEF-1, THE-1 |
| **S5** | `@vbyte/frost` 1.1.5 implements S2's semantics | AUDIT probes + AUDIT-4 differential pins (GAP-5a) | THE-1(i), THE-4 |
| **S6** | Tally-path discipline: honest signers instantiate signing sessions only with `sctx` derived from their own certified machine tally | `independentSigning.ts:112–131` (verdict hash bound at construction), INV-SIGN-1/2 | DEF-1, DEF-2, THE-1, THE-2 |
| **B1** | T1 encoding injectivity / unique parse; per-schema prefix-freeness | `docs/proofs/01-encoding.tex.md` | all: message ⇒ tuple |
| **B2** | T4 machine safety: INV-SIGN-*/INV-VOTE-*/INV-CONF-* hold for every reachable state | `docs/proofs/04-machine-safety.tex.md` (+ model checking) | DEF-1, DEF-2, THE-3 |
| **B3** | T3 tally well-definedness (plurality is a function of the multiset) | `docs/proofs/03-tally.tex.md` | DEF-2, THE-2 |
| **H-JS1** | Machine states only via `create`/`reduce` (TS cannot enforce) | freeze + barriers + adversarial restore tests (GAP-4a) | B2's applicability |
| **L1** | Delivery model of DEF-4 (Δ-bounded relay delivery to non-eclipsed jurors; coordinator dispatch liveness; clock monotonicity INV-VOTE-4/CONF-10) | stated **as part of DEF-4**; Nostr gives no membership/consensus/eclipse resistance (THREAT_MODEL ADV-NET) | DEF-4, THE-4 only |
| **H1/H2** | SHA-256 collision resistance; (T2's) manifest endorsement | round-18 T2 §3 | B1's hash-determinism step |

Every proof in `01-theorems.tex.md` cites this register by ID. A premise
falling invalidates exactly the theorems listing it — the register is the
audit trail.
