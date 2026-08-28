# Changelog

All notable changes to `@bao/court` are documented here. This package ships
by git ref/tag (not npm) — see `AGENTS.md`. Breaking changes are flagged per
version with their consumer impact.

The version scheme: **patch** = bug fixes, **minor** = new modules/capabilities
or consumer-visible API changes. `1.0.0` stays reserved until the
trusted-dealer DKG is replaced with production Pedersen DKG and the API is
frozen.

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
