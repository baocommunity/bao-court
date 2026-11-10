# BAO Court — Formal Invariants (v0.9.2)

**Status:** normative reference for the ceremony machines, selection, batch
attestation, and validator modules.
**Method:** every invariant below was extracted from the *actual guards* in the
v0.9.1 source (an audit by another name) and updated for the v0.9.2
hardening (F-2, F-3, F-12). Each invariant carries an enforcement
pointer (`file:line`) and the test that pins it. Invariants that could not be
stated formally, or whose enforcement is partial, are listed explicitly as
findings (§12).

**Exhaustive model checking (v0.9.3):** beyond the pinning tests, the three
ceremony phase machines (vote, confirmation, signing) are now verified by
exhaustive finite-state-space exploration — every reachable state × every
event application, with properties P1–P5 (phase legality, data invariants
incl. the A-1 signer-set contract and the F-12 monotonic clock ledger,
no-dead-ends biconditional, acyclic progress graph, replay determinism) and
typed-error discipline asserted at every step. The vitest suite
(`__tests__/modelChecking.test.ts`) runs reduced instances; the full
multi-million-state sweep runs via `scripts/model-check.mjs` and its
per-instance numbers are committed in
`__fixtures__/model-check-summary.json`. Methodology and abstraction limits:
the header of `__tests__/modelCheckingCore.ts`.

Modules in scope:

| Module | File | Role |
|---|---|---|
| Ceremony core | `courtCeremonyCore.ts` | shared guards |
| Vote machine | `courtVoteMachine.ts` | commit/reveal tally |
| Confirmation machine | `courtConfirmationMachine.ts` | universal confirmation + ladder |
| Signing machine | `courtSigningMachine.ts` | FROST signing attempt |
| DKG machine | `courtDkgMachine.ts` | key generation ceremony |
| Selection | `selection.ts` | deterministic jury draw |
| Batch attestation | `batchAttestation.ts` | RFC-6962 Merkle batching |
| Validator | `validator.ts` | kind-89/39007 attestation validation |
| Session identity | `courtSession.ts` | CanonicalWriter + session hash |
| Attestation messages | `crypto.ts` | v1/v2 signed messages |

Executable cross-checks for the global invariants live in
`__tests__/invariantAssertions.test.ts`.

---

## 1. Notation and preliminary definitions

### 1.1 Base languages

- **`HEX_32`** := `^[0-9a-f]{64}$` (`courtCeremonyCore.ts:22`) — the language of
  32-byte lowercase-hex strings. Every hash, salt, event id, txid, and proof
  field in the protocol is a member of `HEX_32` unless stated otherwise.
- **`𝕋`** (timestamps): non-negative safe integers,
  `n ∈ 𝕋 ⟺ Number.isSafeInteger(n) ∧ n ≥ 0` (`assertNow`,
  `courtCeremonyCore.ts:30-34`).
- **`𝔻`** (deadlines): safe integers `≥ 1` (`assertPositiveDeadline`,
  `courtCeremonyCore.ts:109-117`).
- **Roster language** (`normalizeCeremonyRoster`,
  `courtCeremonyCore.ts:125-148`): a roster is a list `[1, 2, …, n]` exactly —
  `1 ≤ n ≤ 10 000` (`MAX_CEREMONY_PARTICIPANTS`, line 25) and
  `∀ offset < n : roster[offset] = offset + 1`. There is no other legal roster.
- **Canonical outcome language**: `outcome ∈ OutcomeLang ⟺ outcome` is a
  non-empty string whose UTF-8 encoding is `≤ 256` bytes and which is the
  *exact canonical decoding of its own bytes* (`isCanonicalUtf8Text`,
  `courtCeremonyCore.ts:64-70`). Because `TextEncoder` replaces lone surrogates
  with U+FFFD, two *distinct* strings can share one byte form; the round-trip
  condition makes the map `outcome ↦ UTF8(outcome)` injective on `OutcomeLang`.

### 1.2 CanonicalWriter — the canonical encoding grammar

`CanonicalWriter` (`courtSession.ts:389-451`) is the only sanctioned serializer
for hash inputs. Its grammar, where `‖` is byte concatenation:

```
⟨doc⟩        ::= ⟨chunk⟩*
⟨chunk⟩      ::= ⟨u8⟩ | ⟨u32⟩ | ⟨u64⟩ | ⟨bytes⟩ | ⟨text⟩ | ⟨hex⟩
⟨u8⟩         ::= 1 byte, value ∈ [0, 255]           (integer-checked)
⟨u32⟩        ::= 4 bytes, big-endian, value ∈ [0, 2³²−1]
⟨u64⟩        ::= 8 bytes, big-endian, value a safe non-negative integer (< 2⁵³)
⟨bytes⟩(b)   ::= ⟨u32⟩(|b|) ‖ b                      (length-prefixed)
⟨text⟩(s)    ::= ⟨bytes⟩(UTF8(s))
⟨hex⟩(h)     ::= ⟨bytes⟩(decodeHex(h))
```

Grammar-level laws (all enforced inside the writer methods):

- **CW-1 (typed range failure):** every method throws
  `CourtSessionValidationError('invalid_number', …)` outside its range — no
  silent wrapping or truncation (`courtSession.ts:392-426`).
- **CW-2 (prefix-freeness / injectivity):** because every variable-length field
  carries its byte length, the map from field tuples to byte strings is
  injective: no two distinct field tuples encode to the same `⟨doc⟩`
  (tested: `__tests__/courtSession.test.ts` › 'uses length prefixes instead of
  ambiguous delimiters').
- **CW-3 (determinism):** `finish()` is a pure fold over the chunk list; the
  same call sequence always yields the same bytes.

Every hash in the system is `SHA-256(domain ‖ ⟨doc⟩)` — the domain string is
*raw UTF-8, not length-prefixed*, and the document is writer-encoded.

### 1.3 Hash domains as a disjoint family

The system defines a family of domain strings, all of the form
`BAO-Court/<Name>/v<version>`:

| Domain constant | Value | Defined |
|---|---|---|
| `COURT_SESSION_DOMAIN` | `BAO-Court/SessionParameters/v1` | `courtSession.ts:16` |
| `ATTESTATION_MESSAGE_DOMAIN` | `BAO-Court/AttestationMessage/v1` | `crypto.ts:88` |
| `ATTESTATION_MESSAGE_DOMAIN_V2` | `BAO-Court/AttestationMessage/v2` | `crypto.ts:100` |
| `BATCH_LEAF_DOMAIN` | `BAO-Court/BatchLeaf/v1` | `batchAttestation.ts:35` |
| `BATCH_NODE_DOMAIN` | `BAO-Court/BatchNode/v1` | `batchAttestation.ts:36` |
| `BATCH_MANIFEST_DOMAIN` | `BAO-Court/BatchManifest/v1` | `batchAttestation.ts:37` |
| `COURT_VOTE_COMMIT_DOMAIN` | `BAO-Court/VoteCommit/v1` | `courtVoteMachine.ts:32` |
| `COURT_VERDICT_DOMAIN` | `BAO-Court/Verdict/v1` | `courtVoteMachine.ts:33` |
| `COURT_DISPUTE_VERDICT_DOMAIN` | `BAO-Court/DisputeVerdict/v1` | `courtVoteMachine.ts:34` |
| `COURT_CONFIRMATION_DOMAIN` | `BAO-Court/Confirm/v1` | `courtConfirmationMachine.ts:85` |
| `COURT_SIGNING_SESSION_DOMAIN` | `BAO-Court/SigningSession/v1` | `courtSigningMachine.ts:38` |
| `COURT_SIGNER_SET_DOMAIN` | `BAO-Court/SignerSet/v1` | `validator.ts:262` |
| `COURT_EPOCH_COHORT_DOMAIN` | `BAO-Court/EpochCohort/v1` | `epochCohort.ts:30` |
| `COURT_EPOCH_HANDOFF_DOMAIN` | `BAO-Court/EpochHandoff/v1` | `epochCohort.ts:31` |
| keeper / outbox / host-key / recovery / capability / bond / LN domains | see `courtKeeper.ts:26-28`, `courtOutbox.ts:35`, `courtHostKey.ts:61-67`, `courtRecovery.ts:66`, `courtNip46.ts:38`, `escrow.ts:299`, `lnSettlement.ts:32,366` | |

**Disjointness law (INV-X-1):** all exported domain constants are pairwise
distinct strings sharing the `BAO-Court/` prefix. Because the domain is
concatenated raw (not length-prefixed), distinctness of the *domain strings*
plus prefix-freeness of the encoded document (CW-2) makes cross-domain hash
aliasing require a SHA-256 collision. Pinned executably in
`__tests__/invariantAssertions.test.ts`.

Two deliberate exceptions, documented as such:

- The **confirmation machine reuses `COURT_VERDICT_DOMAIN`** via
  `hashCourtVerdict` (`courtConfirmationMachine.ts:14-27`): a confirmation
  verdict and a mass-vote verdict with identical
  `(sessionHash, outcome, supportingEventIds)` hash identically *by design*
  (same evidence semantics). The machines draw supporting ids from disjoint
  event universes, so substitution changes the hash.
- **Selection's seed** (`deriveSelectionSeed`, `selection.ts:117-127) is
  `SHA-256(disputeEventId ‖ blockHash)` with no domain tag. This is
  unambiguous because both inputs are fixed-length 32-byte hex — but it sits
  outside the CanonicalWriter grammar (finding F-7).

### 1.4 Machines — formalization convention

Each ceremony machine is a tuple `(S, s₀, E, →)` where:

- `S` is the set of well-formed states (created by the exported `create*`
  function, which *is* the only declared producer of `s₀`);
- `E` is the exported event union;
- `→ : S × E ⇀ S` is the exported `reduce*` function, a *partial* function:
  undefined transitions throw the machine's own typed error class (§2
  fail-closed law), never an uncaught `TypeError` and never a
  silently-accepted bad event.

> **Line numbers:** cite the v0.9.1 source except where a v0.9.2-hardening row
> states otherwise; the v0.9.2 insertions (signing/DKG clock-ledger blocks,
> the confirmation outcome-history barrier, the validator/batch empty-pin
> guards) shift some downstream line numbers slightly in exactly those files.
> **Round-16 review note (finding A-4):** the v0.10.x suite/module
> reorganization shifted *many* more pointers (e.g. INV-CONF-2's guard now
> sits at ~line 188 of `courtConfirmationMachine.ts`, not 586; INV-VOTE-3's
> `accept_commit` guard at ~line 630 of `courtVoteMachine.ts`, not 526). The
> line pointers are therefore **advisory**: the binding reference for every
> invariant is its INV-* ID plus the pinning test, both machine-verified by
> `scripts/cross-check.mjs` via docs/CROSS_CHECK.md (which carries the
> current file + test name). Re-resolving line pointers mechanically is
> registered as RS-2 (docs/REVIEW_SIMULATION.md).

"Reachable" below always means: reachable from `s₀` by a finite sequence of
defined transitions. Every returned state is deeply frozen (freeze discipline,
§10 / INV-X-4).

### 1.5 Named assumptions (A1–A6)

The machines below are pure state machines over messages. Their invariants hold
*conditional on assumptions that no machine can enforce*. Listing them here is
deliberate: an unstated assumption is indistinguishable from a proof.

- **A1** — one-more discrete-log hardness for FROST, random-oracle model for
  `H` (paper §10.1).
- **A2** — at least `M` honest roster members opt in and participate.
- **A3** — honest members share authenticated, encrypted channels
  (`nip44Crypto.ts` / `nip59.ts`).
- **A4** — honest majority in the corruption sense `m+1 ≤ t` for the
  possession-bound complaint bound (§2.4).
- **A5** — the block-hash selection seed is unbiased at the required
  confirmation depth.
- **A6 — the settlement binding.** A verdict becomes a pay-out only through a
  rail, and a rail is not a machine in this document. The attestation machines
  guarantee *what* was decided and *who* signed; they say nothing about what
  the escrow script verifies. Three bindings are analysed in
  `docs/SETTLEMENT-BINDING.md`; v1 ships **host-mediated** release (the cohort
  authorises, the host releases), so A6 is discharged by a *named trust point*,
  not by cryptography. Any claim of the form "no single party can release
  funds" is a claim about A6 and must cite which binding it assumes.

The one machine-checkable piece of A6 in this package is the judge-leaf key
contract, pinned as INV-SETTLE-1 (§11).

---

## 2. Fail-closed discipline (all machines)

These apply to every machine; they are stated once and referenced by ID.

- **FC-1 (typed errors only):** every rejection path throws the machine's own
  error class (`CourtVoteTransitionError`, `CourtConfirmationTransitionError`,
  `CourtSigningTransitionError`, `CourtDkgTransitionError`) — never a raw
  `Error`, `TypeError`, or `RangeError`. Enforced structurally: guards take the
  error ctor as a parameter (`courtCeremonyCore.ts:19`).
  Tests: `__tests__/adversarialParserFuzz.test.ts` › '200 random-tag mutations never crash
  untyped'; `__tests__/adversarialMachines.test.ts` › 'null/undefined/non-object
  EVENTS fail closed instead of crashing untyped'.
- **FC-2 (unknown event types fail closed):** the trailing branch of every
  reducer throws on a hostile `type` instead of returning an unfrozen or
  unchanged state (`courtVoteMachine.ts:696-699`,
  `courtConfirmationMachine.ts:1276-1279`, `courtSigningMachine.ts:577-581`,
  `courtDkgMachine.ts:336-340`).
  Tests: `adversarialMachines.test.ts` › 'unknown event types fail closed
  instead of returning an unfrozen state' (vote), 'unknown event types and
  non-object events fail closed' (confirmation, signing).
- **FC-3 (non-object events fail closed):** `event === null ∨ typeof event ≠
  object` throws before property access (`courtVoteMachine.ts:466-469`,
  `courtConfirmationMachine.ts:758-762`, `courtSigningMachine.ts:380-384`,
  `courtDkgMachine.ts:191-195`).
- **FC-4 (state-shape barrier):** every reducer re-validates that configuration
  and ledger fields are arrays before any `.includes`/`.find`/`.map`
  (`assertStateArrays`, `courtCeremonyCore.ts:79-89`; call sites
  `courtVoteMachine.ts:474-478`, `courtConfirmationMachine.ts:766-770`,
  `courtDkgMachine.ts:198-202`, `courtSigningMachine.ts:212-216`). A string
  allowlist (substring admission) and uncaught TypeErrors on restored state are
  both excluded.
  Tests: `adversarialMachines.test.ts` › 'a STRING allowlist cannot admit
  substring outcomes ("YES".includes("Y"))'; 'tampered non-array configuration
  fails closed instead of crashing untyped'.

---

## 3. Ceremony core (INV-CORE)

- **INV-CORE-1 — Timestamp language.**
  `∀ now: assertNow(now) defined ⟺ now ∈ 𝕋.`
  Guard: `courtCeremonyCore.ts:30-34`. Test: `__tests__/courtCores.test.ts` ›
  'assertNow rejects non-safe-integers and negative timestamps'.
- **INV-CORE-2 — Deadline language.**
  `∀ d: assertPositiveDeadline(d) defined ⟺ d ∈ 𝔻.`
  Guard: `courtCeremonyCore.ts:109-117`. Test: `courtCores.test.ts` ›
  'assertPositiveDeadline rejects zero and unsafe deadlines'.
- **INV-CORE-3 — Deadline precedence.**
  `assertBeforeDeadline(now, d) defined ⟺ now ∈ 𝕋 ∧ now < d.` The boundary is
  strict: `now = d` is *at* the deadline and rejected.
  Guard: `courtCeremonyCore.ts:94-104`. Test: `courtCores.test.ts` ›
  'assertBeforeDeadline rejects messages at/after the deadline'.
- **INV-CORE-4 — Roster closure.**
  `assertRosterMember(roster, idx) defined ⟺ idx ∈ roster`; combined with
  INV-CORE-6, every admitted participant index is in `[1, n]` and every index in
  `[1, n]` is a member.
  Guard: `courtCeremonyCore.ts:41-50`. Test: `courtCores.test.ts` ›
  'assertRosterMember rejects off-roster indices'.
- **INV-CORE-5 — Canonical UTF-8 round trip.**
  `isCanonicalUtf8Text(s) ⟺ UTF8⁻¹(UTF8(s)) = s` (decoding with fatal: true).
  Lone surrogates fail. Guard: `courtCeremonyCore.ts:64-70`.
  Tests: `adversarialMachines.test.ts` › 'rejects a lone-surrogate outcome in
  the vote allowlist' (and the confirmation/signing counterparts).
- **INV-CORE-6 — Roster normalization.**
  `normalizeCeremonyRoster(r) = [1..n]` exactly: non-empty, `n ≤ 10 000`,
  sequential one-based. Any gap, reorder, or repetition is rejected.
  Guard: `courtCeremonyCore.ts:125-148`. Test: `courtCores.test.ts` ›
  'normalizeCeremonyRoster validates order, sequentiality, and caps'.
- **INV-CORE-7 — Blame well-formedness.**
  `assertBlamedIdx(b, roster)` defined ⟺ `b = undefined ∨ (b ∈ 𝕋 ∧ b ∈
  roster)` — a peer-blame can never name a non-roster index.
  Guard: `courtCeremonyCore.ts:155-166`. Test: `courtCores.test.ts` ›
  'assertBlamedIdx validates positivity and roster membership'.
- **INV-CORE-8 — Hex language.**
  `HEX_32` matches exactly 64 lowercase hex chars — uppercase, 63/65-char, and
  non-hex strings are outside the language.
  Guard: `courtCeremonyCore.ts:22`. Test: `courtCores.test.ts` › 'HEX_32 is the
  canonical 32-byte lowercase-hex pattern'; pinned again in
  `__tests__/invariantAssertions.test.ts`.

---

## 4. Vote machine (INV-VOTE)

State: `CourtVoteMachineState`; phase lattice
`commit_open → commit_closed → reveal_open → reveal_closed → tally_final`, with
`expired` / `aborted` terminal sinks. `TERMINAL_PHASES = {tally_final, expired,
aborted}` (`courtVoteMachine.ts:122`).

**Phase graph.**

- **INV-VOTE-1 (initial state).** `create` returns phase `commit_open` with
  empty `commits`/`reveals`, `latestTimestamp = 0`, frozen. Guard:
  `courtVoteMachine.ts:448-458`. Test: exercised at the head of every vote test;
  `courtVoteMachine.test.ts` › 'tallies only committed reveals and freezes a
  canonical verdict hash'.
- **INV-VOTE-2 (creation balloting).** Creation requires
  `2 ≤ |allowedOutcomes| ≤ 256`, all outcomes ∈ OutcomeLang, pairwise distinct
  (`courtVoteMachine.ts:403-440`); `commitDeadline ∈ 𝔻`
  (line 441); `revealDeadline > commitDeadline` (lines 442-447).
  Tests: `courtVoteMachine.test.ts` › 'rejects outcomes outside the frozen
  allowlist' (allowlist language), `adversarialMachines.test.ts` › 'enforces the
  256-byte outcome bound at exactly MAX and MAX+1 (multi-byte)'.
- **INV-VOTE-3 (legal edge relation).** For each event type the guard phase is
  exact: `accept_commit` only in `commit_open` (line 526), `close_commits` only
  in `commit_open` (560), `open_reveals` only in `commit_closed` (571),
  `accept_reveal` only in `reveal_open` (580), `close_reveals` only in
  `reveal_open` (638), `finalize_tally` only in `reveal_closed` (651).
  Test: `courtVoteMachine.test.ts` › 'rejects reveals that do not match the
  exact session-bound commit' (wrong-phase rejections throughout);
  `propertiesConfirmation.test.ts` P1/P2 sweep covers the isomorphic
  confirmation graph.

**Time.**

- **INV-VOTE-4 (clock monotonicity).**
  `∀ reachable s, ∀ events e₁ e₂ accepted in order with clocks t₁ t₂: t₂ ≥ t₁`,
  and after any accepted event `s.latestTimestamp = max(t₁…tₖ)`. `abort` carries
  no clock and leaves `latestTimestamp` unchanged (lines 483-489).
  Test: `courtVoteMachine.test.ts` › 'rejects timestamp rollback on any
  time-bearing event'.
- **INV-VOTE-5 (commit window).** `accept_commit` requires
  `now < commitDeadline` (line 524) — strictly before, per INV-CORE-3.
  Test: `courtVoteMachine.test.ts` › 'rejects reveals without a prior commit and
  commits after the deadline'.
- **INV-VOTE-6 (close boundary).** `close_commits` requires
  `now ≥ commitDeadline` (line 563); `open_reveals` requires
  `now < revealDeadline` (570); `close_reveals` requires
  `now ≥ revealDeadline` (641).
  Tests: 'rejects opening vote reveals at or after the reveal deadline'
  (`courtVoteMachine.test.ts:292`); close boundary tested in the happy-path
  sequences.
- **INV-VOTE-7 (tick expiry, conservative).** A `tick` sets `expired` iff
  `phase ∉ TERMINAL ∪ {reveal_closed}` and `now ≥ revealDeadline`
  (lines 491-508). A ceremony one step from finalization (`reveal_closed`) is
  tick-exempt; nothing before its deadline expires.
  Test: `courtVoteMachine.test.ts` › 'does not expire reveal_closed by tick
  before finalization' (line 208); `… › 'expires after the reveal deadline and
  rejects late finalization'`.

**Ledgers (conservation).**

- **INV-VOTE-8 (one commit per participant).**
  `∀ reachable s: ∀ idx, |{c ∈ s.commits : c.idx = idx}| ≤ 1`. Redelivery of
  the *identical* `(commitHash, eventId)` is idempotent (`s' = s`, lines
  544-552); any conflicting redelivery throws.
  Test: `courtVoteMachine.test.ts` › 'allows exactly one commit per roster
  participant'.
- **INV-VOTE-9 (commit well-formedness + version gate).** Every accepted commit
  has `commitHash, eventId ∈ HEX_32` (lines 529-536) and the high nibble of
  `commitHash` has the version bit `0x8` set (lines 539-543) — legacy
  sessionless commitments are structurally inadmissible.
  Test: exercised via `hashCourtVoteCommit` fixtures; legacy rejection covered
  by the version-bit assertion in `invariantAssertions.test.ts`.
- **INV-VOTE-10 (session-bound commit derivation).**
  `hashCourtVoteCommit({S, o, salt}) = H(VoteCommit/v1, S ‖ text(o) ‖ salt)`
  with the version bit OR-ed into the first nibble (lines 179-186); inputs are
  validated *before* hashing (`S, salt ∈ HEX_32`, `o ∈ OutcomeLang`, lines
  156-178).
  Tests: `courtVoteMachine.test.ts` › 'validates vote-commit and verdict hash
  inputs before hashing' (line 302); `adversarialMachines.test.ts` › 'commits
  swapped between identical-shape sessions fail closed (session-bound hashes)'.
- **INV-VOTE-11 (one reveal per participant, unique event ids).**
  `∀ reachable s: ∀ idx, |{r ∈ s.reveals : r.idx = idx}| ≤ 1` and reveal event
  ids are pairwise distinct — both at accept time (lines 615-627) and in the
  ledger barrier (`seenIndices`/`seenEventIds`, lines 337-368).
  Test: `courtVoteMachine.test.ts` › 'allows exactly one commit per roster
  participant' (commit side) + ledger barrier coverage in
  `adversarialMachines.test.ts` › 'a spread-revived ABORTED machine re-validates
  its ledger at the barriers'.
- **INV-VOTE-12 (reveal ⊨ commit — one-commit-one-reveal opening).** A reveal is
  accepted only if (a) its `idx` has a prior commit (line 599-604), and (b)
  `hashCourtVoteCommit({sessionHash, outcome: r.outcome, salt: r.salt}) =
  commit.commitHash` (lines 605-614). The commit is thus a binding commitment:
  the revealed `(outcome, salt)` pair is uniquely determined by the commit.
  Test: `courtVoteMachine.test.ts` › 'rejects reveals that do not match the
  exact session-bound commit'.
- **INV-VOTE-13 (ballot closure).** Every accepted reveal outcome is a member of
  the frozen `allowedOutcomes` (line 588); nothing outside the creation-time
  ballot can ever enter a ledger.
  Test: `courtVoteMachine.test.ts` › 'rejects outcomes outside the frozen
  allowlist'.
- **INV-VOTE-14 (capacity).** `|s.reveals| ≤ 10 000` (`MAX_REVEALS`, lines
  583-587). Structurally implied by INV-CORE-6 + INV-VOTE-8 (roster ≤ 10 000,
  one reveal per idx); the guard is defense-in-depth against tampered states.
  *No dedicated boundary test* — finding F-10.
- **INV-VOTE-15 (ledger barrier at close and finalize).** `close_reveals` and
  `finalize_tally` both re-run `assertValidRevealLedger` (lines 646, 657), which
  re-verifies every ledger record against the machine's own bindings — a
  tampered or hand-restored ledger cannot feed the verdict.
  Tests: `adversarialMachines.test.ts` › 'a spread-revived ABORTED machine
  re-validates its ledger at the barriers'.

**Tally (determinism).**

- **INV-VOTE-16 (plurality with canonical tie-break).** The winner is the
  outcome with the greatest number of valid reveals; ties resolve to the
  lexicographically smallest outcome under `compareOutcomeUtf8` — unsigned
  UTF-8 byte order, *not* UTF-16 code-unit order (lines 661-677; comparator
  131-140).
  Tests: `courtVoteMachine.test.ts` › 'breaks ties deterministically in favor of
  the lexicographically smaller outcome'; `… › 'breaks ties by canonical UTF-8
  byte order, not UTF-16 code units'` (line 265, supplementary-plane pair).
- **INV-VOTE-17 (verdict support conservation).** The verdict's
  `supportingEventIds` is exactly the sorted (ascending, lowercased) set of
  reveal event ids voting for the winner, and is non-empty (`reveals.length
  ≥ 1` enforced at line 658-660).
  Test: `courtVoteMachine.test.ts` › 'reveals reordered (and commits reordered)
  produce the identical verdict' (`adversarialMachines.test.ts:576`).
- **INV-VOTE-18 (verdict hash binding).**
  `verdictHash = H(Verdict/v1, sessionHash ‖ text(outcome) ‖ u32(|ids|) ‖ ids)`
  (lines 221-228) — binds session, winner, and the exact supporting set.
  Test: `courtVoteMachine.test.ts` › 'tallies only committed reveals and freezes
  a canonical verdict hash'.
- **INV-VOTE-19 (dispute-verdict order independence).** `hashDisputeVerdict`
  sorts `supportingEventIds` before hashing (line 288), so the commitment is a
  function of the *set* of supporting ids; inputs validated to `HEX_32` /
  OutcomeLang before hashing (lines 260-283).
  Test: `validator.test.ts` › 'accepts a well-formed dispute attestation' +
  'rejects a dispute attestation that does not bind the verdict'.
- **INV-VOTE-20 (tally determinism).** `finalize_tally` is a pure function of
  the (already order-independent) ledger: reordering reveals/commits does not
  change `(outcome, supportingEventIds, verdictHash)`.
  Test: `adversarialMachines.test.ts` › 'reveals reordered (and commits
  reordered) produce the identical verdict'.

**Terminal + abort.**

- **INV-VOTE-21 (terminal absorption).** From any phase in `TERMINAL_PHASES`,
  every non-tick, non-abort event throws (line 519-521); `abort` from a terminal
  phase throws (510-512); `tick` from a terminal phase is phase-preserving
  (returns the terminal state, with the clock ledger possibly advanced) (496-501).
  Terminal states are absorbing.
  Test: `courtVoteMachine.test.ts` › 'expires after the reveal deadline and
  rejects late finalization'; pinned across all machines in
  `invariantAssertions.test.ts`.
- **INV-VOTE-22 (abort requires non-terminal + reason).** `abort` from a
  non-terminal phase yields `phase = 'aborted'` with the caller's reason in
  `failure` (lines 509-518).
  Test: covered by the terminal-discipline tests; cross-machine pin in
  `invariantAssertions.test.ts`.
- **INV-VOTE-23 (freeze discipline).** Every state returned by `create`/`reduce`
  is deeply frozen: config arrays, ledger arrays, per-record objects, verdict
  (+ its id array), and failure (lines 310-323).
  Tests: `courtVoteMachine.test.ts` › 'freezes configuration and ledger state
  against caller mutation' (line 239); `adversarialMachines.test.ts` ›
  'deep-freezes every returned state (configuration, ledgers, verdict,
  failure)' and 'freezes survive a JSON round-trip'.

---

## 5. Confirmation machine (INV-CONF)

Phase lattice:
`confirm_open → confirm_closed → challenge_window → (fee_settlement |
ladder_pending → ladder_vote_open → ladder_vote_closed → resolve paths)` with
`round_resolved` parking, `final`, and sinks `expired`/`aborted`.
`TERMINAL_PHASES = {final, expired, aborted}` (line 287).

**Creation.**

- **INV-CONF-1 (initial state).** `create` returns `confirm_open`, empty
  ledgers, `ladderRound = 0`, frozen (lines 650-669).
  Test: `courtConfirmationMachine.test.ts` › 'starts in confirm_open with empty
  ledgers'.
- **INV-CONF-2 (panel ≥ 3).** The case roster must have `≥ 3` members —
  fail-closed at creation (round-3 finding r3-6): a 2-member roster could
  confirm but could never resolve a challenged case (the default round panel is
  the case roster and the round-panel barrier demands ≥ 3). Guard:
  `courtConfirmationMachine.ts:586-590` (+ `MIN_ROUND_ROSTER = 3`, line 285).
  Test: `propertiesConfirmation.test.ts` › 'P6 (FINDING r3-6 …): a 2-member case
  roster is rejected at CREATION'.
- **INV-CONF-3 (proposal ∈ ballot).** `proposedOutcome ∈ allowedOutcomes`, and
  `allowedOutcomes` satisfies the 2..256 unique-bounded rule (lines 591-611).
  Test: `courtConfirmationMachine.test.ts` › 'requires the proposal to be a
  member of the allowlist', 'requires at least two unique outcomes'.
- **INV-CONF-4 (quorum range — economic).** `1 ≤ confirmQuorum ≤
  |participants|` (lines 621-630, default 1). The quorum is never larger than
  the panel and never zero.
  Test: `courtConfirmationMachine.test.ts` › 'bounds the quorum to the roster'.
- **INV-CONF-5 (deadline ordering).** `confirmDeadline ∈ 𝔻` and
  `challengeDeadline > confirmDeadline` (lines 631-639).
  Test: `courtConfirmationMachine.test.ts` › 'requires the challenge deadline to
  follow the confirm deadline'.
- **INV-CONF-6 (ladder cap).** `1 ≤ maxLadderRounds ≤ 5`, default 2 (lines
  640-649; constants 282-284).
  Test: `multiRoundLadder.test.ts` › 'bounds the parameter 1..5 and rejects
  non-integers'.
- **INV-CONF-7 (evidence bound).** `evidenceIds` ≤ 256 entries, all `HEX_32`
  (lines 612-620).
  Test: `courtConfirmationMachine.test.ts` › 'validates evidence ids'.

**Canonical bindings.**

- **INV-CONF-8 (confirmation hash binding).**
  `hashCourtConfirmation({S, P, idx}) = H(Confirm/v1, S ‖ P ‖ u32(idx))` —
  replay-proof across sessions and proposals; inputs validated before hashing
  (lines 303-326).
  Tests: `courtConfirmationMachine.test.ts` › 'derives the canonical
  session+proposal+idx binding'; 'is replay-proof across proposals and roster
  indices'.
- **INV-CONF-9 (confirmation ⊨ binding).** An accepted confirmation's
  `confirmHash` must equal the recomputed canonical hash for
  `(sessionHash, proposalHash, idx)` (lines 753-762), and the ledger barrier
  re-derives it at the value-locking points (lines 501-510, invoked at 964 and
  1140).
  Tests: 'rejects a confirmation hash that does not match the canonical
  binding'; `adversarialCrossModule.test.ts` (confirmation-ledger barrier
  coverage).

**Time + graph.**

- **INV-CONF-10 (clock monotonicity).** As INV-VOTE-4; `abort` carries no clock
  (lines 698-706).
  Test: `courtConfirmationMachine.test.ts` › 'rejects clock rollback'.
- **INV-CONF-11 (phase-exact guards).** `accept_confirmation` only in
  `confirm_open` (744); `close_confirmations` only in `confirm_open` (787);
  `open_challenge_window` only in `confirm_closed` (806); `accept_challenge`
  only in `challenge_window` (816); `open_ladder_round` only in
  `ladder_pending` (877); `accept_mass_vote` only in `ladder_vote_open` (912);
  `close_ladder_round` only in `ladder_vote_open` (947); `resolve_round` only in
  `ladder_vote_closed` (960); `escalate`/`concede` only in `round_resolved`
  (1055, 1071); `flag_clawback` only in `fee_settlement` (1096); `finalize` only
  in `fee_settlement` (1129).
  Tests: per-event guard coverage throughout `courtConfirmationMachine.test.ts`
  and `multiRoundLadder.test.ts` ('rejects escalate/concede outside
  round_resolved and double decisions').
- **INV-CONF-12 (window boundaries).** Confirmations require
  `now < confirmDeadline` (749); `close_confirmations` requires
  `now ≥ confirmDeadline` (790); challenges require `now < challengeDeadline`
  (821) and window close requires `now ≥ challengeDeadline` (859); mass votes
  require `now < ladder.voteDeadline` (915) and round close requires
  `now ≥ ladder.voteDeadline` (950).
  Tests: 'rejects closing the confirm window before the deadline'; 'rejects
  confirmations at or after the deadline and during wrong phases'; 'rejects
  challenges after the deadline, off-roster, or malformed'.
- **INV-CONF-13 (tick deadline table).** A tick expires exactly the
  awaiting-input phases at their governing deadlines (`TICK_DEADLINES`, lines
  290-295, applied 718-727): `confirm_open` at `confirmDeadline`,
  `confirm_closed` and `challenge_window` at `challengeDeadline`,
  `ladder_vote_open` at `ladder.voteDeadline`. The near-final phases
  (`ladder_vote_closed`, `round_resolved`, `fee_settlement`, `ladder_pending`)
  and terminal phases are tick-exempt.
  Test: `courtConfirmationMachine.test.ts` › 'expires awaiting-input phases at
  their deadlines and exempts near-final phases'; `… › 'expires confirm_closed
  and challenge_window at the challenge deadline'`; `multiRoundLadder.test.ts` ›
  'a round_resolved case is tick-exempt while awaiting the host decision'.
- **INV-CONF-14 (terminal absorption + abort).** As INV-VOTE-21/22 (lines
  729-741).
  Test: `courtConfirmationMachine.test.ts` › 'aborts from any non-terminal phase
  with the reason preserved'; cross-machine pin in
  `invariantAssertions.test.ts`.

**Economic conservation.**

- **INV-CONF-15 (quorum gate — economic).** `close_confirmations` is illegal
  unless `|confirmations| ≥ confirmQuorum` (lines 795-801): a quorum that never
  formed must be expired by a tick or aborted, never silently closed.
  Test: `courtConfirmationMachine.test.ts` › 'fails closed when the confirm
  quorum never formed'.
- **INV-CONF-16 (one confirmation per idx).** Identical redelivery idempotent,
  conflicting redelivery fatal (lines 768-776); uniqueness re-checked in the
  ledger barrier (511-520).
  Test: `courtConfirmationMachine.test.ts` › 'treats identical redelivery as
  idempotent and conflicting redelivery as fatal'.
- **INV-CONF-17 (challenge bond binding).** Every challenge carries
  `bondTxid, bondProofHash, eventId ∈ HEX_32` (lines 823-825); one challenge per
  idx, identical idempotent / conflicting fatal (831-843); the bond-ownership
  witness hash is bound so observers can re-verify (interface `CourtChallengeRecord`,
  lines 111-122; the witness-vs-UTXO check is the host's pre-dispatch duty —
  boundary, not machine).
  Test: `courtConfirmationMachine.test.ts` › 'rejects challenges after the
  deadline, off-roster, or malformed'.
- **INV-CONF-18 (no-challenge routing).** `close_challenge_window` routes to
  `ladder_pending` iff `|challenges| > 0`, else `fee_settlement` with the
  provisional verdict `{outcome: proposedOutcome, upheld: true}` (lines
  864-874).
  Test: `courtConfirmationMachine.test.ts` › 'routes to fee_settlement with no
  challenges and ladder_pending with one'.

**Ladder.**

- **INV-CONF-19 (consecutive rounds + cap).** `open_ladder_round` requires
  `event.round = ladderRound + 1` (lines 882-889) and
  `event.round ≤ maxLadderRounds` (lines 893-897, defense in depth for restored
  snapshots).
  Tests: `courtConfirmationMachine.test.ts` › 'enforces consecutive rounds and
  non-past deadlines'; `multiRoundLadder.test.ts` › 'hand-restored snapshots
  cannot bypass the cap'.
- **INV-CONF-20 (round deadline validity).** `voteDeadline ∈ 𝔻` and
  `now < voteDeadline` at open (lines 898-899).
  Test: `courtConfirmationMachine.test.ts` › 'enforces consecutive rounds and
  non-past deadlines'.
- **INV-CONF-21 (round-panel language).** An explicit `roundRoster` must be a
  sequential 1..N roster with `N ≥ 3` (`normalizeRoundRoster`, lines 352-365).
  Superset-of-previous is deliberately NOT required. The effective panel for
  votes is the round roster when present, else the case roster (`roundRosterOf`,
  337-339); the barrier re-normalizes a restored round roster (line 444).
  Tests: `multiRoundLadder.test.ts` › 'rejects malformed round rosters:
  non-sequential, < 3 seats, and votes outside the ROUND panel'; `… › 'does NOT
  require the round roster to be a superset of the previous round'.
- **INV-CONF-22 (one vote per idx per round).** Mass votes are unique per idx
  within the round (identical idempotent / conflicting fatal, lines 928-936) and
  the ledger barrier re-checks index + event-id uniqueness (458-467).
  Test: `courtConfirmationMachine.test.ts` › 'rejects votes outside the
  allowlist, off-roster, duplicate, and after deadline'.
- **INV-CONF-23 (mass-vote ledger barrier).** `close_ladder_round` and
  `resolve_round` re-verify the whole vote ledger (lines 955, 963): roster
  membership against the ROUND panel, allowlist, hex, uniqueness.
  Test: `adversarialMachines.test.ts` › 'an ABORTED machine spread-revived into
  ladder phases hits the ledger barrier'.
- **INV-CONF-24 (non-empty round).** `resolve_round` refuses an empty vote
  ledger (lines 965-967).
  Test: `courtConfirmationMachine.test.ts` › 'fails closed when closing a round
  with zero votes'.
- **INV-CONF-25 (round majority + shared tie-break).** The round winner is the
  plurality outcome with ties broken by `compareOutcomeUtf8` — byte-identical
  semantics to the vote machine tally (lines 968-986); `upheld ⟺ winner =
  proposedOutcome` (987).
  Tests: `courtConfirmationMachine.test.ts` › 'accepts mass votes, closes, and
  resolves a majority'; `… › 'breaks tallies deterministically on ties'`.
- **INV-CONF-26 (outcomeHistory append-only + restore barrier — F-3 CLOSED in
  v0.9.2).** Each `resolve_round` appends
  exactly one `{round, outcome, winnerEventIds, winnerIndices}` record; no
  transition ever removes or rewrites history; records are frozen. As of
  v0.9.2 the history is ALSO barrier-verified (`assertValidOutcomeHistory`)
  at `resolve_round` and `finalize`: consecutive 1..k round sequence, ballot
  closure, unique well-formed winner event ids, unique valid winner indices —
  a hand-restored snapshot with a forged history cannot direct `round_flip`
  clawbacks at arbitrary indices.
  Test: `multiRoundLadder.test.ts` › 'records append-only frozen {round,
  outcome, winnerEventIds, winnerIndices} per resolved round';
  `courtConfirmationMachine.test.ts` › 'outcome-history restore barrier
  (finding F-3)' tests.
- **INV-CONF-27 (overturn clawback — economic, append-only idempotent).** If a
  round overturns the proposal (`upheld = false`), every confirming juror is
  flagged `overturned_confirmation`, idempotent per `(idx, reason)`: later
  overturning rounds never duplicate existing flags (lines 1001-1015).
  Tests: `courtConfirmationMachine.test.ts` › 'flags every confirming juror for
  clawback on overturn'; `multiRoundLadder.test.ts` › 'does not duplicate
  overturned_confirmation flags when a later round also rejects the proposal'.
- **INV-CONF-28 (flip-flop clawback — economic, append-only idempotent).** When
  round r's winner differs from round r−1's winner, round r−1's majority voters
  are flagged `round_flip` at `round = r−1`, idempotent per `(idx, reason,
  round)` (lines 1016-1033).
  Test: `multiRoundLadder.test.ts` › "flags the previous round's majority with
  'round_flip' when the winner changes; append-only and idempotent".
- **INV-CONF-29 (escalation gating).** `resolve_round` proceeds to
  `fee_settlement` iff `round ≥ maxLadderRounds`, else parks in
  `round_resolved` (lines 1039-1042). `escalate` additionally refuses when
  `ladderRound ≥ maxLadderRounds` (lines 1062-1066). The machine never
  auto-escalates and never auto-concedes.
  Tests: `multiRoundLadder.test.ts` › 'rounds beyond the last settle without a
  concede; escalate is impossible once settled'; `… › 'escalate re-opens the
  ladder for the next consecutive round; the machine never auto-escalates'`;
  `… › 'concede settles with the current round outcome as final'`.
- **INV-CONF-30 (fee ledger idempotency).** `record_fee` accepts `HEX_32` ids,
  is idempotent per id, and caps at 256 entries (lines 1082-1093).
  Test: `courtConfirmationMachine.test.ts` › 'records fees idempotently and
  rejects malformed ids'; `adversarialMachines.test.ts` › 'accepts exactly
  MAX_FEES fee entries, rejects MAX+1, stays idempotent at the cap'.
- **INV-CONF-31 (explicit clawback flag discipline).** `flag_clawback` only
  during `fee_settlement`, roster-member idx, non-empty reason ≤ 64 bytes,
  deduplicated per `(idx, reason)`, cap 10 000 (lines 1095-1126).
  Test: `courtConfirmationMachine.test.ts` › 'accepts explicit clawback flags
  only during fee_settlement, deduped per (idx, reason)'.
- **INV-CONF-32 (finality = last resolved round).** `finalize` mints the verdict
  from the LAST resolved round: outcome = that round's winner; supporting ids =
  that round's winning vote ids, or the confirmation ledger when the case was
  never challenged and the proposal was upheld (lines 1145-1155).
  Test: `multiRoundLadder.test.ts` › 'finality = LAST resolved round: verdict
  outcome + supporting ids from that round only'.
- **INV-CONF-33 (non-empty final support — r3-1).** `finalize` refuses a verdict
  with zero supporting event ids, throwing the machine's OWN typed error
  (lines 1156-1169).
  Test: `propertiesConfirmation.test.ts` › 'P6 (FINDING r3-1, FIXED in 0.9.1):
  finalize over an EMPTY but well-formed confirmation ledger fails closed with
  the machine's OWN typed error'.
- **INV-CONF-34 (verdict determinism — flags are not verdict inputs).** The
  verdict hash is a pure function of the verified ledgers; clawback-flag history
  is deliberately not an input, so replaying the same pre-finalize snapshot with
  a different flag history yields the identical `verdictHash` (lines 1132-1139
  docstring + 1170-1174).
  Test: `adversarialCrossModule.test.ts` › 're-finalizing from the same
  fee_settlement snapshot with a DIFFERENT flag_clawback history yields the
  IDENTICAL verdictHash (clawbacks are not a verdict input)'.
- **INV-CONF-35 (verdict hash reuses the verdict domain).** `finalize` computes
  `verdictHash` via the vote machine's `hashCourtVerdict` — the shared
  `Verdict/v1` domain (lines 1170-1174; see the domain note at lines 18-27).
  Test: `courtConfirmationMachine.test.ts` › 'builds the verdict from winning
  mass votes on overturn' (hash form); `invariantAssertions.test.ts` pins the
  domain equality.
- **INV-CONF-36 (freeze discipline).** As INV-VOTE-23, with the additional
  frozen shapes: ladder (votes + roster + round), outcomeHistory records (+
  their arrays), clawback flags, fees (lines 398-429).
  Test: `courtConfirmationMachine.test.ts` › 'freezes state so ledgers cannot be
  mutated between transitions'; `adversarialMachines.test.ts` › 'deep-freezes
  every returned state' (confirmation).

---

## 6. Signing machine (INV-SIGN)

Phase lattice: `intent → nonce_commit → commitment_set_final → partial_sign →
aggregate → attestation_published`, sinks `expired`, `aborted_peer`,
`aborted_coordinator`, `aborted_network`. `TERMINAL_PHASES = {attestation_published,
expired, aborted_peer, aborted_coordinator, aborted_network}` (lines 137-143).

- **INV-SIGN-1 (session binding — economic/threshold).** `create` computes
  `signingSessionHash = H(SigningSession/v1, sessionHash ‖ verdictHash ‖
  text(outcome) ‖ u32(n) ‖ indices ‖ u32(threshold) ‖ u32(attempt))`
  (lines 165-189, 351-359): the hash binds the court session, the frozen
  verdict, the outcome, the whole roster, the threshold, and the attempt
  number. A FROST nonce commitment is consumable under exactly one such hash.
  Test: `courtSigningMachine.test.ts` › 'binds the signing session hash to every
  attempt parameter'.
- **INV-SIGN-2 (state ⇄ binding consistency).** Every `reduce` re-derives
  `signingSessionHash` from the persisted fields and fails closed on mismatch —
  a restored snapshot with an edited outcome/threshold/roster/attempt is
  rejected before any event is processed (lines 219-236 inside
  `assertSigningRecordInvariants`, called at line 382).
  Test: `adversarialMachines.test.ts` › 're-derives the signing session hash:
  tampered binding fields fail closed'.
- **INV-SIGN-3 (threshold range — economic).** `1 ≤ threshold ≤
  |participants|` and `threshold ≤ 10 000` (lines 331-342).
  Test: `courtSigningMachine.test.ts` (creation validation in the happy-path +
  'cannot finalize a commitment set below threshold' for the behavioural side).
- **INV-SIGN-4 (one commitment per signer per attempt).** Each roster signer
  publishes at most one nonce commitment: identical redelivery idempotent
  (returns the same state, lines 444-447); a conflicting second commitment is
  nonce equivocation → `aborted_peer` with `blamedIdx` (lines 448-457).
  Test: `courtSigningMachine.test.ts` › 'allows exactly one nonce commitment per
  signer and attempt'.
- **INV-SIGN-5 (nonce points are curve points).** Commitment nonces must decode
  to real secp256k1 points, x-only (64 hex) or compressed (02/03 prefix) —
  malformed nonces cannot poison the FROST binding-factor computation (lines
  441-443; validator `isValidSecp256k1Point`, `crypto.ts:297-305`).
  Tests: `courtSigningMachine.test.ts` (commitment fixtures);
  `regressions.test.ts` › 'computes the group nonce that ends up in the final
  signature' (downstream consistency).
- **INV-SIGN-6 (commitment-set finality ⇔ threshold — economic).**
  `close_commitments` is illegal with fewer than `threshold` commitments (lines
  473-477) and freezes `finalizedSignerSet` = the sorted distinct commitment
  indices (line 478).
  Test: `courtSigningMachine.test.ts` › 'cannot finalize a commitment set below
  threshold'.
- **INV-SIGN-7 (signer-set closure).** `finalizedSignerSet` must exactly equal
  the sorted distinct commitment indices — re-verified on every reduce (lines
  259-270); partials from outside the set are rejected both at accept (lines
  487-491) and in the restored-state barrier (285-289).
  Test: `courtSigningMachine.test.ts` › 'accepts partial signatures only from
  the finalized commitment set'.
- **INV-SIGN-8 (one partial per signer; equivocation aborts with blame).**
  Distinct partial indices are enforced structurally (`finalizedSignerSet`
  membership + duplicate re-checks, lines 272-294, 516-521); a conflicting
  second partial → `aborted_peer` with blame (lines 501-513).
  Test: `courtSigningMachine.test.ts` › 'aborts with blame on conflicting
  partial signatures'.
- **INV-SIGN-9 (partial well-formedness).** `psig` must be 64-char lowercase hex
  (lines 493-500).
  Test: `courtSigningMachine.test.ts` (malformed-partial coverage); fuzz
  coverage `adversarialParserFuzz.test.ts` › 'frost-reveal with oversized psig fails typed'.
- **INV-SIGN-10 (aggregate threshold — economic).** `aggregate` requires
  `|partials| ≥ threshold` (lines 534-538) and a 64-byte lowercase-hex signature
  (539-541). Because partials are distinct-index (INV-SIGN-8), the count equals
  the number of *distinct signers* — the threshold is over signers, not
  signatures.
  Test: `courtSigningMachine.test.ts` › 'runs the full attempt to a published
  attestation' (threshold met) + restored-state duplicate rejections ('rejects
  restored state with duplicate or malformed commitment records').
- **INV-SIGN-11 (publish requires aggregate).** `publish` requires phase
  `aggregate` with a stored signature and a `HEX_32` attestation event id (lines
  545-553).
  Test: `courtSigningMachine.test.ts` › 'runs the full attempt to a published
  attestation'.
- **INV-SIGN-12 (deadline precedence + monotonic clock ledger — F-12 CLOSED in
  v0.9.2).** All peer-facing events require `now ∈ 𝕋 ∧ now < deadline`
  (INV-CORE-3 via `assertBeforeDeadline`); tick expires when
  `now ≥ deadline` unless terminal and re-validates the persisted deadline.
  As of v0.9.2 the signing machine ALSO keeps the monotonic clock ledger
  (`latestTimestamp` in state, initialized to 0 at creation; restored v0.9.1
  snapshots initialize it to 0 on first observation): every time-bearing
  event requires `now ≥ state.latestTimestamp` and advances the ledger, and
  `abort` carries no clock — the exact vote-machine pattern (INV-VOTE-4), so
  old-timestamped replays into a restored signing state are no longer
  admissible. The two idempotent-redelivery paths return the clock-advanced
  state frozen (INV-SIGN-15 preserved).
  Test: `courtSigningMachine.test.ts` › 'expires without publishing and rejects
  out-of-roster signers'; `… › 'monotonic clock ledger (finding F-12)'` tests;
  `invariantAssertions.test.ts` › INV-X-5 tests.
- **INV-SIGN-13 (abort phase whitelist + blame).** `abort` accepts only
  reducer-defined failure phases (`ABORT_PHASES`, lines 131-135, checked
  406-408) and validates `blamedIdx` against the roster (line 411).
  Test: `courtSigningMachine.test.ts` › 'rejects abort events with a non-failure
  phase'.
- **INV-SIGN-14 (terminal absorption).** As INV-VOTE-21 (lines 418-420).
  Test: cross-machine pin in `invariantAssertions.test.ts`.
- **INV-SIGN-15 (freeze discipline).** Every returned state deeply frozen,
  including `finalizedSignerSet` and per-record objects (lines 150-159). The
  two idempotent-redelivery paths that return the *same object* (lines 447, 503)
  return already-frozen state.
  Test: `adversarialMachines.test.ts` › 'deep-freezes every returned state'
  (signing).

---

## 7. DKG machine (INV-DKG)

Phase lattice: `parameters_confirmed → dkg_round_1 → dkg_round_2 →
transcript_signing → certified → backed_up`, sinks `expired`, `delivery_failed`,
`aborted_peer`, `aborted_coordinator`, `aborted_network`, `incompatible_suite`
(`TERMINAL_PHASES`, lines 104-112).

- **INV-DKG-1 (initial state).** `create` returns `parameters_confirmed` with
  empty participant ledgers, `backupVerified = false`, frozen (lines 171-180).
  Test: exercised by every DKG test head (`courtDkgMachine.test.ts` › 'requires
  every selected participant before transcript certification').
- **INV-DKG-2 (participant ledgers are sets, sorted).** `addSorted` preserves
  set semantics (no duplicates) and ascending order (lines 128-131): each
  participant appears at most once in each of `round1Participants`,
  `round2Participants`, `transcriptCertifiers`.
  Test: `courtDkgMachine.test.ts` › 'is idempotent for identical participant
  progress'.
- **INV-DKG-3 (unanimous round-1 advance).** The phase auto-advances to
  `dkg_round_2` iff `|round1Participants| = |roster|` (lines 237-242) —
  unanimity, not threshold.
  Test: `courtDkgMachine.test.ts` › 'requires every selected participant before
  transcript certification'.
- **INV-DKG-4 (unanimous round-2 before finalization).** `finalize_transcript`
  requires phase `dkg_round_2` AND `|round2Participants| = |roster|`
  (lines 256-261); a threshold-sized subset is explicitly *not* completion.
  Test: `courtDkgMachine.test.ts` › 'does not treat a threshold-sized subset as
  DKG completion'.
- **INV-DKG-5 (transcript well-formedness).** `transcriptHash ∈ HEX_32` and
  `candidateGroupPubkey` matches `GROUP_KEY` = x-only or compressed encoding
  (lines 262-269, regex at 93).
  Test: `courtDkgMachine.test.ts` › 'rejects out-of-roster participants and
  invalid transitions' (encoding guards).
- **INV-DKG-6 (single-transcript unanimity).** A certification of a *different*
  transcript → `aborted_peer` with blame (lines 284-294); `certified` is reached
  iff every roster participant certified the exact same `transcriptHash`
  (lines 295-304) — `certifiedGroupPubkey` is exposed only at that point.
  Tests: `courtDkgMachine.test.ts` › 'aborts with blame when a participant
  certifies another transcript'; `… › 'expires without exposing a group key'`.
- **INV-DKG-7 (backup confirmation is local + post-certification).**
  `confirm_backup` requires phase `certified` (and thus a
  `certifiedGroupPubkey`), is a LOCAL event not bounded by the ceremony
  deadline, and yields `backed_up` with `backupVerified = true` (lines 307-318).
  Test: exercised in the certification-to-backup sequences of
  `courtDkgMachine.test.ts` ('requires every selected participant before
  transcript certification' tail) and `invariantAssertions.test.ts` (certified
  is tick-exempt).
- **INV-DKG-8 (certified is tick-exempt).** `expire` returns the state unchanged
  when `phase = 'certified'` even at/after the deadline (line 148) — a certified
  machine can always still reach `backed_up`.
  Test: `invariantAssertions.test.ts` (cross-machine tick discipline) +
  deadline tests in `courtDkgMachine.test.ts`.
- **INV-DKG-9 (deadline precedence + monotonic clock ledger — F-12 CLOSED in
  v0.9.2).** For every non-terminal phase, tick with `now ≥ deadline` →
  `expired` with the standard reason; all peer events require
  `now ∈ 𝕋 ∧ now < deadline`. As of v0.9.2 the DKG machine ALSO keeps the
  monotonic clock ledger (`latestTimestamp` in state, initialized to 0 at
  creation; restored v0.9.1 snapshots initialize it to 0 on first
  observation): every time-bearing event requires
  `now ≥ state.latestTimestamp` and advances the ledger, and `abort` carries
  no clock — the exact vote-machine pattern (INV-VOTE-4), closing the v0.9.1
  asymmetry (finding F-12) where only per-event deadline precedence held.
  Test: `courtDkgMachine.test.ts` › 'expires without exposing a group key';
  `… › 'monotonic clock ledger (finding F-12)'` tests;
  `invariantAssertions.test.ts` › INV-X-5 tests.
- **INV-DKG-10 (abort whitelist + blame).** As INV-SIGN-13 with the DKG
  `ABORT_PHASES` (lines 96-102, checked 207-209, blame at 212); abort from
  `certified` or terminal throws (201-204).
  Test: `courtDkgMachine.test.ts` › 'rejects abort events with a non-failure
  phase'.
- **INV-DKG-11 (terminal absorption + typed unknowns).** As INV-VOTE-21/FC-2
  (lines 219-221, 320-324).
  Test: `invariantAssertions.test.ts`; `courtDkgMachine.test.ts` › 'rejects
  out-of-roster participants and invalid transitions'.
- **INV-DKG-12 (freeze discipline).** Roster + three participant ledgers +
  failure frozen on every return (lines 119-126).
  Test: `invariantAssertions.test.ts` (all-machines freeze sweep);
  `adversarialMachines.test.ts` (machine tampering suite).

---

## 8. Selection (INV-SEL)

- **INV-SEL-1 (seed determinism).** `deriveSelectionSeed(d, b) =
  SHA-256(bytes(d) ‖ bytes(b))` for `d, b` 32-byte hex — a pure function of the
  dispute anchor (`selection.ts:117-127`).
  Test: `selection.test.ts` › 'deriveSelectionSeed is deterministic'.
- **INV-SEL-2 (random value range).** `jurorRandomValue(seed, pk) ∈ [0, 1)` —
  first four digest bytes as big-endian u32 over 2³² (lines 129-140).
  Test: `selection.test.ts` › 'jurorRandomValue returns a number in [0, 1)'.
- **INV-SEL-3 (exponential-clock semantics).** With `r` uniform on (0,1),
  `-ln(r)/w` is an exponential clock of rate `w`; the minimum clock wins with
  probability `w/Σw` (`weightedPriority`, lines 159-167). Legacy
  `quadraticPriority` is the same clock with `w = √stake` (142-147) — the
  default path is byte-identical to the legacy behaviour.
  Tests: `selectionWeights.test.ts` › 'a 4× weight is drawn ~4× as often over
  many seeds (statistical, tolerance)'; `… › 'without weightFn the panel matches
  the quadraticPriority expectations exactly'`.
- **INV-SEL-4 (weight fail-closed).** `weightedPriority` throws on non-finite or
  non-positive weight; `jurorWeight` throws on negative/non-finite `weightFn`
  output; weight `0` is handled as ineligibility, not an error (lines 159-167,
  176-184, 215).
  Tests: `selectionWeights.test.ts` › 'a zero-weight juror is never drawn';
  weight-validation coverage in `selectionWeights.test.ts`.
- **INV-SEL-5 (eligibility closure).** `filterEligibleJurors` admits exactly the
  jurors satisfying ALL of: `wotScore ≥ min`, `stakeCapacitySats ≥ minStakeSats`,
  `registeredAt ≤ referenceTimeSec` (future registration is fail-closed
  *excluded*, not trusted as old — line 199), age ≥ min, category match,
  `stakeCapacitySats ≥ 1% · marketVolumeSats` unless `zeroStakeAllowed`,
  confirmed stake commitment when present, not excluded, `weightFn(j) > 0` when
  in weight mode (lines 186-218).
  Tests: `selection.test.ts` › 'excludes a juror whose registeredAt is in the
  future (fail-closed age)'; `… › 'selectJury excludes jurors with unconfirmed
  stake commitments'`; `selectionWeights.test.ts` › 'zero-stake juror is
  ineligible without the flag (1%-volume gate holds)' / '… eligible with the
  flag, gate waived only in that mode'.
- **INV-SEL-6 (pool sufficiency).** `selectJury` / `selectJuryWithBackups`
  throw when `|eligible| < jurySize` (lines 258-260, 271-273) — no
  under-filled jury is ever produced.
  Test: `selection.test.ts` › 'selectJury throws when the pool is too small'.
- **INV-SEL-7 (order independence + reproducibility).** The scored sort breaks
  exact-priority ties by pubkey ascending (lines 241-248), so the selected set
  and its idx assignment are independent of pool insertion order and fully
  reproducible from `(disputeEventId, blockHash, pool, params)`.
  Tests: `selection.test.ts` › 'selectJury returns a deterministic subset';
  `regressions.test.ts` › 'selection is reproducible with a fixed
  referenceTimeSec'; `… › 'a juror aging into eligibility does not flip
  verification when anchored'`.
- **INV-SEL-8 (selected/backups disjoint).** `selectJuryWithBackups` partitions
  the top `jurySize + backupCount` into a prefix (selected) and suffix
  (backups) — disjoint by construction (lines 275-282).
  Test: `selection.test.ts` › 'selectJuryWithBackups separates selected and
  backups'.
- **INV-SEL-9 (verification = recomputation, fail-closed).**
  `verifyJurySelection` re-runs `selectJury` and compares pubkey, idx, and
  priority (1e-12 tolerance); ANY thrown error (including an invalid weight)
  yields `false` (lines 294-313).
  Test: `selection.test.ts` › 'verifyJurySelection confirms a valid selection';
  `regressions.test.ts` › 'selection is reproducible…' (anchored time).
  *Precision note (round-16 review, finding A-5):* the 1e-12 float tolerance
  admits a narrow re-ranking window — two *distinct* u32 draws give
  priorities differing by ≈ 2.33e-10/√rate, so the window opens only when
  the rate exceeds ~2.3×10⁵: unreachable at quadratic-mode stakes (rate =
  √stake ⟹ stake > ~5.4×10¹⁰ sats) but reachable in `weightFn` reputation
  mode with very large weights. Exact-integer comparison is registered as
  RS-3 (docs/REVIEW_SIMULATION.md).

---

## 9. Batch attestation (INV-BATCH)

- **INV-BATCH-1 (leaf/node domain separation).** Leaves hash
  `H(BatchLeaf/v1, u8(0x00) ‖ verdictHash)`, interior nodes
  `H(BatchNode/v1, u8(0x01) ‖ left ‖ right)` (lines 110-124): the 0x00/0x01
  prefix plus distinct domains make leaf/node/manifest preimage sets disjoint.
  Test: `invariantAssertions.test.ts` (domain family + prefix constants);
  `propertiesBatch.test.ts` PB1 (independent oracle reproduces roots).
- **INV-BATCH-2 (canonical order).** `buildBatchMerkleTree` sorts verdict hashes
  ascending bytewise (`compareHexBytewise`, lines 137-143, sort at 252) — the
  root is independent of submission order.
  Tests: `batchAttestation.test.ts` › 'is independent of input order (canonical
  bytewise sort)'; `propertiesBatch.test.ts` › 'PB3: root determinism — shuffled
  submission order yields the identical root and leaves'.
- **INV-BATCH-3 (no duplicate verdicts).** Duplicate `verdictHash` inputs are
  rejected — two identical verdicts would make proof indices ambiguous (lines
  242-251).
  Test: `batchAttestation.test.ts` › 'rejects duplicate verdict hashes'.
- **INV-BATCH-4 (batch bounds).** `1 ≤ n ≤ 10 000` leaves, all `HEX_32` (lines
  234-241, 145-153).
  Test: `batchAttestation.test.ts` › 'rejects malformed hex and empty input'.
- **INV-BATCH-5 (RFC-6962 split).** The split point is
  `k = 2^⌊log₂(n−1)⌋` computed in integer arithmetic (lines 130-134) —
  `Math.log2` is not exact for large n.
  Test: `propertiesBatch.test.ts` (independent `oracleSplit` oracle across
  n=1..300).
- **INV-BATCH-6 (proof completeness/soundness).** For every n and every index,
  `foldRoot(path, n, index, leaf)` recomputes exactly the tree root; any
  mutation of a proof byte/sibling/index breaks verification (oracle-checked
  for n=1..300).
  Tests: `batchAttestation.test.ts` › 'covers n=1..8 and every index proof
  verifies against the root'; `… › 'covers n=63/64/65 roots with every index
  proof verifying'`; `propertiesBatch.test.ts` PB1/PB2.
- **INV-BATCH-7 (path-shape check).** `verifyCaseInBatch` requires
  `|path| = expectedPathLength(count, index)` (lines 618-620; expected-length
  oracle 178-191) — a short or long path cannot verify by accident.
  Test: `batchAttestation.test.ts` › 'fails a wrong path length'.
- **INV-BATCH-8 (index bound vs declared count).** `proof.index < count` where
  `count` is the signature-bound tag (lines 610-616).
  Test: `batchAttestation.test.ts` › 'fails a wrong index'.
- **INV-BATCH-9 (manifest binding).**
  `hashBatchManifest = H(BatchManifest/v1, u8(1) ‖ u32(epoch) ‖ cohortPubkey ‖
  u32(batchIndex) ‖ u32(count) ‖ root ‖ u64(finalizedAtSec))` with every field
  validated before encoding (lines 289-312).
  Tests: `batchAttestation.test.ts` › 'is deterministic and field-sensitive';
  'throws on malformed fields'.
- **INV-BATCH-10 (event self-consistency).** `validateBatchAttestationEvent`
  enforces: kind = 39018; all eight required tags present exactly once
  (`uniqueTag`, 315-319); `cohort = p = event.pubkey`; `nonce =
  signature[0:64]`; tag/content JSON consistency; NIP-01 event-id recomputation
  (lines 403-481).
  Tests: `batchAttestation.test.ts` › 'rejects tampered tags and content
  (consistency + id recompute)'; 'rejects a nonce tag that does not match the
  signature'; 'rejects a wrong kind'; 'produces the exact tag shape and a
  deterministic id'.
- **INV-BATCH-11 (signature over the manifest).** The cohort Schnorr signature
  verifies over `hashBatchManifest` (recomputed from tags + pinned
  `finalizedAtSec`), not over the event id (lines 494-521).
  Test: `batchAttestation.test.ts` › 'accepts a correctly signed batch
  attestation' / 'rejects a tampered signature'.
- **INV-BATCH-12 (context pins fail closed).** `expectedGroupPubkey`,
  `expectedEpoch`, `expectedCohort`, `expectedFinalizedAtSec` mismatch ⇒
  `{valid: false}` (lines 483-492).
  Tests: `batchAttestation.test.ts` › 'rejects a wrong group pubkey pin' /
  'wrong epoch pin' / 'wrong cohort pin'; `… › 'accepts another cohort
  self-consistent batch but rejects it under a pin'`.
- **INV-BATCH-13 (totality).** `validateBatchAttestationEvent` NEVER throws on
  hostile events — every answer is `{valid, reason?}`; only malformed *call
  arguments* throw typed `BatchAttestationError` (module contract, lines 17-22;
  enforced by the try/catch 522-527 and argument guards).
  Tests: `propertiesBatch.test.ts` › 'PB6b: validateBatchAttestationEvent NEVER
  throws on hostile events'; 'PB6a: malformed caller input throws the TYPED
  BatchAttestationError'.
- **INV-BATCH-14 (typed-error contract of verifyCaseInBatch).** Malformed call
  arguments throw `BatchAttestationError`; tampered protocol data returns
  `{valid: false, reason}`; the event-shape check happens BEFORE leaf work
  (round-3 finding r3-2, lines 584-593).
  Tests: `batchAttestation.test.ts` › 'throws for malformed call arguments but
  never for tampered data'; `propertiesBatch.test.ts` › 'PB6d (FINDING r3,
  FIXED in 0.9.1): verifyCaseInBatch answers a TYPED { valid:false } for a
  tags-less event whose proof leaf matches'.
- **INV-BATCH-15 (rejection by recomputation).** The proof leaf is recomputed
  from the case inputs via the vote machine's `hashCourtVerdict` — not forked
  and not taken on trust (`caseInput.proof.verdictHash` must equal it, lines
  595-601); any single-field change of the case inputs changes the verdict hash.
  Tests: `batchAttestation.test.ts` › 'fails a case from another batch (wrong
  leaf)' / 'fails a tampered outcome' / 'fails a tampered sessionHash' /
  'fails a tampered supporting event id'; `propertiesBatch.test.ts` › 'PB5:
  rejection is by RECOMPUTATION, not identity'.
- **INV-BATCH-16 (membership scope — documented non-goal).** A batch leaf binds
  the verdict HASH only, not epoch/cohort/session inputs: the same
  `verdictHash` may appear in batches of different epochs and both attestations
  validate. Consumers MUST deduplicate by `verdictHash` before deriving
  reputation (lines 220-229, 546-551). Enforcement is by convention — finding
  F-1.
  Test: `adversarialCrossModule.test.ts` (SEQUENCE-2 cross-batch membership).

---

## 10. Validator (INV-VAL)

- **INV-VAL-1 (kind gate).** Only kind 89 and kind 39007
  (`BAO_COURT_ATTESTATION_KIND`) events are validated (lines 64-66; v2: 389-391).
  Tests: `validator.test.ts` › 'rejects events with the wrong kind';
  `batchAttestation.test.ts` › 'rejects a wrong kind' (39018 gate).
- **INV-VAL-2 (Nostr envelope).** `verifyEvent` (id + Schnorr over the NIP-01
  serialization) must pass before any content is trusted (lines 68-70; v2:
  392-394). Cache semantics of the memoized verdict are derived-state only
  (r3-4 observation, lines 42-56) — finding F-8.
  Tests: `validator.test.ts` › 'rejects a signature that does not verify';
  hostile mutation sweeps in `attestationValidator.adversarial.test.ts`.
- **INV-VAL-3 (unique-tag semantics).** Every protocol tag must appear exactly
  once with a non-empty value; duplicated or absent tags yield `null` and
  reject (`uniqueTag`, lines 32-36, applied 78-85).
  Test: `validator.test.ts` › 'rejects duplicate authority tags and context
  mismatches'.
- **INV-VAL-4 (nonce ≔ signature prefix).** The `nonce` tag must equal the
  R value embedded in the signature (`signature[0:64]`) (lines 100-103; v2:
  434-436; batch: 437-439).
  Tests: `validator.test.ts` › 'rejects a nonce tag that does not match the
  signature' (also `regressions.test.ts:312`).
- **INV-VAL-5 (dispute verdict binding — kind 39007).** A dispute attestation
  must carry a `dispute` tag and a `verdict` tag that EQUALS
  `hashDisputeVerdict(disputeId, outcome, sorted e/mention ids)` recomputed from
  the event's own tags (lines 110-149; v2: 437-471). The FROST signature
  certifies the TALLY, not just an outcome — an attestation for an outcome that
  lost the vote is structurally invalid. Supporting ids: 1..10 000, `HEX_64`
  (any case, lowercased for recomputation), pairwise unique.
  Tests: `validator.test.ts` › 'rejects a dispute attestation that does not bind
  the verdict'; `… › 'rejects a verdict hash substituted after signing without a
  new FROST signature'`; `regressions.test.ts` › 'rejects a kind 39007
  attestation without a dispute tag'.
- **INV-VAL-6 (tag/content consistency).** Every tag value must equal its
  mirror in the JSON content (outcome, marketId, round, disputeEventId,
  verdictHash — and epoch/tier/threshold/signerSetRoot/attempt/batchMerkleRoot
  on v2), with missing-tag ≡ missing-content treated as the same assertion
  (lines 180-203; v2 consistency table 549-566).
  Tests: `validator.test.ts` › 'rejects a verdict whose outcome was changed
  without a new FROST signature'; `propertiesValidator.test.ts` › 'PV2: tamper
  matrix — any single-field mutation invalidates'.
- **INV-VAL-7 (signed message reconstruction).** The content's `message` must
  equal `buildAttestationMessage(marketId, outcome, round, disputeEventId?,
  verdictHash?)` (v1, lines 204-213) or the v2 message with the finality
  extension block (lines 567-582) — the signed digest binds all presented
  fields, under the dedicated attestation-message domains (`crypto.ts:88,100`,
  builders 219-234 / 122-196).
  Tests: `validator.test.ts` › 'rejects a verdict whose outcome was changed…';
  `propertiesValidator.test.ts` PV1/PV2; `regressions.test.ts` ›
  'buildAttestationMessage separates marketId/outcome that alias under |'.
- **INV-VAL-8 (signature verification).** The final Schnorr check verifies
  `(signature, message, p-tag pubkey)` (lines 215-222; v2: 583-590).
  Test: `validator.test.ts` › 'accepts a valid FROST attestation event' /
  'rejects a signature that does not verify'.
- **INV-VAL-9 (context pins).** `expectedGroupPubkey`, `expectedDisputeEventId`,
  `expectedMarketId`, `allowedOutcomes`, `trustedPublisherPubkeys` are enforced
  on BOTH the v1 and v2 paths (v1: 71-76, 151-166; v2: 395-400, 495-510 — the
  v2 dispute/market/outcome pins were the round-1 FINDING-3 fix).
  Tests: `validator.test.ts` › 'validates against an expected group pubkey';
  `propertiesValidator.test.ts` PV1 (pins under matching policy).
- **INV-VAL-10 (v2 required finality tags + bounds).** A v2-shaped event (has an
  `epoch` tag) must carry `epoch/tier/threshold/signers`; `marketId ≤ 1024` B,
  `outcome ≤ 256` B, `round ≤ 64` B; numeric tags parse as bounded safe
  integers; `threshold ≥ 1` (lines 420-433, 473-481; bounds 357-360).
  Tests: `propertiesValidator.test.ts` PV1/PV2; `attestationV2Validator.test.ts`.
- **INV-VAL-11 (signer-set commitment).** `hashSignerSetRoot` commits to the
  sorted, deduplicated index set `u8(1) ‖ u32(k) ‖ indices` under
  `SignerSet/v1`, throwing `CourtSignerSetError` on empty/oversized/non-positive
  /duplicate input (lines 287-312).
  Tests: `propertiesValidator.test.ts` › 'PV3: signer-set root pin equivalence —
  root pin, full-set pin (any order), and both are equivalent'.
- **INV-VAL-12 (signerSet pin ⇒ size = threshold).** When a full `signerSet` is
  supplied it must hash to the `signers` tag AND have length exactly
  `threshold` (lines 526-539).
  Test: `propertiesValidator.test.ts` PV3 ('wrong root/set/size rejected').
- **INV-VAL-13 (no v1 downgrade under v2 policy).** A v1-shaped event (no epoch
  tag) presented with ANY v2-only policy field
  (`expectedEpoch/minTier/minThreshold/expectedSignerSetRoot/
  expectedBatchMerkleRoot/signerSet`) is refused — FINDING-1 fix (lines
  604-657).
  Test: `propertiesValidator.test.ts` › 'PV4: V2_ONLY_POLICY_FIELDS downgrade
  refusal'.
- **INV-VAL-14 (dispatcher shape guard).** `validateCourtAttestation` validates
  `event.tags` is an array BEFORE the epoch-tag dispatch (r3-3, lines 643-648),
  answering the typed `{valid: false}` result instead of a raw TypeError.
  Test: `propertiesValidator.test.ts` › 'PV6 (FINDING r3, FIXED in 0.9.1):
  validateCourtAttestation answers a TYPED invalid result for a tags-less
  event'.
- **INV-VAL-15 (totality on well-shaped events).** Validator entry points never
  throw raw errors on hostile (well-shaped) events; every answer is
  `{valid, pubkey, error?}` (v1 catch 223-229; v2 catch 591-597).
  Test: `propertiesValidator.test.ts` › 'PV5: validator entry points never throw
  raw errors on hostile (well-shaped) events'.
- **INV-VAL-16 (v1 frozen).** The v1 path is byte-frozen: no field bounds and no
  behavioural change; v2 additions live only on the v2 path (section comment,
  lines 248-256; bounds deliberately absent — finding F-6).
  Test: `validator.test.ts` full v1 suite (existing attestations must keep
  verifying).

---

## 11. Cross-machine invariants (INV-X)

Executable pins for this section live in
`__tests__/invariantAssertions.test.ts`.

- **INV-X-1 (hash-domain disjointness).** All exported `BAO-Court/*` domain
  constants are pairwise distinct. Guard: the constants themselves (§1.3); test:
  `invariantAssertions.test.ts` › hash-domain family tests.
- **INV-X-2 (typed error family).** Every exported machine/module error class
  extends `CourtError` (which extends `Error`) and sets `name` to its own
  class name; every instance carries a `code` (and `invariant` when it
  enforces a documented invariant). The full class list is §15 below. Test:
  `invariantAssertions.test.ts` › error-family test.
- **INV-X-3 (terminal-state closure).** For each machine, the terminal phase
  set is a subset of the exported phase union, and every terminal state is
  absorbing: once in a terminal phase, `tick` is phase-preserving (never
  expires, never alters the verdict/failure) and every other event throws the
  machine's typed error. Verified *behaviourally* by driving each machine to
  every terminal phase.
  Test: `invariantAssertions.test.ts` › terminal-absorption tests.
- **INV-X-4 (freeze discipline).** Every state object returned by any
  `create*`/`reduce*` is `Object.isFrozen`, as are its array-valued fields and
  ledger records. Test: `invariantAssertions.test.ts` › freeze sweep across all
  four machines; per-machine tests cited in §4-§7.
- **INV-X-5 (deadline precedence is universal; the monotonic ledger clock is
  too, as of v0.9.2).** Every time-bearing event on every machine satisfies
  `now ∈ 𝕋 ∧ now < (the event's governing deadline)` (INV-CORE-3 applied at
  every peer-facing handler). A monotonic *ledger* clock
  (`latestTimestamp`, non-decreasing, `abort` clock-less) is kept and enforced
  by all four machines — vote (INV-VOTE-4), confirmation (INV-CONF-10),
  signing (INV-SIGN-12), and DKG (INV-DKG-9); the v0.9.1 asymmetry (finding
  F-12, signing/DKG deadline-precedence-only) is closed. Test: per-machine
  rollback tests + `invariantAssertions.test.ts` › INV-X-5 tests.
- **INV-X-6 (roster closure is universal).** Every participant index admitted by
  any machine event is a member of the machine's frozen roster (INV-CORE-4
  applied at every accept path). Test: `invariantAssertions.test.ts` ›
  off-roster rejection sweep.
- **INV-X-7 (quorum/threshold ≤ panel — economic).** On every machine where a
  threshold or quorum exists, `1 ≤ q ≤ |roster|` at creation (INV-CONF-4,
  INV-SIGN-3, session `threshold ≤ participants` at `courtSession.ts:353-358`),
  and every "count enough to proceed" gate compares against distinct roster
  members only (INV-SIGN-10, INV-CONF-15, INV-DKG-3/4 unanimity). Test:
  `invariantAssertions.test.ts` › threshold-range sweep.
- **INV-X-8 (CanonicalWriter totality).** Every writer method either appends
  exactly the specified bytes or throws `CourtSessionValidationError`;
  `finish()` is deterministic and prefix-free (CW-1..3). Test:
  `invariantAssertions.test.ts` › writer tests; `courtSession.test.ts` › 'uses
  length prefixes instead of ambiguous delimiters'.
- **INV-X-9 (compareOutcomeUtf8 = unsigned UTF-8 byte order).** For all string
  pairs, `compareOutcomeUtf8(a, b)` agrees with `Buffer.compare(utf8(a),
  utf8(b))` and is a total order (antisymmetric, transitive). Test:
  `invariantAssertions.test.ts` › comparator oracle sweep; per-machine tie-break
  tests cited in INV-VOTE-16/INV-CONF-25.
- **INV-X-10 (shared verdict domain by design).** The confirmation machine's
  verdict hash and the vote machine's verdict hash are the same function
  `hashCourtVerdict` over `Verdict/v1`; the dispute attestation commitment is
  the separate `DisputeVerdict/v1` function. Test: `invariantAssertions.test.ts`
  › domain-binding test.
- **INV-SETTLE-1 (judge-leaf key contract).** `buildCourtJudgeLeaf({winnerXOnly,
  groupXOnly})` serializes `<winner> CHECKSIGVERIFY <group> CHECKSIG` iff both
  inputs are 32-byte lowercase hex **and** `winner ≠ group`; it refuses a shared
  key (one key in both roles collapses the two-signature conjunction to a
  single party — the authority confusion this document's A6 exists to make
  explicit). The builder is byte-identical to `buildTaprootLeaves`'s judge leaf
  for the same keys, so the contract adds no consensus surface.
  `isCourtJudgeLeaf` compares a persisted leaf to that canonical serialization
  exactly (never a substring search for the key). Guard:
  `liquidEscrow.ts › buildCourtJudgeLeaf`; test:
  `__tests__/liquidEscrow.test.ts` › 'buildCourtJudgeLeaf (attested-spend
  binding)'. **Not covered:** the signing ceremony that produces the two
  signatures — that is A6, host-side.

---

## 12. Traceability matrix

Full invariant ↔ guard ↔ test table. "—" in the test column marks a gap
(findings F-9, F-10).

| ID | Invariant (short) | Guard | Test |
|---|---|---|---|
| INV-CORE-1 | timestamp language | courtCeremonyCore.ts:30 | courtCores.test.ts › assertNow rejects… |
| INV-CORE-2 | deadline language | courtCeremonyCore.ts:109 | courtCores.test.ts › assertPositiveDeadline… |
| INV-CORE-3 | strict deadline precedence | courtCeremonyCore.ts:94 | courtCores.test.ts › assertBeforeDeadline… |
| INV-CORE-4 | roster membership closure | courtCeremonyCore.ts:41 | courtCores.test.ts › assertRosterMember… |
| INV-CORE-5 | UTF-8 round trip | courtCeremonyCore.ts:64 | adversarialMachines.test.ts › lone-surrogate suite |
| INV-CORE-6 | roster = [1..n], n ≤ 10000 | courtCeremonyCore.ts:125 | courtCores.test.ts › normalizeCeremonyRoster… |
| INV-CORE-7 | blame well-formedness | courtCeremonyCore.ts:155 | courtCores.test.ts › assertBlamedIdx… |
| INV-CORE-8 | HEX_32 language | courtCeremonyCore.ts:22 | courtCores.test.ts › HEX_32…; invariantAssertions.test.ts |
| INV-VOTE-1 | initial state | courtVoteMachine.ts:448 | courtVoteMachine.test.ts › tallies only committed reveals… |
| INV-VOTE-2 | creation balloting | courtVoteMachine.ts:403-447 | courtVoteMachine.test.ts › rejects outcomes…; adversarialMachines.test.ts › 256-byte bound |
| INV-VOTE-3 | phase-exact guards | courtVoteMachine.ts:526,560,571,580,638,651 | courtVoteMachine.test.ts (per-event) |
| INV-VOTE-4 | clock monotonicity | courtVoteMachine.ts:483-489 | courtVoteMachine.test.ts › rejects timestamp rollback… |
| INV-VOTE-5 | commit window | courtVoteMachine.ts:524 | courtVoteMachine.test.ts › …commits after the deadline |
| INV-VOTE-6 | close/open boundaries | courtVoteMachine.ts:563,570,641 | courtVoteMachine.test.ts › rejects opening vote reveals at or after… |
| INV-VOTE-7 | conservative tick expiry | courtVoteMachine.ts:491-508 | courtVoteMachine.test.ts › does not expire reveal_closed… |
| INV-VOTE-8 | one commit per idx | courtVoteMachine.ts:544-552 | courtVoteMachine.test.ts › allows exactly one commit… |
| INV-VOTE-9 | commit form + version bit | courtVoteMachine.ts:529-543 | invariantAssertions.test.ts › version bit + legacy rejection |
| INV-VOTE-10 | session-bound commit hash | courtVoteMachine.ts:151-186 | courtVoteMachine.test.ts › validates vote-commit…; adversarialMachines.test.ts › commits swapped… |
| INV-VOTE-11 | one reveal per idx; unique ids | courtVoteMachine.ts:615-627,337-368 | adversarialMachines.test.ts › spread-revived ABORTED machine… |
| INV-VOTE-12 | reveal ⊨ commit | courtVoteMachine.ts:599-614 | courtVoteMachine.test.ts › rejects reveals that do not match… |
| INV-VOTE-13 | ballot closure | courtVoteMachine.ts:588 | courtVoteMachine.test.ts › rejects outcomes outside… |
| INV-VOTE-14 | reveal capacity 10k | courtVoteMachine.ts:583-587 | — (F-10) |
| INV-VOTE-15 | ledger barrier ×2 | courtVoteMachine.ts:646,657 | adversarialMachines.test.ts › spread-revived ABORTED… |
| INV-VOTE-16 | plurality + UTF-8 tie-break | courtVoteMachine.ts:661-677,131-140 | courtVoteMachine.test.ts › breaks ties… (×2) |
| INV-VOTE-17 | verdict support conservation | courtVoteMachine.ts:658-683 | adversarialMachines.test.ts › reveals reordered… |
| INV-VOTE-18 | verdict hash binding | courtVoteMachine.ts:221-228 | courtVoteMachine.test.ts › tallies only committed reveals… |
| INV-VOTE-19 | dispute verdict order-independence | courtVoteMachine.ts:288 | validator.test.ts › accepts a well-formed dispute attestation |
| INV-VOTE-20 | tally determinism | courtVoteMachine.ts:650-694 | adversarialMachines.test.ts › reveals reordered… |
| INV-VOTE-21 | terminal absorption | courtVoteMachine.ts:496-521 | invariantAssertions.test.ts; courtVoteMachine.test.ts › expires after… |
| INV-VOTE-22 | abort discipline | courtVoteMachine.ts:509-518 | invariantAssertions.test.ts |
| INV-VOTE-23 | freeze discipline | courtVoteMachine.ts:310-323 | courtVoteMachine.test.ts › freezes configuration…; adversarialMachines.test.ts › deep-freezes… |
| INV-CONF-1 | initial state | courtConfirmationMachine.ts:650-669 | courtConfirmationMachine.test.ts › starts in confirm_open… |
| INV-CONF-2 | panel ≥ 3 | courtConfirmationMachine.ts:586-590 | propertiesConfirmation.test.ts › P6 r3-6 |
| INV-CONF-3 | proposal ∈ ballot | courtConfirmationMachine.ts:591-611 | courtConfirmationMachine.test.ts › requires the proposal… |
| INV-CONF-4 | quorum range | courtConfirmationMachine.ts:621-630 | courtConfirmationMachine.test.ts › bounds the quorum… |
| INV-CONF-5 | deadline ordering | courtConfirmationMachine.ts:631-639 | courtConfirmationMachine.test.ts › requires the challenge deadline… |
| INV-CONF-6 | ladder cap 1..5 | courtConfirmationMachine.ts:640-649 | multiRoundLadder.test.ts › bounds the parameter… |
| INV-CONF-7 | evidence bound | courtConfirmationMachine.ts:612-620 | courtConfirmationMachine.test.ts › validates evidence ids |
| INV-CONF-8 | confirmation hash binding | courtConfirmationMachine.ts:303-326 | courtConfirmationMachine.test.ts › derives the canonical…; replay-proof… |
| INV-CONF-9 | confirmation ⊨ binding (+barrier) | courtConfirmationMachine.ts:753-762,501-510 | courtConfirmationMachine.test.ts › rejects a confirmation hash…; adversarialCrossModule.test.ts |
| INV-CONF-10 | clock monotonicity | courtConfirmationMachine.ts:698-706 | courtConfirmationMachine.test.ts › rejects clock rollback |
| INV-CONF-11 | phase-exact guards | courtConfirmationMachine.ts:744-1129 | courtConfirmationMachine.test.ts + multiRoundLadder.test.ts |
| INV-CONF-12 | window boundaries | courtConfirmationMachine.ts:749,790,821,859,915,950 | courtConfirmationMachine.test.ts › rejects closing the confirm window… etc. |
| INV-CONF-13 | tick deadline table | courtConfirmationMachine.ts:290-295,708-727 | courtConfirmationMachine.test.ts › expires awaiting-input phases…; multiRoundLadder.test.ts › round_resolved tick-exempt |
| INV-CONF-14 | terminal absorption + abort | courtConfirmationMachine.ts:729-741 | courtConfirmationMachine.test.ts › aborts from any non-terminal phase… |
| INV-CONF-15 | quorum gate (economic) | courtConfirmationMachine.ts:795-801 | courtConfirmationMachine.test.ts › fails closed when the confirm quorum never formed |
| INV-CONF-16 | one confirmation per idx | courtConfirmationMachine.ts:768-776,511-520 | courtConfirmationMachine.test.ts › treats identical redelivery… |
| INV-CONF-17 | challenge bond binding | courtConfirmationMachine.ts:823-843 | courtConfirmationMachine.test.ts › rejects challenges after the deadline… |
| INV-CONF-18 | no-challenge routing | courtConfirmationMachine.ts:864-874 | courtConfirmationMachine.test.ts › routes to fee_settlement… |
| INV-CONF-19 | consecutive rounds + cap | courtConfirmationMachine.ts:882-897 | multiRoundLadder.test.ts › hand-restored snapshots…; courtConfirmationMachine.test.ts › enforces consecutive rounds… |
| INV-CONF-20 | round deadline validity | courtConfirmationMachine.ts:898-899 | courtConfirmationMachine.test.ts › enforces consecutive rounds… |
| INV-CONF-21 | round-panel language | courtConfirmationMachine.ts:352-365,444 | multiRoundLadder.test.ts › rejects malformed round rosters…; does NOT require superset… |
| INV-CONF-22 | one vote per idx per round | courtConfirmationMachine.ts:928-936,458-467 | courtConfirmationMachine.test.ts › rejects votes outside the allowlist… |
| INV-CONF-23 | mass-vote ledger barrier | courtConfirmationMachine.ts:955,963 | adversarialMachines.test.ts › ABORTED machine…ladder phases… |
| INV-CONF-24 | non-empty round | courtConfirmationMachine.ts:965-967 | courtConfirmationMachine.test.ts › fails closed when closing a round with zero votes |
| INV-CONF-25 | round majority + shared tie-break | courtConfirmationMachine.ts:968-987 | courtConfirmationMachine.test.ts › resolves a majority; breaks tallies deterministically… |
| INV-CONF-26 | outcomeHistory append-only + restore barrier (F-3 closed v0.9.2) | courtConfirmationMachine.ts resolve_round/finalize + assertValidOutcomeHistory | multiRoundLadder.test.ts › records append-only frozen…; courtConfirmationMachine.test.ts › outcome-history restore barrier… |
| INV-CONF-27 | overturn clawback idempotent | courtConfirmationMachine.ts:1001-1015 | courtConfirmationMachine.test.ts › flags every confirming juror…; multiRoundLadder.test.ts › does not duplicate… |
| INV-CONF-28 | flip-flop clawback idempotent | courtConfirmationMachine.ts:1016-1033 | multiRoundLadder.test.ts › flags the previous round's majority… |
| INV-CONF-29 | escalation gating | courtConfirmationMachine.ts:1039-1042,1062-1066 | multiRoundLadder.test.ts › escalate/concede decision matrix |
| INV-CONF-30 | fee ledger idempotency + cap | courtConfirmationMachine.ts:1082-1093 | adversarialMachines.test.ts › MAX_FEES boundaries |
| INV-CONF-31 | explicit clawback discipline | courtConfirmationMachine.ts:1095-1126 | courtConfirmationMachine.test.ts › accepts explicit clawback flags… |
| INV-CONF-32 | finality = last round | courtConfirmationMachine.ts:1145-1155 | multiRoundLadder.test.ts › finality = LAST resolved round… |
| INV-CONF-33 | non-empty final support (r3-1) | courtConfirmationMachine.ts:1156-1169 | propertiesConfirmation.test.ts › P6 r3-1 |
| INV-CONF-34 | flags ∉ verdict inputs | courtConfirmationMachine.ts:1132-1174 | adversarialCrossModule.test.ts › re-finalizing…IDENTICAL verdictHash |
| INV-CONF-35 | verdict domain reuse | courtConfirmationMachine.ts:1170-1174 | invariantAssertions.test.ts › domain-binding test |
| INV-CONF-36 | freeze discipline | courtConfirmationMachine.ts:398-429 | courtConfirmationMachine.test.ts › freezes state…; adversarialMachines.test.ts › deep-freezes… |
| INV-SIGN-1 | signing session binding | courtSigningMachine.ts:165-189 | courtSigningMachine.test.ts › binds the signing session hash… |
| INV-SIGN-2 | state ⇄ binding consistency | courtSigningMachine.ts:219-236,382 | adversarialMachines.test.ts › re-derives the signing session hash… |
| INV-SIGN-3 | threshold range | courtSigningMachine.ts:331-342 | courtSigningMachine.test.ts (creation); invariantAssertions.test.ts |
| INV-SIGN-4 | one commitment per signer | courtSigningMachine.ts:444-457 | courtSigningMachine.test.ts › allows exactly one nonce commitment… |
| INV-SIGN-5 | nonce points on curve | courtSigningMachine.ts:441-443; crypto.ts:297-305 | regressions.test.ts › aggregatePublicNonce matches… |
| INV-SIGN-6 | commitment set ⇔ threshold | courtSigningMachine.ts:473-478 | courtSigningMachine.test.ts › cannot finalize a commitment set below threshold |
| INV-SIGN-7 | signer-set closure | courtSigningMachine.ts:259-270,487-491 | courtSigningMachine.test.ts › accepts partial signatures only from… |
| INV-SIGN-8 | one partial per signer; equivocation aborts | courtSigningMachine.ts:272-294,501-513 | courtSigningMachine.test.ts › aborts with blame on conflicting partials |
| INV-SIGN-9 | partial form | courtSigningMachine.ts:493-500 | adversarialParserFuzz.test.ts › frost-reveal with oversized psig… |
| INV-SIGN-10 | aggregate threshold over distinct signers | courtSigningMachine.ts:534-541 | courtSigningMachine.test.ts › runs the full attempt…; rejects restored state with duplicate… |
| INV-SIGN-11 | publish requires aggregate | courtSigningMachine.ts:545-553 | courtSigningMachine.test.ts › runs the full attempt… |
| INV-SIGN-12 | deadline precedence + monotonic clock ledger (F-12 closed v0.9.2) | courtSigningMachine.ts reducer clock-ledger block | courtSigningMachine.test.ts › monotonic clock ledger (finding F-12)…; invariantAssertions.test.ts › INV-X-5 |
| INV-SIGN-13 | abort whitelist + blame | courtSigningMachine.ts:406-411 | courtSigningMachine.test.ts › rejects abort events with a non-failure phase |
| INV-SIGN-14 | terminal absorption | courtSigningMachine.ts:418-420 | invariantAssertions.test.ts |
| INV-SIGN-15 | freeze discipline | courtSigningMachine.ts:150-159 | adversarialMachines.test.ts › deep-freezes every returned state (signing) |
| INV-DKG-1 | initial state | courtDkgMachine.ts:171-180 | courtDkgMachine.test.ts › requires every selected participant… |
| INV-DKG-2 | participant ledgers are sorted sets | courtDkgMachine.ts:128-131 | courtDkgMachine.test.ts › is idempotent for identical… |
| INV-DKG-3 | unanimous round-1 advance | courtDkgMachine.ts:237-242 | courtDkgMachine.test.ts › requires every selected participant… |
| INV-DKG-4 | unanimous round-2 before finalize | courtDkgMachine.ts:256-261 | courtDkgMachine.test.ts › does not treat a threshold-sized subset… |
| INV-DKG-5 | transcript/group-key form | courtDkgMachine.ts:262-269,93 | courtDkgMachine.test.ts › rejects out-of-roster… and invalid transitions |
| INV-DKG-6 | single-transcript unanimity | courtDkgMachine.ts:284-304 | courtDkgMachine.test.ts › aborts with blame…; expires without exposing a group key |
| INV-DKG-7 | backup local + post-certification | courtDkgMachine.ts:307-318 | invariantAssertions.test.ts › certified tick-exempt |
| INV-DKG-8 | certified is tick-exempt | courtDkgMachine.ts:148 | invariantAssertions.test.ts |
| INV-DKG-9 | deadline precedence + monotonic clock ledger (F-12 closed v0.9.2) | courtDkgMachine.ts reducer clock-ledger block | courtDkgMachine.test.ts › monotonic clock ledger (finding F-12)…; invariantAssertions.test.ts › INV-X-5 |
| INV-DKG-10 | abort whitelist + blame | courtDkgMachine.ts:207-212 | courtDkgMachine.test.ts › rejects abort events with a non-failure phase |
| INV-DKG-11 | terminal absorption + typed unknowns | courtDkgMachine.ts:219-221,320-324 | invariantAssertions.test.ts |
| INV-DKG-12 | freeze discipline | courtDkgMachine.ts:119-126 | invariantAssertions.test.ts › freeze sweep |
| INV-SEL-1 | seed determinism | selection.ts:117-127 | selection.test.ts › deriveSelectionSeed is deterministic |
| INV-SEL-2 | random value ∈ [0,1) | selection.ts:129-140 | selection.test.ts › jurorRandomValue returns… |
| INV-SEL-3 | exponential-clock semantics | selection.ts:142-167 | selectionWeights.test.ts › 4× weight…; without weightFn… |
| INV-SEL-4 | weight fail-closed | selection.ts:159-184,215 | selectionWeights.test.ts › a zero-weight juror is never drawn |
| INV-SEL-5 | eligibility closure | selection.ts:186-218 | selection.test.ts › future registeredAt…; unconfirmed stake…; selectionWeights.test.ts › zero-stake gates |
| INV-SEL-6 | pool sufficiency | selection.ts:258-260,271-273 | selection.test.ts › selectJury throws when the pool is too small |
| INV-SEL-7 | order independence + reproducibility | selection.ts:241-248 | selection.test.ts › deterministic subset; regressions.test.ts › reproducible with a fixed referenceTimeSec |
| INV-SEL-8 | selected ∩ backups = ∅ | selection.ts:275-282 | selection.test.ts › selectJuryWithBackups separates… |
| INV-SEL-9 | verification = recomputation | selection.ts:294-313 | selection.test.ts › verifyJurySelection confirms… |
| INV-BATCH-1 | leaf/node domain separation | batchAttestation.ts:110-124 | invariantAssertions.test.ts; propertiesBatch.test.ts PB1 |
| INV-BATCH-2 | canonical order | batchAttestation.ts:252,137-143 | batchAttestation.test.ts › independent of input order; propertiesBatch.test.ts PB3 |
| INV-BATCH-3 | no duplicate verdicts | batchAttestation.ts:242-251 | batchAttestation.test.ts › rejects duplicate verdict hashes |
| INV-BATCH-4 | batch bounds | batchAttestation.ts:234-241,145-153 | batchAttestation.test.ts › rejects malformed hex and empty input |
| INV-BATCH-5 | RFC-6962 split (integer-exact) | batchAttestation.ts:130-134 | propertiesBatch.test.ts (oracleSplit) |
| INV-BATCH-6 | proof completeness/soundness | batchAttestation.ts:156-211 | batchAttestation.test.ts › covers n=1..8 / 63/64/65; propertiesBatch.test.ts PB1/PB2 |
| INV-BATCH-7 | path-shape check | batchAttestation.ts:618-620,178-191 | batchAttestation.test.ts › fails a wrong path length |
| INV-BATCH-8 | index bound vs count | batchAttestation.ts:610-616 | batchAttestation.test.ts › fails a wrong index |
| INV-BATCH-9 | manifest binding | batchAttestation.ts:289-312 | batchAttestation.test.ts › deterministic and field-sensitive; throws on malformed fields |
| INV-BATCH-10 | event self-consistency | batchAttestation.ts:403-481 | batchAttestation.test.ts › rejects tampered tags and content… |
| INV-BATCH-11 | signature over manifest | batchAttestation.ts:494-521 | batchAttestation.test.ts › accepts a correctly signed batch attestation |
| INV-BATCH-12 | context pins fail closed | batchAttestation.ts:483-492 | batchAttestation.test.ts › rejects a wrong group pubkey pin… |
| INV-BATCH-13 | totality (never throws) | batchAttestation.ts:522-527 | propertiesBatch.test.ts PB6b |
| INV-BATCH-14 | typed-error contract (r3-2) | batchAttestation.ts:584-593 | propertiesBatch.test.ts PB6a/PB6d; batchAttestation.test.ts › throws for malformed call arguments… |
| INV-BATCH-15 | rejection by recomputation | batchAttestation.ts:595-601 | batchAttestation.test.ts › fails a tampered outcome…; propertiesBatch.test.ts PB5 |
| INV-BATCH-16 | membership scope (documented) | batchAttestation.ts:220-229,546-551 | adversarialCrossModule.test.ts SEQUENCE-2 (convention) |
| INV-VAL-1 | kind gate | validator.ts:64-66,389-391 | validator.test.ts › rejects events with the wrong kind |
| INV-VAL-2 | Nostr envelope | validator.ts:68-70,392-394 | validator.test.ts › rejects a signature that does not verify |
| INV-VAL-3 | unique-tag semantics | validator.ts:32-36,78-85 | validator.test.ts › rejects duplicate authority tags… |
| INV-VAL-4 | nonce ≔ signature prefix | validator.ts:100-103,434-436 | validator.test.ts › rejects a nonce tag that does not match… |
| INV-VAL-5 | dispute verdict binding | validator.ts:110-149,437-471 | validator.test.ts › rejects a dispute attestation that does not bind the verdict |
| INV-VAL-6 | tag/content consistency | validator.ts:180-203,549-566 | validator.test.ts › rejects a verdict whose outcome was changed…; propertiesValidator.test.ts PV2 |
| INV-VAL-7 | signed message reconstruction | validator.ts:204-213,567-582; crypto.ts:219-234,122-196 | propertiesValidator.test.ts PV1/PV2; regressions.test.ts › buildAttestationMessage separates… |
| INV-VAL-8 | signature verification | validator.ts:215-222,583-590 | validator.test.ts › accepts a valid FROST attestation event |
| INV-VAL-9 | context pins (v1+v2) | validator.ts:162-177,515-530 | validator.test.ts › validates against an expected group pubkey; propertiesValidator.test.ts PV1 |
| INV-VAL-10 | v2 required tags + bounds | validator.ts:420-433,473-481,357-360 | propertiesValidator.test.ts PV1/PV2; attestationV2Validator.test.ts |
| INV-VAL-11 | signer-set commitment | validator.ts:287-312 | propertiesValidator.test.ts PV3 |
| INV-VAL-12 | signerSet pin ⇒ size = threshold | validator.ts:526-539 | propertiesValidator.test.ts PV3 |
| INV-VAL-13 | no v1 downgrade under v2 policy | validator.ts:604-657 | propertiesValidator.test.ts PV4 |
| INV-VAL-14 | dispatcher shape guard (r3-3) | validator.ts:643-648 | propertiesValidator.test.ts PV6 |
| INV-VAL-15 | totality on well-shaped events | validator.ts:223-229,591-597 | propertiesValidator.test.ts PV5 |
| INV-VAL-16 | v1 frozen | validator.ts:248-256 | validator.test.ts (v1 suite) |
| INV-X-1 | hash-domain disjointness | §1.3 constants | invariantAssertions.test.ts › hash-domain family |
| INV-X-2 | typed error family | per-module classes | invariantAssertions.test.ts › error family |
| INV-X-3 | terminal-state closure | TERMINAL_PHASES per machine | invariantAssertions.test.ts › terminal absorption |
| INV-X-4 | freeze discipline (all machines) | per-machine freeze fns | invariantAssertions.test.ts › freeze sweep |
| INV-X-5 | universal deadline precedence + universal ledger clock (F-12 closed v0.9.2) | per-machine clock guards | invariantAssertions.test.ts › INV-X-5 |
| INV-X-6 | universal roster closure | assertRosterMember call sites | invariantAssertions.test.ts › off-roster sweep |
| INV-X-7 | quorum/threshold ≤ panel | courtConfirmationMachine.ts:621-630; courtSigningMachine.ts:331-342; courtSession.ts:353-358 | invariantAssertions.test.ts › threshold sweep |
| INV-X-8 | CanonicalWriter totality | courtSession.ts:389-451 | invariantAssertions.test.ts › writer tests; courtSession.test.ts › length prefixes… |
| INV-X-9 | compareOutcomeUtf8 = UTF-8 byte order | courtVoteMachine.ts:131-140 | invariantAssertions.test.ts › comparator oracle |
| INV-X-10 | shared verdict domain by design | courtConfirmationMachine.ts:18-27,1170 | invariantAssertions.test.ts › domain binding |
| INV-SETTLE-1 | judge-leaf key contract (winner ≠ group, byte-identical to legacy) | liquidEscrow.ts › buildCourtJudgeLeaf | liquidEscrow.test.ts › buildCourtJudgeLeaf (attested-spend binding) |

---

## 13. Findings

Invariants that are documented conventions rather than enforced guards, or that
lack an enforcing test. Ordered by audit significance.

- **F-1 (batch membership scope is caller duty).** A batch leaf commits to the
  verdict hash only — not epoch, cohort, or session inputs. The same
  `verdictHash` can appear in batches of different epochs and both kind-39018
  attestations validate; deduplication by `verdictHash` before deriving
  reputation is enforced only by convention (INV-BATCH-16,
  `batchAttestation.ts:220-229`). A consumer that skips the dedup double-counts
  silently. No structural guard is possible without changing the leaf format.
- **F-2 (group-key pin is opt-in and falsy-fragile — CLOSED in v0.9.2).** Both
  validators and the batch validator enforced `expectedGroupPubkey` only when
  truthy, so a present-but-empty pin (`''`, e.g. an unset config joined into
  an empty string) silently disabled the pin. Fixed: a present-but-empty pin
  is now INVALID on all four entry points (`validateAttestationEvent`,
  `validateAttestationEventV2`, `validateCourtAttestation`,
  `validateBatchAttestationEvent`) — typed-invalid
  (`expectedGroupPubkey pin must be a non-empty group pubkey`), never treated
  as "no pin". The absent case is unchanged. Enforced by
  `validator.test.ts` / `batchAttestation.test.ts` › empty-pin tests. No
  remaining gap.
- **F-3 (outcomeHistory is not barrier-verified on restore — CLOSED in
  v0.9.2).** The confirmation machine's ledger barriers re-verified
  `confirmations`, `challenges`, mass votes, and round rosters — but
  `outcomeHistory` records were trusted as-is on a restored snapshot, and
  `resolve_round` consumes `previous.winnerIndices` to direct `round_flip`
  clawbacks, so a forged history could aim clawbacks at arbitrary indices.
  Fixed: `assertValidOutcomeHistory` (consecutive 1..k round sequence, ballot
  closure, unique well-formed winner event ids, unique valid winner indices)
  now runs at `resolve_round` and `finalize` (INV-CONF-26). No remaining gap.
- **F-4 (clawback reason language is open).** `flag_clawback` accepts any
  non-empty reason ≤ 64 bytes (`courtConfirmationMachine.ts:1102-1108`); the two
  protocol reasons (`overturned_confirmation`, `round_flip`) are not enforced as
  the only machine-generated values (they *are* the only values the reducer
  itself writes). Host policy may legitimately add reasons; the invariant
  "machine-generated flags carry only protocol reasons" holds by construction
  but is untested.
- **F-5 (weightFn purity is unenforceable).** `verifyJurySelection` recomputes
  the draw with the *caller's* `weightFn`; a non-pure or non-identical function
  makes verification vacuous (`selection.ts:294-313` docstring). Documented
  contract only; a snapshot-pinned `reputationRoot` is the planned structural
  fix (`selection.ts:43-48`).
- **F-6 (v1 validator is unbounded by design).** The frozen v1 path imposes no
  field-length bounds (`validator.ts:248-256`); a hostile kind-89 event can
  carry megabyte-scale fields through hashing. Byte-compatibility forbids
  tightening; v2 bounds (INV-VAL-10) cover the new path only.
- **F-7 (selection seed sits outside the CanonicalWriter grammar).**
  `deriveSelectionSeed` and `jurorRandomValue` hash raw fixed-length
  concatenations without a domain tag (`selection.ts:117-140`). Unambiguous
  *because* the inputs are fixed-length 32-byte hex — but any future
  variable-length input must migrate to the writer (INV-X-8) or accept
  aliasing risk.
- **F-8 (verifyEvent memoization is caller-visible).** nostr-tools caches its
  verdict on the event object under a symbol key; in-place mutation of a
  previously verified event re-presents the stale verdict (r3-4 observation,
  `validator.ts:42-56`). Spread-clones are safe by construction; the residual
  hazard is documented, not enforced.
- **F-9 (commit version-bit rejection — CLOSED in this round).** The legacy
  commit format rejection (`courtVoteMachine.ts:539-543`) had no dedicated
  machine-level test (coverage was implicit through well-formed fixtures).
  `__tests__/invariantAssertions.test.ts` now pins both sides: every
  `hashCourtVoteCommit` output carries the `0x8` version bit, and a
  version-bit-stripped (legacy sessionless) commit hash is rejected by
  `accept_commit` with the machine's typed error. No remaining gap.
- **F-10 (capacity bounds lack boundary tests).** `MAX_REVEALS`
  (`courtVoteMachine.ts:583-587`), `MAX_CONFIRMATIONS`, `MAX_MASS_VOTES`, and
  `MAX_CLAWBACK_FLAGS` (confirmation machine) are structurally unreachable via
  legal paths (roster ≤ 10 000 with per-idx uniqueness), so no test drives them;
  only `MAX_FEES` (reachable at 256) has a boundary test. The guards remain
  correct defense-in-depth against tampered snapshots.
- **F-11 (SIGN accept_partial has a redundant first regex).**
  `courtSigningMachine.ts:493-500` checks `/^[0-9a-fA-F]{64}$/` and then
  `HEX_32`; the first check is subsumed by the second (the error messages
  differ, so both are observable). Harmless; noted for precision.
- **F-12 (the monotonic clock ledger existed on only two of four machines —
  CLOSED in v0.9.2).** The vote and confirmation machines kept a
  `latestTimestamp` ledger and rejected any event whose clock precedes an
  earlier-observed one (INV-VOTE-4, INV-CONF-10); the signing and DKG
  machines enforced per-event deadline precedence only, so an
  old-timestamped replay into a restored state was admissible where the vote
  machines would reject it. Fixed: both machines now keep the identical
  ledger — `latestTimestamp` in state, `assertNow` + non-decreasing check on
  every time-bearing event, `abort` clock-less, tick/terminal semantics
  unchanged (INV-SIGN-12, INV-DKG-9, INV-X-5). Minor-compatible: v0.9.1
  snapshots without the field initialize it to 0 on restore. No remaining
  asymmetry.

- **F-13 (the settlement binding is not an invariant of any machine — A6).**
  Every machine in this document is a message machine; none of them touches an
  escrow. The shipped judge leaf (`<winner> CHECKSIGVERIFY <judge> CHECKSIG`)
  verifies a *transaction* signature, while the court produces a signature over
  a *Nostr* attestation message (`buildAttestationMessage`) — so nothing
  in-script ties a verdict to a spend, and v1 releases through a host that
  validates the attestation first. That makes the platform a release authority
  (it cannot fabricate or alter a verdict, but it can release without one and
  can choose among several valid verdicts) and makes the justifying assumption
  A6, stated in §1.5 rather than hidden. Partial guard: INV-SETTLE-1 pins the
  judge-leaf key contract. The protocol-side fix (spend-session binding +
  signer policy) and the Liquid-only `CHECKSIGFROMSTACK` leaf are specified
  with their gates in `docs/SETTLEMENT-BINDING.md` §2 and §4.

---

## 14. Verification

- **Cross-check:** `docs/CROSS_CHECK.md` is the per-claim verification index
  for every invariant in this document (file + exact test name / bench id /
  model-check instance), machine-verified by `scripts/cross-check.mjs` —
  the pointers below are re-verified against the tree there.
- Full suite: `npm test` (vitest) — all green including
  `__tests__/invariantAssertions.test.ts` (27 always-on global assertions).
- Typecheck: `npm run typecheck && npm run typecheck:tests`.
- The invariant count: 8 core + 23 vote + 36 confirmation + 15 signing +
  12 DKG + 9 selection + 16 batch + 16 validator + 10 cross-machine =
  **145 stated invariants**, each with an enforcement pointer; 137 pinned by a
  pre-existing named test, and the cross-machine/global set pinned by the 27
  executable assertions of `invariantAssertions.test.ts`. Twelve findings
  (F-1…F-12) were recorded against v0.9.1; as of v0.9.2, F-2, F-3, F-9, and
  F-12 are CLOSED (enforced guards + regression tests), and F-10/F-11 remain
  documented-only (F-10 guards are unreachable defense-in-depth, F-11 is
  harmless redundancy).

---

## 15. Error taxonomy (v0.10.1)

Every error thrown across the package boundary is a `CourtError` (`errors.ts`)
— no plain `Error` escapes. The model has three axes, each independently
holdable:

1. **Class** — how to `catch`. All 30 exported classes extend `CourtError`.
2. **`code`** — what happened, machine-readable. New codes are
   SCREAMING_SNAKE; the pre-existing per-class code unions keep their
   historical lowercase values (compat is additive — existing `err.code`
   consumers are unaffected).
3. **`invariant`** — the INV-* id the error enforces, when it enforces one
   (populated on selected sites; available on every class via
   `CourtErrorOptions`).

Cause-chaining is preserved: `{ cause }` flows into `Error(message, { cause })`.

`errors.ts` holds the whole hierarchy; domain modules import their class.
Legacy classes keep their names, constructors, and code-union values — the
graft is behavior-preserving except that `instanceof CourtError` is now also
true.

### 15.1 Base classes

| Class | Constructor | Meaning |
|---|---|---|
| `CourtError` | `(code, message, { cause?, invariant? }?)` | Abstract base of the taxonomy: `code` always present |
| `CourtArgumentError` | `(code, message, options?)` | Caller-bug argument validation (shape/range/encoding of caller-supplied input) |

### 15.2 Code registry

| Code | Class | Thrown from | Invariants enforced |
|---|---|---|---|
| `ARGUMENT_INVALID` | `CourtArgumentError` | default code (rarely used; sites pass a domain-prefixed code) | — |
| `BATCH_ATTESTATION` | `BatchAttestationError` | batchAttestation.ts (14 sites) | INV-BATCH-3 (duplicate verdicts) |
| `CONFIRMATION_TRANSITION` | `CourtConfirmationTransitionError` | courtConfirmationMachine.ts | INV-CONF-3/5/6/7/9… (illegal edges, deadlines, ledgers) |
| `SIGNING_TRANSITION` | `CourtSigningTransitionError` | courtSigningMachine.ts | INV-SIGN-3/10/12/13 (edges, deadlines, aborts) |
| `DKG_TRANSITION` | `CourtDkgTransitionError` | courtDkgMachine.ts | INV-DKG-3/4/9/10/11 (edges, deadlines, aborts) |
| `VOTE_TRANSITION` | `CourtVoteTransitionError` | courtVoteMachine.ts | INV-VOTE-3/5/6/7/8/11… (edges, windows, ledgers) |
| `EPOCH_COHORT` | `CourtEpochCohortError` | epochCohort.ts | epoch cohort well-formedness |
| `SIGNER_SET` | `CourtSignerSetError` | validator.ts | INV-VAL signer-set commitments |
| `DKG_ARGUMENT` / `DKG_STATE` | `CourtDkgError` | dkg.ts (30 sites) | refresh preserves the group key; transcript well-formedness |
| `IDKG_ARGUMENT` / `IDKG_STATE` | `IndependentDkgError` | independentDkg.ts (27 sites) | mirror of dkg.ts (differential-parity twin) |
| `ISIGN_ARGUMENT` / `ISIGN_STATE` | `IndependentSigningError` | independentSigning.ts (6 sites) | mirror of signing.ts |
| `FROST_SIGNING` | `FrostSigningError` | signing.ts (7 sites) | nonce-reuse guard, signature verification |
| `SELECTION_ARGUMENT` / `SELECTION_STATE` | `CourtSelectionError` | selection.ts (7 sites) | INV-SEL-4 (weight fail-closed), INV-SEL-6 (pool sufficiency) |
| `ESCROW_ARGUMENT` / `ESCROW_LEDGER` | `EscrowLedgerError` | escrow.ts (13 sites) | ledger status machine + snapshot integrity |
| `LN_LEDGER` | `LnHoldLedgerError` | lnSettlement.ts (10 sites) | hold status machine + witness binding |
| `LN_RAIL` | `LnRailError` | lnRail.ts (6 sites) | rail wiring + injected-fault honesty |
| `LIQUID_ARGUMENT` / `LIQUID_STATE` | `LiquidEscrowError` | liquidEscrow.ts (21 sites) | covenant script well-formedness, curve lift |
| `TAPROOT_ARGUMENT` / `TAPROOT_STATE` | `TaprootSpendError` | taprootSpend.ts (21 sites) | control-block/tapleaf integrity, curve lift |
| `CRYPTO_ARGUMENT` / `CRYPTO_STATE` | `CourtCryptoError` | crypto.ts (7), nip44Crypto.ts (1) | attestation message field languages |
| `DISPUTE_ARGUMENT` | — (`CourtArgumentError`) | dispute.ts (4 sites) | commit salt/outcome languages |
| `NOSTR_EVENT_ARGUMENT` | — (`CourtArgumentError`) | events.ts (3 sites) | event tag capacity limits |
| `SIGNER_ARGUMENT` / `SIGNER_STATE` | `CourtSignerError` | courtSigner.ts (3 sites) | NIP-59 seal well-formedness |
| `UNWRAP_ARGUMENT` | — (`CourtArgumentError`) | courtUnwrapCore.ts (2 sites) | unwrap filter + batch bounds |
| `APPEAL_STATE` | `AppealError` | appealCoordinator.ts (5), appealWatcher.ts (2) | reselection fail-closed records, signer/CSPRNG availability |
| `invalid_*` etc. (legacy, lowercase) | `CourtSessionValidationError`, `CourtInboxError`, `CourtHostKeyError`, `CourtKeeperError`, `CourtCapabilityError`, `CourtOutboxError`, `CourtProtocolEventError`, `CourtRecoveryError` | per-module code unions | see each union's machine section (§3–§8) |

### 15.3 Boundary law

No `throw new Error(...)` remains in package sources (176 sites converted in
v0.10.1; one internal control-flow throw in `courtProtocolEvents.ts`
`parseContent` is thrown-and-immediately-caught in the same function and is
typed too). Malformed-but-well-typed caller input surfaces as
`CourtArgumentError` (or a domain class), never as a raw `TypeError` escaping
the boundary — pinned by `__tests__/errorTaxonomy.test.ts`.
