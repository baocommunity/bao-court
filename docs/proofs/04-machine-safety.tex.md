# Theorem 4 — Ceremony-machine safety (all invariants hold in all reachable states)

**Modules:** `courtVoteMachine.ts`, `courtConfirmationMachine.ts` (+ `confirmationMachineCore.ts`, `confirmationMachineHandlers.ts`), `courtSigningMachine.ts`, `courtDkgMachine.ts`; invariants normative in `docs/FORMAL_INVARIANTS.md` (INV-VOTE-1..23, INV-CONF-1..36, INV-SIGN-1..15, INV-DKG-1..12, INV-CORE-1..8, INV-X-1..10).
**Status:** proof complete, with **two explicitly stated environment premises**
(§3, H-JS1/H-JS2) and **one honest formalization boundary** (§6, GAP-4a) —
the theorem is a proof about the machines *as transition systems*; what it
does and does not claim about a running JavaScript host is stated, not
hand-waved.

---

## 1. Statement

> **Theorem 4 (Machine safety).** For each machine
> M ∈ {Vote, Confirmation, Signing, DKG}, fix parameters satisfying M's
> creation language and let s₀ = create_M(params). Let the invariant bundle
> I_M be the conjunction of the machine's INV-* data invariants (§4). Then
> **every state reachable from s₀ by a finite sequence of defined reducer
> applications satisfies I_M.**
>
> Formally, define the transition relation
> s →ₑ s′ ⟺ reduce_M(s, e) returns s′ (e the event carrying type e), and
> let Reach(M) = {s₀} ∪ {s′ : s →ₑ s′, s ∈ Reach(M)} (the least set closed
> under →). Then ∀ s ∈ Reach(M): s ⊨ I_M.

This is the general-n form of what the exhaustive model checker verified over
bounded instances; §7 states the relationship precisely and honestly.

## 2. Proof method

Induction on the length k of the event sequence producing a reachable state
("structural induction on event sequences").

- **Base (k = 0):** s₀ = create_M(params) ⊨ I_M — §5 walks the creation
  guards.
- **Step (k → k+1):** assume s ⊨ I_M and s →ₑ s′. Every handler is covered by
  the *preamble lemma* (§4.1), the *append lemma* (§4.2), or the *barrier
  lemma* (§4.3); §6 walks each handler of each machine and assigns it to a
  lemma plus the specific invariants it touches. Crucially, a **throwing**
  application produces no state: `→ₑ` is undefined, Reach is unchanged, and
  the induction hypothesis is untouched. This is why the fail-closed
  discipline (FC-1..FC-4) is not merely hygiene — it is what makes "reachable"
  a well-behaved induction domain.

## 3. Premises

| # | Premise | Content | Discharge |
|---|---|---|---|
| **J1** | ECMAScript semantics: object spread `{...state}` creates a fresh shallow copy; `Object.freeze` makes property writes fail (silently in sloppy mode, `TypeError` in strict mode); all modules are ESM, hence strict mode, hence **any write attempt to a frozen field or frozen array index throws** rather than corrupting; `Array.prototype.includes/find/filter/map/sort` have their specified semantics; `Number.isSafeInteger` per spec. | ECMAScript spec + the package's module format (`"type": "module"`). |
| **H-JS1** | **Producer discipline.** Every state observed by the machine's `reduce` was produced by this machine's `create` or `reduce` (or is a JSON round-trip of one, restored through the machine's own re-validation barriers). | This is an assumption about the *host* — TypeScript's type system cannot enforce it. It is mitigated in depth, not in type: (i) freeze discipline (INV-X-4) makes returned states `Object.isFrozen` with frozen array fields and records; (ii) every reducer re-validates state shape at entry (FC-4: `assertStateArrays` `courtCeremonyCore.ts:79–89`; signing re-derives the full session binding, `courtSigningMachine.ts:269–360`); (iii) the adversarial suite drives *tampered and hand-restored* states through every machine and asserts typed failures (`__tests__/adversarialMachines.test.ts`). H-JS1 is exactly the boundary the model checker also assumes; see GAP-4a. |
| **H-JS2** | The reducer is executed to completion between state observations (no concurrent interleaving inside a single `reduce` call — the functions are pure synchronous code with no `await`, no I/O, no shared mutable module state except the documented signing `NonceGuard`, which sits *outside* the machines). | Verifiable by inspection: no `await` in any reducer (grep-verified); purity asserted per module docstring and by the determinism property P5 of the model checker. |
| **INV-CORE** | The ceremony-core guards mean what `courtCeremonyCore.ts` says: `assertNow` (30–34), `assertRosterMember` (41–48), `isCanonicalUtf8Text` (64–70), `assertStateArrays` (79–89), `assertBeforeDeadline` — strict (94–104), `assertPositiveDeadline` (109–117), `normalizeCeremonyRoster` = exactly `[1..n]`, n ≤ 10 000 (125–148), `assertBlamedIdx` (155–166). | Read directly; each pinned by `courtCores.test.ts`. |

## 4. The three step-case lemmas

### 4.1 Preamble lemma (every handler of every machine)

> **Lemma 4.1 (Preamble preserves the invariant bundle; throws preserve Reach).**
> At the entry of every exported `reduce_*`:
>
> (i) a non-object event throws (FC-3 — `courtVoteMachine.ts:549–551`,
> `courtSigningMachine.ts:469–471`, `courtDkgMachine.ts:267–270`,
> `courtConfirmationMachine.ts` reducer preamble, dispatch at 326–348);
> (ii) the state's array fields are re-validated before any use (FC-4 —
> `assertStateArrays` call sites: vote 556–560, DKG 274–280, signing inside
> `assertSigningRecordInvariants` 275–279);
> (iii) the signing machine additionally re-derives the *entire* session
> binding from the persisted fields and fails closed on mismatch
> (INV-SIGN-2, `courtSigningMachine.ts:284–301`);
> (iv) every time-bearing event's clock is validated and the monotonic ledger
> advanced (INV-X-5 — vote 565–571, signing 481–487, DKG 296–309,
> confirmation analogously);
> (v) `tick`/`abort` are dispatched before the terminal-absorption barrier,
> and every other event from a terminal phase throws (INV-X-3 — vote
> 578–580, signing 494–496, DKG 312–314);
> (vi) an unknown event type throws the machine's own typed error (FC-2 —
> vote 594–595, signing 510–511, DKG 416).
>
> Consequently: a malformed event or hostile state leaves Reach unchanged;
> an accepted event produces a state whose *only* differences from s are the
> fields its handler writes; and every returned state is deep-frozen
> (INV-X-4 — freeze functions: vote 357–370, signing 215–224, DKG 171–180,
> confirmation `freezeState` `confirmationMachineCore.ts:153–185`).

*Proof.* Direct line-checking of the cited guards; the only subtlety is (iv)'s
clock-advance `state = {...state, latestTimestamp: event.now}` — a fresh
object (J1), so the previous state object is untouched (purity, H-JS2). ∎

### 4.2 Append lemma (the accept handlers)

> **Lemma 4.2 (Validated single-record append preserves the ledger invariants).**
> Each `accept_*` handler, after the preamble, (a) enforces the governing
> deadline strictly (INV-CORE-3), (b) enforces phase-exactness (the INV-*-3 /
> -11 / -13 family), (c) validates every field of the new record against the
> record language (HEX_32 / roster membership / allowlist membership / curve
> points / canonical hash recomputation), (d) resolves redelivery: identical
> → return the same (already frozen) state; conflicting → throw, or (in the
> signing and DKG machines) transition to a typed `aborted_peer` failure
> phase with blame, and (e) appends exactly one record.
>
> Since s ⊨ I_M (induction hypothesis) says the ledger was a duplicate-free,
> well-formed list, appending one well-formed record with a duplicate scan
> preserves duplicate-freeness and well-formedness; the redelivery branches
> change nothing or move to a failure phase whose `failure` object is written
> together with the phase (preserving the failure⇔phase coherence invariant).
> The roster-membership guard (INV-CORE-4 at every accept path, INV-X-6)
> keeps every ledger a subset of the frozen roster; with
> `normalizeCeremonyRoster` ≤ 10 000 seats (INV-CORE-6), the capacity guards
> (e.g. `MAX_REVEALS` `courtVoteMachine.ts:706–710`) are unreachable
> defense-in-depth — finding F-10 — and their preservation argument is the
> same counting argument. ∎

### 4.3 Barrier lemma (value-locking transitions)

> **Lemma 4.3 (Barriers re-establish — not merely preserve — the data invariants).**
> Every transition that derives a *value* (a verdict, a signer set, a
> signature, a clawback target) from ledger contents first re-runs a full
> ledger validation inside the handler:
>
> - vote: `assertValidRevealLedger` at `close_reveals` **and** `finalize_tally`
>   (`courtVoteMachine.ts:773, 788`; validator body 380–433 — per-record
>   roster/allowlist/hex/uniqueness/commit-binding re-checks);
> - confirmation: `assertValidMassVoteLedger` at `close_ladder_round` and
>   `resolve_round`; `assertValidMassVoteLedger` + `assertValidConfirmationLedger`
>   + `assertValidOutcomeHistory` at `resolve_round`
>   (`confirmationMachineHandlers.ts:321, 333–338`); and
>   `assertValidConfirmationLedger` + `assertValidOutcomeHistory` at
>   `finalize` (568–572);
> - signing: `assertSigningRecordInvariants` at **every** reduce
>   (`courtSigningMachine.ts:472`), which re-derives the session hash
>   (284–301), re-validates commitments as curve points from distinct roster
>   signers (302–322), re-checks `finalizedSignerSet` = sorted distinct
>   commitment indices (324–335, INV-SIGN-7), and re-validates partials as
>   HEX_32 records inside the signer set with distinct indices (337–359).
>
> The induction "does work" here: the step case for these handlers does not
> need to trust that s's ledgers were built by earlier accepted events — the
> barrier re-proves the ledger properties from the ledger's own contents at
> the moment the value is locked. A hand-restored or spread-tampered snapshot
> therefore cannot feed a forged ledger into a verdict or a signer set: it
> throws (typed), leaving Reach unchanged. ∎

## 5. Base case — creation guards

**Vote** (`createCourtVoteMachine`, `courtVoteMachine.ts:457–528`): session
hash HEX_32 (464–466); roster normalized to exactly [1..n] (467–471);
ballot 2..256 unique canonical-UTF-8 outcomes with the round-trip check
(472–509, INV-VOTE-2); commit deadline positive (510); reveal deadline
strictly later (511–516); returned state has `phase = commit_open`, empty
ledgers, `latestTimestamp = 0`, deep-frozen (517–527 + freeze 357–370).
⟹ INV-VOTE-1, INV-VOTE-2, INV-VOTE-23, and the ledger vacuity cases of
INV-VOTE-8/11/13 hold at k = 0.

**Confirmation** (`courtConfirmationMachine.ts:150–260` creation path): panel
≥ 3 (MIN_ROUND_ROSTER, line 188–192 — INV-CONF-2); proposal ∈ ballot with the
2..256 unique rule (INV-CONF-3); quorum 1 ≤ q ≤ |participants| (INV-CONF-4);
deadline ordering (INV-CONF-5); ladder cap 1..5 (INV-CONF-6); evidence ≤ 256
× HEX_32 (INV-CONF-7); empty ledgers, frozen (INV-CONF-1, INV-CONF-36).

**Signing** (`createCourtSigningMachine`, `courtSigningMachine.ts:383–449`):
session/verdict hashes HEX_32 (392–394); outcome canonical bounded
(395–402); roster normalized (403–407); 1 ≤ threshold ≤ n (408–414,
INV-SIGN-3); attempt ≥ 0 (420–422); deadline positive (423); and — the
binding — `signingSessionHash` is *computed from the very fields stored*
(428–436), so INV-SIGN-1 and INV-SIGN-2's consistency precondition hold at
creation by construction (the state cannot disagree with a hash derived from
itself).

**DKG** (`createCourtDkgMachine`, `courtDkgMachine.ts:221–245`): session hash
HEX_32; deadline positive; roster normalized; `parameters_confirmed` with
empty sorted-set ledgers (`backupVerified = false`), frozen ⟹ INV-DKG-1,
INV-DKG-2 (vacuously), INV-DKG-12.

## 6. Step case — the handler walk

Every handler below is assumed to run after Lemma 4.1's preamble; "L4.2" /
"L4.3" mark which step lemma carries the argument. Line references are to the
handler bodies.

### 6.1 Vote machine (`courtVoteMachine.ts`)

| Handler | Lines | Argument |
|---|---|---|
| `onTick` | 599–616 | Terminal/`reveal_closed`/pre-deadline ⟹ state returned unchanged (frozen; L4.1(v)); otherwise phase → `expired` with `failure` written atomically (coherence kept). Clock ledger already advanced by the preamble. INV-VOTE-7. |
| `onAbort` | 619–628 | Non-terminal ⟹ phase → `aborted` + reason; terminal throws. INV-VOTE-21/22. |
| `onAcceptCommit` | 631–668 | L4.2: strict deadline (635), roster (636), phase-exact (637–639), HEX_32 + version-bit 0x8 (640–654, INV-VOTE-9), one-commit idempotent/conflict-throw (655–663, INV-VOTE-8). |
| `onCloseCommits` | 671–682 | Phase-exact + `now ≥ commitDeadline` (675–680); pure phase move. INV-VOTE-3/6. |
| `onOpenReveals` | 685–694 | Phase-exact (690–692) + strict deadline (689). INV-VOTE-3/6. |
| `onAcceptReveal` | 697–758 | L4.2: deadline (701), roster (702), phase (703–705), capacity (706–710), allowlist (711–713, INV-VOTE-13), HEX_32 (714–721), commit existence + session-bound hash match (722–737, INV-VOTE-12), one-reveal idempotent/conflict-throw (738–750, INV-VOTE-11). |
| `onCloseReveals` | 761–775 | **L4.3 barrier**: `assertValidRevealLedger` (773) before phase move. INV-VOTE-15. |
| `onFinalizeTally` | 778–803 | **L4.3 barrier** (788) + non-empty ledger (789–791) + Theorem 3 (the tally is a function of the ledger) + `hashCourtVerdict` on validated inputs (Theorem 1). The verdict is derived ONLY after the ledger is re-proven — INV-VOTE-16/17/18/20. |

### 6.2 Confirmation machine (`confirmationMachineHandlers.ts`)

| Handler | Lines | Argument |
|---|---|---|
| `onTick` | 44–64 | TICK_DEADLINES table (INV-CONF-13); near-final and terminal phases tick-exempt; unchanged state returned frozen. |
| `onAbort` | 66–76 | INV-CONF-14 (typed failure phases only; failure written with phase). |
| `onAcceptConfirmation` | 78–122 | L4.2: phase (81–85), deadline (86–87), roster (88), HEX_32 (89–90), **canonical binding recomputation** `hashCourtConfirmation` (91–102, INV-CONF-8/9), capacity (103–106), one-per-idx idempotent/conflict-throw (110–120, INV-CONF-16). |
| `onCloseConfirmations` | 125–146 | Phase + boundary + **economic quorum gate** `confirmations.length ≥ confirmQuorum` (137–142, INV-CONF-15); pure phase move. |
| `onOpenChallengeWindow` | 148–161 | Phase + boundary; pure phase move (INV-CONF-11/12). |
| `onAcceptChallenge` | 162–202 | L4.2: phase, deadline, roster, 3 × HEX_32 (bondTxid/bondProofHash/eventId, 171–173 — INV-CONF-17), capacity, one-per-idx idempotent/conflict-throw. |
| `onCloseChallengeWindow` | 204–228 | Phase + boundary; routing writes the provisional verdict **together with** the phase (`fee_settlement` ⇔ upheld-provisional verdict, 218–226, INV-CONF-18); the challenged route parks in `ladder_pending` with the verdict untouched. |
| `onOpenLadderRound` | 230–267 | Consecutive round = ladderRound + 1 (244–249, INV-CONF-19), cap defense-in-depth (251–256), voteDeadline positive + strictly future (258–259, INV-CONF-20), round roster normalized (≥ 3, sequential, INV-CONF-21 via `normalizeRoundRoster` `confirmationMachineCore.ts:107–120`); fresh empty vote ledger. |
| `onAcceptMassVote` | 270–306 | L4.2 against the ROUND panel (`assertRoundParticipant`, `confirmationMachineCore.ts:96–99`), allowlist, HEX_32, capacity, one-per-idx idempotent/conflict-throw (INV-CONF-22). |
| `onCloseLadderRound` | 309–323 | **L4.3**: `assertValidMassVoteLedger` (321) before phase move (INV-CONF-23). |
| `onResolveRound` | 326–350 | **L4.3 ×3**: mass-vote, confirmation, outcome-history barriers (333–338, INV-CONF-23/26) + non-empty round (340–343, INV-CONF-24); tally by Theorem 3 (via `tallyRoundVotes`, 351–376); append-only history + idempotent clawbacks (`appendRoundOutcome` 378–398, `applyRoundClawbacks` 400–459 — the flag sets are built by filtering out already-flagged indices, INV-CONF-27/28); escalation gating by `round ≥ maxLadderRounds` (INV-CONF-29). |
| `onEscalate` | 463–481 | Phase-exact + cap re-check (471–475, INV-CONF-29); pure phase move. |
| `onConcede` | 483–497 | Phase-exact; parks at `fee_settlement` (INV-CONF-29). |
| `onRecordFee` | 499–513 | HEX_32 + idempotent-by-id + cap (INV-CONF-30); append-only. |
| `onFlagClawback` | 516–550 | Phase-exact (`fee_settlement`), roster, bounded reason, dedup per (idx, reason), cap (INV-CONF-31). |
| `onFinalize` | 553–624 | **L4.3 ×2** (568–572, INV-CONF-9/26); pending verdict required (573–576); supporting ids from the LAST resolved round / confirmation ledger (584–592, INV-CONF-32); **non-empty support fail-closed** (585–597, INV-CONF-33); `verdictHash = hashCourtVerdict(...)` — flags deliberately not inputs (INV-CONF-34), shared Verdict/v1 domain (INV-CONF-35); Theorem 3 + Theorem 1 make the verdict a pure function of the barrier-verified ledgers. |

### 6.3 Signing machine (`courtSigningMachine.ts`)

| Handler | Lines | Argument |
|---|---|---|
| `onTick` | 515–532 | Deadline re-validated (518–522); terminal/pre-deadline unchanged; else `expired` + failure atomically. INV-SIGN-12. |
| `onAbort` | 535–552 | ABORT_PHASES whitelist (541–543, INV-SIGN-13) + `assertBlamedIdx` against the roster (546). |
| `onStart` | 555–564 | Phase-exact `intent` → `nonce_commit`; strict deadline. |
| `onAcceptCommitment` | 567–607 | L4.2: deadline, roster, phase (571–575), **both nonce points decode to real secp256k1 points** (581–583, INV-SIGN-5 via `isValidSecp256k1Point` `crypto.ts:297–305`), one-commitment-per-signer: identical idempotent (584–588) / **conflicting → `aborted_peer` with blame** (589–598, INV-SIGN-4). |
| `onCloseCommitments` | 610–625 | Phase-exact + **threshold gate** `commitments.length ≥ threshold` (618–622, INV-SIGN-6) + `finalizedSignerSet` = sorted distinct commitment indices (623 — distinctness by Lemma 4.2's duplicate-free ledger, INV-SIGN-7). |
| `onAcceptPartial` | 628–677 | L4.2: deadline, phase window (633–635), **signer-set closure** (636–640, INV-SIGN-7), psig 64-hex then HEX_32 (642–649, INV-SIGN-9), one-partial: identical idempotent (650–653) / conflicting → `aborted_peer` with blame (654–662) / structural duplicate re-check (664–671) — INV-SIGN-8. |
| `onAggregate` | 680–697 | Phase window + **threshold over distinct signers** `partials.length ≥ threshold` (688–692, INV-SIGN-10 — distinctness guaranteed by INV-SIGN-8's ledger) + signature shape 128-hex (693–695). Stores the signature with the phase. |
| `onPublish` | 700–712 | Requires `aggregate` phase + stored signature (705–707, INV-SIGN-11) + HEX_32 attestation event id (708–710); phase → `attestation_published` (terminal). |

The cryptographic aggregation itself is outside the machines (by design —
the machine docstring, lines 29–31); Theorem 5 covers it.

### 6.4 DKG machine (`courtDkgMachine.ts`)

| Handler | Lines | Argument |
|---|---|---|
| `expire` (tick) | 200–212 | Terminal and `certified` tick-exempt (202, INV-DKG-8); else deadline-gated `expired` + failure atomically (INV-DKG-9). |
| `abort` branch | 294–313 | Non-terminal, non-`certified` only (295–297, INV-DKG-10); ABORT_PHASES whitelist (298–300); `assertBlamedIdx` (305–306). |
| `start` | 316–323 | Phase-exact `parameters_confirmed` → `dkg_round_1`; strict deadline. |
| `accept_round_1` | 324–336 | L4.2 with `addSorted` set semantics (182–185: membership check + sort — no duplicates, ascending, INV-DKG-2); **unanimous auto-advance** when the set reaches the full roster (330–335, INV-DKG-3). |
| `accept_round_2` | 338–342 | Same set semantics; no auto-advance (INV-DKG-2). |
| `finalize_transcript` | 347–370 | Phase + **unanimous round-2 gate** `round2Participants.length = roster.length` (350–355, INV-DKG-4) + transcript HEX_32 / group-key shape (356–365, INV-DKG-5); transcript fields stored with the phase move. |
| `accept_certification` | 371–398 | Phase + transcript presence (375–377); **different transcript → `aborted_peer` with blame** (378–389, INV-DKG-6); `addSorted` idempotence; **`certified` (and `certifiedGroupPubkey` exposure) only when every roster member certified the exact stored transcript** (390–398, INV-DKG-6). |
| `confirm_backup` | 400–412 | Requires `certified` + exposed group key (407–408, INV-DKG-7); local event, deadline-free by design; `backed_up` + `backupVerified = true` written together. |

### 6.5 Conclusion of the induction

Every handler is either (i) a throw (Reach unchanged), (ii) a freeze-and-return
of the current state (trivial preservation), (iii) a pure phase/clock move with
coherence fields written atomically, (iv) an L4.2 append, or (v) an L4.3
barrier-guarded value derivation. In every case s′ ⊨ I_M whenever s ⊨ I_M.
Together with §5's base case, induction gives: ∀ s ∈ Reach(M): s ⊨ I_M. ∎
**Theorem 4.**

## 6.6 The invariant bundle I_M, precisely

I_M includes exactly the invariant families with *enforcing guards inside the
machine*: for Vote, INV-VOTE-1..23; for Confirmation, INV-CONF-1..36; for
Signing, INV-SIGN-1..15; for DKG, INV-DKG-1..12; plus the shared
INV-CORE-1..8 and INV-X-3/4/5/6 (INV-X-1, -2, -7..10 are about other modules
or follow immediately). Explicitly **outside** I_M (honesty): INV-BATCH-16's
membership-scope convention (F-1), the bond witness-vs-UTXO check
(INV-CONF-17's witness is bound by the machine, but UTXO verification is the
host's pre-dispatch duty), Nostr signature authentication at the event
boundary (machine docstrings, e.g. vote lines 24–26), and all liveness
properties (P3/P4) — the induction proves *safety only*; termination is
covered by the model checker over finite instances (P4, Kahn's algorithm) and
is a liveness theorem not claimed here.

## 7. Relationship to the model checking — stated honestly

The exhaustive model checker (`__tests__/modelCheckingCore.ts`,
`scripts/model-check.mjs`, committed numbers in
`__fixtures__/model-check-summary.json`) explores **finite instances**:

- vote: n = 1..4 (k = 2), n = 2 (k = 3);
- confirmation: n = 3 with quorum/ladder/round-roster variants, reduced clock
  universe {0..14};
- signing: n = 2 t = 1, n = 3 t = 2, plus commitment- and
  partial-equivocation variants;

13 instances, **3 145 632 states**, **128 522 740 event applications**,
**0 raw (untyped) throws**, properties P1–P5 + typed-error discipline at every
reachable state (documented abstraction limits L1–L3 in the core header:
bounded symbolic clock, real-but-small crypto, bounded rosters). The current
witness-aware sweep is 15 instances / **3 869 232 states** /
**213 521 172 applications** / **60 020 684 illegal-witness probes, 0
accepted** (`__fixtures__/model-check-summary.json`); the theorem below is
independent of which sweep is current, since it ranges over all event
sequences.

The two methods are complementary and neither subsumes the other:

1. **The induction (this theorem) covers all n** — including n = 201, outside
   the checker's reach (state explosion; L3 says so explicitly). Its step
   cases are human-checked line-references to the actual guards (§6).
2. **The checker mechanically verifies the base and step claims on every
   bounded instance** — including event-field combinations inside and outside
   the legal language (illegal indices, bad hex, backwards clocks, legacy
   commits, unknown types) and the typed-error discipline, at *every*
   reachable state rather than the sampled paths a test suite visits.
3. On the overlap (n ≤ 4), the two agree by construction of this proof: each
   §6 row's guards are the same code the checker drives. A discrepancy would
   be either a mis-cited guard in §6 (a documentation bug, caught by review)
   or an implementation divergence (caught by the checker and the 1400+ tests).
4. What the induction does **not** give: the liveness/termination properties
   (P3/P4), which the checker verifies per instance and which do not
   generalize by this proof technique (the progress argument is per-instance
   and relies on the bounded clock universe). What the checker does not give:
   any n beyond its instances, and independence from its own harness
   correctness (the induction's step lemmas are checkable against the source
   directly).

## 8. LEMMA-GAP register

> **GAP-4a (environment premise H-JS1 — stated, mitigated, not provable in
> TypeScript).** The induction's domain is "states produced by create/reduce".
> JavaScript cannot enforce, at the type level, that a caller does not
> hand-construct a plausible-looking state or mutate a frozen object through
> a pre-freeze alias. Mitigations, in order of strength: (i) every reducer
> re-validates state shape at entry (FC-4) and the signing machine re-derives
> its entire binding (INV-SIGN-2); (ii) `Object.freeze` + strict-mode ESM
> makes mutation attempts throw (J1) rather than corrupt silently; (iii) the
> barriers (L4.3) re-prove the ledger invariants from contents at every
> value-locking transition, so even a state that survived (i)–(ii) cannot
> feed a forged ledger into a verdict; (iv) the adversarial suite drives
> tampered and JSON-round-tripped states through all machines. Residual risk:
> a host that mutates a state *between* a successful reduce and the next one
> in a way that passes (i)–(iii) — by construction of the barriers this can
> only cost an availability (typed throw), never integrity of a derived
> verdict or signature.
>
> **GAP-4b (string-allowlist semantics).** `allowedOutcomes.includes(outcome)`
> is exact string equality — the substring hazard (`'YES'.includes('Y')`)
> documented in FC-4 applies only to a *tampered* state whose allowlist was
> replaced by a string, which (i) throws at the state-shape barrier. Covered;
> recorded here because the invariant's proof goes through the FC-4 guard.

## 9. How to check this proof (≈ 60 minutes)

1. §3 premises (5 min): confirm the modules are ESM/strict (package.json) and
   that no reducer awaits (grep `await` in the four machine files — only
   outside the machines).
2. §4 lemmas (15 min): read the cited preamble/append/barrier lines; the
   lemmas are deliberately restatements of the code's actual control flow.
3. §5 base case (10 min): read the four create functions against the cited
   guard lines.
4. §6 handler walk (20 min): spot-check each row's line range against the
   handler; every row is one of the five shapes of §6.5.
5. §7 (5 min): read `__tests__/modelCheckingCore.ts` header and
   `__fixtures__/model-check-summary.json` totals; confirm the instance list.
6. Run: `npm test` (includes `modelChecking.test.ts` reduced sweep +
   `invariantAssertions.test.ts`'s 27 always-on cross-machine assertions) and
   `npx tsx scripts/model-check.mjs --fast` for a mechanical re-verification.
