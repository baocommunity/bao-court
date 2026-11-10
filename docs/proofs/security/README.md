# docs/proofs/security/ — The Security-Definition Layer (Round 20)

Round 20 of the symposium program, the **highest-theory round**: what does
"universal confirmation" **guarantee**, as a formal game-based security
definition — and does the shipped protocol **realize** the guarantee?

This layer sits **above** round 18's five proofs (`docs/proofs/01…05-*.tex.md`,
the T1–T5 layer): those prove properties of the *pieces* (encoding, Merkle,
tally, machines, threshold). Round 20 defines the *protocol-level* games and
proves the composed protocol realizes them, by reduction to the pieces. The
distinction is exactly 'proofs about the components' vs 'the protocol's
security is a theorem'.

---

## 1. Files

| File | Content |
|---|---|
| [`00-definitions.tex.md`](00-definitions.tex.md) | Execution model, attestation tuples, the tallied set, **DEF-1** (`ATTFORGE` — attestation unforgeability), **DEF-2** (`VERDICTCONS` — verdict consistency), **DEF-3** (`CHAINFORGE` — finality soundness), **DEF-4** (`CONFLIVE` — confirmation liveness), the full premise registry S1–S6 / B1–B3 / L1 |
| [`01-theorems.tex.md`](01-theorems.tex.md) | **THE-1…4**: Π realizes DEF-1…4 — game-hop / hybrid reductions to T1–T5 and the literature |
| [`02-limitations.tex.md`](02-limitations.tex.md) | The honesty register: majority collusion (PO-1/κ-bounded, economics round), partition liveness (PO-3), LLM advice quality, below-the-model implementation attacks, two in-model residuals, GAP-20a/b |

Each definition is written so an adversary simulator could be coded against
it verbatim: explicit oracles, explicit win condition, explicit environment
model where liveness requires one. Each proof step is elementary, cited
(T1–T5 / KG20 / RFC 9591 / the invariants), or registered as a lemma-gap.

## 2. Definition dependency graph

```
                 Premises (00-definitions §6)
                 S1–S6 (crypto + tally-path)   B1–B3 (T1/T4/T3)   L1 (delivery)
                        │                            │                │
                        ▼                            ▼                │
   ┌──────────────────────────────────────────────────────────┐        │
   │ DEF-1  ATTFORGE — no validating attestation for a        │        │
   │        never-tallied tuple (session, outcome, round,     │        │
   │        signer-set)                                       │        │
   └───────────────┬──────────────────────────────────────────┘        │
                   │ (a validating-but-untallied attestation           │
                   │  is THE-1's event; reuse as lemma)                │
        ┌──────────┴────────────────┬──────────────────┐              │
        ▼                           ▼                  │              │
   ┌─────────────────┐   ┌──────────────────────────┐ │              │
   │ DEF-2           │   │ DEF-3                    │ │              │
   │ VERDICTCONS —   │   │ CHAINFORGE — a final     │ │              │
   │ outcome =       │   │ verdict's every round is │ │              │
   │ Plurality(cited │   │ properly signed at its   │ │              │
   │ certified set)  │   │ recorded threshold; no   │ │              │
   │                 │   │ downgrade replay / splice│ │              │
   └─────────────────┘   └──────────────────────────┘ │              │
                                                      ▼              ▼
                          ┌─────────────────────────────────────────────┐
                          │ DEF-4  CONFLIVE — quorum-met ⇒ final within │
                          │ the deadline bound; quorum-miss ⇒ Path-C    │
                          │ refund (conditional on L1, stated in-def)   │
                          └─────────────────────────────────────────────┘
```

DEF-2 and DEF-3 both *reuse* THE-1's machinery (they reduce their
non-cryptographic content to machine invariants, and their cryptographic
content to THE-1); DEF-4 is orthogonal (liveness vs integrity) and holds
conditionally on the delivery model **stated inside the definition**.

## 3. The reduction map — which primitive assumption buys which definition

| Realizes | Via | Ultimately rests on |
|---|---|---|
| **DEF-1** | THE-1: G0→G1 machine discipline (B2, unconditional) → G1→G2 message⇒tuple (B1, unconditional) → G2→G3 FROST extraction (T5 §5 invoked as lemma) | **S1** Schnorr EUF-CMA + **S2** FROST soundness (KG20) under **S3** nonce rules + **S4** DKG sharing, engine fidelity **S5**; tally-path discipline **S6** |
| **DEF-2** | THE-2: Claim A = validator's `hashDisputeVerdict` recomputation (unconditional) ∧ Claim B = machine tally path (B2/B3/S6) | B1 + **B3** (T3) + B2; crypto core inherits DEF-1's (S1/S2) |
| **DEF-3** | THE-3: (a) downgrade refusal + (c) splice pins **unconditional** (dispatcher + INV-VAL-10..13); (b) threshold substitution via T5's v2 corollary | B1 + B2 for structure; S1/S2 via THE-1 for the per-round threshold fact |
| **DEF-4** | THE-4: deadline arithmetic over reachable states + T5(i) completeness | **L1** (delivery/monotonicity/dispatch — in the definition), B2, T5(i)+S5; integrity untouched by L1 |

One-line version: **B1/B2/B3 (unconditional, structural) + S1–S5
(computational) ⇒ DEF-1/2/3 (integrity, unconditional environment); L1
(environment) + T5(i) ⇒ DEF-4 (liveness, conditional environment).**

## 4. Companion rounds (cross-references)

- **Mechanized round** (`proofs/mechanized/court.qnt`): an independent Quint
  re-model of the vote + confirmation machines — machine-checks the B2
  subset THE-1/THE-4 lean on (quorum gate INV-CONF-15, tick deadline table
  INV-CONF-13, terminal absorption). The pen-and-paper proofs here remain
  the authority for the full invariant bundle; the spec cross-checks its
  state-machine subset.
- **Economics round** (`proofs/economics/`): supplies the PO-1/κ-bounded
  majority-collusion analysis that 02-limitations §1 explicitly scopes out
  of the cryptographic layer.
- **Round 18** (`docs/proofs/01…05`): the primitive layer T1–T5; every
  non-elementary proof step here cites it by theorem number and section.
- **Threat model** (`docs/THREAT_MODEL.md`): the adversary tuples (§2.1)
  and proof obligations (§6, PO-1/2/3…) that round 20 formalizes as games;
  PO-3 and PO-10/11 remain open exactly as registered there.

## 5. Reviewer's checking path (≈ 90 minutes)

| Time | Action |
|---|---|
| 0–20' | **Attack the definitions** (`00-definitions`): for each DEF, read the experiment and try to code the simulator — check the oracles are real (Remark 1.1: no stronger signing oracle than the coordinator can honestly provoke), the win condition is decidable from the transcript (tallied set §0.3 is observer-recomputable), and the environment model L1 is inside DEF-4, not in a footnote. Try to break Remark 1.2's v1/v2 parameterization. |
| 20–45' | **THE-1** (`01-theorems`): walk the four hops; for each, confirm the loss claim: G0→G1 loss 0 rests on B2/T4 + H-JS1 (read `docs/proofs/04-machine-safety.tex.md` §4 lemmas + §8 gap); G1→G2 rests on B1/T1 (read `01-encoding.tex.md` §5c); G2→G3 is T5 §5's three-case analysis invoked as a lemma — verify the invocation is faithful (read `05-threshold-soundness.tex.md` §5). |
| 45–65' | **THE-2/THE-3**: check Claim A against `validator.ts:170–209 / 510–548` (recomputation from the event's own tags, fail-closed); check THE-3(a) against the dispatcher `validator.ts:815–840` and `V2_ONLY_POLICY_FIELDS` (`770–778`, refusal `830–840`); check THE-3(b) against the v2 corollary of T5. |
| 65–80' | **THE-4**: verify the deadline arithmetic against INV-CONF-6/11/12/13/14/15/19/32/33 (`docs/FORMAL_INVARIANTS.md` §5) and confirm Remark 4.1's case split matches the code (fail-closed quorum gate; tick expiry; abort escape). |
| 80–90' | **Honesty sweep** (`02-limitations`): confirm each entry names its owner artifact, and that GAP-20a/b plus the two in-model residuals are consistent with the theorems' own remarks. |

What to demand if skeptical: every proof step cites a premise ID (§6 of
`00-definitions`) or a `file:lines` range — open it. Every premise fall
invalidates exactly the theorems listing it. Anything not closed is in
`02-limitations` §6 — nothing is hidden in a remark.
