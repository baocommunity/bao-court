# BAO Court — Escrow Lifecycle & Slashing

**Version:** 0.5.3 (tracks `@bao/court` v0.5.3 — this repository; module introduced in v0.2.3)
**Status:** Implemented in `escrow.ts` (this package); rail execution remains
host-side per ADR-001 (hybrid dual-panel escrow).
**Scope:** Bond ownership proofs, deterministic escrow ledger, slashing and
redistribution computation. No networking, no sats movement, no ledger writes.

---

## 1. Why this exists

`FROST_COURT_ORACLE_PAPER.md` (bao.markets, mirrors this package) stated that
the court layer "does **not** implement bond escrow or slashing". A
claim-by-claim audit confirmed:

1. Bond **verification** existed (`bondVerification.ts`: unspent UTXO, amount,
   scriptPubKey, confirmations via a Mempool/Esplora verifier) but had **no
   ownership proof** — the coordinator carried an open TODO: *"there is still no
   proof the candidate OWNS the output (a challenge signature over
   bondTxid/bondVout with the UTXO key)"*.
2. There was **no escrow lifecycle** — no deterministic, serializable record of
   `pending → locked → returned | slashed` deposits that hosts could persist
   and apply to their rail.
3. There was **no slashing math** — `tallyVotes` surfaced `invalidReveals` as
   evidence, but the economic consequence (who is slashed by how much, who is
   rewarded, where the bond goes) lived only in bao.markets' server-side
   `DisputeEscrowService` and was not part of the shared protocol package.

This module closes all three gaps in the shared, rail-agnostic package so every
consumer (bao.markets, 2140.wtf, future hosts) derives the **same** escrow and
slashing results from the **same** inputs.

## 2. Design principles

- **Rail-agnostic.** ADR-001 chooses a hybrid dual-panel escrow (Panel A:
  Lightning hold invoices; Panel B: Liquid P2WSH M-of-N multisig). This package
  does not pick a rail; hosts inject the actual lock/return/slash execution.
- **Deterministic.** Every function is a pure function of its inputs. Any
  observer can recompute the redistribution plan and verify the ledger.
- **Integer-exact.** All amounts are satoshis as integers; slashing uses
  `Math.floor`, so the plan never fabricates fractional sats.
- **Fail-closed.** Invalid state transitions throw; malformed signatures verify
  to `false` rather than throwing.
- **Serializable.** `EscrowLedger` snapshots are plain JSON-safe records; hosts
  persist them and restore with `EscrowLedger.fromSnapshot`.

## 3. Ownership proofs (closes the coordinator TODO)

A depositor proves control of the bond UTXO by signing a deterministic
challenge:

```
challenge = SHA256("BAO-Court/BondOwnership/v1"
                   ‖ txid ‖ vout ‖ disputeId ‖ jurorPubkey ‖ nonce)
proof     = BIP-340 Schnorr signature over challenge, UTXO seckey
```

where `‖` denotes the Court's canonical UTF-8 **length-prefixed**
concatenation (`CanonicalWriter`). Delimiter-joined encoding is rejected so a
host-supplied `nonce` or `disputeId` containing a delimiter cannot alias
another field.

- `createBondOwnershipChallenge(input)` — deterministic per input; binds
  txid, vout, dispute, juror, and an anti-replay nonce, so a proof cannot be
  replayed across disputes or candidates.
- `signBondOwnershipProof(utxoSeckeyHex, challenge)` — signs with the private
  key of the bond output.
- `verifyBondOwnershipProof(utxoXOnlyPubkeyHex, challenge, sig)` — verifies
  against the UTXO's x-only public key (host derives it from `scriptPubKey`).
- The host's rail adapter combines this with `verifyBond` (UTXO exists, unspent,
  correct amount, correct script, sufficient confirmations) before `lock()`.

## 4. Escrow lifecycle

`EscrowLedger` is a deterministic state machine over deposits. A deposit is
keyed `disputeId|purpose|pubkey` and walks:

```
                    ┌─────────────────────────────┐
                    │          pending            │
                    └─────────────┬───────────────┘
                          proof rejected (lock(_,false))
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
         failed                 locked                  (pending stays
                                │   │                     until proof)
       ┌──────────────┬─────────┴───┴──────────┬───────────────┐
       ▼              ▼                        ▼               ▼
    returned      slashed_50              slashed_100      redistributed
   (coherent)   (incoherent 50%)     (non-reveal /      (after pool
    bond_won                          double-vote,        transfer)
                                       bond_lost)
```

Transitions:

| Method | From | To | Guard |
|---|---|---|---|
| `record` | — | `pending` | unique id |
| `lock(id, proofOk)` | `pending` | `locked` \| `failed` | proof verdict from host |
| `returnDeposit(id, reason)` | `locked` | `returned` | coherent / bond_won |
| `slash(id, reason)` | `locked` | `slashed_50` \| `slashed_100` | incoherent → 50%, non-reveal/double-vote → 100% |
| `forfeitBond(id)` | `locked` | `slashed_100` | bond_lost (dispute rejected) |
| `redistribute(id)` | `slashed_*` | `redistributed` | pool transfer executed |

`snapshot()` / `fromSnapshot()` round-trip the full state.

## 5. Slashing & redistribution

`computeRedistributionPlan(params)` implements the Kleros-style rules that
bao.markets' `DisputeEscrowService` proved out (with its DISPUTE-CRIT-002 /
HIGH-006 / HIGH-007 fixes):

| Participant | Consequence |
|---|---|
| Coherent juror (voted with majority) | stake back **plus** equal share of slashed pool |
| Incoherent juror (voted against) | −50% stake (keeps floor of half) |
| Non-reveal juror (committed, no reveal) | −100% |
| Double-voting juror (multiple reveals / commit mismatch) | −100% |
| Disputer, dispute upheld | bond returned |
| Disputer, dispute rejected | bond forfeited into pool |
| No coherent jurors | entire pool to `bao-treasury` (dust guard) |

`verifyRedistributionIntegrity(plan)` checks conservation: every deposited sat
is either returned or accounted as dust. Dust bound: with coherent jurors it is
the integer remainder of `slashedPool / coherentCount` (< coherentCount);
without coherent jurors it is the whole pool (treasury absorbs it, `+1` sat
rounding tolerance).

## 6. Integration contract for hosts

1. **Pledge intake:** host records pledges with `EscrowLedger.record({purpose:
   'juror_stake', ...})` when a pledge event is seen (bao.markets uses Kind
   38034).
2. **Lock:** host runs `verifyBond` + `verifyBondOwnershipProof` (rail adapter
   derives the UTXO x-only pubkey from `scriptPubKey`), then
   `ledger.lock(id, ok)`.
3. **Resolution:** run `tallyVotes` → classify reveals into coherent /
   incoherent / non-reveal / double-vote → `computeRedistributionPlan(params)`
   → persist the plan (slash-evidence event; kind owned by the host protocol
   layer — do not reuse the standing-oracle range 38035–38038 from
   `FROST_THRESHOLD_ORACLE_PLAN.md`) → `ledger.applyPlan(plan)`.
4. **Execution:** host moves sats on its rail per plan records and marks
   `redistribute(id)` / `returnDeposit(id)` as funds clear. Treasury records
   go to the platform treasury.
5. **Verification:** any observer can recompute the plan from public inputs and
   run `verifyRedistributionIntegrity` before trusting a slash event.

## 7. Tests

`__tests__/escrow.test.ts` covers: amount calculations (bond/stake/total),
all redistribution branches (coherent reward, incoherent 50%, non-reveal 100%,
double-vote 100%, bond won/lost, treasury fallback), integrity (clean, treasury,
overpayment flagged), ownership proofs (deterministic challenge binding all
fields, valid sign/verify, wrong-challenge and wrong-key rejection, garbage
input safety), and the ledger state machine (record/lock/fail/lock-guard,
return/slash/forfeit/redistribute transitions, double-transition rejection,
snapshot round-trip, `applyPlan` end-to-end for upheld and rejected disputes).

Suite at v0.2.3 release: **520/520** in-package tests pass, `tsc --noEmit`
clean. Current suite (v0.5.x, with settlement rails, simulation harness, and
the appeal coordinator/watcher port): **600/600** (582 + 18 regressions from
the 2026-08-18 review, see `docs/FIXES-2026-08-18.md`).
