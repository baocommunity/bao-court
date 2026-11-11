# Review Round 8 — attacking the escalation transport (v0.14.0) and the round-7 fixes

**Date:** 2026-11-11 · **Base:** `bao-court` `origin/main` @ `081fb8c`
(v0.14.0, #114) · **Branch:** `docs/review-round-8`.

**Scope, as briefed.** Four targets: (1) the **wire parser** of
`courtEscalationRequest.ts` — strict unknown-field refusal, duplicate keys,
`__proto__`, unicode confusables, positional junk, the `'-'` sentinel, and
whether the v2 hash is domain-separated from "absent"; (2) **wire → reducer** —
whether the transport introduces unchecked claims (`challengerPubkey` vs the
case roster, `now` vs the request's timing); (3) the **round-7 finality fix** —
whether the mass-vote barrier runs on *every* path to `finalize`, and whether a
consistent-but-forged `outcomeHistory` can steer the verdict; (4) whether the
**four r41-1 closures** from #112 are real pins (red on the pre-fix head).

**Method.** Unchanged, because it keeps working: the codec is called with
hostile input, the reducer is attacked as an API (a hostile host speaks it
directly *and* hands back tampered snapshots), and every documentary claim is
re-derived from the code. A finding is one of:

- **EXPLOITABLE** — a test in this repository shows the harm through the shipped
  interfaces; fixed here;
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited.

Every residual gets a **disposition** (fixed here / documented + pinned / host
fix with an owner and a trigger / deferred to a named version). Nothing is left
as a bare "registered". A `r8-n` id is this round's; `rN-n` ids are earlier
rounds'.

**What was executed**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound8.test.ts` (**new**, 34 tests) | **34 passed** |
| the same file on **v0.14.0** (`081fb8c`) | **13 failed / 21 passed** — every r8 closure is red on the pre-fix head (§7) |
| `__tests__/reviewRound7.test.ts` on **`1b33b2f`** (pre-#112) | **6 failed** — the four r41-1 closures **+** two doc pins (§4) |
| `npm test` (full suite) | **1,804 passed / 1 skipped (81 files passed + 1 skipped)** — §7 |
| `npm run typecheck` · `typecheck:tests` · `typecheck:scripts` | clean / clean / clean |
| the wire parser fuzz (canonical round-trip, 2 000-id injectivity) | 0 false refusals, 0 collisions (§1.2) |

**Verdict summary.** **2 EXPLOITABLE** (both fixed here): the codec's `caseId`
was encoded lossily, so two different requests hashed to one digest — the r7 H-6
collision one field over; and the transport **bound nothing** — it minted a
reducer event from three wire claims neither it nor the reducer can check
(`challengerPubkey`, `caseId`, `round`), so a bonded challenger could write
another juror's pubkey into the append-only escalation log, apply a request
signed for one case to another, and open a rung its signer never authorised.
Plus **4 PARTIAL, all fixed here** (a `concession` coerced to `false`, duplicate
JSON keys silently resolved, `build` validating one `caseId` and returning
another, `resolve_round` appending onto a history that outran nothing), and the
round-7 finality barrier **BLOCKED on every path** with the one residual it
cannot reach (a *consistent* forgery needs signatures; host-owned).

The headline shape is the campaign's usual one, one layer out: round 7 asked
what the transport *carries*, and answered by adding the field. Nobody asked
what the transport *binds*. A codec that validates shape and forwards claims is
a canonicaliser with no opinion about identity — and identity is exactly what a
`challengerPubkey` and a `caseId` are.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | parser | two `roundBondProofHash` keys in one body | **PARTIAL → fixed** (r8-4): last-wins gave one digest to many byte strings; repeated keys are refused |
| T1 | parser | `caseId` with an unpaired surrogate vs U+FFFD | **EXPLOITABLE → fixed** (r8-1): `TextEncoder` maps both to the same bytes ⇒ **one hash for two different requests** |
| T1 | parser | `"-"` as a real `roundBondProofHash` | **BLOCKED** — not hex32, so the slot is unreachable; `"-"` as a `caseId` is a field value, never the slot |
| T1 | parser | `__proto__`, Cyrillic/zero-width/NUL keys, extra positional args, BOM, trailing junk | **BLOCKED** — every one refused; strictness is not switchable by a second argument |
| T1 | parser | `concession: "true"` / `1` / `{}` | **PARTIAL → fixed** (r8-3): coerced to `false` — a signed flag read as a truthiness test |
| T1 | parser | a getter/`Proxy` input | **PARTIAL → fixed** (r8-5): validated A, returned B, and could escape as a raw `TypeError` |
| T2 | mapping | `challengerPubkey` = any juror | **EXPLOITABLE → fixed** (r8-2a): the log recorded a pubkey that does not own the bond |
| T2 | mapping | request signed for round 1, offered at round 3 | **EXPLOITABLE → fixed** (r8-2b): `roundIndex` comes from the case, the wire `round` was ignored |
| T2 | mapping | a request for case A applied to case B | **fixed with the same binding** (r8-2c) |
| T2 | mapping | can the request steer `now`? | **BLOCKED** — `signedAtSec` is never the clock; NaN/negative/rollback refused |
| T2 | mapping | one bond hash bound to two owners on a restored snapshot | **BLOCKED** (reducer) + mapper hardened to refuse rather than pick |
| T3 | finality | forged vote ledger on each path to `finalize` | **BLOCKED** — 4 paths probed, 4 refusals (§3.1) |
| T3 | finality | consistent-but-forged history (votes + record + verdict agree) | **registered** — undetectable in a pure state machine; host-owned (§3.2) |
| T3 | finality | `resolve_round` on a history that outran the ladder | **PARTIAL → fixed** (r8-6): accepted, appended a non-consecutive record, bricked the case |
| T4 | closures | are the four r41-1 pins real? | **BLOCKED (real)** — measured: 4 red on `1b33b2f` (§4) |

---

## 1. T1 — the wire codec

### 1.1 Duplicate keys: `JSON.parse` picks the last one, silently (PARTIAL → fixed, r8-4)

**Attack.** One body, two claims:

```
{"caseId":"…","…","roundBondProofHash":null,"roundBondProofHash":"<a2…>","eventId":"…"}
```

`JSON.parse` keeps the **last**, so the codec sees a legacy-shape witness slot
and a *different* value than a reader of the raw body sees. The module's stated
contract is `additionalProperties: false` and "a peer that silently drops a field
is how H-6 happened" — a repeated field is the same defect with the arithmetic
reversed: one digest, many byte strings.

**Repro (measured on v0.14.0).** `parseCourtEscalationRequest(dupBody)` →
`roundBondProofHash` = `<a2…>` for a body carrying `null` first:
*r8-4 duplicate-key body accepted: **true***. The same works for `concession`
(`true` then `false` → the flag silently disappears) and for a key spelled with
a JSON escape (`"c\u0061seId"` decodes to `caseId`).

**Outcome.** PARTIAL — no second parser is required for the harm to be real (the
audit artifact and the parsed request disagree), but no shipped path reads the
raw body with a first-wins parser today.

**Fix.** `parseCourtEscalationRequest`'s string form is scanned at depth 1
(`assertNoRepeatedWireFields`, a string-aware walk that decodes keys before
comparing) and a repeated field is a typed refusal. Pinned in
`reviewRound8.test.ts` › `T1 (r8-4)`, including the canonical-form control
(values containing quotes, backslashes and braces must not trip the scanner).
**Limit, stated:** an already-parsed object has already lost the duplicate, so a
host that must accept objects has to hand this module the body text.

### 1.2 `caseId` was encoded lossily — two requests, one digest (EXPLOITABLE → fixed, r8-1)

**Attack.** The preimage is `domain ‖ 0x00 ‖ caseId ‖ 0x00 ‖ round ‖ …`, encoded
with `TextEncoder`. An unpaired UTF-16 surrogate — which `JSON.parse` happily
produces from `"\ud800"` — is replaced by U+FFFD on the way to UTF-8. So
`"court:market-r48:1\ud800"` and `"court:market-r48:1\ufffd"` are **different
case ids**, **different wire strings**, and **the same digest**.

**Repro (measured on v0.14.0).**

```
r8-1  distinct caseIds: true | distinct wire: true | SAME hash: true -> 6fbca7ac563e62d5
```

**Outcome.** EXPLOITABLE — this is precisely the defect class the codec exists
to prevent (r7 H-6: two different round bonds, one request hash). The request
hash is the challenger's signed scope, the host's replay/dedupe key, and the
reducer's `escalationLog.requestHash`. Two distinct ids sharing one digest means:
a host that dedupes per case by hash treats a second case's request as already
applied (or a different request as the same one), and an auditor cannot tell
which id a digest covers — the two render identically wherever U+FFFD shows.
The `'‑'` sentinel is *not* the problem: a `roundBondProofHash` must be hex32, so
`'-'` is unreachable as a value, and the sentinel only ever occupies its fixed
slot (§1.3).

**Fix.** `caseId` is normalised once (`normalizeCaseId`): canonical UTF-8
(`isCanonicalUtf8Text`, so no unpaired surrogates), no `U+0000` (the preimage
separator; injectivity currently survives NUL only by a segment-count argument,
and the codec must not depend on counting), and a 256-byte bound
(`MAX_ESCALATION_CASE_ID_BYTES`). With those, `TextEncoder(caseId)` is injective
over the accepted domain, so the joined preimage is too. Pinned by the collision
probe, the NUL/bound refusals, and a 2 000-id injectivity sweep.

### 1.3 The `'-'` sentinel (BLOCKED)

- `buildCourtEscalationRequest({ roundBondProofHash: '-' })` → refused
  (`must be 32-byte lowercase hex`); `''`, `false`, `0` refused the same way. The
  only way into the slot is hex32, so absent (`-`) and present can never collide.
- `caseId: '-'` is *accepted* — a `caseId` is a field **value**, and the
  sentinel's meaning comes from its fixed position, not from its text.
- The preimage is pinned literally in the test, so a future re-ordering that
  moved the sentinel out of its slot fails loudly.

### 1.4 Confusables, `__proto__`, positional junk (BLOCKED)

Probed and refused, each pinned: `__proto__` as an own key (`JSON.parse` creates
it as a data property, so `Object.keys` sees it — and `Object.prototype` stays
clean, asserted); Cyrillic `а` in `cаseId`; a zero-width joiner suffix
(`round\u200d`); `caseId\u0000x`; arrays (`must be a JSON object`); a BOM; trailing
junk; `null`/numbers. **Extra positional arguments are ignored** — `parse(raw,
{ strict: false })` still parses strictly, which is the fail-closed direction:
strictness cannot be switched off by a caller's options bag.

### 1.5 `concession` was a truthiness test (PARTIAL → fixed, r8-3)

`concession: "true"`, `1`, `"yes"`, `{}`, `[]` and `null` all parsed as `false`:
a signed flag read as `input.concession === true`. A permissive peer that sends
`"true"` (common in hand-built JSON) has its concession *dropped* — and the hash
commits to `'0'`, so the digest agrees with the wrong meaning. Now: a non-boolean
`concession` is a typed refusal, at `parse` **and** at `build` (a hand-built
object cannot bypass the codec); absent still means `false`.

### 1.6 `build` validated A and returned B (PARTIAL → fixed, r8-5)

`buildCourtEscalationRequest` read `input.caseId` twice — once for the
emptiness/shape check, once for the returned value. A getter or `Proxy` could
therefore return a valid id to the check and any other string to the result
(measured: `reads: 3`, returned `court:B:2` for a getter answering `court:A:1`
first), and a getter turning non-string escaped as a raw **`TypeError`**
(`input.caseId.trim is not a function`) instead of this module's typed refusal —
the "foreign error type escapes the fail-closed boundary" class of r3-1 and
r41-1. Every field is now snapshotted exactly once into a local before any check
(`reads: 1`), and the non-string case fails with
`CourtConfirmationTransitionError`.

---

## 2. T2 — wire → reducer: the transport bound nothing (EXPLOITABLE → fixed, r8-2)

The round-7 module's own docstring says the wire supplies the challenger's
*claims* and the case supplies "everything the challenger must not choose".
That is true of `challengerIdx`, `roundIndex` and `now` — and it was **not** true
of the three claims the wire does supply, because nothing compared them with
anything. The reducer cannot: it has indices, not pubkeys (r29-5), no case id at
all, and it derives the round itself.

### 2.1 (a) `challengerPubkey` — an unchecked attribution claim

**Attack.** Juror 2 posts the membership bond. It offers an escalation request
whose `challengerPubkey` is **juror 3's** key. The mapper fills
`challengerIdx: 2` from the bond owner, forwards the wire's pubkey, and the
reducer accepts: its witness test is `(idx, bondProofHash)` (r29-1), and the log
barrier re-checks the same pair, never the pubkey.

**Repro (measured on v0.14.0).**

```
r8-2a forged pubkey: idx 2 pubkey 9999 | reducer phase ladder_pending | log pubkey 9999
```

**Outcome.** EXPLOITABLE. `escalationLog` is the append-only artifact hosts read
to attribute misconduct and price fees (r29-2's whole reason for existing). This
reintroduces the r29-2 harm *at mint time*: the transport writes a juror's
pubkey next to an escalation that juror never made, and it is the transport's
signature that says "this claim is authenticated".

### 2.2 (b) `round` — a stale request opens a rung nobody authorised

**Attack.** `roundIndex` is `state.ladderRound + 1`, so the wire's `round` is
inert. A request signed to "escalate past round 1" is applied at round 3.

**Repro (measured on v0.14.0).**

```
r8-2b stale request: wire round 1 -> event roundIndex 4 | reducer phase ladder_pending
```

**Outcome.** EXPLOITABLE. On a legacy (`requireRoundBond: false`) case the
witness is `null`, so nothing is consumed and the **same** signed request replays
on every rung — a single signature becomes an unlimited escalation mandate. On a
strict case the per-round witness limits it to one replay per fresh bond, which
is still a rung the signer never authorised.

### 2.3 (c) `caseId` — a request can cross cases

`r8-2c cross-case: ladder_pending` — the same request, re-labelled with another
case's id, maps and reduces on the first case. The hash covers `caseId`, but
nothing compares it with the case being escalated.

### 2.4 The fix: the host's binding is a required argument

`escalationRequestToMachineEvent(state, request, now, binding)` now takes

```ts
interface CourtEscalationBinding {
  readonly caseId: string;              // the case the host ROUTED on
  readonly authenticatedPubkey: string; // the pubkey NIP-98 PROVED
}
```

and refuses: a missing/invalid binding; `caseId` ≠ the bound case; the wire
pubkey ≠ the authenticated pubkey; `round` ≠ `state.ladderRound`. The adapter is
the only layer that can hold this — a case id and an authenticated key are host
facts, not state-machine facts — and the refusal message for a 3-argument call
says so. Also hardened while in there: an **ambiguous** bond ledger (one
`bondProofHash`, two owners on a restored snapshot) was silently resolved by
`Array.find`; the mapper now refuses it rather than picking the first owner
(the reducer's r38-1 barrier refuses it anyway — defence in depth, and the host
no longer builds an event the machine will reject).

**Consumer impact.** Source-compatible (the fourth parameter is optional in the
type) but **behaviour-breaking by design**: a 3-argument call now throws instead
of minting an unbound escalation. The package's own host has not wired this
module yet (the vendored `@bao/frost-court` is 0.7.2), so nothing downstream
breaks today; `PER_ROUND_BOND.md` and the CHANGELOG state the requirement.
Over-strictness checked: the strict case still escalates end-to-end through
parse → map → reduce, and a request minted for the round being resolved still
maps on round 2 (§7's positive controls).

### 2.5 `now` cannot be steered by the request (BLOCKED)

`signedAtSec` is in the hash and is **never** used as the clock: `now` is a
caller argument, `NaN`/negative are refused, and the reducer's monotonic ledger
refuses a rolled-back host clock (pinned: `latestTimestamp` 3200, then a 3100
event → `now must not precede`). What the codec deliberately does not do is
decide a **freshness window** — a replayed request keeps its original
`signedAtSec`, so the window is host policy, and it is now bounded by the round
check in §2.4 rather than by time alone. **Disposition: host policy** (owner: the
escalation route; trigger: the deploy that wires the transport).

---

## 3. T3 — the round-7 finality barrier, on every path

### 3.1 The barrier runs, and every forged-ledger path is refused (BLOCKED)

Four paths reach `final` — and `final` is reachable only through `onFinalize`
(the other terminal phases are `expired`/`aborted`), so the barrier's placement
there covers all of them:

| path | how it arrives | forged input | result |
|---|---|---|---|
| no challenge | `close_challenge_window` → `fee_settlement` | a resolved-round record on a never-challenged case | **refused** (`outcome history records exist but the case was never challenged`) |
| concede | `round_resolved` → `concede` → `fee_settlement` | forged vote ledger + matching pending verdict | **refused** (`vote ledger tallies "YES" but the recorded outcome is "NO"`) |
| resolved → concede | same, honest votes | pending verdict flipped to the winner's opposite | **refused** (`pending verdict names "YES" but the verified ledgers derive "NO"`) |
| last round | `resolve_round` → `fee_settlement` directly | duplicate ballots padded into the support set | **refused** (`participant 1 has duplicate mass votes`) |

Honest flows finalize with the derived verdict and the recorded support set
(3 ids for the 3-juror round; `upheld` derived as `□ outcome === proposed`). The
`concede` step itself still reads no ledger — that is fine and pinned: it is
`finalize` that locks value, and it re-derives.

### 3.2 The residual: a CONSISTENT forgery (registered, host-owned)

If an attacker rewrites **the vote ledger, the history record and the pending
verdict together** so all three agree, the machine finalizes happily:

```
YES / upheld / 1 supporting id, final
```

No barrier in a pure state machine can distinguish that from an honest round —
provenance is signatures over the ballots, which `accept_mass_vote`'s *caller*
checks. Pinned as a test that asserts the accepted case **and** the two cheaper
forgeries it excludes (history-only, verdict-only), so the boundary is explicit
rather than implied. **Disposition: registered** (host admission check, same
standing as r29-5/r38-3).

### 3.3 `resolve_round` appended onto a history that outran nothing (PARTIAL → fixed, r8-6)

`assertValidOutcomeHistory` proves the history is a consecutive `1..k` sequence,
but not that `k` is the round being resolved. A restored
`ladder_vote_closed` snapshot with `ladderRound = 4` and **one** record resolves
and appends round 4 on top:

```
r8-6 resolve_round accepted -> history rounds 1,4 | phase fee_settlement
     | finalize: refused (outcome history rounds must be a consecutive 1…)
```

Every later barrier refuses `[1,4]`, so the case can never finalize again — the
r40-2 brick (value locked, host must intervene) for a snapshot the machine
accepted as legal. The live path always has exactly `round − 1` records
(`open_ladder_round` opens one round at a time; each `resolve_round` appends
exactly one). The check is now at the top of `onResolveRound`, and the
over-strictness control (a legal two-round ladder resolving `[1,2]`) is pinned.

---

## 4. T4 — are the four r41-1 closures from #112 real pins?

Run: `__tests__/reviewRound7.test.ts` from this branch against **`1b33b2f`**
(pre-#112 — the tree where `confirmationMachineHandlers.ts` is pre-fix; #112
touched only that file and one docstring), with `node_modules` symlinked:

```
Test Files  1 failed (1)
     Tests  6 failed | 13 passed (19)
```

| closure | pre-fix failure | verdict |
|---|---|---|
| 1 · `finalize` did NOT run the mass-vote barrier | `expected '' to match /vote ledger|recorded outcome|tally/` — `finalize` threw **nothing** on the forged ledger | **real pin** |
| 2 · a LOSING outcome could be minted as the canonical verdict | `expected [Function] to throw an error` — it minted one | **real pin** |
| 3 · the vote ledger is re-derived at finalize | red (the malformed-id matrix returned a verdict) | **real pin** |
| 4 · `upheld` is re-derived, not trusted | `expected '' to match /upheld/` — no refusal | **real pin** |

The other two failures are the round-7 **doc** pins (the upgrade checklist and
the monotonicity sentence), red because that tree also predates the R41 doc
edits — expected, and not closures. The honest corollary: the r41-1 fix is
genuinely load-bearing on this surface, and round 8's §3.1 probes are the same
four routes attacked again from the outside.

---

## 5. Fixes shipped in this PR

| # | File | Fix |
|---|---|---|
| r8-1 | `courtEscalationRequest.ts` | `caseId` canonical UTF-8, NUL-free, ≤ 256 bytes (`MAX_ESCALATION_CASE_ID_BYTES`) — the preimage is injective over the accepted domain |
| r8-2 | `courtEscalationRequest.ts` | `CourtEscalationBinding` required by `escalationRequestToMachineEvent`: case id, authenticated pubkey, and `round === ladderRound`; ambiguous bond ledgers refused |
| r8-3 | `courtEscalationRequest.ts` | a non-boolean `concession` is refused at `parse` and at `build` |
| r8-4 | `courtEscalationRequest.ts` | `parse`'s string form refuses a repeated top-level field (`assertNoRepeatedWireFields`) |
| r8-5 | `courtEscalationRequest.ts` | `build` snapshots each field exactly once — no validate-A/return-B, no escaping `TypeError` |
| r8-6 | `confirmationMachineHandlers.ts` | `resolve_round` requires `outcomeHistory.length === ladder.round − 1` |
| — | `index.ts` | export `CourtEscalationBinding`, `MAX_ESCALATION_CASE_ID_BYTES` |
| — | `__tests__/escalationRequestWire.test.ts` | the 12 r7 tests now pass the binding (their assertions are unchanged) |
| — | `docs/PER_ROUND_BOND.md` | the transport section states the binding requirement and why the reducer cannot carry it |

Tests: `__tests__/reviewRound8.test.ts` — **34**, of which **13 are red on
v0.14.0** (r8-1 ×2, r8-3, r8-4 ×3, r8-5 ×2, r8-2 ×5, r8-6).

---

## 6. Residuals, with dispositions

| Residual | Class | Disposition |
|---|---|---|
| A **consistent** forgery (votes + history + verdict rewritten to agree) finalizes | provenance | **Host-owned** (signature admission at `accept_mass_vote`); pinned as the boundary, §3.2 |
| The replay **window** is not enforced here (a replayed request keeps `signedAtSec`) | freshness policy | **Host policy** (escalation route); the round binding (§2.4) bounds the damage; trigger: transport wiring |
| Duplicate-key detection needs the **body text** (a pre-parsed object has lost the duplicate) | canonicality | **Documented**; hosts must hand `parse` the raw body — stated in the docstring and §1.1 |
| `parse` normalises `caseId` by trimming (a padded id hashes as its trimmed form) | canonicality | **Documented + pinned** (preimage test); a host must key cases by the normalised id |
| The escalation log's `challengerPubkey` is only as good as the host binding | attribution | **Fixed here** for the transport path; a host that builds `escalate` events by hand bypasses it (`challengerEscalationEvent` takes a pubkey claim) — **host rule**: use the codec |
| `now` monotonicity is the reducer's; the codec adds none | clock | **By design** (r8 §2.5) |

## 7. Suite evidence (this branch)

```bash
npx vitest run __tests__/reviewRound8.test.ts          # 34 passed
# same file, worktree at 081fb8c (v0.14.0):            13 failed | 21 passed
npx vitest run __tests__/reviewRound7.test.ts           # (1b33b2f) 6 failed: 4 closures + 2 doc pins
npm test                                                # 1804 passed | 1 skipped (82 files)
npm run typecheck && npm run typecheck:tests && npm run typecheck:scripts   # clean
```

The 21 tests that pass on v0.14.0 are, by design, the ones that must: the four
finality paths (§3.1), the four r41-1 guard pins (§4), the `'-'` sentinel, the
confusable/`__proto__` matrix, the `now`/clock pins, and the positive controls
(a strict case still escalates end-to-end; a legal two-round ladder still
resolves `[1,2]`).
