# Limitations — the honesty register (Round 20)

What DEF-1…4 (`00-definitions.tex.md`) and THE-1…4 (`01-theorems.tex.md`)
**do not** cover. Each entry states: the gap, **why it is out of scope** (a
modeling decision, not an oversight), and **which artifact covers it
empirically** (so the gap has an owner and an owner's evidence). This file
is the round-20 extension of the lemma-gap registers of round 18
(`docs/proofs/04-machine-safety.tex.md` §8, `05-threshold-soundness.tex.md`
§7) — nothing here contradicts them; several entries are their
game-level consequences.

---

## 1. Majority collusion (≥ t corrupt jurors) — *by design*

**The gap.** DEF-1's game fixes $|C_{\mathcal{A}}| < t$. A coalition
controlling ≥ t shares can produce *valid* attestations for **any** outcome
it likes — that is not a bug, it is the definition of threshold signing.
ADV-JUROR-≥t (`docs/THREAT_MODEL.md` §2.1) is the strongest insider
adversary and every guarantee in this round stops at its boundary.

**Why out of scope.** The defense against ≥ t collusion is **economic, not
cryptographic**: stake-backed selection, commit-reveal visibility, Kleros-style
slashing, ×3-per-round ladder clawbacks, 0.8^k compounding. Whether those
mechanics make bribery unprofitable is a *game-theoretic* claim — an
equilibrium argument about the bribe game under unpredictable selection —
which is a different proof discipline (mechanism design) from the
cryptographic reductions of round 20. Round 18 registered this as PO-1
(`docs/THREAT_MODEL.md` §6): no bribe-equilibrium model exists for
$\lceil 2N/3 \rceil$-of-$N$-style majorities under the implemented economics.

**Covered empirically by.** The **economics round**
(`proofs/economics/` — companion of this round), which supplies the
PO-1/κ-bounded collusion-budget analysis (collusion cost κ as a function of
jury size, stake, and clawback schedule) that this round deliberately does
not attempt; plus deployment-stage small stakes and the fact that collusion
is *observable* (public commit-reveal) even where unprevented. At the
protocol layer, DEF-2 still binds a majority-produced attestation to the
**tally it actually cites** — collusion can steer the tally, but cannot
publish an attestation inconsistent with it.

## 2. Eclipse / partition liveness — *PO-3, explicitly unproven*

**The gap.** DEF-4 is conditional on the delivery model **L1** (Δ-bounded
delivery to non-eclipsed jurors, coordinator dispatch liveness, clock
monotonicity). The theorem's own Remark 4.1 lists what breaks the *bound*
when L1 fails: eclipsed jurors' confirmations vanish; a partitioned cohort
may never reach quorum; a crashed coordinator delays dispatch indefinitely.
**No liveness property holds under partition.** What survives partition is
only: (a) *integrity* — DEF-1/2/3 are delivery-independent, a partition can
strand or delay honest material but cannot validate a false attestation;
and (b) *bounded damage* — deadline ticks plus INV-CONF-14's
abort-from-any-phase move stranded cases to the Path-C refund terminal, so
a partition degrades to "money back", never "money stuck in a live
non-terminal machine" and never "false finality".

**Why out of scope.** Nostr provides self-authenticating events but **no
membership, no consensus, no eclipse resistance** (`docs/THREAT_MODEL.md`
ADV-NET); a liveness theorem under ≤ 1/3 relay control would require
formalizing the timeout/refund DAG as a distributed-liveness object —
registered as PO-3's open formalization, and requiring a multi-relay
junction deployment model that is policy, not protocol.

**Covered empirically by.** Soak validation at 10k disputes/day
(`docs/THREAT_MODEL.md` §4-C residual; `docs/EVALUATION.md`); the
model-checking sweep's terminal-absorption coverage (every non-terminal
phase has an outgoing edge — `__fixtures__/model-check-summary.json`, 13
instances / 3 145 632 states, 0 raw throws) and its Quint re-model
(`proofs/mechanized/court.qnt`, mechanized round); the Path-C refund tests
in `courtConfirmationMachine.test.ts`.

## 3. LLM-juror advice quality — *orthogonal by construction*

**The gap.** The advisory LLM (ADV-LLM, hermes-juror trust boundary) can be
prompt-injected, compromised, down, or simply wrong. Nothing in DEF-1…4
constrains the *quality* of juror deliberation; the definitions constrain
what the cohort's **key** certifies about the **tally**, not how jurors
decided how to vote.

**Why out of scope.** The trust boundary is clean and architectural: the
LLM controls **no keys** and cannot override the mechanical policy — the
worst it can do is influence votes, which are then commit-revealed, tallied
by B3's function, confirmed by DEF-4's quorum, and signed by DEF-1's
threshold. "The key still signs" is the whole point: attestation security is
*invariant to* advice quality, so any advice-quality claim belongs to a
different evaluation (advice accuracy benchmarks), not to this proof layer.

**Covered empirically by.** ADV-LLM's threat-model row and the §4.7
evidence-prompt analysis (`docs/THREAT_MODEL.md`); the hermes-juror tests'
mechanical-policy overrides (the LLM advisory path is advisory-only in the
dispatcher). Accuracy-of-advice is an open empirical question tracked in the
paper's limitations, not a proof obligation here.

## 4. Implementation-level attacks below the model — *the audit program's domain*

**The gap.** THE-1…4 are proved about the *source-level* protocol: machine
guards, the validator, the FROST engine as pinned. Below that line sit the
usual implementation hazards: JS engine semantics beyond the assumed ECMAScript
guarantees (premise J1 of round 18), dependency-supply-chain compromise of
`@vbyte/frost` / `@noble/curves` (S5's fidelity is pinned, not verified from
source — GAP-5a), host compromise of a juror's share file (ADV-KEY), timing
side channels, the v1 validator's unbounded-input hashing-DoS surface
(PO-10), the `verifyEvent` memoization mutation trap (PO-11).

**Why out of scope.** Game-based definitions model the protocol, not the
process. Every premise marked "empirically probed / pinned by tests" (S3,
S5, H-JS1) is precisely the interface where this round hands off to the
audit program: the differential pins are *designed to fail loudly* when a
dependency upgrade breaks the assumed semantics, which is the right
engineering answer to an assumption you cannot prove.

**Covered empirically by.** `docs/CRYPTO_AUDIT.md` (literature-vs-implementation
audit, AUDIT-1…4 differential pins); `docs/CROSS_CHECK.md` (claim →
executable evidence, machine-checked); the security rounds r1–r3 (machine
fuzz, supply chain, properties fixup — `security/*` branches and their
finding registers); the restore/adversarial-machine suites
(`__tests__/adversarialMachines.test.ts`, restore-discipline pins) backing
H-JS1; the reproducibility contract (`scripts/reproduce.sh`,
`docs/REPRODUCIBILITY.md`).

## 5. Two precise residuals inside the model (stated because they are *in* scope)

These are not "below the model" — they are consequences of modeling choices
this round made and wants on the record:

1. **v1 signer-set invisibility** (DEF-1 Remark 1.2): a v1 attestation's
   signer set is protocol-level only; DEF-1's full parameterization (tuple
   including the signer set) is realized on the **v2 path**. The v1 path is
   frozen byte-compatibly (INV-VAL-16); consumers wanting in-band
   signer-set finality must consume v2. Artifact: T5 Remark 6.2; PV3/PV4
   tests.
2. **Coordinator-crash liveness** (DEF-4 Remark 4.1): the machines do not
   self-drive (ADR 0001); DEF-4 conditions on coordinator dispatch
   liveness, and the abort-escape (INV-CONF-14) bounds the damage to a
   terminal state. A fully coordinator-free liveness proof would need the
   timeout/refund DAG formalization of PO-3. Artifact: the mechanized
   round's Quint tick/deadline model (`proofs/mechanized/court.qnt`).

## 6. Gap register (round-20 additions)

| ID | Where | Content | Inherited from |
|---|---|---|---|
| GAP-5a | THE-1 | S5 dependency fidelity: probe/pin-verified, not verified from source | T5 §7 |
| GAP-5b | THE-1 | Conditional reduction — the honest ceiling for any result of this shape | T5 §7 |
| GAP-20a | THE-4 | L1 is an environment premise; partition liveness is **excluded by the definition** (PO-3) | PO-3, new formal framing |
| GAP-20b | DEF-1 | v1 tuple lacks the in-band signer-set component; full parameterization is v2-only | T5 Remark 6.2, new |
