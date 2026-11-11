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
6. the **challenge pool the witness test reads is itself the ledger the machine
   could have produced** (R40, r40-1). Rule 3 above and the `(idx,
   bondProofHash)` test both enumerate `state.challenges`, so `escalate`
   re-derives the challenge-ledger uniqueness (r38-1) before opening a rung —
   without it a restored ledger binding one hash to two indices satisfies the
   pair test for a juror that posted nothing, and a *free* rung is opened on a
   bond its nominal owner still holds.

The membership pool the rules above read has its own uniqueness invariant
(R38, r38-1): `accept_challenge` binds one `bondProofHash` to at most ONE roster
index per case, and `assertValidConfirmationLedger` re-checks it on a restored
ledger. Without it the whole list was attackable in two steps — mint an
"accepted challenge" that reuses a bonded juror's hash (the ledger deduped by
`idx` only), then escalate on `(idx, bondProofHash)`, which is exactly the pair
r29-1 taught the reducer to require. One paid bond bought unlimited standing.

The binding is **per case and per index**: a juror holds at most one challenge in
a case, one bond witness buys one challenger's standing *in that case*, and the
same hash may be cited by a different case (there is no cross-case memory here —
r33-3, the host's registry). That is deliberate: the machine's registry is
`state.challenges`, and a cross-case ledger is not a state this package can see.

A host whose proof derivation can collide across jurors (a hash of the funding
transaction, which a batch payout shares) must mix the juror index into the
witness. Note *why* that is mandatory rather than tidy: a **derivable** witness is
**preemptable**. `hash(bondTxid)` is computable the moment the bond is on chain,
and uniqueness is first-come-first-served, so a juror that owns no bond can
register it under its own index and lock the payer out (R40, r40-3). The machine
cannot tell owner from copier — the state carries no idx→pubkey registry (r38-3)
— so the host's bond verifier must bind the witness to the **event author**, and
v0.14's `accept_challenge` pubkey makes it re-derivable.

The hash is bound to the round by construction: the witness's `roundIndex` must
open exactly `ladderRound + 1`, the record stores that round, and the log is
append-only, so "one fresh witness per rung" is a property of the state, not of
the host API. `assertValidEscalationLog` (the barrier `finalize` re-runs, and that
**`escalate` and `open_ladder_round` re-run before a rung is opened or a panel
seat is spent**) re-derives all six rules, so a hand-restored snapshot cannot
re-open the option by editing the log — and `escalate`/`open_ladder_round` also
re-derive the challenge-ledger uniqueness that rules 3 and 6 depend on. The log is
bounded by `MAX_LADDER_ROUNDS` (5), so the consumption set is bounded too.

A restored snapshot at **`ladder_pending`** is a legal state and every barrier
accepts it (R37, r37-1: `escalate` appends the record for `ladderRound + 1` and
`open_ladder_round` advances `ladderRound`, so the half-step carries one record
naming `ladderRound + 1`; the completeness rule accounted for it and the round
bound did not, which made hosts refuse the very snapshots the restore contract
told them to restore). The definition is **one record per OPENED round** —
`ladderRound − 1`, or `ladderRound` while a rung is pending.

**The entry matrix names the pools, not just the barriers (R41, r41-1).** Round
6 classified `close_ladder_round`, `concede` and `flag_clawback` as non-readers
"followed by a pool-reading barrier before any value is locked in" — true of the
CHALLENGE pool, and false of the pool `finalize` actually reads for a challenged
case: the verdict's evidence is the **round vote ledger**. `concede` walks
straight to `fee_settlement` without re-deriving anything, so a restored snapshot
entered through it carried a forged vote ledger into `finalize`, which had no
mass-vote barrier at all — duplicate ballots, off-roster voters and event ids no
ballot ever carried all minted a canonical verdict (a malformed id even escaped
as the *vote* machine's error type). `finalize` now runs
`assertValidMassVoteLedger` for a challenged case and derives the verdict from
the round's append-only `outcomeHistory` record, requiring the vote ledger to
agree with it. The non-readers themselves are unchanged and still lock nothing
in: each is followed by a barrier before value moves.

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

**Transport (R43, H-6).** The matrix above is the REDUCER's policy. What the
client can actually SUBMIT is the wire: `courtEscalationRequest.ts`
(`roundBondProofHash` optional, `null` = the legacy shape) and, on the host, the
escalate body schema plus the request hash. Review round 7 (H-6) found the body
schema could not carry the field at all and the hash ignored it, so the strict
rows were unreachable from a client and two different round bonds produced one
request hash. Both halves now ship: the package codec (domain **v2**, witness in
the preimage) and the host's byte-identical `hashEscalationRequest` / body field.
Ship the transport before enforcing the policy.

**The mapping needs the host's binding (r8-2).** `escalationRequestToMachineEvent`
takes a fourth argument, `{ caseId, authenticatedPubkey }` — the case id the
host routed on and the pubkey the request authenticated as (NIP-98). The reducer
carries indices, not pubkeys, so it cannot pair `challengerPubkey` with the bond
owner (r29-5); without the binding the transport used to mint an escalation
whose append-only log could name ANY juror, apply a request signed for one case
to another, and accept a request signed for round 1 at round 3. All three are
refused now, and a 3-argument call is a refusal rather than a silent pass.

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

### Upgrading a deployment to the strict policy (checklist — R41, r41-T4)

The strict policy is a **host** decision passed at case creation; this package
does not flip it (a factory default of `true` is v0.14, sweep r33-4). Nothing
here breaks on upgrade — an existing case keeps whatever policy it froze, and a
pre-0.13 snapshot with the field absent stays legacy (`reviewRound7.test.ts` ›
'(r41-T4) a v0.12 snapshot … is legacy'). The breakage risk is the *other*
order of operations, and it is the one to check before arming:

1. **The transport must carry the witness BEFORE the policy requires it.** A
   strict case refuses any challenger escalation without `roundBondProofHash`,
   so a host that flips the flag while its escalate endpoint still accepts only
   `{round, bond_txid, bond_proof_hash, event_id, signed_at}` turns every
   escalation into a typed refusal — the ladder parks at its last resolved round
   (fail closed, but dead). Verify the route's body schema and the request hash
   both carry the per-round witness (and that the hash binds it, or two
   different round bonds produce the same request hash).
   **The package-side transport now exists (R43, H-6):**
   `courtEscalationRequest.ts` is the versioned wire codec —
   `buildCourtEscalationRequest` / `serializeCourtEscalationRequest` /
   `parseCourtEscalationRequest` carry the optional `roundBondProofHash`,
   `hashCourtEscalationRequest` binds it (domain **v2**), and
   `escalationRequestToMachineEvent` produces the reducer's `escalate` event
   field-for-field (the wire supplies the challenger's claims; the CASE supplies
   `challengerIdx`, `roundIndex` and `now`). The host's escalate body schema and
   its own request hash must adopt the same shape — a body that rejects the
   field (`additionalProperties: false` without it) is the H-6 defect itself.
2. **A strict case cannot be relaxed later.** The policy is frozen with the
   case: a host that flips `BAO_COURT_REQUIRE_ROUND_BOND` back to `0` changes
   only NEW cases. Existing strict cases keep refusing witness-less
   escalations.
3. **Never combine it with `hostEscalation: true`** (the matrix's break-glass
   row): the exemption is granted to challenger escalations too, so the strict
   policy prices nothing (r38-2).
4. **Legacy cases keep the documented deletion residual** (r33-5): a legacy case
   restored with an emptied log still opens a rung. A deployment that wants that
   closed must create new cases under the strict policy — there is no retrofit.
5. **Both ends must agree on "one bond witness, one standing"** (r38-1/r40-3):
   the witness derivation must mix the juror index in, and the host verifier
   must bind it to the event author, or the first registrant preempts the payer.

## What the host must do

1. **New deployments:** create confirmation machines with
   `requireRoundBond: true`. Nothing else changes in the reducer. Until a
   deployment opts in it rides the **default** (`false` = the r30-1 free option,
   r33-4). The shipped host opted in at R39 (`BAO_COURT_REQUIRE_ROUND_BOND=0` is
   the explicit legacy opt-out) and vendors bao-court v0.13.1, so a host case is
   strict unless an operator says otherwise.
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
   safe** — refuse the ladder (R33, r33-6). Read the SIGN-BASED verdict, not the
   two integers: composing `cap <= derivedCap` is a different predicate, and it
   blesses a break-even rung (`E[π] = 0`) whenever the boundary is an exact
   integer — unreachable at ρ = β, reachable as soon as they differ (R40, r40-4).
   The host gates the *assumed* accuracy (0.85) at creation since R39, which is
   not a measurement: r33-7 stays open, and the boot backfill / NULL fallback
   paths still write the depth from the unbounded config (r40-5).

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
- `__tests__/reviewRound6.test.ts` — the R40 attacks on the *barriers*: the
  challenge-ledger re-derivation at `escalate` and `open_ladder_round` (r40-1),
  the deleted record at `ladder_pending` (r40-2), the barrier-at-every-entry
  matrix (5 readers pinned, 3 non-readers stated), the cross-case and collision
  semantics, the preemption residual (r40-3), and the **legal-state hunt** — a
  490-state walk over every policy/ladder/authority combination asserting that no
  reducer-reachable state is refused by either barrier.
- `__tests__/reviewRound7.test.ts` — the R41 attacks: the three stated
  non-readers probed with forged snapshots (r41-1: `concede` carries a forged
  vote ledger into `finalize`, which minted a verdict for a losing outcome),
  the verdict evidence barrier and the derived `upheld`, a 40-flow
  over-strictness walk, and the sign-rule predicate probed at its edges
  (ρ/β ⇒ 0, scale invariance, monotonicity in `a_f` and `β`, the break-even
  cell, `derivedCap = 0`, the constant-`β` drift).
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
  The host gates the depth it FREEZES at creation since R39, but against an
  ASSUMED accuracy (0.85, env-overridable), and two write paths bypass that gate
  (boot backfill, NULL fallback — r40-5). A measured `a_f` is still r33-7.
- `roundBondProofHash` is a uniqueness witness, not a payment witness (r33-2),
  it can be claimed by another bonded challenger before its owner uses it
  (r33-2b), and it is expendable once per case (r33-3). All three need an
  accepted-round-bond ledger in the host (`docs/REVIEW_ROUND_4.md` §1.3–1.5).
