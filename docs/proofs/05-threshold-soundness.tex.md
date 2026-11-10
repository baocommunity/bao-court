# Theorem 5 — Attestation soundness (FROST threshold semantics)

**Modules:** `signing.ts` (FROST engine), `courtSigningMachine.ts` (signer-set
guards), `validator.ts` (kind-89/39007 verification gate, v1 + v2),
`independentSigning.ts` (session-level mirror of the guards), `courtDkgMachine.ts`
(roster certification).
**Status:** proof complete, with the dependency-level premises **S1–S5**
stated explicitly (§3) — this theorem is *necessarily conditional*: its
cryptographic core is the FROST soundness theorem (Komlo–Goldberg 2020 /
RFC 9591) applied to the implementation, and the implementation's fidelity to
that semantics is a premise about a third-party dependency (empirically
probed, pinned by tests — see S2 and GAP-5a).

---

## 1. Statement

Fix an empaneled FROST cohort: roster [1..n], threshold t (1 ≤ t ≤ n),
certified group public key Q (a BIP-340 x-only key), per-index verification
shares committed by a completed DKG ceremony. Let E be a Nostr event of
kind 89 or 39007 (`eventsCommon.ts:41`: `BAO_COURT_ATTESTATION_KIND = 39007`).

> **Theorem 5 (Attestation soundness).**
> **(i) Pipeline soundness (unconditional modulo S2).** Every kind-89/39007
> attestation produced end-to-end by the shipped pipeline —
> `courtSigningMachine` (signer-set discipline) + `signing.ts`
> (`createRevealAndPartialSig` → `aggregateAttestation`) — is the BIP-340
> aggregate of partial signatures from **exactly the distinct-index reveal
> set S**, with |S| ≥ t, every index in S a roster member whose partial
> passed `verify_partial_sig` against the finalized commitment set, and the
> final aggregate passing `verify_final_sig` under Q.
>
> **(ii) Verification soundness (conditional on S1–S4).** Suppose
> `validateAttestationEvent(E, ctx)` (v1) or `validateAttestationEventV2(E, ctx)`
> returns `{valid: true}` with `ctx.expectedGroupPubkey = Q` pinned to the
> empaneled key. Then, **unless an adversary breaks Schnorr unforgeability
> (S1), the FROST soundness assumption (S2) under the nonce rules (S3), or
> the DKG secret-sharing premise (S4)**, the aggregate signature σ carried by
> E implies the existence of ≥ t partial signatures from **distinct,
> certified roster share indices** that were aggregated over the reconstructed
> attestation message.
>
> **Corollary (v2, checkable signer set).** For v2 attestations the
> signer-set claim is verifiable *from the event*: the `signers` tag commits
> to the sorted distinct index set under `SignerSet/v1`
> (`hashSignerSetRoot`, `validator.ts:353–378`), is bound into the signed
> message (`buildAttestationMessageV2`), and a supplied full signer set must
> hash to the tag AND have size exactly = threshold
> (INV-VAL-11/12, `validator.ts:619–632`). For v1 the ≥t-distinct-signers
> fact holds at the protocol level (part ii) but is **not** verifiable from
> the event alone — the v1 message carries no signer-set commitment (§6,
> Remark 6.2; this is the honest v1/v2 asymmetry).

## 2. Code map (what each layer enforces)

| Layer | File:lines | Guarantees used below |
|---|---|---|
| Signing session binding | `courtSigningMachine.ts:230–254` (`hashCourtSigningSession`) | the signature context binds (sessionHash, verdictHash, outcome, roster, threshold, attempt) — INV-SIGN-1; re-derived at every reduce (269–360, INV-SIGN-2). |
| One commitment / one partial per signer | `courtSigningMachine.ts:584–598` (commitment equivocation → `aborted_peer`), `650–662` (partial equivocation → `aborted_peer`) | INV-SIGN-4/8; equivocation cannot be used to re-open a closed set. |
| Nonce points are curve points | `courtSigningMachine.ts:581–583`; `crypto.ts:297–305` (`isValidSecp256k1Point`) | malformed nonces cannot poison binding factors (INV-SIGN-5). |
| Threshold-set finalization | `courtSigningMachine.ts:610–625` (`close_commitments`: ≥ t distinct commitments; `finalizedSignerSet` = sorted distinct indices) | INV-SIGN-6/7, A-1 contract. |
| Aggregate threshold | `courtSigningMachine.ts:680–697` (`partials.length ≥ threshold`, distinct-index by INV-SIGN-8) | INV-SIGN-10: the threshold is over SIGNERS, not signatures. |
| Nonce discipline | `signing.ts:88–194` (`NonceGuard`, `InMemoryNonceGuard`, shared default guard); consumption **before** `sign_msg` (`signing.ts:266–271`) | one commitment package consumes at most one partial (RFC 9591 §7.3-style hedge; CRYPTO_AUDIT §1.1/§1.4). |
| Partial creation & self-check | `signing.ts:242–299` (message built from the SAME `buildAttestationMessage` the validator reconstructs; `verify_partial_sig` before returning, 275–283) | the signer's own partial verifies before publication. |
| Aggregation & final check | `signing.ts:314–395` (`aggregateAttestation`: threshold 339–343; duplicate-reveal rejection 345–350; **per-partial verification against the ctx commitment set** 352–365; `combine_partial_sigs` 367–370; `verify_final_sig` under the group key 374–381; commitment-set = reveal-set contract, 319–324 + AUDIT §1.3 probe) | fail-closed aggregation. |
| Session-level mirror | `independentSigning.ts` (`addCommitment` equivocation rejection 245–; `addReveal` requires nonces matching the stored commitment; `canAggregate` requires reveal set = commitment set 452–; `aggregate` throws otherwise 466–) | the same guards without the state machine. |
| Validator (v1) | `validator.ts:106–290` (kind gate 124–126; Nostr envelope 128–130; unique-tag 138–163; nonce = signature[0:64] 157–163; kind-39007 verdict binding 170–209; pins 211–227; message reconstruction 264–273; **Schnorr verify under the `p` tag key** 275–282) | INV-VAL-1..9. |
| Validator (v2) | `validator.ts:385–689` (finality tags + bounds 554–578; pins incl. `minThreshold` 610–612; signer-set commitment + size=threshold 619–632; message reconstruction incl. finality block 670–685; Schnorr verify 686–689) | INV-VAL-10..13. |
| Roster certification | `courtDkgMachine.ts:371–398` (`accept_certification`: different transcript → blame-abort; `certified` + `certifiedGroupPubkey` only under unanimous single-transcript certification) | INV-DKG-5/6: the group key is exposed only after every roster member certified the same transcript. |

## 3. Premises

| # | Premise | Content | Evidence / source |
|---|---|---|---|
| **S1** | **BIP-340 Schnorr unforgeability.** Given Q and (adaptive) oracle access to honest signing computations, no efficient adversary outputs (msg, σ) with `schnorr.verify(σ, msg, Q) = true` for a fresh msg, except with negligible probability. | Standard EUF-CMA for Schnorr; @noble/curves 2.4.0 is the verification engine (validator sites above). |
| **S2** | **FROST soundness (KG20 / RFC 9591).** The FROST signing protocol — binding factors H₁(prefix ‖ idx) over (group key, message hash, commitment list), Lagrange-weighted partials, deterministic combination into a BIP-340 signature — is *sound*: a valid group signature under Q for a message m implies, except with negligible probability under the assumed hardness (OMDL/AOMDL per the 2025–2026 literature; KG20's original proof under its stated assumptions), that a signing execution for m aggregated ≥ t distinct participants' partials. | Komlo–Goldberg, eprint 2020/852 (§ soundness; §2.5 anti-Drijvers binding factors); RFC 9591 §4.3/§5.2. The assumption used is exactly the one KG20's Theorem establishes. |
| **S3** | **Nonce rules.** (a) Signing nonces are derived with auxiliary randomness mixed in — `generate_nonce(secret, aux) = H3(aux ‖ secret)` per RFC 9591 §4.1/§7.3 (a purely share-deterministic nonce admits a key-recovery attack under challenge manipulation); (b) each nonce commitment is consumed at most once (`NonceGuard`, consumption before signing); (c) one commitment / one partial per signer per attempt, conflicts abort with blame (INV-SIGN-4/8); (d) the message is bound into the signing-session hash **before** any commitment is accepted (INV-SIGN-1) and cross-session contexts are disjoint (Drijvers/Wagner fence, CRYPTO_AUDIT §1.1). | CRYPTO_AUDIT.md §1.1 (binding factors pinned by AUDIT-4 in `cryptoLiteratureAudit.test.ts`), §1.2 (round ordering), §1.4 (HKDF derivation + caveat). |
| **S4** | **DKG secret sharing.** The certified group key Q arises from a completed DKG: the group secret is Shamir-shared t-of-n (Pedersen VSS verification), never materializes at any single party, and the roster certified a single transcript unanimously (INV-DKG-6) — so share index i's verification key is bound to Q, and reconstructing the group secret requires ≥ t distinct certified shares. | `dkg.ts` / `independentDkg.ts` (PedPOP adapter); the machine-side certification guards cited in §2. |
| **S5** | **Dependency fidelity.** `@vbyte/frost` 1.1.5 implements the S2 semantics: `get_group_signing_ctx` computes RFC-9591 binding factors over (group key, H4(msg), H5(commitment list)); `verify_partial_sig` accepts (idx, psig) iff psig is the valid FROST partial of share idx for that ctx; `combine_partial_sigs` emits the BIP-340 aggregate (R ‖ s); `verify_final_sig` is BIP-340 verification under the group key. | Empirical probe of 1.1.5 (CRYPTO_AUDIT §1.3 — over-large commitment sets fail the final check, fail-closed); AUDIT-4 differential pins; the library's own RFC-9591-conformant structure (§1.1 code citation). Stated as a premise because the dependency's source is not formally verified here — GAP-5a. |

## 4. Proof of part (i) — pipeline soundness

Walk the shipped pipeline and collect the facts:

1. **Signer set.** `close_commitments` fires only with ≥ t *distinct* signer
   commitments (distinct by INV-SIGN-4's one-per-signer ledger +
   `assertSigningRecordInvariants`'s duplicate re-check,
   `courtSigningMachine.ts:318–322`) and freezes `finalizedSignerSet` = the
   sorted distinct commitment indices (line 623). Partials are accepted only
   from `finalizedSignerSet` members (636–640) and are one-per-signer
   (650–671). Hence at `aggregate` time, `state.partials` is a set of
   distinct indices, each in the commitment set, with
   `|partials| ≥ t` (688–692).
2. **Partials are individually verified.** `createRevealAndPartialSig` runs
   `verify_partial_sig(ctx, commit, sig.pubkey, sig.psig)` before returning
   (`signing.ts:275–283`) — and on the aggregation path, EVERY incoming
   reveal is re-verified against the ctx computed from the commitment set
   (`signing.ts:352–365`), with duplicates rejected (345–350). By S5,
   a passing `verify_partial_sig(idx, …)` means the partial is the correct
   FROST partial of share idx over (message, commitment list) — i.e. it is
   the partial of a genuine share of Q's secret (S2/S4: verification shares
   derive from the DKG).
3. **The aggregate is verified.** `aggregateAttestation` fails closed unless
   `verify_final_sig(ctx, message, signature)` passes under the group key
   (374–381); the commitment set equals the reveal set (contract 319–324 +
   the AUDIT §1.3 probe: any mismatch makes the final check fail).
4. **The message is the validator's message.** The signed message is
   `buildAttestationMessage(marketId, outcome, round, disputeEventId?,
   verdictHash?)` (`signing.ts:247–253, 325–331`) — the exact function the
   validator reconstructs and compares tag-by-tag before verifying
   (`validator.ts:264–273` v1; `670–685` v2). So a published attestation's
   signature verifies under Q over precisely the message the validator
   rebuilds from the event's own tags/content.

Combining: the pipeline's published σ is the FROST aggregate of ≥ t
distinct-index, individually verified partials over the canonical message,
and it verifies under Q. (This is FROST *completeness* — unconditional,
given S5's implementation fidelity — plus the machine's structural guards.)
∎ (i)

## 5. Proof of part (ii) — verification soundness

Assume `validateAttestationEvent(V2)(E, ctx)` returns valid with
`expectedGroupPubkey = Q`. Unpack what acceptance establishes (line-checked
above):

- (V1) kind ∈ {89, 39007}; the Nostr envelope verifies (id recomputation +
  event signature) — INV-VAL-1/2.
- (V2) `p = pubkey = event.pubkey` is the unique `p` tag = Q (pin enforced,
  211–217 v1 / 592–594 v2; a present-but-empty pin fails closed — F-2).
- (V3) `nonce = signature[0:64]` (INV-VAL-4) — the tag is consistent with the
  signature's group commitment R.
- (V4) for kind 39007: the `verdict` tag equals `hashDisputeVerdict`
  recomputed from the event's own dispute/outcome/supporting ids
  (170–209 v1 / 510–548 v2) — the signature certifies the TALLY, by
  Theorem 1 (the commitment's encoding is injective, E1/E2) and SHA-256
  determinism.
- (V5) the content's `message` equals the reconstructed canonical attestation
  message binding ALL presented fields (INV-VAL-6/7; v2 adds the finality
  block incl. `threshold` and `signerSetRoot`).
- (V6) `schnorr.verify(σ, msg, Q) = true` (275–282 v1 / 686–689 v2).

Now the threshold claim. Suppose, for contradiction, that σ was NOT produced
by an aggregation of ≥ t distinct certified roster partials over msg. There
are exactly three ways a valid (msg, σ) under Q can exist:

1. **A direct forgery of the Schnorr signature under Q** — excluded by S1
   (relative to the signing-oracle access model; the adversary may run
   honest rounds, which is precisely the FROST setting S2 analyzes).
2. **A FROST-level forgery**: an aggregation whose qualifying set did NOT
   include ≥ t distinct certified shares (e.g. fewer shares, uncertified
   shares, share substitution, or ROS/Drijvers-style manipulation across
   sessions). Excluded by S2 (FROST soundness) *applied under its
   preconditions* — which are exactly what S3 + the machine guards enforce:
   binding factors over (group key, message, commitment list) defeat
   concurrent-session attacks (S3d, AUDIT §1.1); nonces are
   aux-randomness-mixed and single-use (S3a/b — the KG20 soundness proof's
   nonce assumption); the commitment set is frozen before partials and the
   message before commitments (S3c/d + INV-SIGN-6/7; the dangerous direction
   — commitments chosen after partials — is structurally unreachable, AUDIT
   §1.2).
3. **The adversary knows the group secret key of Q** — excluded by S4: the
   secret is Shamir-shared t-of-n and never materializes; "knowing" it
   requires ≥ t distinct certified shares, which is the claimed conclusion
   (i.e., this case collapses into the conclusion rather than contradicting
   it).

In cases 1–2 the contradiction is with S1/S2(+S3); case 3 yields the
conclusion directly. Hence ≥ t distinct certified roster shares contributed
partials to the production of σ over msg. ∎ (ii)

**v2 corollary proof.** For a v2 event, acceptance additionally re-derives
`threshold` from the tags (bounded, ≥ 1; 554–578), requires the `signers`
tag to be 32-byte hex (562–564), and — when the verifier supplies the full
signer set — requires `hashSignerSetRoot(set) = signersTag` **and**
`|set| = threshold` (619–632). Since `signerSetRoot` is bound into the
SIGNED message (V5, `buildAttestationMessageV2`), the threshold-and-set
claim is covered by the group's own signature: the cohort attested to WHICH
distinct index set (of the claimed size = threshold) produced σ, and
`hashSignerSetRoot` is injective on sorted distinct positive index sets
(same length-prefixing argument as Theorem 1(b), E2-analog for the u32
indices: fixed-width big-endian, Lemma 4.2 of Theorem 1). The event-level
check and the protocol-level fact (part ii) coincide: |set| = t, distinct by
`hashSignerSetRoot`'s duplicate guard (353–366). ∎

∎ Theorem 5.

## 6. Remarks (scope, stated precisely)

**6.1 (The validator proves "some key signed", the pin proves "THE key
signed".)** A valid Schnorr verification alone never identifies the signer:
without `expectedGroupPubkey`, any key can sign self-chosen tags and the
event validates (documented, `validator.ts:443–454`; SEQUENCE-3 in
`__tests__/adversarialCrossModule.test.ts`). Theorem 5 is therefore
conditional on the caller pinning the empaneled key — the same caller duty
as Theorem 2's ctx pin. Consumers deriving settlement/reputation MUST pin.

**6.2 (v1 vs v2 asymmetry — honest).** In v1, the signer set is not committed
anywhere in the signed material: the ≥t-distinct-certified-shares fact is a
*protocol-level* consequence (part ii) but cannot be re-derived from the
event by a third party. v2 makes it in-band (signers tag bound into the
signed message + INV-VAL-12's size=threshold check). The v1 path is frozen
byte-compatibly (INV-VAL-16, F-6); this is the documented reason v2 exists.

**6.3 (What "certified" adds.)** "Certified roster share" = an index whose
share was produced by the DKG whose transcript was unanimously certified
(INV-DKG-6) — the machine exposes `certifiedGroupPubkey` only at that point,
binding shares to Q. A share from a *failed* DKG (aborted, or a participant
certifying a different transcript — blame-abort) is not a certified share.

**6.4 (The nonce caveat on record).** CRYPTO_AUDIT §1.4 records the one
caveat on S3a: deterministic derivation is safe ONLY because aux randomness
is mixed in (RFC 9591 §4.1). S3 is stated with that mixing as part of the
premise; removing the aux input would void S3 and with it part (ii).

## 7. LEMMA-GAP register

> **GAP-5a (dependency fidelity — S5).** The cryptographic core is executed by
> `@vbyte/frost` 1.1.5, whose internal correctness is established
> empirically (AUDIT probes; AUDIT-4 differential pins in
> `__tests__/cryptoLiteratureAudit.test.ts`) rather than by formal
> verification of its source. If an upgrade broke RFC-9591 semantics, S5
> (and with it part ii) would need re-establishment — the differential pins
> exist precisely to make such a regression loud.
>
> **GAP-5b (assumption-strength honesty).** Part (ii) is a *conditional
> reduction*: "no valid attestation without ≥t distinct certified shares,
> unless S1/S2/S4 fall". It is not an unconditional statement — no proof of
> this shape can be, without proving Schnorr unforgeability. What is
> unconditional is part (i) plus every *structural* check in §5's (V1)–(V6)
> list, which the validator executes on every input.

## 8. Executable evidence

| Property | Where |
|---|---|
| End-to-end pipeline produces verifying attestations (threshold met) | `courtSigningMachine.test.ts` › 'runs the full attempt to a published attestation'; `signing.test.ts` |
| Threshold-over-distinct-signers (duplicates cannot inflate) | INV-SIGN-8/10 pins: 'aborts with blame on conflicting partial signatures'; 'rejects restored state with duplicate or malformed commitment records' |
| Commitment-set = reveal-set (fail-closed subset aggregation) | AUDIT-3 pins (`independentSigning.test.ts`, `signing.test.ts`) |
| Binding factors over (key, msg, commitments) — anti-Drijvers | AUDIT-4 in `cryptoLiteratureAudit.test.ts` |
| Nonce-reuse protection (guard consumption before signing) | `signing.test.ts` nonce-guard suite; `LocalStorageNonceGuard` mirror semantics |
| Validator tamper matrix: any single-field mutation invalidates | `propertiesValidator.test.ts` PV2; `attestationValidator.adversarial.test.ts` |
| Verdict binding (signature certifies the tally) | `validator.test.ts` › 'rejects a verdict hash substituted after signing without a new FROST signature'; INV-VAL-5 suite |
| Signer-set commitment + size=threshold | `propertiesValidator.test.ts` PV3 (root pin / full-set pin equivalence) |
| No v1 downgrade under v2 policy | PV4 |
| Independent DKG + signing cross-checks | `independentDkg.test.ts`, `independentSigning.test.ts` |

## 9. How to check this proof (≈ 45 minutes)

1. §2 code map (15 min): read each cited range; confirm each guarantee is
   actually enforced where claimed (the table is deliberately exhaustive —
   every row is load-bearing for §4/§5).
2. §3 premises (5 min): confirm S3's fences exist in code (NonceGuard
   consumption order; INV-SIGN-1's session hash; AUDIT §1.1/§1.4).
3. §4 (10 min): check the four pipeline facts; the only nontrivial step is
   fact 2 (per-partial verification on the aggregation path —
   `signing.ts:352–365`).
4. §5 (10 min): check the three-case analysis and that each case maps to one
   premise; check the v2 corollary against `validator.ts:619–632`.
5. Run: `npx vitest run __tests__/signing.test.ts
   __tests__/courtSigningMachine.test.ts __tests__/validator.test.ts
   __tests__/propertiesValidator.test.ts __tests__/cryptoLiteratureAudit.test.ts`.
