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
3. the round bond is **any other accepted challenge bond of the case** (R33,
   r33-1) — otherwise a second bonded challenger can quote the first one's
   membership bond as its own per-round payment, burning a witness its owner
   still needs and billing the quoter nothing;
4. the round bond was **already consumed** by an earlier record in
   `escalationLog`;
5. the **log itself is incomplete** for the rounds this case opened (R33,
   r33-5): one record per escalation, enforced whenever the case has any record
   and unconditionally under `requireRoundBond`, so a restored snapshot cannot
   delete an entry to un-consume the bond it paid with.

The membership pool the rules above read has its own uniqueness invariant
(R38, r38-1): `accept_challenge` binds one `bondProofHash` to at most ONE roster
index per case, and `assertValidConfirmationLedger` re-checks it on a restored
ledger. Without it the whole list was attackable in two steps — mint an
"accepted challenge" that reuses a bonded juror's hash (the ledger deduped by
`idx` only), then escalate on `(idx, bondProofHash)`, which is exactly the pair
r29-1 taught the reducer to require. One paid bond bought unlimited standing. A
host whose proof derivation can collide across jurors (a hash of the funding
transaction, which a batch payout shares) must mix the juror index into the
witness.

The hash is bound to the round by construction: the witness's `roundIndex` must
open exactly `ladderRound + 1`, the record stores that round, and the log is
append-only, so "one fresh witness per rung" is a property of the state, not of
the host API. `assertValidEscalationLog` (the barrier `finalize` re-runs **and**
`escalate` now re-runs before a rung opens) re-derives all five rules, so a
hand-restored snapshot cannot re-open the option by editing the log. The log is
bounded by `MAX_LADDER_ROUNDS` (5), so the consumption set is bounded too.

`hostEscalationEvent` (break-glass) still carries **no** witness: a host record
must have `roundBondProofHash === null`, exactly like its other challenger
fields.

### What the machine does NOT enforce (read before quoting the economics)

R33 attacked this layer and the honest boundary is narrower than "the ladder
costs `3^R b₀`" (`docs/REVIEW_ROUND_4.md` §1):

- **Uniqueness, not payment** (r33-2). The machine sees a 32-byte string. Any
  never-paid hash satisfies a strict case; nothing binds the hash to an escrow, an
  amount, or a chain. The *membership* bond is at least tied to a juror through
  `state.challenges`; the round bond is tied to nothing. The r30-1 pricing is
  therefore only as real as the host's per-round verification, and a nominally
  fresh but under-priced bond is caught only by the host's pre-flight.
- **A bonded rival can front-run a paid witness** (r33-2b). Whoever escalates
  first is billed, because the machine cannot tell whose bond a hash is; the
  victim's own escalation is then refused ("already consumed"). Only one
  `escalate` per resolved round exists, so the harm is attribution plus griefing,
  not extra rungs.
- **The ledger is per CASE** (r33-3). One round bond is consumable once per case;
  two cases accept the same hash. The host must dedupe bond hashes globally
  (r29-4's remedy).
- **The default is the legacy free option** (r33-4). `requireRoundBond` defaults
  to `false`, so a host that does not opt in keeps `ΔC = 0`. "New deployments set
  `true`" is a documented instruction, not an enforced default; the hostile
  restore is only fully closed under the strict policy.


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
| `requireRoundBond: true` | **another** juror's accepted challenge bond | **refused** (R33, r33-1 — see the reducer list) |
| any policy, authority `host` | any non-null | **refused** (`a host escalation must not carry a challenger request witness`) |

**Never compose `requireRoundBond: true` with `hostEscalation: true`** (R38,
r38-2). The break-glass row above exempts a *challenger* escalation from the
round-bond requirement, not just the host's, so the strict policy prices
nothing on such a case. The exemption is a pinned decision (it is how a
break-glass case stays compatible), and it is now recorded as a hazard: a
deployment that wants break-glass recovery should leave `requireRoundBond`
false, or wait for the v0.14 policy split (host authority vs challenger
authority).

Restored snapshots: an **absent** `requireRoundBond` reads as `false` and an
**absent** `roundBondProofHash` reads as `null`, so pre-0.13 snapshots still
load and finalize. A strict case (`requireRoundBond: true`, not break-glass)
refuses a challenger record with no per-round bond, so stripping the field from
a restored snapshot fails closed rather than silently downgrading the case. A
strict case also refuses a snapshot whose log is missing an entry for a round it
opened (`r33-5`), because a dropped entry un-consumes the bond it paid with.

## What the host must do

1. **New deployments:** create confirmation machines with
   `requireRoundBond: true`. Nothing else changes in the reducer. Until this is
   wired the deployment rides the **default** (`false` = the r30-1 free option,
   r33-4) — the hosted package vendors v0.12.0 today, so no live case is strict.
2. **Post and verify a bond per round, and bind it to the challenger.** The
   machine can only see that a hash is fresh; `accept_round_bond`-style
   verification (or a globally unique proof-hash registry) is what makes it a
   payment (r33-2 / r33-2b / r33-3). The per-round amount is the spec's
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
   returns the verdict plus both numbers for a refusal message; its `ok` is
   sign-based (`cap < flipRound`), and `derivedCap = 0` means **no depth is
   safe** — refuse the ladder (R33, r33-6). No host measures `a_f` yet, which is
   why r33-7 is open.

## Tests

- `__tests__/perRoundBond.test.ts` — the matrix above, attacked from the reducer
  boundary: absent / relabelled / reused / malformed witnesses, the legacy
  default, the strict policy, the break-glass exception, and three restored
  snapshots (reused, relabelled, stripped) refused at `finalize`.
- `__tests__/reviewRound4.test.ts` — the R33 attacks on the same surface: a
  foreign membership bond (reducer + finalize), an emptied or partially deleted
  log reusing a consumed bond, the escalate-time barrier, the no-challenge
  finalize path, and the registered limits (uniqueness-not-payment, front-run,
  cross-case, the default).
- `__tests__/reviewRound5.test.ts` — the R38 attacks on these rules: the
  borrowed membership bond (two-step r29-1 bypass, closed here), the union of
  the consumption sets, the round-bond-as-membership direction (phase + barrier),
  ledger order/duplicates/gaps/mismatched challenger, the escalate-time barrier,
  and the registered limits (break-glass exemption, the unverifiable
  `challengerPubkey`).
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
  Nothing checks the frozen depth against the bound at creation (r33-7).
- `roundBondProofHash` is a uniqueness witness, not a payment witness (r33-2),
  it can be claimed by another bonded challenger before its owner uses it
  (r33-2b), and it is expendable once per case (r33-3). All three need an
  accepted-round-bond ledger in the host (`docs/REVIEW_ROUND_4.md` §1.3–1.5).
