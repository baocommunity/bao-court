# Cryptographic Literature Audit — BAO Court v0.9.2

**Round 7 of the symposium/bug-hunt campaign · 2026-11-10 · branch `crypto/literature-audit`**

Scope: the protocol's cryptography *as used* — `crypto.ts`, `signing.ts`, `dkg.ts`,
`independentDkg.ts`/`independentSigning.ts`, `courtSigningMachine.ts` nonce handling,
`batchAttestation.ts` signatures, `validator.ts` Schnorr verify sites, `selection.ts`
seeded randomness. Dependency reality: `@vbyte/frost` 1.1.5 + `@noble/curves` 2.4.0.

Method: every finding is anchored to a literature reference, a code location, an
exploitability sketch, and a disposition (shipped fix <40 lines w/ tests, or spec'd).
§6 is the security-argument skeleton the paper's security chapter builds on.

Severity scale: **H** (attack class applicable as composed), **M** (weakened
property / fail-open under composition), **L** (hardening, contract hygiene),
**OK** (verified sound — recorded so the argument doesn't have to be re-derived).

---

## 1. FROST / Schnorr nonce security

### 1.1 Drijvers/Wagner multi-session attacks — **OK (verified sound)**

**Literature.** Drijvers et al., *On the Security of Two-Round Multi-Signatures*
(IEEE S&P 2019) — Wagner's generalized-birthday (k-tree) attack forges signatures
when an adversary sees victims' nonce commitments across ψ concurrent sessions
before choosing its own shares. FROST (Komlo–Goldberg 2020, eprint 2020/852 §2.5)
defeats it with *binding factors* over (group key, message hash, commitment list).
RFC 9591 (June 2024) standardizes exactly this computation (§4.4). Adaptive-security
state of the art 2025–2026: Crites et al. (CRYPTO 2025) prove full adaptive
security of FROST under the new LDVR assumption; Bacho–Chen–Loss–Tessaro–Zhu
(eprint 2025/1953, EUROCRYPT 2026) give ms-FROST under the older AOMDL assumption.
Neither paper reports an attack on binding-factor FROST; LDVR is the assumption to
watch.

**Code.** `@vbyte/frost` 1.1.5 computes the binding prefix as
`group_pk ‖ H4(msg) ‖ H5(commitment_list)` and per-signer factors
`H1(prefix ‖ SerializeScalar(idx))` (`dist/lib/commit.js`, `ecc/hash.js`) — the
RFC 9591 structure with hash-to-field domain separation. Pinned in
`__tests__/cryptoLiteratureAudit.test.ts` (AUDIT-4): binding factors over the same
commitment set differ for different messages, and the challenge differs — the
anti-Drijvers property cannot silently regress in an upgrade.

**Concurrency.** The court layer adds three fences the raw library does not:

- `NonceGuard` (`signing.ts:53-152`): one commitment package consumes at most one
  partial signature, keyed `(idx, binder_pn, hidden_pn)`, process-shared by
  default, `LocalStorageNonceGuard` persists across browser restarts with an
  in-process mirror surviving quota failures. Consumption happens *before*
  `sign_msg`, so a throw wastes a nonce but never reuses one (fail-closed
  direction). This implements RFC 9591 §7.3's recommended coordinator hedge.
- `courtSigningMachine.ts` INV-SIGN-4/8: one nonce commitment and one partial per
  signer per attempt; conflicting resubmission aborts with blame (equivocation
  cannot be used to re-open a closed commitment set).
- The signing-session hash (`hashCourtSigningSession`) binds
  `(sessionHash, verdictHash, outcome, participantIndices, threshold, attempt)` —
  two concurrent signing sessions can never share a session context, so
  cross-session share combination (the Drijvers prerequisite) fails at the
  machine, the guard, and the binding factors simultaneously.

### 1.2 Round ordering vs the FROST two-round structure — **OK**

**Literature.** FROST round 1 (nonce commitments) must precede round 2 (partial
signatures) and the commitment *set* must be frozen before any partial is
verified; ROAST (Ruffing et al. 2022) additionally requires the coordinator to
commit to which shares it aggregates. NCC Group's Zcash-FROST assessment (2023)
stresses the ROS-attack variant when a signer's commitment is *not represented*
in the commitment set used for its partial.

**Code.** `courtSigningMachine` phases: `intent → nonce_commit →
commitment_set_final → partial_sign → aggregate → attestation_published`.
`accept_partial` is illegal before `close_commitments` finalizes the exact signer
set (INV-SIGN-6/7), and `close_commitments` requires ≥ threshold distinct
commitments. The message is fixed at machine creation (bound into the signing
session hash) *before* any commitment is accepted — strictly stronger than
FROST's worst case (message freedom after commitments). Note the message-known-
early direction is the safe one; the dangerous direction (commitments chosen
after partials) is structurally unreachable.

`IndependentSigningSession` mirrors this: `addCommitment` rejects equivocation,
`addReveal` requires the reveal's nonces to match the stored commitment, and
reveals are only admitted from DKG participants bound to roster pubkeys.

### 1.3 Commitment-set/reveal-set equality — **M, shipped fix**

**Literature.** The Lagrange coefficients in FROST are indexed by the *signing
set*. RFC 9591 §5.2 computes λᵢ over exactly the participants in the commitment
list that will sign; mixing sets is undefined behaviour. (NCC 2023's "commitments
must be represented in the set" is the security face of the same constraint.)

**Code + empirical probe.** `@vbyte/frost`'s `interpolate_x(indexes, …)` indexes
over `ctx.indexes` = the *full* commitment list passed to
`get_group_signing_ctx`. We probed 1.1.5 directly: a 2-of-3 threshold group with
3 commitments and 2 reveals produces per-partial *verification success* but a
final aggregate that **fails** `verify_final_sig` (fail-closed), while ctx over
exactly the 2 revealing signers verifies. Consequences:

- `IndependentSigningSession.canAggregate()` accepted `reveals ≥ threshold` while
  `createMyReveal` signs against *all* collected commitments — a committed-but-
  silent peer drove every aggregation attempt into the guaranteed-failing final
  check, burning a nonce commitment per juror per attempt. Fail-closed (never a
  forgery) but a systematic liveness trap with no diagnostic.
- `aggregateAttestation` (`signing.ts`) has the same latent contract, undocumented.

**Shipped.** `canAggregate()` now requires the reveal set to *equal* the
commitment set and `aggregate()` throws a precise reason
(`independentSigning.ts`); the contract is documented on `aggregateAttestation`
(`signing.ts`); tests pin both the full-coverage success and the fail-early
subset behaviour (AUDIT-3). Spec'd follow-up (C-1 in §7): let the machine layer
mediate a threshold-subset signer set — the correct FROST flow — by rebuilding
the session against the finalized subset.

### 1.4 Deterministic nonce derivation (HKDF) — **OK, with one caveat**

**Literature.** RFC 9591 §4.1/§7.3 is explicit: signing nonces must NOT be
deterministic in the share alone — "deriving nonces deterministically allows for
a complete key-recovery attack" (MuSig/EdDSA-style derivations leak under
challenge manipulation across sessions). Aux randomness must be mixed in.

**Code.** `@vbyte/frost`'s `generate_nonce(secret, aux)` = `H3(aux ‖ secret)` with
`aux = Buff.random(32)` when no seed is passed — the RFC structure with fresh
aux randomness per commitment. The court never passes seeds to
`create_commit_pkg`. The **deterministic HKDF paths** (`seededScalar` in
`crypto.ts`) are confined to: DKG coefficients under `unsafeTestMode` only
(`dkg.ts:240-245` throws otherwise), and demo/test key material. The caveat,
spec'd (S-4): nothing *enforces* at the type level that `seededScalar`-derived
values never reach a signing nonce; a `@: SigningNonce` brand or a lint rule
would make the RFC 9591 §7.3 violation impossible by construction.

## 2. Domain separation completeness

### 2.1 CanonicalWriter family — **OK (INV-X-1 holds)**

All protocol hash inputs go through `CanonicalWriter` (length-prefixed, tag-free)
under an explicit `BAO-Court/<Name>/v<version>` domain concatenated raw. The
domain family is asserted pairwise-distinct in `__tests__/invariantAssertions.test.ts`
(INV-X-1); domain-string distinctness + length-prefixed bodies make cross-domain
aliasing require a SHA-256 collision. Enumerated raw `sha256` calls outside the
writer pattern (audit sweep of all 35 non-test call sites):

| Site | Input | Verdict |
|---|---|---|
| `selection.ts:121` `deriveSelectionSeed` | `disputeEventId ‖ blockHash`, both enforced 32-byte hex | **OK** — fixed-length fields make concat injective; already documented as finding F-7 in FORMAL_INVARIANTS §1.3 |
| `selection.ts:130` `jurorRandomValue` | `seed ‖ pubkey` (both 32-byte) | **OK** — same injectivity argument |
| `dispute.ts:113` `deriveDisputeGroupPubkey` | `groupPubkey + disputeId` raw **string** concat, no length check | **M → shipped fix** (§2.2) |
| `crypto.ts` PoK challenge (pre-fix) | `'|'`-join with attacker-influenced domain | **M → shipped fix** (§2.3) |
| `dkg.ts:493` | `sha256(seed-string)`, `unsafeTestMode` only | **OK** — test-only |
| `courtKeeper.ts:515` `hashKeeperSecret` | SHA-256 of a 32-byte random secret, self-compared (commit/reveal) | **OK** — no cross-domain consumer |
| `liquidEscrow.ts` / `taprootSpend.ts` / `lnSettlement.ts` | Bitcoin/Elements tagged-hash conventions (`TapSighash`, `sha256(script)` P2WSH) | **OK** — protocol-mandated, not court domains |
| everything else (`courtKeeper:241`, `courtNip46:354`, `courtRecovery:300`, `courtVoteMachine:236`, `validator:322`, `courtConfirmationMachine:325`, `courtSigningMachine:190`, `epochCohort:142/169`, `courtOutbox:189`, `courtHostKey:248`, `escrow:328`, `courtSession:507`, `dispute:46/179`) | domain-prefixed CanonicalWriter encodings | **OK** — inside the INV-X-1 family |

### 2.2 `deriveDisputeGroupPubkey` raw concatenation — **M, shipped fix**

**Literature.** Domain-separation/misbinding failures from unframed hash inputs
are the canonical "hash inconsistency" class (Krawczyk's HKDF paper §3.1 defines
the requirement; BIP-340's tagged-hash construction exists precisely to prevent
it). Two tuples `(pk₁, d₁) ≠ (pk₂, d₂)` with `pk₁ ‖ d₁ = pk₂ ‖ d₂` derive the
*same* demo dispute key.

**Exploitability sketch.** `normalGroupPubkey` was unvalidated: a caller passing
a short/empty pubkey lets `disputeId` absorb it (e.g. pk `"ab"` + id `"cd"` ≡ pk
`"abc"` + id `"d"`), aliasing demo escrow keys across disputes. Contained: the
docstring already forbids using this key for authentication (its dlog is public
by construction — correctly documented against the rogue-key confusion).

**Shipped.** `dispute.ts` now enforces a **fixed 64-char width** on the group
pubkey (any bytes — hex-ness is not required for injectivity, only the fixed
width, which keeps the pre-existing demo test values working) and a non-empty
≤512-char dispute id. With a fixed-width first field the concatenation is
injective; the digest formula is unchanged so existing demo data keeps
deriving the same key. Tests: AUDIT-2.

### 2.3 DKG PoK challenge delimiter-join — **M, shipped fix**

**Literature.** Same hash-inconsistency class as §2.2; the codebase's own rule
("delimiter-joined attacker-controlled strings must never be hashed directly",
`courtSession.ts` CanonicalWriter docstring) and INV-X-1's prefix-freeness
argument (CW-2) both prohibit the old `['…', pk, nonce, domain].join('|')`
challenge. The aliasing tuple: `proofDomain` renders
`market=M|dispute=D|juror=k`; tuples `(M="x", D="y|dispute=z")` and
`(M="x|dispute=y", D="z")` render identically, so a proof created under one
(market, dispute) binding verifies under another. Contained impact: the PoK
proves knowledge of the constant coefficient, which is separately committed in
the VSS commitments and bound to the roster at the event boundary
(`independentDkg.addCommitment` checks `event.pubkey === juror.nostrPubkey`);
the realistic effect is ceremony-binding confusion, not key theft.

**Shipped.** Challenge now encoded via `CanonicalWriter` under
`bao-frost-court/dkg-pok-challenge-v2` (`crypto.ts`); `verifyProofOfKnowledge`
accepts v2 (created) *and* legacy v1 (mixed-fleet rollout window — documented,
fail-closed in the sense that a v1-accepting verifier still checks the full
Schnorr equation). The domain itself is now the canonical
`dkgPokDomain(marketId, disputeId, jurorIdx)` — hex of the length-prefixed
tuple — in both `dkg.ts` and `independentDkg.ts`, killing the delimiter aliasing
at the source. Tests: AUDIT-1 (round-trip, cross-domain rejection, tuple
distinctness, legacy-v1 acceptance, legacy-v1 cross-domain rejection).
**Sunset obligation (round-16 review, finding B-3):** v1 acceptance has no
gate or deadline — until it is removed or parameter-gated (RS-6), every
verifier accepts the aliased v1 encoding, so this class remains reachable
against v1-verifying peers; see the `verifyProofOfKnowledge` docstring for
the sunset trigger.

### 2.4 Selection seed: what it binds, and what it doesn't — **M, spec'd**

`deriveSelectionSeed` binds exactly `(disputeEventId, blockHash)` — **not**
`reputationRoot` or `cohortEpoch` (the prompt's assumption; those exist only as
docstring future-work notes in `selection.ts:40-48`). Three literature-grounded
gaps:

1. **Miner/relay influence on `blockHash` (grinding).** The seed inherits the
   anchoring block's miner's discretion: a miner can grind coinbase tweaks to
   shift the block hash, and a *coordinator* can additionally retry selection
   (`appealCoordinator.maybeReselect` increments `selectionAttempts`, growing
   `excludedPubkeys`) until a favourable roster appears — adaptive-reselection
   grinding. Literature: committee-selection grinding attacks (Algorand's VRF
   design notes; follow-the-satoshi analyses; Drijvers-style "choose after
   seeing" is the same pattern transposed to randomness). Cost model: biasing
   one specific juror into a 5-seat jury costs ≈ pool/5 draws per grind bit;
   controlling a full jury is exponential. Exploitability today: moderate — the
   draw itself is publicly verifiable (`verifyJurySelection`) given the same
   pool and params, so grinding is *evidence-preserving*: an observer re-running
   the draw with the pinned pool detects nothing, because the pin is the
   attacker-chosen block hash/pool.
2. **`reputationRoot` unbound.** Weights are computed from caller-supplied
   juror records; two verifiers holding different pool snapshots legitimately
   disagree. The docstring admits this ("future work"). Spec'd fix S-1.
3. **Pool/params pinning is caller-duty.** `verifyJurySelection` recomputes on
   whatever pool the verifier holds; no commitment ceremony binds the pool
   snapshot into the dispute (the session hash binds the *selected* roster, not
   the candidate pool). Spec'd fix S-1.

**Spec'd fix S-1 (selection anchoring, >40 lines — needs a protocol event):**
commit `SHA256(CanonicalWriter(disputeEventId, anchoring block height h,
blockHash(h), poolRoot, weightRoot, cohortEpoch))` in the dispute-open event;
derive the seed as the XOR (or hash) of k≥3 future block hashes at fixed depths
h+d₁…h+d_k (defeats single-miner grinding; multi-block beacons are the
standard mitigations — cf. NIST beacon, drand, and "grinding-resistant
randomness" in PoS committee selection). Backwards compatibility: keep
`deriveSelectionSeed` for v1 disputes, gate v2 on the session parameters'
`version` byte.

## 3. Rogue-key / key-cancellation (DKG)

### 3.1 Pedersen/PedPop composition — **OK (verified)**

**Literature.** Pedersen DKG (Pedersen 1991) + Feldman VSS commitments; rogue-key
resistance in threshold DKG requires a proof of possession of each constant
coefficient *before* shares are trusted (GJKKS-style Pop's; Chiang et al. and
the FROST-DKG lineage — ChillDKG/BIP-445 draft, Blockstream — certify the full
transcript). Without the PoK, a participant commits to `A₀' = A₀ - Σⱼ≠ᵢ A₀ʲ` and
steers the group key (key cancellation).

**Code.** PoK is created (`crypto.ts createProofOfKnowledge`) and **verified at
both consumption sites**: `PedersenDkgAdapter.resolveComplaints` verifies each
sender's PoK *before* share checks (`dkg.ts:543-551` — the 2026-08-15 fix that
made the previously-dead check live), and `IndependentDkgSession.addCommitment`
verifies it before storing the commitment (`independentDkg.ts:251`). A failed
PoK disqualifies the participant and aborts the attempt (roster never shrinks —
INV-DKG unanimity). Additional rogue-key fences: duplicate nostr pubkeys
rejected (`dkg.validateParams`), shares verified against commitments per
recipient pair, group key = Σ qualified constant commitments, and the
final sanity check that every secret share reproduces its advertised
verification share (`dkg.ts:292-300`, `independentDkg.computeKey`). The
dispute-scoped PoK domain (now canonical, §2.3) binds the proof to
`(market, dispute, juror)` so a PoK cannot be replayed across ceremonies by the
same key holder.

**Note (L, spec'd S-2):** `courtDkgMachine`'s `transcriptHash` — the value all
participants certify in `transcript_signing` — is an opaque `HEX_32` supplied by
the caller; the machine never recomputes it from the actual commitment set.
ChillDKG's ACert binds the full `(idx, pubkey, commitments, PoK, phaseNonce)`
vector canonically. Spec: define `hashDkgTranscript` (CanonicalWriter over the
sorted commitment set + PoKs + roster) and require `certify_transcript` events
to carry enough data to recompute it.

### 3.2 Share-refresh threshold invariance — **OK (CVE-2025-58359 analog)**

ZF-frost CVE-2025-58359 (2025): refreshing with a *smaller* min_signers silently
reduced group security. Our refresh cannot do that: `generateRefreshShares`
emits a degree-`(t-1)` zero-constant polynomial under the session's unchanged
`threshold` (`dkg.ts`), `mergeRefreshCommitments` asserts the count is one less
than the original, `validateRefreshParams` re-checks `threshold ≥ 2` and
share/participant consistency, `refreshShares`/`computeRefreshedKey` throw if
the group public key changed, and every refreshed share is checked against the
recomputed verification share. Documented here as a deliberate, tested
invariant (INV-DKG refresh family).

## 4. Malleability / consensus strictness

### 4.1 s ≥ n and signature encoding — **OK (verified at every call site)**

**Literature.** BIP-340 §"Design": non-canonical `s ≥ n` makes signatures
malleable; verifiers MUST reject `s ≥ n` (and libsecp256k1 rejects; noble is
stricter). Batch attestation consensus additionally needs *uniform* strictness
across implementations.

**Code.** `@noble/curves` 2.4.0 `schnorrVerify` (verified by reading the
installed source): rejects `x ≥ p`/`x = 0` (r), `s ≥ n` **and** `s = 0`
(deliberately stricter than BIP-340 — honest signing reaches s = 0 with
probability ~2⁻²⁵⁶; uniform since every verifier links the same noble),
lifts x with on-curve checks, and enforces even-y R. All seven
`schnorr.verify` call sites are exception-guarded and return a typed false:

- `crypto.ts:278` `verifySchnorr` (try/catch → false)
- `validator.ts:226,249,603` (v1, raw, v2 paths — try/catch → invalid)
- `batchAttestation.ts:522` (outer try/catch → `{valid:false}`)
- `courtHostKey.ts:262` `schnorrVerifyHex` (try/catch → false)
- `escrow.ts:353` `verifyBondOwnershipProof` (try/catch → false)

Encoding strictness: FROST aggregate + validator paths require `^[0-9a-f]{128}$`
(the machine's `SCHNORR_SIGNATURE`) or case-tolerant `{128}` hex at the event
boundary followed by exact byte comparison — no `0x` prefixes are accepted
anywhere (`HEX_32`/`isHex64`/`assertHex32` all reject). The `nonce` tag must
equal `signature.slice(0,64)` (the embedded R) in both v1 attestation and batch
validators — a transplanted signature cannot masquerade under a different
published nonce.

`@vbyte/frost` internals: `verify_partial_sig` lifts x-only points with on-curve
checks and `interpolate_x` asserts index membership + uniqueness (duplicate
indices throw, not miscalculate); `combine_partial_sigs` reduces every partial
mod n. `aggregateAttestation` re-verifies each partial against the finalized
ctx, rejects duplicates, requires ≥ threshold distinct indices, and finally
re-verifies the aggregate with `verify_final_sig` (which delegates to noble's
strict BIP-340 verifier) — so a hostile coordinator's malleated partials or
sums fail closed at the aggregator, and independently again at every validator.

**Uniformity correction (round-16 review, finding B-4).** The "every verifier
links the same noble" claim is **false as stated on this tree**: `nostr-tools`
carries its own *nested* `@noble/curves@2.0.1` alongside the court's 2.4.0 —
two copies, two verifiers (the NIP-01 id path vs the attestation path).
Empirical probe (2026-11-10, this tree, both versions): `schnorr.verify`
accepts a valid signature and rejects `s = n` on **both** 2.4.0 and 2.0.1 —
uniform *today*, by upstream behavior, not by the tree's construction. A
nostr-tools bump can change this silently; it is added to the §6 upgrade
triggers, and the `^`-range caveat below (§6, finding B-2) compounds it.

### 4.2 x-only pubkey edge cases — **OK**

`isValidSecp256k1Point` accepts 64-hex (x-only) or 66-hex compressed *and*
verifies on-curve membership (`Point.fromHex`) — malformed nonce commitments
cannot poison binding-factor computation (INV-SIGN-5, pinned in tests). The
parity caveat is handled where it matters: `IndependentSigningSession.addReveal`
requires the compressed verification pubkey (x-only loses y-parity and the FROST
verification equation needs it), and `restoreFromBackup` rejects a negated
(n-share) backup by exact full-point comparison. `lift_x` rejects x ≥ p.

## 5. Randomness audit

| Path | Source | Verdict |
|---|---|---|
| DKG coefficients, PoK nonces, refresh coefficients | `randomScalar()` → `secp256k1.utils.randomSecretKey()` (noble vetted, rejection-free, `[1, n-1]`) | **OK** |
| Nonce packages | `@vbyte/frost generate_nonce` = H3(32-byte CSPRNG aux ‖ secret) — RFC 9591 §4.1 structure | **OK** |
| BIP-340 signing (`courtHostKey`, `escrow` bond proofs) | `schnorr.sign` default `auxRand = randomBytes(32)` — aux randomness present (BIP-340 §5 recommends; protects deterministic-nonce fault/side-channel attacks) | **OK** |
| Keeper secrets, host key generation | `crypto.getRandomValues` / noble `randomBytes` | **OK** |
| `seededScalar` (crypto.ts) | HKDF-SHA256(seed, info ‖ uint16BE counter), 64-byte OKM, mod-N | **OK** — see §5.1 |
| Demo coordinator fixtures (`appealCoordinator` vote salts, `randomBlockHash`) | CSPRNG, demo-only | **OK** (grinding note in §2.4) |

### 5.1 `seededScalar` counter space — **OK**

The uint16 counter is *inside* the HKDF `info` field together with the
caller-supplied domain string, so counters never collide across distinct
`(seed, info)` pairs; the counter's only role is rejecting the zero scalar
(probability ≈ 2⁻²⁵⁶ — the 65 536-iteration bound is unreachable in practice and
the throw is fail-closed). mod-N bias from the 512-bit OKM is ≈ 2⁻²²⁴ —
negligible. There is no "collision space at scale": different `(seed, info)`
derive independent pseudorandom functions. The one *design* property to keep in
the paper: seeded paths are for **public-derivation demos and secret-seed
material only** — enforced for the DKG (`unsafeTestMode` gate, §1.4), spec'd as
a type-level guarantee (S-4).

### 5.2 Nonce-guard state loss across restarts — **L, spec'd S-3**

`LocalStorageNonceGuard` persists in browsers; in Node the shared default guard
is memory-only, so a process restart forgets consumed commitments. The
commitment-then-reveal structure makes accidental reuse require *also* reusing
the same commitment package after restart, which the machine's one-attempt
disclosure makes unlikely but not impossible (a crashed coordinator replaying
its own stored commit package into a restarted process). Spec: persist the
guard in Node hosts (file-backed), or derive nonces from a persisted
`(secret, sessionHash)` HKDF — the deterministic-derivation alternative RFC
9591 §7.3 warns must not be share-only (bind the session hash and a persisted
counter, never the share alone).

## 6. `@vbyte/frost` 1.1.5 — verdict

> **Range caveat (round-16 review, finding B-2):** the versions below are the
> *audited lockfile state*, not what a fresh install resolves — `package.json`
> declares `^1.1.5` / `^2.2.0` / `^2.13.0` caret ranges. Exact-pinning the
> crypto-relevant deps (or a CI dependency-audit gate diffing `npm ls` against
> the audited versions) is registered as RS-5 (docs/REVIEW_SIMULATION.md);
> the "pin" language in this section should be read as "lockfile-pinned".

Repo: `cmdruid/frost` (MIT, ~43 commits; npm 1.1.4 under `@cmdcode/frost`, 1.1.5
under `@vbyte/frost`). Findings:

- **Protocol core is the real thing.** Binding factors, group commitment, and
  challenge match RFC 9591 §4.4–4.6 (verified by source reading above); H1/H2/H3
  use hash-to-field with distinct DSTs, H4/H5 are domain-tagged SHA-256; final
  verification delegates to noble's strict BIP-340 `schnorr.verify`. The
  Drijvers/Wagner class is addressed at the library level, and our
  machine/guard layer adds the RFC's recommended coordinator hedging.
- **No known CVEs or open security advisories** for `@vbyte/frost` /
  `@cmdcode/frost` (checked 2026-11-10). The CVE space that *does* exist for
  FROST implementations (ZF frost CVE-2025-58359, refresh/threshold) is
  neutralized by our own refresh design (§3.2).
- **Known sharp edges we already fence** (each pinned by a test):
  - `get_group_prefix`/`get_commits_prefix` sort the nonce array **in place** —
    `aggregatePublicNonce` copies first (`crypto.ts:252`).
  - Commitment packages carry secret nonces; `createRevealAndPartialSig`
    serializes only public fields (the 2026-08 leak-hardening comment).
  - `interpolate_x` throws on index-not-in-set / duplicate set (fail-closed).
  - The commitment-set/reveal-set equality constraint (§1.3) — now guarded in
    the session layer and pinned by tests.
- **Pin verdict: keep 1.1.5.** It is small enough to fully audit (we just did),
  matches the RFC structure, and the alternatives each cost more than they buy
  today: `@noble/curves/abstract/frost` (v2.4) is a newer, less battle-exposed
  API with no BIP-340 taproot tweak path wired, and ChillDKG/BIP-445
  implementations (the suite id `chilldkg-0.3+bip445-draft` in
  `courtSession.ts` is aspirational) are Rust-first drafts. Upgrade triggers to
  watch: (a) any published attack on the LDVR assumption underlying Crites et
  al.'s CRYPTO-2025 adaptive proof, (b) a ChillDKG 1.0/BIP-445 final spec (the
  existing suite slot anticipates it), (c) any change to noble's `schnorrVerify`
  strictness (our validators inherit it — the consensus argument in §4.1 assumes
  this exact behaviour; pin it in the upgrade checklist — and note finding B-4:
  the nostr-tools-nested noble copy must be re-probed on every nostr-tools
  bump, not just the direct dep), (d) any resolved-version change under the
  `^` ranges of finding B-2.

## 7. Security-argument skeleton (per invariant)

Each entry: the formal invariant (docs/FORMAL_INVARIANTS.md), the property, and
the literature anchor the paper's security chapter will cite. ✅ = argument
complete from this audit; 🔶 = argument exists, external dependency noted.

- **INV-X-1 (domain disjointness / canonical encoding)** ✅ —
  prefix-free CanonicalWriter grammar + pairwise-distinct `BAO-Court/*` domains
  ⇒ cross-domain aliasing requires a SHA-256 collision. Anchors: Krawczyk
  (HKDF, domain separation), BIP-340 tagged hashes. Exceptions are enumerated
  and injective-by-fixed-length (selection seed, F-7) or now canonical
  (PoK challenge, §2.3).
- **INV-VOTE-12/18 (commit-reveal binding, verdict hash)** ✅ — commit = H(domain
  ‖ len(outcome) ‖ outcome ‖ len(salt) ‖ salt); reveal accepted only if it
  recomputes; verdict hash binds (session, outcome, supporting ids) canonically.
  Anchors: Pedersen commitments; canonical tie-break determinism (INV-VOTE-16).
- **INV-SIGN-1..15 (signing machine)** ✅ — session hash binds
  (session, verdict, outcome, roster, threshold, attempt); nonce commitments
  before partials with set finality; one-commitment/one-partial per signer;
  cryptographic verification at the boundary. Anchors: FROST (KG20) §2.5 vs
  Drijvers et al. (S&P 2019); RFC 9591 §4.4/§7.3; ROAST (2022) for coordinator
  robustness; NCC ZF-FROST assessment (2023) for commitment-set membership.
- **INV-DKG (unanimity, PoK, refresh)** ✅ — rogue-key resistance via
  verified-before-use PoKs bound to (market, dispute, juror); share checks
  against Feldman commitments; complaint protocol with false-complaint
  slashing evidence; refresh preserves group key and threshold. Anchors:
  Pedersen (1991), Feldman (1987), GJKKS rogue-key, ChillDKG/BIP-445 draft
  (transcript certification — 🔶 our transcript hash is caller-opaque, S-2),
  CVE-2025-58359 as the refresh-threshold cautionary analogue.
- **INV-CONF (confirmation ladder, clawbacks)** ✅ (unchanged this round) —
  economic finality invariants referenced from the formal doc; this audit adds
  the v2 attestation binding (`buildAttestationMessageV2` tagged extensions)
  under the same INV-X-1 grammar.
- **Batch attestations (kind 39018)** ✅ — RFC-6962 unbalanced tree, domain-
  separated leaf/node/manifest, manifest signature over
  (epoch, cohort, batchIndex, count, root, finalizedAtSec); event-id
  recomputation binds the whole Nostr serialization. Anchors: RFC 6962;
  certificate-transparency inclusion-proof soundness. 🔶 the
  caller-pins-not-the-event property (group key pinning duty) is documented in
  the validator — the paper must state it as a trust assumption, not a
  mechanism.
- **Selection (jury randomness)** 🔶 — draw is publicly recomputable
  (`verifyJurySelection`); exponential-clock weights give P(win) ∝ weight
  (standard Poisson-process race result). Open anchor set: committee-selection
  grinding (S-1) and reputation-snapshot pinning — the two protocol-level
  assumptions the security chapter must carry explicitly.
- **Nonce hygiene (machine level)** ✅ — NonceGuard implements RFC 9591 §7.3's
  coordinator hedge; equivocation aborts with blame; consumption precedes
  signing (fail-closed). 🔶 Node-restart persistence (S-3).
- **Dependency surface** ✅ — `@noble/curves` 2.4.0 strict BIP-340 verifier
  (s ≥ n and s = 0 rejected, uniform across all verifiers); `@vbyte/frost`
  1.1.5 RFC-shaped core with no known CVEs; upgrade triggers listed in §6.

## 8. Finding index

| ID | Sev | Location | Literature | Disposition |
|---|---|---|---|---|
| A-1 | M | `independentSigning.canAggregate` / `signing.aggregateAttestation`; machine level: `courtSigningMachine` finalized signer set | RFC 9591 §5.2 (Lagrange over the signing set); NCC ZF-FROST 2023 | **Shipped** — equality guard + precise error + contract docs + tests; **exhaustively model-checked at the machine level** (`finalizedSignerSet` == distinct commitment set, partials ⊆ frozen set — every interleaving at n ≤ 3, incl. nonce/partial equivocation; `__tests__/modelChecking.test.ts` + `scripts/model-check.mjs`) |
| A-2 | M | `crypto.ts` PoK challenge | Krawczyk HKDF §3.1; INV-X-1/CW-2 (internal) | **Shipped** — canonical v2 challenge + `dkgPokDomain` + v1-compat verify + tests |
| A-3 | M | `dispute.deriveDisputeGroupPubkey` | BIP-340 tagged-hash rationale; hash-misbinding class | **Shipped** — fixed-width (64-char) + ≤512-char input validation (derivation unchanged) + tests |
| A-4 | M | `selection.ts` seed | Committee-selection grinding (Algorand VRF notes; multi-block beacons) | **Spec'd S-1** — anchored multi-block seed + pool/weight roots |
| A-5 | L | `courtDkgMachine.transcriptHash` | ChillDKG/BIP-445 ACert | **Spec'd S-2** — canonical transcript hash |
| A-6 | L | `signing.ts` Node guard persistence | RFC 9591 §7.3 | **Spec'd S-3** — persistent guard / session-bound derivation |
| A-7 | L | `crypto.seededScalar` scoping | RFC 9591 §7.3 (deterministic-nonce caveat) | **Spec'd S-4** — type-level brand separating demo-derivation from signing nonces |
| A-8 | OK | all 7 `schnorr.verify` sites; encoding regexes | BIP-340 §Design (s ≥ n malleability) | Verified — noble 2.4.0 strict, all sites guarded (§4.1) |
| A-9 | OK | FROST round ordering (`courtSigningMachine`) | FROST §2.5; RFC 9591; ROAST | Verified (§1.2) |
| A-10 | OK | refresh threshold invariance | CVE-2025-58359 analogue | Verified (§3.2) |
| A-11 | OK | `seededScalar` counter/bias | HKDF analysis | Verified (§5.1) |
| A-12 | OK | `@vbyte/frost` 1.1.5 pin | RFC 9591 conformance; CVE sweep | Keep pin; upgrade triggers in §6 |

## 9. Verification

- `npx vitest run` — full suite green (55 files, including the new
  `__tests__/cryptoLiteratureAudit.test.ts`, 9 tests).
- `npm run typecheck` — green.
- Empirical probes (recorded above, reproducible with the AUDIT tests):
  @vbyte/frost 1.1.5 subset-vs-commitment-set aggregation behaviour; noble
  2.4.0 `schnorrVerify` strictness; binding-factor message dependence.
