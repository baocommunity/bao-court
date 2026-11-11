# Mutation testing — the v0.14.0 escalation TRANSPORT (CAMPAIGN 3)

*Round 47. Evidence: `scripts/mutation/pass1-v014.json` (**as found**, base
**v0.14.1 `bc28ff3`**) and `scripts/mutation/pass2-v014-postclosure.json`
(**after closure**, base **v0.15.1 `e489fe5`**). Closures:
`__tests__/mutationClosuresV014.test.ts` (C11–C15). Probe detector:
`scripts/mutation/spot-check.mjs` (S33–S48).*

The two earlier campaigns measured a spec that predates this file:

- **Campaign 1** (`docs/MUTATION_TESTING.md`) — 53 mutants, 18 classes, the
  ceremony surface of v0.11. Seven blind spots found.
- **Campaign 2** (`docs/MUTATION_TESTING_V013.md`) — 25 mutants, 10 new classes,
  the v0.13 surface (per-round bond, strict policy, decay pairing, ladder sign).
  24/25 captured; the survivor was a real guard-pointing-the-wrong-way bug
  (r37-1).

Neither campaign contains a single mutant in `courtEscalationRequest.ts`. The
file did not exist when they ran. It was created in **v0.14.0** to carry the
round-7 finding **H-6** (the escalation body had no round-bond field and the
request hash ignored it), and hardened in **v0.14.1** by the round-8 findings
**r8-1** (lossy `caseId` encoding), **r8-2** (the mapping bound none of the three
wire claims it forwarded), **r8-3** (a signed flag read as truthiness), **r8-4**
(duplicate keys silently resolved last-wins) and **r8-5** (getter double-fetch).

So this round asks one narrow question: **is the escalation TRANSPORT adequately
pinned?** Not "is the protocol right" — the transport is the one place where the
package decides what a challenger's request *is*, and every field in it is a byte
a host will hash, log, route on, and later audit.

This round adds **24 mutants in 12 new classes** for that surface (catalogue
**98 mutants / 40 classes**), runs the same three detectors, and closes what the
pre-round instruments could not see.

### Provenance — main moved three times under this campaign

The round was planned against **v0.14.1** (`bc28ff3`), which is the code the
question is about. While it ran, `main` advanced to v0.14.2 (round 9), v0.15.0
(r52's exact ladder bound + round 10) and **v0.15.1** (round 11, which touched
this very file's escape/diagnostic path). The campaign therefore keeps **two
measurements on two bases**, which is what campaign 2 also did:

| Pass | Base | Instruments | Answers |
|---|---|---|---|
| **1** | v0.14.1 `bc28ff3` | the **pre-round** repository (no C11–C15, probes S01–S32) | what v0.14.1 actually pinned |
| **2** | v0.15.1 `e489fe5` | + C11–C15, + S33–S48 | what the **shipping** head pins |

The rebase was not a formality, and the honest record is that it changed the
campaign's own conclusions — see §5.1. Two things had to be done to the
catalogue: eleven mutants were **re-anchored** (the r9-1 rewrite changed
`normalizeCaseId`, the round-11 fix changed two diagnostic expressions), and
**M67–M70 were retired** (§1.1).

---

## 1. Method

Unchanged from campaigns 1–2 — same runner (`scripts/mutation/run-mutants.mjs`),
same guarantees:

- **Sandboxed.** The tree is copied under `/tmp/bao-court-mutation-<pid>/`; the
  repository is never written to. Tracked `git status` and a sha256 of every
  mutable file must be identical before and after, or the run reports a *runner
  bug* (exit 1). Every pass here certifies `cleanTree.unchanged: true`.
- **Green baseline first** — the pristine sandbox must pass the suite, or every
  capture is noise (pass 1: 1781/1782; pass 2: 1925/1926 — the 1 is the
  env-gated live-Taproot test).
- **Unambiguous by construction** — every `find` occurs exactly once;
  `node scripts/mutation/check-catalogue.mjs` proves the catalogue in ~1 s.
- **Deterministic and crash-safe** — mutants run in id order; each finished
  mutant is appended to `<out>.partial.jsonl`.

### Three detectors

| | Detector | Scope |
|---|---|---|
| **A** | `vitest` battery | the full suite **minus** `__tests__/modelChecking.test.ts` (that work *is* B) and `__tests__/simulateCourt.test.ts` (a wall-clock budget that produced false captures in campaign 1) |
| **B** | model explorer | `scripts/mutation/model-probe.mjs` → the reduced inline instances of the three ceremony machines (`confirmation`, `vote`, `signing`) |
| **C** | invariant probe | `scripts/mutation/spot-check.mjs` → pass 1: **S01–S32**; pass 2: **S01–S48** |

Structural note, stated up front rather than buried in the conclusion:
**Detector B cannot see this surface at all.** The explorer explores a phase
machine's transition relation; the transport is a pure codec — no state, no
transitions, no adapter. Every mutant in this round is `machine: null` because
there is no machine to probe, not because the file was awkward to model. B's
honest denominator is **0**, and its 0 % is a *blast radius*, not a regression:
all three models are green on the pristine tree (confirmation 111,667 states,
vote 2,650 + 5,482, signing 877 + 6,862) and stay green under every mutant —
which is itself the useful negative result (no transport mutant perturbs a
ceremony model).

### 1.1 Catalogue housekeeping (`scripts/mutation/**` only)

- `validateCatalogue` now accepts **three-digit ids** and orders them
  numerically: this round passed M99, and string order would have placed `M100`
  before `M99`.
- **M65 had drifted.** Its `find` named a statement sequence the r40-1 barrier
  had moved, so `check-catalogue` exited **1 for the whole catalogue** — a sweep
  would have aborted on a file it never meant to touch. Its `find` was re-anchored
  to the current source; the mutation (drop the escalate-time ledger barrier) is
  unchanged.
- **M67–M70 retired** (moved to `RETIRED_MUTANTS`). R52 (#125) replaced the
  real-valued `floor(ln(ρ/(ρ+β))/ln a_f)` evaluation, and `ladderSignBoundary`'s
  role as the gate's input, with an exact-integer scan over a predicate mechanised
  in Lean; the four expressions those mutants edited no longer exist in any form.
  They were **not** re-anchored: inventing four new expressions and keeping the
  old ids would report a capture for a mutant whose class description no longer
  describes it. Retirement is not renumbering — the entries and their v0.13
  evidence (`docs/MUTATION_TESTING_V013.md`, `pass1-v013.json`) are unchanged. A
  future ladder campaign adds NEW ids against the exact predicate.
- **SIGTERM leaked the sandbox.** `cleanup()` used a boolean guard, so the signal
  handler started the `rm` and `main()`'s own `cleanup()` returned immediately —
  `process.exit` then killed the in-flight removal. Worse, `child.kill('SIGKILL')`
  killed only the `vitest.mjs` parent; a surviving pool worker re-created files
  inside the tree being removed. `cleanup()` is now a single-flight **promise**
  and children are spawned **detached** so the whole process group is killed, with
  a 250 ms drain before the removal. Verified: `SIGTERM` mid-baseline now leaves
  `/tmp/bao-court-mutation-*` empty (it did not before).

### How to reproduce

```bash
node scripts/mutation/check-catalogue.mjs                  # applicability, ~1 s
node scripts/mutation/run-mutants.mjs --jobs 4 \
  --out scripts/mutation/pass2-v014-postclosure.json \
  --only M79,M80,M81,M82,M83,M84,M85,M86,M87,M88,M89,M90,M91,M92,M93,M94,M95,M96,M97,M98,M99,M100,M101,M102
```

---

## 2. Pass 1 — as found (what v0.14.1 actually pinned)

Artifact: `scripts/mutation/pass1-v014.json`. Tree certified pristine before and
after. Baseline 1781/1782 green in 101 s.

| Metric | Value |
|---|---|
| New mutants | **23** in 12 classes |
| Captured | **19** (recorded) / **18** (after the false-capture correction below) |
| Survived | **4** recorded, **5** corrected |
| Mutation score | **82.6 %** recorded / **78.3 %** corrected |

| Detector | Captured / 23 | Score | Honest denominator |
|---|---|---|---|
| **A** — vitest battery | 19 (18) | **82.6 %** (78.3 %) | 23 |
| **B** — model explorer | 0 | **0 %** | **0** — no modelled machine on this surface |
| **C** — invariant probe (pre-round, S01–S32) | **0** | **0 %** | 23 |
| **Union** | **19 (18)** | **82.6 %** (78.3 %) | 23 |

### Per mutant (pass 1 — the detector column is the pre-round repository's answer)

| ID | Class | Edit (one semantic mutation) | Caught by | Verdict |
|---|---|---|---|---|
| M79 | `caseid-injectivity` | NUL check deleted from `normalizeCaseId` | A (`reviewRound8` T1) | captured |
| M80 | `caseid-injectivity` | 256-byte cap deleted | A (`reviewRound8` T1) | captured |
| M81 | `caseid-injectivity` | **r8-1 as a mutant** — `isCanonicalUtf8Text` guard deleted (an unpaired surrogate becomes U+FFFD) | A (`reviewRound8` T1) | captured |
| M82 | `caseid-injectivity` | the id is folded: validated untrimmed, returned trimmed | — | **survived** |
| M83 | `caseid-injectivity` | `normalize('NFC')` instead of refuse (normalise a wire value) | — | **survived** |
| M84 | `wire-hash-preimage` | `hash` digests the caller's value, not the re-validated one | A* (see §3.2) | **survived** |
| M85 | `wire-hash-preimage` | `'-'` witness sentinel → `''` | A (both wire suites) | captured |
| M86 | `wire-hash-preimage` | domain/body separator `0x00` → `0x2d` (the field sentinel byte) | A (known-answer digest) | captured |
| M87 | `wire-unknown-field-acceptance` | unknown-field loop deleted | A (both wire suites) | captured |
| M88 | `wire-unknown-field-acceptance` | field whitelist runs on the JSON-string path only | A (both wire suites) | captured |
| M89 | `wire-duplicate-key-acceptance` | `assertNoRepeatedWireFields(raw)` not called | A (`reviewRound8` T1) | captured |
| M90 | `wire-duplicate-key-acceptance` | keys compared as RAW text, so `"c\u0061seId"` is a second key | A (`reviewRound8` T1) | captured |
| M91 | `wire-field-coercion` | `parse` does `String(value.caseId)` | — | **survived** |
| M92 | `wire-field-coercion` | `parse` does `Number(value.round)` | — | **survived** |
| M93 | `wire-round-bounds` | the round integer/ceiling check deleted | A (`escalationRequestWire`) | captured |
| M94 | `escalation-identity-binding` | **r8-2 as a mutant** — wire `challengerPubkey` forwarded uncompared | A (`reviewRound8` T2) | captured |
| M95 | `escalation-identity-binding` | `challengerIdx` from the roster head, not the bond owner | A (`escalationRequestWire`, 9 assertions) | captured |
| M96 | `escalation-witness-ambiguity` | one bond hash, two owners resolved to the first instead of refused (r38-1) | A (`reviewRound8` T2) | captured |
| M97 | `escalation-round-binding` | `round === ladderRound` binding deleted | A (`reviewRound8` T2) | captured |
| M98 | `host-clock-authority` | the event's `now` taken from the wire `signedAtSec` | A (both wire suites) | captured |
| M99 | `host-clock-authority` | a bad host clock fails OPEN to the wire clock | A (`reviewRound8` T2) | captured |
| M100 | `build-snapshot-purity` | **r8-5 as a mutant** — `caseId` validated from the snapshot, returned from a second read | A (`reviewRound8` T1) | captured |
| M101 | `signed-flag-type` | **r8-3 as a mutant** — the `concession` boolean check deleted | A (`reviewRound8` T1) | captured |

Per class, pass 1:

| Class | Captured | Score | Survivors |
|---|---|---|---|
| `caseid-injectivity` | 3/5 | 60 % | M82, M83 |
| `wire-hash-preimage` | 3/3 | 100 % | — (M84 in the corrected row) |
| `wire-unknown-field-acceptance` | 2/2 | 100 % | — |
| `wire-duplicate-key-acceptance` | 2/2 | 100 % | — |
| `wire-field-coercion` | **0/2** | **0 %** | M91, M92 |
| `wire-round-bounds` | 1/1 | 100 % | — |
| `escalation-identity-binding` | 2/2 | 100 % | — |
| `escalation-witness-ambiguity` | 1/1 | 100 % | — |
| `escalation-round-binding` | 1/1 | 100 % | — |
| `host-clock-authority` | 2/2 | 100 % | — |
| `build-snapshot-purity` | 1/1 | 100 % | — |
| `signed-flag-type` | 1/1 | 100 % | — |

**What the round-8 findings cost to leave uncaught.** Every fix that round 8
shipped *with its own test* was caught (M81/r8-1, M94/r8-2, M100/r8-5,
M101/r8-3, M89–M90/r8-4, M85–M86/H-6): the review round's pins are real. The
survivors are all in the seams *around* those pins — the values the fixes touched
but the tests only ever exercised with well-formed input.

---

## 3. The survivors, and how each is closed

Five mutants survived the v0.14.1 repository. Four are closed by a pin in
`__tests__/mutationClosuresV014.test.ts`; the fifth became an **equivalence** when
the base moved (§3.4). **Each pin was proven RED** by applying its mutation to a
sandbox copy of the tree and re-running the pin file there (`/tmp/opencode/proofs.sh`;
transcript `/tmp/opencode/proofs.log`, repeated on the rebased base in
`/tmp/opencode/proofs2.log`):

```
base (unmutated)      : Test Files 1 passed (1) · Tests 15 passed (15)
M83 applied           : Test Files 1 failed (1)
M84 applied           : Test Files 1 failed (1)
M91 applied           : Test Files 1 failed (1)
M92 applied           : Test Files 1 failed (1)
M102 applied          : Test Files 1 failed (1)   ← the live member of M82's class
```

(C11 was restated on the branch after round 9 landed: the shipped text pins the
r9-1 *exact-validation* contract — a padded id is refused at `build` and cannot
be hashed — rather than the superseded trim. The red proof above was re-run
against that shipped text, not against the campaign's first wording.)

### 3.1 M82 + M83 (`caseid-injectivity`) → C11, C12 — and round 9

Both are the **r8-1 class re-opened through a different door**. r8-1 was "two
ids, one digest" caused by *lossy encoding*; these are the same harm caused by
*normalisation*:

- **M82** folds the id: it is validated untrimmed and returned trimmed, so
  `build` returns an id the caller never supplied and every consumer that
  compares trimmed (r8-1's own binding did) puts `"court:X"`, `"court:X "` and
  `"court:X\u{3000}"` on one digest.
- **M83** replaces `return value` with `return value.normalize('NFC')`: an NFD id
  and its NFC twin are different wire strings, one digest, and the id the host
  routes on is not the id the client sent.

**Pin.** C11 asserts the r9-1 rule structurally — surrounding whitespace of any
kind is *refused*, an accepted id comes back **byte-for-byte**, field 1 of the
preimage is the id itself (no trim authority anywhere), and the padded twin never
shares the digest. C12 pins the normalisation clause (NFD/NFC/NFKC distinct,
full-width preserved).

> **Convergence, disclosed.** Review round 9 (`v0.14.2`, #119) found the same
> seam independently and *fixed* it: `r9-1` refuses ids that differ from their
> trimmed form and states "no Unicode normalisation, deliberately". So M82's fold
> is **dead code** on the shipping base — the guard above it excludes every id a
> fold could change — and the live member of the class is the guard itself, which
> this round added as **M102** (its removal is caught by C11). The two instruments
> agreeing is worth recording: a hand-written mutant catalogue and a review round
> aimed at the same file landed on the same defect within days. C11/C12 stay in
> the suite as the campaign's own pins; they overlap `reviewRound9.test.ts` on
> purpose (a refactor of that file must not silently drop the property).

### 3.2 M84 (`wire-hash-preimage`) → C13

`hashCourtEscalationRequest` re-validates through `buildCourtEscalationRequest`
before hashing. M84 hashes the caller's object directly, so a hand-built request
— foldable id, wrong-shaped, unpaired surrogate, malformed hex — gets a digest
without the codec ever seeing it. **Pin.** C13 asserts the digest of a hand-built
NUL id / malformed hex / fractional round / unpaired surrogate / foldable id is a
typed refusal.

> **False capture, disclosed.** Pass 1 recorded M84 as *captured by A*, on a
> single failure in `__tests__/r30MultiProcessCeremony.test.ts` ("rejects a
> process replaying its previous round": `expected [3 objects] to deeply equal
> []`). That file spawns child processes and is load-sensitive; the transport is
> not imported by the ceremony. Re-running the detector-A scope on a tree holding
> **only** M84 is **green** (1781 passed, 1 skipped, 0 failed), so the capture is
> environmental. The recorded artifact was **not** doctored — the correction
> lives here, with its reproduction.
>
> This is the fourth instance of the same hazard in this repository (campaign 1:
> `simulateCourt` wall-clock; campaign 2: `r33ByzantineRelay` on its first
> attempt; round 47 pass 1: `r30MultiProcessCeremony`; round 47 pass 2:
> `r33ByzantineRelay` again — §5.2). The mitigation is procedural and recorded so
> the next campaign inherits it: **a capture that rests only on a multi-process
> harness must be re-run with that mutation applied alone before it is counted.**

### 3.3 M91 + M92 (`wire-field-coercion`) → C14, C15

`parse` is a fail-closed decoder. M91 turns `caseId: value.caseId as string` into
`String(value.caseId)` — so `42` becomes the id `"42"`, and, worse, a **missing**
`caseId` becomes the id `"undefined"`: a request with no case id at all parses
into a well-formed request bound to a case that does not exist. M92 turns
`round: value.round as number` into `Number(value.round)` — `"2"`, `true` and
`[2]` all pass the integer check as 2.

**Pins.** C14/C15 assert the shape check, not a coercion: numeric / boolean /
object / `null` / missing `caseId` is a typed refusal, and `"2"`, `" 2 "`,
`true`, `[2]`, `1.5`, `NaN`, `Infinity` are refused as rounds — with the legal
values still parsing (over-strictness controls in both).

### 3.4 M82 on the shipping base → equivalence, not coverage

On **v0.15.x** M82 survives every detector, and that is the correct verdict:
after r9-1 no accepted id contains whitespace, so `return value.trim()` cannot
change the returned value. It is filed as **equivalent** (the M66 pattern from
campaign 2): the mutant is kept because ids are permanent, its `note` in the
catalogue records the equivalence and the base it depends on, and C11 pins the
behaviour that makes it equivalent. Nothing else this round is claimed as
equivalent.

---

## 4. Detector analysis — what the numbers actually say

### 4.1 Detector C went 0 % → 92 %, and that is a statement about the probes

On the pre-round repository **Detector C scored 0/23 — by construction, not by
weakness.** `scripts/mutation/spot-check.mjs` at `bc28ff3` does not import
`courtEscalationRequest.ts` at all (`grep -c courtEscalationRequest` on the
pre-round file: **0**). The overflow probes S01–S32 restate the ceremony, the
batch, the ladder and the decay; none restates a single claim of the transport.
The honest pre-round reading is therefore not "C is weak" but "**C did not
look**".

S33–S48 now restate the transport's own claims as independent black-box
properties — including a full recomputation of the digest
(`sha256(domain ‖ 0x00 ‖ preimage)`, S37), an injectivity corpus over accepted ids
(S34), and both input paths for the wire contract (S38). They import nothing from
`__tests__/`. On the shipping base C catches 22 of the 24 (91.7 %); the two it
misses are M82 (equivalent) and M97 (the round binding, which is a *state*
property — the probe's job, and Detector A catches it).

**The caveat that must travel with this number:** probes written in the same
round as the mutants are not independent evidence of what the repository pinned.
Their 92 % says *the claims are expressible as black-box properties*, and that a
future sweep will notice a regression without running the whole suite. It does
**not** say the repository was already defending them — pass 1's 0 % says the
opposite, and pass 1 is the honest baseline.

### 4.2 Detector A earned its 78 % on the review round's own pins

18 of 23 (corrected). `reviewRound8.test.ts` appears in **16 of the 19** recorded
captures, `escalationRequestWire.test.ts` in **7**. The five survivors sit in the
seams: a value that is *folded* rather than refused, coercions at the parse
boundary, and a re-validation that is only ever called with valid arguments.

### 4.3 Detector B: 0 % of 0

Stated plainly because the raw `0 %` column invites the wrong reading. The
explorer's denominator here is zero — nothing in this file is a transition — and
its models were green before, during and after every mutant. The interesting
result is the *negative* one: **no transport mutant perturbs any ceremony
model**, which is what one wants from a codec that only feeds the reducer.

---

## 5. Pass 2 — after closure, on the shipping head

Artifact: `scripts/mutation/pass2-v014-postclosure.json` — 24 mutants (**M102
added**), base **v0.15.1 `e489fe5`**, with C11–C15 in the battery and S33–S48 in
the probe set. Tree certified pristine. Baseline 1925/1926 green.

| Metric | Pass 1 (v0.14.1, as found) | Pass 2 (v0.15.1, after closure) |
|---|---|---|
| Mutants | 23 | 24 |
| Mutation score | 82.6 % / **78.3 %** corrected | 100 % / **95.8 %** corrected (§5.2) |
| Detector A | 19/23 (18/23) | 24/24 (23/24) |
| Detector C | **0/23** (S01–S32) | **22/24 = 91.7 %** (S01–S48) |
| Detector B | 0/0 | 0/0 |
| Survivors | 5 (corrected) | **1 — M82, equivalent** (§3.4) |
| Clean tree | pristine | pristine |

Per class, pass 2: **12/12 classes at 100 %** — `caseid-injectivity` 6/6,
`wire-hash-preimage` 3/3, `wire-unknown-field-acceptance` 2/2,
`wire-duplicate-key-acceptance` 2/2, `wire-field-coercion` 2/2,
`wire-round-bounds` 1/1, `escalation-identity-binding` 2/2,
`escalation-witness-ambiguity` 1/1, `escalation-round-binding` 1/1,
`host-clock-authority` 2/2, `build-snapshot-purity` 1/1, `signed-flag-type` 1/1.

### 5.1 What the rebase changed, and why the record says so

The campaign was measured on v0.14.1 and rebased twice. Three things changed:

1. **Two survivors were independently fixed** (r9-1 closed the fold and the
   normalisation clause). The campaign's finding is therefore *confirmed by
   another instrument* rather than merely closed by its own pins — and one of its
   survivors (M82) became unreachable, i.e. an equivalence on the new base.
2. **Eleven mutants were re-anchored** to the new source (the `normalizeCaseId`
   rewrite, the r9 label parameter, the round-11 diagnostic expressions
   `quoteWireValue`/`quoteWireUnknown`). Re-anchoring preserves the class, not the
   byte string: each entry's `intent` still describes the harm.
3. **M67–M70 were retired** — r52 replaced the code they edited (§1.1).

An intermediate v0.15.0 run gave the same verdict as the final v0.15.1 run (23/24,
M82 equivalent), so the extra rebase changed no conclusion — the recorded
artifact is nevertheless the one produced on the base that ships these tests.

The branch was then rebased once more, onto **v0.15.2** (round 12, whose only
transport change is the diagnostic quoting: `quoteCounter` / `quoteWireUnknown`
in the refusal messages). The artifact is **left as measured on v0.15.1**: every
one of the 24 mutants still applies unchanged (the mutations do not touch the
message text), all 48 probes pass, and the five transport suites are green on
v0.15.2. Re-anchoring the whole catalogue to v0.15.2 also repaired **seven
pre-existing drifts** from earlier campaigns (`M08, M18, M39, M41, M54, M55,
M59`), which the same round-12 quoting change had broken: `check-catalogue` now
exits 0 for all 98 mutants, where it had been exiting 1 on `main`.

### 5.2 One more false capture, of exactly the predicted kind

The pass-2 artifact records **24/24**, with M82 "captured by tests" on a single
failure in `__tests__/r33ByzantineRelay.test.ts` (the split-view/silence matrix,
`expected [3 objects] to deeply equal []`). M82 cannot affect that harness: with
M82 applied, all five transport-relevant suites pass
(`reviewRound8`, `escalationRequestWire`, `reviewRound9`, `reviewRound10`,
`mutationClosuresV014` — **113/113**), and the same file also failed on the
**pristine** tree in a plain full-suite run during this session under load ~35.
M82 is a survivor (equivalent); the corrected pass-2 score is **95.8 % (23/24)**.

The artifact is committed **undoctored** and the correction is here, with its
reproduction, for the same reason as §3.2: a mutation score that quietly absorbs
its own noise is not evidence.

---

## 6. Honest conclusion

**The escalation transport is now well pinned. Before this round it was
adequately pinned only where round 8 happened to write a test — 78 %, and blind
to five bug classes; two of those classes were independently found and fixed by
round 9 while this campaign was in flight.**

Four qualifications, in order of how much they should worry a reader:

1. **The pre-round 78 % is a statement about the tests, not the protocol.** The
   mutants are hand-written: they encode the bug classes *this reviewer* thought
   of. Four of the five survivors share one shape — a value that is *normalised,
   folded or coerced* instead of *refused* — which looks systematic rather than
   accidental: r8-1 and r8-3 were fixed at the field the review named, while the
   neighbouring fields kept the permissive idiom. That pattern is what round 9
   then attacked.
2. **The post-closure 96 % is not the interesting number.** Detector C went from
   0 % to 92 % because 16 probes were added in this round, written with the
   mutants in view; read pass 1 for what the repository defended, pass 2 for what
   it defends now. A campaign that published only pass 2 would be reporting its
   own instrument as if it were the code's property.
3. **Two recorded captures in this document's evidence are false**, one in each
   pass (M84 in pass 1, M82 in pass 2), both from multi-process harnesses on a
   shared box. The runner cannot tell a load flake from a regression. The remedy
   is procedural and now written down in two places (§3.2, §5.2). This is the
   single weakest part of the numbers here, and it is a property of the box, not
   of the transport.
4. **Detector B's 0 % is a coverage boundary.** A codec has no transition
   relation; the explorer will never see it. If a future round wants a model of
   this surface, the shape is not a phase machine but a property-based
   equivalence between the codec and an independently written reference
   encoder — which now partly exists on the host side (`bao.markets`' Python
   differential, r49) and not in this package.

What the transport's pinning actually **is**, after this round: one known-answer
digest shared with the host, an injectivity property over accepted ids (validate
exactly, normalise never), a fail-closed decoder that refuses rather than coerces
on both input paths, a mapper that refuses every wire claim the host did not
verify, and a host-clock rule with no fail-open. The remaining soft spot is **the
preimage's own byte-level construction**: only M86 (the separator byte) is pinned,
by a known-answer constant rather than by a property — an edit that kept the
digest stable for the KAT while changing the encoding for other inputs would
survive every detector here.
