# proofs/mechanized — Machine-checked verification of the Court phase machines

An **independent second model** of the two BAO Court phase machines, written in
[Quint](https://quint.sh) and verified with three complementary backends:

| Backend | What it does | Result (see `quint-run.log`) |
|---|---|---|
| `quint typecheck` | type/effect checking of the spec | clean |
| `quint test` | 58 deterministic scenario tests mirroring the TS test matrix (42 phase-machine + 16 escalation-transport) | **58 passing, 0 failed** |
| `quint run --invariants` | **10 000 seeded random simulation runs** (60 steps) for the phase machines, plus 5 000 + 3 000 for the escalation transport (14 steps) | no violation (vote, confirmation, escalation) |
| `quint verify` (Apalache) | **exhaustive symbolic model checking** to depth 10 (phase machines) and 8 (escalation) | no violation where a JVM is available (see the log) |

The spec is a re-model, not a transcription: it was written from the TS guard
clauses and then cross-checked against them. Differences discovered during that
cross-check are recorded below under **Divergences & findings**.

Modeled: `courtVoteMachine.ts` (paper §5), `courtConfirmationMachine.ts` +
`confirmationMachine{Types,Core,Handlers}.ts` (paper §6), and the v0.14.0
escalation WIRE (`courtEscalationRequest.ts`) landing on the reducer
(`escalation.qnt`, Theorem 7 of `docs/proofs/07-mechanised-escalation.tex.md`). This directory
**machine-checks the Vote/Confirmation instances of Theorem 4 — ceremony-
machine safety** (`docs/proofs/04-machine-safety.tex.md`: "every state
reachable from `create_M(params)` satisfies the machine's INV-* bundle") and
the state-machine part of **Theorem 3 — tally well-definedness**
(`docs/proofs/03-tally.tex.md`), as a third verification channel that shares
no harness with either the TS model checker (`__tests__/modelCheckingCore.ts`
— the committed witness-aware sweep: 15 instances, 3.87M states; 13 / 3.1M
before the two witness instances) or the prose induction. Invariant identifiers
cross-reference `docs/FORMAL_INVARIANTS.md` §4 (INV-VOTE-1..23) and §5
(INV-CONF-1..36); the machine-checked subset is tabulated below.

## How to re-run (one command)

```bash
cd proofs/mechanized
./run.sh                       # requires quint 0.33.1 + Java 21 (for Apalache)
```

- Quint: `npm install -g @informalsystems/quint@0.33.1` (or `QUINT=/path/to/quint ./run.sh`).
- Java 21+ on `PATH` for the `quint verify` steps; quint fetches the Apalache
  distribution automatically on first use.
- Without Java the script still runs steps 1–4 and notes the skip.
- Determinism: the scenario tests are fixed scripts; both simulator runs are
  seeded (`--seed 42`; quint echoes the effective seed, e.g. `--seed=0x97a2c7
  --backend=rust`, on completion). Apalache is exhaustive — no randomness.
- The committed `quint-run.log` is the output of exactly this script
  (`./run.sh > quint-run.log 2>&1`).

Individual pieces:

```bash
quint typecheck court.qnt
quint test court.qnt --main voteTests          # + confirmTests, confirmQuorumTests, confirmCapOneTests
quint run court.qnt --main voteSim --invariants inv \
  --witnesses wTallyFinal wFullLedger wExpired wAborted \
  --max-samples 10000 --max-steps 60 --seed 42
quint verify court.qnt --main voteSim --invariants inv --max-steps 10
```

Note: `quint test` (0.33) only discovers `run` defs whose **name ends in
`Test`** — that is the naming convention here.

## What is verified

### Vote machine (`voteMachine`, `courtVoteMachine.ts`)

**Theorem 4 (Vote instance) + Theorem 3 (tally), machine-checked.**
State space per instance: 3 jurors × 2-outcome ballot × commit hashes
(6 witnesses incl. 2 legacy) × salts × deadline windows. Invariants held on
every reachable state (sim + Apalache):

| Quint invariant | Paper / doc reference |
|---|---|
| `invPhase` — phase ∈ declared 7-phase set | INV-VOTE-1, INV-VOTE-3 |
| `invClock` — clock ledger non-negative | INV-VOTE-4 |
| `invCommits` — commits ⊆ roster, version-bit gate, ≤ 1 per idx | INV-VOTE-8, INV-VOTE-9 |
| `invReveals` — reveals ⊆ roster × ballot × salt, reveal ⊨ commit (session-bound hash), ≤ 1 per idx | INV-VOTE-11, INV-VOTE-12, INV-VOTE-13 |
| `invLedgerBound` — \|reveals\| ≤ \|commits\| | INV-VOTE-14 |
| `invVerdictCoherence` — verdict ⟺ `tally_final` | INV-VOTE-21 |
| `invFailureCoherence` — failure ⟺ `expired`/`aborted` | INV-VOTE-7/22 |
| `invTally` — verdict IS the plurality tally with canonical tie-break, support ≥ 1 | INV-VOTE-16, INV-VOTE-17, INV-VOTE-20 |

Scenario tests (19) mirror the TS negative/positive matrix: deadline
boundaries (at-deadline accepted for close, rejected for accept), legacy
commit rejection, commit/reveal mismatch (wrong outcome, wrong salt),
idempotent redelivery (state unchanged, clock advances), conflicting
commit/reveal rejection, non-roster rejection, ballot closure, tick expiry at
the reveal deadline, `reveal_closed` tick exemption, abort + terminal
absorption, empty-tally finalize rejection, lexicographic tie-break witness.

### Confirmation machine (`confirmationMachine`, `courtConfirmationMachine.ts`)

**Theorem 4 (Confirmation instance), machine-checked.**
Full 11-phase graph including the challenged ladder path. Invariants:

| Quint invariant | Paper / doc reference |
|---|---|
| `invConfig` — roster ≥ 3, quorum ∈ [1, N], deadline order, ladder cap 1..5, proposal ∈ ballot | INV-CONF-2..6 |
| `invConfirmations` / `invChallenges` — ⊆ roster, ≤ 1 per idx | INV-CONF-16, INV-CONF-17 |
| `invQuorum` — past the confirm window the quorum was met (fail-closed close) | INV-CONF-15 |
| `invLadder` — rounds consecutive & capped; live rounds have positive deadlines; `ladder_pending` has cap headroom | INV-CONF-19, INV-CONF-29 |
| `invVotes` — mass votes ⊆ roster × ballot, ≤ 1 per idx | INV-CONF-22 |
| `invHistory` — outcome history append-only, consecutive rounds 1..r | INV-CONF-26 |
| `invFlags` — every clawback flag justified (overturned ⇒ actual confirmer; round_flip ⇒ actual winner of that round; manual ⇒ roster); overturn flags unique per idx | INV-CONF-27, INV-CONF-28, INV-CONF-31 |
| `invOverturnSoundness` — an overturned proposal flags EVERY confirming juror | INV-CONF-27 |
| `invPendingCoherence` — `upheld ⟺ outcome == proposal` | INV-CONF-25 corollary |
| `invFinalSupport` — every `fee_settlement`/`final` state has non-empty verdict support (**r3-1 "unreachable on live paths", machine-checked**) | INV-CONF-33 |
| `invFinal` — finalized ⟺ `final`; verdict = pending verdict (last resolved round) | INV-CONF-32, INV-CONF-34 |
| `invFailure`, `invFees`, `invPhase`, `invClock` | INV-CONF-13/14/30 |

Scenario tests (23 across 4 instances incl. quorum=2 and maxLadderRounds=1):
the no-challenge happy path, the challenged → overturned → clawback →
concede → final path, the §4.2 flip-flop rule across two rounds, ladder cap
enforcement (final round settles fees directly, escalate refused), consecutive
rounds, the tick deadline table (incl. `confirm_closed` expiry at the
*challenge* deadline and the waiting-phase exemptions), record_fee
idempotency in any non-terminal phase, flag_clawback discipline, terminal
absorption, and reachability witnesses for `final` and the overturn path.

### Hash abstraction

`H(outcome, salt)` and `CH(idx)` are abstract **injective** encodings; the
commit version bit (high nibble `0x8`, `courtVoteMachine.ts:650`) is modeled
as `h >= 8` with legacy (< 8) and non-matching witnesses in the environment's
hash set. The real SHA-256 domain-separated bindings (INV-VOTE-9/10/18,
INV-CONF-8/9) are exercised by the TS suite with real cryptography and are
out of scope here — the model checks the *structure* (what binds to what),
the TS suite checks the *encoding*.

## The escalation transport (`escalation.qnt`)

**Theorem 7.4 (transport binding), model-checked.** An independent re-model of
`parse → map → reduce`: `canParse` is the codec's shape check, `canMap` the
host-binding check of `escalationRequestToMachineEvent` (r8-2), `canReduce` the
reducer's witness checks of `onEscalate` (INV-ESC-5/9, r33-1, R42).

| Quint invariant | Paper / doc reference |
|---|---|
| `invBinding` — every recorded escalation's wire claims (case id, pubkey) agree with the HOST binding | r8-2 (`courtEscalationRequest.ts:536–554`), Theorem 7.4 |
| `invRoundBound` — a witness opens only `ladderRound + 1`; `roundIndex` is derived from the case, never the wire | INV-ESC-8, r40-2 (`handlers.ts:578–583`) |
| `invRungRounds` — log rounds are a consecutive `2..ladderRound` | INV-ESC-8 (`core.ts:366–370`) |
| `invSeatNeedsRung` — `open_ladder_round` seats only a round a pending record names | r40-2 (the rung-spend barrier) |
| `invBondConsumption` — round bond ≠ membership bond, ≠ any accepted bond, never consumed twice | INV-ESC-9, r33-1 (`handlers.ts:640–662`, `core.ts:433–438`) |
| `invStrict` — `requireRoundBond` ⇒ every rung has one | R42 (`handlers.ts:630–637`) |
| `invChallenges` — one bond witness, one challenger | r38-1 (`handlers.ts:165–211`, `core.ts:565–589`) |
| `invRungMembership` — a rung is bound to THAT challenger's accepted bond | INV-ESC-5, r29-1 |
| `invLogBound`, `invLadderRange`, `invLadderShape` | INV-CONF-6, INV-CONF-19 |

The simulation deliberately offers HOSTILE wires (another case, another juror's
pubkey, a stale round, a legacy witness, a relabelled membership bond, an
unaccepted bond), so a leak in the binding surfaces as a violation rather than
passing silently. 16 scenario tests pin the negative/positive matrix, including
"parses but does not map" (parsing ≠ binding) and the strict instance's
legacy-refusal pair.

**Abstractions:** hashes/pubkeys/case ids are `int` literals (only injectivity
and distinctness matter); `roundBond == 0` stands for the wire's `null`. The
codec's canonicalisation (UTF-8 injectivity, duplicate-key refusal, the v2 hash
preimage) is TS-suite-checked, not modelled — see
`docs/proofs/07-mechanised-escalation.tex.md` §8.

## Divergences & findings

Found while building the independent model — none is a protocol bug; all are
modeling-scope notes plus two observations worth recording:

1. **`record_fee` has no phase guard by design** (`onRecordFee`). It is legal
   in *every* non-terminal phase — even `confirm_open`, before any
   confirmation. The model reproduces this exactly and the test
   `confirmRecordFeeIdempotentAnywhereTest` pins it. If this is unintended,
   the fix belongs in `confirmationMachineHandlers.ts`; the paper is silent on
   the fee ledger's phase discipline.
2. **Tick table asymmetry (faithfully modeled):** in the vote machine only the
   *reveal* deadline can expire a ceremony (the commit deadline never does —
   `commit_open`/`commit_closed` tick-exempt until the reveal deadline), while
   the confirmation machine's `confirm_closed` phase expires at the
   *challenge* deadline. Both are intentional per the TS comments (conservative
   expiry / one-step-from-transition exemptions) and are now pinned by tests
   (`voteTickDoesNotExpireRevealClosedTest`,
   `confirmTickExpiresConfirmClosedTest`).
3. **Idempotent redelivery is modeled as disabled, not as a no-op success**
   (vote commits/reveals with identical payloads; confirmation redelivery).
   In the TS, an identical redelivery returns the *same state* (success); in
   the Quint step relation it is simply not an enabled step. The reachable
   state sets are identical — only deadlock/enablement bookkeeping differs.
   Conflicting (different-payload) redelivery throws in the TS and is a
   disabled step here: same state relation.
4. **Conflicting challenges are unmodelable at this abstraction:** a
   re-challenge with a *different* bond witness throws in the TS; with bond
   txids/proof hashes abstracted, every re-challenge looks identical, so the
   model admits one challenge per idx (idempotent). The TS
   `conflicting challenge` path remains TS-suite-covered.
5. **Per-round `roundRoster` expansion is not modeled:** `open_ladder_round`
   may carry an expanded panel; the model pins the round panel to the case
   roster (the default and the common case). `normalizeRoundRoster`'s
   validation stays TS-suite-covered.
6. **Event-id / bond-txid well-formedness is out of scope** (abstracted):
   hex-ness, uniqueness across ledger entries, and canonical lowercase sorting
   into verdict support sets are TS ledger-barrier concerns
   (`assertValidRevealLedger` etc.), not state-machine concerns.
7. **Ballot fixed at k = 2** (TS allows 2..256). The tally rule verified
   (plurality + lexicographic tie-break) is the general rule restricted to the
   two-outcome instance used by the TS tests; the tie-break *encoding* here is
   a rank table standing in for `compareOutcomeUtf8`.
8. **Tooling notes for future rounds (not protocol findings):** Quint 0.33's
   effect system requires every composed action to update the same variable
   set — the spec therefore uses one record-typed state variable per machine
   (mirroring the TS state records). The Apalache backend (0.62.4) cannot
   compile `set.filter(...).getOnlyElement()` (QNT IR bug), so the outcome
   history is a round-keyed map. The rust simulator leaves the successor state
   unset after a failed action, so `.fail()` assertions are terminal steps in
   tests and mid-chain negative assertions use guard predicates directly.
   Finally, the sim runners bias their *input distribution* (deadline-aware
   timestamp sets, operator abort gated to 1-in-4) so random walks sample the
   phase graph instead of dying on the first mistimed pick — the legal-step
   relation itself is untouched and exhaustively checked by Apalache.

## Scope & honest limits

- **Verified:** the transition structure, guard clauses, ledger discipline,
  tally/clawback economics, and phase graph of both machines, by simulation
  (10k seeded runs) AND exhaustive symbolic checking (Apalache, depth 10).
- **Not verified here:** real SHA-256 hash bindings, secp256k1/FROST math,
  event-id canonicalization, roster expansion, network/relay behavior
  (`courtInbox`/`courtOutbox`), the DKG and signing machines, the escalation
  wire's UTF-8/duplicate-key canonicalisation, and the HOST's authentication
  (`invBinding` relates the log to the binding, it does not prove the binding). Those remain
  with the TS suite (`npm test`) and the pen-and-paper proofs (`docs/proofs/`).
- Apalache depth 10 covers every reachable state up to 10 transitions from
  init; the full unbounded state space is not exhausted (the deep multi-round
  clawback paths beyond depth 10 are covered by the deterministic scenario
  tests, which construct them explicitly).
- The simulator's witness coverage percentages (in the log) are a property of
  random-walk biasing, not of the state space: abort/expiry-heavy walks
  terminate early; the deep paths are asserted deterministically instead.

## Relationship to the other verification channels

`docs/proofs/04-machine-safety.tex.md` §7 states the relationship between the
prose induction and the TS exhaustive model checker ("complementary and
neither subsumes the other"). This directory adds a **third channel** with a
different failure profile: an independent spec, written in a different
language from the TS guard clauses, executed by a different toolchain
(Quint simulator + Apalache SMT-based model checker). A discrepancy between
this spec and the TS would surface as either (a) an invariant violation found
by the simulator/model checker — none was found — or (b) a divergence listed
above. What this channel adds over the TS checker: an independently written
step relation (harness bugs in `modelCheckingCore.ts` cannot hide here). What
it does not add: any n beyond the modeled instances, real cryptographic
encodings, or the liveness properties (P3/P4-style), which remain with the
TS checker and Theorem 4's prose.

## Files

- `court.qnt` — the phase-machine spec: `protocolUtil`, `voteMachine`,
  `confirmationMachine`, sim runners (`voteSim`, `confirmSim`), 42 scenario tests.
- `escalation.qnt` — the transport spec: `escalationTransport` (wire, binding,
  reducer), sim runners (`escalationSim`, `escalationStrictSim`), 16 scenario
  tests.
- `run.sh` — deterministic re-run script (the one-command bar).
- `quint-run.log` — committed output of the full run.
- `README.md` — this file.
