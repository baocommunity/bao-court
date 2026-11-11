# Mutation testing — the v0.14.0 escalation TRANSPORT (CAMPAIGN 3)

*Round 47. Evidence: `scripts/mutation/pass1-v014.json` (as found, base
**v0.14.1 `bc28ff3`**) and `scripts/mutation/pass2-v014-postclosure.json` (after
closure, same base). Closures: `__tests__/mutationClosuresV014.test.ts`
(C11–C15). Probe detector: `scripts/mutation/spot-check.mjs` (S33–S48).*

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

This round adds **23 mutants in 12 new classes** for that surface (catalogue
**101 mutants / 40 classes**), runs the same three detectors, and closes what the
pre-round instruments could not see.

---

## 1. Method

Unchanged from campaigns 1–2 — same runner (`scripts/mutation/run-mutants.mjs`),
same guarantees:

- **Sandboxed.** The tree is copied under `/tmp/bao-court-mutation-<pid>/`; the
  repository is never written to. Tracked `git status` and a sha256 of every
  mutable file must be identical before and after, or the run reports a *runner
  bug* (exit 1). Both passes certify `cleanTree.unchanged: true`.
- **Green baseline first** — the pristine sandbox must pass the suite, or every
  capture is noise (pass 1: 1781/1782, pass 2: 1796/1797 — the 1 is the
  env-gated live-Taproot test).
- **Unambiguous by construction** — every `find` occurs exactly once;
  `node scripts/mutation/check-catalogue.mjs` proves the whole catalogue in ~1 s.
- **Deterministic and crash-safe** — mutants run in id order; each finished
  mutant is appended to `<out>.partial.jsonl`.

### Two instruments were (re)built this round, and that is the point

A mutation score is only as interesting as the difference between "what the
repository already pinned" and "what this round can now see". So the sweep was
run **twice**, on the same 23 mutants and the same base:

| Pass | Detector A | Detector C | Reads as |
|---|---|---|---|
| **1 — as found** | the pre-round battery (no `mutationClosuresV014.test.ts`) | the pre-round probe set, **S01–S32** — which never imported `courtEscalationRequest.ts` at all | what v0.14.1 actually pinned |
| **2 — after closure** | + C11–C15 | + **S33–S48** | what the repository pins now |

That is not a re-labelling of one run: pass 1 was executed with
`git show origin/main:scripts/mutation/spot-check.mjs` in place and the closure
file moved out of the tree, and pass 2 with both in place.

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

### Catalogue housekeeping (both repairs in `scripts/mutation/**`)

- `validateCatalogue` now accepts **three-digit ids** and orders them
  numerically: this round passed M99, and string order would have placed `M100`
  before `M99`.
- **M65 had drifted.** Its `find` named a statement sequence the r40-1 barrier
  moved (`assertValidEscalationLog(state)` no longer sits immediately before
  `const expectedRound = …` in `confirmationMachineHandlers.ts`), so
  `check-catalogue` exited **1 for the whole catalogue** — a sweep would have
  aborted on a file it never meant to touch. Its `find` was re-anchored to the
  current source; the mutation (drop the escalate-time ledger barrier) is
  unchanged.
- One runner bug found by exercising the signal path: **SIGTERM leaked the
  sandbox.** `cleanup()` used a boolean guard, so the signal handler started the
  `rm` and `main()`'s own `cleanup()` returned immediately — `process.exit`
  then killed the in-flight removal. Worse, `child.kill('SIGKILL')` killed only
  the `vitest.mjs` parent; a surviving pool worker re-created files inside the
  tree being removed. `cleanup()` is now a single-flight **promise** and children
  are spawned **detached** so the whole process group is killed, with a 250 ms
  drain before the removal. Verified: `SIGTERM` mid-baseline now leaves
  `/tmp/bao-court-mutation-*` empty (it did not before).

### How to reproduce

```bash
node scripts/mutation/check-catalogue.mjs                  # applicability, ~1 s
node scripts/mutation/run-mutants.mjs --jobs 4 \
  --out scripts/mutation/pass1-v014.json \
  --only M79,M80,M81,M82,M83,M84,M85,M86,M87,M88,M89,M90,M91,M92,M93,M94,M95,M96,M97,M98,M99,M100,M101
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
| M82 | `caseid-injectivity` | `const trimmed = value.trim()` → `value` (validated untrimmed, hashed trimmed) | — | **survived** |
| M83 | `caseid-injectivity` | `return trimmed` → `return trimmed.normalize('NFC')` (normalise instead of refuse) | — | **survived** |
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
survivors are all in the seams *around* those pins — the fields the fixes touched
but the tests only exercised with well-formed values.

---

## 3. The survivors, and how each is closed

Five mutants survived the pre-round repository. Each is closed by a pin in
`__tests__/mutationClosuresV014.test.ts`, and **each pin was proven RED** by
applying its mutation to a sandbox copy of the tree and re-running the pin file
there (`/tmp/opencode/proofs.sh`; transcript in `/tmp/opencode/proofs.log`):

```
base (unmutated)      : Test Files 1 passed (1) · Tests 15 passed (15)
M82 applied           : Test Files 1 failed (1)
M83 applied           : Test Files 1 failed (1)
M84 applied           : Test Files 1 failed (1)
M91 applied           : Test Files 1 failed (1)
M92 applied           : Test Files 1 failed (1)
```

### 3.1 M82 + M83 (`caseid-injectivity`) → C11, C12

Both are the **r8-1 class re-opened through a different door**. r8-1 was "two
ids, one digest"; these are "two ids, one digest" produced by *normalisation*
instead of by *lossy encoding*:

- **M82** drops `trim()` from `normalizeCaseId`. `build` then returns the
  untrimmed id while `courtEscalationRequestPreimage` still trims — validate A,
  hash B. Two wire strings (`"court:1"`, `" court:1"`) with one digest, and the
  host routes on a key that is not the key the digest covers.
- **M83** replaces `return trimmed` with `return trimmed.normalize('NFC')`: an
  NFD id and its NFC twin are different wire strings, one digest, and the id the
  host reads is not the id the client sent.

**Pins.** C11 asserts the trimming authority is single (build, once) and that a
hand-built untrimmed id hashes as the trimmed one; C12 asserts an accepted id
comes back **byte-for-byte** (NFD stays NFD, full-width stays full-width) and
that the two forms do not share a digest. C12 also pins NFKC folding
(`\uFF21` ≠ `A`), which was never defended by anything.

### 3.2 M84 (`wire-hash-preimage`) → C13

`hashCourtEscalationRequest` re-validates through `buildCourtEscalationRequest`
before hashing. M84 hashes the caller's object directly, so a hand-built request
— untrimmed, wrong-shaped, unpaired-surrogate id, malformed hex — gets a digest
without the codec ever seeing it. **Pins.** C13 asserts the digest of a
hand-built NUL id / malformed hex / fractional round / unpaired surrogate is a
typed refusal, and that the digest of an untrimmed id equals the trimmed one's.

> **False capture, disclosed.** Pass 1 recorded M84 as *captured by A*, on a
> single failure in `__tests__/r30MultiProcessCeremony.test.ts` ("rejects a
> process replaying its previous round": `expected [3 objects] to deeply equal
> []`). That file spawns child processes and is load-sensitive; the transport is
> not imported by the ceremony. Re-running the detector-A scope on a tree holding
> **only** M84 is **green** (1781 passed, 1 skipped, 0 failed), so the capture is
> environmental. M84 is a survivor, and the corrected pass-1 numbers are the
> ones in brackets throughout this document. The recorded artifact was **not**
> doctored — the correction lives here, with its evidence.
>
> This is the third instance of the same runner hazard (campaign 1:
> `simulateCourt` wall-clock; campaign 2: `r33ByzantineRelay` on its first
> attempt; now `r30MultiProcessCeremony`). The mitigation is procedural and
> recorded so the next campaign inherits it: **a capture that rests only on a
> multi-process harness must be re-run with that mutation applied alone before it
> is counted.** No other capture this round rests on one — M95/M96/M97 also fail
> deterministic assertions.

### 3.3 M91 + M92 (`wire-field-coercion`) → C14, C15

`parse` is a fail-closed decoder. M91 turns `caseId: value.caseId as string` into
`String(value.caseId)` — so `42` becomes the id `"42"`, and, worse, a **missing**
`caseId` becomes the id `"undefined"`: a request with no case id at all parses
into a well-formed request bound to a case that does not exist. M92 turns
`round: value.round as number` into `Number(value.round)` — `"2"`, `true` and
`[2]` all pass the integer check as 2.

**Pins.** C14/C15 assert the shape check, not a coercion: numeric / boolean /
object / `null` / missing `caseId` is a typed refusal, and `"2"`, `"1"`, `" 2 "`,
`true`, `[2]`, `1.5`, `NaN`, `Infinity` are refused as rounds — with the legal
values still parsing (over-strictness controls in both).

None of the five is equivalent to the code that shipped: each changes an
observable (a returned id, a digest, an accepted wire form). Nothing is filed
under "equivalent by construction" this round.

---

## 4. Detector analysis — what the numbers actually say

### 4.1 Detector C went 0 % → 100 %, and that is a statement about the probes

On the pre-round repository **Detector C scored 0/23 — by construction, not by
weakness.** `scripts/mutation/spot-check.mjs` at `bc28ff3` does not import
`courtEscalationRequest.ts` at all (`grep -c courtEscalationRequest` on the
pre-round file: **0**). The overflow probes S01–S32 restate the ceremony, the
batch, the ladder and the decay; none of them restates a single claim of the
transport. So the honest pre-round reading is not "C is weak" but "**C did not
look**".

S33–S48 now restate the transport's own claims, each as an independent black-box
property — including a full recomputation of the digest
(`sha256(domain ‖ 0x00 ‖ preimage)`, S37), an injectivity corpus over accepted ids
(S34), and both input paths for the wire contract (S38). They import nothing from
`__tests__/`.

**The caveat that must travel with this number:** probes written in the same
round as the mutants are not independent evidence of what the repository pinned.
Their 100 % says *the claims are expressible as black-box properties*, and that a
future sweep will notice a regression in them without running the suite. It does
**not** say the repository was already defending them — pass 1's 0 % says the
opposite, and pass 1 is the honest baseline.

### 4.2 Detector A earned its 78 % on the review round's own pins

18 of 23 (corrected). The captures are exactly where round 8 wrote tests:
`reviewRound8.test.ts` appears in **16 of the 19** recorded captures,
`escalationRequestWire.test.ts` in **7**. The five survivors sit in the seams: a
value that is *normalised* rather than refused, a coercion at a boundary, and a
re-validation that is only ever called with valid arguments.

### 4.3 Detector B: 0 % of 0

Stated plainly because the raw `0 %` column invites the wrong reading. The
explorer's denominator here is zero — nothing in this file is a transition — and
its models were green before, during and after every mutant. The interesting
result is the *negative* one: **no transport mutant perturbs any ceremony
model**, which is what one wants from a codec that only feeds the reducer.

---

## 5. Pass 2 — after closure

Artifact: `scripts/mutation/pass2-v014-postclosure.json` — the same 23 mutants,
the same base, with C11–C15 in the battery and S33–S48 in the probe set. Run
**twice**: the first pass-2 sweep predates a type-only import correction in the
pin file (the error class now comes from `courtConfirmationMachine`, where it is
exported, instead of from the module under test); the committed artifact is the
re-run against the exact shipping tree.

| Metric | Pass 1 (as found) | Pass 2 (after closure) |
|---|---|---|
| Mutation score | 82.6 % / **78.3 %** corrected | **100 %** |
| Detector A | 19/23 (18/23) | **23/23** |
| Detector C | **0/23** (S01–S32) | **23/23** (S01–S48) |
| Detector B | 0/0 | 0/0 |
| Survivors | 5 (corrected) | **0** |
| Clean tree | pristine | pristine |
| Baseline | 1781/1782 | 1796/1797 |

The 15 closure assertions add 15 to the suite's green count (1782 → 1797) and,
with the corrected pass-1 reading, convert **5 survivors into 5 captures**.

---

## 6. Honest conclusion

**The escalation transport is now well pinned. Before this round it was
adequately pinned only where the round-8 review happened to write a test —
78 %, and blind to five bug classes.**

Four qualifications, in order of how much they should worry a reader:

1. **The pre-round 78 % is a statement about the tests, not the protocol.** The
   mutants are hand-written: they encode the bug classes *this reviewer* thought
   of. Three of the five survivors are the same shape (a value that is
   normalised or coerced instead of refused), which suggests the seam is
   systematic: r8-1 and r8-3 were fixed **at the field the review named**, and
   the neighbouring fields kept the permissive idiom. That is a review-process
   lesson, not a codec defect.
2. **The post-closure 100 % is not the interesting number.** Detector C went
   from 0 % to 100 % because 16 probes were added in this round, written with the
   mutants in view. Read pass 1 for what the repository defended; read pass 2
   for what it defends *now*. A campaign that only published pass 2 would be
   reporting its own instrument as if it were the code's property.
3. **One capture in the committed pass-1 artifact is a false capture** (M84) and
   the correction is in this document, with its reproduction: the mutation alone,
   the detector-A scope, green. The runner cannot tell a load flake from a
   regression, and on a shared box the multi-process harnesses (`r30`, `r33`)
   will keep producing them. The remedy is procedural and now written down.
4. **Detector B's 0 % is a coverage boundary, not a gap.** A codec has no
   transition relation; the explorer will never see it. If a future round wants a
   *model* of this surface (rather than probes), the shape to build is not a
   phase machine but a property-based equivalence between the codec and an
   independently written reference encoder — which does not exist, and which
   S37 only approximates for one instance.

What the transport's pinning actually **is**, after this round: one
known-answer digest shared with the host, an injectivity property over accepted
ids (trim once, normalise never), a fail-closed decoder that refuses rather than
coerces on both input paths, a mapper that refuses every wire claim the host did
not verify, and a host-clock rule with no fail-open. The remaining soft spot is
**the preimage's own byte-level construction**: only M86 (the separator byte) is
pinned, and it is pinned by a known-answer constant, not by a property — a future
edit that keeps the digest stable for the KAT while changing the encoding for
other inputs would survive every detector here.
