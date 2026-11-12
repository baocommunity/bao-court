# Multi-process ceremony simulation (rounds 30 + 33)

The reviewer's standing objection to the assurance case is: *"nothing ran
distributed."* This harness is the closest we can get without a second box.
It is **not** a distributed deployment, and this page exists to keep us from
claiming it is.

**Status (round 34):** F1–F4 are dispositioned in the cross-repo register
`bao.markets` `docs/operations/REGISTERED_FINDINGS_SWEEP.md` — that table is the
single source of truth for every registered finding in this repository.

```
tsx scripts/court/multi-process-ceremony.mjs --jurors=3               # happy path
tsx scripts/court/multi-process-ceremony.mjs --jurors=7
tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --chaos=kill --kill-phase=sign
tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --chaos=replay

# round 33 — a relay that lies
tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --mode=reorder
tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --mode=drop --drop-p=0.2
tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --mode=fork               # split-view, from DKG
tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --mode=fork --fork-variant=sign
tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --mode=replay
tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --mode=silence
tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --mode=reorder --reorder-style=invert
tsx scripts/court/multi-process-ceremony.mjs --matrix                 # all modes, N=3 and N=5 (~40 s)
```

Part of the CI suite: `__tests__/r30MultiProcessCeremony.test.ts` (happy path,
both kill points, cross-round replay) and `__tests__/r33ByzantineRelay.test.ts`
(the Byzantine-relay matrix, ≈20 s).

## What actually happens

Each juror is a **separate OS process** (`scripts/court/juror-child.ts`),
spawned by the coordinator (`scripts/court/multi-process-ceremony.mjs`) with
`node --import tsx`. Each has:

- its own PID, heap, and secret identity (derived deterministically from the
  ceremony seed so the roster needs no trust handshake);
- its own state directory (`juror-<idx>/published.jsonl`, `outcomes.json`) —
  no shared memory, no shared objects, no in-process calls between jurors;
- its own poll cursor into the relay, and (round 33) its own **view**.

The **relay** is a `node:http` server on loopback TCP. Jurors exchange JSON
envelopes over real sockets and never hand each other objects. The relay — not
the jurors — assigns the total message order (monotonic `seq`). Since round 33
the relay keeps a **per-juror view**: a juror polls with `?as=<idx>` (a real
relay knows which subscriber a connection is) and receives the subset, in the
order, that the current mode dictates. The coordinator refuses to start without
it. Payloads on the wire are **signed Nostr events** re-parsed in the receiving
process by the production parsers (`parseDkgCommitmentEvent`,
`parseEncryptedShareEvent`, `parseFrostCommitEvent`, `parseFrostRevealEvent`)
and gated by `IndependentDkgSession` / `IndependentSigningSession`.

The ceremony is the real one: Pedersen DKG (verify shares, complaint gates,
full-roster key computation) → FROST commit/reveal/aggregate →
`verifyFinalSignature`. The **coordinator verifies independently**, from the
wire only: it re-parses every published DKG commitment, sums the constant
commitments to recompute the group key, and checks the aggregate signature
against it with its own verifier.

## The lying relay (round 33)

One relay, six behaviours, all **deterministic** and **seeded**. Every routing
decision is a pure function of `(seed, mode, seq, juror)` — a hash, not a
sequential PRNG — so the same seed reproduces the same dishonest relay record
for record, no matter how the processes interleave.

| `--mode=` | mechanism | what it is | what it tests |
|---|---|---|---|
| `honest` | every record to every juror, in receive order | baseline | R30's claim still holds with the view machinery in place |
| `reorder` | per-receiver sender **ranking**: each sender's records are held for `rank × window/N` (`--reorder-window-ms`, 90 ms default). Per-sender FIFO is preserved; the interleaving is adversarial. `--reorder-style=invert` instead holds **one** juror's FROST commitments 800 ms so its *reveal* overtakes its own *commit*. | a relay that delivers a different total order to each subscriber | is the protocol order-independent? and what does the reveal gate do when a commit/reveal pair is inverted? |
| `drop` | each (record, juror) pair is discarded with probability `--drop-p` (0.2 default) | message loss between relay and one subscriber | does loss ever produce a divergent or unverifiable outcome, or only a typed abort? |
| `fork` | jurors split into two seeded cohorts (ceil(N/2) / rest); a sender's records are delivered **only inside the sender's cohort**. `--fork-variant=dkg` (default) splits from the start; `--fork-variant=sign` keeps DKG whole so both cohorts hold the SAME group key and splits only the signing phase. | **the split-view / equivocation attack** | can the relay make two jurors sign different things, or two group keys exist? |
| `replay` | a seeded 70 % of records are duplicated and re-delivered late, byte-identical and correctly signed | duplicate + old-message redelivery | is the receive path idempotent, and can a repeat ever yield a second signature? |
| `silence` | every record **from** one juror is withheld from all others (`--victim-idx=` to pin the target, else seeded) | targeted censorship | does it fail closed, and does it name the participant? |

The relay **never forges a signature**. Every lie is a delivery policy over
genuinely signed events: a relay can choose *which* signed objects each juror
sees, in *which order*, and *how often* — nothing else. Content equivocation
(two different commitments from one juror) needs a Byzantine **sender**, which
is `--chaos=replay` (R30) and the transport suites.

## Scenarios and asserted outcomes

### Round 30 — process and sender faults (honest relay)

| `--chaos` | Assertion |
|---|---|
| `none` (N = 3…7) | Every process completes DKG + signing; **one** group key across all processes; **one** identical signature; coordinator recomputes the same group key from published commitments; the aggregate verifies against it; one state dir per juror. |
| `kill --kill-phase=dkg` | Victim SIGKILLed after its commitment reaches the relay. Every survivor fails closed with `DKG_MISSING_PARTICIPANT`, blames the victim, and accepts **no** group key (the attempt is not shrunk to a threshold subset). |
| `kill --kill-phase=sign` | Victim SIGKILLed after its FROST commitment. DKG still completes (survivors agree on the group key), then every survivor fails closed with `SIGN_MISSING_REVEAL`, blames the victim, and emits **no** signature. |
| `replay` | Juror 2 republishes its round-1 signed commitment and shares verbatim into round 2 (the outer envelope is unauthenticated, so re-labelling is allowed). Honest processes detect the equivocation, disqualify juror 2, and fail closed with `DKG_DISQUALIFIED`; the replayer — which never sees its own traffic — diverges locally and still cannot collect reveals. **No signature anywhere.** |

### Round 33 — relay faults (both sizes, seeded)

| `--mode=` | Assertion (N = 3 and N = 5) |
|---|---|
| `honest` | All jurors complete; one message, one key, one signature; the relay delivered every record to every juror; completion shape `ALL_COMPLETED_IDENTICALLY`. |
| `reorder` | Jurors observe **different** delivery orders (asserted from the per-juror trace), and the outcome is unchanged: everyone completes with the identical tuple. Order-independence holds for *interleaving*. |
| `reorder --reorder-style=invert` | A commit/reveal inversion is delivered. At most **one** signature exists; peers that lost a reveal fail closed with `SIGN_MISSING_REVEAL` and blame the sender; completion shape is `PARTIAL` (finding F1). |
| `drop` (p = 0.2) | The relay really dropped records; every juror either completes or fails closed with a classification from `{DKG_MISSING_PARTICIPANT, DKG_DISQUALIFIED, SIGN_MISSING_PARTICIPANT, SIGN_MISSING_REVEAL}`; no juror holds a signature without completing; any completers agree on one key and one signature; never `ALL_COMPLETED_DIVERGENT`. |
| `fork` (dkg) | The relay really served different subsets; **no juror saw a record from the other cohort**; no group key, no signature; everybody fails closed with `DKG_MISSING_PARTICIPANT` and names a missing participant; completion shape `ALL_FAILED_CLOSED`. |
| `fork --fork-variant=sign` | DKG completed before the split (one group key across all jurors), then **no signature anywhere**: `createMyReveal()` refuses while any roster participant's nonce commitment is missing, so a split view starves the reveal gate on *both* sides. Shape `ALL_FAILED_CLOSED`. |
| `replay` | The relay really duplicated (and late-redelivered) records; every juror observed the repeats (`disclosure.duplicatesSeen > 0`) and stayed idempotent; the ceremony completes everywhere with **exactly one** signature. |
| `silence` | No signature anywhere; every other juror fails closed with `DKG_MISSING_PARTICIPANT` and **names the silenced juror**; the silenced juror also fails closed (it never sees its own echo, so it reaches signing with no peer commitments). Shape `ALL_FAILED_CLOSED`. |

### Recorded results (seeds derived as `sha256("r33-matrix|N|<args>")`, deadlines 2.5 s)

| cell | juror 1 | juror 2 | juror 3 | juror 4 | juror 5 | shape |
|---|---|---|---|---|---|---|
| N=3 honest | OK | OK | OK | — | — | all identical |
| N=3 reorder | OK (14 msgs) | OK (14) | OK (15) | — | — | all identical |
| N=3 drop 0.2 | `DKG_MISSING_PARTICIPANT` (blames 3) | `SIGN_MISSING_PARTICIPANT` (blames 1, key held) | `DKG_MISSING_PARTICIPANT` (blames 2) | — | — | all failed closed |
| N=3 fork:dkg | `DKG_MISSING_PARTICIPANT` (blames 3) | `DKG_MISSING_PARTICIPANT` (blames 3) | `DKG_MISSING_PARTICIPANT` (blames 1) | — | — | all failed closed |
| N=3 fork:sign | `SIGN_MISSING_PARTICIPANT` | `SIGN_MISSING_PARTICIPANT` | `SIGN_MISSING_PARTICIPANT` | — | — | all failed closed (one key) |
| N=3 replay | OK, 6 dupes | OK, 8 dupes | OK, 8 dupes | — | — | all identical |
| N=3 silence(j1) | `SIGN_MISSING_PARTICIPANT` (key held) | `DKG_MISSING_PARTICIPANT` (blames 1) | `DKG_MISSING_PARTICIPANT` (blames 1) | — | — | all failed closed |
| N=3 invert(j2's commit) | `SIGN_MISSING_REVEAL` (blames 2) | **OK** (signs) | `SIGN_MISSING_REVEAL` (blames 2) | — | — | `PARTIAL`, one signature |
| N=5 fork:dkg | cohort sizes 3/2 (seeded) | | | | | all failed closed |
| N=5 fork:sign | all `SIGN_MISSING_PARTICIPANT` | | | | | all failed closed (one key) |
| N=5 drop 0.2 | all `DKG_MISSING_PARTICIPANT` | | | | | all failed closed |
| N=5 silence(j5) | 1–4 `DKG_MISSING_PARTICIPANT` (blame 5) | | | | j5 `SIGN_MISSING_PARTICIPANT` | all failed closed |
| N=5 replay / honest / reorder | all OK, one signature (21–24 dupes under replay) | | | | | all identical |

Every cell asserts `NO_EQUIVOCATION`: at most one distinct message, at most one
distinct group key among outputs, and every emitted signature verified by the
coordinator's own verifier against the key it recomputed from the receive log.
`--matrix` runs all 15 cells in ≈40 s and exits non-zero if any cell's
assertions fail.

## The equivocation report — what a split view actually produces

`<run-dir>/relay-views.json` (and `report.json` → `equivocation`) record, per
juror: how many records it received, from which senders, in which `seq` order,
how many were duplicates, plus every outcome (classification, blame, key,
signature, message) and a machine verdict. Under `fork:dkg` at N=3 the trace is
unambiguous:

```
juror 1: saw 6 msgs from [2]      -> DKG_MISSING_PARTICIPANT (blames 3)
juror 2: saw 6 msgs from [1]      -> DKG_MISSING_PARTICIPANT (blames 3)
juror 3: saw 3 msgs from []       -> DKG_MISSING_PARTICIPANT (blames 1)
verdict: NO_EQUIVOCATION (messages 0, keys 0, signatures 0)
```

Juror 3 never received a single peer record; jurors 1 and 2 never saw juror 3.
The relay really did mount a split-view. **No two signatures, no two keys, and
no signature at all** — and this is structural, not luck:

1. **The relay cannot mint content.** Every wire object is a signed Nostr event
   whose payload is re-parsed and re-verified in the receiving process. A relay
   can withhold, reorder and repeat; it cannot alter.
2. **Each object is bound to (roster, index, attempt, dispute).**
   `addCommitment` requires `event.pubkey === jurors[idx].nostrPubkey`, the same
   threshold, a PoK over `vssCommits[0]` in a roster-scoped domain, and — for a
   *second* commitment from the same index — either byte-identical content
   (idempotent) or a **disqualification**. `addEncryptedShare` binds
   `fromIdx → roster pubkey` and `phaseNonce → the commitment already seen`.
3. **The key is a pure function of the full roster's commitments.**
   `canComputeKey()` needs every roster member's commitment *and* decrypted
   share; `computeKey()` throws on any missing member or disqualification. Each
   commitment is uniquely determined by (sender key, attempt), so any two jurors
   that complete DKG hold the identical commitment vector and therefore the
   **same group key**. A split cannot create two keys; it can only stop jurors
   from finishing. That is why `fork:dkg` yields `DKG_MISSING_PARTICIPANT`
   everywhere and *no* key, rather than two keys.
4. **The signed message is derived locally.** `buildAttestationMessage(marketId,
   outcome, round, disputeEventId, verdictHash)` — no relay-supplied field
   participates. Every juror recomputes it; there is no channel through which a
   relay could ask for message B.
5. **The reveal gate is roster-wide and all-or-nothing.**
   `createMyReveal()` throws unless `hasEnoughCommitments()` (every roster
   participant's nonce commitment present), and `canAggregate()` requires the
   reveal set to **equal** the commitment set with `|reveals| ≥ threshold`. A
   split therefore suppresses reveals on both sides: it cannot produce a
   signature from each half. (`fork:sign` is exactly this: one agreed key, no
   signature, `SIGN_MISSING_PARTICIPANT` everywhere.)
6. **Repeats are inert.** An identical re-delivery of a commitment or share is
   accepted as a no-op; a *conflicting* reveal is rejected (first reveal wins);
   the default nonce guard refuses a second partial signature for one nonce.
   `replay` produces 6–24 duplicate deliveries per juror and still exactly one
   signature.

**Verdict: NO_EQUIVOCATION — the split-view attack cannot yield two signatures
over different messages, and cannot yield one either.** The defense is not a
relay trust assumption; it is the (dispute, attempt, roster-index) binding plus
the full-roster DKG and reveal gates. The single security-relevant residual is
therefore *not* relay equivocation but **Byzantine senders** — a juror that
signs two different commitments under the same `(disputeId, phaseNonce)`. That
is detected and disqualified by the same gates (R30 `--chaos=replay`,
`__tests__/courtRelayAdversary.test.ts`, `courtInbox`/`courtOutbox` suite).

### Replay is not equivocation — the collapse must happen FIRST

A re-delivered record and an equivocation look identical to a sloppy comparator
and are opposites in fact:

| | replay | equivocation |
|---|---|---|
| who can do it | the **relay** (a delivery policy) | only a **signer** holding the key |
| wire objects | ONE signed event, delivered twice | TWO signed events, different ids |
| identity | same event id (Nostr ids are `sha256` over the serialised event, so same id ⇒ same bytes ⇒ same signature) | two distinct ids, both validly signed |
| correct verdict | idempotent no-op | disqualify and blame that juror |
| if misread | **false accusation against an honest juror** | a Byzantine juror escapes |

**Where the collapse happens.** `collapseSignedRecords` in
`courtCeremonyCore.ts` — the module that exists to hold ceremony invariants once
— and nowhere else. Identity is the record's own signed event id (payload hash
as the fallback for a record that carries no event), **never its arrival
position**; the attribution key is `(phase, round, jurorIdx)`, so the same signer
in another round is a different claim, not a second one. `scripts/court/distributed-ceremony.mjs`
owns the comparison for the relay log and only *calls* it: first occurrence per
key wins, an identical identity counts as a collapsed duplicate, and a
**different** identity for the same key is the sole trigger for blame. The
session classes already compared by value (`IndependentDkgSession.addCommitment`,
`IndependentSigningSession.addCommitment/addReveal`,
`courtSigningMachine`'s commitment guard); this closes the one place that did
not.

**The defect this replaced** (v0.15.3, reproduced on untouched `origin/main`,
`--scenario=replay`, n=3 k=2): the coordinator compared the parsed
proof-of-knowledge object by **reference** —
`existing.parsed.pok === parsed.pok` — which is false for two parses of the same
event, so the collapse branch could never fire. Every duplicate became an
equivocation: `equivocatingJurors:[2]`, `duplicatesIgnored:0`, the group key could
not be re-derived from the log, and three assertions failed (the re-derivation,
the signature verification, and "exactly one DISTINCT commitment per juror").
A re-delivered commitment was blamed on an honest juror — a false accusation in
the one subsystem whose whole purpose is to blame correctly.

**Pinned by** `__tests__/replayEquivocation.test.ts` against the captured trace
of that failing run (`__fixtures__/replay-wire-n3-k2.json`, 22 relay records
including the injected copy of seq 2 as seq 3):

- `(a)` the captured replay trace → `equivocations: []`, `duplicates: 1`,
  three distinct commitments, zero unparsed — **zero false accusations**;
- `(a2)` the root cause isolated: two parses of one event are never `===` but are
  `toEqual` — the old predicate, and the value identity the collapse uses;
- `(a3)` order independence: any arrival order, same verdict;
- `(b)` a **genuine** equivocation (two different commitments, same juror 2,
  round 1, `dkg-commit`) → still detected, blamed on juror 2 and no one else;
- `(b2)` replay *alongside* a real equivocation → the duplicate collapses, the
  equivocation is still blamed (the fix cannot have neutered the check);
- `(b3)` the same juror in a different round → not equivocation.

At run time the harness asserts the same invariant on every replay run: *"the
coordinator collapsed EVERY re-delivered commitment as the same signed event
(replay is not equivocation)"* — the collapsed count must equal the number of
records the relay marked `injected`, and the equivocation list must be empty.

### Normative completion semantics (A / N / P)

These are the three properties the harness asserts and the deployment may rely
on. They are stated here as the reference; R34 made them explicit because F1–F4
below were previously only prose in this file. Disposition of every row in this
section: `bao.markets` `docs/operations/REGISTERED_FINDINGS_SWEEP.md` (round 34).

| property | statement | what it does **not** say |
|---|---|---|
| **A — arrival-order insensitivity (safety)** | For any per-receiver delivery order, every juror that completes holds the *same* group key and the *same* message; at most one distinct signature exists. Interleaving order cannot change *what* is signed. | It does **not** make completion order-independent: a commit/reveal inversion (F1) can leave one juror able to aggregate where its peers cannot. |
| **N — all-or-nothing (liveness)** | The attempt either completes for every participant that received the full roster traffic, or fails closed with a typed classification; there is no threshold-sized degraded ceremony. | It does **not** promise liveness under one dead, silenced or eclipsed juror (F3): the attempt dies and a new one is needed. |
| **P — `PARTIAL` is legal (availability asymmetry)** | `PARTIAL` means *some* juror(s) aggregated one identical message/signature and the rest failed closed; it is a legal completion shape and can never become `ALL_COMPLETED_DIVERGENT`. | It does **not** mean the signature is weaker, nor that the failed peers agreed to anything: the signature is the same object, held by fewer parties (F4). |

**Evidence in the suite:** `__tests__/r33ByzantineRelay.test.ts` asserts A on
every cell (`NO_EQUIVOCATION`), N on `fork`/`silence`/`drop`
(`ALL_FAILED_CLOSED`), and P on `reorder --reorder-style=invert` (one signature,
`PARTIAL`); `__tests__/r30MultiProcessCeremony.test.ts` asserts the same on the
process-kill paths. The host-side deployment notes mirror this table in
`bao.markets` `docs/operations/COURT_MULTIHOST_CEREMONY.md` §0.1.

### Findings (registered, with severity)

- **F1 — the reveal gate is arrival-order sensitive (availability, not
  safety).** `addReveal` drops a reveal whose commitment is not yet stored, and
  the protocol never retries. A relay that holds one sender's FROST commitment
  past its own reveal (`--reorder-style=invert`) makes that sender's partial
  signature unusable at its peers: peers abort with `SIGN_MISSING_REVEAL` while
  the sender itself — which holds its own nonce locally — aggregates and signs.
  One message, one key, one signature: **no equivocation** (property A holds),
  but the ceremony's *completion* is now view-dependent (property P applies).
  The refusal is final for that attempt: the dropped reveal is not buffered.
  Candidate fixes (not implemented here): buffer unmatched reveals and re-apply
  them when the commitment lands, or make the reveal self-contained (carry the
  commitment it belongs to). **Trigger to implement:** any deployment whose
  relays can reorder across senders (i.e. any real WAN relay, not loopback).
- **F2 — "blame" is *whom I did not hear from*, not *who misbehaved*.** The
  field is `blamedIdx` in the harness (and `blame` in the prose of earlier
  rounds). Under `silence`, peers name the silenced juror; under `invert` and
  `drop` they name an **honest** sender whose message the relay discarded. It is
  diagnostic evidence for a fail-closed decision — **never slashing evidence**.
  Slashing needs the signed evidence paths (`DkgVerificationFailure`,
  `falseComplaints`), not this classification; a host that treats `blamedIdx`
  as proof of misconduct would punish a relay's victim. The harness now states
  this in the field's JSDoc, in the report JSON (`blameSemantics`) and in its
  console line ("did not hear from … — diagnostic, not slashing evidence").
- **F3 — all-or-nothing liveness (property N).** `fork`, `silence` and `drop`
  never degrade to a threshold-sized ceremony: the attempt dies and needs a new
  one. That is the protocol as shipped (DKG and the reveal gate both require
  the full certified roster); no Byzantine *liveness* is provided. Consequence
  for operators: a single absent juror costs a fresh attempt, not a smaller
  quorum — plan the deadline and re-summons budget for it, never "wait for the
  threshold".
- **F4 — `PARTIAL` completion is legal and benign (property P).** Message loss
  can leave one juror able to aggregate while others cannot (N=3 `drop`,
  `invert`). Because the message and key are identical, this is an availability
  asymmetry, not a divergence; the harness asserts it can never become
  `ALL_COMPLETED_DIVERGENT`. A host must publish the single signature it
  received rather than re-running the ceremony for cosmetic uniformity, and must
  not read a peer's `SIGN_MISSING_REVEAL` as that peer's dissent.

## What this proves

- The ceremony **completes** across independent processes that share nothing
  but a relay, an ordering, and signed events — including when the relay
  reorders arbitrarily or duplicates/late-redelivers a large fraction of the
  traffic.
- The protocol **fails closed** on process death, targeted censorship, message
  loss, and split-view, with the **correct classification** and a named
  participant, and never emits a partial signature or a subset-derived group
  key.
- **The split-view attack does not equivocate.** Under a real per-juror view
  split (asserted from the per-juror trace), the ceremony either completes with
  one identical session/message/key/signature or fails closed everywhere; there
  is no third outcome where two jurors hold different valid signatures.
- Replayed wire bytes and duplicate deliveries are rejected or absorbed
  idempotently, and the rejection is attributable.
- Verification is independent: the coordinator re-derives the group key from the
  transcript, so a coordinating bug cannot certify itself.

## What this does not prove

- **It is still localhost.** One kernel, one clock, one machine. No packet
  loss at the socket layer, no partitions, no clock skew, no congestion, no
  scheduler failure, no disk failure. The loss/reorder/duplication above are
  *simulated at the relay's delivery policy*, not at the kernel.
- **The "Byzantine relay" is a code path in the coordinator's own process.**
  It is a second *view*, not a second *operator*: no TLS, no DNS, no hostile
  relay binary, no rate limits, no adversarial subscription auth. A real relay
  can also lie about *arrival time* and *subscription state*, which this model
  does not exercise.
- **No real network asynchrony.** Deadlines are 2.5–10 s on loopback; a WAN
  deployment has reordering windows and tail latencies this harness cannot
  produce, and those are exactly the conditions F1 depends on.
- **No Byzantine liveness.** One dead, silenced or eclipsed juror aborts the
  attempt (F3). Reaching a threshold signature while a minority is offline would
  require relaxing the full-roster DKG/reveal gates — a protocol change, not a
  harness change.
- **Custody is not simulated.** Shares live in process memory for the run;
  nothing here exercises HSMs, disk encryption, or backup/restore.
- **Sender equivocation is out of scope here** (covered by R30 `--chaos=replay`
  and the transport suites); the relay itself cannot forge, so this harness
  cannot test a relay that also steals a share.

The remaining gap to a real deployment is therefore *operational plus
liveness*: real network asynchrony, independent relay operators, key custody,
machine-independent timing, and a protocol that can finish with a Byzantine
minority. The **coordination structure** — separate processes, separate
identities, signed messages, third-party ordering and per-subscriber views,
independent verification, crash, replay, split-view, censorship and loss — is
real.

---

## The continuous program (distributed soak)

One distributed ceremony is evidence; a series of them is a programme. The
three-box run (`docs/DISTRIBUTED_CEREMONY.md`) is executed unattended every six
hours by `scripts/court/distributed-ceremony-soak.mjs`, on a systemd timer, for
as long as the operator wants — the ceremony half of the ~100-hour test program
whose rail half is the settlement soak.

### What runs, and in what order

Rotation (one scenario per invocation, persisted in `state.json`):

| # | scenario | what it exercises | expected |
|---|---|---|---|
| 1 | `happy-k2` | 3 boxes, threshold 2: DKG → commit → reveal → aggregate | one key, one **verified** signature |
| 2 | `happy-kn` | 3 boxes, threshold 3 (all-of-N) | one key, one **verified** signature |
| 3 | `kill` | SIGKILL a juror over ssh after its `frost-commit` reaches the relay | **no** signature, survivors `SIGN_MISSING_REVEAL` |
| 4 | `replay` | relay duplicates a deterministic stride of records and re-delivers them late | one key, one **verified** signature, duplicates deduped |
| 5 | `reorder` | relay releases each sender's records after a seeded rank × 90 ms (per-sender FIFO kept) | one key, one **verified** signature, different delivery orders |
| 6 | `silence` (opt-in `--with-silence`) | relay withholds one juror's records from the others | **no** signature, typed missing-peer abort |

The relay may lie about **delivery** and never about **content**: every message
on the wire is a signed Nostr event, so a duplicated or delayed record is
byte-identical, and a censored one is simply absent. `replay` and `reorder` are
therefore real idempotency/order tests over a real network, not injections.

### One JSONL record per run

`~/.local/state/bao-court-ceremony-soak/records.jsonl`, append-only:

```jsonc
{"ts":"…","scenario":"happy-k2","k":2,"n":3,"outcome":"pass",
 "groupKeyFingerprint":"sha256(ffee8d18eb7c6ba5…)[0:16]=e87dbce455e2a36e",
 "signatureVerified":true,"durationMs":16179,"perBoxWallMs":[1343,1335,1460],
 "relayRttP50":3.05,"classification":"OK",
 "evidencePath":"runs/…/dist-…-summary.json", "relayMode":"honest",
 "relayRecords":18,"gap":null,"cleanup":{"straysBefore":[…],"after":[…],"prunedRuns":0}}
```

`outcome` is `pass`, `fail`, `timeout`, `blocked` (a box was down or had no
Node — recorded with the reason, never a hang) or `gap` (a reboot or a long
elapse: the programme was not observing, which is not a failure). **No key,
share, seed, nonce or token is ever written**: the fingerprint is a hash prefix
of the *public* group key.

### Cadence, timer, control

`scripts/court/ceremony-soakctl.sh` (user units — no root):

```bash
./scripts/court/ceremony-soakctl.sh install     # enable the 6-hourly timer for THIS checkout
./scripts/court/ceremony-soakctl.sh status      # timer state + the status block
./scripts/court/ceremony-soakctl.sh report --last=20
./scripts/court/ceremony-soakctl.sh pause|start|stop|run-now|logs|preflight|next
```

Timer (`scripts/court/systemd/bao-court-ceremony-soak.timer`): `OnBootSec=15min`,
`OnUnitActiveSec=6h`, `Persistent=true` (one missed slot is replayed after
downtime), `RandomizedDelaySec=5min`, `AccuracySec=1min`. Service:
`flock -n` on a lock file (a stuck run never overlaps the next tick),
`timeout --kill-after=60s 600s` outside the runner's own 300 s budget,
`SuccessExitStatus=0 1 2` so a failed or blocked ceremony stays *data* rather
than a permanently failed unit.

Boot-gap accounting: the runner compares `/proc/sys/kernel/random/boot_id` with
the last stored value and also rejects an elapse > 2.5 × cadence, writing a
`gap` record with the reason before it runs anything. A reboot is a gap in the
series, not a failure — and the series says so out loud.

Rolling artifact cap: the last `--keep-runs=120` evidence directories (≈30 days
at the 6-hour cadence) are kept; older ones are pruned after each run.
`records.jsonl` itself is append-only and tiny (~700 B/run).

### Status block

`status` prints, per scenario, runs/pass/fail/blocked; the verified-signature
rate for honest scenarios (**must be 100%**) and the signed rate for fault
scenarios (**must be 0%**); the classification histogram; the last failure; the
next run; and the standing note that this is four boxes owned by one operator on
one network path — a continuous transport/DKG/signing programme, **not** a
Byzantine network.

### What the series proves that a single run cannot

- that the ceremony **keeps** working across reboots, OS/Node updates, code
  changes and months of scheduler and network variance, rather than having
  worked once;
- that fail-closed behaviour is **stable**, not a lucky abort: every `kill` and
  `silence` in the series must produce zero signatures, and the histogram shows
  which classifications actually occur;
- that the honest path's signature verification rate is 100% over time, which is
  the only meaningful way to catch a rare timing-dependent defect (exactly the
  class the three-box run found in its first hour: a faster peer's FROST
  commitment being discarded);
- that the operator's environment (the four boxes) stays capable — a box losing
  Node or becoming unreachable shows up as `blocked` with a reason, before it
  silently shrinks the topology.

### What it still does not prove

- **No adversarial network.** The relay's lies are delivery policies; there is
  no packet loss, partition, eclipse, clock-skew attack or traffic analysis, and
  all four machines have one owner. A Byzantine *juror* is out of scope (that is
  the R30 replay suite plus the protocol's own gates).
- **No real stake** (in the soak's default configuration). The rotation runs with
  the bond gate INERT, so every roster bond reference is `rail:"none"`, nothing
  is at risk and nothing can be slashed. The gate can be armed per invocation —
  see [The bond gate](#the-bond-gate--a-seat-costs-a-proven-bond-round-53) —
  but the soak timer does not set it, and a bond still proves collateral at
  verification time, not future honesty.
- **Custody is on disk.** Keys are 0600 files generated on each box, not HSMs or
  threshold devices.
- **Uptime is not the metric.** `gap` records are expected across reboots; the
  series measures the ceremony when it runs, not the hosts' availability.
- **One geography, one operator, three jurors.** Threshold 2-of-3 and 3-of-3
  across three boxes is a liveness/correctness demonstration, not a
  decentralisation claim.

---

## The bond gate — a seat costs a proven bond (round 53)

Until this round the roster carried a bond **reference** and verified nothing:
`CourtBondRef {rail, network, proofRef}` was parsed, echoed on the wire and
recorded with `bondVerified:false`. A well-formed reference for a bond nobody
ever paid was a free seat.

The gate closes that **in the ceremony**, without teaching this repository any
chain dependency. The proof is the HOST's (bao.markets `CourtBondVerifier`, live
for public Liquid testnet and Bitcoin testnet4 since bao.markets #2464); the
ceremony decides only what a verdict **means**.

### The contract

```
BAO_COURT_BOND_CHECK_CMD=<command line>   # unset ⇒ no enforcement at all
```

The harness runs the command **once per juror, on the coordinator**, appending
exactly (fixed order, values validated so they can only be inert tokens):

```
<cmd> --rail=<liquid|onchain|lightning|cashu|none> \
      --network=<testnet|signet-public|private-signet> \
      --proof=<proofRef> \
      --bond-sats=<n> \
      --juror-pubkey=<64-hex x-only>
```

Anything the command needs beyond that is embedded in the command line itself —
which is where policy lives (`--allow-own-script`, `--bond-script=`,
`--court-pubkey=`, `--bitcoind-ssh=`). The harness passes no other flag.

Exit **0** with ONE JSON object on stdout means proven:

```json
{"ok":true,"proofRef":"<the same proofRef>","sources":["blockstream","liquid-network"]}
```

Any other exit is a refusal:

```json
{"ok":false,"code":"BOND_SPENT","detail":"the outpoint is not an unspent Liquid output (…)"}
```

Strictness is deliberate, because every leniency here is a free seat:

| observation | verdict |
|---|---|
| exit 0 + `ok:true` + `proofRef` equal to the roster's + non-empty `sources` | **proven** |
| exit non-zero, typed body | `BOND_CHECK_REFUSED` with the command's own code (e.g. `BOND_SPENT`) |
| exit 0 but body says `ok:false` | refusal (the same code path) |
| exit non-zero but body says `ok:true` | `BOND_CHECK_FAILED` — a contradiction is never a pass |
| no output, a log line, a JSON array, `{"ok":"yes"}`, `ok:true` without `proofRef`/`sources` | `BOND_CHECK_MALFORMED` |
| no answer inside `--bond-check-timeout-ms` (default 60 s) | `BOND_CHECK_TIMEOUT` |
| the command proves a **different** `proofRef` than the roster claims | `BOND_PROOF_MISMATCH` |
| a juror whose check never ran (no verdict) | `BOND_CHECK_FAILED` |
| `rail:"none"` under `--require-bonds` | `BOND_NOT_CLAIMED` |

The parser and the roster decision are the protocol's: `bondCheckGate.ts`
(`buildBondCheckArgs`, `parseBondCheckOutput`, `gateRosterOnBonds`), exported
from the package root and covered by `__tests__/bondCheckGate.test.ts`. The
harness only spawns the process.

### The enforcement point

For each run of `scripts/court/distributed-ceremony.mjs`:

1. every box generates its own key and publishes its **x-only pubkey**
   (`--identity-only`) — the check needs the seated key;
2. **the gate runs here** — after the keys, **before** `roster.json` is written
   and before **any** juror process starts, so an excluded juror never takes part
   in a DKG at all;
3. the survivors are **re-seated** at sequential indices 1..m. Each keeps the key
   it generated on its own box (the identity file is copied to the new position),
   so the proof taken in step 2 still covers the key that actually sits;
4. if the survivors cannot reach `--threshold`, the ceremony **fails closed**
   before the roster exists: `ROSTER_BELOW_THRESHOLD`, no key, no signature, no
   roster written, no juror launched.

`--require-bonds` with no command configured is refused at startup (a strict run
with nothing to check with is a misconfiguration, not "no enforcement").

`--expect-classification=ROSTER_BELOW_THRESHOLD` turns that refusal into a PASS
for a negative run (otherwise a below-threshold roster is a driver failure, so a
regression can never hide as "expected").

Per-juror bonds come from `--bonds=<rail>:<network>:<proofRef>,…` (box order) or
`--bonds-file=<json>`; without either, one shared `--bond-rail/--bond-network/--
bond-proof-ref` applies to every juror (today: `none`).

### The artifacts

Each run JSON (and the summary) now carries, per seated juror and per excluded
juror:

```jsonc
"identities": [
  {"seat":1, "idx":1, "box":"vps16gb", "pubkey":"4775…",
   "bond":{"rail":"liquid","network":"testnet","proofRef":"0f11…:0"},
   "bondRef":"liquid/testnet:0f11…:0", "bondVerified":true,
   "sources":["blockstream","liquid-network"], "bondCode":null},
  …
],
"bondExclusions": [{"idx":3, "bondRef":"liquid/testnet:cce0…:1", "refusal":
  "BOND_CHECK_REFUSED", "code":"BOND_SPENT", "detail":"…", "sources":[]}],
"bondGate": {"enforced":true, "requireBonds":true, "bondSats":1000,
             "threshold":3, "admitted":[1,2], "excluded":[3],
             "classification":"ROSTER_BELOW_THRESHOLD", "verdicts":[…]},
"classification": "ROSTER_BELOW_THRESHOLD"   // present only when it stopped
```

Only public material is written: rails, outpoints, values, heights, source names.
No key, seed, nonce, token or RPC credential.

### The runs (2026-11-12, four boxes)

Command shape (the host CLI is bao.markets `scripts/court/verify-bond.mts`, a
thin adapter over the shipped verifier):

```bash
export BAO_COURT_BOND_CHECK_CMD="cd <bao.markets> && npx tsx scripts/court/verify-bond.mts --allow-own-script --bitcoind-ssh=bao8gb"
```

| run | command | result |
|---|---|---|
| **A — bonded quorum** | `--scenario=happy-k2 --require-bonds --bond-sats=1000` and three Liquid-testnet refs | all three **PROVEN** (`blockstream` + `liquid-network` agree, 4140 sat, asset `144c6543…9a49`, height 2701339), DKG+signing complete, **one group key, one signature verified** by the coordinator |
| **B — one bad bond, k=3** | `--scenario=happy-kn --require-bonds --bond-sats=1000`, juror 3's ref spent | juror 3 **BOND_SPENT** → excluded → 2 admitted < 3 → **`ROSTER_BELOW_THRESHOLD`**, `groupKey:null`, `signatures:[]`, relay records 0 |
| **C — rail-agnostic** | `--scenario=happy-k2 --require-bonds --bond-sats=1000`, juror 1 on-chain | juror 1 **PROVEN** on Bitcoin testnet4 (`bitcoind-first-party` + `mempool.space/testnet4`, 4900000000 sat, 193 conf), jurors 2–3 Liquid → one key, one signature |
| **control — inert** | `--scenario=happy-k2`, variable unset | unchanged behaviour: `bondVerified:false`, 18 relay records, one key, one signature |

Bonds used, exactly:

| juror | rail | proofRef | verdict |
|---|---|---|---|
| A/1 `vps16gb`, A/2 `bao8gb`, A/3 `bao-testnet` | liquid | `0f1186fabb1fbeb1862f67edadedb291f0a41a0bc0ca5936c3f1028577465d2a:0` | proven (the **same** audited outpoint for all three — see the limit below) |
| B/1, B/2 | liquid | `0f1186fab…:0` | proven |
| B/3 `bao-testnet` | liquid | `cce002762fc697a9debd5edd91d3587b34bbd403fb8e88561c2ed422d82cf699:1` | **BOND_SPENT** (spent by the very transaction that created the bond above) |
| C/1 `vps16gb` | onchain | `f1a394de9060f7156a43d607c13ab5cb6920b86308fcd4b875afe11a6e382e74:0` | proven on testnet4 |
| C/2, C/3 | liquid | `0f1186fab…:0` | proven |

A refusal the gate also produces, shown directly against the CLI (same outpoint,
wrong denomination): `--bond-script=<the outpoint's own script> --asset=bbbb…`
→ `BOND_ASSET_MISMATCH` — a valid, unspent, correctly-scripted output that is
denominated in the wrong asset is still refused. And a refusal with **no**
script binding at all (no `--bond-script`/`--court-pubkey`, no
`--allow-own-script`) is `BOND_UNVERIFIABLE`, never a pass: "I could not check"
is not "bonded".

### The honest limit

- **A bond proves collateral at verification time — nothing more.** It does not
  prove the juror cannot be bribed afterwards, cannot collude, or will not sign
  the wrong outcome. It prices a seat; it does not buy honesty. The protocol's
  safety still rests on the DKG/reveal gates and the threshold, not on the bond.
- **`scriptBinding:"chain"` is weaker than `"configured"`.** The historical
  outpoints were funded before this round, so they do **not** pay the court bond
  lock, and the on-chain one does not pay the 2-of-2 court⊕juror script. In that
  mode the two sources agree on the outpoint's *own* script — proving existence,
  unspent-ness, asset, value and depth, but **not** that the coin is locked to
  the court, and therefore not that it is slashable by the covenant spender.
  Production must configure `--bond-script`/`--court-pubkey` and refuse everything
  else. The artifact says which binding applied, so the two can never be blurred.
- **Run A's three seats share ONE outpoint.** The Liquid testnet faucet still
  rejects every address shape we derive (`local variable 'data' referenced before
  assignment`), so no fresh bond could be funded; the audited outpoint was
  therefore proven three times. That demonstrates the enforcement path (three
  independent checks, three independent keys, a quorum that indeed signed), not
  three independent coins — a real deployment needs three distinct, court-locked
  bonds.
- **The check runs on the coordinator.** A coordinator that lies about the
  verdict is not detected by the ceremony; the boxes cannot check a chain. The
  artifact records the command and every verdict so the lie is at least on the
  record, and a host that re-verifies independently (as the API's admission path
  does) is the real defence.
- **The gate does not slash.** Excluding a juror is a seat decision; taking the
  bond stays the rail's own spender path.
