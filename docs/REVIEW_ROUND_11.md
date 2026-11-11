# Review Round 11 — attacking the round-10 fixes and the exact bound (v0.15.0)

**Date:** 2026-11-11 · **Base:** `bao-court` `origin/main` @ `fe47ba4`
(v0.15.0, #126) · **Branch:** `docs/review-round-11`.

**Scope, as briefed.** Five targets, each a *fix* or a *new mechanism* rather
than the code it was written against:

1. **`quoteWireValue`** (r10-1's fix) — is the escape TOTAL over the echo path
   (every site that prints a wire value), can a value smuggle a line break
   through a *different* channel (the JSON stringifier, a template literal, a
   logged object), is the bound real, and do terminal control sequences render?
2. **`escalationRequestBindingFromSignedEvent`** (r10-3's fix) — extra fields
   inside the signed JSON, field order, unicode escapes vs literal characters,
   a signature that verifies over *other* bytes (the Nirvana class), and a kind
   supplied as a string.
3. **`assertRoundCountersAgree`** (r10-4's fix) — is every other reader of the
   ladder counters behind the barrier, and can a snapshot with agreeing counters
   and a wrong history length index out of bounds?
4. **The exact bound (v0.15.0, R52)** — the parameter parsing (`0.03` vs `0.030`
   vs `3e-2` vs a string), a parameter that overflows or hangs, and whether the
   clamp is applied before or after the exact comparison (the r40-4 class).
5. **Doctrine** — are #122's 24 tests genuine pins? Six fixes, each reverted.

**Method.** Unchanged from rounds 8–10: the codec is called with hostile input,
the reducer is attacked as an API (a hostile host speaks it directly *and* hands
back tampered snapshots), the economics is attacked as arithmetic, and every
documentary claim is re-derived from the code. A finding is one of:

- **EXPLOITABLE** — a test in this repository shows the harm through the shipped
  interfaces; fixed here;
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited;
- **REGISTERED** — the harm is real, no pure function can close it, and the
  residual is pinned as a *visible boundary* with a named owner.

An `r11-n` id is this round's; `rN-n` ids are earlier rounds'. Every finding is
dispositioned as **FIXED**, **CLOSED-BY-DESIGN**, **DEFERRED (with a trigger)** or
**REJECTED (with a reason)** — no bare "registered".

**What was executed**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound11.test.ts` (**new**, 21 tests) | **21 passed** |
| the same file against the pre-fix head (`fe47ba4` sources, §9.1) | **7 failed / 14 passed** — every fix has teeth |
| 7 mutations, each reverting a round-10 fix in turn (§6.1) | **7/7 red** — #122's pins are genuine |
| `npm test` (full suite) | **1,932 passed / 1 skipped (88 files + 1)** |
| `npm run typecheck` · `typecheck:tests` · `typecheck:scripts` | clean |

**Verdict summary.** **3 EXPLOITABLE, 3 PARTIAL, all dispositioned; 4 fixes
shipped.** (1) r10-1's escape class is *right* — ANSI/OSC, C1 and the bidi
format class are all `Cc`/`Cf` and none of them renders — but the escape was
**not total**: it covered four sites and there were **seven**, and the three it
missed were one wire value (`event.kind` on the new binder) and two *snapshot*
values (`state.ladderRound`, `state.phase`) that the barriers themselves echo,
plus the r10-4 barrier's own message; the documented 64-character bound was spent
on the **input** (a legal 60-character id produced a **387**-character echo); and
a hostile value *object* made the refusal throw (`String(Object.create(null))` →
`TypeError`) instead of refusing — a foreign error type at the boundary r3-1/
r41-1/r49-d closed (**r11-1**, FIXED). (2) The signed-content binding is sound
against every smuggling shape probed — extra fields, reordering, re-escaping,
kind swaps, a transplanted signature — but the new entry called `verifyEvent` on
an **unvalidated** event, so `tags: null` escaped as `Cannot read properties of
null (reading 'map')` and `tags: [null]` as `tag is not iterable` (**r11-2**,
FIXED). (3) No verdict path can index out of bounds — the only index is
`[length − 1]` and `record.round !== ladder.round` forces the length — but
`flag_clawback`, the one reader the r10-4 sweep did not list, persisted a
**round the ladder never opened** (**r11-3**, FIXED). (4) The exact bound holds
at its boundary, the clamp is applied *after* the comparison, and no parameter
overflows or hangs — but the parameters are rationalised from `String(number)`,
so one economy written two ways (`beta: 0.3` vs `beta: 3 * 0.1`) yields **cap 1
vs cap 2**, with the gate blessing the break-even round (**r11-5**, PARTIAL; the
doc claim is narrowed and the divergence pinned — and the fix that would have
closed it was **withdrawn** because it preempted a round-5 pin, §4.2).

The shape of the round: round 10 fixed three defects by *narrowing a channel* —
escape the echo, bind the signature, barrier the counters. Round 11 found that
each narrowing was measured at the site that had been attacked rather than at the
class: four echo sites out of seven, an event whose *shape* was never checked
before its signature, a reader list one entry short. And in the arithmetic, the
new exactness is exactness about a **value**, while the defect class it closed
lives one layer up, in the *expression* that produced the value.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | the echo path | ANSI / OSC title, hyperlink, C1 CSI, clear-screen through a legal id | **BLOCKED** — all `Cc`, all escaped |
| T1 | the echo path | the *snapshot* echo (`ladderRound`, `ladder.round`, `phase`) | **EXPLOITABLE → fixed** (r11-1): a restored `ladderRound` forged a line in the reconciliation refusal **and in the r10-4 barrier's** |
| T1 | the echo path | the *wire* echo on the new binder (`event.kind`) | **EXPLOITABLE → fixed** (r11-1) |
| T1 | the echo path | the documented 64-character bound | **PARTIAL → fixed** (r11-1): 387 output characters measured |
| T1 | the echo path | a hostile value object (`Object.create(null)`, throwing `toString`) | **EXPLOITABLE → fixed** (r11-1): raw `TypeError` out of a refusal |
| T1 | the echo path | a clip that splits a surrogate or an escape | **BLOCKED** — the clip is a prefix of the escaped value |
| T2 | signed content | an extra field inside the signed JSON | **BLOCKED** — byte-exact compare |
| T2 | signed content | field ORDER, unicode re-escaping (same value, other bytes) | **BLOCKED** — refused; the builder is the only way in |
| T2 | signed content | a valid signature over other bytes / another id | **BLOCKED** — 4 Nirvana probes |
| T2 | signed content | `kind` supplied as a string | **PARTIAL → fixed** (r11-2): the message pretended the kinds matched, and carried the newline |
| T2 | signed content | an event whose SHAPE was never validated | **EXPLOITABLE → fixed** (r11-2): raw `TypeError` at the typed boundary |
| T2 | signed content | arbitrary tags on the signed event | **CLOSED-BY-DESIGN** — signed, but no wire claim rides on them |
| T3 | ladder counters | counters agree, history shorter / longer | **BLOCKED** — `record.round !== ladder.round` |
| T3 | ladder counters | out-of-bounds / stale index on any verdict path | **BLOCKED** — no index by round exists |
| T3 | ladder counters | `flag_clawback` on a skewed snapshot | **EXPLOITABLE → fixed** (r11-3): a round-3 flag on a round-2 ladder |
| T3 | ladder counters | the sweep's own completeness claim | **PARTIAL → fixed** — the list is now the invariant, and the test sweeps it |
| T4 | exact bound | `0.03` / `0.030` / `3e-2` / a string | **BLOCKED** — one double, one rational; text refused by design |
| T4 | exact bound | one economy, two expressions (`3 * 0.1`) | **PARTIAL** (r11-5): cap 2 vs cap 1, gate `ok: true` vs `false` |
| T4 | exact bound | overflow / hang on extreme parameters | **BLOCKED** — bounded scan, measured |
| T4 | exact bound | clamp before vs after the comparison | **BLOCKED** — measured at the exact boundary |

---

## 1. T1 — the echo path (r10-1 attacked)

### 1.1 The escape class is right (BLOCKED)

The brief asks whether ANSI/OSC sequences render. They do not: `ESC` (U+001B),
`BEL` (U+0007) and the C1 introducer `CSI` (U+009B) are **`Cc`**, and the escape
pattern is `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]`. Measured through a *legal* case id
(interior control characters are not whitespace, so they pass the id rules):

```
r11-1 OSC 0 window title   : "court:\u{1b}]0;pwned\u{7}\u{1b}]8;;http://evil\u{1b}\x"
r11-1 C1 CSI colour        : "court:A\u{9b}31mred\u{9b}0m"
```

Four sequences (OSC 0, OSC 8 hyperlink, C1 CSI, clear-screen) come back with the
introducer escaped and **no** raw control character in the message
(`reviewRound11.test.ts` › `r11-1: terminal escape sequences cannot reach a
terminal`). The same class covers the bidi/zero-width residual r10 §1.2 recorded.

**The other channels are not channels.** A wire value can only reach a log
through the refusal *string*: this package has no logger, `console.error(err)`
prints `err.message` (already escaped), and the JSON stringifier is the *wire*
encoder, not an echo — `JSON.stringify` escapes `Cc` as `\uXXXX` by spec, so a
value that travels as wire text arrives as one line at the far end too.

### 1.2 The escape was not TOTAL over the echo path (EXPLOITABLE → fixed, r11-1)

r10-1's write-up says *"all four echo sites use it"*. The module has **ten**
places that interpolate a value into a refusal, and `grep '\${'` finds three that
did not go through `quoteWireValue`:

| site | value | trust | pre-fix |
|---|---|---|---|
| `escalationRequestToMachineEvent` | `event.kind` (on the **binder**) | wire | raw `String()` |
| `escalationRequestToMachineEvent` | `state.ladderRound` | **snapshot** | raw |
| `escalationRequestToMachineEvent` | `state.ladder.round`, `state.phase` | **snapshot** | raw |
| `assertRoundCountersAgree` (`confirmationMachineCore`) | `state.ladderRound`, `ladder.round` | **snapshot** | raw |

**Repro (measured on `fe47ba4`).** A restored snapshot — the exact threat model
every barrier in this module exists for — carries a *string* counter:

```
r11-1 snapshot echo: "escalation request was signed to escalate past round 1 but
  the case is resolving round 2\nESCALATION ACCEPTED for case court:target:1 — …"
r11-1 kind echo    : "escalation request event has kind 39009\nESCALATION ACCEPTED
  but this route publishes kind 39009: a request signed for another kind is …"
```

Note the second one: the *reason* reads as if the kinds matched. A host that logs
its refusals — which is what a typed refusal is *for* — writes a forged,
well-formed line into its escalation log, from a value the caller does not
control either time.

**Fix.** `quoteWireUnknown(value)` — the same escaping, total over *any* value:
only primitives are rendered, every object is `'<object>'`, and nothing calls
`toString`. It is applied at all four raw sites (and at the `round` site, which
already escaped but threw on an object, §1.4). `assertRoundCountersAgree` gets a
local `quoteCounter` that describes a non-integer counter (`'<not an integer>'`)
rather than echoing it — a 3-line helper, so no new import edge between
`confirmationMachineCore` and the escalation module.

Pinned by `r11-1: every refusal that echoes a wire or snapshot value escapes it`,
which drives **all ten** sites with `"2\nESCALATION ACCEPTED for case
court:target:1"` and asserts one line each, and by `r11-3: a restored counter
cannot forge the barrier's own refusal` for the barrier half.

### 1.3 The bound was the input's, not the output's (PARTIAL → fixed, r11-1)

`quoteWireValue` clipped the **input** to 64 code points and *then* escaped, so
the documented "bounds the echo to 64 characters" was false whenever the value
held characters that expand. A **legal** id — 18 characters of case id plus 60
zero-width spaces (180 bytes, inside the 256-byte bound, interior so `trim`
never sees them) — measured:

| | echo characters | message characters |
|---|---|---|
| `fe47ba4` | **387** | 498 |
| this round | **59** | 170 |

The budget is now spent on the escaped output, walked by **code point**: the clip
cannot split a surrogate pair (no `\p{Cs}` can appear) and cannot cut an escape
in half (every `\u{` is closed), and the result is always a **prefix** of the
full escaped value plus `…`. The same rule applies to the block: `'…'` still
marks a clip, so a truncated id cannot be mistaken for a complete one.

Mild severity on its own (498 bytes is not a flood); it is a **claim-vs-mechanism**
finding, which is the class this campaign scores worst, and it was one character
class away from being a real one.

### 1.4 A hostile value object made the refusal throw (EXPLOITABLE → fixed, r11-1)

**Attack.** `buildCourtEscalationRequest`'s round refusal built its message with
`String(roundRaw)`. A caller that passes a descriptor it did not build as a
literal — a restored draft, a proxy, a merged config — reaches:

```
r11-1 round = Object.create(null)  →  TypeError: Cannot convert object to primitive value
```

That is a **foreign error type** at the boundary r3-1/r41-1/r49-d closed (`"every
entry point of this module refuses with CourtConfirmationTransitionError or not at
all"`), and `String({ toString() { throw … } })` runs caller code inside a
refusal. Fixed by `quoteWireUnknown`: `<object>`, `<symbol>`, `<function>` — the
type, never the value, and no user code.

### 1.5 The sweep, as of this round

| # | site | value | escaped by |
|---|---|---|---|
| 1 | cross-case message | request `caseId` | `quoteWireValue` |
| 2 | cross-case message | host-bound `caseId` | `quoteWireValue` |
| 3 | round refusal | request `round` | `quoteWireUnknown` (was `String`) |
| 4 | unknown field | JSON field name | `quoteWireValue` |
| 5 | repeated field | JSON field name | `quoteWireValue` |
| 6 | kind refusal | `event.kind` | `quoteWireUnknown` (was raw) |
| 7 | stale-round refusal | `state.ladderRound` | `quoteWireUnknown` (was raw) |
| 8 | no-open-ladder refusal | `state.phase` | `quoteWireUnknown` (was raw) |
| 9 | counter-skew refusal | both counters (mapper) | `quoteWireUnknown` (was raw) |
| 10 | counter-skew refusal | both counters (`assertRoundCountersAgree`) | `quoteCounter` (was raw) |

The remaining interpolations in the module (`assertHex32`'s field name,
`normalizeCaseId`'s label, `bonds.length`, `normalized.round`, a hex32 txid) are
module constants, a validated safe integer, an array length, or an
`assertHex32`-validated value — none can carry a control character.

**Disposition: FIXED** (§1.2, §1.3, §1.4). The residual is unchanged and is a
property of the *caller*: a host that interpolates a wire value into its own log
line outside this package gets none of this (r11-6, §7).

---

## 2. T2 — the signed-content binding (r10-3 attacked)

### 2.1 Field order, extra fields, re-escaping (BLOCKED, fail-closed)

`courtEscalationRequestSignedContent` is the canonical wire form minus `eventId`,
produced by `JSON.stringify` over an object built in `WIRE_FIELDS` order. The
binding compares **strings**, so every re-encoding is a refusal:

| signed `content` | outcome |
|---|---|
| canonical text | **binds** (`{ caseId, authenticatedPubkey }`, pubkey derived from the signature) |
| canonical + `"bonus":"drop-the-appeal"` | refused — *not the canonical serialization* |
| same fields, `concession` moved to the front | refused — same decoded object, different bytes |
| `court:mark\u0065t-r50:1` instead of `court:market-r50:1` | refused — same decoded id, different bytes |

**Which does it hash?** The literal bytes the signer put in `content` — and that
is the fail-closed direction: the event id commits to `content` as a string, so
two byte spellings are two events, and only the canonical one binds. There is no
"two spellings, one request". The cost is interop, and it is the cost r10-3
already named: a host that invents its own content layout is outside the binding,
which is *why* the builder ships with the verifier.

### 2.2 The Nirvana class (BLOCKED)

Four probes, all refused, each for its own reason:

| probe | refusal |
|---|---|
| the honest id with **another event's bytes** (id mismatch) | event-id compare |
| the honest id with **another event's signature** (a valid sig, wrong bytes) | *signature does not verify* |
| the same content re-signed under **kind 39008** and presented as 39009 | *signed for another kind* (the kind is inside the id) |
| the request's eight fields each retyped while keeping the event | *not the canonical serialization* |

The last row is the totality pin: for **every** wire field (`caseId`, `round`,
`challengerPubkey`, `bondTxid`, `bondProofHash`, `roundBondProofHash`,
`signedAtSec`, `concession`) the test asserts both that the field name is in the
preimage text and that retyping it refuses — so the eight cannot all be passing
for one shared reason. Verified structurally too: `content` contains all eight
names and **no** `eventId` (an id cannot be inside its own preimage).

### 2.3 The kind as a string (PARTIAL → fixed, r11-2)

`event.kind !== expectedKind` refused a string already (`'39009' !== 39009`), so
nothing was accepted — but the message said *"has kind 39009"* by stringifying
the attacker's value, which is (a) a diagnostic that reads as a match, and (b)
§1.2's injection. Now the shape check fires first and says what is true
(`"kind must be a non-negative safe integer (got 39009\u{a}ACCEPTED)"`), and
`39009.5`, `-1` and `NaN` are refused by the same rule.

### 2.4 The event's SHAPE was never validated (EXPLOITABLE → fixed, r11-2)

**Attack.** The binder checked `isRecord(event)`, then rebuilt a plain object —
`tags: event.tags.map(tag => [...tag])` — and then called `verifyEvent`. But
`verifyEvent` is **tolerant**: it returns `false` for a malformed event, it does
not validate. The rebuild runs *before* it:

```
r11-2 tags: null   →  TypeError: Cannot read properties of null (reading 'map')
r11-2 tags: [null] →  TypeError: tag is not iterable
```

A raw `TypeError` out of a *fail-closed boundary* is the r49-d class, on the one
entry in this module written to refuse hostile input. The package already had the
right pattern — `courtHostKey.ts`'s `reconstructEventForVerification` validates
`id`/`pubkey`/`sig`/`kind`/`created_at`/`content`/`tags` **before**
`verifyEvent` — and the new entry reproduced the rebuild without the check.

**Fix.** Shape first: kind (non-negative safe integer), id and pubkey (hex32),
`sig` (128 hex), `created_at` (non-negative safe integer), `content` (string),
`tags` (array of string arrays), *then* the kind compare, *then* the rebuild and
`verifyEvent`. Pinned with 13 malformed shapes, plus the over-strictness control
(a shape-valid, signature-invalid event still reaches — and fails — the
signature check).

### 2.5 Tags are signed but carry no wire claim (CLOSED-BY-DESIGN)

The binder constrains no tag. Nothing in the request is expressed there (there is
no tag field on the wire), so a tag cannot smuggle a claim — and a host that
routes on tags is reading its own convention, not this wire's. Pinned both ways:
arbitrary tags (`['t','concession']`, `['e',…]`, `['x',…]`) **bind**, and
mutating them after signing **breaks the id** (they are inside the signed bytes).

**Disposition: FIXED** for §2.3 and §2.4; **CLOSED-BY-DESIGN** for §2.5. The r9-6
obligation is unchanged: the binder exists, and a host that does not call it
learns nothing new from this round. **DEFERRED** (trigger: the host's
request-event shape is fixed in this package, at which point the binder becomes
mandatory rather than available).

---

## 3. T3 — the ladder counters (r10-4 attacked)

### 3.1 Every reader, enumerated

`grep -rn 'ladderRound\|ladder\.round\|outcomeHistory'` over the package, minus
tests, gives **five** readers of a counter and **three** of the history:

| reader | counter | behind the barrier | locks in |
|---|---|---|---|
| `resolve_round` | `ladder.round`, `ladderRound` | **yes** (r9-4) | the round's outcome + history record |
| `escalate` | `ladderRound` | **yes** (r10-4) | a rung + a panel seat |
| `open_ladder_round` | `ladderRound` | **yes** (r10-4) | a seat + the vote ledger |
| `finalize` / `deriveFinalVerdict` | both | **yes** (r10-4) | the verdict |
| transport mapper | both | **yes** (r9-4) | an attribution record |
| **`flag_clawback`** | `ladderRound` | **no** (r11-3 — now yes) | a clawback record's round |
| `tick` | `ladder.voteDeadline` only | n/a | a phase expiry |
| `close_ladder_round` | via `assertValidMassVoteLedger` | no | freezes a ledger `resolve_round` re-derives |
| `challengerEscalationEvent` / `hostEscalationEvent` | `ladderRound` | no | nothing — they mint an *event*; `escalate` re-checks |

### 3.2 A wrong history length cannot be indexed (BLOCKED)

`deriveFinalVerdict` reads `outcomeHistory[outcomeHistory.length - 1]` and
requires `record.round === ladder.round`; `assertValidOutcomeHistory` requires the
history to be a consecutive `1..k`. Since the last record's `round` is `k`, the
two together force `k === ladder.round`. Measured on the honest three-round ladder
(rounds `1/2/3` resolve `NO/YES/NO`), counters agreeing at `3`:

| snapshot | outcome |
|---|---|
| honest | **finalizes, `NO`** (round 3's) |
| history `[1,2]` (short) | refused — *the last resolved round is 2 but the ladder is at round 3* |
| history `[1,2,3,4]` (long) | refused — *the last resolved round is 4* |
| history `[]` | refused — *no resolved-round record* |
| history `[1,3]` (gap), `[9]`, empty winners | refused — consecutive `1..k`, non-empty winners |

There is no `outcomeHistory[round]` indexing anywhere in the package, so the
"shorter history → out of bounds / stale entry" probe has no site to land on: the
only index is the last element, and the last element's **own** round number is
cross-checked. The stale-entry variant (counters agree, history shorter, *and*
the verdict read anyway) cannot be spelled.

### 3.3 `flag_clawback` persisted a round the ladder never opened (EXPLOITABLE → fixed, r11-3)

**Attack.** r10-4's sweep table lists ten events; `flag_clawback` is not on it,
and it is the one transition that *writes* a counter into a persisted record:

```ts
clawbackFlags: [ ..., { idx: event.idx, reason: event.reason, round: state.ladderRound } ]
```

**Repro (measured on `fe47ba4`).** A restored `fee_settlement` snapshot with
`ladderRound 3` and `ladder.round 2`:

```
r11-3 flag_clawback on a skew: ACCEPTED
r11-3 flag written          : [{"idx":1,"reason":"late fee","round":3}]
```

A clawback attributed to round 3 on a case whose ladder says round 2 — and the
state is one the machine could not have produced, so the flag is also the *last*
thing before the case bricks. Severity is bounded: `clawbackFlags` are
deliberately **not** a verdict input (`finalize` says so, twice), so this cannot
mint a wrong verdict — it is the audit/fee channel, the same channel r29-2
closed for the escalation log.

**Fix.** `assertRoundCountersAgree(state)` in `onFlagClawback`, before the record
is written. Pinned by `r11-3: the sweep — flag_clawback was the one reader outside
the barrier` (skew refused; the honest case still flags, naming round 3).

### 3.4 A uniformly rewound snapshot (BLOCKED, with the registered residual)

Delete the *whole* last rung — `ladderRound` 3→2, `ladder.round` 3→2, the last
log record **and** the last history record — and the state is internally coherent.
It is still refused at `finalize`, because the vote ledger is round 2's while the
remaining history record says `YES`:

```
r11-3 uniformly rewound: cannot finalize: the round 2 vote ledger tallies "NO" but
  the recorded outcome is "YES" — one of the two was not produced by resolve_round
```

The general "drop a rung and its evidence consistently" case is the r33-5 log
deletion residual (a legacy `requireRoundBond: false` case cannot tell a deleted
record from a pre-0.12 snapshot); it is unchanged here and stays registered.

### 3.5 The sweep's completeness claim (PARTIAL → fixed)

`confirmationMachineCore`'s doc comment for `assertRoundCountersAgree` claimed the
invariant *"is enforced at the ONE point every event passes (the reducer's
pre-dispatch block)"* — the placement round 10 explicitly **implemented and
reverted** (`REVIEW_ROUND_10.md` §4.4: three existing pins construct a skewed
snapshot on purpose to exercise other guards). The reducer's own comment
(`courtConfirmationMachine.ts`) and the round-10 document say the opposite. The
comment now says what the code does: *the list of entries is the invariant*, and
this round's file sweeps it.

**Disposition: FIXED** for §3.3 and §3.5; **BLOCKED** for §3.2 and §3.4;
**DEFERRED** for the structural unification (two fields still exist; trigger: the
next field added to `CourtLadderRound`, or a snapshot schema bump — unchanged
from r10 §4.4).

---

## 4. T4 — the exact bound (v0.15.0)

### 4.1 The parameter parsing: one double, one rational (BLOCKED)

`exactRational` reads `String(value)` (ECMA-262's shortest round-trip text), so
every spelling of the **same double** is the same rational and the same bound:

```
0.03 / 0.030 / 3e-2 / 0.03e0 / 3/100  →  cap 5, flip 7 (identical)
```

The text form is refused (`a_f as a string` is an existing pin in
`reviewRound5.test.ts`, part of *"adversarial parameters throw a typed error"*),
so there is no second spelling to disagree with. No canonicalisation class
instance here.

### 4.2 One economy, two expressions (PARTIAL, r11-5)

**Attack.** The exactness proved is exactness about the **value**; the value is
whatever the caller computed. `β = 3ρ` with `ρ = 0.1` is one economy and two
doubles:

| parameters | rational | cap | gate at cap 2 |
|---|---|---|---|
| `{ a_f: 0.5, rho: 0.1, beta: 0.3 }` | `3/10` | **1** | `ok: false` |
| `{ a_f: 0.5, rho: 0.1, beta: 3 * 0.1 }` | `30000000000000004/10^17` | **2** | **`ok: true`** |

At `a_f = ½, β = 3ρ` the exact predicate is at break-even on round 2
(`E[π](2) = 0`) — the very point R52's `floor`-to-`BigInt` change was written to
exclude — and the arithmetic spelling **admits it**, with the pre-flight gate
blessing the configuration. The fail direction is the dangerous one: more β means
"more safe", so the fuzz *raises* the cap. It is not a rounding corner: `1 - 0.9`
(=`0.09999999999999998`), `0.1 + 0.2`, `3 * 0.1` and `77 / 100` all carry it.

**Attempted fix, withdrawn.** Widening `LadderParameters` to `number | string`
(parsing `'0.3'` exactly) is ~25 lines and was implemented — and it turned
**four** existing tests red, including round 5's deliberate
`['a_f as a string', { a_f: '0.9' as unknown as number }]` refusal: *"adversarial
parameters throw a typed error rather than returning garbage"*. That pin is a
decision (a JSON body's `"0.03"` must not silently become a parameter), and
round 10 §4.4 already set the rule — **preempting a pin to simplify a fix is how
a suite loses teeth**. The widening is therefore *not shipped*; it is the
mechanism the trigger names.

**Disposition: PARTIAL → the claim is narrowed, the divergence pinned, DEFERRED
with a trigger** ("a parameter-shape change — `LadderParameters` accepting decimal
text or an exact rational — which must also revise round 5's `a_f as a string`
pin"). Shipped here: the module header and `deriveMaxLadderRounds` no longer say
`β = 3ρ` *is* seen as the boundary (they say it is seen as the boundary **for the
decimal the parameter names**, with both spellings in the examples), and
`r11-5: two spellings of ONE economy diverge at the exact boundary` pins cap 1 vs
cap 2 and `ok: false` vs `ok: true` — a visible boundary, not an assumption.
Owner: the host that owns the policy constants (it must pass the literal decimal,
not an expression). Trigger to revisit: above.

### 4.3 Overflow and hang (BLOCKED)

`exactRational` builds `10n ** k` from the shortest text — at most 324 decimal
places, at most 17 significant digits — and the scan is bounded at
`MAX_LADDER_ROUNDS` (`+1` for the flip round). Measured on the extremes
(`Number.MIN_VALUE`, `Number.MAX_VALUE`, `5e-324`, `1.7976931348623157e308`,
`0.9999999999999999`): every call returns a safe integer in `0..5` in well under a
millisecond, and 60 worst-case derivations (324-digit denominators, five-round
powers) finish in single-digit milliseconds. The test asserts the *values* (a
`Number.isSafeInteger` cap in range, a non-`NaN` flip round) and uses a generous
5-second wall clock only as a **hang detector**, not as a performance pin.

### 4.4 The clamp is applied AFTER the comparison (BLOCKED)

The r40-4 class is "clamp the derivation, then compare against the clamp". Here
the only clamp is `capFromExact`'s ceiling (`return MAX_LADDER_ROUNDS` after the
scan) and the gate never reads it: `ladderCapWithinBound.ok` is
`strictlySafeAtDepth(exact, maxLadderRounds)`, evaluated at the **caller's** cap.

Measured at the boundary the class needs:

```
a_f = ½, β = 3ρ  → float derivation floor(...) = 2   (the break-even round)
                 → deriveMaxLadderRounds           = 1
                 → gate at cap 2                   = ok:false
                 → deriveLadderFlipRound           = 2
```

and across a **32-point grid** (`a_f ∈ {0.30 … 1} × β ∈ {0.03, 0.09, 0.3, 3}`):
`gate(derivedCap).ok === true` and `gate(derivedCap + 1).ok === false` at every
point where `derivedCap ≥ 1`, and `gate(1).ok === false` wherever `derivedCap = 0`
(so "0 means refuse every ladder" is enforced, not documented). The ceiling clamp
is proven to bind **upwards only**: at `a_f = 0.9` the derivation is 6, the cap is
reported as 5 (the ceiling) and the gate is still decided at 5; at `a_f = 1` the
cap is the ceiling and the flip round is `Infinity`.

`deriveLadderFlipRound` is telemetry (the decision never reads it), and its
floating-point fallback can only *over*-report: `Math.max(MAX + 2, ceil(boundary))`
is a floor, so a monitoring alert cannot be lulled by a number below the first
unsafe round. Pinned.

---

## 5. Doctrine — are #122's closures genuine pins?

Six fixes from round 10 (plus the r9-1 fold, as a control), each reverted in
turn in a scratch copy; `npx vitest run __tests__/reviewRound10.test.ts` after
each.

| mutation | result | tests that went red |
|---|---|---|
| M1 `quoteWireValue` → identity (r10-1) | **2 red / 22** | *a refused id can no longer forge a log line*; *the other three echo sites are escaped too* |
| M2 the binder's content comparison removed (r10-3) | **1 red / 23** | *the signed-event binder refuses the flip in BOTH directions* |
| M3 `finalize`'s counter barrier removed (r10-4) | **2 red / 22** | *finalize accepted a skewed ladder…*; *the skew cannot be laundered through concede → finalize either* |
| M4 `escalate`/`open_ladder_round` barrier removed (r10-4) | **1 red / 23** | *escalate and open_ladder_round refuse a skew before spending a seat* |
| M5 the digest domain `v2` → `v3` (r10-5) | **1 red / 23** | *a DOMAIN-ONLY change fails the pin: the domain is re-derived, not read back* |
| M6 the r9-1 trailing-whitespace refusal removed | **4 red / 20** | the trim-class, the totality, the refusal-shape and the 2 000-id sweep tests |
| M7 the r9-1 fold returned by `validateCaseId` | **4 red / 20** | same four |

**7/7 mutations red, each on its own assertion.** #122's doctrine claim is
honest, and the round-10 fixes are pinned at the behaviour (not at the message
text), which is why round 11 could restructure `quoteWireValue` and add whole
branches to the binder without touching a single round-10 test.

---

## 6. What is still open (named, not hidden)

| # | Residual | Owner | Trigger to revisit |
|---|---|---|---|
| r11-5 | a parameter expressed by ARITHMETIC is the ulp of its decimal, so one economy can yield cap 1 or cap 2 at an exact boundary (§4.2) | the host's policy config (pass the literal decimal) | a parameter-shape change (`LadderParameters` accepting decimal text / a rational), which must also revise round 5's `a_f as a string` pin |
| r11-6 | the escape protects *this package's* refusals; a host that interpolates a wire value into its own log loses it | the host's logger | the host adopts `quoteWireValue`/a structured logger — note the binder's own message is safe, so a host that logs `err.message` inherits the guarantee |
| r9-6 | a host that keeps a private request-event layout may fill the binding from the wire | the escalation route | the host's request-event shape is fixed here → the binder becomes mandatory |
| r9-7 | bond ownership / derivable-witness preemption (a challenge lockout) | host bond verifier | an idx→pubkey registry lands in the case state |
| r9-8 | the state has no case identity; state + binding must come from one lookup | host router | a case id lands in the snapshot |
| r8-4 | an already-parsed object has lost its duplicate keys | host (pass body text) | the host parses with a duplicate-aware parser |
| r10 §4.4 | `ladder.round` and `ladderRound` are still two fields; the invariant is per-entry, now with a complete list and a sweeping pin | this package | the next field added to `CourtLadderRound`, or a snapshot schema bump |
| r33-5 | a legacy (`requireRoundBond: false`) case cannot distinguish a deleted log entry from a pre-0.12 snapshot | host policy | every new deployment sets `requireRoundBond: true` (already the default) |
| — | `docs/REVIEWS_INDEX.md` was last refreshed at #117 (rounds 7–8); rounds 9, 10 and 11 are unindexed | this package | the next index refresh — deliberately not half-done here |

## 7. Files changed

- `courtEscalationRequest.ts` — `quoteWireValue` spends its budget on the escaped
  output and walks code points; `quoteWireUnknown` makes the echo total over
  untyped values (r11-1); four raw sites now use it; the binder validates the
  event's SHAPE (kind/id/pubkey/sig/created_at/content/tags) before
  `verifyEvent` and before the kind compare (r11-2).
- `confirmationMachineCore.ts` — `assertRoundCountersAgree` describes a
  non-integer counter instead of echoing it (r11-1) and its doc comment no longer
  claims the pre-dispatch placement round 10 reverted (r11-3).
- `confirmationMachineHandlers.ts` — `flag_clawback` joins the barrier (r11-3).
- `ladderEconomics.ts` — documentation only: the `β = 3ρ` claim is narrowed to
  the decimal the parameter names, with both spellings in the examples (r11-5).
- `__tests__/reviewRound11.test.ts` — **new**, 21 tests.
- `docs/REVIEW_ROUND_11.md` (this file).

## 8. Numbers

| | before (`fe47ba4`) | after |
|---|---|---|
| `reviewRound11.test.ts` | — (new, 21 tests) | 21 passed |
| the same file on the pre-fix sources | — | **7 failed / 14 passed** |
| full suite | 1,911 passed / 1 skipped (87 files + 1) | **1,932 passed / 1 skipped (88 files + 1)** |
| typecheck / tests / scripts | clean | clean |
| echo sites escaped (of 10) | 7 | **10** |
| echo characters for a legal 60-character Cf id | 387 | **59** |
| refusal channels that can write a non-message into a log | 4 | **0** |
| raw `TypeError`s at the binder's boundary (13 malformed shapes) | 2 | **0** |
| ladder-counter readers behind the barrier (of 6) | 5 | **6** |
| round-10 pins with teeth (mutations reverted) | — | **7 / 7** |

## 9. Evidence

### 9.1 The new tests against the pre-fix head

Sources restored to `fe47ba4`, new test file kept:

```
× r11-1: the budget is spent on the ESCAPED output, not on the input
× r11-1: every refusal that echoes a wire or snapshot value escapes it
× r11-1: a hostile value OBJECT is described, never stringified
× r11-2: a malformed event SHAPE is a typed refusal, not a raw TypeError
× r11-2: the kind must be a NUMBER, and the refusal says so honestly
× r11-3: the sweep — flag_clawback was the one reader outside the barrier
× r11-3: a restored counter cannot forge the barrier's own refusal
Tests  7 failed | 14 passed (21)
```

The 14 that pass on both sides are the BLOCKED targets (the escape class, the
signed-content totality, the history-length rules, the bound grid, the clamp
order, the parameter spellings) — a finding that is not a fix must not need one.
`r11-5` also passes on both sides by design: it pins a boundary that is
unchanged, and it is the *documentation* that moved.

### 9.2 Pre-fix measurements (quoted verbatim in §§1.2–1.4, 3.3)

```
r11-1 cf-id echo: 387 characters (message 498)   [after: 59 / 170]
r11-1 snapshot echo: "… resolving round 2\nESCALATION ACCEPTED for case court:target:1 — …"
r11-1 kind echo:     "… has kind 39009\nESCALATION ACCEPTED but this route publishes kind 39009: …"
r11-1 round=Object.create(null): TypeError: Cannot convert object to primitive value
r11-2 tags: null   -> TypeError: Cannot read properties of null (reading 'map')
r11-2 tags: [null] -> TypeError: tag is not iterable
r11-3 flag_clawback on a skew (ladderRound 3, ladder.round 2): ACCEPTED
r11-3 flag written: [{"idx":1,"reason":"late fee","round":3}]
r11-5 β=0.3 → cap 1 / gate(2) ok:false;  β=3*0.1 → cap 2 / gate(2) ok:true
```

### 9.3 Suite stability

Two full-suite runs were made on this branch. The first, taken while the parallel
campaign's worker pools held the machine, reported 5 failures in four
**timing-sensitive** files (`appealWatcher`, `independentSigning`,
`propertiesValidator`, `r33ByzantineRelay` — relay and ceremony timing, 5–22 s per
test). Each was re-run in isolation with no source change and passed (27/27), and
the final run (§8) is green — contention, not a regression, exactly the pattern
`REVIEW_ROUND_10.md` §10.4 recorded.
