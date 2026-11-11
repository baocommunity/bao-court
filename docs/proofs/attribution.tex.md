# Theorem 6 — Attribution of FROST signing sessions (and the batch-signing duty)

**Modules:** `attribution.ts` (journal builder + verifier, new),
`signing.ts` (FROST engine), `batchAttestation.ts` (RFC-6962 batch root),
`validator.ts` (aggregate acceptance).
**Status:** proof complete for the reconstruction/verification identities
(unconditional given the published record); attribution of *identity* is
conditional on the **certified-share pin (P1)** and on the **authenticated,
append-only journal (P2)** — stated explicitly in §3 and §10, not hidden.

---

## 1. Statement

A FROST aggregate is an ordinary BIP-340 Schnorr signature `(R, s)` under the
group key `Q`. It names no signers, carries no per-signer material, and is
distributed identically to a single-key signature (Lemma 6.0). Malicious
signers therefore face **zero attribution risk from the signature alone** —
the gap this theorem closes by moving the evidence from the signature to the
**signing session**.

> **Theorem 6 (Attribution).** Fix an empaneled cohort `[1..n]`, threshold
> `t`, group key `Q` (x-only), and certified verification shares `Y_i` from a
> completed DKG ceremony. Let
> `J = (m, Q, {(D_i, E_i)}_{i∈S}, {(s_i)}_{i∈S}, S, t, (R, s))` be a published
> signing-session journal (§2). Then:
>
> **(i) Reconstruction (completeness — unconditional).** If `J` is the honest
> transcript of a FROST round, the aggregate relation
> `s = Σ_{i∈S} s_i + c·π·τ` (mod n) and the group-nonce relation
> `R = Σ_{i∈S} ε(D_i + ρ_i E_i)` both hold, so re-running the aggregate from
> the published partials reproduces `(R, s)` byte-for-byte. Any published
> triple that does **not** reproduce is a forged or inconsistent record — the
> reconstruction check is a deterministic test, not an assumption.
>
> **(ii) Soundness and uniqueness (per signer — unconditional).** Each published
> partial `s_i` satisfies the share-verification identity
> `s_i·G = R_i + c·λ_i·(π·Y_i)`, checked on `x` as BIP-340 does. At most **two**
> scalars per signer can satisfy that x-only identity (`s_i` and `n − s_i`:
> the sign ambiguity inherent in x-only comparison); both name the **same**
> index, so the ambiguity never changes attribution. A journal whose partials
> all verify and reconstruct the aggregate therefore pins the contributing
> signer set `S` exactly — and Lemma 6.4 shows `R` fixes `S` independently.
>
> **(iii) Identity (conditional on P1, P2).** With `Y_i` pinned to the
> certified DKG transcript (P1) and each record entry authenticated by its
> signer's transport key in an append-only log (P2), the shares that signed
> are attributable to the roster indices that published them. A partial that
> fails (ii) is attributable to the index that published it
> (Corollary 6.4). Without P1 a fabricated journal can name a substitute share
> key (self-consistency alone is not identity); without P2 a relay can
> substitute a partial and frame a signer. Both premises are deployment
> obligations, not cryptographic gaps.

The theorem does **not** claim the bare signature is linkable: it is not, and
must not be presented as if it were (Lemma 6.0, §10).

---

## 2. Code map (what each layer actually implements)

| Layer | File:lines | Used below |
|---|---|---|
| Commitment package `(D_i, E_i) = (hidden_pn, binder_pn)`, index-labelled | `signing.ts › createCommitments`; `@vbyte/frost` `create_commit_pkg` | Def. 6.1 |
| Binding factors `ρ_i = H1(prefix ‖ i)`, group nonce `R` | `@vbyte/frost` `commit.js › get_group_binders, get_group_pubnonce`; exposed as `ctx.group_pn` | Lemma 6.1 |
| Lagrange coefficient `λ_i` | `@vbyte/frost` `poly.js › interpolate_x` (used by `sign_msg` and `verify_partial_sig`) | Lemma 6.1/6.2 |
| Partial generation `s_i` | `@vbyte/frost` `sign.js › sign_msg`; wrapped by `signing.ts:242-299` (`createRevealAndPartialSig`, which self-verifies before returning) | Lemma 6.1 |
| Share-verification identity | `@vbyte/frost` `sign.js › verify_partial_sig`; `signing.ts:352-365` (aggregation pre-check) | Lemma 6.2 |
| Aggregate relation | `@vbyte/frost` `sign.js › combine_partial_sigs`; `signing.ts:367-381` | Theorem 6(i) |
| Final acceptance | `verify_final_sig` under `Q`; `signing.ts:374-381`; `validator.ts` `p`-tag pin | §4 |
| Journal builder / verifier | `attribution.ts › buildSigningJournal`, `verifyAggregateAttribution` | §5 |
| Batch root the duty recomputes | `batchAttestation.ts › buildBatchMerkleTree`, `hashBatchManifest`, `MAX_BATCH_VERDICTS` | §8 |

Every identity below is the one the library implements; the theorem is a
statement about the shipped code, not a parallel design.

---

## 3. Notation and premises

**Definition 6.1 (session record).** A journal is the tuple

```
J = ( m, Q, S, t, {(i, D_i, E_i)}_{i∈S}, {(i, s_i)}_{i∈S}, (R, s) )
```

with `m` the 32-byte signed message digest (`buildAttestationMessage`), `Q`
the group key, `S` the sorted distinct signer index set, `t` the threshold,
`(D_i, E_i)` signer `i`'s round-1 public nonces, `s_i` its round-2 partial,
and `(R, s)` the published aggregate. Canonical encoding:
`attribution.ts › hashSigningJournal` under `BAO-Court/SigningJournal/v1`.

**Definition 6.2 (signing context).** With `ε = +1` when `R` has even Y and
`−1` otherwise, and `π ∈ {±1}` the group-key parity adjustment, define

```
ρ_i  = H1( H5( sorted (i, D_i, E_i) ) ‖ i )        (binding factor)
λ_i  = ∏_{j∈S, j≠i} (0 − j)/(i − j)   mod n         (Lagrange at 0)
R_i  = ε · (D_i + ρ_i · E_i)                        (signer nonce point)
c    = H_challenge(R, Q', m)                        (BIP-340 challenge)
Q'   = π·Q + τ·G                                    (tweaked group point; τ = 0 shipped)
```

**Premises.**

| ID | Premise | Why it is needed | Where enforced / stated |
|---|---|---|---|
| **P1** | `Y_i` for `i ∈ S` are the **certified** DKG verification shares (`DkgRecord.verificationShares`) | self-consistency alone lets a fabricated journal name a substitute share key (§5 Lemma 6.3) | caller supplies the pin to `verifyAggregateAttribution`; DKG certification is INV-DKG-5/6 |
| **P2** | journal entries are **authenticated per signer** and stored in an append-only log | a relay/host that can rewrite a published partial can frame a signer | ceremony events are NIP-01-signed by each juror; the log design is `docs/ATTRIBUTABLE_SIGNING.md` §3 |
| **H3** | SHA-256 / tagged-hash collision resistance (`H1`, `H5`) | rules out two distinct indexings producing the same binding prefix | same assumption family as T2 §3 (H1) |
| **S1** | Schnorr unforgeability | a partial that verifies under `Y_i` was produced by a holder of `x_i` | T5 §3 (S1), restated |

---

## 4. The algebra: what the aggregate actually is

**Lemma 6.0 (the bare aggregate is unlinkable).** `(R, s)` is a valid BIP-340
signature under `Q` and contains no signer-identifying field. For any other
signer subset `S'` with `|S'| ≥ t`, the distribution of `(R, s)` produced by
`S'` is the same as that produced by `S` (both are uniform Schnorr signatures
under the same key). *Consequence:* attribution cannot be a property of the
signature; it must be a property of a published session record. This is the
finding, not a limitation of the fix.

**Lemma 6.1 (partial and aggregate relations).** For every `i ∈ S`,

```
s_i = c·λ_i·(π·x_i) + ε·(d_i + ρ_i·e_i)                    (mod n)      (6.1)
```

and the aggregate is

```
s = Σ_{i∈S} s_i + c·π·τ                                     (mod n)      (6.2)
R = Σ_{i∈S} R_i                                                          (6.3)
```

*Proof.* (6.1) is `sign_msg` (`sign.js`): `coefficient = interpolate_x(indexes, i)`,
`adjusted_secret = parity·state·seckey = π·x_i`, `combined_nonce =
d_i + ρ_i·e_i`, negated iff `R` has odd Y (the `ε` factor). (6.3) is
`get_group_pubnonce` (sum of `D_i + ρ_i·E_i`, equally parity-flipped, which is
why `ε` multiplies the whole sum). (6.2) is `combine_partial_sigs`: the partials
are summed mod n and the taproot tweak term `c·π·τ` is added (τ = 0 for the
attestation path, which passes no tweaks). ∎

**Corollary 6.1 (verification equation).** Summing (6.1) over `S` and using
Σ`i∈S` λ_i·x_i = f(0) = x (Shamir interpolation at 0, valid for any `|S| ≥ t`),

```
s·G = Σ_i s_i·G = c·π·x·G + Σ_i k_i·G = c·Q' + R,
```

which is exactly the BIP-340 verification equation for `(R, s)` under `Q`.
Hence every honest round is accepted by `verify_final_sig` and by the
validator's Schnorr check — completeness of the whole pipeline in one line.

---

## 5. Per-signer verification and uniqueness

**Lemma 6.2 (share-verification identity).** For `i ∈ S` with verification
share `Y_i = x_i·G`,

```
s_i·G = R_i + c·λ_i·(π·Y_i).                                             (6.4)
```

*Proof.* Multiply (6.1) by `G`: `s_i·G = c·λ_i·π·(x_i G) + ε(d_i + ρ_i e_i)G =
c·λ_i·π·Y_i + R_i`. This is precisely `verify_partial_sig` (it lifts
`hidden_pn`, `binder_pn`, `share_pk`, applies the same `ε` flips, multiplies by
`binder` = ρ_i and `λ_i`, and compares `sG.x` with `R.x`; the comparison is on
x because BIP-340 signatures are x-only). ∎

**Uniqueness (up to the x-only sign ambiguity — unconditional).** Suppose `s_i`
and `s_i'` both satisfy (6.4) for the same `(i, ctx, Y_i)`, where the library
compares only x-coordinates (`verify_partial_sig` returns
`sG.x === R.x`). Then `s_i·G = ± s_i'·G`, so `s_i' ≡ σ·s_i (mod n)` with
`σ ∈ {+1, −1}` — **at most two candidate scalars per signer**, the second
being `n − s_i`. Both verify against the same `Y_i` and name the same roster
index, so the ambiguity **cannot change attribution**; it is exactly the
x-only ambiguity BIP-340 resolves by fixing `R` to even Y.

For the *record* to be accepted, the partials must also satisfy the aggregate
relation (6.2). A sign pattern that flips a subset `T` changes the sum by
`2·Σ_{i∈T} s_i`; it is accepted only if that is `0` mod n (a subset-sum
coincidence, and even then the attributed index set is unchanged because `R`
fixes `S` by Lemma 6.4). So the honest transcript is the unique record **as a
signer-set decomposition**, which is the property attribution needs. No
cryptographic assumption is used for this step.

**Lemma 6.3 (why the pin P1 is required).** Without a pin, the record is
self-describing and therefore forgeable. Take the **published** commitment list
(so `R_i` and hence `R` are fixed), choose partials `s_i'` summing to the
published `s`, and set

```
Y_i' = (s_i'·G − R_i) · (c·λ_i·π)^{-1}
```

for every claimed index. Every `(6.4)` holds by construction and the record
reconstructs `(R, s)` exactly — yet `Y_i'` is not the roster share. Nothing in
the record distinguishes it from the honest transcript: only the comparison of
`Y_i'` with the certified DKG verification shares does. Pinning removes the
degree of freedom — with `Y_i` fixed, (6.4) determines `s_i` as the discrete log
of a point the adversary cannot compute without `x_i` (S1). **Attribution is
therefore exactly as strong as the certified-share pin**, which
`verifyAggregateAttribution` reports as `identityPinned`.

---

## 6. Theorem 6(i): reconstruction

**Claim.** Given `J` and the published `(R, s)`, the checks
`R = Σ ε(D_i + ρ_i E_i)` and `s = Σ s_i + c·π·τ` are deterministic and
byte-exact; an honest transcript passes, any transcript that fails is not the
one that produced `(R, s)`.

*Proof.* `attribution.ts › verifyAggregateAttribution` rebuilds the FROST
context from `(Q, {(D_i, E_i)}, m)`, recomputes `R` (as `ctx.group_pn`),
recomputes `s` by `combine_partial_sigs`, and compares both to the claim. By
Lemma 6.1 the honest values are exactly the recomputed ones, so completeness
holds with no assumption. If a published partial differs from the one used in
the real aggregation, the sum differs by that difference mod n; equality can
hold only if the difference is 0, i.e. the values are identical. Failure is
therefore proof of an inconsistent record (or of a partial that the publisher
never contributed), not a probabilistic statement. The final check
`verify_final_sig` additionally rejects any `(R, s)` that is not a Schnorr
signature under the pinned `Q`, closing substitution of both `R` and `s`
together. ∎

---

## 7. Theorem 6(ii)+(iii): attribution

**Lemma 6.4 (the signer set is determined by `R`).** Let two journals over the
same `(m, Q)` publish the same `R` with signer sets `S ≠ S'`. Their commitment
lists differ (a signer set change changes at least one index → both the
per-index serialization in `H5` and the `H1` inputs for binding factors
change). By H3 the binding prefixes collide with negligible probability, so the
two `R` values differ. Hence, except with negligible probability, **`R` fixes
`S`**; a journal cannot silently claim extra or different signers.

**Proof of Theorem 6(ii).** Lemma 6.2 pins each `s_i` up to the sign ambiguity,
and the ambiguity leaves the index unchanged; Lemma 6.4 fixes `S` from `R`
alone. A journal whose partials all verify therefore exhibits exactly the
signers that produced `(R, s)` — the "decomposition" is the published list
itself, and its correctness is checkable by anyone in `O(|S|)` curve
operations.

**Proof of Theorem 6(iii).** Under P1 the verification shares belong to the
certified roster shares, so a verifying `s_i` was produced by a holder of
`x_i` (S1); under P2 the entry naming `i` was published by `i`'s transport key.
Therefore `S` is exactly the set of shares that signed, attributed to roster
indices.

**Corollary 6.4 (corruption attribution is local).** If `s_i` fails (6.4), the
failure is attributable to index `i` alone: no other signer's partial can
repair it (the reconstruction sum is additive and the other partials are
independent), and a valid participant cannot produce a failing `s_i` without
deviating from `sign_msg`. The verifier reports
`{ code: 'PARTIAL_INVALID', idx: i }` and excludes `i` from `attributed`. The
same locality holds for `SHARE_MISMATCH` (published key ≠ certified share) and
`R_MISMATCH` (aggregate incompatible with the commitments — attributable to the
publisher of the aggregate).

---

## 8. The batch-signing duty (the question one signature per 10 000 verdicts raises)

A kind-39018 batch attestation lets **one** cohort signature certify an epoch's
cohort by signing a manifest `(epoch, cohort, batchIndex, count, root,
finalizedAt)` (`batchAttestation.ts › hashBatchManifest`, `count ≤ 10 000`).
Theorem 6 attributes that signature to the contributing signers — which is
exactly why the contribution must be *informed*:

> **D-BATCH (signer duty, normative).** Before publishing a partial for a batch
> manifest `M` with root `root` and count `n`, a signer MUST verify, locally:
> 1. `n = |H|` where `H` is the verdict-hash list it was given, `1 ≤ n ≤ 10 000`,
>    and the list has no duplicates;
> 2. `buildBatchMerkleTree(H).root = root` — the signer's **own** recomputation,
>    never a value received alongside the manifest;
> 3. `M.epoch`, `M.cohort`, `M.batchIndex`, `M.finalizedAt` match the cohort
>    epoch the signer is currently signing (no cross-epoch or cross-cohort
>    reuse);
> 4. the message it contributes to is the manifest hash `hashBatchManifest(M)`,
>    not a bare root string;
> 5. the outcome of checks 1–4 is recorded in its journal entry (`duty` record,
>    `docs/ATTRIBUTABLE_SIGNING.md` §4).
>
> **Consequence.** Under D-BATCH, the one aggregate certifies exactly the `n`
> verdicts whose hashes that signer recomputed. A signer that skips check 2 is
> certifying an opaque root — and, because of Theorem 6, is doing so
> *attributably*. D-BATCH is the honest reading of "one signature certifies up
> to 10 000 verdicts": the compression is in the signature, not in the
> verification duty.

Status: D-BATCH is a **spec-level duty** today (INV-ATTRIB-3,
`docs/FORMAL_INVARIANTS.md` §16). The
protocol exports the recomputation primitives (`buildBatchMerkleTree`,
`hashBatchManifest`, `buildSigningJournal`); the host that drives the signing
machine is responsible for running and journaling the check. It is not
mechanically enforced by `aggregateAttestation` because that function never
sees a batch root — an enforceable version requires the batch manifest in the
signed message (v0.11 candidate, `docs/ATTRIBUTABLE_SIGNING.md` §5).

---

## 9. What the theorem does **not** give (residuals, stated honestly)

1. **No retroactive attribution for unjournaled sessions.** A bare aggregate
   remains unlinkable (Lemma 6.0). The detective control exists only for
   sessions whose journal was published; the host-side obligation to journal
   every session is deployment work (v0.11 candidate).
2. **No intent, no coercion defence.** Attribution says *who contributed a
   partial*, not why. A signer coerced into signing is still attributed; that
   is the correct forensic output, not an exoneration.
3. **Abstention is invisible.** Jurors who never publish a commitment are
   indistinguishable from offline jurors; the journal attributes participation,
   not sabotage-by-abstention (liveness is A5).
4. **P1/P2 are real.** A journal without the certified-share pin proves only
   internal consistency; a journal not authenticated per signer can be
   tampered with in transit. Both are named premises, tested negatively
   (`__tests__/attribution.test.ts` "identity pin", "wrong signer set").
5. **The log itself can be forked.** An append-only log detects truncation and
   equivocation only if clients gossip tree heads (the RFC 9162 / CT model);
   the journal format is specified, the gossip network is not shipped.

---

## 10. Executable evidence

| Theorem part | Test (`__tests__/attribution.test.ts`) |
|---|---|
| 6(i) completeness: honest journal reconstructs `(R, s)` | "builds a journal that verifies and attributes both signers" |
| 6(i) soundness: inconsistent aggregate rejected | "rejects a signature the published partials do not reconstruct" |
| 6(ii) signer-set decomposition, forged partial attributed | "attributes a forged partial to its signer index" |
| 6(ii) missing partial ⇒ no reconstruction | "fails reconstruction when a partial is missing" |
| 6(iii)/6.4 signer-set binding | "rejects a wrong signer set" |
| P1 identity pin (Lemma 6.3) | "requires the certified verification shares (identity pin)" |
| group-key pin | "rejects a journal bound to a different group key" |
| fail-closed on malformed record data | "never throws on a malformed record (fail-closed)" |
| canonical journal hash | "builds a journal…" (`hashSigningJournal` determinism) |

Plus the upstream pipeline evidence for Lemma 6.1/Corollary 6.1:
`__tests__/signing.test.ts` (full round, corrupt partial rejection) and
`__tests__/independentSigning.test.ts` (session-level mirror).

---

## 11. Dependencies

```
T1 (encoding injectivity) ──► journal canonical hash (field-order determinism)
T5 (attestation soundness) ──► the aggregate the journal explains
        │
        ▼
T6 Attribution ◄── H3 (hash collision resistance), P1 (certified shares), P2 (auth log)
        │
        ▼
D-BATCH duty (§8) ──► batchAttestation.ts (RFC-6962 root)
```

Reading order: 05 → this file. T6 assumes T5's pipeline result (a valid
aggregate over the reconstructed message) and adds the forensic direction:
given the aggregate *and the published session*, who produced it.
