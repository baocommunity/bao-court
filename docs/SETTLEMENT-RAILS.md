# BAO Court — Settlement Rails (Panel A: Lightning, Panel B: Liquid)

**Version:** 0.4.0 (implemented; signet execution by hosts)
**Status:** Protocol-side settlement implemented and test-covered. Rail
execution (node access, keys, broadcasting) is HOST-INJECTED per the secrecy
boundary — this package contains no keys, no node URLs, no credentials.
**Tests:** hermetic (default suite) + signet integration (opt-in, host-side).

---

## 1. Scope

The court package computes *what must happen financially* (the escrow ledger
and slashing plan from `escrow.ts`) and, since v0.3.0, *the protocol
primitives to make it happen on two rails* (ADR-001 hybrid dual-panel):

| Rail | Module | What it provides |
|---|---|---|
| **Panel A — Lightning hold invoices** | `lnSettlement.ts` + `lnRail.ts` | deterministic preimage/payment-hash derivation, hold lifecycle state machine, settle/cancel decisions from the court plan, audit-event templates; host `LnRail` contract + in-memory fake |
| **Panel B — Liquid P2WSH/Taproot escrow** | `liquidEscrow.ts` + `liquidRail.ts` | P2WSH M-of-N CHECKMULTISIG and Taproot judge/refund script trees, bech32/bech32m address derivation (BIP-173/BIP-350), release-skeleton builder, M-of-N witness assembly; host `LiquidRail` contract + fake |

Both rails consume the same `RedistributionPlan` from `escrow.ts`, so a single
court verdict drives deterministic LM and Liquid behavior with no drift.

## 2. Panel A — Lightning hold invoices

ADR-001 Panel A is **social slashing**: Lightning cannot script-enforce a
penalty, so "slashing" = denial of reward + reputation damage.

- `deriveLnPreimage(witness)` — deterministic 32-byte preimage binding
  `disputeId ‖ role ‖ pubkey ‖ outcome ‖ attestationDigest ‖ round` under the
  domain tag `BAO-Court/LnPreimage/v1`, where `‖` is the Court's canonical
  UTF-8 **length-prefixed** concatenation (`CanonicalWriter`) — no field can
  alias another even if it contains a delimiter. The `attestationDigest`
  binds the preimage to the court's FROST-signed verdict: a holder cannot
  claim without a valid attestation.
- `paymentHash(preimage)` — **SHA-256 of the raw preimage bytes** (BOLT
  semantics), NOT of its hex string.
- `LnHoldLedger` — deterministic, serializable state machine:
  `offer → held → settled | cancelled | expired | failed`. Guards: only an
  `offer` can be held; only a held, non-expired hold can be decided; expired
  holds route to the refund path.
- `planDecisionsForHolds(plan, holds)` — maps a `RedistributionPlan` to
  per-hold `settle`/`cancel`:
  coherent / bond_won → settle; incoherent / non-reveal / double-vote /
  bond_lost → cancel; unmentioned holds → `unsettled` (host refunds
  unselected pledgers).
- `buildLnAuditEvent(kind, hold, ...)` — JSON-safe audit template; the
  preimage is NEVER included (only the payment hash).

**Host contract** (`LnRail`): `createHoldInvoice`, `settleHold(invoiceId,
preimage)`, `cancelHold`, `getStatus`, `waitForPayment`. bao.markets
implements it against LNbits/CLN/LND on BAO signet — never in this package.

## 3. Panel B — Liquid P2WSH / Taproot escrow

ADR-001 Panel B is **script-enforced**: the multisig/threshold spend is real
on-chain. The script does not read the tally — enforcement is the court
choosing which branch to sign (ADR-001 negative).

- `buildMultisigScript({pubkeys, threshold})` — P2WSH M-of-N `CHECKMULTISIG`
  with the leading `OP_FALSE` (script bug), 1..15 pubkeys, compressed or
  x-only input (x-only lifted to compressed with correct parity).
- `buildTaprootLeaves({winner, oracle, refundLocktime})` — judge leaf
  `<winner> CHECKSIGVERIFY <oracle> CHECKSIG` and a CLTV refund leaf.
- `p2wshAddress(script, net)` / `taprootAddress(pubkey, merkleRoot, net)` —
  bech32 (v0) / bech32m (v1) addresses. BIP-173/BIP-350 compliant; verified
  against the official vectors. The witness version is a 5-bit word prepended
  to the program words (a byte-concatenation would silently corrupt the
  version — covered by tests).
- `taprootProgram` implements the BIP-341 tweak (key + merkle root, even-Y
  parity correction), `tapMerkleRoot` the sorted-pairs tree.
- `buildReleaseSkeleton(inputs, recipients, minFee)` — fee-exact,
  integer-only; rejects negative/zero amounts and malformed scripts.
- `assembleMultisigWitness(sigs, threshold)` — `OP_FALSE || sigs` ordering.

**Host contract** (`LiquidRail`): `getUtxo`, `broadcast`, `getConfirmations`.
bao.markets implements it against the Liquid node + Electrs on BAO signet —
never in this package.

## 4. Determinism & observability

- Every function is a pure function of its inputs; any observer can recompute
  the ledgers, decisions, scripts and addresses.
- `LnHoldLedger` and `EscrowLedger` are snapshot/restore serializable.
- The audit events and the redistribution plan are the public evidence trail
  hosts (and auditors) verify before executing on a rail.

## 5. Secrecy boundary (binding)

This package is PUBLIC (AGPL-3.0) and contains: protocol math, script trees,
address derivation, state machines, adapter contracts, and test fakes.

It must NEVER contain: private keys, seed phrases, node URLs, macaroons /
credentials, treasury/business policy, or the bao.markets rail
implementations (those live in `baocommunity/bao.markets`, closed-source, per
`docs/plans/REAL_RAIL_SEND_V2.md`). Hosts consume `lnSettlement` /
`liquidEscrow` as a library and implement `LnRail` / `LiquidRail` privately.

## 6. Test coverage

Default suite (hermetic, no network):

- `__tests__/lnSettlement.test.ts` — preimage determinism + field binding,
  BOLT hash semantics, ledger transitions, decision mapping, audit events.
- `__tests__/lnRail.test.ts` — adapter contract, call ordering, fail-closed
  host failures, payer sim.
- `__tests__/liquidEscrow.test.ts` — script serialization, witness assembly,
  release skeleton, fee/dust guards, script sanity.
- `__tests__/liquidAddress.test.ts` — independent bech32/bech32m decoder,
  official BIP-350 vectors, program round-trip.
- `__tests__/settlementE2E.test.ts` — court plan → LN decisions → Liquid
  branch → skeleton → broadcast via fakes; determinism.

Signet integration tests are HOST-SIDE (opt-in, need credentials): bao.markets
runs them against BAO signet before release and records evidence in release
notes. They are not part of this package's default suite by design.
