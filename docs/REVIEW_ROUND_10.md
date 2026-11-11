# Review Round 10 — attacking the round-9 fixes (v0.14.2)

**Date:** 2026-11-11 · **Base:** `bao-court` `origin/main` @ `0e7772f`
(v0.14.2, #119) · **Branch:** `docs/review-round-10`.

**Scope, as briefed.** Five targets, each the *fix* of round 9 rather than the
code it fixed: (1) the **exact `caseId` validation** (r9-1) — every Unicode
whitespace code point, zero-width and bidi controls, and the **refusal path**
itself (is a refused id ever logged at full length? is the refusal an oracle?);
(2) the **`bondTxid` comparison** (r9-2) — what exactly is compared, can a
different bond with the same hash still slip, can a bond be re-bound to a second
challenge in the same case; (3) **concession/escalation discrimination** (r9-3) —
is the fix kind-bound at the *signature domain*, or a field the caller sets?;
(4) the **ladder field unification** (r9-4) — `ladder.round` vs `ladderRound`,
probed with a hand-built skewed ladder on *every* reader; (5) the **new
byte-differential pin** (r9-5) — does a deliberately lossy encoder fail it, and
does a canonicaliser that changes only the digest domain? Plus the doctrine
check: are the eight closures #118 shipped genuine pins?

**Method.** Unchanged: the codec is called with hostile input, the reducer is
attacked as an API (a hostile host speaks it directly *and* hands back tampered
snapshots), and every documentary claim is re-derived from the code. A finding is
one of:

- **EXPLOITABLE** — a test in this repository shows the harm through the shipped
  interfaces; fixed here;
- **PARTIAL** — the guard exists but is incomplete, or the documented claim is
  stronger than the mechanism;
- **BLOCKED** — the guard holds, with the pin cited;
- **REGISTERED** — the harm is real, no pure function can close it, and the
  residual is pinned as a *visible boundary* with a named owner.

An `r10-n` id is this round's; `rN-n` ids are earlier rounds'. Every finding is
dispositioned as **FIXED**, **CLOSED-BY-DESIGN**, **DEFERRED (with a trigger)** or
**REJECTED (with a reason)** — none is bare "registered".

**What was executed**

| Check | Result |
|---|---|
| `npx vitest run __tests__/reviewRound10.test.ts` (**new**, 24 tests) | **24 passed** |
| the three shipped fixes, each reverted in turn (§10.2) | **2, 1, 2, 1** tests red — every pin has teeth |
| the r9-5 pin run against four mutated canonicalisers (§10.3) | lossy/folding **red**, domain-only/join **green** → r10-5 |
| `reviewRound9.test.ts` on **`bc28ff3`** (its pre-fix head) | **8 failed / 19 passed** — all eight for the claimed reason (§10.1) |
| `npm test` (full suite) | **1,855 passed / 1 skipped (83 files + 1 skipped)** |
| `npm run typecheck` · `typecheck:tests` · `typecheck:scripts` | clean / clean / clean |

**Verdict summary.** **3 EXPLOITABLE, 2 PARTIAL, all fixed here.** (1) The
exact-id guard itself **holds against the whole whitespace class and the
zero-width/bidi class** — but the **refusal path** echoed the offending id
verbatim, and only an id's *ends* are whitespace-checked, so `"court:A\n…"` put
a forged line into the operator's log and a U+202E reversed a rendered one
(**r10-1**). (2) The `bondTxid` binding is exact and one-directional
(**BLOCKED**), one witness cannot be re-bound to a second challenge
(**BLOCKED**), but a *txid* is not a bond identity — one transaction may fund two
bonds — and the payer **loses the challenge itself**, not only the attribution,
when a derivable witness is preempted (r9-7 sharpened; the shipped doc claimed a
defence the code does not have, corrected). (3) `concession` was committed to the
preimage, so the digest is kind-bound **at the field** — and the r9-3 refusal is a
*field* check: the same **signed concession**, re-presented with
`concession: false`, was accepted and hashed as an escalation **nobody signed**,
while the mirror direction (a signed escalation re-labelled a concession) had **no
guard at all** (**r10-3**). (4) r9-4 checked two of the readers; **`finalize`
still accepted the skew** and minted an **earlier** round's verdict over the last
paid panel's decision (**r10-4**). (5) The r9-5 differential **is** strong against
lossy and folding encoders (measured: both fail) and **blind** to a
digest-domain-only change (measured: passes) — the property is pinned elsewhere,
so the gap is a separation of pins, not a hole (**r10-5**, closed by pinning the
whole preimage in one place).

The shape of the round: round 9 closed four *fields* by refusing values. Round 10
found that three of those refusals sat in the **diagnostic** rather than in the
binding — the id in the message, the txid in the record, the flag in the body —
and that the guard policing the ladder was still reading one of two counters at
the one entry where value actually moves. A guard that is only as strong as its
last field is also only as strong as the *last entry that consults it*.

| # | Target | Attack that mattered | Outcome |
|---|---|---|---|
| T1 | exact ids | all 25 whitespace code points, both ends | **BLOCKED** — 25/25 refused; the exact id still maps |
| T1 | exact ids | zero-width / bidi controls inside an id | **intended** — 18/18 accepted, 18 distinct digests (no fold); display residual |
| T1 | exact ids | the REFUSAL path logs the id at full length | **EXPLOITABLE → fixed** (r10-1): a newline inside an id forged a log line; U+202E reversed a rendered one |
| T1 | exact ids | is the refusal an oracle? | **CLOSED-BY-DESIGN** — reasons differ (caller supplied the value); class does not; no digest/state/length leak beyond the documented bound |
| T2 | bondTxid | a foreign txid | **BLOCKED** — exact, one-directional, `undefined` fails closed |
| T2 | bondTxid | a bond re-bound to a second challenge | **BLOCKED** — one witness, one owner *at the challenge level* (r38-1), plus the mapper's ambiguity refusal |
| T2 | bondTxid | one transaction, two bonds | **CLOSED-BY-DESIGN** — the txid is not the bond identity; the *witness* selects the record (pinned; doc claim corrected) |
| T2 | bondTxid | the derivable-witness preemptor | **REGISTERED** (r9-7, sharpened) — the payer loses the challenge, not just the attribution |
| T3 | concession | the preimage binds the flag | **BLOCKED at the field** — last slot `1`/`0`, digests differ |
| T3 | concession | the same signed event, flag flipped | **EXPLOITABLE → fixed** (r10-3): accepted; the logged hash was not the signed request's |
| T3 | concession | the mirror (signed escalation → concession) | **EXPLOITABLE → fixed** (r10-3): there was no guard at all |
| T3 | concession | cross-kind replay / same nonce, both kinds | **fixed** — the kind is inside the id; one id, one claim |
| T4 | ladder counters | the machine's own states | **BLOCKED** — both counters agree at every step, including `ladder_pending` |
| T4 | ladder counters | `finalize` on a skewed snapshot | **EXPLOITABLE → fixed** (r10-4): minted round 2's verdict over round 3's decision |
| T4 | ladder counters | `escalate` / `open_ladder_round` on a skew | **fixed** — refused before a seat is spent (they could only brick) |
| T4 | ladder counters | every other reader | **sweep** — the accepted transitions are exactly the ones that lock no value |
| T5 | the pin | a lossy / case-folding encoder | **BLOCKED** — the differential fails both (measured) |
| T5 | the pin | a digest-domain-only change | **PARTIAL → fixed** (r10-5): the differential passes it; the domain is now re-derived, not read back |

---

## 1. T1 — the exact case id (r9-1 attacked)

### 1.1 The whole whitespace class is refused (BLOCKED)

r9 pinned seven code points. `String.prototype.trim` removes **twenty-five**:
U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
U+205F, U+3000, U+FEFF. The round-10 test asserts the *class property* (`ch.trim()
=== ''`) and then both ends of every member:

```
r10-1 whitespace refused trailing: 25 / 25
```

Every refusal is typed, and the exact id still maps end-to-end for all 25 — the
over-strictness control that keeps a guard from becoming a denial of service.

**The refusal is total.** The harm r9-1 closed is "two spellings, one digest".
The proof that it cannot return by another character is that **one member of
every such pair is refused**, so there is no second accepted spelling to share a
digest with; and `build` returns **exactly** the string it was given for every
accepted id, so the accepted domain is a *subset* of the wire strings (injective
by construction), not their image under a fold. Both halves are pinned.

A leading U+FEFF is still refused one step earlier, by the canonical-UTF-8
round-trip (`TextDecoder` strips a leading BOM) — r9 documented the message
mismatch and it is unchanged here; the test now tolerates it explicitly so the
"why" stays on the record.

### 1.2 Zero-width and bidi controls are accepted — and that is the right direction

`trim` does **not** remove the format class, so U+200B–U+200F (ZWSP, ZWNJ, ZWJ,
LRM, RLM), U+061C (ALM), U+202A–U+202E (embeddings and overrides), U+2066–U+2069
(isolates), U+00AD, U+180E, U+0085 and U+FEFF-inside are **legal inside an id**:

```
r10-1 format chars accepted inside an id: 18 / 18
```

Two ids differing only by one of them are two ids with two preimages and two
digests (pinned, 18 pairs). Folding them would **manufacture** the collision
r9-1 closed, so accepting them is deliberate — the same argument r9 made for
NFC/NFD. The residual is the display/audit confusable (they render identically),
and it stops being an *audit* problem in §1.3.

### 1.3 The refusal path logged the id verbatim (EXPLOITABLE → fixed, r10-1)

**Attack.** Only the **ends** of a case id are whitespace-checked, so an id's
interior may carry a newline. The cross-case refusal interpolated the id into the
message:

```
escalation request names case "<id>" but the host bound it to "<case id>" — …
```

**Repro (measured on v0.14.2, `0e7772f`).**

```
r10-1 message: "escalation request names case \"court:A\nESCALATION ACCEPTED for case court:target:1\" but the host bound it to \"court:market-r50:1\" — a request must not cross cases"
r10-1 bidi echoed raw: true
```

A host that logs the refusal — which is the whole point of a typed refusal —
writes a **forged, well-formed line** into its escalation log or stderr. U+202E
(RIGHT-TO-LEFT OVERRIDE) does the same to a *rendered* line with no newline at
all. Two more sites interpolate wire values: the round value (`round: "1\n…"` is
not a safe integer, and the message quoted it) and the JSON field name (in both
the unknown-field and the repeated-field refusal, reachable straight from the
body text).

**Outcome.** EXPLOITABLE, on the audit channel: the id guard holds, the *report*
of it was an injection. Fixed by refusing to re-interpret anything the wire
supplied:

- `quoteWireValue(value)` escapes every `Cc`, `Cf`, `Zl`, `Zp` and `Cs` code
  point to `\u{…}` and bounds the echo to 64 characters (a 256-byte id can no
  longer double into a 512-byte log entry);
- all four echo sites use it: the cross-case message (both ids — the host's own
  id is the one value there the caller did not supply), the round value, the
  unknown field, the repeated field.

The diagnostic is *kept* — the reason and the bytes are still on the line, they
just cannot **be** a line. Pinned with the raw newline, the bidi override, the
host's id and a 256-byte id (`r10-1: a refused id can no longer forge a log
line`, `… the other three echo sites are escaped too`).

### 1.4 Is the refusal an oracle? (CLOSED-BY-DESIGN)

The brief asks whether the error is "constant-shape, i.e. no oracle
distinguishing bad whitespace from bad length". It is **not** constant-shape, and
that is deliberate:

- the *reasons* differ (whitespace / length / U+0000 / non-canonical / empty) —
  and the caller **supplied the value**, so naming the rule discloses nothing the
  caller did not already know. r9-1's own consumer-impact paragraph sells exactly
  this discoverability ("a host with such an id learns immediately");
- what must not vary *does* not: the error **class** is
  `CourtConfirmationTransitionError` (hosts branch on it, pinned by `instanceof`),
  and no message carries a digest, a state field, or a length beyond the
  documented 256-byte bound (pinned: no `[0-9a-f]{32}` in any refusal);
- the one value in a message that the caller did **not** supply — the host's own
  bound case id — is now escaped and bounded like everything else. It remains
  disclosed (a host debugging a misroute needs it), and that is a routing-key
  disclosure, not a secret: case ids are the host's public handles.

**Disposition: CLOSED-BY-DESIGN**, now with the channel hardened; the trade is
diagnosability against a constant-shape message, and a reviewer can see both
halves pinned.

---

## 2. T2 — the `bondTxid` comparison (r9-2 attacked)

### 2.1 What is compared: the txid, of the record the WITNESS selects (BLOCKED)

`escalationRequestToMachineEvent` filters `state.challenges` by
`bondProofHash`, refuses zero and refuses more than one, and then requires
`request.bondTxid === bond.bondTxid` of that single record. Pinned:

- a foreign txid is refused (`… commit to a bond this case never bound`);
- a restored record with **no** txid (legacy shape) fails **closed** — the
  comparison is against `undefined`, which no hex32 can equal;
- the minted `escalate` event carries **no** `bondTxid` at all, so the request
  hash is the only place the txid lives. That is *why* binding it there mattered.

### 2.2 A bond cannot be re-bound to a second challenge (BLOCKED)

The brief's "one-hash-one-index at the CHALLENGE level". Measured:

| probe | result |
|---|---|
| idx 3 registers idx 2's witness hash | **refused** — `one bond witness buys one challenger's standing` (r38-1) |
| idx 2 registers a *second* bond | **refused** — `participant 2 published a conflicting challenge` |
| a restored ledger binds one hash to two indices | the mapper refuses — `the escalation witness is ambiguous` |
| one owner, two bonds | accepted, and attributed to the same owner (the request names its witness) |

So there is **no ledger shape** in which one paid bond funds two challengers of
the same case, and no shape in which it can be re-presented for a second
challenge. r9-2's fix is complete for what it claims.

### 2.3 But the txid is not a bond IDENTITY (PARTIAL → CLOSED-BY-DESIGN)

```
same witness hash at idx 3 : refused
same TXID, different witness: ACCEPTED  →  [[2,"dddd","eeeeeeee"],[3,"dddd","00000000"]]
```

One bond transaction may fund **two** bonds (two outputs, or a batch payout), so
a uniqueness rule on `txid` would refuse a legitimate second challenger. The
**witness** identifies a bond; the txid is a descriptive field. r9-2 stops a
request from naming a txid the case never bound — it does **not** make the txid
an identifier, and a host that keys bond release on `bondTxid` alone cannot
disambiguate two bonds of one transaction. Pinned (both records, both
escalations attributed correctly by witness) and stated in
`docs/PER_ROUND_BOND.md`.

**Disposition: CLOSED-BY-DESIGN**, with the claim narrowed to what is true.

### 2.4 The preemptor does not just steal attribution — it steals the challenge (REGISTERED, r9-7 sharpened)

**Attack.** `hash(bondTxid)` is derivable the moment the bond is on chain and
uniqueness is first-come-first-served (r38-1). r9-7 registered the *attribution*
harm. The measured consequence is worse:

```
copier (idx 3) registers the payer's derivable witness: ACCEPTED
payer  (idx 2) then registers the same bond        : REFUSED — already bound to participant 3
```

The payer's **own** `accept_challenge` is refused, and `escalate` requires an
accepted challenge *of the caller's index* — so the payer can neither challenge
nor escalate: one paid bond, one stolen challenger role, and the payer's dispute
is heard only at the copier's discretion. Pinned as the concrete harm.

**Disposition: REGISTERED** — owner: the host's bond verifier, which must bind
the witness to the **event author** (r40-3). The machine cannot do it:
`accept_challenge` carries **no pubkey** and the state keeps no idx→pubkey
registry. `docs/PER_ROUND_BOND.md` said *"v0.14's `accept_challenge` pubkey makes
it re-derivable"* — **that field does not exist**; the sentence is corrected in
this PR (the shipped doc claimed a defence the code does not have). Trigger to
revisit: an idx→pubkey registry in the case state (a wire change), at which point
the challenge-accept path can compare the author itself.

---

## 3. T3 — concession vs escalation: the FIELD and the SIGNATURE (r9-3 attacked)

### 3.1 The preimage is kind-bound at the field (BLOCKED for the field)

The flag is the preimage's last slot (`'1'`/`'0'`, NUL-joined), so
`concession: true` and `concession: false` are two digests; and the mapper still
refuses the honest concession body (r9-3's guard). If the request were the signed
artifact, that would be the end of it.

### 3.2 It is not the signed artifact (EXPLOITABLE → fixed, r10-3)

**Attack.** The request's `eventId` is asserted to be hex32 and nothing more. No
function in the package ties it to bytes the challenger signed. `concession`, the
case id, the round and both witnesses are fields the **caller** sets, so the flag
is a field the caller can retype while keeping the signature's id.

**Repro (measured on v0.14.2).** A real event is signed over a CONCESSION
(`kind 39008`, `content` = the canonical request, `concession: true`); the same
id is then presented with `concession: false`:

```
r10-3 flipped concession -> escalate: ACCEPTED, requestHash bc7c1a36adcb5290 | hash of what was signed dd843b7753c8293e | equal false
```

The mapper mints an escalate event (the r9-3 guard sees `false` and passes), the
reducer accepts it and the case climbs a rung — while the append-only log's only
record of the request is a digest of **bytes nobody signed**. The linker between
the two is exactly the host-level verification the package never performed.

**The mirror direction is worse and had no guard at all.** The package offers no
concession transition, so nothing refused a signed **escalation** re-labelled
`concession: true`; and it is the *flag*, not the signature, a host reads to
decide whether the appeal is dropped. r9-3 closed one direction of a two-way
confusion.

**Fix (r10-3).** `escalationRequestBindingFromSignedEvent(request, event,
expectedKind)` derives the binding from the **signed event** and refuses unless:

1. `event.kind === expectedKind` — the kind is one of the seven fields the Nostr
   id commits to, so a request signed for another kind is another claim;
2. `event.id === request.eventId`;
3. `verifyEvent(event)` — id and signature (over a rebuilt plain object, because
   `verifyEvent` memoises its verdict on the object it is handed; same discipline
   as `validator.ts`);
4. `event.pubkey === request.challengerPubkey` — the author is the claimed
   challenger;
5. `event.created_at === request.signedAtSec`;
6. `event.content === courtEscalationRequestSignedContent(request)` — the
   canonical wire form **without `eventId`** (an id cannot be inside its own
   preimage), which is where the **flag**, the case id, the round and both bond
   witnesses live.

Pinned: the flip is refused in **both** directions; the honest pair binds in both
directions; a wrong kind, author, `created_at`, event id, tampered signature or
tampered content are each refused; and the honest path runs end-to-end into the
reducer with the binding **derived** (the pubkey comes out of the signature, so
the r9-6 echoed-binding forgery cannot be spelled).

`courtEscalationRequestSignedContent` ships with the verifier, because transport
must ship before enforcement: a host that invents its own content layout is
outside the binding, and now has no excuse for one.

**Answer to "same nonce for both kinds".** There is no nonce in this wire; the
closest artifact is the event id, and one id cannot authorise two claims — `kind`
is inside the id (pinned: the same request signed under `39008` and `39009` has
two different ids, and the binder refuses the wrong one). The wire itself has no
`kind` field: a body carrying one is an unknown-field refusal, so a caller cannot
smuggle a kind in the request.

**Residual.** The mapper's `binding` parameter is still a trust anchor (r9-6) for
hosts that do **not** use the new binder. The difference is that r9-6 is no longer
*unclosable*: it is now an obligation with a shipped mechanism. **r9-6:
CLOSED-BY-DESIGN** for hosts that publish with `courtEscalationRequestSignedContent`
and pass the event to the binder; **DEFERRED** for any host that keeps a private
event layout (trigger: the host's request-event shape is fixed in this package, at
which point the binder becomes mandatory rather than available).

---

## 4. T4 — the ladder's two round counters (r9-4 attacked)

### 4.1 The machine never produces a skew (BLOCKED)

A three-round ladder walked honestly agrees at every step — `[2,2]` after round 2,
`[3,3]` after round 3, and `[2,2]` in the `ladder_pending` half-step between
`escalate` and `open_ladder_round` (which is what makes a pre-dispatch barrier
safe in principle). `open_ladder_round` writes both; nothing else writes either.

### 4.2 `finalize` accepted a skewed ladder and minted an EARLIER round's verdict (EXPLOITABLE → fixed, r10-4)

**Attack.** r9-4 taught `resolve_round` and the transport mapper to refuse
`ladderRound !== ladder.round`. `finalize` reads `ladder.round` (through
`deriveFinalVerdict`) and sizes the escalation log from `ladderRound` (through
`assertValidEscalationLog`) — and checked neither against the other.

**Repro (measured on v0.14.2).** Honest ladder: rounds 1/2/3 resolve
`NO/YES/NO`, two escalations on the append-only log (round bonds for rounds 2 and
3 consumed, two panels seated). One field is then forged:

```
r10-4 finalize on skewed: ACCEPTED, verdict YES | honest ladder ended NO | log rounds 2,3
```

Every barrier `finalize` runs passes: the log is complete `ladderRound − 1 = 2`
records, consecutive `2,3`, each bound to its challenger's bond and consuming a
distinct round bond; the history is a consecutive `1..2`; the vote ledger agrees
with record 2. The case reaches `final` with **round 2's** outcome while its own
audit trail says round 3 was opened, paid and decided the opposite. A host that
settles on this verdict pays the wrong outcome after the ladder's own log
contradicts it — "a state the machine could not have produced" accepted at the
one entry where value actually moves.

**Fix (r10-4).** The invariant is a named barrier,
`assertRoundCountersAgree(state)`, called by the three entries that **consume**
the escalation log — `finalize`, `escalate`, `open_ladder_round` — and (from r9-4)
by `resolve_round` and the mapper. `escalate`/`open_ladder_round` refuse it before
a seat is spent: a skew there cannot mint a wrong verdict, it *bricks* the case
(escalate writes a record the log can never satisfy; `open_ladder_round` heals the
skew into a jump — `ladder.round` 2 → 4 — the history can never satisfy), which is
the r40-2 value-locked failure the campaign already treats as a harm.

Pinned: the forgery is refused, the snapshot is untouched (purity), the
*consistent* forgery is refused by the r8-6 rule, the honest snapshot still
finalizes **round 3's** `NO`, and the skew cannot be laundered through
`concede → finalize`.

### 4.3 The sweep: which transitions accept a skew

| event | skewed snapshot | locks in |
|---|---|---|
| `tick`, `abort`, `record_fee` | accepted | nothing (clock / terminal / append-only fee id) |
| `concede` | accepted | nothing — and `finalize` refuses it afterwards |
| `close_ladder_round` | accepted | freezes a vote ledger that `resolve_round` re-derives and re-checks |
| `accept_confirmation`, `accept_mass_vote` | refused | (phase) |
| `resolve_round` | **refused** (r9-4) | the outcome |
| `escalate`, `open_ladder_round` | **refused** (r10-4) | a rung + a panel seat |
| `finalize` | **refused** (r10-4) | the verdict |

### 4.4 Why not the reducer-wide barrier — and the residual

The cleanest form (one check before *every* dispatch) was implemented first and
**reverted deliberately**: three existing pins (`reviewRound5.test.ts` ×2,
`adversarialCrossModule.test.ts` ×1) construct skewed snapshots *on purpose* to
test the **other** guards those states exist to exercise, and a pre-dispatch
barrier preempts their messages. Preempting a pin to make a new guard simpler is
how a suite loses teeth, so the check sits on the entries that consume the value
instead — every one of them, enumerated in §4.3, with the sweep as the pin that
keeps the list complete.

**Residual: two fields still exist** (this is a consistency invariant, not a
unification). A future transition that reads `ladder.round` without
`assertRoundCountersAgree` re-opens the shape; the sweep test in §4.3 is the
tripwire, and the real unification (delete `ladder.round`, derive it from
`ladderRound`) is a snapshot/wire change. **Disposition: FIXED for the measured
gap; DEFERRED (trigger: the next field added to `CourtLadderRound`, or a snapshot
schema bump) for the unification.**

---

## 5. T5 — the byte-differential pin (r9-5 attacked)

### 5.1 The measurement

r9-5's pin was run against four mutated **copies** of the canonicaliser (the
source is string-mutated into a temp module, then the pin's own assertions are
executed against it):

| mutant | r9-5 pin | r43 known-answer digest |
|---|---|---|
| M1 lossy — `caseId` truncated to 8 chars in the preimage | **FAILS** (all 5 pair comparisons collide; 2 000 ids → **1** preimage) | differs |
| M2 digest-domain only — `…/v2` → `…/v3` | **PASSES (blind)** | differs |
| M3 separator — join `\u0000` → `\u0001` | **PASSES (blind)** | differs |
| M4 case-folding — `caseId.toLowerCase()` in the preimage | **FAILS** (pair `court:X:1a`/`court:X:1A` collides) | matches |

So r9-5's replacement is a real injectivity pin — it fails a lossy encoder and a
folding one, which is exactly what it claimed — but it is **field-level**: it
cannot see a change that leaves every dangerous *pair* distinct while changing the
digest domain or the field separator.

**Outcome: PARTIAL → fixed (r10-5).** Not a hole in the package (M2/M3 are
caught by the r43 known-answer digest in `escalationRequestWire.test.ts`), but the
claim "the encoding pin is total" was true only across two files and two
different ideas of "total". The round-10 pin closes it in one place:

- **structure**: the preimage is exactly nine NUL-joined segments, segment 0 is
  the id **byte-exact**, the remaining eight are asserted in declared order, and
  an absent round bond is the `'-'` sentinel — which fails M1 (segment 0 is
  truncated), M4 (segment 0 is folded) and M3 (one segment, not nine);
- **domain**: the digest is **re-computed** from the documented literal
  `BAO-Court/Escalation/Request/v2`, the `0x00` separator and the preimage, so a
  domain-only change (M2) fails, and the r43 known answer is pinned beside it;
- **pairs**: the dangerous-pair differential is kept and extended with the classes
  this round probed (format characters, astral text vs U+FFFD, case-folded
  suffixes);
- **the 2 000-id sweep is kept as a smoke test and explicitly demoted** — it
  cannot fail for a reason a `caseId` guard can affect, which is the honest
  reading of r9-5.

**Disposition: FIXED** (three of four mutants are now caught by this pin, the
fourth by the re-derivation inside it).

---

## 6. Doctrine — are #118's eight closures genuine pins?

`__tests__/reviewRound9.test.ts` was copied onto **`bc28ff3` (v0.14.1)**, the
head the round-9 fixes replace:

```
Tests  8 failed | 19 passed (27)
```

All eight fail as **refusals that do not happen** (`expected [Function] to throw`
/ `expected a refusal, got none`) — not as import or collection errors, and the
19 that pass are the BLOCKED targets and the over-strictness controls. The eight:

1. `a trailing/leading whitespace id is refused instead of silently folded`
2. `the binding compares EXACTLY, so a request cannot ride a case id across the whitespace class`
3. `the byte bound is exact at 256 bytes for every UTF-8 width` (the trim branch)
4. `the differential pin: dangerous pairs differ in the PREIMAGE BYTES or are refused`
5. `a foreign bond txid is refused; the challenge record holds the binding`
6. `a signed concession cannot be minted into an escalate event`
7. `a restored snapshot whose two round counters disagree cannot mint an attribution record`
8. `r9-4: the two round counters must agree, or the r8-6 rule is bypassed`

**8/8 genuine.** #118's doctrine claim is honest.

---

## 7. What is still open (named, not hidden)

| # | Residual | Owner | Trigger to revisit |
|---|---|---|---|
| r9-6 | a host that keeps a private request-event layout may fill the binding from the wire (the binder is now available: `escalationRequestBindingFromSignedEvent`) | the escalation route | the host's request-event shape is fixed here → binder becomes mandatory |
| r9-7 | bond ownership / derivable-witness preemption — now measured as a **challenge lockout**, not only mis-attribution | host bond verifier | an idx→pubkey registry lands in the case state |
| r9-8 | the state has no case identity; state + binding must come from one lookup | host router | a case id lands in the snapshot. (Note: with the signed-event binder the *request's* case id is signed, so this residual is about the SNAPSHOT side only.) |
| r8-4 | an already-parsed object has lost its duplicate keys | host (pass body text) | the host parses with a duplicate-aware parser |
| §1.2 | NFC/NFD and the zero-width/bidi class render identically | host display/audit | never — folding would create the collision (the refusal path now escapes them, r10-1) |
| §4.4 | `ladder.round` and `ladderRound` are still two fields; the invariant is per-entry, not structural | this package | the next field added to `CourtLadderRound`, or a snapshot schema bump |
| §5.1 | the round-10 pin re-derives the domain itself; a host that changes its own domain constant is caught only by the r43 cross-suite known answer | host | the host's suite pins the same KAT (it does) |

## 8. Files changed

- `courtEscalationRequest.ts` — `quoteWireValue` escapes every wire value echoed
  into a refusal and bounds the echo (r10-1); `courtEscalationRequestSignedContent`
  + `escalationRequestBindingFromSignedEvent` bind a request to the event that was
  signed — kind, id, signature, author, time, content — so the concession flag is
  inside the signed bytes and the binding is derived rather than echoed (r10-3).
- `confirmationMachineCore.ts` — `assertRoundCountersAgree` (the shared barrier),
  and a note on why it is not inside `assertValidEscalationLog`.
- `confirmationMachineHandlers.ts` — `finalize` (the measured hole), `escalate`
  and `open_ladder_round` call it before any value or seat moves (r10-4);
  `resolve_round`'s r9-4 check now uses the shared barrier.
- `index.ts` — the two new exports.
- `__tests__/reviewRound10.test.ts` — **new**, 24 tests.
- `docs/REVIEW_ROUND_10.md` (this file), `docs/PER_ROUND_BOND.md` (the
  `accept_challenge` pubkey claim corrected; the lockout and the signed-request
  binding recorded).

## 9. Numbers

| | before (v0.14.2) | after |
|---|---|---|
| `reviewRound10.test.ts` | — (new, 24 tests) | 24 passed |
| full suite | 1,831 passed / 1 skipped (82 files + 1 skipped) | **1,855 passed / 1 skipped (83 files + 1 skipped)** |
| typecheck / tests / scripts | clean | clean |
| whitespace code points refused (of 25) | 25 | 25 |
| format characters folded (of 18) | 0 | 0 |
| refusal channels that can carry a raw control char | 4 | **0** |
| signed-concession → escalation paths | 1 (flag flip) | **0** |
| entries that mint a verdict from a skewed ladder | 1 (`finalize`) | **0** |
| mutated canonicalisers the encoding pin catches | 2 of 4 | **4 of 4** |

## 10. Evidence

### 10.1 Doctrine

`npx vitest run __tests__/reviewRound9.test.ts` on `bc28ff3` → **8 failed / 19
passed (27)**; the eight are listed in §6, each failing on its own "expected a
refusal" assertion.

### 10.2 Each shipped fix, reverted in turn (the pins have teeth)

| fix reverted | tests that went red |
|---|---|
| `quoteWireValue` → identity (r10-1) | 2 (`a refused id can no longer forge a log line`; `the other three echo sites are escaped too`) |
| the binder's content comparison removed (r10-3) | 1 (`the signed-event binder refuses the flip in BOTH directions`) |
| `finalize`'s counter check removed (r10-4) | 2 (`finalize accepted a skewed ladder…`; `the skew cannot be laundered through concede → finalize`) |
| `escalate`/`open_ladder_round` checks removed (r10-4) | 1 (`escalate and open_ladder_round refuse a skew before spending a seat`) |

### 10.3 Pre-fix measurements (quoted verbatim in §§1.3, 3.2, 4.2)

Run against `0e7772f` with the shipped code and no test harness:

```
r10-1 whitespace refused trailing: 25 / 25
r10-1 format chars accepted inside an id: 18 / 18
r10-1 message: "… names case \"court:A\nESCALATION ACCEPTED for case court:target:1\" but …"
r10-1 bidi echoed raw: true
r10-3 flipped concession -> escalate: ACCEPTED, requestHash bc7c1a36adcb5290 | hash of what was signed dd843b7753c8293e | equal false
r10-4 finalize on skewed: ACCEPTED, verdict YES | honest ladder ended NO | log rounds 2,3
```

### 10.4 Suite stability

Two clean runs of `npm test` on this branch: **1,855 passed / 1 skipped**. One run
taken while a mutation campaign held eight worker pools on the same machine
reported 15 failures in **timing-sensitive** files (test time 1,010 s against
184 s on a quiet host); both re-runs were green with no source change, so the
failures were contention, not regressions.
