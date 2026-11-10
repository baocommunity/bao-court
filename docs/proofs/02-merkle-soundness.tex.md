# Theorem 2 — Batch-attestation Merkle soundness

**Module:** `batchAttestation.ts` (tree lines 128–230, builder 249–275,
verifier `verifyCaseInBatch` 681–762, event validator 510–648).
**Status:** proof complete. Conditional on premises **H1** (SHA-256 collision
resistance) and **H2** (BIP-340 Schnorr EUF-CMA) — stated explicitly in §3.
The completeness direction and all structural lemmas are unconditional
(properties of the pure code).

---

## 1. Statement

Fix the notation of `batchAttestation.ts`:

- `BatchLeaf(v) = SHA-256("BAO-Court/BatchLeaf/v1" ‖ 0x00 ‖ dec(v))` for a
  32-byte verdict hash v (lines 129–134; the `0x00` tag written by
  `CanonicalWriter.u8`, Theorem 1 encoding);
- `BatchNode(l, r) = SHA-256("BAO-Court/BatchNode/v1" ‖ 0x01 ‖ dec(l) ‖ dec(r))`
  (lines 137–143);
- for a leaf array Λ = (λ₀, …, λ_{n−1}) (n ≥ 1), the RFC-6962 root
  `Root(Λ) = subtreeRoot(Λ, 0, n)` with the unbalanced split
  `k(n) = 2^⌊log₂(n−1)⌋` (lines 149–153, 175–179);
- `Path(Λ, i) = buildPath(Λ, 0, n, i)` (lines 182–194).

Let an *honest batch* be a kind-39018 event E built over the committed verdict
array V (distinct, `HEX_32`), with leaf array Λ = BatchLeaf∘V, root
R = Root(Λ), count n = |V|, and a cohort signature over the manifest
`(epoch, cohort, batchIndex, n, R, finalizedAtSec)`.

> **Theorem 2 (Merkle soundness of `verifyCaseInBatch`).**
> **(a) Completeness (unconditional).** For every honest batch E with its
> honestly built proof `Path(Λ, i)` for leaf index i, and any case inputs
> whose verdict hash is V[i]:
> `verifyCaseInBatch(E, caseInput, ctx)` returns `{valid: true}` whenever the
> event passes `validateBatchAttestationEvent` (signature, pins).
>
> **(b) Soundness (conditional on H1, H2).** Suppose
> `verifyCaseInBatch(E, caseInput, ctx)` returns `{valid: true}`, where ctx
> pins `expectedGroupPubkey` to the empaneled cohort key Q. Let
> L = `BatchLeaf(hashCourtVerdict(caseInput))` be the recomputed leaf. Then
> L is a member of the committed leaf set — i.e. there is a verdict hash
> v in the cohort's committed array with `BatchLeaf(v) = L` — **unless the
> adversary has found a SHA-256 collision (H1) or forged a Schnorr signature
> under Q (H2).**

The ⟺ form requested by the program holds with the premises carried by the
forward direction only: (a) is unconditional; (b) carries H1 + H2. Both
directions are spelled out below.

## 2. Structural lemmas (unconditional — pure code)

All line references are to `batchAttestation.ts`.

> **Lemma 2.1 (Split well-foundedness).** For every n ≥ 2, k = splitPoint(n)
> satisfies 1 ≤ k ≤ n−1; hence both halves (k, n−k) are strictly smaller than
> n and every recursion in `subtreeRoot` / `buildPath` / `foldRoot`
> terminates.
>
> *Proof.* `splitPoint` (149–153) starts at k = 1 and doubles while 2k ≤ n−1;
> on exit k ≤ n−1 < 2k. So 1 ≤ k ≤ n−1, giving n − k ≥ 1 and k ≤ n−1 < n. ∎

> **Lemma 2.2 (Path shape).** For every n ≥ 1 and 0 ≤ i < n:
> `|buildPath(Λ, 0, n, i)| = expectedPathLength(n, i)`, and buildPath's
> recursion visits exactly the same (lo, hi, target) triples as
> expectedPathLength's loop.
>
> *Proof.* Both procedures implement the same recurrence: at interval size
> m > 1 with split k(m), descend into the half containing the target and
> increment the counter/append one sibling. Induction on m: m = 1 — buildPath
> returns `[]` (line 188) and the loop body never runs (line 199 guard
> `n > 1`), both length 0. m > 1: if `target − lo < k` both take the left
> half (`buildPath` line 190–192; loop line 201–203), else the right half
> (193, 204–206), each incrementing the length by one and recursing on an
> interval of size k or m−k. The split function is deterministic in m, so the
> descent paths coincide term by term. ∎

> **Lemma 2.3 (Fold = recomputation; grafting).** For every n ≥ 1, every
> 0 ≤ i < n, every path p with |p| = expectedPathLength(n, i), and every
> 32-byte accumulator L: let M = Graft(p, n, i, L) be the leaf array defined
> by — M[i] = L; and for every recursion node (lo, hi) of the split descent
> of (n, i) whose interval does not contain i, the entries of M on that
> interval are ANY values with `subtreeRoot(M, lo, hi)` equal to the
> corresponding path entry (one entry is consumed per descent level, nearest
> split first: `p` is ordered leaf-sibling-first… precisely, `p` is ordered
> so that `p[|p|−1]` is the sibling at the TOP split — line 225 reads
> `path[path.length − 1]`). Then
>
>     foldRoot(p, n, i, L) = subtreeRoot(M, 0, n).
>
> In particular (taking p = Path(Λ, i), L = Λ[i], M = Λ):
> `foldRoot(Path(Λ, i), n, i, Λ[i]) = Root(Λ)`.
>
> *Proof.* Induction on n. n = 1: `foldRoot` returns acc (line 223–224);
> i = 0, M = (L), `subtreeRoot` returns `leaves[0]` (line 176) — equal.
> n ≥ 2: k = splitPoint(n) in both procedures (lines 224, 177 — same
> deterministic function, Lemma 2.1). Case `i < k` (left half): `foldRoot`
> takes `sibling = p[p.length−1]` and recurses `foldRoot(p′, k, i, L)` with
> p′ = p without its last element (line 227); by Lemma 2.2 the sibling at
> this (topmost) level is the subtree root of the right half, i.e. Graft
> assigns `subtreeRoot(M, k, n) = sibling`. By the induction hypothesis,
> `foldRoot(p′, k, i, L) = subtreeRoot(M, 0, k)` (the descent (k, i) inside
> (0, k) is the same recursion; the graft constrains only intervals not
> containing i, consistently with p′). Then
> `batchNode(subtreeRoot(M,0,k), subtreeRoot(M,k,n)) = subtreeRoot(M, 0, n)`
> by the definition of subtreeRoot (line 178). Case `i ≥ k` is symmetric
> (line 229: `batchNode(sibling, foldRoot(…, n−k, i−k, …))`). The "in
> particular" clause is the same argument with M = Λ, where every
> non-containing interval's graft value is by construction the honest
> subtree root, so Graft(p, n, i, Λ[i]) = Λ. ∎

> **Lemma 2.4 (Leaf recomputation binding).** `verifyCaseInBatch` recomputes
> the verdict hash from the caller's case inputs with the vote machine's own
> `hashCourtVerdict` (line 726 — not a fork, not taken from the proof) and
> rejects unless `proof.verdictHash` equals the recomputed leaf (lines
> 728–730, INV-BATCH-15).
>
> *Proof.* Direct reading of lines 726–730. ∎

## 3. Premises

| # | Premise | Formal content | Where used |
|---|---|---|---|
| **H1** | **SHA-256 collision resistance.** It is computationally infeasible to find any two *distinct* byte strings x ≠ x′ with SHA-256(x) = SHA-256(x′). (Only the restricted family of structured inputs — domain-prefixed leaf/node/manifest encodings of Theorem 1 — is exercised, but we assume the general property.) | Standard assumption; SHA-256 has no known collision attack better than ≈ 2¹²⁸ generic work. | The "⟹" direction of (b): distinct trees (or a leaf vs node confusion) with equal digests. |
| **H2** | **BIP-340 Schnorr EUF-CMA.** Given the cohort public key Q and signing-oracle access to honest cohort signing rounds, no efficient adversary can produce a fresh (msg, σ) pair with `schnorr.verify(σ, msg, Q) = true` that was not produced by an honest round. | Standard assumption (BIP-340; @noble/curves implementation pinned by the suite). | Binding the root R (and count n) to a cohort endorsement: `validateBatchAttestationEvent` lines 634–641. |

Ambient premises inherited from Theorem 1: **E2** (canonical lowercase hex —
all leaf/verdict/proof strings are `HEX_32`, checked at lines 113–117,
262–271) and **J1** (deterministic hashing). Also the *caller contract* that
the ctx pin `expectedGroupPubkey` equals the empaneled key Q — a present-but-
empty pin fails closed (F-2, lines 520–525; INV-BATCH-12, lines 604–606);
without the pin, "the committed set" is only bound to *some* key, not to the
court's cohort (documented caller duty, module docstring lines 66–71).

## 4. Proof

### 4.1 Part (a) — completeness (unconditional)

Let E be an honest batch with leaf array Λ, root R, count n, and honest proof
p = Path(Λ, i) for the case's leaf index i, and let caseInput's verdict hash
be V[i] so that the recomputed verdict hash (line 726) is V[i] and the
recomputed leaf is L = BatchLeaf(V[i]) = Λ[i] (the builder computes leaves by
exactly this function, line 273).

Walk the checks:

1. Call-argument guards pass (well-formed inputs) — lines 691–722.
2. `caseInput.proof.verdictHash` = Λ[i] = recomputed leaf — line 728 passes.
3. Required tags present; count parses, 1 ≤ n ≤ 10 000 — lines 732–742.
4. `i < n` — line 744 passes (honest index).
5. `|p| = expectedPathLength(n, i)` — line 747 passes by Lemma 2.2.
6. `foldRoot(p, n, i, L) = Root(Λ) = R = rootTag` — line 752–756 passes by
   Lemma 2.3 (graft with M = Λ).
7. `validateBatchAttestationEvent(E, ctx)` — the full event check: tags,
   consistency, id recomputation, pins, and the cohort Schnorr signature over
   the recomputed manifest hash (lines 526–641). For an honestly signed event
   with matching pins this verifies (Schnorr correctness; H2's honest-round
   clause).

Hence `{valid: true}`. ∎ (a)

### 4.2 Part (b) — soundness (conditional on H1, H2)

Assume acceptance. From the final call (line 761) and the checks inside
`validateBatchAttestationEvent`:

- (S) `schnorr.verify(σ, manifestHash, cohortTag)` = true, where
  `manifestHash = H(BatchManifest/v1, …, count, rootTag, finalizedAtSec…)`
  (lines 621–641), `cohortTag = event.pubkey = pTag` (lines 548–553), and —
  under the ctx pin — `cohortTag = Q`.
- (C) `count = countTag`, `rootTag` = the root the proof folded to:
  line 752–756 established `foldRoot(p, count, i, L) = rootTag`.

By **H2** (with the pin Q), the manifest — in particular the pair
(count, R := rootTag) — was endorsed by an honest cohort signing round. That
round, by the protocol's construction (`buildBatchMerkleTree`, lines 249–275),
computed R = Root(Λ) over the cohort's committed leaf array Λ (distinct
HEX_32 verdict hashes, canonically sorted, leaves = BatchLeaf images). Fix
this Λ; note |Λ| = count = n.

Now apply Lemma 2.3 to the accepted proof: with
M = Graft(p, n, i, L) (a well-defined length-n leaf array with M[i] = L),

    Root(M) = foldRoot(p, n, i, L) = R = Root(Λ).

**Case M = Λ.** Then L = M[i] = Λ[i] ∈ Λ: the recomputed leaf IS a member of
the committed set. Done — no premise consumed.

**Case M ≠ Λ.** We exhibit a SHA-256 collision. We claim:

> **Claim.** For length-n arrays M ≠ Λ with Root(M) = Root(Λ), there exist
> two distinct byte strings x ≠ x′ of the structured family
> {domain ‖ tag ‖ payload} (leaf or node encodings) with
> SHA-256(x) = SHA-256(x′).

*Proof of the claim by strong induction on n.* If n = 1, Root is the identity
(line 176), so M = Λ — contradiction; vacuous. For n ≥ 2, both roots were
computed with the same split k = splitPoint(n) (deterministic in n), so

    BatchNode(M_L, M_R) = BatchNode(Λ_L, Λ_R),

where (M_L, M_R) are the roots of M's left/right halves (a half of size 1
"root" being its single leaf value, line 176).

- If (M_L, M_R) ≠ (Λ_L, Λ_R): the two `batchNode` inputs are
  `"BAO-Court/BatchNode/v1" ‖ 0x01 ‖ dec(M_L) ‖ dec(M_R)` and
  `"…/BatchNode/v1" ‖ 0x01 ‖ dec(Λ_L) ‖ dec(Λ_R)`. Distinct hex pairs give
  distinct decodings (Lemma: `dec` is injective on fixed-length lowercase
  hex — premise E2), hence distinct SHA-256 inputs with equal outputs: a
  collision (H1).
- If (M_L, M_R) = (Λ_L, Λ_R): then Root(M_L) = Root(Λ_L) and
  Root(M_R) = Root(Λ_R) with (by M ≠ Λ) at least one half's arrays distinct
  and of strictly smaller size; the induction hypothesis applies to that
  half. (Leaf level: a size-1 half's "root" is the leaf value itself; if the
  size-1 arrays differ, their parent node inputs already differed — handled
  by the first bullet at the parent level; if all aligned pairs are equal
  down to the leaves, M = Λ, contradiction.)

This proves the Claim.

Now, one further structural point — the **leaf/node separation** (the
second-preimage argument the domain separation exists for). Suppose the
adversary's grafted tree M reuses *digest material across levels or kinds*:
e.g. L (a leaf digest) appearing where an honest interior-node digest stands,
or vice versa. `BatchLeaf` inputs and `BatchNode` inputs are never equal as
byte strings — the domains differ (`BatchLeaf/v1` vs `BatchNode/v1`, lines
38–41) AND the tag bytes differ (`0x00` at line 131 vs `0x01` at line 139).
So any equality between a leaf digest and a node digest is itself a
collision between two distinct SHA-256 inputs — subsumed by H1. This is the
classical RFC-6962 §2.1 motivation: without the leaf/node split, a leaf hash
could be re-interpreted as an interior node preimage (a second-preimage
attack on the tree); here both the domain prefix and the tag byte must be
forged, and either forgery is a H1-collision. The same argument covers
`BatchManifest/v1` (a third domain, u8(1)-led body, lines 402–410): manifest
and tree digests cannot alias without a collision.

Therefore, in Case M ≠ Λ, acceptance of a proof for a leaf outside the
committed set implies H1 is false. Contrapositively, under H1 (and H2 for the
manifest endorsement), acceptance implies L ∈ Λ — the recomputed leaf is in
the committed set. ∎ (b)

∎ Theorem 2.

## 5. Corollaries

> **Corollary 5.1 (Case binding).** Under H1, an accepted `verifyCaseInBatch`
> certifies the *case inputs themselves*: the accepted leaf is
> `BatchLeaf(hashCourtVerdict(caseInput))` (Lemma 2.4), so the cohort
> committed a verdict with exactly the presented
> `(sessionHash, outcome, supportingEventIds)` — unless a
> `hashCourtVerdict`-preimage collision exists (itself a H1 instance, by
> Theorem 1(b) + SHA-256 injectivity-up-to-collision).
>
> **Corollary 5.2 (What is NOT claimed — the documented scope).** The proof
> pins the verdict HASH only. (i) The authenticity of the underlying
> supporting event ids (that they are real reveals/confirmations of that
> session) is the caller's authentication duty (`verifyCaseInBatch`
> docstring, lines 660–670). (ii) Batch membership is per-batch: the same
> verdictHash may legitimately appear in another epoch's batch (INV-BATCH-16,
> finding F-1); consumers must deduplicate by verdictHash. (iii) Without the
> `expectedGroupPubkey` pin, "the committed set" is bound only to
> `event.pubkey`, which may be any key (SEQUENCE-3 in
> `__tests__/adversarialCrossModule.test.ts`).

## 6. Executable evidence

| Property | Where |
|---|---|
| Completeness: every honest index's proof verifies (n = 1..8, 63/64/65) | `batchAttestation.test.ts` › 'covers n=1..8 and every index proof verifies against the root'; 'covers n=63/64/65…' |
| Root/proof oracle across n = 1..300 (independent split-point oracle) | `propertiesBatch.test.ts` PB1/PB3 |
| Differential parity: independent RFC-6962 builder + record-and-replay verifier, n = 1..128, **8256 proofs**, node:crypto vs @noble | PR #52, `__tests__/differentialParity.test.ts` |
| Soundness-by-recomputation (tampered outcome/sessionHash/supporting id rejected) | `batchAttestation.test.ts` › 'fails a tampered outcome' etc.; `propertiesBatch.test.ts` PB5 |
| Path-shape and index-bound checks are load-bearing | `batchAttestation.test.ts` › 'fails a wrong path length'; 'fails a wrong index' |
| Domain separation (leaf/node/manifest families disjoint as *inputs*) | `invariantAssertions.test.ts` › hash-domain family; INV-BATCH-1 |
| Tamper matrix (every sibling bit-flip, wrong leaf/index, truncated/extended path → reject) | PR #52 differential suite |

## 7. How to check this proof (≈ 30 minutes)

1. Read `batchAttestation.ts:128–230` against §1's definitions and Lemmas
   2.1–2.3 (each cites its lines).
2. Verify Lemma 2.3's induction matches `foldRoot`'s actual slicing
   (lines 217–230) and `buildPath`'s sibling ordering (182–194): the TOP-split
   sibling is the LAST path element.
3. Check the Claim's induction in 4.2 — the only case split is "child pairs
   equal / unequal"; confirm `dec` injectivity on lowercase hex (E2).
4. Confirm the leaf/node input-distinctness claim (domains lines 38–41, tags
   lines 131, 139).
5. Confirm the signature path in `validateBatchAttestationEvent`
   (lines 621–641) covers count and root.
6. Run `npx vitest run __tests__/batchAttestation.test.ts
   __tests__/propertiesBatch.test.ts __tests__/differentialParity.test.ts`.
