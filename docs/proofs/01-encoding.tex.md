# Theorem 1 — CanonicalWriter encoding: injectivity & unique decomposition

**Module:** `courtSession.ts` (`CanonicalWriter`, lines 458–537); grammar normative in
`docs/FORMAL_INVARIANTS.md` §1.2 (CW-1..CW-3, INV-X-8).
**Status:** proof complete. No lemma-gaps. Conditional on the runtime premises
**E1**/**E2**/**J1** stated below (all enforced at protocol call sites or guaranteed
by the ECMAScript specification).

---

## 1. Statement

> **Theorem 1 (Injectivity and per-schema prefix-freeness of the canonical encoding).**
> Fix a *schema* — a finite sequence σ = (c₁, …, c_m) of chunk kinds
> cᵢ ∈ {u8, u32, u64, bytes, text, hex}. Let D(σ) ⊆ (values)ᵐ be the set of
> value tuples admitted by the writer's range checks (§2 below), and
> Enc_σ : D(σ) → {0,…,255}* the byte string produced by appending the fields
> in schema order and calling `finish()`. Then:
>
> **(a) Unique parse (left inverse).** There is a partial function
> Parse_σ : {0,…,255}* ⇀ valuesᵐ such that for every v ∈ D(σ):
> Parse_σ(Enc_σ(v)) = v and the parse consumes exactly |Enc_σ(v)| bytes.
>
> **(b) Injectivity.** For all v ≠ w ∈ D(σ): Enc_σ(v) ≠ Enc_σ(w).
>
> **(c) Per-schema prefix-freeness.** For all v, w ∈ D(σ):
> Enc_σ(v) ⊑ Enc_σ(w) ⟹ v = w  (⊑ = "is a prefix of").
> Equivalently: distinct tuples under the *same* schema are never in a
> prefix relation.
>
> **(d) Extension uniqueness (concatenation).** For all schemas σ, τ and
> v ∈ D(σ), w ∈ D(τ):
> Enc_{σ·τ}(v·w) = Enc_σ(v) ‖ Enc_τ(w),
> and any parse of the concatenation that is driven by the schema σ·τ
> recovers (v, w) with the σ/τ byte split at exactly |Enc_σ(v)|.

**(b) is exactly CW-2 / INV-X-8 as stated in `docs/FORMAL_INVARIANTS.md` §1.2;
(d) is the property the differential-parity parser exercises (PR #52); (c) is
the honest, correctly scoped form of "prefix-freeness" — see Remark 6.3 for
why the un-scoped claim would be false.**

## 2. Definitions (line-checked against `courtSession.ts:458–537`)

- **Chunk kinds and domains.** For a value v and kind c, the writer admits
  - `u8`: `Number.isInteger(v) ∧ 0 ≤ v ≤ 255` (lines 475–481);
  - `u32`: integer, `0 ≤ v ≤ 0xffff_ffff` (lines 487–493);
  - `u64`: safe non-negative integer, `0 ≤ v < 2⁵³` (lines 499–507);
  - `bytes`: any `Uint8Array` b (line 516; a length > 0xffffffff throws in the
    inner `u32` call — CW-1, no silent wrap);
  - `text`: any string s (line 523) — the byte image is `UTF8(s)` via `TextEncoder`;
  - `hex`: any string h accepted by `hexToBytes` (line 527) — the byte image is `dec(h)`.
- **Encoding of one chunk.**
  - fixed-width kinds write exactly m(c) ∈ {1, 4, 8} bytes, big-endian
    (`buf[len]`, `view.setUint32(len, v, false)`, and the hi/lo pair at
    lines 509–513 — byte-identical to `setBigUint64` for safe integers);
  - variable-width kinds (`bytes`, and therefore `text`/`hex`, lines 516–529)
    write `u32(ℓ)` followed by the ℓ payload bytes, ℓ = |byte image|.
- **Enc_σ** is the concatenation of the chunk encodings in schema order:
  `finish()` (lines 531–536) returns `buf.slice(0, len)` — a pure fold over
  the appended bytes (CW-3, determinism).
- **⊑** denotes the prefix relation on byte strings; **⊏** its strict form;
  **‖** byte concatenation.

## 3. Premises

| # | Premise | Status |
|---|---|---|
| **J1** | ECMAScript runtime semantics: `DataView.setUint32` writes big-endian when `false` is passed; `TextEncoder.encode` implements WHATWG UTF-8 encoding ( lone surrogates → U+FFFD, deterministic); `Number.isSafeInteger` / `Number.isInteger` behave per spec; `Map` preserves insertion order. | Guaranteed by the ECMAScript / WHATWG / Infra specifications; no assumption about a specific engine's extensions. |
| **E1** | `text` arguments lie in the **canonical UTF-8 domain**: `UTF8⁻¹(UTF8(s)) = s` with fatal decoding (`isCanonicalUtf8Text`, `courtCeremonyCore.ts:64–70`; INV-CORE-5). | Enforced at every protocol call site that admits attacker-influenced text: session parameters (`assertCanonicalText` + NFC + control-char guard, `courtSession.ts:185–204`), vote/confirmation/signing outcomes (`courtVoteMachine.ts:487–509`, round-trip check at line 502; `courtSigningMachine.ts:395–402`), validator outcome bounds (v2). |
| **E2** | `hex` arguments are **canonical lowercase hex**: the byte image `dec(h)` is the intended value; distinct canonical hex strings have distinct images. | Enforced at every protocol call site by `HEX_32 = /^[0-9a-f]{64}$/` (`courtCeremonyCore.ts:22` — lowercase only) and the compressed-key / 128-hex signature guards. Outside the canonical domain the theorem's conclusions hold *modulo case equivalence* (Remark 6.4). |

## 4. Lemmas

> **Lemma 4.1 (Self-delimiting chunks).** Let c be a chunk kind and v an
> admissible value. The extent (byte length) of Enc_c(v) is determined by the
> first ≤ 4 bytes of Enc_c(v): for fixed-width c it is the constant m(c) ∈
> {1, 4, 8}; for variable-width c it is 4 + ℓ where ℓ is the big-endian
> integer in the first 4 bytes.
>
> *Proof.* Immediate from §2: fixed-width kinds write a constant number of
> bytes; `bytes` writes `u32(ℓ)` first (line 517) and then exactly ℓ payload
> bytes (lines 518–520); `text`/`hex` delegate to `bytes` (lines 524, 528). ∎

> **Lemma 4.2 (Fixed-width injectivity).** For c ∈ {u8, u32, u64}, the map
> v ↦ Enc_c(v) is injective on the admissible range, and two encodings agree
> on all m(c) bytes iff the values are equal.
>
> *Proof.* u8: the single byte *is* the value. u32: big-endian base-256
> representation is injective on [0, 2³²) — standard positional-notation
> argument: `setUint32(offset, v, false)` writes the unique 4-byte
> representation (J1). u64: lines 509–513 write `(⌊v/2³²⌋, v mod 2³²)` as two
> big-endian u32s; the map v ↦ (⌊v/2³²⌋, v mod 2³²) is the Euclidean division
> pair, which is unique and injective for 0 ≤ v < 2⁵³ < 2⁶⁴; composition of
> injective maps is injective. ∎

> **Lemma 4.3 (Deterministic consumption).** Let σ = (c₁, …, c_m), v ∈ D(σ),
> x = Enc_σ(v), and let y be any byte string with x ⊑ y. Then the greedy
> schema-directed parse of y under σ — read chunk i according to kind cᵢ:
> consume m(cᵢ) bytes (fixed width) or 4 + ℓ bytes where ℓ is read from the
> next 4 bytes (variable width) — consumes exactly |x| bytes for the first m
> chunks, and recovers exactly the values of v.
>
> *Proof.* By induction on m. For m = 0 nothing is consumed. For
> σ = c·σ′: by Lemma 4.1 the extent of the first chunk of x is determined by
> x's own first ≤ 4 bytes, which are also y's first ≤ 4 bytes (prefix). The
> required bytes exist in y because they exist in x ⊑ y. So the parse consumes
> the first-chunk extent e, which is the same in x and y; the remainder
> x[e..] = Enc_{σ′}(v₂…) is again a prefix of y[e..], and the induction
> applies. ∎

## 5. Proof of the Theorem

**(a) Unique parse.** Define Parse_σ as the greedy schema-directed parse of
Lemma 4.3 (throwing on truncation, exactly as the reference parser
`refParseCanonical` does — `__tests__/reference/refCanonical.ts`, "Strictly
bounds-checked"). Lemma 4.3 with y = x = Enc_σ(v) gives
Parse_σ(Enc_σ(v)) = v with exact consumption — provided the *values* the parse
reads off agree with v's. Fixed-width chunks: Lemma 4.2. Variable-width
chunks: the parse reads ℓ from the length prefix (which equals the payload
length by construction, line 517) and returns the payload bytes — for
`bytes` that is the value itself; for `text`/`hex` it returns the byte image,
which equals the original value's image. Under premises E1/E2 the value is
recovered from its image (canonicality is exactly injectivity of the
image map); without them the parse still returns a *determinate* canonical
witness (Remark 6.4). ∎ (part a)

**(b) Injectivity.** Suppose Enc_σ(v) = Enc_σ(w) with v, w ∈ D(σ). Then each
is a prefix of the other. Apply part (a): v = Parse_σ(Enc_σ(v)) =
Parse_σ(Enc_σ(w)) = w. (This is the general fact: a map with a left inverse
on its image is injective.) ∎ (part b)

**(c) Per-schema prefix-freeness.** We prove the stronger statement by
structural induction on |σ|:

> **C(σ):** for all v, w ∈ D(σ): Enc_σ(v) ⊑ Enc_σ(w) ⟹ v = w.

- |σ| = 0: D(σ) contains only the empty tuple, so v = w trivially.
- σ = c·σ′. Assume x = Enc_σ(v) ⊑ y = Enc_σ(w).
  - *c fixed width m:* the first m bytes of x and y agree (prefix, and both
    strings have ≥ m bytes). By Lemma 4.2, v₁ = w₁. Strip m bytes: x[m..] ⊑
    y[m..], where x[m..] = Enc_{σ′}(v₂…) and y[m..] = Enc_{σ′}(w₂…). By the
    induction hypothesis (v₂…) = (w₂…), hence v = w.
  - *c variable width:* the first 4 bytes of x and y agree, so the length
    prefixes are equal: ℓ_v = ℓ_w = ℓ. The first chunk's extent is 4 + ℓ in
    both strings; moreover 4 + ℓ ≤ |x|, because |x| = 4 + ℓ_v +
    |Enc_{σ′}(v₂…)| ≥ 4 + ℓ. Hence the entire payload of x's first chunk lies
    inside the common prefix, and the payloads agree (equal length, one a
    prefix of the other). So the first-chunk byte images coincide:
    - `bytes`: b_v = b_w ⟹ v₁ = w₁.
    - `text`: UTF8(s_v) = UTF8(s_w); by premise **E1** (canonical round trip)
      s_v = s_w.
    - `hex`: dec(h_v) = dec(h_w); by premise **E2** (canonical lowercase hex)
      h_v = h_w.
    Strip 4 + ℓ bytes; the remainder is a prefix relation between
    Enc_{σ′}(v₂…) and Enc_{σ′}(w₂…); induction hypothesis ⟹ (v₂…) = (w₂…).
    Hence v = w. ∎ (part c)

**(d) Extension uniqueness.** `finish()` returns exactly the bytes appended so
far in append order (lines 531–536; a pure fold — CW-3). Appending the fields
of v under σ and then the fields of w under τ therefore yields byte-for-byte
Enc_σ(v) ‖ Enc_τ(w); this is Enc_{σ·τ}(v·w). Now run the σ·τ-parse of the
concatenation. By Lemma 4.3 (with x = Enc_σ(v), y = Enc_σ(v) ‖ Enc_τ(w)) the
first m = |σ| chunks consume exactly |Enc_σ(v)| bytes and recover v; the
remainder is Enc_τ(w), from which the τ-tail of the parse recovers w by
part (a). The split point is thus forced to be |Enc_σ(v)| — the parse never
"swallows" bytes of τ into σ's last field, because every variable-width
field's extent is fixed by its own length prefix (Lemma 4.1), not by the
parse's discretion. ∎ (part d)

∎ Theorem 1.

## 6. Remarks

**6.1 (Executable witness — PR #52).** The production `CanonicalWriter` has no
parser; the differential-parity round shipped an *independent* recursive-descent
parser over the same grammar (`__tests__/reference/refCanonical.ts`,
`refParseCanonical(schema, buffer)`) with different architecture (flat byte
accumulator + manual big-endian + Node `Buffer` UTF-8 vs production's chunk
push + `DataView` + `TextEncoder`). The suite
`__tests__/differentialParity.test.ts` exercises Theorem 1 mechanically:
byte-identity over 300 seeded random field sequences; 200 round-trips through
the reference parser; 200 prefix-freeness pairs (encode(A)‖encode(B) parses as
A-then-B with byte-exact consumption — Theorem 1(d)); 250 injectivity vectors
including the aliasing traps `('ab','c')` vs `('a','bc')` and `u64(1)` vs
`u8(1)` (Theorem 1(b)); identical fail-closed range rejection (CW-1).

**6.2 (Why the protocol only ever needs (b) and (d)).** Every hash input in the
Court is written by a *statically known* schema: `encodeCourtSessionParameters`
(`courtSession.ts:564–592`), `hashCourtVoteCommit` / `hashCourtVerdict` /
`hashDisputeVerdict` (`courtVoteMachine.ts:198–341`), `hashCourtSigningSession`
(`courtSigningMachine.ts:230–254`), `hashBatchManifest` (`batchAttestation.ts:388–411`),
`hashSignerSetRoot` (`validator.ts:353–378`). The verifier of a hash always
knows which schema produced it, so Theorem 1(b) (distinct tuples → distinct
bytes, hence — with SHA-256 determinism — distinct hash *inputs*) is the
load-bearing direction; Theorem 1(d) is what lets an independent
implementation stream-parse concatenated documents, which the parity suite
pins.

**6.3 (Honest scoping of "prefix-free").** The set { Enc_σ(v) : σ, v } over
*all* schemas is **not** prefix-free: e.g. Enc₍u8₎(1) = `01` is a proper
prefix of Enc₍u8,u8₎(1, 2) = `01 02`. Unscoped prefix-freeness would also fail
via the empty document (⟨doc⟩ ::= ⟨chunk⟩* admits ε). This is why CW-2's
guarantee is stated per fixed field-tuple shape (as FORMAL_INVARIANTS §1.2
does: "no two distinct field tuples encode to the same ⟨doc⟩" — injectivity,
Theorem 1(b)) and why every hash call site pins its schema statically
(Remark 6.2). Claiming more would be false; claiming less is unnecessary.

**6.4 (What breaks without E1/E2).** If a `text` argument were a non-canonical
string containing a lone surrogate (e.g. `'A\uD800'`), `TextEncoder` would
map it and `'A\uFFFD'` to the same bytes — the encoding would identify two
distinct strings, and two ballot outcomes could hash identically while the
tally counted them as different keys (this is precisely the hazard documented
at `courtCeremonyCore.ts:57–70` and excluded by INV-CORE-5 + the creation
guards). If a `hex` argument were non-canonical-case, distinct strings could
share a byte image and Theorem 1(b) would hold only modulo case equivalence.
Both are excluded at the boundaries, so the theorem as stated covers every
protocol call site.

**6.5 (u64 width).** Safe integers (< 2⁵³) are strictly narrower than 2⁶⁴, so
the u64 encoding never wraps: the hi/lo split at lines 509–513 is the exact
big-endian representation (Lemma 4.2), independently pinned against
`BigInt`-based `setBigUint64` by the differential suite.

## 7. How to check this proof (≈ 20 minutes)

1. Read `courtSession.ts:458–537` against §2 (each claim cites its lines).
2. Check Lemma 4.1 against lines 475–529 (fixed widths; length-prefix-first).
3. Check the induction in 5(c): the only case analysis is fixed vs variable
   width; confirm the prefix argument respects chunk extents (Lemma 4.1).
4. Confirm premises E1/E2 are enforced where the theorem is consumed
   (`courtCeremonyCore.ts:22, 64–70`; `courtVoteMachine.ts:487–509`;
   `courtSession.ts:185–204`).
5. Run `npx vitest run __tests__/differentialParity.test.ts` for the
   executable witness.
