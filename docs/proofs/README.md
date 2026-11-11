# docs/proofs/ — The Proofs Index

Round 18 of the symposium program: complete, line-checked mathematical proofs
of the six core properties of the BAO Court protocol. Every proof cites the
actual guards (`file:lines`), states its premises explicitly, and maps to
executable evidence (tests / model checking / differential parity). A proof
step that could not be made rigorous is recorded as an explicit LEMMA-GAP in
the file and in §4 below — none are papered over.

These proofs *formalize* what `docs/FORMAL_INVARIANTS.md` states and what
`docs/CROSS_CHECK.md` maps to executable evidence; they generalize the finite
model checking to all roster sizes (Theorem 4, §7 there).

---

## 1. The theorems

| # | File | Theorem | One-line content |
|---|---|---|---|
| 1 | [`01-encoding.tex.md`](01-encoding.tex.md) | **Encoding injectivity & per-schema prefix-freeness** | The `CanonicalWriter` grammar's encoding has a left inverse (unique parse); distinct tuples under a fixed schema encode to distinct, never prefix-related byte strings; concatenation parses unambiguously with byte-exact split. |
| 2 | [`02-merkle-soundness.tex.md`](02-merkle-soundness.tex.md) | **Merkle soundness** | `verifyCaseInBatch` accepts ⟺ the recomputed leaf is in the committed set — completeness unconditional; soundness conditional on SHA-256 collision resistance + Schnorr EUF-CMA (stated). Domain separation (BatchLeaf/BatchNode prefixes + 0x00/0x01 tags) blocks the second-preimage leaf/node confusion. |
| 3 | [`03-tally.tex.md`](03-tally.tex.md) | **Tally well-definedness** | The verdict is a function of the reveal MULTISET: counting is a commutative monoid; the winner is the unique (max-count, min-UTF-8-tie-break) extremum; `compareOutcomeUtf8` is proven a strict total order (full lexicographic transitivity case analysis). |
| 4 | [`04-machine-safety.tex.md`](04-machine-safety.tex.md) | **Machine safety** (crown) | For each phase machine (vote, confirmation, signing, DKG), EVERY reachable state satisfies the INV-* invariant bundle — structural induction on event sequences: creation guards (base), preamble/append/barrier lemmas (step, per-handler walk with line references). Generalizes the model checking (n ≤ 4 exhaustive) to all n; the relationship is stated honestly. |
| 5 | [`05-threshold-soundness.tex.md`](05-threshold-soundness.tex.md) | **Attestation soundness** | A valid kind-89/39007 attestation under the pinned group key implies ≥ t partial signatures from DISTINCT certified roster shares — pipeline direction unconditional; verification direction conditional on Schnorr unforgeability + FROST (KG20/RFC 9591) soundness under the nonce rules; v2 makes the signer set verifiable in-band, v1 does not (stated). |
| 7 | [`07-mechanised-escalation.tex.md`](07-mechanised-escalation.tex.md) | **The escalation layer, mechanised** | Lean 4: the sign-based ladder bound `E[π](d) < 0 ↔ d < flipRound` (r33-6/r40-4) with monotonicity in `a_f` and `β` and `derivedCap = 0 ⇒ no safe depth`; per-round bond consumption (INV-ESC-9), one-hash-one-index (r38-1), the consecutive-round ledger (INV-ESC-8) and the entry-matrix barriers (r40-1/r40-2). Quint: the v0.14.0 transport's three refusals (r8-2) as `invBinding`. Includes the code↔model correspondence table and the explicit NOT-mechanised list (the logarithm, floating point, the wire codec's canonicalisation, host authentication). |
| 6 | [`attribution.tex.md`](attribution.tex.md) | **Attribution** | A published signing-session journal (nonce commitments + partials + signer set + threshold + aggregate) decomposes the aggregate to the contributing shares: each partial satisfies `s_i·G = R_i + c·λ_i·(π·Y_i)`, the partials reconstruct `s = Σ s_i + c·π·τ` byte-exactly, and a failing partial is attributable to its index. The signer set is fixed by `R` (Lemma 6.4); the per-partial x-only sign ambiguity leaves every index unchanged. Identity is conditional on the certified-share pin (P1) + authenticated append-only entries (P2); the bare aggregate is proven unlinkable (Lemma 6.0), which is why the record must exist. Includes the batch-signing duty (D-BATCH). |

Theorem 7 is the escalation layer's mechanisation: it depends on T1 (the wire's
encoding injectivity is *assumed*, not re-proved — the codec's canonicalisation
stays TS-suite-checked) and on T4's confirmation machine (the ledger is that
machine's state). It adds no new cryptographic premise: hashes are abstract.

## 2. Dependency graph

```
Premises (§3 below)
│
├── T1 Encoding injectivity ──────────────┐
│                                         │
│   ┌─────────────────────────────────────┤
│   │                                     │
│   ▼                                     ▼
├── T2 Merkle soundness                T3 Tally well-definedness
│   (uses T1 for leaf/encoding             (uses T1 for verdict-hash
│    determinism + H1, H2)                 determinism; E1 total order)
│                                         │
│   ┌─────────────────────────────────────┤
│   ▼                                     ▼
├── T4 Machine safety ◄───────────────────┘
│   (uses T1 for hash bindings, T3 for
│    verdict determinism; premises H-JS1/2)
│                                         │
└── T5 Attestation soundness ◄────────────┘
    (uses T4's signer-set guards (INV-SIGN-*),
     T1 for the SignerSet commitment injectivity,
     T3's domain for the 39007 tally binding;
     premises S1–S5)
        │
        ▼
    T6 Attribution ◄── H3 (hash collision resistance), P1 (certified shares), P2 (authenticated log)
    (uses T5 for the aggregate it explains,
     T1 for the journal hash determinism;
     adds the forensic direction: WHO signed)
        │
        ▼
    D-BATCH duty (docs/ATTRIBUTABLE_SIGNING.md §4)
```

Reading order for a reviewer: 01 → 02 → 03 → 04 → 05 → attribution. T2 and T3
are independent of each other; T4 needs T1+T3; T5 needs T4 (machine guards) and
T1; T6 needs T5 (the aggregate) and T1 (the canonical journal hash).

## 3. Premises registry — everything assumed, nothing hidden

### 3.1 Runtime premises (specification-guaranteed)

| ID | Premise | Source of truth | Used by |
|---|---|---|---|
| **J1** | ECMAScript/WHATWG semantics: big-endian `DataView`, deterministic `TextEncoder` UTF-8, safe-integer predicates, `Object.freeze` + strict-mode throw, `Map` insertion order, spread = fresh copy, correct `Array.sort`. | ECMAScript spec; WHATWG Encoding/Infra. | T1, T2, T3, T4 |

### 3.2 Protocol-domain premises (enforced at call sites)

| ID | Premise | Enforcement | Used by |
|---|---|---|---|
| **E1** | `text` arguments are canonical UTF-8 (`UTF8⁻¹∘UTF8 = id`) | INV-CORE-5 (`courtCeremonyCore.ts:64–70`); creation guards (vote 487–509, session `assertCanonicalText` 185–204, signing 395–402) | T1, T2, T3, T5 |
| **E2** | `hex` arguments are canonical lowercase hex | `HEX_32 = /^[0-9a-f]{64}$/` (`courtCeremonyCore.ts:22`) + compressed-key/signature guards | T1, T2, T5 |

### 3.3 Cryptographic premises (computational assumptions)

| ID | Premise | Status | Used by |
|---|---|---|---|
| **H1** | SHA-256 collision resistance (no feasible distinct x ≠ x′ with equal digests) | Standard; stated in T2 §3 | T2 (⟹ direction), T2 Cor 5.1 |
| **H2** | BIP-340 Schnorr EUF-CMA under a pinned key | Standard; stated in T2 §3 | T2 (manifest endorsement) |
| **S1** | BIP-340 Schnorr unforgeability (T5's form) | Standard | T5 (ii) |
| **S2** | FROST soundness (KG20 eprint 2020/852; RFC 9591), under its preconditions | Literature theorem, applied | T5 (ii) |
| **S3** | Nonce rules: aux-randomness-mixed HKDF derivation (RFC 9591 §4.1/§7.3), one-consumption NonceGuard, per-attempt equivocation aborts, message bound pre-commitment | Enforced in code (`signing.ts:88–194, 266–271`; INV-SIGN-1/4/8) + CRYPTO_AUDIT §1.1/§1.4 | T5 (ii) preconditions |
| **S4** | DKG: group secret Shamir-shared t-of-n, never materializes; unanimous single-transcript certification (INV-DKG-6) | Machine guards + `dkg.ts`/`independentDkg.ts` | T5 (ii), "certified" |
| **S5** | `@vbyte/frost` 1.1.5 implements the S2 semantics | Empirical probes + AUDIT-4 differential pins (**GAP-5a**) | T5 (i), (ii) |
| **H3** | SHA-256 / tagged-hash collision resistance, in the journal's binding-factor prefix (`H1`/`H5`) | Same family as H1; stated in T6 §3 — used only to make the signer set unique for a given `R` (Lemma 6.4) | T6 (ii) |

### 3.4 Host/environment premises (stated honestly)

| ID | Premise | Mitigation | Used by |
|---|---|---|---|
| **H-JS1** | Machine states are only produced by `create`/`reduce` (TS cannot enforce) | freeze discipline (INV-X-4) + state-shape barriers (FC-4) + session-hash re-derivation (INV-SIGN-2) + ledger barriers + adversarial restore tests (**GAP-4a**) | T4 |
| **H-JS2** | `reduce` executes atomically (pure, synchronous, no awaits) | inspection + P5 determinism checks | T4 |
| **P1** | verification shares `Y_i` in a journal are the **certified** DKG shares | caller supplies `DkgRecord.verificationShares`; `identityPinned` is reported (Theorem 6 Lemma 6.3) | T6 (iii) |
| **P2** | journal entries are authenticated per signer and append-only | ceremony events are NIP-01-signed by each juror; log design `docs/ATTRIBUTABLE_SIGNING.md` §3.4; per-participant entries are v0.11 | T6 (iii) |

## 4. Lemma-gap register (complete list)

| ID | Where | Content |
|---|---|---|
| **GAP-4a** | T4 §8 | Environment premise H-JS1: producer discipline for machine states is assumed, not type-enforceable; four layers of mitigation (state-shape barriers, freeze+strict-mode throw, value-locking barriers that re-prove ledger invariants from contents, adversarial restore tests). Residual risk is availability (typed throw), never verdict/signature integrity. |
| **GAP-4b** | T4 §8 | The allowlist membership proof goes through the FC-4 string-vs-array barrier; recorded because the substring hazard is the classic version of this bug. Covered by the barrier; noted for precision. |
| **GAP-5a** | T5 §7 | Dependency fidelity S5: `@vbyte/frost`'s RFC-9591 semantics are probe- and differential-pinned, not formally verified from source; an upgrade must re-establish the pins (they are designed to fail loudly). |
| **GAP-5b** | T5 §7 | Part (ii) is a conditional reduction ("unless S1/S2/S4 fall"), not an unconditional theorem — the honest ceiling for any result of this shape. |
| **GAP-6a** | T6 §9 | Attribution identity rests on the certified-share pin (P1) and authenticated append-only entries (P2) — both deployment obligations, tested negatively but not enforced by cryptography alone. A journal without the pin proves consistency only. |
| **GAP-6b** | T6 §8/§9 | The batch-signing duty (D-BATCH) is normative but not mechanically enforced: the batch manifest is not inside the signed FROST message, so `aggregateAttestation` cannot see a root. Journaled duty records are the current evidence; the signing-schema binding is v0.11. |

Theorem 1 and Theorem 3 are complete with no gaps beyond their stated
premises; Theorem 2's completeness direction is unconditional and its
soundness direction carries H1/H2 by explicit statement (not a gap — a
stated conditional, as cryptological soundness theorems always are).

## 5. Proof ↔ executable-evidence map

| Theorem | Executable witness |
|---|---|
| T1 | **PR #52** differential parity: independent writer+parser (`__tests__/reference/refCanonical.ts`), byte-identity (300 sequences), round-trip (200), prefix-freeness of concatenation (200 pairs, byte-exact), injectivity (250 vectors incl. aliasing traps), fail-closed parity. Always-on pins: `invariantAssertions.test.ts` (INV-X-8), `courtSession.test.ts` › 'length prefixes…'. |
| T2 | `batchAttestation.test.ts` (every-index proofs n=1..8, 63/64/65; tamper rejections), `propertiesBatch.test.ts` PB1/PB3/PB5/PB6 (oracle n=1..300; rejection by recomputation; totality), **PR #52** differential Merkle (n=1..128, 8256 proofs, independent builder+verifier, node:crypto vs @noble). |
| T3 | **PR #52** refTally: exhaustive 3ⁿ ballot assignments n=1..4 (120 machines) + 10×300-juror random tallies + UTF-16-divergence pin; `adversarialMachines.test.ts` › reorder → identical verdict (INV-VOTE-20); `invariantAssertions.test.ts` comparator oracle (INV-X-9, 500 pairs). |
| T4 | Model checking: `__tests__/modelChecking.test.ts` (reduced sweep in CI) + `scripts/model-check.mjs` full sweep — committed numbers in `__fixtures__/model-check-summary.json` (witness-aware, at `608e6dc`): 15 instances, 3 869 232 states, 213 521 172 applications, 60 020 684 illegal-witness probes with 0 accepted, **0 raw throws**; `invariantAssertions.test.ts` (27 always-on cross-machine assertions); `adversarialMachines.test.ts` (tamper/restore discipline). |
| T5 | `signing.test.ts` + `courtSigningMachine.test.ts` (end-to-end attempt; equivocation aborts with blame; threshold-over-distinct-signers), `validator.test.ts` + `propertiesValidator.test.ts` PV1–PV6 (tamper matrix; PV3 signer-set pins; PV4 downgrade refusal), `cryptoLiteratureAudit.test.ts` AUDIT-3/4, `independentDkg.test.ts` / `independentSigning.test.ts`. |
| T6 | `attribution.test.ts`: honest journal reconstructs the aggregate and attributes both signers; forged partial attributed by index; missing partial ⇒ no reconstruction; tampered aggregate rejected; wrong signer set rejected; certified-share pin enforced (`SHARE_MISMATCH`); wrong group key rejected; malformed record fails closed; `hashSigningJournal` determinism. |

## 6. Reviewer's checking guide (one hour total)

| Time | Action |
|---|---|
| 0–15' | **T1**: read `courtSession.ts:458–537` against T1 §2; check the fixed/variable-width induction (T1 §5c) and the honest scoping remark 6.3 (cross-schema prefix counterexample). Run `npx vitest run __tests__/differentialParity.test.ts`. |
| 15–30' | **T2**: read `batchAttestation.ts:128–230` against Lemmas 2.1–2.3; check the fold/graft induction (§4.2) and the collision argument (the Claim); verify leaf/node input-distinctness (domains + tags). |
| 30–45' | **T3**: read `courtVoteMachine.ts:178–187, 811–834`; check the transitivity case analysis (Lemma 3.1) and the fold-invariant argument (§4 Step 2). Spot-check the UTF-16 divergence test. |
| 45–60' | **T4/T5**: read T4's three lemmas (§4) and spot-check five handler rows of §6 against the cited lines (suggest: one per machine); read T5's three-case analysis (§5) and confirm each case maps to one premise. Then run the full suite: `npm test` (includes the reduced model-checking sweep and the 27 always-on invariant assertions), plus `npx tsx scripts/model-check.mjs --fast` if you want the mechanical re-verification locally. |

What to demand if you are skeptical of a step: every proof line cites a
`file:lines` range — open it. Every premise is in §3 above — nothing is
assumed silently. Anything that could not be closed is in §4, not hidden in
a remark.
