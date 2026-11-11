# Multi-process ceremony simulation (round 30)

The reviewer's standing objection to the assurance case is: *"nothing ran
distributed."* This harness is the closest we can get without a second box.
It is **not** a distributed deployment, and this page exists to keep us from
claiming it is.

```
tsx scripts/court/multi-process-ceremony.mjs --jurors=3
tsx scripts/court/multi-process-ceremony.mjs --jurors=7
tsx scripts/court/multi-process-ceremony.mjs --jurors=5 --chaos=kill --kill-phase=sign
tsx scripts/court/multi-process-ceremony.mjs --jurors=3 --chaos=replay
```

Part of the CI suite: `__tests__/r30MultiProcessCeremony.test.ts` runs the
happy path, both kill points, and the replay scenario (≈15 s).

## What actually happens

Each juror is a **separate OS process** (`scripts/court/juror-child.ts`),
spawned by the coordinator (`scripts/court/multi-process-ceremony.mjs`) with
`node --import tsx`. Each has:

- its own PID, heap, and secret identity (derived deterministically from the
  ceremony seed so the roster needs no trust handshake);
- its own state directory (`juror-<idx>/published.jsonl`, `outcomes.json`) —
  no shared memory, no shared objects, no in-process calls between jurors;
- its own poll cursor into the relay.

The **relay** is a `node:http` server on loopback TCP. Jurors exchange JSON
envelopes over real sockets and never hand each other objects. The relay — not
the jurors — assigns the total message order (monotonic `seq`), and the
coordinator refuses to start without it. Payloads on the wire are **signed
Nostr events** re-parsed in the receiving process by the production parsers
(`parseDkgCommitmentEvent`, `parseEncryptedShareEvent`, `parseFrostCommitEvent`,
`parseFrostRevealEvent`) and gated by `IndependentDkgSession` /
`IndependentSigningSession`.

The ceremony is the real one: Pedersen DKG (verify shares, complaint gates,
full-roster key computation) → FROST commit/reveal/aggregate →
`verifyFinalSignature`. The **coordinator verifies independently**, from the
wire only: it re-parses every published DKG commitment, sums the constant
commitments to recompute the group key, and checks the aggregate signature
against it with its own verifier.

## Latency model

Deliberately simple and documented rather than measured: we exercise
*ordering*, not timing.

| Parameter | Value |
|---|---|
| Transport | HTTP/1.1 over loopback TCP, JSON envelope, relay-assigned `seq` |
| Pre-publish jitter | `(idx*13 + round*29 + phaseIndex*7) % 41` ms (deterministic) |
| Commitment → shares gap | 150 ms (so a mid-round kill lands between them reproducibly) |
| Poll interval | 20 ms (a message is visible to a peer within one tick) |
| Phase deadline | 10 s default (`--deadline-ms`); the harness cannot hang |
| Whole-harness budget | 300 s default (`--budget-ms`) |

## Scenarios and asserted outcomes

| `--chaos` | Assertion |
|---|---|
| `none` (N = 3…7) | Every process completes DKG + signing; **one** group key across all processes; **one** identical signature; coordinator recomputes the same group key from published commitments; the aggregate verifies against it; one state dir per juror. |
| `kill --kill-phase=dkg` | Victim SIGKILLed after its commitment reaches the relay. Every survivor fails closed with `DKG_MISSING_PARTICIPANT`, blames the victim, and accepts **no** group key (the attempt is not shrunk to a threshold subset). |
| `kill --kill-phase=sign` | Victim SIGKILLed after its FROST commitment. DKG still completes (survivors agree on the group key), then every survivor fails closed with `SIGN_MISSING_REVEAL`, blames the victim, and emits **no** signature. |
| `replay` | Juror 2 republishes its round-1 signed commitment and shares verbatim into round 2 (the outer envelope is unauthenticated, so re-labelling is allowed). Honest processes detect the equivocation, disqualify juror 2, and fail closed with `DKG_DISQUALIFIED`; the replayer — which never sees its own traffic — diverges locally and still cannot collect reveals. **No signature anywhere.** |

## What this proves

- The ceremony **completes** across independent processes that share nothing
  but a relay, an ordering, and signed events.
- The protocol **fails closed** on process death at two different points, with
  the **correct classification** and the **correct blame**, and never emits a
  partial signature or a subset-derived group key.
- Replayed wire bytes are rejected, and the rejection is attributable.
- Verification is independent: the coordinator re-derives the group key from
  the transcript, so a coordinating bug cannot certify itself.

## What this does not prove

- **It is still localhost.** One kernel, one clock, one machine. No packet
  loss, no partitions, no clock skew, no congestion, no scheduler failure, no
  disk failure.
- **The relay is honest and always available.** Censorship, equivocation and
  eclipse are covered by the transport suites (`courtInbox`/`courtOutbox`
  provenance, dedupe, capacity) and by peer-side verification — not here.
- **No Byzantine liveness.** One dead juror stalls the round until the phase
  deadline and aborts the attempt. That is the *current* protocol's behaviour
  (DKG requires the full certified roster; the roster never shrinks), not a
  property this harness adds.
- **Custody is not simulated.** Shares live in process memory for the run;
  nothing here exercises HSMs, disk encryption, or backup/restore.
- **Concurrency is not adversarial by default.** Ordering is relay-assigned
  and total; byzantine reordering is a transport-suite concern.

The remaining gap to a real deployment is therefore *operational*: network
asynchrony, real relay failure modes, key custody, and machine-independent
timing. The **coordination structure** — separate processes, separate
identities, signed messages, third-party ordering, independent verification,
crash and replay — is real.
