# V12 Audit — Suggested Fixes Report, v2.0 (Evaluated & Implemented)

> Supersedes `docs/v12-suggested_fixes.md` (the raw V12 report).
> Produced 2026-08-20: every actionable finding was re-evaluated by a second
> pass, and the accepted fixes are now implemented and green in this repo.

## Status

| | |
|---|---|
| Total findings | 81 |
| Actionable findings | 35 (11 high / 19 medium / 5 low) |
| Implemented (already in working tree at review time) | 17 |
| Implemented by this evaluation pass | 15 |
| Accepted with deliberate divergence from V12's patch | 3 |
| Rejected | 0 — all 35 were judged valid; 3 ship with a documented different shape |

Reconciled against the original V12 export (`docs/f12_fiiixes_export.md` +
`docs/export-findings.json`, 81 findings): all 35 `valid` findings appear in
this report exactly once; the 46 `invalid` findings were re-checked and remain
un-actioned. No valid finding was dropped in the filtering.

Verification: `npm test` (611/611), `npm run typecheck`,
`npm run typecheck:scripts`, `npm run simulate:court` (ALL GREEN).

## Status legend

- **Implemented (prior)** — the fix was already present in the working tree
  (`v12_fix` branch) before this pass; verified, tests added/kept.
- **Implemented (this pass)** — the fix was added during this evaluation.
- **Divergence** — accepted as valid, but implemented with a different (and
  deliberately better-fitting) shape than the V12 patch; rationale below.

---

## High severity

### 1. Abort Events Can Forge Failure and Blame — courtDkgMachine.ts
**Verdict: valid — implemented as a divergence.**

V12 proposed rejecting *every* caller-authored `abort`. That is too broad:
coordinators legitimately abort for network/coordinator failures that no
reducer event can derive, so a total ban would remove a real protocol path.
The forgery surface is (a) arbitrary runtime-injected phases and (b) an
unverified `blamedIdx`. Both are now closed:
- `ABORT_PHASES` allowlist — only `delivery_failed`, `aborted_peer`,
  `aborted_coordinator`, `aborted_network`, `incompatible_suite` may enter via
  `abort` (added this pass).
- `blamedIdx` must be a positive safe integer AND a roster participant
  (already in working tree).
- `abort` from terminal/`certified` phases remains rejected.

Tests: `rejects abort events with a non-failure phase`.

### 2. Bind verdict commitments to their dispute — dispute.ts, validator.ts, appealCoordinator.ts
**Verdict: valid — implemented as a divergence.**

V12 derives + validates `verdictHash` inside `runDisputeOverrideSigning` and
recomputes it in the validator. This repo already separates the legacy
sessionless commit path from the session-bound machine path
(`LEGACY_VOTE_COMMIT_DOMAIN` + digest version bit — see finding "Audited by
V12" below) and enforces the tally commitment at the value-protecting
boundary:
- `FrostAppealCoordinator.settleAppeal` recomputes `hashDisputeVerdict` from
  the appeal's frozen verdict inputs and rejects mismatches before releasing
  backup stakes / settling (working tree).
- `validateAttestationEvent` now recomputes the verdict commitment from the
  event's own dispute/outcome/supporting `e`-mention ids and rejects any
  attestation whose `verdict` tag does not match (added this pass — V12's
  validator recompute, which the working tree had left out).

`runDisputeOverrideSigning` deliberately keeps accepting a caller-supplied
`verdictHash` (tests, simulators, and demo coordinators construct attestations
without a machine tally); the settlement and validation boundaries are the
enforcement points that protect value. Documented, not a gap.

### 3. Closed reveal ledger is mutable and finalization trusts unvalidated reveals — courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

`assertValidRevealLedger` (roster membership, frozen allowlist, primitive
hex salt/event-id, unique index, unique event id, commit-match) runs at
`close_reveals` and again at `finalize_tally`; the ledger is deep-frozen at
close. This pass added array-shape guards and primitive-string checks to the
ledger assertion so hand-restored malformed state fails closed with
`CourtVoteTransitionError` instead of a TypeError.

### 4. Define a canonical Unicode tie-break ordering — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

`finalize_tally` now breaks tied counts with `compareOutcomeUtf8` (unsigned
UTF-8 byte order — the canonical outcome serialization), replacing the JS
UTF-16 `<` which diverges for supplementary-plane outcomes. `tallyVotes`
(dispute.ts) uses the same comparator so the imperative path and the machine
can never derive different verdicts. ASCII outcomes are unaffected (byte order
== code-unit order), so no existing verdict changes.

Tests: `breaks ties by canonical UTF-8 byte order, not UTF-16 code units`
(U+1F4A9 vs U+E000 — the orderings genuinely differ).

### 5. Duplicate roster identities can control multiple threshold shares — dkg.ts
**Verdict: valid — implemented (prior).**

`PedersenDkgAdapter.validateParams` rejects duplicate `nostrPubkey`s and
requires canonical 32-byte lowercase hex pubkeys; share indices must be
positive safe integers.

### 6. Iterator-controlled outcomes bypass cardinality enforcement — courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

`allowedOutcomes` is required to be an array, length 2..256 (bounds split so
the >256 case reports the actual length), each a valid bounded UTF-8 string,
unique.

### 7. Mutable State Bypasses Frozen Vote Configuration — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

Every state returned by `createCourtVoteMachine` / `reduceCourtVoteMachine` is
deep-frozen (`freezeCourtVoteMachineState`): configuration arrays, ledger
arrays and records, verdict, and failure. V12's `allowedOutcomes`-only freeze
was insufficient — `participantIndices` mutation could expand the roster, and
ledger records were mutable until close. No-op/idempotent paths (tick no-op,
repeat commit/reveal) also return frozen state.

Tests: `freezes configuration and ledger state against caller mutation`.

### 8. Mutable State Bypasses Reveal Admission — courtVoteMachine.ts
**Verdict: valid — implemented (this pass, same mechanism as #7).**

Admission itself was already strict (allowlist outcome, hex salt/event id,
commit-match, conflicting-reveal rejection); the deep-freeze closes the
mutation window between transitions. Reveal count is additionally capped at
`MAX_REVEALS` (10 000) at admission.

### 9. Reject invalid thresholds before DKG and refresh construction — dkg.ts
**Verdict: valid — implemented (prior).**

`validateParams` / `validateRefreshParams` require safe-integer thresholds
>= 2 and <= `MAX_DKG_PARTICIPANTS`, matching participant counts, and valid
share indices before any polynomial construction.

### 10. Reveal deadline can be bypassed with non-monotonic timestamps — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

The state tracks `latestTimestamp`; every time-bearing event with a lower
timestamp is rejected, and `open_reveals` must occur before the reveal
deadline (a late-open empty-ledger path is closed). All existing tests use
monotonic clocks, so nothing else moved.

Tests: `rejects timestamp rollback on any time-bearing event`,
`rejects opening vote reveals at or after the reveal deadline`.

### 11. Transient signer failure permanently drops messages — courtInbox.ts
**Verdict: valid — implemented (prior).**

A signer exception during `drain` no longer marks the wrap drained; the record
stays undrained and is retried on the next drain once the signer recovers.
Only clean unwraps or explicit nulls (invalid structure) are dropped.

---

## Medium severity

### 12. Audited by V12 — vote commitment formats diverge across exported paths — dispute.ts, courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

The legacy sessionless `hashCommit` now uses its own domain
(`BAO-Court/LegacyVoteCommit/v1`) and clears the digest version bit, while
`hashCourtVoteCommit` sets it; the reducer rejects legacy-format commits at
admission instead of storing commits that can never reveal. (This pass adds
input validation to both helpers — see #13.)

### 13. Bound public vote-commitment hash inputs — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

`hashCourtVoteCommit` validates sessionHash/salt as primitive 32-byte
lowercase hex and outcome as a non-empty <= 256-byte string before any
encoding; `hashCourtVerdict` and `hashDisputeVerdict` got the same treatment
(see #20). `hashCommit` (dispute.ts) bounds outcome to 256 bytes and requires
primitive strings, while keeping the legacy path's free-form salt so existing
integrations keep working.

Tests: `validates vote-commit and verdict hash inputs before hashing`.

### 14. Bound verdict evidence and participant cardinality — events.ts, validator.ts, courtSession.ts
**Verdict: valid — implemented (prior).**

`buildDisputeEvent` caps evidence hashes at 64; `buildDisputeAttestationEvent`
caps supporting ids at 10 000; the validator enforces 1..10 000 supporting
ids with uniqueness; session parameters were already bounded (1..1000
participants, 2..256 outcomes). Two dead `MAX_COURT_*` constants added by an
earlier edit were removed this pass — the live bounds live in the validators.

### 15. Canonicalize support IDs before hashing verdicts — courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

`finalize_tally` lowercases supporting event ids before the canonical sort so
casing cannot change the verdict hash; `hashDisputeVerdict` itself sorts
before hashing (order-independent).

### 16. Coercion Bypasses Canonical Hash Validation — courtDkgMachine.ts
**Verdict: valid — implemented (this pass).**

`createCourtDkgMachine` requires a primitive-string sessionHash;
`finalize_transcript` requires primitive-string transcriptHash /
candidateGroupPubkey before regex validation.

Tests: `rejects coercible non-string session hashes`.

### 17. Duplicate persisted records bypass distinct-signer thresholds — courtSigningMachine.ts
**Verdict: valid — implemented (this pass).**

`assertSigningRecordInvariants` runs at every reducer entry: commitment
records must be canonical points from distinct roster signers, the
`finalizedSignerSet` must exactly match the distinct sorted commitment
indices, and partial records must belong to that set with well-formed
signatures. The existing in-band duplicate-partial check stays as defense in
depth.

Tests: `rejects restored state with duplicate or malformed commitment records`.

### 18. Empty Dispute Filter Broadens Results — courtSigner.ts, nip59.ts
**Verdict: valid — implemented (this pass).**

Both signer-backed and seckey-backed batch unwraps treat a supplied `disputeId`
as an active filter whenever it is `!== undefined` — an empty string now
matches nothing instead of everything.

Tests: `an explicitly supplied empty dispute filter matches nothing`.

### 19. Hex Casing Changes Evidence Ordering — events.ts
**Verdict: valid — implemented (prior).**

`buildDisputeEvent` lowercases and sorts evidence hashes into tags so the
event (and its signed id) is deterministic and independent of insertion
order/casing.

### 20. Malformed Evidence IDs Produce Valid Commitments — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

`hashDisputeVerdict` validates disputeId as primitive 32-byte lowercase hex,
outcome as non-empty <= 256 bytes, and requires at least one primitive
32-byte lowercase hex supporting id before hashing. The validator's recompute
(#2) therefore cannot be fed malformed evidence.

### 21. Malformed Kind Filter Aborts Batch — courtSigner.ts
**Verdict: valid — implemented as a divergence.**

V12 treats a malformed `kinds` value as an absent filter (silently broadens).
The working tree instead validates every kind against 0..65535 and throws on
an invalid one. A malformed filter is a caller bug; failing loudly beats
silently broadening a security boundary. Behavior kept, documented.

### 22. Malformed Unicode outcomes can bypass commitment binding — courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

`createCourtVoteMachine` rejects outcomes that fail fatal UTF-8 decoding or
exceed 256 bytes, so allowlisted outcomes are always canonical text.

### 23. Malformed nonce commitments can poison FROST signing — crypto.ts, courtSigningMachine.ts, courtProtocolEvents.ts, independentSigning.ts
**Verdict: valid — implemented (this pass).**

New shared `isValidSecp256k1Point` (crypto.ts) verifies shape *and* curve
membership. Applied at:
- `courtSigningMachine.accept_commitment` and the stored-record invariant;
- `courtProtocolEvents` frost commit/reveal parsing (binder/hidden/frostPubkey);
- `independentSigning.addCommitment` and snapshot restore.

DKG commitment POK points keep their shape check (unchanged scope).

Tests: `isValidSecp256k1Point accepts on-curve points and rejects arbitrary hex`
(+ machine/protocol fixtures updated to real curve points).

### 24. Outer metadata bypasses wrap deduplication — courtSigner.ts
**Verdict: valid — implemented (this pass).**

`unwrapProtocolEventWithSigner` reconstructs the outer NIP-59 wrap and
`verifyEvent`s it (over a fresh object to dodge nostr-tools' cached-verdict
symbol) before recipient routing or decryption — the outer id/sig are now
load-bearing for wrap deduplication, mirroring the existing seal
re-verification. The adversary test that asserted the old "sig tampering is
not load-bearing" behavior was updated to assert the drop.

### 25. Bind and reuse the verified seal before wrapping — courtSigner.ts
**Verdict: valid — implemented (prior).**

`wrapProtocolEventWithSigner` verifies the seal returned by the external
signer over a reconstructed plain object (fresh `id`/`pubkey`/`sig`/`kind`/
`created_at`/`content`/`tags`), so a malicious signer that returns a once-valid
seal and then tampers with it cannot smuggle a cached nostr-tools
verification verdict into the wrap. (The working tree already carried this;
this pass mirrored the same reconstruction pattern on the outer wrap — #24.)

### 26. Reject malformed persisted deadlines before signing transitions — courtSigningMachine.ts
**Verdict: valid — implemented (prior).**

`tick` validates the persisted deadline (safe positive integer) before any
expiry transition so a corrupted restored snapshot fails closed.

### 27. Unauthenticated Index Claims Enable Peer Blame — courtDkgMachine.ts, courtSigningMachine.ts
**Verdict: valid — implemented (prior).**

Both machines require `blamedIdx` to be a positive safe integer and a roster
participant before recording peer blame.

### 28. Unbounded ceremony rosters exhaust reducer resources — courtDkgMachine.ts, courtSigningMachine.ts, courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

`MAX_DKG_PARTICIPANTS` / `MAX_PARTICIPANTS` / `MAX_PARTIAL_SIGNATURES`
(10 000) bound rosters, thresholds, and partial counts; the vote ledger caps
reveals at 10 000 (this pass).

### 29. Validate abort phases before mutating ceremony state — courtDkgMachine.ts, courtSigningMachine.ts
**Verdict: valid — implemented (this pass).**

Runtime `ABORT_PHASES` allowlists in both machines (see #1). A caller can no
longer cast an arbitrary phase into state via a forged abort event.

### 30. Validate and bound DKG parameters before cryptographic processing — dkg.ts
**Verdict: valid — implemented (prior).**

Participant count, threshold range/safety, unique indices, unique pubkeys, and
canonical pubkey encoding are all enforced in `validateParams` before keygen.

---

## Low severity

### 31. Coercible reveal IDs can block vote finalization — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

`accept_reveal`, `accept_commit`, and `assertValidRevealLedger` require
primitive strings before hex validation, so boxed objects can never be
persisted and later break the canonical verdict sort/hash.

### 32. Coercible session hash can poison reveal processing — courtVoteMachine.ts
**Verdict: valid — implemented (this pass).**

`createCourtVoteMachine` requires a primitive-string sessionHash before regex
validation; `hashCourtVoteCommit`/`hashCourtVerdict`/`hashDisputeVerdict` do
the same at the hashing boundary (#13/#20).

### 33. Malformed state crashes commitment processing — courtSigningMachine.ts
**Verdict: valid — implemented (this pass).**

Covered by `assertSigningRecordInvariants` (#17): non-array ledgers,
non-object records, missing fields, and off-roster/duplicate indices all throw
`CourtSigningTransitionError` instead of TypeError-ing.

### 34. Unbounded unwrap processing permits resource exhaustion — courtSigner.ts
**Verdict: valid — implemented (prior).**

`unwrapProtocolEventsWithSigner` rejects batches over `MAX_UNWRAP_BATCH`
(10 000) before processing.

### 35. Validate the copied participant roster before opening a ceremony — courtVoteMachine.ts
**Verdict: valid — implemented (prior).**

Participant-count bounds (0 < n <= 10 000) are enforced before the roster is
copied, and every copied index is checked for safe-integer sequential
ordering.

---

## Findings rejected or accepted differently

None of the 35 actionable findings were rejected outright. Three ship as
deliberate divergences (all documented above):

1. **#1** (covers #29's abort allowlist) — abort events kept (coordinators
   need network/coordinator aborts) but locked to an allowlist + verified
   blame, instead of V12's total ban.
2. **#2** — verdict commitment enforced at settlement + validation boundaries,
   not inside `runDisputeOverrideSigning` (library callers/tests/simulators
   build attestations without a machine tally).
3. **#21** — malformed kind filters throw instead of silently broadening.

Every other finding ships as V12 proposed (or as the working tree already had
it). The 46 findings V12 classified as "Invalid (intended behavior)" were
re-checked against the current code and remain un-actioned; several are now
covered by the hardening above (e.g. coercible-value guards live at the
machine boundaries where V12's invalid list assumed they were absent).

## Verification

```bash
npm test                 # 611/611 green (was 600/600 before this pass)
npm run typecheck        # clean
npm run typecheck:scripts# clean
npm run simulate:court   # ALL GREEN (selection → DKG → vote → sign → validate → escrow → LN → Liquid)
```
