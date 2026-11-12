# The escalation-request WIRE, differentially

**Round 49.** The escalation transport (`courtEscalationRequest.ts`, v0.14.x) had
no independent implementation: every test of it is written against the code it
tests, so a shared misreading of the contract — a field order, a sentinel, a
definition of "whitespace" — is invisible to the suite. This document is the
record of a second implementation in a different language, the 100 000-case
differential that compared them, the five corners it forced a decision on, and
what such a differential cannot see.

- implementation under test: `courtEscalationRequest.ts` (shipped, v0.14.2)
- independent reference: `scripts/differential/wire_ref.py` (Python 3, stdlib only)
- harness: `scripts/differential/run.mjs` (seeded corpus, both sides, comparison)
- suite member: `__tests__/differentialWire.test.ts` (fast mode + the pins)
- campaign artifacts: `scripts/differential/results/r49-100k.json` (post-fix),
  `scripts/differential/results/r49-prefix.json` (the same corpus, shipped codec)

**Result.** 100 000 cases, seed `20261111`, 0 disagreements after the fixes;
**4 distinct disagreements (443 case instances) before them** — two shipped bugs
and three under-specified sentences. All five resolved, none by copying.

---

## 1. The gap this closes

The machine has a differential-parity harness (five independent
reimplementations, 0 disagreements, `__tests__/differentialParity.test.ts`).
The wire did not. Its whole test surface — `escalationRequestWire.test.ts`,
`reviewRound8.test.ts`, `reviewRound9.test.ts` — asserts the codec's own
behaviour, so it can prove "the codec is consistent with its comments", never
"the codec is what the comments say". Review rounds 7-9 found four defects in
this exact file (a hash that ignored a field, a lossy id encoding, a silently
coerced boolean, a mapper that bound nothing), and every one was found by *a
reader*, not by a test: the tests were green because they agreed with the bug.

Two implementations written from the same prose in different languages fail
differently. That is all this is: a second pair of eyes that cannot be talked
into the same mistake by the same line of code.

---

## 2. Spec sources — what the reference was written FROM

The reference was NOT written from the TypeScript. It was written from:

| Source | What it pins |
|---|---|
| `docs/PER_ROUND_BOND.md` § *Transport (R43, H-6)*, § *The mapping needs the host's binding (r8-2)*, § *The binding is a TRUST ANCHOR (r9-6)* | the nine wire fields, the optional per-round witness, the host binding `{caseId, authenticatedPubkey}`, the wire/case split of the event |
| `docs/REVIEW_ROUND_9.md` §1.1 | ids are validated **exactly** — never folded, never normalised; canonical UTF-8; NUL-free; ≤256 bytes |
| `docs/REVIEW_ROUND_9.md` §2.6, §3 | the ambiguous-bond refusal; duplicate-key detection is depth-1 **and why that is sufficient** (every wire field is a scalar) |
| `CHANGELOG.md` v0.14.0 / v0.14.1 / v0.14.2 | r8-1..r8-6, r9-1..r9-4 as prose: what was refused and why |
| the JSDoc of `courtEscalationRequest.ts` | the contract's own summary: field order, the `'-'` sentinel, domain `v2`, the `1`/`0` concession bit, the known-answer digest |

**Where the spec is thin, the reference had to decide.** Three sentences turned
out to be under-specified, and each produced a real divergence (§5). They are
recorded here so the next implementer (a host in Rust, a relay in Go) does not
have to rediscover them:

1. *"must not have leading or trailing whitespace"* — **which characters?** (D1)
2. *"canonical UTF-8 (no unpaired surrogates)"* — the check is a **round-trip**,
   and a round-trip through a WHATWG decoder also refuses a leading BOM (D4)
3. a JSON **numeric literal** — a fractional literal that rounds to a safe
   integer, or an integer beyond ±(2^53−1) (D3)

---

## 3. The field-by-field contract

`buildCourtEscalationRequest` / `parseCourtEscalationRequest` accept exactly
these nine fields. A tenth field on the wire is a refusal (`additionalProperties:
false` is the point of a wire shape: a peer that drops a field silently is how
H-6 happened). `build` takes a typed descriptor and ignores extra keys; `parse`
refuses them.

| # | field | wire type | rule | refusal class |
|---|---|---|---|---|
| 1 | `caseId` | string | the UTF-8 round-trip is the identity (no lone surrogate, no leading `U+FEFF`); no `U+0000`; non-empty after trim; **no** leading/trailing ECMAScript whitespace; ≤ 256 UTF-8 **bytes**; used EXACTLY (no `trim`, no NFC/NFD) | `case_id_not_canonical`, `case_id_nul`, `case_id_type_or_empty`, `case_id_whitespace`, `case_id_too_long` |
| 2 | `round` | number | integer in `1..5` (the machine ceiling); the request opens `round + 1` | `round` |
| 3 | `challengerPubkey` | string | `^[0-9a-f]{64}$` — lowercase only | `hex32_challenger_pubkey` |
| 4 | `bondTxid` | string | idem | `hex32_bond_txid` |
| 5 | `bondProofHash` | string | idem (the membership bond witness) | `hex32_bond_proof_hash` |
| 6 | `roundBondProofHash` | string \| null, **optional** | idem, or `null`/absent (the legacy shape). The serializer ALWAYS emits the slot, so "absent" is explicit | `hex32_round_bond_proof_hash` |
| 7 | `eventId` | string | `^[0-9a-f]{64}$` | `hex32_event_id` |
| 8 | `signedAtSec` | number | a **safe** integer ≥ 0 (client clock, replay bound, never a host clock) | `signed_at` |
| 9 | `concession` | boolean, **optional** | absent ≡ `false`; a non-boolean (`"true"`, `1`, `null`, `{}`) is a refusal — a signed flag is not a truthiness test (r8-3) | `concession_type` |

**Check order is part of the contract** (first refusal wins, so a multi-fault
input reports one class): `caseId` → `round` → `roundBondProofHash` →
`signedAtSec` → `concession` → `challengerPubkey` → `bondTxid` →
`bondProofHash` → `eventId`. The differential fuzzes multi-fault inputs
precisely because a re-implementer will otherwise order these differently and
neither implementation is "wrong" — the wire has to say which error a caller
sees.

`parse` additionally, in this order: (a) the body text must be JSON
(`json`); (b) a top-level repeated field is a refusal **after decoding the key**,
so `"c\u0061seId"` counts (`duplicate_key`); (c) the value must be an object
(`not_object`); (d) an unknown field is a refusal (`unknown_field`). An
already-parsed object cannot be checked for duplicates — that policy belongs to
whoever parsed it, so hosts hand `parse` the body **text**.

### 3.1 The canonical preimage and digest

```
domain  = "BAO-Court/Escalation/Request/v2"          (33 bytes)
digest  = sha256( domain ‖ 0x00 ‖ field₀ ‖ 0x00 ‖ field₁ ‖ … )

fields  = caseId, String(round), challengerPubkey, bondTxid, bondProofHash,
          (roundBondProofHash ?? '-'), eventId, String(signedAtSec),
          (concession ? '1' : '0')
```

- **`'-'` sentinel** (r7 H-6): no hex32 equals `-`, so "no per-round witness"
  and "a per-round witness" can never share a digest. `null` and *absent* are
  the same request.
- **`1`/`0`, never a truthiness** (r8-3): the concession bit is committed, so a
  dropped flag and a refused one are different requests.
- **Domain separation** (r7, "v2"): the round-bond witness was NOT in the v1
  preimage, and a hash that ignores a field cannot be fixed by adding it — the
  old digest would still verify for a request with a different witness. The v2
  domain makes v1 digests fail closed everywhere.
- **Known answer** (shared with the host's `CourtEscalationService.ts`):
  `38f94655c82847e158c451d02e338db9f6742d23556c029ed6b7773e0e0bab5f` for the
  r43 fixture. `wire_ref.py --selftest` reproduces it from the prose — the
  cheapest possible confirmation that the reference read the contract, not the
  code.

### 3.2 The wire → `escalate` event split

`escalationRequestToMachineEvent(state, request, now, binding)` fills every
field the reducer's `escalate` arm declares. Who supplies what is the contract:

| event field | source | why |
|---|---|---|
| `type`, `authority` | constant (`'escalate'`, `'challenger'`) | the mapper only mints challenger escalations |
| `challengerPubkey` | **wire** | the challenger's claim, verified only by the binding |
| `bondProofHash` | **wire** | the membership witness the case must already hold |
| `roundBondProofHash` | **wire**, omitted when `null` | absent ≠ `null` in the event; the reducer reads absence as legacy |
| `requestHash` | **derived** (v2 digest of the normalised request) | the append-only log's only record of *which* request |
| `challengerIdx` | **case** (the bond record's `idx`) | a challenger cannot choose its own roster index |
| `roundIndex` | **case** (`ladderRound + 1`) | a challenger cannot choose the rung it opens |
| `now` | **host** (clock) | never from the wire |

The mapper's refusals, in order (first wins): request re-validation →
`concession_not_escalation` (r9-3) → `binding_missing` → binding `caseId`
validation (`case_id_*`) → `binding_pubkey_format` → `binding_case_mismatch`
(r8-2) → `binding_pubkey_mismatch` (r8-2) → `state_shape` → `binding_round`
(r8-2) → `ladder_missing` (r9-4) → `ladder_counters` (r9-4) → `state_shape`
(ledger not an array, D2) → `bond_none` → `bond_ambiguous` (r38-1) →
`bond_txid` (r9-2) → `now`.

**v0.15.3 — the lane projection.** A state that declares `projection: 'lane'`
(courtEscalationRequest.ts, `docs/LANE-PROJECTION.md`) is exempt from
`ladder_missing`: its round ledger is the host's case row, so it carries a real
`ladderRound` and no `ladder`. The counter itself is validated by the shared
barrier, so a lane with a non-integer counter is still `ladder_counters`
(the reference implements the same rule from the spec, and the corpus carries six
lane cases: `lane-projection`, `lane-projection-round2`,
`lane-projection-with-ladder`, `lane-projection-counter-string`,
`lane-projection-counter-float`, `unknown-projection-missing-ladder`).

---

## 4. Harness design

```
        seeded corpus (JS, mulberry32)                  both sides, one record each
  ┌───────────────────────────────────┐        ┌──────────────────────────────────────┐
  │ 423 deterministic boundary cases  │  JSONL │  A. courtEscalationRequest.ts (tsx)  │
  │ + random mutations to 100 000     │ ─────► │  B. wire_ref.py (python3, stdlib)    │
  └───────────────────────────────────┘        └──────────────────────────────────────┘
                        │                                     │
                        └──────────────►  compare ◄───────────┘
       (a) accept/refuse   (b) refusal CLASS   (c) preimage + digest bytes on accept
       (d) canonical wire string and the mapped `escalate` event on accept
                                          │
                              disagreement → shrink to a minimal repro
```

**Operations.** Every case is one of four, so each layer of the contract is
fuzzed on its own terms:

| op | what runs | why |
|---|---|---|
| `build` | `build` on an arbitrary descriptor | field rules, check order, numbers, encodings |
| `parse_text` | `parse` on raw body text | JSON, duplicate keys, unknown fields, canonicality of the *bytes* |
| `parse_object` | `parse` on an already-parsed value | the duplicate policy is gone; the type guards must still hold |
| `to_event` | `build` + `escalationRequestToMachineEvent` | the wire/case split, the binding, the ledger |

**Corpus.** 423 deterministic cases first (always included, in every mode), then
seeded random mutations of valid shapes:

- the whole **edge-character set** (35 code points = ECMAScript whitespace ∪
  Unicode-only whitespace ∪ zero-width/bidi), at both edges, alone, and interior;
- the 255/256/257-**byte** bound at UTF-8 widths 1/2/3/4;
- lone surrogates at 8 positions (plus a well-formed pair as the control);
  NUL at 4; NFC/NFD pairs; astral; CJK; bidi isolates;
- every hex field × 13 malformed shapes (uppercase, 63/65 chars, spaces, `null`,
  numbers, arrays, objects);
- round/clock/flag edges: `0`, `6`, `-1`, `1.5`, `1e400`, `9007199254740993`,
  `2^53`, `-0`, `true`, `"1"`, `null`, arrays, objects;
- raw bodies: reordered keys, injected whitespace, escaped keys
  (`"c\u0061seId"`), duplicate keys top-level/nested/identical-value, duplicate
  after a `","concession":true,"` string trap, `__proto__`, snake_case field
  names, trailing commas/garbage, BOM, `NaN`/`Infinity`/`01`/`1.`/`.5`/`+1`,
  20 000-deep nesting, non-objects;
- snapshots: every binding mismatch; concession; round skew; `ladder` absent /
  `null` / array / counter skew; ledger absent / non-array / `null` row / string
  row / ambiguous bond; `now` invalid.

**Comparison.** Four axes, all structural:

1. **accept/refuse** — the one decision that must never differ;
2. **refusal CLASS** — mapped, never string-compared. Both sides map onto one
   closed set of 31 classes (`REFUSAL_CLASSES` in `run.mjs`, the `Refusal.code`
   values in `wire_ref.py`): a class is a *decision* ("refused because the id is
   folded"), a message is prose. The TypeScript side is classified from the
   error's `code` (`CONFIRMATION_TRANSITION`) plus an ordered pattern table; an
   error that is not the codec's own typed refusal classifies as `panic`, which
   is itself a finding (a foreign error type at a fail-closed boundary);
3. **preimage bytes and digest** — compared as strings, so a field-order or
   sentinel bug cannot hide behind a matching 32-byte coincidence;
4. **canonical wire string and event shape** — the serializer's bytes (key
   order, no whitespace, `null` slot) and the mapped event, canonically
   JSON-compared after key sorting (numbers are one type in JS).

**Shrinking.** Every distinct disagreement is greedily minimised — drop object
keys, shorten strings, neutralise numbers, drop ledger rows — re-running *both*
implementations on each candidate and keeping the first that still disagrees
with the SAME signature. The committed artifact carries the minimal repro, so a
finding is a runnable input rather than a 300-line payload.

---

## 5. Decisions the differential forced (the spec sentences)

Each is a sentence that was missing or ambiguous, the two readings, the
decision, the reason, and where it is pinned. **None was resolved by copying the
shipped behaviour without an argument** — where the shipped code was wrong it
was fixed; where the *sentence* was thin, the sentence was written down and both
sides pinned to it (two implementations agreeing on a sentence is a contract;
two implementations agreeing because one was edited to match the other is a
coincidence).

### D1 — "leading or trailing whitespace" is the **ECMAScript** set

*Sentence as written:* "`caseId` must not have leading or trailing whitespace".
*Readings:* (a) `String.prototype.trim` — WhiteSpace ∪ LineTerminator, **plus
`U+FEFF`**, but **not** `U+0085` or `U+001C..U+001F`; (b) Unicode `White_Space`
/ Python `str.isspace()` — the opposite membership on exactly those characters.

The two readings disagree in **both directions**, on invisible characters, at
the one place two ids must not become one id:

| character | ECMAScript `trim` (shipped) | Unicode `White_Space` |
|---|---|---|
| `U+0085` NEL | **id character** (accepted) | whitespace (refused) |
| `U+001C`..`U+001F` | **id characters** (accepted) | whitespace (refused) |
| `U+FEFF` ZWNBSP | whitespace (refused at an edge) | **id character** (accepted) |
| `U+180E` MVS | id character | id character (post-Unicode 6.3) |

**Decision: the ECMAScript set is the contract**, and it is written down here
because the codec *is* a JavaScript library and `trim` is the definition the
sentence is implemented with. Nothing about the manifest is lost by accepting
`U+0085` as an id character (no fold happens, so no collision); the important
half is that a second implementer knows exactly which code points are refused.
Pinned in `wire_ref.py` (`JS_WHITESPACE`), in
`__tests__/differentialWire.test.ts` (all 25 set members at both edges + the 5
Unicode-only characters as accepted id characters), and in the corpus sweep
(4 cases per character).

*Host consequence:* store and route ids **byte-exactly**. The codec will not
fold `"court:X "` into `"court:X"` for you; it refuses it.

### D2 — a tampered snapshot is a **typed** refusal (shipped bug, fixed)

`escalationRequestToMachineEvent` read `state.ladderRound` and
`state.challenges.filter(...)` before any shape check, so a restored snapshot
escaped as a **raw `TypeError`**:

| snapshot | shipped (v0.14.2) | reference |
|---|---|---|
| `state = null` | `TypeError: Cannot read properties of null (reading 'ladderRound')` | typed `state_shape` |
| `challenges = {}` / `null` / `"rows"` | `TypeError: state.challenges.filter is not a function` (**344/100 000 cases**) | typed `state_shape` |
| `challenges = [null]` | `TypeError: Cannot read properties of null (reading 'bondProofHash')` (**95 cases**) | typed (`bond_none`, or the real row) |
| `state = 5` / `"state"` / `[]` | `TypeError` | typed `state_shape` |

**Verdict: shipped bug.** `@bao/court` documents a typed-only boundary
(`errors.ts`, the r3-1/r41-1 "foreign error type escapes the fail-closed
boundary" family) and already owns the guard for it — `assertStateArrays`
(`courtCeremonyCore.ts`) exists *for this exact reason*: "Guards that call
`.includes`/`.find`/`.map` would otherwise crash with an uncaught TypeError".
This path did not use it, and the one snapshot shape that is restored from disk
is the one shape nobody types. Fixed in `courtEscalationRequest.ts`: a record
state, an array ledger, and object-only rows (a non-object row carries no
witness, so it cannot match — the reducer's own ledger validation still owns
"this ledger is malformed"). Pinned in the test and in the corpus.

### D3 — a number field is the **IEEE-754 double** its literal denotes

A JSON numeric literal is not a value, and the sentence said nothing about it:

| literal | a double parser (JSON.parse) | an exact/decimal parser |
|---|---|---|
| `9007199254740991.4` | the integer `9007199254740991` → **accepted** | not an integer → **refused** |
| `9007199254740990.5` | the integer `9007199254740990` → **accepted** | not an integer → **refused** |
| `9007199254740993` | `2^53` → outside the safe range → refused | `…993` → outside the safe range → refused |
| `1e400` | `Infinity` → refused | out of range → refused |

**Decision: the receiver's double is the contract** (JSON.parse semantics) — the
wire is JSON, `signedAtSec` is a client clock, and this is what every JS host and
every `double`-based parser will do. Consequence stated for hosts: **encoders
must emit decimal integers inside ±(2^53−1)**; a fractional literal that happens
to round to a safe integer is accepted and digested as the rounded value, so a
sender outside that rule has emitted something whose meaning is its parser's.

**Status of this finding.** The reference modelled doubles from its first draft
(it parses with `parse_int=float`), so the campaign never recorded D3 as a
disagreement — it is a **corner closed by decision**, not a bug found, and it is
listed here because a Rust/Go host using exact integers would diverge. Pinned in
the reference and in the test.

### D4 — canonicality is a **round-trip**, and it also refuses a leading BOM

*Sentence as written:* "canonical UTF-8 (no unpaired surrogates)".
*Actual test:* `decode(encode(value)) === value`, through a WHATWG
`TextDecoder`, whose default **strips one leading `U+FEFF`**. So:

| id | class reported | why |
|---|---|---|
| `"\ud800"` | `case_id_not_canonical` | a lone surrogate has no UTF-8 form (r8-1) |
| `"\ufeffcourt:x"` | `case_id_not_canonical` | the decoder ate the BOM, so the round-trip differs |
| `"court:x\ufeff"` | `case_id_whitespace` | trailing — the trim rule |
| `"\ufeff"` | `case_id_not_canonical` | round-trip to `""` |
| `"court\ufeff:x"` | accepted | interior |

**Decision: the round-trip is the contract**, because the round-trip is the
injectivity test that the whole rule exists for, and **both readings refuse** the
leading-BOM id — the accepted domain and its injectivity are identical. What
differs is only the reported reason, and there the shipped wording is a
**diagnostic wart**: "no unpaired surrogates" sends an operator hunting a
surrogate that is not there. Registered for the owner rather than fixed here,
because the only true fix changes `isCanonicalUtf8Text`, which
`courtVoteMachine` uses to refuse BOM-prefixed ballot **outcomes** — a different
module and a behaviour change out of this round's scope. Pinned in the
reference (explicit BOM-strip model) and in the test (leading vs trailing vs
interior vs BOM-only).

### D5 — a non-object descriptor is a **typed** refusal (shipped bug, fixed)

`build(null)` → `TypeError: Cannot read properties of null (reading 'caseId')`.
The r8-5 hardening ("a getter… could escape as a raw `TypeError` …
instead of this module's typed refusal") covered reading the *fields* once; it
did not cover the argument itself, and `build`, `hash`, `serialize` and
`escalationRequestToMachineEvent` all reach it (`parse` was already safe, it
checks `isRecord` first). `build([])` was classified `case_id_type_or_empty`
where a non-object body is `not_object` — two names for one decision.

**Verdict: shipped bug (fail-open only in the sense that a host cannot tell a
typed protocol refusal from a crash).** Fixed: a non-object descriptor refuses
with the class the wire already uses for a non-object body (`not_object`).
Pinned in the test across all four entry points.

---

## 6. The 100 000-case campaign

Seed `20261111`, 100 000 cases, `--count 100000`. Both runs used the **same
corpus** (`accept` and `refuse` counts are identical), so the only variable is
the codec.

| | shipped v0.14.2 | this branch |
|---|---|---|
| cases | 100 000 | 100 000 |
| accept / refuse | 51 252 / 48 748 | 51 252 / 48 748 |
| **distinct disagreements** | **4** | **0** |
| disagreeing case instances | 443 | 0 |
| wall clock (this host, warm) | 11.0 s | 10.4 s |

By operation: `build` 35 203, `parse_text` 24 925, `parse_object` 9 893,
`to_event` 29 979. By refusal class (post-fix, TypeScript side; the reference
classifies identically on all 100 000):

| class | n | class | n | class | n |
|---|---|---|---|---|---|
| `json` | 739 | `hex32_round_bond_proof_hash` | 785 | `binding_missing` | 931 |
| `not_object` | 964 | `hex32_challenger_pubkey` | 2 114 | `binding_pubkey_format` | 904 |
| `duplicate_key` | 5 001 | `hex32_bond_txid` | 2 114 | `binding_case_mismatch` | 766 |
| `unknown_field` | 4 053 | `hex32_bond_proof_hash` | 2 074 | `binding_pubkey_mismatch` | 191 |
| `case_id_type_or_empty` | 3 264 | `hex32_event_id` | 1 604 | `binding_round` | 918 |
| `case_id_not_canonical` | 611 | `signed_at` | 3 202 | `ladder_missing` | 756 |
| `case_id_nul` | 568 | `concession_type` | 6 324 | `ladder_counters` | 171 |
| `case_id_whitespace` | 1 854 | `round` | 4 165 | `bond_none` | 469 |
| `case_id_too_long` | 353 | `concession_not_escalation` | 1 440 | `bond_ambiguous` | 72 |
| `now` | 1 900 | `bond_txid` | 97 | `state_shape` | 344 |
| `panic` | **0** | | | | |

### 6.1 Every disagreement and its resolution

| # | signature (op / axis / TS / reference) | cases | verdict | resolution |
|---|---|---|---|---|
| 1 | `to_event` / class / `panic` / `state_shape` | 344 | **TS bug** | ledger not an array was a raw `TypeError` → typed refusal (D2) |
| 2 | `to_event` / class / `panic` / `bond_none` | 95 | **TS bug** | `null` ledger row dereferenced → object-only matching (D2) |
| 3 | `build` / class / `panic` / `not_object` | 1 | **TS bug** | `build(null)` raw `TypeError` → typed `not_object` (D5) |
| 4 | `build` / class / `case_id_type_or_empty` / `not_object` | 3 | **TS bug** | `build([])` reported a field rule for a non-object argument (D5) |
| — | `build` / class / `case_id_not_canonical` / `case_id_whitespace` | 3 | **spec gap** | leading `U+FEFF`: two readings of the canonicality sentence (D4) |
| — | `build` / class / `case_id_not_canonical` / `case_id_type_or_empty` | 1 | **spec gap** | `U+FEFF` alone (D4) |
| — | `build` / class / same / same (whitespace family) | exploratory | **spec gap** | `U+0085` / `U+001C..1F` (D1) |
| — | `parse_text` / accept-vs-refuse | not observed | **spec gap** | fractional numeric literals, e.g. `9007199254740991.4` (D3) |

Rows 1-4 are the committed `r49-prefix.json`. The next three are from the
**first** exploratory run, before the reference's thin-sentence corners were
pinned; they are reproducible by reverting one line of `wire_ref.py` (the
canonicality test to `encode`-only, `JS_WHITESPACE` to `str.isspace`) and
re-running the sweep — that is exactly what "the sentence was thin" means. D3 is
the other kind: a corner the reference closed by decision before it could ever
disagree, recorded so an exact-integer host knows what the wire means.

No accepted case disagreed on the preimage, the digest, the serialized bytes or
the event shape at any point in the 100 000 — the agreement that matters is on
the *bytes*, not only on the decision.

---

## 7. The residual — what a second implementation cannot catch

Stated plainly, because a differential harness is easy to oversell:

1. **A shared misreading of one sentence.** Both implementations were written in
   this round from the same prose. If a sentence says the wrong thing — e.g. the
   preimage field order in the JSDoc were *itself* the mistake — both sides
   inherit it and the differential stays green. Only a reader (or a third
   implementation by someone who never saw this doc) catches that. The one
   anchor against it is the shared known-answer digest, which is pinned by the
   **host** too (`CourtEscalationService.ts`) — but a host that ported the same
   sentence is in the same boat.
2. **What neither implements.** A *missing* rule (a freshness/replay window for
   `signedAtSec`, a case-id→case binding in the state, bond ownership) is absent
   from both sides and cannot be found by comparing them. Those are the
   registered residuals of review rounds 8-9 (`r9-6` trust anchor, `r9-7` bond
   ownership, `r9-8` case identity) and they stay registered.
3. **The generator's shape space.** The corpus is seeded and finite: a defect
   reachable only through a shape the generator does not produce (a 300-field
   body, a JSON string with 4-byte-escaped surrogates split across a duplicate
   key, an exotic number format) is invisible. The deterministic sweep covers
   every *character set* and *length boundary* the contract names; it does not
   cover every *combination*.
4. **Platform divergence.** Both sides run on this host (Node 22 `JSON.parse`,
   Python 3.14 `json`). A different JS engine or Python version could differ on
   a corner neither side models — the double-rounding decision (D3) exists
   precisely because this class of divergence is real, and it is documented
   rather than eliminated.
5. **Timing and state.** These are pure functions; the differential says nothing
   about the *host's* use of them (replay, ordering, concurrency, whether the
   binding is filled from the auth layer or copied from the body — the r9-6
   obligation).

What it *does* catch, and did: raw errors escaping a typed boundary, a
diagnostic that names the wrong rule, an error class that depends on which layer
noticed first, a re-implementation's different reading of an unstated corner,
and any accidental divergence in the digest over 51 252 accepted requests.

---

## 8. Running it

```bash
# the reference alone: the shared known answer + its boundary table (~40 ms)
python3 scripts/differential/wire_ref.py --selftest

# fast mode — 2 000 cases including the whole deterministic sweep (~1 s)
npx tsx scripts/differential/run.mjs --only

# the campaign — 100 000 cases, writes scripts/differential/results/r49-100k.json (~10-30 s)
npx tsx scripts/differential/run.mjs

# a different corpus / a narrower run
npx tsx scripts/differential/run.mjs --count 20000 --seed 7 --out /tmp/out.json
```

**CI policy.** The fast mode is a suite member (`__tests__/differentialWire.test.ts`,
~2 s, skipped when `python3` or the local `tsx` is unavailable) because it is
cheap and it pins the parity claim. The 100 000-case campaign is **not** in the
default suite: ~10-30 s and its output is a committed artifact to be compared,
not an assertion to be re-run. A disagreement makes `run.mjs` exit non-zero,
print the signature and the minimal repro, and write nothing — so a campaign can
never silently record parity it did not measure.

**Reproducibility.** The PRNG is `mulberry32` seeded by `--seed`; the corpus is
identical across runs and machines for a given `--seed` and `--count` (verified:
the prefix and post-fix artifacts above have identical accept/refuse counts on
the same seed). The Python reference is stdlib-only (`hashlib`, `json`, `math`,
`re`) and is invoked as `python3`; set `BAO_DIFFERENTIAL_PYTHON` to override the
interpreter.
