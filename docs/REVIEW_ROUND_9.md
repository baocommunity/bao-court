# Review Round 9 — attacking the round-8 fixes (v0.14.1)

**Date:** 2026-11-11 · **Base:** `bao-court` `origin/main` @ `bc28ff3`
(v0.14.1, #116) · **Branch:** `docs/review-round-9`.

**Scope, as briefed.** Four targets, each the *fix* of round 8 rather than the
code it fixed: (1) the **canonical `caseId` encoding** (r8-1) — overlong UTF-8,
lone surrogates at every position, the 256/257-byte boundary, NUL at
start/middle/end, combining marks and NFC/NFD, and whether the 2 000-id
"injectivity pin" measures injectivity at all; (2) the **host binding** (r8-2) —
can it be supplied *wrong* (a host echoing the wire as the "authenticated"
values), is the r40-3 ownership boundary preempted, what the ambiguous-bond
definition covers, and whether a case id can still cross cases through the
case's **own** fields; (3) the **duplicate-JSON-key refusal** (r8-4) — nested
objects, arrays with repeated elements, and whether the refusal is typed; (4)
the **`resolve_round` history rule** (r8-6) at lag 0, lag 1, lag k and empty.

**Method.** Unchanged: the codec is called with hostile input, the reducer is
attacked as an API (a hostile host speaks it directly *and* hands back
tampered snapshots), and every documentary claim is re-derived from the code.
A finding is one of:

- **EXPLOITABLE** — a test in this repository shows the harm through the shipped
  interfaces; fixed here;
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited;
- **REGISTERED** — the harm is real, no pure function can close it, and the
  residual is pinned as a *visible boundary* with a named owner.

An `r9-n` id is this round's; `rN-n` ids are earlier rounds'.

**What was executed**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound9.test.ts` (**new**, 27 tests) | **27 passed** |
| the same file on **v0.14.1** (`bc28ff3`, the r8 fixes under attack) | **8 failed / 19 passed** — every closure is red on the head it replaces (§8) |
| `npm test` (full suite) | **1,831 passed / 1 skipped (82 files passed + 1 skipped)** |
| `npm run typecheck` · `typecheck:tests` · `typecheck:scripts` | clean / clean / clean |
| `__tests__/reviewRound8.test.ts` (34) + `escalationRequestWire.test.ts` | still green — no over-strictness regression |

**Verdict summary.** **1 EXPLOITABLE** — the r8-1 canonicalisation was a
*normalisation*: `caseId` was validated as `value.trim()` and the trimmed string
was returned, so `"court:X "`, `"court:X\t"` and `"court:X\u{3000}"` were one id
with **one digest** (the exact defect r8-1 was written to close) and the host
binding folded symmetrically, so a request could cross the whitespace class.
**4 PARTIAL, all fixed here**: `bondTxid` — a field *of the preimage* — was never
compared with the challenge record it names (r9-2); a signed **CONCESSION** was
minted into an **ESCALATION** (r9-3); the r8-6 history rule read one of the
case's **two round counters**, and setting the other one walked around it
(r9-4); and the 2 000-id "injectivity pin" measures sha256, not the encoding —
demonstrated by making a deliberately lossy encoder pass it with **1** distinct
digest (r9-5). Plus **3 REGISTERED** residuals, each pinned as a visible
boundary: the binding is a trust anchor a host can fill from the wire (r9-6),
bond ownership is still the host verifier's (r9-7, r40-3 is not preempted), and
the case state carries no case identity at all (r9-8). The duplicate-key target
is **BLOCKED** with the argument for why depth 1 is sufficient made explicit and
pinned.

The shape of the round: round 8 asked *what the transport binds* and answered
with three guards. All three had a field left outside the binding — `caseId`'s
whitespace class, `bondTxid`, and the `concession` flag — and the guard that
polices the ladder's history was reading the wrong one of two counters. A guard
is only as strong as the *last* field it forgets, which is why every finding
here is a field, not a mechanism.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | encoding | `"court:X "` vs `"court:X"` | **EXPLOITABLE → fixed** (r9-1): `trim()` folded distinct ids onto one digest, and `build` returned an id it was never given |
| T1 | encoding | lone surrogate start/middle/end, lone low, high+non-low | **BLOCKED** — every position refused; a real pair accepted (pinned) |
| T1 | encoding | NUL at start/middle/end/alone | **BLOCKED** — refused, including as a JSON escape |
| T1 | encoding | 256 vs 257 bytes at 1/2/3/4-byte widths | **BLOCKED** — exact; 256 accepted, 257 refused, round-trip stable |
| T1 | encoding | overlong UTF-8 (`C0 80`, `C0 AF`) | **BLOCKED** — not expressible in the string domain; in the byte domain it decodes to U+FFFD, never to the ASCII it imitates |
| T1 | encoding | NFC vs NFD (same render, different ids) | **intended** — no normalisation, pinned; the residual is a display/audit confusable |
| T1 | encoding | the 2 000-id "injectivity pin" | **PARTIAL → fixed** (r9-5): a lossy encoder passes it with ONE digest |
| T2 | binding | host echoes the wire as the binding | **REGISTERED** (r9-6) — reproduces the r8-2 harm; unpinnable in a pure function, so pinned as a boundary |
| T2 | binding | `bondTxid` ≠ the challenge record's txid | **PARTIAL → fixed** (r9-2): the logged `requestHash` committed to a bond the case never bound |
| T2 | binding | `concession: true` mapped through the escalation mapper | **PARTIAL → fixed** (r9-3): a refused authorisation recorded as an escalation |
| T2 | binding | derivable witness registered by a non-payer (r40-3) | **REGISTERED** (r9-7) — ownership is the host verifier's; pinned |
| T2 | binding | request for case A on case B's snapshot | **REGISTERED** (r9-8) — the state has no case id; the binding is the only check |
| T2 | binding | one hash, two owners / one owner, two hashes | **BLOCKED** — the first is refused, the second is attributable and refused by the reducer's ledger |
| T3 | duplicate keys | nested duplicate in a value | **BLOCKED** — refused by the field's type guard; the depth-1 scope is *sound* because every wire field is a scalar (pinned) |
| T3 | duplicate keys | arrays with duplicate elements; duplicate inside an array | **BLOCKED** — no field accepts an array, so unreachable; typed refusal |
| T3 | duplicate keys | is the refusal typed? | **BLOCKED** — `CourtConfirmationTransitionError`, asserted by class not message |
| T3 | duplicate keys | already-parsed object | **documented** — the duplicate is gone before the codec sees it; hosts pass text (pinned) |
| T3 | duplicate keys | 20 000-deep body, `1e999` | **BLOCKED** — typed refusal, no raw `RangeError`/`Infinity` escape |
| T4 | history rule | lag 1, lag k, history ahead, empty | **BLOCKED** — refused; lag 0 and [1,2] still resolve |
| T4 | history rule | `ladderRound` ≠ `ladder.round` | **PARTIAL → fixed** (r9-4): the length rule read one counter and the escalation rules read the other |

---

## 1. T1 — the canonical case id (r8-1 attacked)

### 1.1 `caseId` was still folded — distinct ids, one digest (EXPLOITABLE → fixed, r9-1)

**Attack.** r8-1 rejected unpaired surrogates, NUL and >256 bytes, then returned
`value.trim()`. `String.prototype.trim` removes every `WhiteSpace` and
`LineTerminator` code point (space, `\t`, `\n`, `\r`, `\u00a0`, `\u2000`–`\u200A`,
`\u2028/9`, `\u3000`, `\uFEFF`). Three different wire ids therefore became one
string, one preimage, one digest:

```
"court:market-r49:1 "        -> "court:market-r49:1"
"court:market-r49:1\t"       -> "court:market-r49:1"
"court:market-r49:1\u3000"   -> "court:market-r49:1"
```

**Repro (measured on v0.14.1).**

```
r9-1 caseId in : "court:market-r49:1 "
r9-1 caseId out: "court:market-r49:1"      <- returned an id it was never given
r9-1 same hash : true
r9-1 NBSP fold : "court:market-r49:1" true  <- \u00a0 too
```

**Outcome.** EXPLOITABLE. This is the r8-1 defect one normalisation call away,
and it carries two extra harms:

- **the host binding folded symmetrically.** `escalationRequestToMachineEvent`
  compared `normalised.caseId !== expectedCaseId.trim()`, so a request for case
  `"court:other:9"` was ACCEPTED against a host binding of `"court:other:9 "`.
  The r8-2c claim — "a request must not cross cases" — held only up to the
  whitespace class, i.e. a host with two cases whose ids differ by a trailing
  space (a URL path segment decoded with the space intact, a CSV import) had one
  identity for two cases;
- **the r8-5 shape came back.** `buildCourtEscalationRequest` returned a
  different `caseId` than the caller supplied, which is the "validate A, return
  B" defect r8-5 fixed for getters — here with no getter at all. A caller that
  keyed a log line by its own input and a digest by the returned value had two
  ids for one request.

**Fix.** The id is now **validated, never normalised**
(`normalizeCaseId(value, label)`): canonical UTF-8 on the RAW value, NUL-free,
non-empty, **no leading or trailing whitespace** (a typed refusal naming r9-1),
and ≤256 bytes counted on the accepted string. The preimage no longer trims
either, so a hand-built request object cannot re-introduce the fold by calling
`courtEscalationRequestPreimage` directly. The mapper validates the *binding's*
`caseId` through the same function and compares **exactly**, so both sides of
"must not cross cases" now speak the same injective domain.

**Consumer impact.** Behaviour-breaking by design on pathological ids only: a
case id with surrounding whitespace was previously accepted (folded) and is now
refused. No id a host generates carries one, and the alternative — accepting a
fold — is the collision. The refusal is discoverable at build time (typed error
naming the reason), so a host with such an id learns immediately instead of
silently sharing a digest.

### 1.2 Lone surrogates at every position (BLOCKED)

Pinned at seven positions: start, middle, end, lone LOW surrogate at start and
end, a high surrogate followed by a non-low code unit (`a\ud800\u0041`), and an
unpaired high surrogate *inside* a would-be pair (`a\ud83d\ud83db`). Every one is
refused as non-canonical UTF-8. The over-strictness control is explicit: a real
surrogate pair (`a😀`) is 5 UTF-8 bytes and is accepted — a guard that refused
all astral characters would be a denial of service on emoji-bearing ids.

The check is now made on the **raw** value rather than on a trimmed one, so a
future normalisation step cannot mask a non-canonical string.

### 1.3 NUL at start, middle, end, alone (BLOCKED)

`\u0000ab`, `a\u0000b`, `ab\u0000`, `\u0000` and `\u0000\u0000` are all refused
(`must not contain U+0000`), and the escaped wire form cannot smuggle one
(`JSON.stringify({caseId: 'a\u0000b'})` → refused). The reason is unchanged from
r8: the preimage joins fields with U+0000, so a NUL inside the id blurs a field
boundary; injectivity currently survives on a segment-count argument and the
codec must not depend on counting.

### 1.4 The byte boundary is exact (BLOCKED)

Checked at every UTF-8 width, because a byte bound implemented on `.length`
(characters) is the classic off-by-width bug:

| id | bytes | result |
|---|---|---|
| `'a'.repeat(256)` | 256 | accepted |
| `'a'.repeat(257)` | 257 | refused |
| `'é'.repeat(128)` | 256 | accepted |
| `'é'.repeat(129)` | 258 | refused |
| `'中'.repeat(85) + 'a'` | 256 | accepted |
| `'中'.repeat(85) + 'ab'` | 257 | refused |
| `'😀'.repeat(64)` | 256 | accepted |
| `'😀'.repeat(64) + 'a'` | 257 | refused |

Each accepted id is also round-tripped through `serialize` → `parse` with an
unchanged digest, so the bound cannot be met by a string that the wire later
re-encodes differently. The bound is counted on the **accepted** string: on
v0.14.1 a 257-character id whose surrounding spaces were trimmed away fit under
the limit — the same fold, one field over.

### 1.5 Overlong UTF-8 (BLOCKED — and why it cannot be an issue in this domain)

An overlong encoding (`C0 80` for NUL, `C0 AF` for `/`) is a *byte-level* attack.
Two independent reasons it cannot reach this codec:

1. **JS cannot express it.** Strings are UTF-16; `TextEncoder` emits the shortest
   form. The test re-derives the minimal encoding for `U+0000, U+0041, U+007F,
   U+0080, U+07FF, U+0800, U+FFFD, U+10000, U+1F600, U+10FFFF` and asserts
   `TextEncoder(cp) === minimal(cp)` for each — no overlong form is producible.
2. **The byte boundary is the host's, and it collapses toward safety.** A
   non-fatal `TextDecoder` turns `C0 80` into `U+FFFD U+FFFD` — *never* a NUL —
   so an overlong encoding cannot smuggle the preimage separator past the U+0000
   check. It produces a legal but different id (`"\uFFFD\uFFFD"`), and the
   substitution dies at the exact binding comparison (`must not cross cases`),
   which is pinned. The codec's own helper uses the **fatal** decoder, which
   refuses the byte sequence outright; that is the decoder a host's HTTP layer
   must use.

One quirk surfaced by the boundary sweep and now named in the test: a **leading**
U+FEFF is refused one step *earlier* than the whitespace rule, by the
canonical-UTF-8 round-trip, because `TextDecoder` strips a leading BOM
(`ignoreBOM: false`). Fail-closed, but the message mentions surrogates when the
cause is a BOM — recorded in the test so the next reader does not "fix" it into
an accepted id.

### 1.6 NFC vs NFD: two ids that render the same (INTENDED, documented)

```
"court:café:1"      (NFC)  -> accepted, digest A
"court:cafe\u0301:1" (NFD)  -> accepted, digest B   (A ≠ B)
normalize('NFC') of each -> identical
```

This is **deliberate and must stay**. Normalising (NFC/NFD/NFKC) maps distinct
inputs onto one string, i.e. it *manufactures* the collision this codec exists to
prevent: an attacker could present `NFD(x)` and `NFC(x)` for two different case
ids and get one digest. The residual is an audit/display confusable — two log
lines that look identical — and it is the host's to resolve (render ids escaped,
or generate ASCII ids). The test asserts both halves (same render, different
preimage) so a future "helpful" normalisation fails loudly.

### 1.7 The 2 000-id pin measured sha256, not the encoding (PARTIAL → fixed, r9-5)

**Attack.** r8-1's evidence was "pinned with a 2 000-id sweep":
`court:market-r48:${i}` → 2 000 distinct digests. Every one of those ids is
already a distinct canonical string, so the sweep asserts only that sha256 does
not collide over 2 000 distinct inputs. It cannot fail for any reason a `caseId`
guard can affect — including the *unfixed* code (the 2 000 ids had no
surrounding whitespace, no surrogate, no NUL).

**Repro (measured).** Run the pin's exact generator through a deliberately LOSSY
encoder — hash only the first 8 characters of the id:

```
r9-5 lossy encoder, 2000 ids -> distinct digests: 1
```

2 000 ids, **one** digest, and the r8 pin still passes. A test that cannot
distinguish a correct encoder from one that truncates the id to nothing is not an
injectivity pin.

**Fix.** The sweep is kept (distinct preimages for 2 000 ids — still a useful
smoke test) and joined by a **differential pin**: for dangerous *pairs* (NFC/NFD,
`\u0001`/`\u0002`, `\uFFFD`/`\uFFFE`, case-folded suffixes, adjacent integers)
the **preimage bytes** must differ — comparing preimages, not digests, is what
gives the test the power a digest comparison lacks — and the fold family
(`"x "`, `" x"`, `"x\u00a0"`) must be *refused* rather than encoded. The pin now
fails if a future change makes the encoding lossy, which is the property r8-1
claimed.

---

## 2. T2 — the host binding (r8-2 attacked)

### 2.1 `bondTxid` was in the preimage and outside the binding (PARTIAL → fixed, r9-2)

**Attack.** The mapper selects the challenge record by `bondProofHash`:

```
const bonds = state.challenges.filter((c) => c.bondProofHash === normalised.bondProofHash);
```

`bondTxid` was carried into the preimage (`hashCourtEscalationRequest`) and
compared with nothing. A bonded challenger therefore names **any** txid:

```
request({ bondTxid: <someone else's bond> })  -> event.requestHash commits to it
```

**Repro (measured on v0.14.1).**

```
C challenge record: {"idx":2,"bondTxid":"dddd…","bondProofHash":"eeee…",…}
C foreign bondTxid ACCEPTED, event: {… "requestHash":"ea19d493…" …}
C reducer accepted, log: {… "bondProofHash":"eeee…" …}
```

**Outcome.** PARTIAL. The machine's own ledger stays honest (`bondProofHash`
is the witness it re-checks), but the *only* record of the request — the
`requestHash` in the append-only `escalationLog` — commits to a bond this case
never bound. A host that reads `bondTxid` from the body to decide **which bond
the escalation is made under** (bond release, slashing attribution, accounting)
attributes it to a bond that paid nothing, and an auditor re-deriving the
preimage finds a txid/witness pair the case contradicts. That is the r8-2
"unverified wire claim" family on the field r8-2 forgot.

**Fix.** `normalised.bondTxid` must equal `CourtChallengeRecord.bondTxid` of the
single challenge its witness selects (typed refusal, r9-2). The pairing is
checkable on one record, and `assertValidConfirmationLedger` already requires
every challenge to carry a hex32 `bondTxid`, so there is no legacy shape to
exempt.

### 2.2 A CONCESSION minted an ESCALATION (PARTIAL → fixed, r9-3)

**Attack.** `concession: true` is validated (r8-3 hardened it to a boolean) and
committed to the hash as `'1'` — and then the mapper ignored it. The challenger's
signed exit became the opposite move.

**Repro (measured on v0.14.1).**

```
D concession minted as: escalate authority challenger
D phase: ladder_pending
D log: {"round":2,…,"requestHash":"643aced1…"}   <- a request that says "drop the appeal"
```

**Outcome.** PARTIAL, and it hits both sides of the record:

- **the audit trail inverts.** `escalationLog` is append-only and is the proof of
  who escalated (`INV-ESC-6`). Recording an escalation under the hash of a
  CONCESSION means the machine's own evidence says the challenger exercised a
  right he refused to exercise;
- **the challenger's exit is blocked.** A concession finalizes the case; the
  conversion climbs a rung instead — a fresh round bond (priced at 3× per the
  R31 economics) and a summoned panel.

**Fix.** The mapper is an *escalation* mapper; a concession is a typed refusal
naming the correct transition (`concede`). The two claims were always
distinguishable in the hash; the mapper now refuses instead of choosing for the
signer. (The machine's `concede` event carries no request witness, so a host that
wants the signed concession on the record keeps it in its own audit trail — noted
in `PER_ROUND_BOND.md`.)

### 2.3 The binding is a trust anchor, not a proof (REGISTERED, r9-6)

**Attack.** The brief's question — can the binding be supplied *wrong*? — has the
answer yes, trivially: pass the wire's own claims as the "authenticated" values.

```
claim   = request({ challengerPubkey: <juror 3's key> })
binding = { caseId: claim.caseId, authenticatedPubkey: claim.challengerPubkey }
```

**Repro (measured).** The mapper accepts, the reducer accepts, and the
append-only log names idx 2 (the bond owner, from the case) with **juror 3's**
pubkey — byte-for-byte the r8-2 attribution forgery.

**Outcome.** REGISTERED, with the reason stated rather than hidden. A pure
function receives two strings; it cannot tell the value the host *verified* from
the same value *copied*, and the state has no idx→pubkey registry to check
against (r29-5/r38-3). The fix therefore moved trust to the host — the doctrine
question the brief raises (r40-3 preemption) is answered honestly here: the guard
is real (the honest binding refuses that request), but it cannot audit its own
input.

**Disposition.** Owner: the host's escalation route (the NIP-98/bearer auth
layer). Obligation: `authenticatedPubkey` must be the pubkey the auth layer
derived from the signed request, and `caseId` must be the id the host *looked up*
— never an echo of the body. Enforced by: documentation on
`CourtEscalationBinding` (the type itself now says "a trust anchor, not a proof")
and a pinned boundary test (`T2 (r9-6)`), so a reviewer sees the residual as a
decision on the record instead of discovering it as an assumption. Trigger to
revisit: the day the machine gains an idx→pubkey registry, the mapper can check
`challengerIdx`'s key directly and this becomes BLOCKED.

### 2.4 Bond ownership is not preempted (REGISTERED, r9-7)

**Attack.** A **derivable** witness (`hash(bondTxid)`) is public the moment the
bond is on chain and uniqueness is first-come-first-served (r38-1), so a juror
owning nothing registers the payer's witness under its own index. The r8-2
binding proves the *request* was authenticated; it says nothing about who paid.

**Repro (measured).** A challenge by idx 3 whose `bondProofHash` is
`sha256(bondTxid)` of idx 2's bond is accepted by `accept_challenge`, and an
escalation quoting it maps to `challengerIdx: 3` — the copier, not the payer.

**Outcome.** REGISTERED. The mapper cannot resolve it: it holds indices, not
keys, and no ledger of payments. **Disposition.** Owner: the host's bond
verifier, which must bind the witness to the **event author** (the r40-3
doctrine), as `CourtChallengeRecord` and `PER_ROUND_BOND.md` already require.
Pinned so the claim "the r8-2 binding closes attribution" cannot be quoted
without this qualifier.

### 2.5 The case carries no case identity (REGISTERED, r9-8)

**Attack.** "Can a `caseId`/case mismatch still slip via the case's OWN fields?"
The case's own fields are `sessionHash`, `proposalHash`, roster, deadlines —
there is **no case id in the state** (`Object.keys(state)` is pinned). So the
only thing that ties a request to a case is the host's binding: a state from
case A plus a binding for case A is accepted whatever the snapshot really is.

**Outcome.** REGISTERED: state and binding must come from the same lookup
(one host read of `caseId → snapshot`). Pinned with the positive/negative pair
(the honest binding maps; a mismatched binding is refused) plus the assertion
that no case field exists to check against. Changing this would be a wire/state
change (a case id in the snapshot), not a guard — recorded as the named
alternative if a future deployment needs the machine to prove it.

### 2.6 The ambiguous bond ledger (BLOCKED, definition stated)

The refusal is `challenges.filter(hash)` returning **more than one** record — one
proof hash, two owners, on a restored snapshot (the r38-1 invariant already
refuses to *create* that shape). The reverse shape — one owner with two bonds,
which the brief also asks about — is a **different** case and is deliberately not
refused by the mapper: the filter matches the witness exactly, so exactly one row
is selected and the attribution (`challengerIdx`) is the same for both. A
mapper that "resolved" the two rows would be choosing which bond the request is
made under; instead the request names its witness, the reducer's
`assertValidConfirmationLedger` refuses the malformed ledger, and the mapper only
refuses the genuinely ambiguous shape. Both halves are pinned.

### 2.7 The case's own `challengerIdx`/`roundIndex` (BLOCKED, see r9-4)

The two fields the case supplies — `challengerIdx` from the bond record and
`roundIndex = ladderRound + 1` — cannot be steered by the wire (the r8-2 tests
pin that). What *could* be steered was the round **counter**, and that is r9-4
(§4).

---

## 3. T3 — duplicate JSON keys: how deep does the refusal reach?

**Attack.** r8-4 scans the body at **depth 1**. Three questions: (a) is a nested
duplicate reachable, (b) can an array hide one, (c) is the refusal typed?

**Repro (measured).**

| body | result |
|---|---|
| `{"caseId":{"a":1,"a":2}, …}` | refused — `CourtConfirmationTransitionError`, message is the **type** guard, not the scanner |
| `{"caseId":["a","a"], …}` | refused — same |
| `{"caseId":[{"a":1,"a":2}], …}` | refused — same |
| `{"concession":true,"concession":false, …}` (text) | refused — `repeats the field concession`, typed |
| `parse(JSON.parse(that_body))` | **accepted** (`concession: false`) — the duplicate is gone before the codec sees it |
| 20 000-deep array as `caseId` | refused, typed (the `JSON.parse` `RangeError` does not escape) |
| every field wrapped in a duplicate-key object | **all 9 refused**, all typed |

**Outcome.** BLOCKED, with the argument made explicit rather than assumed:
depth 1 is **sufficient for this wire because every wire field is a scalar**, so
a nested duplicate cannot occur in any *accepted* request — the field's type
guard refuses it first. That argument is now a test: the wire shape is asserted
field-by-field (`string | number | boolean | null`, nine names), so the day a
field becomes structured, the suite fails loudly instead of the scanner silently
narrowing. Arrays are the same story (no field accepts one) and are pinned with
duplicate elements at every field.

The refusal is typed (`instanceof CourtConfirmationTransitionError`, asserted by
**class**, not only by message — the r3-1/r41-1 "foreign error type escapes the
fail-closed boundary" class). The scanner is also shown to be robust in both
directions: a `caseId` whose *text* is `a","concession":true,"x` must not cause a
false refusal, and a genuine duplicate hidden after such a value is still caught.

**Documented residual (unchanged from r8-4, now pinned):** an already-parsed
object has lost the duplicate, so a host that parses the body itself and hands
the object over applies its *own* duplicate policy. Hosts pass the body **text**.

---

## 4. T4 — `resolve_round` and a lagging history (r8-6 attacked)

### 4.1 The boundaries (BLOCKED)

| snapshot | history | result |
|---|---|---|
| round 1 (live), empty-then-one | `[]` → `[1]` | **legal** — resolves, `[1]` |
| round 2 (live, after a real escalation) | `[1]` | **legal** — resolves, `[1,2]` (the over-strictness control) |
| round 3, one record (lag 1) | `[1]` | refused — `holds 1 record(s) but 2 round(s) were resolved` |
| round 4, one record (lag k) | `[1]` | refused — `holds 1 record(s) but 3 round(s) were resolved` |
| round 1, two records (history ahead) | `[1,2]` | refused — `holds 2 record(s) but 0 round(s) were resolved` |
| single-round ladder | `[1]` | resolves and finalizes |

No partial append: the reducer throws before building a next state, and the
attacker's snapshot is asserted byte-identical afterwards (purity). The refusals
name both numbers, so the operator sees which ledger disagreed — the r8-6 fix's
real advance over the silent `[1,4]` append.

### 4.2 The rule read one of the case's TWO round counters (PARTIAL → fixed, r9-4)

**Attack.** The state carries `ladderRound` **and** `ladder.round`. Every rung
transition reads `ladderRound` (`escalate` derives `roundIndex = ladderRound + 1`,
`open_ladder_round` validates against it, `assertValidEscalationLog` sizes the
log from it). The r8-6 rule read `ladder.round`:

```
if (state.outcomeHistory.length !== state.ladder.round - 1) throw …
```

Nothing checked that the two agree. Set `ladderRound = 4` (three rungs on the
escalation log) and `ladder.round = 2` (one history record):

**Repro (measured on v0.14.1).**

```
E snapshot ladderRound/ladder.round/history: 4 2 1
E ACCEPTED -> history rounds: [1,2] ladderRound 4 phase round_resolved
E follow-on refused: escalation round bond proof hash was already consumed by round 2
```

**Outcome.** PARTIAL. The accepted append produces a history that disagrees with
the machine's own round counter — precisely the "a history no later barrier
accepts" harm r8-6 exists to prevent — and the follow-on escalation then dies on a
consumed round bond, i.e. the case is stuck with value in escrow (the r40-2 brick,
reached through the guard that was added to prevent it). The wrong append also
feeds `outcomeHistory`, which is the reputation-scoring ledger (round weights
1.0/0.5).

**Fix, both halves.** `onResolveRound` refuses a snapshot whose `ladderRound`
differs from `ladder.round` before looking at the history (r9-4), and
`escalationRequestToMachineEvent` refuses it too — an escalation must not be
minted (and an attribution record written) against a state the machine could not
have produced. The two guards are complementary and the test asserts both
directions: the skewed snapshot is refused by the counter rule, the *consistent*
version of the same forgery (both counters 4, one record) is refused by the r8-6
rule.

---

## 5. What is still open (named, not hidden)

| # | Residual | Owner | Trigger to revisit |
|---|---|---|---|
| r9-6 | a host may fill the binding from the wire | escalation route (auth layer) | the machine gains an idx→pubkey registry |
| r9-7 | bond ownership / derivable witness preemption (r40-3) | host bond verifier | same |
| r9-8 | the state has no case identity; state+binding must come from one lookup | host router | a case id lands in the snapshot (wire change) |
| r8-4 | an already-parsed object has lost its duplicate keys | host (pass body text) | the host parses with a duplicate-aware parser |
| §1.6 | NFC/NFD render identically | host display/audit | never — normalising would create the collision |
| §1.5 | a leading BOM is refused as "non-canonical" (message names surrogates) | this package (cosmetic) | next touch of `isCanonicalUtf8Text` |

## 6. Files changed

- `courtEscalationRequest.ts` — `normalizeCaseId(value, label)` validates and
  never folds (r9-1); the preimage uses the id exactly; the mapper validates the
  binding id through the same codec and compares exactly (r9-1), requires
  `bondTxid === challenge.bondTxid` (r9-2), refuses a CONCESSION (r9-3) and a
  snapshot whose two round counters disagree (r9-4); docstrings state the
  binding's trust-anchor boundary (r9-6) and the ownership residual (r9-7).
- `confirmationMachineHandlers.ts` — `onResolveRound` requires
  `ladderRound === ladder.round` before the r8-6 history rule (r9-4).
- `__tests__/reviewRound9.test.ts` — 27 tests, **8 red on v0.14.1**.
- `docs/REVIEW_ROUND_9.md` (this file), `CHANGELOG.md`, `docs/PER_ROUND_BOND.md`.

## 7. Numbers

| | before (v0.14.1) | after |
|---|---|---|
| `reviewRound9.test.ts` | 8 failed / 19 passed | 27 passed |
| full suite | 1,804 passed / 1 skipped | **1,831 passed / 1 skipped (82 files + 1 skipped)** |
| typecheck / tests / scripts | clean | clean |
| ids folded onto one digest (whitespace family) | **unbounded** (every `WhiteSpace` code point) | 0 (refused) |
| `caseId` fields outside the binding | 2 (`caseId`'s fold, `bondTxid`) + 1 flag (`concession`) | 0 |
| round counters the history rule trusts | 1 of 2 | 2 of 2 |

## 8. Red-on-pre-fix evidence (the closures are real)

`npx vitest run __tests__/reviewRound9.test.ts` on **`bc28ff3` (v0.14.1)**:

```
× a trailing/leading whitespace id is refused instead of silently folded          (r9-1)
× the binding compares EXACTLY, so a request cannot ride a case id across the whitespace class (r9-1)
× the byte bound is exact at 256 bytes for every UTF-8 width                       (r9-1, the trim)
× the differential pin: dangerous pairs differ in the PREIMAGE BYTES or are refused (r9-5)
× a foreign bond txid is refused; the challenge record holds the binding            (r9-2)
× a signed concession cannot be minted into an escalate event                      (r9-3)
× a restored snapshot whose two round counters disagree cannot mint an attribution record (r9-4)
× r9-4: the two round counters must agree, or the r8-6 rule is bypassed             (r9-4)
Tests  8 failed | 19 passed (27)
```

The 19 that pass on both heads are the BLOCKED targets and the over-strictness
controls — they are pins on guards round 8 got right, kept so this round cannot
claim credit for them.
