# Review Round 12 — attacking the round-11 fixes (v0.15.1)

**Date:** 2026-11-11 · **Base:** `bao-court` `origin/main` @ `e489fe5`
(v0.15.1, #129) · **Branch:** `docs/review-round-12`.

**Scope, as briefed.** Five targets, each one of round 11's fixes rather than
the code it was written against:

1. **Escape totality** (r11-1's fix) — prove the escape is total over the echo
   path *mechanically*, then probe the helper's edges: a value that is already a
   quoted value, a value spelling the escape's own marker, the clip's unit
   (code points or UTF-16 code units?), a lone surrogate.
2. **Event-shape validation** (r11-2's fix) — fuzz the validator from its own
   accepted grammar and run `verifyEvent` on every shape; probe the reverse
   direction for over-strictness on legal events.
3. **The clawback barrier** (r11-3's fix) — enumerate every handler that WRITES
   a ladder counter and prove each is behind the barrier or independent; probe
   the ordering for a legal interleaving the barrier now refuses.
4. **The r11-5 divergence** (deferred) — decide `beta: 0.3` vs `beta: 3 * 0.1`,
   and apply the campaign's canonicalisation rule.
5. **Doctrine** — are #128's four fixes genuine pins? Each reverted in turn.

**Method.** Unchanged from rounds 8–11: the codec is called with hostile input,
the reducer is attacked as an API (a hostile host speaks it directly *and* hands
back tampered snapshots), the economics is attacked as arithmetic, and every
documentary claim is re-derived from the code. A finding is one of
**EXPLOITABLE** (a test here shows the harm through the shipped interfaces;
fixed), **PARTIAL** (the guard exists but is incomplete, or the documented claim
is stronger than the mechanism), **BLOCKED** (the guard holds, with the pin
cited), **CLOSED-BY-DESIGN** (the behaviour is a decision, measured and pinned),
**REGISTERED** (the harm is real, no pure function can close it, pinned as a
visible boundary with a named owner). No finding this round needed
**REGISTERED**: every one is either fixed or closed with a measurement.

**What was executed**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound12.test.ts` (**new**, 20 tests) | **20 passed** |
| the same file against the pre-fix sources (`e489fe5`, §10.1) | **9 failed / 11 passed** |
| 4 mutations, each reverting one of #128's fixes in turn (§6.1) | **4/4 red** |
| `npm test` (full suite) | **1,953 passed / 1 skipped (90 files)** |
| `npm run typecheck` · `typecheck:tests` | clean |

**Verdict summary.** **1 EXPLOITABLE cluster (7 sites, fixed), 1 PARTIAL
(fixed), 2 BLOCKED, 1 CLOSED-BY-DESIGN.** Round 11's three fixes are *right*:
the escape class holds, the binder's shape gate holds under 20 000 fuzzed
shapes, and every ladder writer is behind the barrier. What round 12 found is
that round 11 measured each fix **in the two files it was editing**:

- the escape is total over `courtEscalationRequest.ts` and
  `confirmationMachineCore.ts`, and **not** over
  `confirmationMachineHandlers.ts` (44 raw interpolations, including
  `state.phase` × 15 and `String(event.roundIndex)`) or
  `courtConfirmationMachine.ts` (`event.type` and `String(unknownType)` on the
  front door) — and `String(Object.create(null))` there throws a raw `TypeError`
  and runs caller code, which is verbatim r11-1 §1.4 one module over
  (**r12-1**, FIXED);
- the counter barrier's *message* was made total in round 11 but its
  *invariant* was still `===`, so two counters forged to the SAME non-integer
  passed it and `flag_clawback` **persisted** the forged value — r11-3's harm on
  the one shape r11's own probe did not try (**r12-1**, FIXED);
- the clip was documented as 64 characters and returned 65 whenever it clipped
  (`body + '…'`), and it counted UTF-16 units for astral characters
  (**r12-2**, PARTIAL → FIXED);
- the r11-5 deferral named a fix that is arithmetically impossible — `String(x)`
  *is* the shortest round-trip decimal, so two distinct doubles can never be
  merged losslessly; the only merge is a lossy rounding that moves OTHER
  boundaries, i.e. a new parameter domain, not a bug fix (**r12-5**,
  CLOSED-BY-DESIGN, §5).

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | the echo path | the **static** sweep: 66 raw interpolations in 4 files | **EXPLOITABLE → fixed** (r12-1) |
| T1 | the echo path | `String(event.type)` on the reducer's front door | **EXPLOITABLE → fixed** (r12-1): raw `TypeError`, and caller code ran |
| T1 | the echo path | `state.phase` × 15, outcomes, indices, `roundIndex` | **EXPLOITABLE → fixed** (r12-1): forged log lines |
| T1 | the counter barrier | two counters forged to the SAME non-integer | **EXPLOITABLE → fixed** (r12-1) — persisted, not just echoed |
| T1 | the helper | the documented 64-character bound | **PARTIAL → fixed** (r12-2): 65 measured |
| T1 | the helper | double-quote, marker, astral, lone surrogate | **BLOCKED / CLOSED-BY-DESIGN** (r12-2) |
| T2 | the shape gate | 20 000 shapes from its own grammar | **BLOCKED** (r12-3) |
| T2 | the shape gate | legal signed shapes, reverse direction | **BLOCKED** (r12-3) |
| T2 | the signature | `{ ...event }` copies nostr-tools' memoised verdict | **BLOCKED** (r12-3) — the rebuild is load-bearing |
| T3 | ladder writers | the write sweep (5 writers, 5 non-writers) | **BLOCKED** (r12-4) |
| T3 | ladder writers | a legal interleaving the barrier refuses | **BLOCKED** — none exists (r12-4) |
| T4 | `beta: 3 * 0.1` | the deferred fix is arithmetically impossible | **CLOSED-BY-DESIGN** (r12-5) |

---

## 1. T1 — the echo path (r11-1 attacked at the class)

### 1.1 The escape is total over two files, not over the echo path (EXPLOITABLE → fixed, r12-1)

**The mechanical check.** `reviewRound12.test.ts` › *the static sweep* discovers
every source file that constructs `CourtConfirmationTransitionError` (four
today, discovered via the constructor name, not listed), extracts every
`${…}` inside a typed refusal and inside a state `failure.reason` template, and
requires each expression to be one of:

| allowed | why it cannot carry a hostile value |
|---|---|
| `quoteWireValue(…)`, `quoteWireUnknown(…)`, `quoteCounter(…)` | the canonical escape (courtEcho.ts, §1.3) |
| `MAX_…`, `MIN_…` (an ALL-CAPS identifier) | a module constant |
| `typeof <x>` | a type name, never a value |
| `<x>.length` | a number, whatever the collection holds |
| a numeric literal | a number |

Anything else is a violation with `file:line`. The check is a *property* test,
not a list: a new file that throws the typed error is scanned automatically, and
a new raw interpolation fails the suite. Two guards keep the check honest:
a teeth test feeds it the exact pre-fix lines and asserts it reports them, and a
*one implementation* assertion fails if a second `quoteWire*`/`quoteCounter`
definition appears anywhere in the package.

**What it found on `e489fe5`: 66 raw interpolations.**

| file | sites | of which reachable with a caller/snapshot value |
|---|---|---|
| `confirmationMachineHandlers.ts` | **44** | 44 — `state.phase` × 15, `event.idx` × 4, `bondOwner.idx`, `membershipBond.idx`, `consumed.round`, `record.round` × 3, `state.ladderRound`, `state.ladder.round`, `state.maxLadderRounds` × 2, `state.confirmQuorum`, `state.outcomeHistory.length`, `state.ladder.round − 1`, `event.round`, `String(event.roundIndex)`, `expectedRound`, `pending.outcome`, `derived.outcome` × 2, `state.proposedOutcome`, `String(pending.upheld)`, `String(derived.upheld)`, `tallied.winner`, `record.outcome`, two `.length`s |
| `courtConfirmationMachine.ts` | **3** | 3 — `event.type`, `state.phase`, `String(unknownType)` |
| `confirmationMachineCore.ts` | **9** | `state.ladderRound` in the log-completeness refusal (r11's §1.5 table implied the core's remaining interpolations were safe — this one was not), plus indices and derived counts |
| `courtEscalationRequest.ts` | **10** | none today — literals, a validated round, two hex32 ids — but safe by CONVENTION, which is what a static check turns into a rule |

Round 11's §1.5 table is a *site* enumeration for one module; it reads like a
totality claim. The class is "every refusal in the package", and 47 of the 66
sites are in files round 11 never opened.

**Repro (measured on `e489fe5`).**

```
unknown event type (string):      "unknown confirmation event type: boom3\nESCALATION ACCEPTED for case court:target:1"
unknown event type (null-proto):  TypeError: Cannot convert object to primitive value
unknown event type (toString):    Error: boom                      ← the CALLER's code ran inside the refusal
escalate roundIndex object:       TypeError: Cannot convert object to primitive value
escalate roundIndex string:       "escalation roundIndex 3\nESCALATION ACCEPTED for case court:target:1 does not open the next ladder round 1"
```

The first is r11-1 §1.2's harm (a forged, well-formed line in the operator's
log); the second is r11-1 §1.4's harm (a foreign error type at the boundary
r3-1/r41-1/r49-d closed, and caller code executed); the third is the same site
on the *reducer's front door*, where every event in the package enters.

### 1.2 The barrier's invariant was `===`, so agreement alone was enough (EXPLOITABLE → fixed, r12-1)

**Repro (measured on `e489fe5`).** A restored `fee_settlement` snapshot whose
**two** counters are forged to the same non-integer:

```
ladderRound = "3\nESCALATION ACCEPTED for case court:target:1", ladder.round = the same
  → flag_clawback: ACCEPTED
  → clawbackFlags: [{"idx":1,"reason":"late","round":"3\nESCALATION ACCEPTED…"}]

ladderRound = 2.5, ladder.round = 2.5
  → flag_clawback: ACCEPTED
  → clawbackFlags: [{"idx":1,"reason":"late","round":2.5}]

resolve_round on the same shape:
  "cannot resolve round 3\nESCALATION ACCEPTED…: the outcome history holds 0 record(s) but NaN round(s)…"
```

That is r11-3's finding *resurrected*: a clawback attributed to a round the
ladder never opened, this time **persisted** rather than echoed, plus the raw
echo r11-1 fixed. Round 11's probe forged only `ladderRound`, so the pair
disagreed and the barrier fired; the shape that *agrees* was never tried. The
lesson is r10's again, one layer down: round 11 made the barrier's **message**
total and left its **predicate** unchanged.

**Fix.** `assertRoundCountersAgree` now enforces the field's write domain — a
non-negative safe integer — on both counters, and requires `ladderRound === 0`
when no ladder is open (a counter with no ledger is the mirror image of a skew).

### 1.3 The fix: one escape, used by every refusal

`courtEcho.ts` (new) holds the single implementation (`quoteWireValue`,
`quoteWireUnknown`, `quoteCounter`) that the codec, the core, the handlers and
the reducer all import; the local copies in `courtEscalationRequest.ts` and
`confirmationMachineCore.ts` are gone, and the static sweep fails if a second
definition appears. Every one of the 66 sites now goes through it, and
`quoteWireValue` is **total at runtime** as well as in the type: a field the
type declares as `string` can be `undefined` on a restored record, and the
round-12 fix's own first draft reproduced the `value is not iterable` class on
`bond.bondTxid` before the runtime guard was added (§10.4).

### 1.4 What is deliberately NOT an escape site

`quoteWireValue` is not injective (§2.2), and this round does **not** claim the
log can be parsed back into values. The claim is the narrow one the mapping can
prove: **no refusal message can contain a `Cc`/`Cf`/`Zl`/`Zp`/`Cs` character
supplied by a caller or a snapshot**, so a refusal cannot BE a line. A host that
interpolates a wire value into its own message outside this package still loses
the guarantee (r11-6, unchanged).

---

## 2. T1b — the helper's own edges (r12-2)

### 2.1 The bound was 65, documented as 64 (PARTIAL → fixed)

Round 11 spent the budget on the escaped output — the right move — but returned
`out + '…'`, so any clipped echo was one character past the documented bound.
Measured with the round-11 helper and this round's:

| input | round 11 | this round |
|---|---|---|
| `\u{1F600}` × 40 (astral) | **65** characters (33 code points) | **63** (32) |
| `\u2066` × 64 (all escaping) | **65** | **57** |
| `court:A` + 60 zero-width spaces | 64 | **64** |

The fix reserves one character of the budget for the marker, so the output is
`≤ 64` in code points **and** in UTF-16 code units, marker included. The astral
line is the interesting one: the budget is counted in code units, which is never
smaller than the code-point count, so an astral character costs two units and
the clip is *tighter* than a code-point budget — never looser, and it can never
split a surrogate pair.

### 2.2 Double-quoting, the marker, and a lone surrogate (BLOCKED / CLOSED-BY-DESIGN)

| probe | result |
|---|---|
| `quoteWireValue(quoteWireValue(v))` | **idempotent** for control chars, format chars, astral, `…`, and a literal `\u{1b}`: two authors quoting one message cannot double-escape it |
| a value containing the escape's own text (`"\\u{1b}]0;pwned"`) | **unchanged**, and renders identically to an escaped `ESC` — the echo is **not injective** |
| a value ending in `…` | **unchanged**, and renders like a clip |
| a lone surrogate `"\uD800"` | escaped (`\u{d800}`); never emitted. Through the wire: `parse` names an unknown field `c\ud800` as `\u{d800}`; a lone surrogate in a **case id** is refused by the canonical-UTF-8 rule before any echo (r8-1) |

The non-injectivity is **CLOSED-BY-DESIGN**, with the reason stated: the safe
direction is the only one that matters (no control character reaches the log),
and the ambiguity can only make a hostile value look *more boring* than it is —
an attacker cannot make a benign value look dangerous in a way that costs the
operator anything, and cannot make a clipped value look complete because the
marker is a suffix, not a prefix.

`quoteWireUnknown` and `quoteCounter` were re-probed for totality: ten hostile
values (null-prototype object, throwing `toString`, symbol, bigint, null,
undefined, array, function, float, boolean) all render as strings, and the
`toString` that would set a flag never ran. `quoteCounter` now also describes a
**negative** integer (`<not an integer>`): the write domain is non-negative, and
a message must not imply that `-1` is a round.

---

## 3. T2 — the shape gate (r11-2 attacked)

### 3.1 20 000 shapes from the validator's own grammar (BLOCKED)

The fuzz builds every field from the type the gate ADMITS and randomises the
value: `kind ∈ {0, 1, 39009, 22242, MAX_SAFE_INTEGER}`,
`created_at ∈ {0, 1, 1790000000, MAX_SAFE_INTEGER}`, `id`/`pubkey` random hex32,
`sig` random hex128, `content ∈ {'', 'x', '{}', '\n\u202e\u0000', 300×x}`, and
seven tag shapes (empty, `[['t','x']]`, `[['']]`, `[['a','b','c']]`, eight
tags, a tag containing `\u0000`). Half the corpus is bound to its own event id
so it reaches the crypto path.

| measurement | value |
|---|---|
| shapes fuzzed | **20 000** |
| typed refusals | **20 000 / 20 000** |
| reached `verifyEvent` and failed on the signature | **1 955** |
| raw throws from the binder | **0** |
| `verifyEvent` throws (called directly on every shape) | **0** |
| refusals containing a raw control character | **0** |

`verifyEvent` is tolerant by construction (it wraps its work in `try/catch` and
returns `false`), which is exactly why r11-2's shape-first rule is load-bearing:
the *rebuild* that runs before it is the throw site.

### 3.2 The reverse direction: legal shapes bind (BLOCKED)

Four genuinely signed shapes — `kind: 0` at the epoch with empty tags,
`kind: 1` with empty tag values, the route kind with a `\n`/bidi/astral content,
and 32 tags with a 400-byte content — all **bind** (and `verifyEvent` agrees).
Extra unsigned fields on the event (`{ …event, extra: 'x', seen_at: 1 }`) are
ignored, not refused: the gate reads seven fields.

Two **narrowings** are real over-strictness relative to nostr-tools and are now
pinned as decisions rather than accidents:

| signed shape | nostr-tools | this gate | why |
|---|---|---|---|
| `created_at: -1` | **verifies** | refused: *created_at must be a non-negative safe integer* | the request's `signedAtSec` is a non-negative unix second |
| `kind: 1.5` | **verifies** | refused: *kind must be a non-negative safe integer* | the kind is the route's own constant |
| uppercase hex `sig` | **verifies** | refused: *signature must be 64-byte lowercase hex* | canonical encoding — the same decision r9-1 made for ids (validate, never fold) |

### 3.3 `verifyEvent` memoises on the object it is given (BLOCKED, and measured)

`finalizeEvent` writes a `verified: true` **symbol** onto the object it returns,
and object spread copies symbol-keyed properties. So:

```
{ ...honestEvent, sig: 'f'.repeat(128) }   →   verifyEvent(...) === TRUE
```

An event whose signature is one byte-string forged is reported VALID by
nostr-tools because the memoised verdict rode along on the spread. The binder
refuses it — *signature does not verify* — only because it **rebuilds** a
seven-field plain object before verifying (the r10-3 rationale, now a measured
pin). Any future "the object is already verified" shortcut would accept a forged
signature on a real id.

---

## 4. T3 — the clawback barrier (r11-3 attacked)

### 4.1 Every ladder writer, swept (BLOCKED)

The five handlers that persist a ladder-derived number, dispatched at their OWN
phase on a snapshot whose two counters are forged **but equal**:

| writer | phase | writes | outcome |
|---|---|---|---|
| `open_ladder_round` | `ladder_pending` | `ladderRound`, `ladder.round` | refused by the barrier |
| `escalate` | `round_resolved` | `escalationLog[].round` | refused by the barrier |
| `resolve_round` | `ladder_vote_closed` | `outcomeHistory[].round`, clawback rounds | refused by the barrier |
| `flag_clawback` | `fee_settlement` | `clawbackFlags[].round` | refused by the barrier |
| `finalize` | `fee_settlement` | (consumes the round for the verdict) | refused by the barrier |

Each refusal happens **before** any record is written (`clawbackFlags`,
`outcomeHistory` and `escalationLog` are unchanged), and each writer still
succeeds on the honest state — the sweep is a barrier, not a narrowing.

Five transitions that do **not** consume a counter were probed for
independence: `accept_confirmation`, `record_fee`, `concede`, `abort` and `tick`
neither heal a forged counter nor are refused by the barrier (they leave the
forged value exactly as they found it, which is the round-10 "no silent heal"
rule holding for the counter as well).

### 4.2 The ordering: is there a legal interleaving the barrier refuses? (BLOCKED)

A clawback can only be flagged in `fee_settlement`, which is reachable at the
**last** round and after an early **concede**. Both are exercised:

| path | flag accepted | round recorded |
|---|---|---|
| full 3-round ladder (round 3 is final) | yes | 3 |
| round 1 resolved, then `concede` (cap 3) | yes | 1 — the round the ladder is on, not the cap |
| never challenged (no ladder at all) | yes | 0 — the honest "no ladder round" |

and every state the machine actually produced (`challenge_window`,
`ladder_pending`, `round_resolved`, the finished ladder, the conceded case)
satisfies `assertRoundCountersAgree` without throwing. A flag *during* a live
round is refused by the **phase** (`cannot flag clawbacks during
ladder_vote_closed`), not by the barrier — the barrier did not take over a rule
it does not own. **No legal interleaving is refused.**

### 4.3 The domain, stated as the invariant (r12-1's hardening, pinned)

| `ladderRound` | `ladder.round` | verdict |
|---|---|---|
| `0`, `3`, `5` (with a matching ladder) | same | accepted |
| `2.5` / `2.5`, `-1` / `-1`, `"3\n…"` / the same string | same | **refused** — not round numbers |
| `3` with **no ladder** | — | **refused** — a counter with no ledger |
| `0` with no ladder | — | accepted (every case starts here) |

---

## 5. T4 — the r11-5 divergence, decided: CLOSED-BY-DESIGN

### 5.1 The deferred fix is arithmetically impossible

The trigger round 11 wrote was: *"rationalise from the shortest round-trip
decimal of the double, so both spellings produce the same rational."* That
premise cannot hold:

- `String(x)` **is** the shortest decimal that round-trips to `x`
  (ECMA-262 `Number::toString`);
- if two doubles had the same shortest text, parsing that text back would give
  the same double — i.e. they would be the same double;
- therefore two **distinct** doubles always have distinct shortest texts, and
  no lossless reading of the text can map them to one rational.

Measured: `String(0.3) = "0.3"`, `String(3 * 0.1) = "0.30000000000000004"`, the
IEEE-754 bit patterns differ (`3fd3333333333333` vs `3fd3333333333334`), and each
text round-trips to its own double only.

### 5.2 The field IS canonicalised once — the campaign's rule is satisfied

The canonicalisation rule is *once per field*. Here the field is `beta`, and it
is canonicalised exactly once: `String(double)` → one exact rational → one
predicate. Round 11's BLOCKED target is that rule working: `0.03`, `0.030`,
`3e-2`, `0.03e0` and `3/100` are **one double**, so one rational and one cap
(5, flip 7), and `0.3`/`3e-1` likewise. `3 * 0.1` is **not a second spelling**
of that double; it is a different double, i.e. a different input. The
divergence enters *before* the field, in the host's expression. There is nothing
left for the codec to canonicalise, so the rule does not license a change here.

### 5.3 The only available merge is lossy — a parameter domain, not a fix

Rounding to 15 significant digits does merge the pair (`round15(3*0.1) = 0.3`),
and it moves **other** boundaries too. Measured at `a_f = ½` (where the
boundary is an exact integer):

| `beta` | cap before | cap after `round15` |
|---|---|---|
| `0.30000000000000004` | 2 | 1 |
| `0.7000000000000001` | 3 | 2 |
| `0.10000000000000003` | 1 | 0 |

So rounding is a **new parameter domain** (a precision the policy chooses),
which is the policy owner's decision, made once for every parameter in the
module — not a defect fix disguised as one. It would also need a documented
precision, a CHANGELOG entry and a revision of every pinned example.

**Decision: CLOSE-BY-DESIGN.** The code is *right about the value it was given*
— `0.30000000000000004` is a larger bond, so the break-even round really is
strictly unprofitable and cap 2 is the exact answer for that parameter; the gate
agrees with the cap because both read the same rational. The defect is the
**policy expression**, which lives in the host. The obligation is unchanged and
now has a test: **pass the literal decimal** (`beta: 0.3`), not an arithmetic
expression that lands one ulp away. Round 11's pin stays (cap 1 vs cap 2,
`ok: false` vs `ok: true`); the trigger changes shape — it is no longer "the fix
that closes it" but "a parameter-shape change (decimal text or an exact rational
on the wire), which must also revise round 5's `a_f as a string` pin". Nothing
of that kind ships here.

---

## 6. Doctrine — are #128's four fixes genuine pins?

Each of #128's four code fixes reverted in turn in a scratch copy of this
branch; `npx vitest run __tests__/reviewRound11.test.ts` after each.

| mutation | revert | result | tests that went red |
|---|---|---|---|
| M1 | the budget spent on the **escaped output** → on the input (`MAX_ECHO_BODY_CHARS = MAX_ECHO_CHARS * 6`) | **1 red / 20** | *the budget is spent on the ESCAPED output, not on the input* |
| M2 | `quoteWireUnknown` totality → `String(value)` for non-null | **1 red / 20** | *a hostile value OBJECT is described, never stringified* |
| M3 | the shape gate's `tags` rule removed | **1 red / 20** | *a malformed event SHAPE is a typed refusal, not a raw TypeError* |
| M4 | `assertRoundCountersAgree` removed from `flag_clawback` | **3 red / 18** | *every refusal that echoes a wire or snapshot value escapes it*; *the sweep — flag_clawback was the one reader outside the barrier*; *a restored counter cannot forge the barrier's own refusal* |

**4/4 red, each on its own assertion** (M4's first red is the r11-1 sweep
entry for the barrier, which also covers the site). #128's fourth *fix* — the
`ladderEconomics` documentation narrowing — is doc-only and is the **control**:
no test can go red for a doc change, and round 11 said so itself (its r11-5
boundary test passes on both sides by design). The doctrine claim is therefore
honest for the code and explicitly not claimed for the prose.

### 6.1 Why the round-11 pins survived round 12

All 21 round-11 tests pass unchanged on this branch, which is the point: the
round-12 fix *restructured* the escape (a new module, a tighter bound, a total
`quoteWireValue`) and *hardened* the barrier (a domain check) without touching
a single round-11 assertion. A pin written at the behaviour rather than at the
message text is what makes a re-fix possible; a pin written at the text would
have blocked both.

---

## 7. What is still open (named, not hidden)

| # | Residual | Owner | Trigger to revisit |
|---|---|---|---|
| r12-6 | the reducer validates its ledgers but not `state.phase`'s MEMBERSHIP: a restored snapshot with `phase: "final\n…"` is not one of the five phases, yet `abort` accepts it (nothing is written from it, and every refusal now escapes it — measured) | the host's snapshot loader (or this package, when the phase union gets a validator) | a snapshot-schema bump, or the first handler that branches on a phase prefix |
| r12-7 | the static sweep checks **literals**: a refusal whose message is assembled in a variable before the constructor is not scanned | this package | the first refusal built that way — the sweep is extended then, deliberately not now (it would need dataflow) |
| r11-5 | a parameter expressed by ARITHMETIC is the ulp of its decimal (§5) — **CLOSED-BY-DESIGN**: pass the literal decimal | the host's policy config | a parameter-shape change (decimal text / a rational on the wire), which must also revise round 5's `a_f as a string` pin |
| r11-6 | the escape protects *this package's* refusals; a host that interpolates a wire value into its own log loses it | the host's logger | the host adopts `quoteWire*`/a structured logger |
| r9-6 | a host that keeps a private request-event layout may fill the binding from the wire | the escalation route | the host's request-event shape is fixed here → the binder becomes mandatory |
| r9-7 | bond ownership / derivable-witness preemption | host bond verifier | an idx→pubkey registry lands in the case state |
| r9-8 | the state has no case identity; state + binding must come from one lookup | host router | a case id lands in the snapshot |
| r8-4 | an already-parsed object has lost its duplicate keys | host (pass body text) | the host parses with a duplicate-aware parser |
| r33-5 | a legacy (`requireRoundBond: false`) case cannot distinguish a deleted log entry from a pre-0.12 snapshot | host policy | every new deployment sets `requireRoundBond: true` (already the default) |
| — | `docs/REVIEWS_INDEX.md` was last refreshed at #117; rounds 9–12 are unindexed | this package | the next index refresh — deliberately not half-done here |

---

## 8. Files changed

- `courtEcho.ts` — **new**: the one escape implementation
  (`quoteWireValue`/`quoteWireUnknown`/`quoteCounter`), the exact 64-character
  bound (marker included, counted in code units and therefore bounded in code
  points), and a runtime-total `quoteWireValue` (r12-1, r12-2).
- `courtEscalationRequest.ts` — imports the helpers instead of defining them;
  the ten convention-safe sites are quoted (r12-1).
- `confirmationMachineCore.ts` — imports the helpers; the barrier now enforces
  the counters' write domain and the no-ladder `0` rule (r12-1).
- `confirmationMachineHandlers.ts` — 44 refusal interpolations escaped (r12-1).
- `courtConfirmationMachine.ts` — the front door's `event.type` / `unknownType`
  refusals escaped and total (r12-1).
- `__tests__/reviewRound12.test.ts` — **new**, 20 tests (the static sweep, the
  helper probes, the 20 000-shape fuzz, the writer sweep, the r11-5 decision).
- `docs/REVIEW_ROUND_12.md` (this file).

## 9. Numbers

| | before (`e489fe5`) | after |
|---|---|---|
| `reviewRound12.test.ts` | — (new, 20 tests) | 20 passed |
| the same file on the pre-fix sources | — | **9 failed / 11 passed** |
| full suite | 1,953 passed / 1 skipped (90 files) | **1,953 passed / 1 skipped (90 files)** |
| typecheck / tests / scripts | clean | clean |
| unquoted refusal interpolations (static sweep) | **66** | **0** |
| echo characters for a clipped astral value | 65 | **63** |
| echo characters for 64 escaping characters | 65 | **57** |
| fuzzed event shapes → raw throws | (r11 fixed the one known site) | **0 / 20 000** |
| ladder writers behind the barrier | 5 (r11: +1 for `flag_clawback`) | **5 / 5**, plus the domain check |
| #128's fixes with teeth (mutations reverted) | — | **4 / 4** |

## 10. Evidence

### 10.1 The new tests against the pre-fix head

`git archive e489fe5` in a scratch tree, the new test file copied in, and the
helper module given the **round-11 semantics** (so the fetch is fair: only the
round-12 changes are missing):

```
× r12-1: the static sweep — every refusal interpolation is quoted or provably safe
× r12-1: the reducer's front door refuses a hostile event type with a TYPED error
× r12-1: a hostile SNAPSHOT cannot forge a line through a handler refusal
× r12-1: two counters forged to the SAME non-integer are refused, never persisted
× r12-2: the bound is 64 characters, MARKER INCLUDED, in code points and code units
× r12-2: double-quoting is IDEMPOTENT, and the marker is deliberately not injective
× r12-2: quoting is total over untyped values and never runs caller code
× r12-4: every handler that PERSISTS a round is behind the barrier
× r12-4: the barrier enforces the write domain, not just equality
Tests  9 failed | 11 passed (20)
```

The 11 that pass on both sides are the BLOCKED / CLOSED-BY-DESIGN targets (the
fuzz, the legal-shape bindings, the narrowings, the memoisation pin, the lone
surrogate, the ordering sweep, the checker's own teeth test, the r11-5
decision) — a finding that is not a fix must not need one.

### 10.2 Pre-fix measurements (quoted verbatim in §§1.1–1.2, 2.1)

```
static sweep on e489fe5: 66 raw interpolations
  confirmationMachineHandlers.ts 44 · confirmationMachineCore.ts 9
  courtConfirmationMachine.ts 3 · courtEscalationRequest.ts 10
unknown event type (Object.create(null))  -> TypeError: Cannot convert object to primitive value
unknown event type ({toString(){throw}})  -> Error: boom            (caller code ran)
unknown event type ("boom\nESCALATION…")  -> the newline, verbatim
escalate roundIndex (Object.create(null)) -> TypeError: Cannot convert object to primitive value
escalate roundIndex ("1\nESCALATION…")    -> the newline, verbatim
flag_clawback on forged-EQUAL counters    -> ACCEPTED
  clawbackFlags: [{"idx":1,"reason":"late","round":"3\nESCALATION ACCEPTED…"}]
  clawbackFlags: [{"idx":1,"reason":"late","round":2.5}]
resolve_round on forged-EQUAL counters    -> "…cannot resolve round 3\nESCALATION ACCEPTED…"
echo, 40 astral characters: round 11 = 65 characters / 33 code points; now 63 / 32
echo, 64 escaping characters: round 11 = 65; now 57
```

### 10.3 The 20 000-shape fuzz

```
shapes                20000
typed refusals        20000
reached verifyEvent    1955   (kind 39009, bound to its own id, random sig)
binder raw throws         0
verifyEvent throws        0
refusals with a raw Cc/Cf/Zl/Zp/Cs   0
```

### 10.4 A regression this round caught in itself

The first draft of the fix quoted `bond.bondTxid` — a field the type declares
`string` — with `quoteWireValue`, which iterates its argument. On a **restored**
record that drops the column (§ a legacy snapshot) the value is `undefined`, and
the refusal threw `TypeError: value is not iterable` — the exact class this
round exists to close, introduced by the fix. `reviewRound10.test.ts` caught it
(`the witness selects the record; the txid must be THAT record's txid`), the
site now uses `quoteWireUnknown`, and `quoteWireValue` is total at runtime so
the next such site cannot throw. It is recorded rather than quietly fixed
because it is the argument for the static sweep being a *property* test: the
sweep would have flagged the site's expression only if it were unquoted, and the
totality guard is what makes "quoted" sufficient.

### 10.5 Suite stability

The full suite was run twice. The first run, taken while the parallel campaign's
worker pools held the machine, reported timing failures in `appealWatcher` (4),
`independentDkg` (1) and `r33ByzantineRelay` (1) — the pattern
`REVIEW_ROUND_11.md` §9.3 recorded — plus one **real** regression (§10.4). After
the fix, each of the three files was re-run in isolation and passed (25/25), and
the final full run is green (§9).

---

*Round 12's summary in one sentence: round 11 fixed three channels and measured
each fix where it had been attacked; round 12 measured them where the CHANNEL
ends — and the escape, which round 11 called total, was total over two files out
of four, while the barrier that round 11 extended still let a forged value
through whenever the forgery agreed with itself.*
