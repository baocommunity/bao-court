# Lane projections — `projection: 'lane'` (v0.15.3)

**Finding:** r12-1's second clause, measured by the host sync (bao.markets
PR #2488, draft) — *"no `ladder` ⇒ `ladderRound` must be 0"* is true of every
state the machine produces and false of the state a host persists.

**The defect.** `bao.markets` runs the escalation LANE of the confirmation
machine (`packages/api/src/services/court/CourtCaseMachineState.ts`). Its row
holds a `Pick` of `CourtConfirmationMachineState` — `phase`, `ladderRound`, the
policy flags, the roster, the challenge/excalation ledgers — and **no `ladder`**,
because the ladder in that deployment is the case row's
(`market_disputes.dispute_round`), not the lane state's. `ladderRound ≥ 1` with
no `ladder` is therefore the normal shape of a live host case, and r12-1's
clause refused all of it: 42 of 185 host court tests red across 8 suites,
including R50's first-contact escalation. Green at the v0.15.1 baseline;
reverting only that clause made 52/52 green.

The class is the r37-1 class: an invariant stated in terms of **shape**
("there is no ladder object") when what it means is **provenance** ("whose
ledger vouches for this round").

## The shape

```ts
// confirmationMachineTypes.ts
type CourtConfirmationStateProjection = 'lane';

interface CourtConfirmationMachineState {
  // …
  ladderRound: number;
  /** Absent on every state the machine produces. `'lane'` = a host projection. */
  projection?: CourtConfirmationStateProjection;
}
```

A host that persists the lane adds one field to its materialiser:

```ts
return { phase: 'round_resolved', projection: 'lane', ladderRound: facts.ladderRound, /* … */ };
```

Absent **means** "the machine produced this state" — the factory and the reducer
never write the field, so "absent ⇒ FULL" is a construction, not a convention.
An unknown marker (`'wallet'`, `'LANE'`, `1`, `null`) is a typed refusal at the
reducer's front door: a typo cannot silently re-strict a legal lane snapshot, and
no value other than `'lane'` is a trust upgrade.

## The rule, entry by entry

`assertRoundCountersAgree(state, entry)` — the reader is a **required** argument
so no caller inherits a rule it did not choose.

| entry | reads | a declared lane (`ladderRound ≥ 1`, no `ladder`) |
|---|---|---|
| `escalate` | `ladderRound`; opens `ladderRound + 1` | **accepted** — the rung has no ledger yet by construction, and `assertValidEscalationLog` sizes the log from the same counter, so the log vouches for it |
| `transport` | `ladderRound`; mints that event | **accepted** (same one round number, no second derivation — r9-4 stays one rule) |
| `open_ladder_round` | seats the round panel | **refused** — full state only |
| `resolve_round` | tallies the round's votes | **refused** |
| `flag_clawback` | persists the round into the audit ledger | **refused** |
| `finalize` | consumes the round for the verdict | **refused** |

Both shapes are still subject to the field's **write domain** — a non-negative
safe integer — on `ladderRound` *and*, when a ladder is present, on
`ladder.round` plus their equality. That is what keeps r12-1 closed; the marker
relaxes nothing about it.

**Why a marker, and not a `ladder` reference.** The host's older wire projection
fabricates `ladder: { round }` to satisfy r9-4, and that works for a mapper that
reads one field. It is the wrong answer for a PERSISTED state: the reducer's
front door requires `ladder.votes` to be an array, so the fabrication would have
to grow a `votes: []` — a made-up ledger, `stateHash`-covered, that
`assertValidMassVoteLedger` would then treat as real. The host's own design rule
("every field the consumer does not read is absent, so a consumer that starts
reading one fails closed") is the correct one, and a declared provenance is the
only way to keep it while telling the machine what the counter means.

## What this does NOT buy a host

- A lane projection cannot reach a **write** path. `flag_clawback`, `finalize`,
  `resolve_round` and `open_ladder_round` refuse it, so a projection can never
  persist a round in the clawback ledger or mint a verdict.
- Escalating does not launder a projection into a full state: the marker survives
  the transition (`{ ...state }`), so the escalated lane is still refused by the
  write paths.
- A forged counter is refused identically on both shapes — the domain check is
  provenance-blind.
- The marker is not an authentication: a hostile snapshot can set it. What
  bounds the damage is unchanged — the write domain, the escalation log's
  completeness and witness rules, and the fact that only `escalate`/`transport`
  read a projection's counter.

## The evidence

`__tests__/overStrictness.test.ts` (25 tests) is the standing suite:

| direction | what it pins |
|---|---|
| accept | a shape × reader MATRIX over 12 legal host shapes (lane first contact, lane at a later rung, lane mid-escalation, the older wire projection, the machine's own state at every phase, the legacy shapes) — every cell asserted both ways |
| accept | the exact `buildCaseMachineLaneState` output escalates from round 1; phase, log length, rung, counter and marker all asserted; the mapper mints the same event from the same state |
| refuse | r12-1's forged counters (hostile string, `2.5`, `-1`, `null`, `NaN`, `2^53`) on **both** shapes; a full state with a counter and no ledger; a lane projection re-stamped into `fee_settlement`, `ladder_vote_closed`, `ladder_pending` — all four write paths refuse and nothing is written |
| refuse | an unknown marker; the same state with the marker stripped |
| sweep | every exported `assert(state)` in `confirmationMachineCore` must accept the lane unless the sweep's allow-list names it with the reason — a NEW barrier cannot re-strict a legal host shape silently |

The r12-1 and r9-4 pins in `reviewRound12.test.ts` / `reviewRound9.test.ts` are
unchanged in intent and both still red a hostile snapshot; the barrier's
"no ladder round is open" sentence is preserved for the shape it was written
about (a FULL state), and the lane's refusal names the declaration that would
have made it legal.

## Host migration (bao.markets)

1. Add `'projection'` to `CourtCaseMachineLaneState`'s `Pick` and set
   `projection: 'lane'` in `buildCaseMachineLaneState`.
2. Keep the field out of `assertCaseMachineLaneState`'s rejection list if it
   validates unknown keys; validate it as `'lane'` if it validates the shape.
3. `mapEscalationToMachineEvent`'s per-request projection may drop the fabricated
   `ladder: { round }` — either shape maps — but dropping it is the honest form.
4. **Existing rows need the marker.** A lane row written before v0.15.3 has
   `ladderRound ≥ 1` and no `projection`, so the first reduction after the
   upgrade refuses it (fail-closed, typed: *"does not declare projection"* —
   nothing is corrupted, but the escalation is rejected). Two safe options:
   - **inject on read** (preferred): after `assertCaseMachineLaneState(row.state)`,
     `row.state.projection ??= 'lane'` — the marker reaches the reducer, and the
     next applied transition persists it inside the state the CAS writes, whose
     `state_hash` is recomputed from it. The stored hash stays consistent with
     the stored state at every version.
   - a JSONB backfill **must move `state_hash` with `state`** (the store does not
     recompute it on read, so a state-only backfill leaves every backfilled row
     un-auditable). Computing `sha256(canonical(...))` in SQL is not fun: prefer
     the read-time injection.
   Rows the host writes after the upgrade carry it by construction.
5. Re-vendor at **v0.15.3**; the 42 red tests are the acceptance criterion, and
   `docs/REVIEW_ROUND_10.md` §4.4's "the list of entries is the invariant" still
   holds for the reader argument.
