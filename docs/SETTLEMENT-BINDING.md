# BAO Court — Settlement Binding

**What the FROST judge key actually signs, what that buys, and what it does not.**

**Status:** normative. Corrects a claim the paper carried through v0.10.2
("Path B: FROST attestation + winner signature" verified on-chain). The
attested-spend builder (`buildCourtJudgeLeaf`) ships in this package; the
CHECKSIGFROMSTACK variant is specified but deliberately **not** shipped (gates
in §2.2); the v1 host-mediated lane is documented as the honest status quo
(§2.3).

**Audience:** settlement-rail implementers (hosts), reviewers, auditors.

---

## 0. Summary

A FROST signature over a Nostr attestation message is **not** a transaction
signature, and no shipped script verifies one. Three bindings are achievable;
they differ in *what the second signature is over*, and therefore in *who can
release funds*.

| # | Binding | Second signature is over | Verdict enforced by | Who can release | Shipped |
|---|---|---|---|---|---|
| i | **attested-spend** | the spend's taproot sighash | cohort signing policy + public audit trail | the cohort (M signers) **and** the winner | **yes** (`buildCourtJudgeLeaf`) |
| ii | **CHECKSIGFROMSTACK** | the verdict (or a settlement message) | the script, on Liquid | the winner, given a cohort signature over the attested outcome | no — spec only (§2.2) |
| iii | **host-mediated** (v1 status quo) | the spend's sighash, requested by the host | the host process | the host + winner; the cohort signs on request | deployed today |

The honest one-line statement for v1: **the court decides the verdict, the
host releases it.** The platform is a trust point for *release* (never for the
*verdict*): it cannot fabricate or alter a verdict, and it cannot spend without
the winner's signature, but nothing cryptographic stops it from releasing
without one.

---

## 1. The gap (verified against the code, not inferred)

### 1.1 What the paper used to say

- §1.2: "No single party — including the platform — can unilaterally release
  dispute funds."
- §3.2 Path B: "FROST attestation under $P_{\mathrm{dispute}}$ **and** winner
  signature … jurors attest; they cannot spend. The FROST aggregate key is an
  oracle key, not a spending key — an attestation without the winner's
  signature is worthless on-chain."
- §9.2: judge leaf `<winner> CHECKSIGVERIFY <oracle> CHECKSIG` "(jurors attest,
  the winner spends — §3.2)".

Each sentence is true of binding (ii). None is true of the shipped byte code.

### 1.2 What the shipped rail does

1. **The leaf verifies a transaction signature, not a message.**
   `liquidEscrow.ts › buildTaprootLeaves` emits
   `<winner> CHECKSIGVERIFY <oracle> CHECKSIG`. Both spends are BIP-342
   `OP_CHECKSIG`: the interpreter verifies a BIP-340 signature over the
   **sighash it computes from the spending transaction**. No opcode in the leaf
   can compare a signature against a caller-chosen message. (Verified: the
   package has no `CHECKSIGFROMSTACK` builder and no suite that exercises one.)
2. **The court's FROST output is over a different message entirely.**
   `crypto.ts › buildAttestationMessage` produces
   $m = H(\texttt{AttestationMessage/v1} \,\|\, marketId \,\|\, outcome \,\|
   round \,\|\, disputeEventId \,\|\, verdictHash)$ — published inside a
   kind-39007 event. It is a Nostr message. It is not a sighash, it is not
   accepted by the leaf, and the leaf has no way to learn it.
3. **The attestation message carries no transaction or plan commitment.**
   There is no sighash, txid, plan hash, or script commitment in the signed
   preimage, so even a CSFS-capable leaf over the *published* attestation could
   not stop the spender from building a different transaction.
4. **The oracle slot cannot hold the JIT dispute key.** §3.4 forms the jury and
   runs the DKG *after* a dispute is filed; $P_{\mathrm{dispute}}$ does not
   exist at market creation, which is when the script tree is fixed. The only
   keys that exist at creation are excrowed-fund keys and *epoch cohort*
   keys — and cohorts rotate (§3).
5. **So the second signature is a second signing session.** The group key can
   only satisfy the leaf by signing the sighash. The host builds the release
   plan, asks for that signature, and validates the attestation itself. That is
   binding (i) executed as (iii).

### 1.3 Why this matters (consequences)

| Claim | True? | Actual |
|---|---|---|
| "A FROST attestation is redeemable on-chain" | no | the attestation is consumed off-chain by the host |
| "No single party (incl. the platform) can release" | no | the host holds the signer token and can request the spend signature |
| "Jurors attest; they cannot spend" | half | the same group key both attests *and* co-signs the spend |
| "The oracle slot binds the verdict" | no | it binds *a transaction the host chose*; the verdict is bound procedurally |
| "The creation-time key covers resolution" | sometimes | only if the cohort outlives the market (§3) |

---

## 2. The three achievable bindings

Notation: $G$ = standing cohort group key (pinned at market creation),
$W$ = winner/beneficiary key, $D$ = funder/donor key (refund leaf),
$m_{\text{att}}$ = `buildAttestationMessage(...)` digest,
$\sigma_X$ = BIP-340 signature under key $X$.

### 2.1 (i) Attested-spend — **recommended for v1, shipped**

```
L1 judge  : <W> CHECKSIGVERIFY <G> CHECKSIG
L2 refund : <T> CLTV DROP <D> CHECKSIG
witness   : [ sigma_G(sighash), sigma_W(sighash), L1, controlBlock ]
```

**What the cohort signature certifies.** Exactly the transaction: Elements /
BIP-341 sighash (inputs, amounts, outputs, fee, leaf hash). It cannot be
re-pointed at another payout, another amount, or another input set — the host
cannot reuse it. That part is cryptographic.

**What binds the verdict to the spend.** *Procedure*, in three layers:

1. **Session separation + notification.** The cohort runs two sessions under
   the same key: one signs $m_{\text{att}}$ (published as kind-39007), one
   signs the sighash. A participant that receives a spend-signing request must
   already hold a *valid* attestation for `(marketId, outcome)`
   (`validator.ts › validateAttestationEvent`, group key pinned, verdict
   commitment recomputed). No attestation ⇒ no spend partial.
2. **Plan reproducibility.** The release plan is a pure function of public
   inputs (`buildReleasePlan` semantics): a participant recomputes
   `planHash` and the per-input sighash from the UTXO set and rejects a request
   whose sighash it cannot derive from a plan that pays the attested
   beneficiary.
3. **Publication.** `(attestationEventId, planHash, sighash, txid)` is
   published as one audit record. Any observer can recompute layers 1–2
   afterwards, so a host that releases without an attestation (or against one)
   is *detectable*, permanently, by anyone.

**Who can release.** M cohort signers **and** $W$. The host alone cannot
(release also needs the winner's key), $W$ alone cannot (needs the cohort).
The host can *withhold*; the CLTV refund leaf (`$T$) bounds that.

**Failure modes.**

- *Authority confusion at the signer.* A signer service that signs any
  structured request from its host (v1 reality) makes the cohort a rubber
  stamp: the policy in (1) lives in the requester. **This is the residual gap
  and it is procedural, not cryptographic.** Fix direction: make the verdict
  part of the *request* (`attestationDigest`, `marketId`, `outcome` alongside
  `{kind, escrow, rail, action, planId, sighash}`) so the signer can bind
  approval-once-per-verdict and so a deliberate release without a verdict
  becomes a recorded, refusable action rather than an omission.
- *Stale verdict selection.* If several valid attestations exist for one market
  (rounds), the escrow cannot tell them apart; the host picks. Enforced
  out-of-band: one attestation per `(market, round)` binding, monotone round
  wins, published.
- *Cohort death before settlement.* §3.

**Code.** `liquidEscrow.ts › buildCourtJudgeLeaf({winnerXOnly, groupXOnly})`
returns `{script, binding: 'attested-spend', secondSignatureMessage:
'taproot-sighash'}`, refuses a shared winner/group key (role collapse) and
non-x-only inputs, and is **byte-identical** to the legacy builder for the same
keys — pinned by a test, so the fix adds no consensus surface.
`isCourtJudgeLeaf(scriptHex, keys)` gives hosts an exact-equality check against
the persisted descriptor (never a "does the script contain the key" scan).

**Why this and not (ii) for v1.** It is the only binding that works on *both*
rails (Bitcoin/L1 has no CSFS), needs no new consensus surface, and keeps one
attestation format for all rails. Its weakness — the verdict is bound by
procedure — is real, bounded, and now documented instead of denied.

### 2.2 (ii) CHECKSIGFROMSTACK — Liquid-only, spec only (not shipped)

Elements tapscript exposes `OP_CHECKSIGFROMSTACK` (`0xba`) /
`OP_CHECKSIGFROMSTACKVERIFY` (`0xbb`), which verify a signature against a
message *from the stack*. A verdict-binding leaf is:

```
L1 judge  : <W> CHECKSIGVERIFY <digest32> <G> CHECKSIGFROMSTACK
witness   : [ sigma_G(digest32), sigma_W(sighash), L1, controlBlock ]
```

`CHECKSIGFROMSTACK` pops `(sig, msg, pubkey)`, so the group's signature sits
below the winner's on the witness and survives the `CHECKSIGVERIFY` above it.
The verdict (or a settlement commitment) is then checked **by consensus**, and
an observer learns the attested outcome from the spent leaf itself.

**Two sub-variants, and why the obvious one cannot exist:**

- **(ii-a) CSFS over the attestation message.** Impossible: `digest32` is baked
  into the leaf at market creation, but $m_{\text{att}}$ includes
  `disputeEventId` (and, in v2, `epochId`), which are created *after* the
  market opens. Unknowable at lock time.
- **(ii-b) CSFS over a canonical settlement message** that *is* a
  creation-time constant:
  $\text{settle}(marketId, o) = H(\texttt{SettlementMessage/v1} \,\|\,
  marketId \,\|\, o)$, one judge leaf per outcome $o$ (binary markets: two
  leaves; N-outcome markets: N leaves). The cohort signs
  $\text{settle}(marketId, o)$ under the same session as — or a separate
  session from — the attestation. Result: **the host can no longer change the
  outcome**, only refuse or release. That is stronger than (i) and worth the
  extra leaves.

**Gates before (ii-b) may hold funds:**

1. **Consensus proof.** A script-path spend of a CSFS leaf, accepted by the
   deployment's elementsd on elementsregtest, committed like
   `__tests__/taprootSpend-live.test.ts` does for the current leaf version
   (`0xc4`) and tagged-hash domains. Script serialization tests are not
   evidence that the opcode is enabled on the chain we ship to.
2. **Leaf growth.** Each outcome leaf carries 33 extra bytes and its own winner
   slot; a 256-outcome parimutuel market is out of the question — apply (ii-b)
   to binary/escrow rails only.
3. **Portability.** CSFS does not exist on Bitcoin; the L1 lane keeps (i). Two
   settlement semantics then coexist, so the rail must be recorded per escrow
   and the market metadata must say which one it is.
4. **A second ceremony.** The cohort now signs two messages per settlement
   (`settle(...)` and $m_{\text{att}}$); keep the nonce discipline of §4.3 and
   make sure the *same* nonce can never sign both (distinct messages).

Until all four are green, (ii-b) is a design, not a rail.

### 2.3 (iii) Host-mediated — the honest v1 (deployed today)

```
FROST authorises  →  host validates the attestation  →  host requests the
cohort's spend signature  →  winner signs  →  host broadcasts
```

**Trust point:** the host process (its bearer token, its validation code, its
deploy). Whoever holds both can release; the cohort signature is requested, not
independently motivated.

**What the host cannot do (and why that is not nothing):**

- **Fabricate a verdict.** Needs ≥ M shares. The published attestation is the
  only verdict artifact, and it is verified against the *pinned* group key,
  market id, outcome whitelist, verdict commitment and signature.
- **Alter an attested verdict and pass validation.** `validateAttestationEvent`
  recomputes the tally commitment and the message; the outcome whitelist is the
  escrow's own key set.
- **Spend without the winner/beneficiary signature.** Both signatures are
  required by the leaf.
- **Re-publish a signature for a different plan.** The signer binds one
  signature per `(kind, escrow, rail, action, planId)`; a different digest on
  the same binding is refused (`BINDING_CONFLICT`).
- **Escape the audit trail.** Attestation, plan, txid are public.

**What it can do:** release without a verdict, pick among valid verdicts, or
refuse to release at all (bounded by the CLTV refund).

**Detective control (the only one that exists for the first failure mode):**
publish every `(attestation, planHash, sighash, txid)` tuple, and re-verify
out-of-band that each release is covered by a valid attestation for that
market and that the plan pays the attested beneficiary. Monitoring this is a
*post-hoc* control: funds have already moved when it fires.

---

## 3. The cohort-lifetime constraint (formal)

### 3.1 Definitions

- **Market window.** `lockAt` (escrow funded), `closeAt` (trading close),
  `resolveBy` (last admissible resolution: appeal rounds, ladder rounds and
  their windows included), `refundAt` (absolute CLTV height/time of L2),
  `slack` (settlement session + broadcast + confirmation margin).
- **Cohort window.** `CourtEpochCohort` (`epochCohort.ts`):
  `[startsAtSec, endsAtSec]`, plus the operational lifetime of the shares and
  the signer service. A cohort is *standing* at $t$ iff its record is valid at
  $t$ **and** its shares are still served.
- **Settlement-binding coverage (SBC).** A market settled by the cohort path at
  time $t_s$ is covered iff

  $$\texttt{startsAtSec} \le \texttt{lockAt}
    \;\wedge\; t_s \le \texttt{endsAtSec}
    \;\wedge\; t_s \le \texttt{refundAt}.$$

  Since $t_s \le \texttt{resolveBy} + \texttt{slack}$, the creation-time
  obligation is

  $$\boxed{\texttt{resolveBy} + \texttt{slack} \;\le\; \texttt{endsAtSec}}$$

  and it must hold **for the cohort key that the script actually pinned**.

### 3.2 Why it cannot be patched after creation

The script tree is fixed at funding; $G$ is in it. Rotation is a deliberate
procedure that *destroys* the old shares. Consequences:

- `hashCourtEpochHandoff` proves **which key was valid when** (attribution,
  jurisdiction, audit) — it cannot make a rotated-out key sign. An open market
  locked to a dead cohort is unsettleable by the court path, full stop.
- The attestation layer already carries the epoch (`buildAttestationMessageV2`
  binds `epochId`), so a verdict can always be attributed to a cohort. The
  *settlement* layer has no epoch notion at all — hence the hard constraint is
  on lifetime, not on attribution.
- A JIT dispute key is not a candidate: it does not exist at creation (§1.2.4).

### 3.3 The market-creation rule

At creation, with `resolveBy + slack` known:

1. Let $C^{*}$ be the **earliest-ending cohort** with
   `startsAtSec ≤ lockAt` and `endsAtSec ≥ resolveBy + slack`. Bind $C^{*}$.
   (Earliest-ending sufficiency leaves the longer-lived cohorts for
   longer-lived markets.)
2. If no cohort qualifies, apply the policy ladder **in order**, and record the
   choice in the market metadata:
   - **(a) refuse** to open a court-settled market
     (`COHORT_NOT_COVERED`) — the fail-closed default;
   - **(b) shorten** `closeAt`/`resolveBy` so the window fits;
   - **(c) pre-commit the next epoch's key**: bind $C_{n+1}$ if its DKG has
     already run and its key is published (`hashCourtEpochHandoff` + a
     pre-announced cohort). This is the only way a market can outlive $C_n$
     while staying script-bound — it requires the runbook to publish the next
     cohort key **before** the market opens;
   - **(d) degrade explicitly** to the host-mediated lane (iii), labelled in the
     market metadata. Never silently.
3. `refundAt` must be finite and reachable (`refundAt < ∞`): cohort death
   mid-market is answered by the CLTV refund, which is the designed liveness
   fallback (Path C), not an incident.

### 3.4 Working the arithmetic

A 90-day market with a 7-day resolution + appeal window and a 1-day settlement
margin needs ~98 days of coverage. With 30-day epochs, **no market can ever be
covered by its creation-epoch cohort** — every court-settled market would have
to bind a future cohort (rule 3c) or be refused (3a). Therefore:

> Epoch length is a *product* parameter: `epochLife ≥ maxMarketLife + slack`.
> A cohort epoch that is shorter than the longest market it serves is a
> configuration error, not a rotation strategy.

The constraint is checkable off-chain from public records (cohort windows +
market windows), so an auditor can list every open market that would become
unsettleable if the current cohort retired on schedule.

---

## 4. Recommendation (implementation order)

### 4.1 Ship now — done in this change

1. `buildCourtJudgeLeaf` / `isCourtJudgeLeaf` (§2.1) + tests, legacy builder
   untouched.
2. This document; paper §1.2 / §3.2 / §3.4 / §9.2 / §10.1–10.2 / §12 and
   `FORMAL_INVARIANTS`
   corrected to match.

### 4.2 Next — the ceremony, not the script

The binding lives in the two signing sessions and the published audit record:

1. **Spend-session binding.** Extend the signing-session hash
   (`courtSigningMachine.ts`, `SigningSession/v1`) with a settlement tuple
   `(marketId, attestationDigest, planHash, sighash, attempt)` so a spend
   attempt is bound to the verdict *and* the transaction it releases —
   `INV-SIGN-1` semantics, one new field block.
2. **Signer policy.** Refuse a spend partial unless (a) the spend session names
   a valid attestation for `(marketId, outcome)`, and (b) the sighash is
   reproducible from a plan that pays the attested beneficiary.
3. **Nonce discipline (unchanged, mandatory).** Fresh CSPRNG nonce per attempt,
   bound to the full commitment set; never reused across the attestation and
   spend sessions (distinct messages ⇒ distinct nonces; `INV-SIGN-4`…`INV-SIGN-10`).
4. **Request shape.** Add `attestationDigest`, `marketId`, `outcome` to the
   on-chain `escrow-swap` signature request, so approval is bound to a verdict
   at the signer and a release-without-verdict is refusable and recorded.
5. **Publication.** One audit record per release:
   `(marketId, outcome, attestationEventId, planHash, sighash, txid)`.

### 4.3 Then — (ii-b) for Liquid binary/escrow rails, once the four gates in
§2.2 are green. Do not ship a CSFS leaf on script-serialization tests alone.

---

## 5. Residual risk register

| Risk | Impact | Control today | Status |
|---|---|---|---|
| Host releases with no verdict | funds move on an unadjudicated market | none at the signer; post-hoc audit | **open** — §4.2.4 |
| Host picks a stale verdict among rounds | wrong payout | one attestation per `(market, round)`; round monotone; public trail | partial |
| Cohort dies before settlement | market unsettleable | `resolveBy + slack ≤ endsAt` rule; CLTV refund | policy |
| Verdict↔plan mismatch | payout to a wrong address | both signatures needed; plan reproducibility; publication | procedural |
| Signer host compromise | arbitrary release for open escrows | loopback + bearer token + one-signature-per-binding | boundary |
| `M` shares co-located (prototype) | single-point key compromise | documented (paper §10.2 G) | **open** until cross-host deployment |

---

## 6. What this document does not claim

- Not that v1 has threshold settlement: it has threshold **attestation** and
  host-mediated settlement.
- Not that the attestation is redeemable on-chain on any rail.
- Not that CSFS is available on the target chain until a consensus witness test
  proves it (§2.2 gate 1).
- Not that the cohort outlives the market until §3.3 is checked per market.

## 7. How to re-verify this document

```bash
# the leaf is a transaction-signature leaf, not a message leaf
grep -n "CHECKSIGVERIFY\|buildCourtJudgeLeaf\|buildTaprootLeaves" liquidEscrow.ts
grep -rn "CHECKSIGFROMSTACK" --include='*.ts' .        # no builder in this package

# the court signs a Nostr message, not a sighash
grep -n "ATTESTATION_MESSAGE_DOMAIN\b" -A4 crypto.ts

# the attestation carries no transaction/plan commitment
grep -n "buildAttestationMessage" -A14 crypto.ts

# the judge key must exist at creation; cohorts are the only standing keys
grep -n "endsAtSec\|cohortPubkey" epochCohort.ts
```
