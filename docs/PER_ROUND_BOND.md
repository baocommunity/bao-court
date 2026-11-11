# Per-round escalation bonds (v0.13, R31)

**Finding:** `docs/proofs/economics/06-expert-verify.tex.md` §1 (r30-1) — *the
escalation bond was a membership test, not a consumption test.*

`accept_challenge` is the only event that admits a bond, and `escalate` carried
no amount: any bond that appeared in the challenger's accepted challenges
authorised every round. One payment therefore bought the whole ladder
(`ΔC_{r+1} = 0` for every `r`), which turns escalation into a **free option**
worth `Σ 3^r b₀ = 363 b₀` at the protocol cap. The measured consequences:

| what | before | after (this change) |
|---|---|---|
| challenger's expected burn at the shipped cap (`R = 2`) | −1.86 % of V | the price of round 2's bond |
| at the protocol cap (`R = 5`) | −0.543 % of V (77.4 % of the deterrence gone) | the price of rounds 2–5 |
| ladder total cost | `b₀` (one bond) | `(3^{R+1} − 1)/2 · b₀` = 4/13/40/121/364× |
| venue cost ÷ griefer loss at `R = 5` (`c_s = 500`) | 54.1× | bounded by the per-round price |

## What the machine now enforces

The escalation witness gained one field and the log became a ledger.

```
CourtEscalationRecord.roundBondProofHash : string | null
escalate.roundBondProofHash?             : string | null
CourtConfirmationMachineState.requireRoundBond : boolean   (frozen policy)
```

`onEscalate` (challenger authority) refuses an escalation when

1. the round bond is **absent** and `requireRoundBond === true` (break-glass
   cases aside — see the matrix);
2. the round bond **is the membership bond** (`bondProofHash`) — relabelling the
   one payment is not a payment;
3. the round bond was **already consumed** by an earlier record in
   `escalationLog`.

The hash is bound to the round by construction: the witness's `roundIndex` must
open exactly `ladderRound + 1`, the record stores that round, and the log is
append-only, so "one fresh witness per rung" is a property of the state, not of
the host API. `assertValidEscalationLog` (the barrier `finalize` re-runs)
re-derives the same three rules, so a hand-restored snapshot cannot re-open the
option by editing the log. The log is bounded by `MAX_LADDER_ROUNDS` (5), so the
consumption set is bounded too.

`hostEscalationEvent` (break-glass) still carries **no** witness: a host record
must have `roundBondProofHash === null`, exactly like its other challenger
fields.

## Compatibility matrix

`requireRoundBond` defaults to **FALSE**. Every existing case, snapshot and
consumer keeps the v0.12 semantics until it opts in.

| case policy | witness carries `roundBondProofHash` | outcome |
|---|---|---|
| `requireRoundBond: false` (default, v0.12) | absent / `null` | **accepted** — legacy membership semantics (one bond, every round) |
| `requireRoundBond: false` | a fresh hash | **accepted and consumed** — a host can tighten a legacy case without flipping the policy |
| `requireRoundBond: false` | the membership bond | **refused** (`must be distinct from the membership (challenge) bond`) |
| `requireRoundBond: false` | a consumed hash | **refused** (`already consumed by round r`) |
| `requireRoundBond: true` (new deployments) | a fresh hash | **accepted and consumed** — the intended consumption test |
| `requireRoundBond: true` | absent / `null` | **refused** (`requires a per-round bond witness`) |
| `requireRoundBond: true` + `hostEscalation: true` | absent / `null` | **accepted** — break-glass: the host may already open a round with no bond at all, so charging the challenger prices nothing |
| `requireRoundBond: true` | the membership bond, or a reused hash | **refused** (same two rules) |
| any policy, authority `host` | any non-null | **refused** (`a host escalation must not carry a challenger request witness`) |

Restored snapshots: an **absent** `requireRoundBond` reads as `false` and an
**absent** `roundBondProofHash` reads as `null`, so pre-0.13 snapshots still
load and finalize. A strict case (`requireRoundBond: true`, not break-glass)
refuses a challenger record with no per-round bond, so stripping the field from
a restored snapshot fails closed rather than silently downgrading the case.

## What the host must do

1. **New deployments:** create confirmation machines with
   `requireRoundBond: true`. Nothing else changes in the reducer.
2. **Post and verify a bond per round.** The per-round amount is the spec's
   `ΔC_R = 3^R b₀` on top of the challenge bond (`cumulativeLadderBondMultiple`
   in `ladderEconomics.ts` gives 4/13/40/121/364× at `R = 1..5`). The old host
   helper doubles (`2^(r−1)`) while the spec triples — reconcile that before
   wiring amounts (r30-1b); the package only pins the shape, the amounts are
   host policy.
3. **Cap the ladder from the measured accuracy** until every deployment is
   strict: `deriveMaxLadderRounds({ a_f, rho, beta })` is the boxed rule of
   06 §1.5. Use `deriveLadderFlipRound` for alerting — it is the first round
   that is *profitable* (7 at `a_f = 0.9`, 5 at 0.85, 3 at 0.75), one above the
   safe cap (6/4/2, clamped to the machine ceiling 5). `ladderCapWithinBound`
   returns the verdict plus both numbers for a refusal message.

## Tests

- `__tests__/perRoundBond.test.ts` — the matrix above, attacked from the reducer
  boundary: absent / relabelled / reused / malformed witnesses, the legacy
  default, the strict policy, the break-glass exception, and three restored
  snapshots (reused, relabelled, stripped) refused at `finalize`.
- `__tests__/ladderEconomics.test.ts` — the derived cap and flip round against
  06's published numbers, the EV sign at the boundary, monotonicity, and the
  bond schedule.
- `__tests__/reviewRound3.test.ts` — the r29-3 residual now asserts the legacy
  path *and* points at the strict test that closes it.
- `__tests__/modelCheckingCore.ts` (P2) — the state invariant: a per-round bond
  is well-formed, distinct, and never consumed twice; a strict case never logs a
  challenger escalation without one.
- `__tests__/scale/witnessCorpus.ts` (W3) — the accepted record carries exactly
  the witnessed per-round bond.

## Residuals (unchanged, registered)

- The amounts are host policy; the machine cannot see them, and a host that posts
  a *nominally* fresh but under-priced bond is only caught by its own pre-flight
  (`ladderCapWithinBound`, `calculateBondAmount`).
- An escalation bond is returned on a win against the *rejection*; a case that
  never resolves (abort) refunds nothing here — r30-1's EV assumed the bond
  returns, and the forfeit path is unchanged.
- `maxLadderRounds` remains a constant per case; the derived bound is a
  pre-flight rule, not something the machine recomputes from a measured `a_f`.
