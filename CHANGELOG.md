# Changelog

All notable changes to `@bao/court` are documented here. This package ships
by git ref/tag (not npm) — see `AGENTS.md`. Breaking changes are flagged per
version with their consumer impact.

The version scheme: **patch** = bug fixes, **minor** = new modules/capabilities
or consumer-visible API changes. `1.0.0` stays reserved until the
trusted-dealer DKG is replaced with production Pedersen DKG and the API is
frozen.

## [0.10.1] — 2026-11-10

### Added (round-11 error-taxonomy unification — additive only, no behaviour change)

- **Unified error taxonomy (`errors.ts`):** every error thrown across the
  package boundary is now a `CourtError extends Error` carrying a
  machine-readable `code` (SCREAMING_SNAKE for new codes; the pre-existing
  per-class code unions keep their historical lowercase values) and — when
  the error enforces a documented invariant — an `invariant` field with the
  INV-* id from docs/FORMAL_INVARIANTS.md §15. Cause-chaining is supported
  everywhere via `CourtErrorOptions.cause` → `Error(message, { cause })`.
  Full class/code registry with invariant column: docs/FORMAL_INVARIANTS.md
  §15.
- **15 legacy classes grafted** onto `CourtError` (names, constructors, code
  values, and messages unchanged — `instanceof CourtError` is additionally
  true): `BatchAttestationError`, `CourtVoteTransitionError`,
  `CourtConfirmationTransitionError`, `CourtSigningTransitionError`,
  `CourtDkgTransitionError`, `CourtEpochCohortError`,
  `CourtSignerSetError`, `CourtSessionValidationError`,
  `CourtInboxError`, `CourtHostKeyError`, `CourtKeeperError`,
  `CourtCapabilityError`, `CourtOutboxError`, `CourtProtocolEventError`,
  `CourtRecoveryError`.
- **13 new domain classes** (base-constructor style
  `(code, message, options?)`): `CourtDkgError`, `IndependentDkgError`,
  `IndependentSigningError`, `FrostSigningError`, `CourtSelectionError`,
  `EscrowLedgerError`, `LnHoldLedgerError`, `LnRailError`,
  `LiquidEscrowError`, `TaprootSpendError`, `CourtCryptoError`,
  `CourtSignerError`, `AppealError`; plus the `CourtArgumentError`
  caller-bug base (argument-shape failures carry domain-prefixed codes,
  e.g. `DKG_ARGUMENT`, `TAPROOT_ARGUMENT`).
- **176 plain `throw new Error(...)` sites converted** across 19 modules —
  argument-shape failures to `CourtArgumentError`, protocol/ledger/state
  failures to the domain class. No plain `Error` throw remains in package
  sources (one internal throw-and-catch control-flow site in
  `courtProtocolEvents.ts` `parseContent` is typed too). Messages are
  byte-identical to pre-0.10.1 everywhere.
- **Boundary hardening found by the new suite:** `SeckeyCourtSigner`'s
  constructor decoded malformed hex strings before validation (raw
  decoder `Error` escaped); likewise `taprootSpend.ts` /
  `liquidEscrow.ts` decoded caller hex via the noble decoder before their
  length checks. All three now surface `CourtArgumentError` (with
  `cause` preserved) for malformed-but-typed inputs.
- **`invariant` traceability:** the base field is populated on selected
  enforcing sites (e.g. duplicate batch verdicts → `INV-BATCH-3`,
  selection pool sufficiency → `INV-SEL-6`); the registry table in
  docs/FORMAL_INVARIANTS.md §15.2 maps every class/code family to the
  invariants it enforces.
- **New test suite `__tests__/errorTaxonomy.test.ts` (19 tests):** full
  registry walk (30 classes extend the base, names survive, codes present,
  SCREAMING_SNAKE convention), cause-chaining, invariant field, and the
  boundary law — 15 malformed-but-typed public-API probes assert a typed
  `CourtError`, never a raw `TypeError`/decoder error.
  `invariantAssertions.test.ts` INV-X-2 extended: machine error classes must
  extend `CourtError` and carry a code. **Consumer impact: additive only** —
  existing catch sites (`instanceof`, message, name, legacy `code` values)
  are unaffected.

## [0.10.0] — 2026-11-10

### Added (round-9 performance optimization — no byte output or behaviour changes)

- **`buildBatchMerkleProofs(leaves): BatchMerkleProof[]` (batch-attestation module):**
  full proof-set generation in O(n) node hashes + O(n log n) path slots,
  versus ~O(n²) node hashes for per-leaf `buildBatchMerkleProof` calls
  (each call re-hashes O(n) sibling-subtree nodes; the full set re-hashes
  the same subtrees ~log n times over). The RFC-6962 split recursion visits
  exactly 2n−1 distinct subtrees; hashing the tree once into a node table
  lets every proof read its O(log n) siblings from the table, with path
  entries SHARING the table's string objects (memory: O(n) retained hash
  material, not O(n log n) fresh strings). Output is IDENTICAL — same
  index/verdictHash/path per leaf as the single-proof API — pinned by the
  differential-parity suite (every proof verified under the independent
  reference verifier for n = 1..128, 333, 1000). The single-proof API is
  unchanged. **Consumer impact: additive only** — new export, existing
  exports byte-compatible.
- New benchmarks: `buildBatchMerkleProofs` (full set, n = 10/100/1k/10k) and
  `reduceCourtSigningMachine` (10k legal transitions, roster=threshold=21 —
  the heaviest invariant-checking case), added to `bench/court.bench.mjs`
  and `docs/benchmarks/BASELINE.md`.

### Changed (performance — measured, byte-output-identical)

- **CanonicalWriter — pre-sized growable buffer** replaces the per-field
  chunk array + finish-time concat: one amortized buffer, in-place writes,
  a shared DataView, and a hi/lo split replacing the `BigInt` u64 conversion.
  Byte output identical (differential-parity pinned: byte-identity on 300
  random sequences + boundary + round-trip + fail-closed ranges).
  `canonicalWriter.encodeHash` at 1k field groups: 6.46 ms → 1.48 ms (4.4×;
  5.50 → 1.44 ms on the noise-floor `min`; paired numbers in BASELINE.md).
- **`isValidSecp256k1Point` — bounded validity memo** (cap 8192, clear-on-
  full): point validity is a pure mathematical function of the encoding
  string, so the memo is semantically transparent; it is module-private
  (never enumerable on machine state, never serialized) per the
  verified-verdict cache lesson. This removes the signing machine's dominant
  per-reduce cost — the reducer re-validates EVERY stored nonce commitment
  (2 `Point.fromHex` decodes ≈ 88 µs each on this host class) on EVERY
  transition. `reduceCourtSigningMachine` at roster=threshold=21:
  3340 µs → 110 µs per transition (**30×**; paired numbers in BASELINE.md).
- **Selection hot path** (`selection.ts`): `bytesFromHex` lookup-table decode
  (byte-identical, same accept/reject set); `jurorRandomValue` single
  pre-sized concat instead of two array spreads; `scoreAndSort` ranks light
  `{juror, priority}` records and materializes `SelectedJuror` objects only
  for the selected top-k (previously two full object spreads per juror plus
  idx assignment over the whole pool). Same comparator, same draws, same
  ranking — exact parity verified against the pre-change algorithm across
  randomized rosters, and by the differential-parity end-to-end ranking pin.
  `selectJury` at roster=10k: 88.5 ms → 32.5 ms (**2.7×**; 77.8 → 30.1 ms on
  `min`; paired numbers in BASELINE.md).

### Refused (measured, not worth the risk/complexity — see BASELINE.md round-9 findings)

- **Heap-based O(n log k) top-k jury selection:** 27× on the ranking step
  alone (4.0 ms → 0.148 ms, top-k parity confirmed) but only ~1.12×
  end-to-end at roster=10k — the sha256 draws dominate; below the ≥2× bar.
- **Cross-call CanonicalWriter buffer pooling:** the per-instance pre-sized
  buffer already captures the win; shared mutable scratch state on a
  security-critical encoding primitive for no measured additional benefit.
- **Memoizing `assertSigningRecordInvariants` on state hash:** couples a
  cache to the restored-snapshot corruption class the check exists to catch;
  the point memo captures ~95% of the win. Spec (WeakMap keyed by the frozen
  state object) recorded in BASELINE.md.

## [0.9.4] — 2026-11-10

### Fixed (round-8 adversarial-nostr round — hostile relay data)

- **`appealWatcher` — resolution outcome binding:** `handleEvent` read the
  reported outcome from the single-letter `o` tag BEFORE the validated
  `outcome` tag. The `o` tag is not part of any kind-39007 builder's tag set,
  so a hostile re-publisher of a valid attestation could append an extra
  `['o', <anything>]` tag and steer the reported resolution outcome away from
  the FROST-certified one (the event's own Schnorr signature only proves the
  untrusted publisher signed it). The resolution now carries
  `validation.outcome` — uniqueTag-checked, content-mirrored, and bound into
  the signed attestation message. **Consumer impact: none for honest
  events** (builders never emit `o` on 39007); hostile alias tags can no
  longer steer resolutions.
- **`courtInbox` — dedupe-key integrity:** `ingest` accepted any shape-valid
  64-hex wrap id without verifying the NIP-01 id commitment. A hostile relay
  could serve a same-id different-content wrap that (a) poisoned the stored
  record when it won the delivery race, or (b) deduped the real wrap away on
  redelivery — drain permanently drops junk, so the message was lost either
  way. `ingest` now recomputes the event hash and rejects non-committing ids
  as `malformed`. **Consumer impact: none** — every real wrap id commits by
  construction (`finalizeEvent`); hand-crafted test wraps must derive ids via
  `getEventHash`.
- New adversarial suite `__tests__/adversarialNostr.test.ts`: kind confusion
  (filter drift), tag abuse (duplicates/nesting/empty/100k-mention-tags/
  MB-scale values), NIP-59 seal games (self-wrapped seals, cross-session
  replay, algorithm confusion), inbox flooding (dedupe-key poisoning,
  capacity fail-closed, provenance), watcher outcome binding.



### Fixed (round-7 cryptographic literature audit — docs/CRYPTO_AUDIT.md)

- **`crypto` — DKG proof-of-knowledge challenge encoding (A-2):** the PoK
  challenge was a delimiter-joined string (`prefix|pk|nonce|domain`) whose
  `domain` (`market=…|dispute=…|juror=…`) is attacker-influenced and contains
  the separators — tuples like (market `"x"`, dispute `"y|dispute=z"`) and
  (market `"x|dispute=y"`, dispute `"z"`) rendered identically, aliasing a
  proof across DKG ceremony bindings. The challenge is now CanonicalWriter
  length-prefixed under `bao-frost-court/dkg-pok-challenge-v2`, and the
  domain itself is canonical: new export `dkgPokDomain(marketId, disputeId,
  jurorIdx)` (hex of the length-prefixed tuple), used by both
  `PedersenDkgAdapter.proofDomain` and `IndependentDkgSession`.
  `verifyProofOfKnowledge` accepts v2 (created) and — one documented
  mixed-fleet rollout window — the legacy v1 encoding. **Consumer impact:
  none** within a single-version fleet; mixed-version DKG attempts fail
  closed at the PoK check (attempt restarts, no state corruption).
- **`dispute` — `deriveDisputeGroupPubkey` concat boundary (A-3):** the raw
  `groupPubkey ‖ disputeId` digest input had no fixed-width contract, so
  (pk, disputeId) pairs could alias when a caller passed a short pubkey.
  Creation now enforces exactly-64-char group pubkey and a non-empty ≤512-char
  dispute id; **the digest formula is unchanged** — every previously derived
  key that satisfied the (now explicit) width contract derives identically.
- **`independentSigning` — commitment-set/reveal-set equality guard (A-1):**
  empirically verified for `@vbyte/frost` 1.1.5: FROST Lagrange coefficients
  are indexed by the FULL commitment list, so aggregating threshold reveals
  over a larger commitment set yields a final signature that fails
  `verify_final_sig` (fail-closed liveness trap — every committed-but-silent
  juror burned a nonce commitment per attempt with no diagnostic).
  `canAggregate()` now requires the reveal set to EQUAL the commitment set
  and `aggregate()` throws a precise reason
  (`reveal set must equal the commitment set`). Full-coverage flows are
  unchanged (pinned by new tests, including the fail-early subset case).
  `aggregateAttestation` documents the same contract for direct callers.

### Added

- **`docs/CRYPTO_AUDIT.md`** — the round-7 cryptographic literature audit:
  per-finding literature anchors (FROST/Drijvers, RFC 9591, Crites et al.
  CRYPTO 2025 / ms-FROST 2025, ChillDKG/BIP-445, CVE-2025-58359, RFC 6962),
  code locations, exploitability sketches, and the security-argument
  skeleton (§7) the paper's security chapter builds on. Verdict: keep the
  `@vbyte/frost` 1.1.5 pin, with documented upgrade triggers.
- **Tests:** `__tests__/cryptoLiteratureAudit.test.ts` (9 tests) — PoK
  round-trip/cross-domain/legacy-v1 acceptance, PoK domain tuple
  distinctness, `deriveDisputeGroupPubkey` boundary validation, the
  full-coverage independent signing aggregation, and the library
  binding-factor message-dependence pin (anti-Drijvers property cannot
  silently regress in a dependency upgrade).

## [0.9.2] — 2026-11-10

### Fixed (formal-audit findings F-12, F-2, F-3)

- **`courtSigningMachine` + `courtDkgMachine` — F-12 (state-shape change,
  minor-compat):** both machines now keep the monotonic clock ledger the
  vote/confirmation machines already had: `latestTimestamp` in state, and
  every time-bearing event must satisfy `now ≥ latestTimestamp` (typed
  rejection: `now must not precede a previously observed timestamp`).
  `abort` carries no clock and leaves the ledger unchanged; tick and
  terminal semantics are unchanged (a terminal tick stays phase-preserving
  and may only advance the clock). Old-timestamped replays into a restored
  signing/DKG snapshot are no longer admissible.
  **Restore semantics (additive field):** v0.9.1 snapshots without
  `latestTimestamp` initialize it to `0` on restore — the first
  time-bearing event writes it, and pre-upgrade replay sequences keep
  working (they can only be rejected if they genuinely roll the clock
  backwards). The two idempotent-redelivery paths in the signing machine
  now return the clock-advanced state frozen (freeze discipline preserved).
- **`validator` + `batchAttestation` — F-2:** a present-but-empty
  `expectedGroupPubkey` pin (`''`) is now INVALID — the v1 validator, the
  v2 validator, `validateCourtAttestation`, and
  `validateBatchAttestationEvent` all answer typed-invalid
  (`expectedGroupPubkey pin must be a non-empty group pubkey`) instead of
  silently disabling the pin. A pin must be a real pubkey or absent; the
  absent case behaves exactly as before.
- **`courtConfirmationMachine` — F-3:** the append-only `outcomeHistory` is
  now barrier-verified before it locks value in: a new
  `assertValidOutcomeHistory` runs at `resolve_round` (which steers
  `round_flip` clawbacks from `previous.winnerIndices`) and at `finalize`.
  The barrier enforces the consecutive 1..k round sequence, ballot closure
  of every recorded outcome, unique well-formed `winnerEventIds`, and
  unique valid `winnerIndices` — a hand-restored snapshot with a forged
  history can no longer direct clawbacks at arbitrary indices.

### Added

- **Exports:** `weightedPriority` is now exported from the package root
  (it was reachable only via the `./selection` subpath — the juror-kit
  weight-mode verification needs it from the vendored-visible surface).
  `IndependentDkgSession` / `IndependentSigningSession` and their state
  types (`IndependentDkgState`, `IndependentSigningState`,
  `IndependentSigningSnapshot`) were verified present on the root surface.

## [0.9.1] — 2026-11-09

### Fixed (round-3 property-sweep findings)
- **`courtConfirmationMachine` — r3-1:** `finalize` over a restored EMPTY
  confirmation ledger used to escape the vote machine's FOREIGN
  `CourtVoteTransitionError` (empty `supportingEventIds` reached
  `hashCourtVerdict`). Finalize now fails closed with the machine's own
  typed `CourtConfirmationTransitionError` when the verdict would carry zero
  supporting event ids. Unreachable on live paths — `close_confirmations`
  enforces the quorum (unchallenged cases) and `resolve_round` refuses an
  empty vote ledger (challenged cases) — the guard protects the
  restore/replay path.
- **`batchAttestation` — r3-2:** `verifyCaseInBatch` escaped a raw
  `TypeError` for a tags-less event once the proof leaf matched. The event
  shape (`tags` array) is now validated BEFORE leaf work, answering the
  module's typed `{ valid: false, reason: 'malformed event' }` — identical
  to `validateBatchAttestationEvent`'s guard. Malformed call arguments
  (proof path/index) still throw the typed `BatchAttestationError` as before.
- **`validator` — r3-3:** `validateCourtAttestation` dereferenced
  `event.tags` unguarded in the v1/v2 shape dispatch, crashing with a raw
  `TypeError` on malformed events. Now guarded: a tags-less event answers
  the typed `{ valid: false, error: 'Malformed event: tags must be an
  array' }`.
- **`courtConfirmationMachine` — r3-6 (design bug):** a challenged case on a
  2-member case roster could NEVER resolve: the ladder round panel defaults
  to the case roster, but the close/resolve ledger barrier demands ≥ 3
  round-panel members — a mid-ladder dead end. Chosen fix: **fail closed at
  creation** — `createCourtConfirmationMachine` now rejects a
  `participantIndices` roster with fewer than 3 members (typed
  `CourtConfirmationTransitionError`, `confirmation roster must contain at
  least 3 participants`). This is the cleanest consistent rule: the
  confirmation-quorum and round-panel semantics presuppose a panel. One
  pre-existing test (`adversarialMachines.test.ts` quorum-shortfall case)
  was updated from a 2-member to a 3-member roster; no API consumer change
  beyond the stricter creation guard.
- **`validator` — r3-5:** `hashSignerSetRoot` threw a plain `Error`; it now
  throws the new typed **`CourtSignerSetError`** (exported from the package
  root; error messages byte-identical to the previous text).
- **`validator` — r3-4 (observation, documentation only):** documented the
  nostr-tools `verifyEvent` verdict-cache semantics on
  `validateAttestationEvent` (cache lives under a Symbol-keyed property,
  derived state only; object-spread clones never carry it and re-verify
  from scratch — in-place mutation of a verified event is the residual
  hazard). No behaviour change.

## [0.9.0] — 2026-11-09

### Added (multi-round ladder escalation, universal-confirmation proposal §4.2)
- **`courtConfirmationMachine` ladder is now multi-round.** Round panels grow
  host-side (reference sizes r1=15, r2=45, r3=135 — FROST-subset selection is
  host policy; the machine tracks rounds + votes). `createCourtConfirmationMachine`
  gains `maxLadderRounds` (default 2, bounded 1..5).
- **New phase `round_resolved`** — after a round resolves with rounds
  remaining, the case parks there for an explicit host decision: new events
  `escalate` (→ `ladder_pending`, next round) or `concede` (→
  `fee_settlement`, current outcome final). The machine never auto-escalates.
  Resolving round `maxLadderRounds` proceeds to `fee_settlement` directly.
- **Per-round roster expansion** — `open_ladder_round` accepts an optional
  `roundRoster` (sequential indices 1..N, N ≥ 3, N ≤ 10 000; superset of the
  previous round NOT required). Mass votes validate against the ROUND panel;
  round rosters re-verify at the close/resolve ledger barrier.
- **Flip-flop clawback rule** — when round r's winner differs from round
  r-1's winner, round r-1's majority voters are flagged with reason
  `round_flip` (round = r-1). Flag accounting stays append-only and
  idempotent: `overturned_confirmation` flags fire once (no duplicates on
  repeated overturns), `round_flip` dedupes per (idx, reason, round).
- **`outcomeHistory`** — append-only frozen `{round, outcome,
  winnerEventIds, winnerIndices}[]` for host-side reputation scoring
  (final-round weight 1.0, earlier 0.5 — scoring is host policy). Finality:
  the verdict is the LAST resolved round's winner, backed by that round's
  winning-vote event ids (confirmation ids when never challenged).
- **Compatibility:** the v0.8.5 single-round flow is preserved via
  `maxLadderRounds: 1` (resolve → `fee_settlement` directly) and produces
  verdict-identical results to the default-cap flow with an explicit
  `concede`. Consumers driving the default cap must now play
  `concede`/`escalate` after each non-final round resolution.
- Suite: 1314 passed / 1 skipped (adds `__tests__/multiRoundLadder.test.ts`).

## [0.8.5] — 2026-11-09

### Fixed (round-2 cross-module adversarial audit, PR #41)
- **`AttestationV2ValidationContext` gained `expectedBatchMerkleRoot`** — the
  v2 `batch` tag carried only the Merkle root with no way to pin it; a stale
  epoch's batch attestation could satisfy epoch policy via the epoch pin
  alone. Now pinnable fail-closed (and in `V2_ONLY_POLICY_FIELDS`, refused on
  v1-shaped downgrades).
- **Confirmation/challenge ledgers re-verified after snapshot restore** —
  `assertValidConfirmationLedger` (canonical confirmHash recomputation,
  roster/hex/uniqueness) runs at `resolve_round` + `finalize`; a restored
  snapshot could previously carry edited confirmations into finalization.
- **Docstring hardening:** loud MUST-pin-`expectedGroupPubkey` warnings on
  `validateAttestationEventV2` / `validateCourtAttestation` / batch context —
  unpinned consumers accept any valid signature (documented trust boundary).
- Documented by-design: same `verdictHash` in two epoch batches is valid —
  reputation derivation MUST dedupe by verdict hash; cross-round vote leakage
  impossible (barrier).
- Suite: 1259 passed / 1 skipped.

## [0.8.4] — 2026-11-09

### Fixed
- **Consumer-typelib compat:** `Object.hasOwn` (ES2022) in the adversarial
  suite breaks typecheck under consumers whose `lib` target predates
  es2022 (bao.markets build-config typecheck) — replaced with
  `Object.prototype.hasOwnProperty.call`. Source-distributed packages must
  stay within the consumer lib baseline.

## [0.8.3] — 2026-11-09

### Fixed (round-1 adversarial machine fuzz, PR #37)
- **Canonicalization bypass:** lone surrogates encoded identically to their
  U+FFFD replacement — two distinct outcomes hashed identically while the
  tally counted separate buckets (order-dependent majorities). All four
  machines now reject non-canonical UTF-8 (`isCanonicalUtf8Text` round-trip
  check) at creation and in every hash helper; the dead surrogate-only fatal
  decoder is replaced by the round-trip gate.
- **State-shape tampering:** null/string rosters crashed uncaught; string
  allowlists admitted substring outcomes past the ledger barrier
  (`'YES'.includes('Y')`). `assertStateArrays` + roster array guard at every
  reducer entry.
- **Signing binding re-verification:** restored snapshots could edit
  outcome/threshold/roster post-hoc (below-threshold aggregates) — the
  signing-session hash is now re-derived on every dispatch.
- **Freeze discipline:** signing/DKG machines now freeze returned states
  (uniform with vote/confirmation).
- **Unknown event types:** reducers throw typed errors instead of returning
  unfrozen clock-advanced copies.
- Reported-not-fixed (owner decisions): cross-index eventId reuse wedges
  resolution fail-closed until tick-expiry; `abort.reason` unbounded.
- Suite: 1206 passed / 1 skipped (+404 adversarial tests).

## [0.8.2] — 2026-11-09

### Fixed
- **Security round 1 (validator/finality adversarial audit).** Three real
  findings, all fixed in v2 paths + the dispatcher only; the frozen v1
  validator is byte-compatible for legacy events (validated by
  `__tests__/validator.test.ts`).
  - **F3 (high) — v2 scope pins silently dropped.**
    `validateAttestationEventV2` declared `expectedMarketId`,
    `expectedDisputeEventId`, and `allowedOutcomes` on its context but never
    enforced them: an attestation for the wrong market, a foreign dispute,
    or a non-allowed outcome validated under v2. All three are now enforced
    exactly as in the frozen v1 path.
  - **F1 (medium) — dispatcher policy downgrade.**
    `validateCourtAttestation` routed a v1-shaped event (no `epoch` tag) to
    the frozen v1 validator while silently IGNORING v2-only finality policy
    (`expectedEpoch` / `minTier` / `minThreshold` / `expectedSignerSetRoot`
    / `signerSet`) — a stale v1 attestation could satisfy policy it never
    met. The dispatcher now fails closed when v2 policy is requested for a
    v1-shaped event.
  - **F2 (low) — unbounded v2 field lengths.** v2 validators now bound
    `marketId` (1024 UTF-8 bytes), `outcome` (256, mirrors the vote
    machine's `MAX_OUTCOME_BYTES`), and `round` (64) before hashing, so a
    hostile relay cannot force megabyte-scale hash inputs. v1 keeps its
    frozen unbounded behaviour (documented).
- Verified-hard (no change needed): epoch-tag downgrade of a v2 event to the
  v1 validator is structurally impossible (v1 recomputes a different domain
  digest); noble `schnorr.verify` rejects malleable `s ≥ n`, `s = 0`, and
  non-curve pubkeys; `hashSignerSetRoot` rejects unsorted-free duplicates,
  non-positive, fractional, NaN, and >2³² indices (no truncation collisions —
  `CanonicalWriter.u32` throws); the vote-machine tie-break uses
  `compareOutcomeUtf8` (UTF-8 byte order) where JS UTF-16 order diverges;
  NFC/NFD outcomes are distinct with no aliasing. Repro suite:
  `__tests__/attestationValidator.adversarial.test.ts` (30 cases).

## [0.8.1] — 2026-11-09

### Added
- **v2 attestation validation with in-band finality binding
  (`validator.ts`).** `hashSignerSetRoot` (canonical sorted-index commitment
  under `BAO-Court/SignerSet/v1`), `validateAttestationEventV2` (requires
  epoch/tier/threshold/signers tags mirrored in content; recomputes the v2
  signed message via `buildAttestationMessageV2`; dispute attestations
  recompute the verdict hash exactly as the frozen v1 path; finality-policy
  pins: expected epoch, minimum tier/threshold, signer-set root, full
  signer-set verification with `length === threshold`), and
  `validateCourtAttestation` (dispatcher: `epoch` tag → v2, else frozen v1).
  Closes the round-0-attestation-replayed-as-final gap end to end.

## [0.8.0] — 2026-11-08

### Added
- **Universal confirmation case machine (`courtConfirmationMachine.ts`).**
  Pure fail-closed reducer for the confirm/challenge lifecycle: public
  juror confirmations (`hashCourtConfirmation` binds session + proposal +
  roster index), a bond-witnessed challenge window, one mass-vote ladder
  round resolved by majority (vote-machine tie-break semantics), automatic
  `overturned_confirmation` clawback flags when a proposal is overturned,
  a fee ledger, explicit clawback flags during fee settlement, and a final
  verdict whose hash reuses `hashCourtVerdict` so kind-89 attestations can
  reference it unchanged. Multi-round escalation is future work (documented
  in-module).
- **Merkle-batched attestations (`batchAttestation.ts`, kind 39018).**
  RFC-6962-style domain-separated tree over `hashCourtVerdict` leaves
  (`BAO-Court/BatchLeaf/v1` / `BatchNode/v1`), sorted-leaf determinism with
  duplicate rejection, unbalanced-split shape stability, inclusion proofs,
  `hashBatchManifest` under `BAO-Court/BatchManifest/v1`, event builder +
  fail-closed validator + per-case `verifyCaseInBatch` — one threshold
  signature now covers a whole epoch batch of verdicts.
- **Zero-stake reputation-weighted selection (`selection.ts`).** Optional
  `weightFn` (pure, deterministic, fail-closed validation) and
  `zeroStakeAllowed` gate-waiver; default draw path byte-identical;
  `verifyJurySelection` round-trips both modes. Phase-0 vetted juror pools
  no longer require stake.

## [0.7.2] — 2026-09-30

### Fixed
- **Liquid CLTV refunds pay the funder, with minimal tapscript locktimes.**
  `buildTaprootLeaves` takes a required `funderXOnly` and the refund leaf is
  `<locktime> OP_CLTV OP_DROP <funder> OP_CHECKSIG` — the depositor's key,
  never the oracle's (previously the oracle could reclaim a refunded bond).
  `locktimeToPush` now emits the MINIMAL signed script-number push required
  by BIP-342 (trailing 0x00 bytes are rejected; a high-bit 4-byte value gets
  the positive 5-byte form), so OP_CLTV accepts the argument at spend time.
  Taproot vectors regenerated (leaf lengths, merkle roots, output keys,
  addresses, control-block parity).
- **LN hold settlement binds every hold to its plan.** `planDecisionsForHolds`
  rejects (throws) a hold whose payment hash does not match its own witness or
  whose amount does not match the plan stake, leaves holds from another
  dispute/round unsettled, and matches bond holds by `plan.disputerPubkey` —
  a foreign "disputer" hold can no longer inherit this plan's bond outcome.
- **Bond admission verifies ownership against the court-derived script.**
  `bondScriptXOnlyPubkey` / `verifyBondOwnershipForScript` bind a candidacy's
  signed challenge (txid/vout/dispute/candidate + nonce) to the P2PK/P2TR
  bond script. The coordinator requires `expectedStakeScriptPubKey` whenever a
  bond verifier is wired, enforces `requireBondOwnership` (default true), one
  locked UTXO per candidacy per dispute, and takes selection weight from the
  VERIFIED stake amount. `verifyBond` fails closed when given an
  `expectedAddress` without a derived `expectedScriptPubKey`.
- **Candidacies carry an optional bond-ownership proof.** Kind 39001 parsing
  reads `ownershipNonce` / `ownershipSig` tags into
  `StakeCommitment.ownershipProof` (`BondOwnershipProof`).

### Breaking
- `TaprootEscrowParams` gains required `funderXOnly`.
- `FrostAppealCoordinatorConfig` gains `expectedStakeScriptPubKey` and
  `requireBondOwnership`. With a `bondVerifier` wired, admission now also
  requires the court-derived script and (by default) an ownership proof; the
  weight used for selection comes from the verified UTXO amount.
- `FrostAppealCoordinatorConfig.verifyStakeCommitment` stays a boolean hook.

## [0.7.1] — 2026-09-26

### Fixed
- **DKG shares are bound to the NIP-59 envelope author.**
  `parseEncryptedShareEvent` / `parseEncryptedRefreshShareEvent` now take the
  sender from the signed envelope author (`event.pubkey`) and reject events
  with no author or with a `from` tag/content pubkey that disagrees with it —
  a forged share claiming an honest juror's roster pubkey is no longer
  re-attributed to that juror (it is rejected). `IndependentDkgSession`
  `addEncryptedShare` / `addEncryptedRefreshShare` take the envelope author as
  an optional second argument and require `payload.fromPubkey` (and the
  author, when provided) to equal the roster pubkey for `fromIdx`.
- **The appeal coordinator tallies only signed commit/reveal events.**
  `vote_commit` collects signature-verified Kind 39004 commits authored by a
  selected juror for this dispute (conflicting commits from one juror →
  reselection), and `vote_reveal` counts only signature-verified Kind 39014
  reveals whose `hashCommit(outcome, salt)` matches that juror's signed
  commit. The verdict is never fabricated from the challenger's
  `proposedOutcome`; a tally with no valid reveal triggers reselection instead
  of attesting an empty outcome. The former self-contained flow stays behind
  the explicit, test-only `simulateVotes` config switch (defaults to
  `environment === 'test'`); `vote_commits_collected` / `vote_reveals_collected`
  payloads carry `simulated`.
- **Appeal settlement requires a pinned group key.** `settleAppeal` fails
  closed (`unpinned_group_key`) for an attestation under a group key that is
  neither the appeal's local `dkgRecord.groupPubkeyXOnly` nor an explicitly
  allow-listed `empaneledGroupKeys` entry — an injected appeal can no longer
  settle under a self-chosen key.

### Breaking
- `FrostAppealCoordinatorConfig` gains `simulateVotes` and
  `empaneledGroupKeys` (both optional, no signature changes). Behaviour
  changes by design: outside `environment: 'test'` the coordinator now
  collects signed Kind 39004/39014 events instead of fabricating votes from
  the challenger's claim, and externally-attested appeals with no local DKG
  record must list the empaneled group key(s). Test-environment hosts keep
  the simulated flow unless they pass `simulateVotes: false`.

## [0.7.0] — 2026-08-27

### Added
- **M3 pairwise dual-refund WS-A tree leaves** (SMJ-MATCHING-ENGINE-PLAN.md
  §M3, user-vs-user matched pairs):
  - `buildPairwiseCoopLeaf(pkA, pkB)` — strict **2-of-2** coop leaf
    `<pkA> OP_CHECKSIG <pkB> OP_CHECKSIGADD OP_2 OP_EQUAL` (`20<pkA>ac20<pkB>ba5287`).
    Deliberately stricter than the WS-E `buildCoopStakeLeaf` shape (`… ba`,
    which tapscript evaluates as 1-of-2 — acceptable there because the server
    enforces the sponsor signature, but a theft vector user-vs-user where the
    refusing loser could claim both UTXOs). Witness order `[sigB, sigA, leaf,
    control]` matches WS-E's `[operatorSig, sponsorSig, …]` assembly.
  - `buildDualRefundLeaves(pkA, pkB, refundLocktime)` — `[REFUND-A, REFUND-B]`
    mirroring `buildWsARefundLeaf` per participant, so each user can pull back
    only their OWN side after close+Δ.
  - Frozen 3-leaf vectors (§8.1 style): leaf scripts, tapleaf hashes, split-
    at-half merkle root, output key / signet address, and all three control
    blocks, plus a minimal tapscript interpreter test proving the strict
    2-of-2 semantics (both sigs required; one sig fails; the WS-E 1-of-2
    shape demonstrably passes with one).

### Fixed
- **`taprootMerklePath` emitted siblings in root→leaf order (latent
  consensus bug for >2-leaf trees).** BIP-341 folds a control-block path in
  leaf→root order; the implementation accumulated top-down, so any leaf whose
  path had ≥2 siblings produced a control block that did not re-derive
  `tapMerkleRoot` (consensus-invalid). Every shipped consumer — WS-A and WS-E
  two-leaf trees and the live spend proof — was order-invariant and therefore
  unaffected; the bug was found while drafting the 3-leaf pairwise tree and
  is regression-guarded by the fold-back assertions in the new vectors.

## [0.6.3] — 2026-08-25

**⚠️ ALL TREE/TWEAK-DERIVED VALUES CHANGE vs ≤ 0.6.2 — READ BEFORE UPGRADING.**
Elements consensus tags the taproot hashes `TapLeaf/elements`,
`TapBranch/elements`, and `TapTweak/elements` (Elements
`src/script/interpreter.cpp` HASHER_TAPLEAF/TAPBRANCH_ELEMENTS,
`src/pubkeys.cpp` HASHER_TAPTWEAK_ELEMENTS). v0.6.2 (and earlier) used
Bitcoin's plain BIP-341 tags: every merkle root, tapleaf hash, output key /
taproot program, taproot address, output-key parity bit, and control block
derived by those versions is **invalid on any Elements chain** — script-path spends fail with `mempool-script-verify-flag-failed (Witness program hash
mismatch)`. No production consumers exist yet (verified 2026-08-25), so the
correction is a patch bump; API shape is unchanged.

### Fixed
- **Tagged-hash domains + Tapscript leaf version (consensus blockers).**
  `liquidEscrow.ts` (`tapMerkleRoot`, `taprootProgram`) and `taprootSpend.ts`
  (`tapleafHash`, `branchHash`, `outputKeyParity`, `TAPROOT_LEAF_VERSION`,
  `TAPROOT_CONTROL_BASE`) now derive under the `/elements` tags AND the
  Elements Tapscript leaf version **0xc4** (Elements interpreter.h
  TAPROOT_LEAF_TAPSCRIPT — Bitcoin's BIP-342 value is 0xc0, which elementsd
  rejects with "Taproot version reserved for soft-fork upgrades"). The two
  bugs surfaced as distinct consensus rejections during live testing: wrong
  tags → "Witness program hash mismatch"; right tags + 0xc0 → upgradable-
  version rejection. The sighash tag (`TapSighash/elements`) was already
  correct in v0.6.x (its known-answer test digest moved only because the
  tapleaf hash inside the preimage changed). Proven against Elements Core sources
  and a live elementsregtest chain: a hand-built WS-A cooperative script-path
  spend (funded from the faucet, broadcast via `sendrawtransaction`) is
  accepted by consensus and confirms on-chain only with these tags — the new
  live test `__tests__/taprootSpend-live.test.ts` encodes that end-to-end §8.6
  proof (env-gated: `BAO_LIVE_TAPROOT=true` + esplora + ssh targets).
- **Live test actually exercises consensus.** The previous live test "spent"
  via a second wallet send; the witness never touched validation. It now:
  derives a fresh trader keypair, builds the production two-leaf tree, funds
  the NUMS-taproot address, locates the UTXO by scriptPubKey, hand-serializes
  the Elements transaction (single flags byte, witness-at-end layout, explicit
  asset/value commitments with WIRE byte order — asset ids are reversed
  uint256s like txids — explicit policy-asset fee output last), signs the COOP
  leaf under SIGHASH_DEFAULT, broadcasts, mines, and verifies the confirmed
  spend consumed our UTXO with our exact witness stack.

### Changed
- Regenerated pinned vectors under the corrected domains (§8.1 roots/keys/
  addresses/control blocks, BIP-341 official-vector inputs, 3-leaf tree-shape
  root); added a literal-tag regression guard suite ("Elements tagged-hash
  domains") plus independent numeric parity cross-checks. Bitcoin-domain
  originals are preserved as comments for provenance.

## [0.6.2] — 2026-08-24

Consensus-correctness release for `./taproot-spend`: three independent
BIP-341/Elements bugs fixed. **Consumer-visible signature changes** in
`controlBlock` / `scriptPathControlBlock` — see *Changed* below.

### Fixed
- **Control-block parity (consensus blocker).** The script-path control
  block's low bit is the Y-parity of the OUTPUT key
  Q = lift_x(P) + tagged_hash("TapTweak", P ‖ root)·G per BIP-341 — not a
  property of the internal key. v0.6.0 defaulted it to 0, producing
  consensus-invalid control blocks for every output whose Q has odd Y (~50%:
  proven numerically on the §8.1 vectors). Parity is now derived from
  `(internalKey, merkleRoot)` via the new `outputKeyParity` export and cannot
  be mis-stated; `finalizeTaproot` now rejects control blocks whose parity
  bit contradicts the recomputed output key (the old x-only output-key check
  could not catch this).
- **Genesis byte order in the Elements sighash.**
  `LIQUID_MAINNET_GENESIS` / `LIQUID_TESTNET_GENESIS` are documented as
  uint256 INTERNAL byte order (Elements Core seeds
  `HASHER_TAPSIGHASH_ELEMENTS` with the raw genesis uint256 twice), but the
  values shipped were the well-known DISPLAY hex — every sighash preimage got
  reversed bytes. The constants now hold true internal order, derived from
  their display forms (`reverseHex`) so the two orders cannot be mixed up
  again. Verified against Elements Core `src/script/interpreter.cpp`,
  `src/uint256.h` serialization, the `kernel/chainparams.cpp` mainnet genesis
  assert, and the live Liquid / liquidtestnet Esplora APIs (height 0).
- **`finalizeTaproot` hash_type witness form.** A non-default `hashType`
  silently produced a bare 64-byte signature element; BIP-341/Elements
  require the hash_type byte appended (65-byte element,
  `CheckSchnorrSignature`). SIGHASH_DEFAULT keeps the 64-byte form.

### Changed (consumer-visible)
- `controlBlock(internalKeyXOnly, merklePath)` →
  `controlBlock(internalKeyXOnly, merklePath, merkleRoot)`: the third
  parameter is now the merkle ROOT the parity is derived from (was a manual
  `parity: 0|1` defaulting to 0 — the bug above).
- `scriptPathControlBlock(internalKeyXOnly, leaves, leafIndex, parity?)` →
  `scriptPathControlBlock(internalKeyXOnly, leaves, leafIndex)`: path, root
  and parity are all derived internally.
- New export `outputKeyParity(internalKeyXOnly, merkleRoot): 0 | 1`.
- **Live test infra is now env-injected (CI-safe, no IPs in code).**
  `__tests__/taprootSpend-live.test.ts` is skipped unless
  `BAO_LIVE_TAPROOT=true` with `BAO_ELEMENTS_ESPLORA` + `BAO_ELEMENTS_SSH`
  set (`npm run test:live`). GitHub CI no longer needs VPS SSH access.

### Vector regeneration (spec §8.1, v2.2)
- `CB_T0` / `CB_T1` re-pinned with prefix `0xc1` (Q_T has odd Y); paths and
  all other §8.1 values unchanged (`CB_C0` / `CB_C1` stay `0xc0` — Q_C is
  even-Y, which is why they passed before). Tests add an independent numeric
  Q-parity cross-check, a genesis-byte-order pin against the display hashes,
  a non-default-hashType witness test, and a finalizeTaproot parity-rejection
  test; the hand-built sighash known-answer digest was re-pinned for the
  corrected genesis bytes.

## [0.6.0] — 2026-08-24

New module — WS-A Taproot script-path spend finalization for Liquid/Elements
(`./taproot-spend`). Pure math, no new runtime deps, consumer-visible surface
additive only (one new export in `liquidEscrow.ts`).

### Added
- `taprootSpend.ts` — `controlBlock` / `scriptPathControlBlock` (BIP-341
  control-block construction over the same split-at-half tree
  `tapMerkleRoot` commits), `taprootMerklePath`, `merkleRootFromLeafAndPath`,
  `tapleafHash`, and the WS-A leaf builders `buildWsACoopLeaf` /
  `buildWsARefundLeaf` (owner-key-only leaves, D1-no).
- `taprootSighashElements` — faithful port of Elements Core
  `SignatureHashSchnorr` (TAPSCRIPT): tag `"TapSighash/elements"` with the
  chain-genesis prefix, outpoint flags, confidential asset/value/nonce
  serializations, issuance + issuance-rangeproof commitments, output-witness
  (rangeproof/surjection) commitments; SIGHASH_DEFAULT/ALL/NONE/SINGLE + ACP
  branches; no annex support (WS-A leaves never use one).
- `finalizeTaproot` — computes the sighash and assembles the
  `[sig, ...stack, leafScript, controlBlock]` witness, with optional
  leaf+control-block→output-key verification.
- `serializeExplicitValue` / `serializeExplicitAsset` / `reverseHex`
  (Elements confidential-field wire forms) and network genesis constants
  `LIQUID_MAINNET_GENESIS` / `LIQUID_TESTNET_GENESIS`.
- `liquidEscrow.ts` now exports `locktimeToPush` (was module-private).
- `__tests__/taprootSpend.test.ts` — the WS-A spec §8.1 frozen vectors
  (leaves, merkle roots, output keys, signet addresses, control blocks), an
  independently hand-built sighash known-answer, determinism/sensitivity
  checks, `finalizeTaproot` verification, and the D1-no property test.

### Vector correction (spec §8.1, v2.1)
- The frozen v2 REFUND-leaf hex emitted `b1 00` where spec §3 defines
  `<locktime> OP_CLTV OP_DROP <pk> OP_CHECKSIG` — `0x00` in place of
  `OP_DROP` (`0x75`), a bug in the deleted vector generator. The corrected
  leaves regenerate MERKLE/Q/ADDR and the COOP-leaf control blocks; COOP
  leaves and REFUND-leaf control-block paths are unchanged. See the spec's
  correction note.

## [0.5.5] — 2026-08-23

Test-hardening and developer-docs pass. No protocol or wire-format changes —
nothing consumer-visible beyond docs.

### Changed
- Appeal coordinator/watcher tests drive the genuine fetch → detect → emit
  pipeline through host-injected relay fakes instead of manual state injection,
  and pin relay-filter shape, subscription cleanup, and the jury-selection seed.
- Adversarial fuzz assertions rewritten from false-positive-prone try/catch
  sentinels to typed `.toThrow(CourtProtocolEventError)` checks.

### Added
- `FrostWatcherRelayPool` — narrow structural type for
  `FrostAppealWatcherConfig.pool` (nostr-tools' `SimplePool` still satisfies it;
  hosts and tests no longer need casts against the full SimplePool surface).
- Decrypt-guard invocation counting in inbox tests; bond-pubkey derivation pin.
- `npm run typecheck:tests` — `__tests__/` is now typechecked (CI included);
  it was previously excluded from every gate.

### Fixed
- `FrostAppealWatcher.handleEvent` dedup race: concurrent duplicate deliveries
  racing through the async group-pubkey resolver could both pass the
  processed-event check and double-fire `onResolution`. Ids are now reserved
  synchronously on entry (failed validations remain retryable as before).

## [0.5.4] — 2026-08-21

Developer-experience release (live DX audit of v0.5.3). No protocol or
wire-format changes — patch bump only.

### Added
- `CHANGELOG.md` (this file), backfilled v0.2.0 → v0.5.3 with migration
  notes lifted from the FIXES memos.
- CI workflow (`.github/workflows/ci.yml`) running the full AGENTS.md
  verification battery (typecheck, typecheck:scripts, tests, court
  simulation) on push to `main` and on PRs.
- GitHub issue templates: bug report (with fail-closed/protocol impact
  triage) and feature request (with compatibility + security notes).
- Runnable Quick start ceremony example in the README (verified to produce
  the documented output).

### Changed
- README: consumption instructions now state plainly that `@bao/court` is a
  raw-TypeScript source package requiring a TS-aware resolver (tsx / Vite /
  bundler) — plain `node` cannot resolve the extensionless internal imports.
  Subpath imports (`@bao/court/events`, etc.) documented.
- `CONTRIBUTING.md`: contributors must keep `CHANGELOG.md` current.

## [0.5.3] — 2026-08-21

V12 audit hardening (all 35 actionable findings implemented) + architecture
deepening. See `docs/FIXES-2026-08-21.md` for the full memo.

### Added
- Ceremony machine caps and coercion guards: roster caps (10 000), outcome
  caps, bounded partial-signature / unwrap-batch sizes, strict UTF-8 and hex
  shape validation on every admission boundary.
- Verdict-ledger integrity barriers (`assertValidRevealLedger`,
  `assertSigningRecordInvariants`) run before `close_reveals` /
  `finalize_tally` so tampered ledgers fail before the verdict is locked.
- Duplicate-juror-pubkey rejection in DKG keygen; parameter bounds validated
  before cryptographic processing.
- Verdict-certified attestation enforcement at validation/settlement
  boundaries: `verdictHash` is recomputed from the supporting event ids and
  checked before a settlement is accepted.

### Changed
- External NIP-59 gift wraps are re-verified before routing; transient unwrap
  failures are retried on the next drain instead of being dropped.
- Evidence hashes on dispute events are canonicalized (lowercased + sorted)
  so the event is insertion-order-independent.
- Vote-commit format discriminator: session-bound commits set a version bit,
  legacy sessionless commits clear it, and the vote reducer rejects legacy
  commits at admission (they could never match a reveal).

### Architecture (public API unchanged)
- `courtCeremonyCore.ts` — roster/deadline/phase/blame/caps shared by the
  DKG, vote, and signing machines (was duplicated in parallel).
- `courtUnwrapCore.ts` — one filter/dedup/bounds core behind the seckey and
  signer unwrap adapters.
- `courtEventParseCore.ts` — tag/content/value primitives shared by the
  lenient (`events.ts`) and strict (`courtProtocolEvents.ts`) parse tiers.
- `docs/adr/0001` parks the appealCoordinator-as-machine conversion;
  `CONTEXT.md` adds a domain glossary.

### Fixed
- `blamedIdx` must now be a positive roster integer (no forged peer-blame).
- Duplicate partial signatures rejected (could bypass the distinct-signer
  threshold check).
- `deadline` tamper-detection on `tick` for signing state restored from a
  corrupted snapshot.
- Unwrap batch/kind-filter bounds before processing.

## [0.5.2] — 2026-08-18

Docs/version-header sync only — no code changes.

## [0.5.1] — 2026-08-18

### Fixed
- Regression tests type-clean under consumer tsconfigs.

## [0.5.0] — 2026-08-18

2026-08-18 adversarial deep review (rounds 1–7). **Wire-format breaking
changes** — see `docs/FIXES-2026-08-18.md` for the full analysis.

### Breaking
- **Canonical length-prefixed hashing.** `buildAttestationMessage`,
  `createBondOwnershipChallenge`, and `deriveLnPreimage` no longer join
  fields with `|`; they hash `CanonicalWriter` length-prefixed fields under
  explicit domain tags (`BAO-Court/AttestationMessage/v1`,
  `BAO-Court/BondOwnership/v1`, `BAO-Court/LnPreimage/v1`). Signatures keep
  their shapes but produce **new digests** — old attestation messages, bond
  challenges, and invoice preimages no longer verify.
- **Verdict-certified attestations.** Dispute attestations (kind 39007)
  must carry a `verdict_hash` over the session, outcome, and supporting
  reveal event ids; `validateAttestationEvent` rejects attestations without
  it. Consumers publishing dispute overrides must include the verdict hash.
- **BIP-341 compliance** for Liquid Taproot escrow script trees.

### Changed
- Commit/reveal vote commitments use the session-bound canonical encoding
  (length-prefixed `sessionHash || outcome || salt` under
  `BAO-Court/VoteCommit/v1`).

## [0.4.0] — 2026-08-17

### Added
- JIT appeal pipeline ported from bao.markets: `appealCoordinator.ts`
  (event-driven dispute → candidacy → selection → DKG → vote → signing →
  attestation), `appealWatcher.ts`, `appealTiming.ts`.
- Protocol paper: `docs/FROST_COURT_ORACLE_PAPER.md`.

## [0.3.0] — 2026-08-16

### Added
- Settlement rails (protocol-side only):
  - **Panel A — Lightning hold invoices** (`lnSettlement.ts` / `lnRail.ts`):
    deterministic preimage/payment-hash derivation, hold lifecycle state
    machine, settle/cancel decisions.
  - **Panel B — Liquid P2WSH/Taproot escrow** (`liquidEscrow.ts` /
    `liquidRail.ts`): M-of-N CHECKMULTISIG and judge/refund Taproot script
    trees, BIP-173/BIP-350 addresses.

## [0.2.3] — 2026-08-16

### Fixed
- Escrow kind-space references; `escrow.ts` emits no events.

## [0.2.2] — 2026-08-16

### Added
- Escrow lifecycle ledger (`escrow.ts`): bond ownership proofs (BIP-340
  challenge signatures), `pending → locked → returned | slashed_50 |
  slashed_100 | redistributed | failed` state machine, Kleros-style slashing
  math, deterministic integer-exact redistribution plans.
- Juror bond verification (`bondVerification.ts`): Mempool/Esplora evidence
  verifiers, required-bond computation.

## [0.2.1] — 2026-08-15

2026-08-15 hardening release. See `docs/FIXES-2026-08-15.md`.

### Breaking changes for consumers
1. **`addComplaint` returns `boolean`** (was `void`). Ignoring the return
   value is safe; gating on it is the recommended new behavior.
2. **`DkgComplaint` requires `encryptedShareEventId`.** Complaint events
   without `['share', id]` (author = victim) are structurally invalid.
3. **`restoreFromBackup` is stricter**: backups must carry full, consistent
   VSS commitment sets for the session's threshold; legacy relaxed backups
   are rejected (fail-closed). Use `buildBackupPayload` (unchanged) or the
   certified `courtRecovery` module for new backups.
4. **Legacy NIP-59 unwraps now verify**; wraps that do not verify return
   `null`.

### Changed
- DKG complaints are possession-bound and victim-authored (kind 38032).
- `unwrapProtocolEvent(s)` run the same gate as the signer path: recipient
  `p` tag, seal Schnorr signature, seal-author === rumor-author, rumor-id
  recomputation.
- `restoreFromBackup` recomputes the full verification battery (ordered
  indices, per-participant commitment counts, group key, every verification
  share, full-point parity-exact local share check).
- `seededScalar` counter encoded as a full uint16 (no truncation collision).

## [0.2.0] — 2026-08-14

Initial release: BAO Court — FROST threshold oracle (AGPL-3.0).

- Jury selection (`selection.ts`) — seed-derived, verifiable roster draw.
- Pedersen/PedPop DKG (`dkg.ts`, `independentDkg.ts`) — fail-closed, private
  blame, share backups.
- Commit/reveal voting state machine (`courtVoteMachine.ts`) with canonical
  verdict hashing.
- FROST signing state machine (`courtSigningMachine.ts`, `signing.ts`,
  `independentSigning.ts`) — nonce-equivocation aborts, frozen-verdict
  signing.
- Court session parameters and canonical encoding (`courtSession.ts`,
  `courtProtocolEvents.ts`).
- Nostr event builders/parsers (`events.ts`, `dkgMessages.ts`), NIP-44 v2
  encryption and NIP-59 gift wraps (`nip44Crypto.ts`, `nip59.ts`), external
  signer transport (`courtSigner.ts`, `courtNip46.ts`), durable outbox
  (`courtOutbox.ts`), recipient inbox (`courtInbox.ts`), keeper designation
  (`courtKeeper.ts`), host-key lifecycle (`courtHostKey.ts`), recovery
  (`courtRecovery.ts`), consumer-side attestation validation
  (`validator.ts`).

---

Migration notes for the wire-format breaks (v0.4.0 → v0.5.0) and the
hardening changes (v0.2.x → v0.2.1) are preserved verbatim in
`docs/FIXES-2026-08-18.md` and `docs/FIXES-2026-08-15.md` respectively.
